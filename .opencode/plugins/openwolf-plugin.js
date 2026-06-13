// .opencode/plugins/openwolf-plugin.js
// OpenWolf Plugin for OpenCode — project intelligence, token tracking, graphify integration
// Ported from src/hooks/*.ts (Claude Code hooks) to OpenCode plugin API

import {
  existsSync, readFileSync, writeFileSync, appendFileSync,
  renameSync, readdirSync, unlinkSync, statSync, mkdirSync,
  openSync, readSync, closeSync,
} from "fs";
import { join, dirname, basename, extname, relative, normalize } from "path";
import { execSync } from "child_process";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const WOLF_DIR = ".wolf";
const CODE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".css", ".json", ".yaml", ".yml"]);
const PROSE_EXTS = new Set([".md", ".txt", ".rst"]);
const CODE_TOKEN_RATIO = 3.5;
const PROSE_TOKEN_RATIO = 4.0;
const MIXED_TOKEN_RATIO = 3.75;
const MAX_DESCRIPTION_LENGTH = 100;
const REPEATED_EDIT_THRESHOLD = 3;
const ANATOMY_SAVINGS_PER_HIT = 200;
const STOP_WORDS = new Set([
  "error","function","return","const","this","that","with","from","import","export",
  "class","interface","type","undefined","null","true","false","string","number",
  "object","array","value","file","path","name","data","response","request","result",
  "should","must","does","have","been","will","would","could","when","then","else",
  "each","some","every","only"
]);

// ─────────────────────────────────────────────
// Shared Utilities (inlined from src/hooks/shared.ts)
// ─────────────────────────────────────────────

function wolfPath(dir, ...segments) {
  return join(dir, WOLF_DIR, ...segments);
}

function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

function ensureWolfDir(dir) {
  const wp = wolfPath(dir);
  if (!existsSync(wp)) mkdirSync(wp, { recursive: true });
}

function classifyFileType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (CODE_EXTS.has(ext)) return "code";
  if (PROSE_EXTS.has(ext)) return "prose";
  return "mixed";
}

function estimateTokens(text, type) {
  if (!text) return 0;
  const ratio = type === "code" ? CODE_TOKEN_RATIO
              : type === "prose" ? PROSE_TOKEN_RATIO
              : MIXED_TOKEN_RATIO;
  return Math.ceil(text.length / ratio);
}

function atomicWrite(filePath, content) {
  const tmp = filePath + "." + Math.random().toString(16).slice(2, 10) + ".tmp";
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, content, "utf8");
    try { unlinkSync(tmp); } catch {}
  }
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function writeJson(filePath, data) {
  atomicWrite(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ─────────────────────────────────────────────
// Anatomy Parsing (from shared.ts L65-111)
// ─────────────────────────────────────────────

function parseAnatomy(content) {
  const sections = new Map();
  let currentKey = null;
  let currentEntries = [];
  for (const line of content.split("\n")) {
    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      if (currentKey !== null) sections.set(currentKey, currentEntries);
      currentKey = sectionMatch[1].trim();
      currentEntries = [];
      continue;
    }
    const entryMatch = line.match(/^- `([^`]+)`(?:\s+—\s+(.+?))?\s*\(~(\d+)\s+tok\)$/);
    if (entryMatch && currentKey !== null) {
      currentEntries.push({
        file: entryMatch[1],
        description: entryMatch[2] || "",
        tokens: parseInt(entryMatch[3], 10),
      });
    }
  }
  if (currentKey !== null) sections.set(currentKey, currentEntries);
  return sections;
}

function serializeAnatomy(sections) {
  const lines = [];
  for (const [key, entries] of sections) {
    lines.push("## " + key);
    for (const e of entries) {
      const desc = e.description ? " — " + e.description : "";
      lines.push("- `" + e.file + "`" + desc + " (~" + e.tokens + " tok)");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// extractDescription (VERBATIM from src/hooks/shared.ts L113-563)
// Multi-language heuristic file description extractor
// ─────────────────────────────────────────────

function extractDescription(filePath) {
  const MAX_DESC = 150;
  const bn = basename(filePath);
  const ext = extname(bn).toLowerCase();
  const known = {
    "package.json": "Node.js package manifest",
    "tsconfig.json": "TypeScript configuration",
    ".gitignore": "Git ignore rules",
    "README.md": "Project documentation",
    "composer.json": "PHP package manifest",
    "requirements.txt": "Python dependencies",
    "schema.sql": "Database schema",
    "Dockerfile": "Docker container definition",
    "docker-compose.yml": "Docker Compose services",
    "Cargo.toml": "Rust package manifest",
    "go.mod": "Go module definition",
    "Gemfile": "Ruby dependencies",
    "pubspec.yaml": "Dart/Flutter package manifest",
  };
  if (known[bn]) return known[bn];

  let content;
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(12288);
      const n = readSync(fd, buf, 0, 12288, 0);
      content = buf.subarray(0, n).toString("utf-8");
    } finally {
      try { closeSync(fd); } catch {}
    }
  } catch {
    return "";
  }
  if (!content.trim()) return "";

  const cap = (s) => s.length <= MAX_DESC ? s : s.slice(0, MAX_DESC - 3) + "...";

  // Markdown heading
  if (ext === ".md" || ext === ".mdx") {
    const m = content.match(/^#{1,2}\s+(.+)$/m);
    if (m) return cap(m[1].trim());
  }

  // HTML title
  if (ext === ".html" || ext === ".htm") {
    const m = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return cap(m[1].trim());
  }

  // JSDoc / PHPDoc / Javadoc — first meaningful line
  const jm = content.match(/\/\*\*\s*\n?\s*\*?\s*(.+)/);
  if (jm) {
    const l = jm[1].replace(/\*\/$/, "").trim();
    if (l && !l.startsWith("@") && l.length > 5) return cap(l);
  }

  // Python docstring
  if (ext === ".py") {
    const dm = content.match(/^(?:#[^\n]*\n)*\s*(?:"""(.+?)"""|'''(.+?)''')/s);
    if (dm) {
      const first = (dm[1] || dm[2]).split("\n")[0].trim();
      if (first && first.length > 3) return cap(first);
    }
  }

  // Rust doc comments
  if (ext === ".rs") {
    const lines = content.split("\n");
    for (const line of lines.slice(0, 20)) {
      const m = line.match(/^\s*(?:\/\/\/|\/\/!)\s*(.+)/);
      if (m && m[1].length > 5) return cap(m[1].trim());
    }
  }

  // Go package comment
  if (ext === ".go") {
    const m = content.match(/\/\/\s*Package\s+\w+\s+(.*)/);
    if (m) return cap(m[1].trim());
  }

  // C# XML doc
  if (ext === ".cs") {
    const m = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
    if (m) {
      const text = m[1].replace(/\/\/\/\s*/g, "").replace(/\s+/g, " ").trim();
      if (text.length > 5) return cap(text);
    }
  }

  // Elixir @moduledoc
  if (ext === ".ex" || ext === ".exs") {
    const m = content.match(/@moduledoc\s+"""\s*\n\s*(.*)/);
    if (m) return cap(m[1].trim());
  }

  // Header comment (skip generic ones)
  const hdrLines = content.split("\n");
  for (const line of hdrLines.slice(0, 15)) {
    const t = line.trim();
    if (!t || t === "<?php" || t.startsWith("#!") || t.startsWith("namespace") || t.startsWith("use ") || t.startsWith("import ") || t.startsWith("from ") || t.startsWith("require") || t.startsWith("module ")) continue;
    const cm = t.match(/^(?:\/\/|#|--)\s*(.+)/);
    if (cm) {
      const text = cm[1].trim();
      const lower = text.toLowerCase();
      if (text.length > 5 && !lower.startsWith("copyright") && !lower.startsWith("license") && !lower.startsWith("@") && !lower.startsWith("strict") && !lower.startsWith("generated") && !lower.startsWith("eslint-") && !lower.startsWith("nolint")) {
        return cap(text);
      }
    }
    if (!t.startsWith("//") && !t.startsWith("#") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("--")) break;
  }

  // ─── PHP / Laravel ───────────────────────────────────────
  if (ext === ".php") {
    if (bn.endsWith(".blade.php")) {
      const ext2 = content.match(/@extends\(\s*['"]([^'"]+)['"]\s*\)/);
      const sections = (content.match(/@section\(\s*['"](\w+)['"]/g) || []).map(s => s.match(/['"](\w+)['"]/)?.[1]).filter(Boolean);
      const parts = [];
      if (ext2) parts.push("extends " + ext2[1]);
      if (sections.length) parts.push("sections: " + sections.join(", "));
      return cap(parts.length ? "Blade: " + parts.join(", ") : "Blade template");
    }

    const classM = content.match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    const className = classM?.[1] || "";
    const parent = classM?.[2] || "";
    const pubMethods = (content.match(/public\s+function\s+(\w+)/g) || [])
      .map(m => m.match(/public\s+function\s+(\w+)/)?.[1])
      .filter(n => n && n !== "__construct" && n !== "middleware");

    if (bn.endsWith("Controller.php") || parent === "Controller") {
      if (pubMethods.length > 0) {
        const display = pubMethods.slice(0, 5).join(", ");
        return cap(pubMethods.length > 5 ? display + " + " + (pubMethods.length - 5) + " more" : display);
      }
    }

    if (parent === "Model" || parent === "Authenticatable") {
      const parts = [];
      const tbl = content.match(/\$table\s*=\s*['"]([^'"]+)['"]/);
      if (tbl) parts.push("table: " + tbl[1]);
      const fill = content.match(/\$fillable\s*=\s*\[([^\]]*)\]/s);
      if (fill) { const c = (fill[1].match(/['"]/g) || []).length / 2; parts.push(Math.floor(c) + " fields"); }
      const rels = (content.match(/\$this->(hasMany|hasOne|belongsTo|belongsToMany|morphMany|morphTo)\(/g) || []).length;
      if (rels) parts.push(rels + " rels");
      return cap(parts.length ? "Model — " + parts.join(", ") : "Model: " + className);
    }

    if (bn.match(/^\d{4}_\d{2}_\d{2}/)) {
      const create = content.match(/Schema::create\(\s*['"]([^'"]+)['"]/);
      if (create) return "Migration: create " + create[1] + " table";
      const alter = content.match(/Schema::table\(\s*['"]([^'"]+)['"]/);
      if (alter) return "Migration: alter " + alter[1] + " table";
      return "Database migration";
    }

    if (className && pubMethods.length > 0) {
      const display = pubMethods.slice(0, 4).join(", ");
      return cap(pubMethods.length > 4 ? className + ": " + display + " + " + (pubMethods.length - 4) + " more" : className + ": " + display);
    }
  }

  // ─── TS/JS/React/Next.js ─────────────────────────────────
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    // React component
    if (ext === ".tsx" || ext === ".jsx") {
      const comp = content.match(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+(\w+)/);
      const parts = [];
      if (comp) parts.push(comp[1]);
      const renders = [];
      if (/<(?:form|Form)/i.test(content)) renders.push("form");
      if (/<(?:table|Table|DataTable)/i.test(content)) renders.push("table");
      if (/<(?:dialog|Dialog|Modal|Drawer)/i.test(content)) renders.push("modal");
      if (renders.length) parts.push("renders " + renders.join(", "));
      if (parts.length) return cap(parts.join(" — "));
    }

    // Next.js conventions
    if (bn === "page.tsx" || bn === "page.js") return "Next.js page component";
    if (bn === "layout.tsx" || bn === "layout.js") return "Next.js layout";
    if (bn === "route.ts" || bn === "route.js") {
      const methods = [...new Set((content.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g) || [])
        .map(m => m.match(/(GET|POST|PUT|PATCH|DELETE)/)?.[1]))].filter(Boolean);
      return methods.length ? "Next.js API route: " + methods.join(", ") : "Next.js API route";
    }

    // Express/Fastify routes
    const routeHits = content.match(/\.(get|post|put|patch|delete)\s*\(\s*['"`]/g);
    if (routeHits && routeHits.length > 0) {
      const methods = [...new Set(routeHits.map(r => r.match(/\.(get|post|put|patch|delete)/)?.[1]?.toUpperCase()))];
      return cap("API routes: " + methods.join(", ") + " (" + routeHits.length + " endpoints)");
    }

    // tRPC router
    if (content.includes("createTRPCRouter") || content.includes("publicProcedure")) {
      const procs = (content.match(/\.(query|mutation|subscription)\s*\(/g) || []).length;
      return procs ? "tRPC router: " + procs + " procedures" : "tRPC router";
    }

    // Zod schemas
    if (content.includes("z.object") || content.includes("z.string")) {
      const schemas = (content.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*z\./g) || [])
        .map(s => s.match(/(?:const|let)\s+(\w+)/)?.[1]).filter(Boolean);
      if (schemas.length) return cap("Zod schemas: " + schemas.slice(0, 4).join(", ") + (schemas.length > 4 ? " + " + (schemas.length - 4) + " more" : ""));
    }

    // Exports summary
    const exports = (content.match(/export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+(\w+)/g) || [])
      .map(e => e.match(/(\w+)$/)?.[1]).filter(Boolean);
    if (exports.length > 0 && exports.length <= 5) return "Exports " + exports.join(", ");
    if (exports.length > 5) return cap("Exports " + exports.slice(0, 4).join(", ") + " + " + (exports.length - 4) + " more");
  }

  // ─── Python / Django / FastAPI / Flask ────────────────────
  if (ext === ".py") {
    if (content.includes("models.Model")) {
      const cls = content.match(/class\s+(\w+)\(.*models\.Model\)/);
      const fields = (content.match(/^\s+\w+\s*=\s*models\.\w+/gm) || []).length;
      return cap("Model: " + (cls?.[1] || "unknown") + ", " + fields + " fields");
    }
    if (content.includes("@router.") || content.includes("@app.")) {
      const routes = (content.match(/@(?:router|app)\.(get|post|put|patch|delete)\s*\(/g) || []);
      return cap(routes.length ? "API: " + routes.length + " endpoints" : "API router");
    }
    if (content.includes("BaseModel") && content.includes("Field(")) {
      const cls = content.match(/class\s+(\w+)\(.*BaseModel\)/);
      return cls ? "Pydantic: " + cls[1] : "Pydantic model";
    }
    if (content.includes("@shared_task") || content.includes("@app.task")) {
      const tasks = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_"));
      return cap(tasks.length ? "Celery tasks: " + tasks.join(", ") : "Celery task");
    }
    const pyClass = content.match(/class\s+(\w+)/);
    const funcs = (content.match(/def\s+(\w+)/g) || []).map(f => f.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_"));
    if (pyClass && funcs.length > 0) return cap(funcs.length > 4 ? pyClass[1] + ": " + funcs.slice(0, 4).join(", ") + " + " + (funcs.length - 4) + " more" : pyClass[1] + ": " + funcs.join(", "));
    if (funcs.length > 0) return cap(funcs.slice(0, 4).join(", "));
  }

  // ─── Go ──────────────────────────────────────────────────
  if (ext === ".go") {
    const handlers = (content.match(/func\s+(\w+)\s*\(\s*\w+\s+http\.ResponseWriter/g) || [])
      .map(m => m.match(/func\s+(\w+)/)?.[1]).filter(Boolean);
    if (handlers.length) return cap("HTTP handlers: " + handlers.slice(0, 5).join(", "));
    const iface = content.match(/type\s+(\w+)\s+interface\s*\{/);
    if (iface) return "Interface: " + iface[1];
    const structM = content.match(/type\s+(\w+)\s+struct\s*\{/);
    if (structM) return "Struct: " + structM[1];
    const funcs = (content.match(/^func\s+(\w+)/gm) || []).map(m => m.match(/func\s+(\w+)/)?.[1]).filter(n => n && n[0] === n[0].toUpperCase());
    if (funcs.length) return cap(funcs.slice(0, 5).join(", "));
  }

  // ─── Rust ────────────────────────────────────────────────
  if (ext === ".rs") {
    const structM = content.match(/pub\s+struct\s+(\w+)/);
    if (structM) {
      const methods = (content.match(/pub\s+(?:async\s+)?fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
      return cap(methods.length ? structM[1] + ": " + methods.slice(0, 4).join(", ") : "Struct: " + structM[1]);
    }
    const traitM = content.match(/pub\s+trait\s+(\w+)/);
    if (traitM) return "Trait: " + traitM[1];
    const enumM = content.match(/pub\s+enum\s+(\w+)/);
    if (enumM) return "Enum: " + enumM[1];
    const fns = (content.match(/pub\s+(?:async\s+)?fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── Java / Spring ───────────────────────────────────────
  if (ext === ".java") {
    const cls = content.match(/(?:public\s+)?class\s+(\w+)/);
    const className = cls?.[1] || bn.replace(".java", "");
    const annotations = (content.match(/@(RestController|Controller|Service|Repository|Component|Entity|Configuration)/g) || []).map(a => a.slice(1));
    const mappings = (content.match(/@(?:Get|Post|Put|Patch|Delete|Request)Mapping/g) || []).length;
    if (mappings) return cap((annotations[0] || "Spring") + ": " + className + " (" + mappings + " endpoints)");
    if (annotations.length) return annotations[0] + ": " + className;
    if (content.includes("@Entity")) return "Entity: " + className;
    const methods = (content.match(/public\s+(?:static\s+)?(?:\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(/g) || [])
      .map(m => m.match(/(\w+)\s*\(/)?.[1]).filter(n => n && n !== className);
    if (methods.length) return cap(className + ": " + methods.slice(0, 4).join(", "));
    return className ? "Class: " + className : "";
  }

  // ─── Kotlin ──────────────────────────────────────────────
  if (ext === ".kt" || ext === ".kts") {
    const cls = content.match(/(?:data\s+)?class\s+(\w+)/);
    if (content.match(/data\s+class/)) return "Data class: " + (cls?.[1] || bn.replace(/\.kts?$/, ""));
    if (content.includes("routing {")) return "Ktor routing";
    const fns = (content.match(/fun\s+(\w+)/g) || []).map(m => m.match(/fun\s+(\w+)/)?.[1]).filter(Boolean);
    if (cls && fns.length) return cap(cls[1] + ": " + fns.slice(0, 4).join(", "));
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── C# / .NET ───────────────────────────────────────────
  if (ext === ".cs") {
    const cls = content.match(/(?:public\s+)?(?:partial\s+)?class\s+(\w+)(?:\s*:\s*(\w+))?/);
    const className = cls?.[1] || bn.replace(".cs", "");
    const parent = cls?.[2] || "";
    if (parent === "Controller" || parent === "ControllerBase" || content.includes("[ApiController]")) {
      const actions = (content.match(/\[Http(Get|Post|Put|Patch|Delete)\]/g) || []).map(a => a.match(/Http(\w+)/)?.[1]).filter(Boolean);
      return cap(actions.length ? "API Controller: " + className + " (" + [...new Set(actions)].join(", ") + ")" : "Controller: " + className);
    }
    if (parent === "DbContext" || content.includes("DbSet<")) {
      const sets = (content.match(/DbSet<(\w+)>/g) || []).map(s => s.match(/<(\w+)>/)?.[1]).filter(Boolean);
      return cap(sets.length ? "DbContext: " + sets.join(", ") : "DbContext: " + className);
    }
    return className ? "Class: " + className : "";
  }

  // ─── Ruby / Rails ────────────────────────────────────────
  if (ext === ".rb") {
    const cls = content.match(/class\s+(\w+)(?:\s*<\s*(\w+(?:::\w+)?))?/);
    const className = cls?.[1] || "";
    const parent = cls?.[2] || "";
    if (parent?.includes("Controller")) {
      const actions = (content.match(/def\s+(index|show|new|create|edit|update|destroy|\w+)/g) || [])
        .map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_"));
      return cap(actions.length ? "Controller: " + actions.join(", ") : "Controller: " + className);
    }
    if (parent === "ApplicationRecord" || parent === "ActiveRecord::Base") return "Model: " + className;
    if (bn.match(/^\d{14}_/)) {
      const create = content.match(/create_table\s+:(\w+)/);
      return create ? "Migration: create " + create[1] : "Database migration";
    }
    const methods = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_"));
    if (cls && methods.length) return cap(className + ": " + methods.slice(0, 4).join(", "));
  }

  // ─── Swift ───────────────────────────────────────────────
  if (ext === ".swift") {
    if (content.includes(": View") || content.includes("some View")) {
      const name = content.match(/struct\s+(\w+)\s*:\s*View/);
      return name ? "SwiftUI view: " + name[1] : "SwiftUI view";
    }
    const proto = content.match(/protocol\s+(\w+)/);
    if (proto) return "Protocol: " + proto[1];
    const struct = content.match(/(?:public\s+)?struct\s+(\w+)/);
    const cls = content.match(/(?:public\s+)?class\s+(\w+)/);
    const name = struct?.[1] || cls?.[1] || "";
    if (name) return (struct ? "Struct" : "Class") + ": " + name;
  }

  // ─── Dart / Flutter ──────────────────────────────────────
  if (ext === ".dart") {
    if (content.includes("StatefulWidget") || content.includes("StatelessWidget")) {
      const name = content.match(/class\s+(\w+)\s+extends\s+(?:Stateful|Stateless)Widget/);
      return name ? (content.includes("StatefulWidget") ? "Stateful" : "Stateless") + " widget: " + name[1] : "Flutter widget";
    }
    const cls = content.match(/class\s+(\w+)/);
    if (cls) return "Class: " + cls[1];
  }

  // ─── Vue / Svelte / Astro ────────────────────────────────
  if (ext === ".vue") {
    const name = content.match(/name:\s*['"]([^'"]+)['"]/);
    const setup = content.includes("<script setup");
    const parts = [];
    if (name) parts.push(name[1]);
    if (setup) parts.push("setup");
    return cap(parts.length ? "Vue: " + parts.join(", ") : "Vue component");
  }
  if (ext === ".svelte") return "Svelte: " + bn.replace(".svelte", "");
  if (ext === ".astro") return "Astro: " + bn.replace(".astro", "");

  // ─── CSS / SCSS / Less ───────────────────────────────────
  if (ext === ".css" || ext === ".scss" || ext === ".less") {
    const rules = (content.match(/^[.#@][^\n{]+/gm) || []).length;
    const vars = (content.match(/--[\w-]+\s*:/g) || []).length;
    const parts = [];
    if (rules) parts.push(rules + " rules");
    if (vars) parts.push(vars + " vars");
    return cap(parts.length ? "Styles: " + parts.join(", ") : "Stylesheet");
  }

  // ─── SQL ─────────────────────────────────────────────────
  if (ext === ".sql") {
    const creates = (content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/gi) || [])
      .map(m => m.match(/(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([`"']?\w+)/i)?.[1]?.replace(/[`"']/g, "")).filter(Boolean);
    if (creates.length) return cap("SQL: tables: " + creates.slice(0, 4).join(", "));
  }

  // ─── Proto / GraphQL ─────────────────────────────────────
  if (ext === ".proto") {
    const msgs = (content.match(/message\s+(\w+)/g) || []).map(m => m.match(/message\s+(\w+)/)?.[1]).filter(Boolean);
    const services = (content.match(/service\s+(\w+)/g) || []).map(m => m.match(/service\s+(\w+)/)?.[1]).filter(Boolean);
    const parts = [];
    if (msgs.length) parts.push("messages: " + msgs.slice(0, 3).join(", "));
    if (services.length) parts.push("services: " + services.join(", "));
    return cap(parts.length ? "Proto: " + parts.join(", ") : "");
  }
  if (ext === ".graphql" || ext === ".gql") {
    const types = (content.match(/type\s+(\w+)/g) || []).map(m => m.match(/type\s+(\w+)/)?.[1]).filter(Boolean);
    return cap(types.length ? "GraphQL: types: " + types.slice(0, 4).join(", ") : "GraphQL schema");
  }

  // ─── YAML ────────────────────────────────────────────────
  if (ext === ".yaml" || ext === ".yml") {
    if (content.includes("runs-on:")) {
      const name = content.match(/^name:\s*(.+)$/m);
      return cap(name ? "CI: " + name[1].trim() : "GitHub Actions workflow");
    }
    if (content.includes("apiVersion:") && content.includes("kind:")) {
      const kind = content.match(/kind:\s*(\w+)/);
      return cap(kind ? "K8s " + kind[1] : "Kubernetes manifest");
    }
    if (content.includes("services:") && (bn.includes("docker") || bn.includes("compose"))) {
      const services = (content.match(/^\s{2}\w+:/gm) || []).length;
      return "Docker Compose: " + services + " services";
    }
  }

  // ─── TOML ────────────────────────────────────────────────
  if (ext === ".toml") {
    const desc = content.match(/^description\s*=\s*"([^"]+)"/m);
    if (desc) return cap(desc[1]);
  }

  // ─── Elixir ──────────────────────────────────────────────
  if (ext === ".ex" || ext === ".exs") {
    const mod = content.match(/defmodule\s+([\w.]+)/);
    if (content.includes("Phoenix.LiveView")) return cap(mod ? "LiveView: " + mod[1] : "Phoenix LiveView");
    if (content.includes("Controller")) return cap(mod ? "Phoenix controller: " + mod[1] : "Phoenix controller");
    const fns = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(Boolean);
    if (mod && fns.length) return cap(mod[1] + ": " + fns.slice(0, 4).join(", "));
    if (mod) return mod[1];
  }

  // ─── Lua ─────────────────────────────────────────────────
  if (ext === ".lua") {
    const fns = (content.match(/function\s+(?:\w+[.:])?(\w+)/g) || []).map(m => m.match(/(\w+)\s*$/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── Zig ─────────────────────────────────────────────────
  if (ext === ".zig") {
    const fns = (content.match(/pub\s+fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // Last resort
  const declM = content.match(/(?:function|class|const|interface|type|enum)\s+(\w+)/);
  if (declM) {
    const name = declM[1];
    const methods = (content.match(/(?:public\s+)?(?:async\s+)?(?:function\s+|(?:get|set)\s+)(\w+)\s*\(/g) || [])
      .map(m => m.match(/(\w+)\s*\(/)?.[1]).filter(n => n && n !== name && n !== "__construct" && n !== "constructor");
    if (methods.length > 0 && methods.length <= 5) return cap(name + ": " + methods.join(", "));
    if (methods.length > 5) return cap(name + ": " + methods.slice(0, 3).join(", ") + " + " + (methods.length - 3) + " more");
    return "Declares " + name;
  }
  return "";
}

// ─────────────────────────────────────────────
// Edit Summarizer (VERBATIM from post-write.ts L186-274)
// ─────────────────────────────────────────────

function summarizeEdit(oldStr, newStr, filename) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const ext = extname(filename).toLowerCase();

  // --- Structural fixes ---
  if (newStr.includes("try") && newStr.includes("catch") && !oldStr.includes("catch")) {
    return "added error handling";
  }
  if (newStr.includes("?.") && !oldStr.includes("?.")) return "added optional chaining";
  if (newStr.includes("?? ") && !oldStr.includes("?? ")) return "added nullish coalescing";

  // --- Deleted code ---
  if (!newStr.trim() || newStr.trim().length < oldStr.trim().length * 0.2) {
    return "removed " + oldCount + " lines";
  }

  // --- Import changes ---
  const oldImports = oldLines.filter(l => /^\s*(import|require|use |from )/.test(l)).length;
  const newImports = newLines.filter(l => /^\s*(import|require|use |from )/.test(l)).length;
  if (newImports > oldImports && Math.abs(newCount - oldCount) <= newImports - oldImports + 1) {
    return "added " + (newImports - oldImports) + " import(s)";
  }

  // --- Value/string replacement (common bug fix: wrong value) ---
  if (oldCount === 1 && newCount === 1) {
    const o = oldStr.trim();
    const n = newStr.trim();
    // String literal change
    const oStr = o.match(/['"`]([^'"`]+)['"`]/);
    const nStr = n.match(/['"`]([^'"`]+)['"`]/);
    if (oStr && nStr && oStr[1] !== nStr[1]) {
      return '"' + oStr[1].slice(0, 25) + '" → "' + nStr[1].slice(0, 25) + '"';
    }
    // Number change
    const oNum = o.match(/\b(\d+\.?\d*)\b/);
    const nNum = n.match(/\b(\d+\.?\d*)\b/);
    if (oNum && nNum && oNum[1] !== nNum[1] && o.replace(oNum[1], "") === n.replace(nNum[1], "")) {
      return oNum[1] + " → " + nNum[1];
    }
    return "inline fix";
  }

  // --- Method/function call changes ---
  const oldCalls = extractCalls(oldStr);
  const newCalls = extractCalls(newStr);
  const addedCalls = newCalls.filter(c => !oldCalls.includes(c));
  const removedCalls = oldCalls.filter(c => !newCalls.includes(c));
  if (removedCalls.length === 1 && addedCalls.length === 1) {
    return removedCalls[0] + "() → " + addedCalls[0] + "()";
  }

  // --- CSS/style changes ---
  if (ext === ".css" || ext === ".scss" || ext === ".vue" || ext === ".tsx" || ext === ".jsx") {
    const oldProps = (oldStr.match(/[\w-]+\s*:/g) || []).map(p => p.replace(/\s*:/, ""));
    const newProps = (newStr.match(/[\w-]+\s*:/g) || []).map(p => p.replace(/\s*:/, ""));
    const changed = newProps.filter(p => !oldProps.includes(p));
    if (changed.length > 0 && changed.length <= 3) {
      return "CSS: " + changed.join(", ");
    }
  }

  // --- Condition changes ---
  const oldConds = (oldStr.match(/if\s*\(([^)]+)\)/g) || []);
  const newConds = (newStr.match(/if\s*\(([^)]+)\)/g) || []);
  if (newConds.length > oldConds.length) {
    return "added " + (newConds.length - oldConds.length) + " condition(s)";
  }

  // --- Function modified ---
  const fnMatch = newStr.match(/(?:function|def|fn|func|async\s+function)\s+(\w+)/);
  if (fnMatch) {
    return "modified " + fnMatch[1] + "()";
  }

  // --- Class/method context ---
  const methodMatch = newStr.match(/(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/);
  if (methodMatch) {
    return "modified " + methodMatch[1] + "()";
  }

  // --- Size-based fallback ---
  if (newCount > oldCount + 5) return "expanded (+" + (newCount - oldCount) + " lines)";
  if (oldCount > newCount + 5) return "reduced (-" + (oldCount - newCount) + " lines)";

  return oldCount + "→" + newCount + " lines";
}

function extractCalls(code) {
  return [...new Set(
    (code.match(/(\w+)\s*\(/g) || [])
      .map(m => m.match(/(\w+)/)?.[1] || "")
      .filter(n => n.length > 2 && !["if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "instanceof", "const", "let", "var"].includes(n))
  )];
}

// ─────────────────────────────────────────────
// Bug Detection (VERBATIM from post-write.ts L175-538)
// ─────────────────────────────────────────────

function detectFixPattern(oldStr, newStr, ext) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // --- Error handling added ---
  if (newStr.includes("catch") && !oldStr.includes("catch")) {
    const fn = newStr.match(/(?:function|def|async)\s+(\w+)/)?.[1] || "unknown";
    return {
      category: "error-handling",
      summary: "Missing error handling in " + basename(fn),
      rootCause: "Code path had no error handling — exceptions would propagate uncaught",
      fix: "Added try/catch block",
      context: extractChangedLines(oldStr, newStr),
    };
  }

  // --- Null/undefined safety ---
  if ((newStr.includes("?.") && !oldStr.includes("?.")) ||
      (newStr.includes("?? ") && !oldStr.includes("?? ")) ||
      (/!==?\s*(null|undefined)/.test(newStr) && !/!==?\s*(null|undefined)/.test(oldStr))) {
    return {
      category: "null-safety",
      summary: "Null/undefined access",
      rootCause: "Property access on potentially null/undefined value",
      fix: "Added null safety (optional chaining or null check)",
      context: extractChangedLines(oldStr, newStr),
    };
  }

  // --- Guard clause / early return added ---
  if (/if\s*\([^)]*\)\s*(return|throw|continue|break)/.test(newStr) &&
      !/if\s*\([^)]*\)\s*(return|throw|continue|break)/.test(oldStr)) {
    const condition = newStr.match(/if\s*\(([^)]+)\)/)?.[1]?.trim().slice(0, 60) || "condition";
    return {
      category: "guard-clause",
      summary: "Missing guard clause",
      rootCause: "No early return/throw for edge case: " + condition,
      fix: "Added guard clause: if (" + condition.slice(0, 40) + ")",
    };
  }

  // --- Wrong value / string fix (very common bug) ---
  if (oldLines.length <= 3 && newLines.length <= 3) {
    const oldJoined = oldStr.trim();
    const newJoined = newStr.trim();
    // String literal changed
    const oStrs = oldJoined.match(/['"`]([^'"`]{2,})['"`]/g) || [];
    const nStrs = newJoined.match(/['"`]([^'"`]{2,})['"`]/g) || [];
    if (oStrs.length > 0 && nStrs.length > 0) {
      for (let i = 0; i < Math.min(oStrs.length, nStrs.length); i++) {
        if (oStrs[i] !== nStrs[i]) {
          return {
            category: "wrong-value",
            summary: "Incorrect value in code",
            rootCause: "Had " + oStrs[i].slice(0, 50),
            fix: "Changed to " + nStrs[i].slice(0, 50),
          };
        }
      }
    }

    // Variable name / method call changed
    const oldTokens = tokenizeCode(oldJoined);
    const newTokens = tokenizeCode(newJoined);
    const changed = [];
    for (let i = 0; i < Math.min(oldTokens.length, newTokens.length); i++) {
      if (oldTokens[i] !== newTokens[i]) {
        changed.push([oldTokens[i], newTokens[i]]);
      }
    }
    if (changed.length === 1 && changed[0][0].length > 2) {
      return {
        category: "wrong-reference",
        summary: "Wrong reference: " + changed[0][0] + " should be " + changed[0][1],
        rootCause: 'Used "' + changed[0][0] + '" instead of "' + changed[0][1] + '"',
        fix: "Changed " + changed[0][0] + " → " + changed[0][1],
      };
    }
  }

  // --- Logic fix (condition changed) ---
  const oldCond = oldStr.match(/if\s*\(([^)]+)\)/)?.[1];
  const newCond = newStr.match(/if\s*\(([^)]+)\)/)?.[1];
  if (oldCond && newCond && oldCond !== newCond && oldLines.length <= 5) {
    return {
      category: "logic-fix",
      summary: "Wrong condition in logic",
      rootCause: "Condition was: if (" + oldCond.slice(0, 50) + ")",
      fix: "Changed to: if (" + newCond.slice(0, 50) + ")",
    };
  }

  // --- Operator fix (=== vs ==, > vs >=, etc.) ---
  const opChange = findOperatorChange(oldStr, newStr);
  if (opChange) {
    return {
      category: "operator-fix",
      summary: "Wrong operator: " + opChange.old + " should be " + opChange.new,
      rootCause: 'Used "' + opChange.old + '" instead of "' + opChange.new + '"',
      fix: "Changed operator " + opChange.old + " → " + opChange.new,
    };
  }

  // --- Missing import/require ---
  const oldImports = new Set((oldStr.match(/(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g) || []).map(m => m));
  const newImports = (newStr.match(/(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g) || []);
  const addedImports = newImports.filter(i => !oldImports.has(i));
  if (addedImports.length > 0 && newLines.length - oldLines.length <= addedImports.length + 2) {
    const modules = addedImports.map(i => i.match(/['"]([^'"]+)['"]/)?.[1] || "").filter(Boolean);
    return {
      category: "missing-import",
      summary: "Missing import: " + modules.join(", "),
      rootCause: "Module(s) not imported: " + modules.join(", "),
      fix: "Added import(s) for " + modules.join(", "),
    };
  }

  // --- Return value fix ---
  const oldReturn = oldStr.match(/return\s+(.+)/)?.[1]?.trim();
  const newReturn = newStr.match(/return\s+(.+)/)?.[1]?.trim();
  if (oldReturn && newReturn && oldReturn !== newReturn && oldLines.length <= 5) {
    return {
      category: "return-value",
      summary: "Wrong return value",
      rootCause: "Was returning: " + oldReturn.slice(0, 50),
      fix: "Now returns: " + newReturn.slice(0, 50),
    };
  }

  // --- Async/await fix ---
  if (newStr.includes("await ") && !oldStr.includes("await ")) {
    return {
      category: "async-fix",
      summary: "Missing await",
      rootCause: "Async call without await — returned Promise instead of value",
      fix: "Added await to async call",
      context: extractChangedLines(oldStr, newStr),
    };
  }
  if (newStr.includes("async ") && !oldStr.includes("async ")) {
    return {
      category: "async-fix",
      summary: "Function not marked async",
      rootCause: "Function uses await but wasn't declared async",
      fix: "Added async modifier",
    };
  }

  // --- Type annotation/cast fix ---
  if (ext === ".ts" || ext === ".tsx") {
    if ((newStr.includes(" as ") && !oldStr.includes(" as ")) ||
        (newStr.includes(": ") && !oldStr.includes(": ") && oldLines.length <= 3)) {
      return {
        category: "type-fix",
        summary: "Type error",
        rootCause: "Missing or incorrect type annotation",
        fix: "Added type assertion/annotation",
        context: extractChangedLines(oldStr, newStr),
      };
    }
  }

  // --- CSS/style fix ---
  if (ext === ".css" || ext === ".scss" || ext === ".vue" || ext === ".tsx" || ext === ".jsx") {
    const oldProps = extractCSSProps(oldStr);
    const newProps = extractCSSProps(newStr);
    const changedProps = [...newProps.entries()].filter(([k, v]) => oldProps.get(k) !== v && oldProps.has(k));
    if (changedProps.length > 0 && changedProps.length <= 3) {
      const desc = changedProps.map(([k, v]) => k + ": " + oldProps.get(k) + " → " + v).join("; ");
      return {
        category: "style-fix",
        summary: "CSS fix: " + changedProps.map(([k]) => k).join(", "),
        rootCause: desc,
        fix: "Changed " + desc,
      };
    }
  }

  // --- Significant diff (catch-all for substantial edits) ---
  const diffRatio = Math.abs(newStr.length - oldStr.length) / Math.max(oldStr.length, 1);
  if (diffRatio > 0.3 && oldLines.length >= 3 && newLines.length >= 3) {
    const removedLines = oldLines.filter(l => l.trim() && !newLines.some(nl => nl.trim() === l.trim()));
    if (removedLines.length >= 2) {
      return {
        category: "refactor",
        summary: "Significant refactor",
        rootCause: removedLines.length + " lines replaced/restructured",
        fix: "Rewrote " + oldLines.length + "→" + newLines.length + " lines (" + removedLines.length + " removed)",
        context: removedLines.slice(0, 2).map(l => l.trim().slice(0, 50)).join("; "),
      };
    }
  }

  return null;
}

function extractChangedLines(oldStr, newStr) {
  const oldLines = new Set(oldStr.split("\n").map(l => l.trim()).filter(Boolean));
  const newLines = newStr.split("\n").map(l => l.trim()).filter(Boolean);
  const added = newLines.filter(l => !oldLines.has(l));
  return added.slice(0, 2).map(l => l.slice(0, 60)).join("; ");
}

function tokenizeCode(code) {
  return code.replace(/[^\w$]/g, " ").split(/\s+/).filter(t => t.length > 0);
}

function findOperatorChange(oldStr, newStr) {
  const operators = ["===", "!==", "==", "!=", ">=", "<=", ">>", "<<", "&&", "||", "??"];
  for (const op of operators) {
    if (oldStr.includes(op) && !newStr.includes(op)) {
      for (const op2 of operators) {
        if (op2 !== op && newStr.includes(op2) && !oldStr.includes(op2)) {
          return { old: op, new: op2 };
        }
      }
    }
  }
  return null;
}

function extractCSSProps(code) {
  const props = new Map();
  const matches = code.matchAll(/([\w-]+)\s*:\s*([^;}\n]+)/g);
  for (const m of matches) {
    props.set(m[1].trim(), m[2].trim());
  }
  return props;
}

// ─────────────────────────────────────────────
// Plugin State
// ─────────────────────────────────────────────

let projectDir = "";
let worktreeDir = "";
let anatomyCache = new Map();
let readHistory = new Map();
let writeHistory = new Map();
let graphifyNodes = new Map();
let graphifyByFile = new Map();
let graphifyLinks = [];
let sessionMeta = {
  id: "", started: "",
  anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
  recordedCerebrumWarnings: [],
  recordedBuglogMatches: [],
  sessionNags: {
    cerebrumEntryCount: null,
    cerebrumDaysSinceUpdate: null,
    cerebrumHoursSinceUpdate: null,
    buglogIsEmpty: false,
    multiEditFiles: [],
  },
};
let updateTimer = null;
let sessionStopped = false;

// ─────────────────────────────────────────────
// Graphify Data Loading
// ─────────────────────────────────────────────

function loadGraphifyData(dir) {
  const graphPath = join(dir, "graphify-out", "graph.json");
  if (!existsSync(graphPath)) return;
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    graphifyLinks = graph.links || [];
    for (const node of graph.nodes || []) {
      const normLabel = (node.norm_label || node.label || "").toLowerCase();
      if (!normLabel) continue;
      if (!graphifyNodes.has(normLabel)) graphifyNodes.set(normLabel, []);
      graphifyNodes.get(normLabel).push(node);
      const srcFile = node.source_file || "";
      if (srcFile) {
        const normFile = normalizePath(srcFile);
        if (!graphifyByFile.has(normFile)) graphifyByFile.set(normFile, []);
        graphifyByFile.get(normFile).push(node);
      }
    }
  } catch {}
}

function computeGodNodes(limit = 10) {
  if (graphifyLinks.length === 0) return [];
  const degreeMap = new Map();
  for (const link of graphifyLinks) {
    if (link.source) degreeMap.set(link.source, (degreeMap.get(link.source) || 0) + 1);
    if (link.target) degreeMap.set(link.target, (degreeMap.get(link.target) || 0) + 1);
  }
  const sorted = [...degreeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const result = [];
  for (const [id, degree] of sorted) {
    let label = id, community = "?", fileType = "?", sourceFile = "";
    for (const nodes of graphifyNodes.values()) {
      const found = nodes.find(n => n.id === id);
      if (found) { label = found.label; community = found.community || "?"; fileType = found.file_type || "?"; sourceFile = found.source_file || ""; break; }
    }
    result.push({ label, degree, community, fileType, sourceFile });
  }
  return result;
}

// ─────────────────────────────────────────────
// Session Stop (shared by event.idle and dispose)
// ─────────────────────────────────────────────

async function stopSession() {
  if (sessionStopped) return;
  sessionStopped = true;
  const sessionFile = wolfPath(projectDir, "_session.json");
  const session = readJson(sessionFile);
  if (!session) return;

  const now = new Date();
  const readEntries = [];
  for (const [file, info] of readHistory.entries()) {
    readEntries.push({ file, tokens_estimated: info.tokens, was_repeated: info.count > 1 });
  }
  const writtenFiles = session.files_written || [];
  const editCounts = session.edit_counts || {};
  let inputTokens = 0;
  for (const info of readHistory.values()) inputTokens += info.tokens * info.count;
  let outputTokens = 0;
  for (const f of writtenFiles) outputTokens += 50;

  const readCount = readHistory.size;
  const writeCount = writtenFiles.length;
  if (readCount === 0 && writeCount === 0) return;

  const sessionEntry = {
    id: sessionMeta.id,
    started: sessionMeta.started,
    ended: now.toISOString(),
    reads: readEntries,
    writes: writtenFiles.map(f => ({ file: f, tokens_estimated: 50 })),
    totals: {
      input_tokens_estimated: inputTokens,
      output_tokens_estimated: outputTokens,
      reads_count: readCount,
      writes_count: writeCount,
      repeated_reads_blocked: sessionMeta.repeatedWarned,
      anatomy_lookups: sessionMeta.anatomyHits + sessionMeta.anatomyMisses,
    },
  };

  const ledgerFile = wolfPath(projectDir, "token-ledger.json");
  const ledger = readJson(ledgerFile) || { sessions: [], lifetime: {} };
  if (!ledger.sessions) ledger.sessions = [];
  if (!ledger.lifetime) ledger.lifetime = {};
  ledger.sessions.push(sessionEntry);
  const lt = ledger.lifetime;
  lt.total_reads = (lt.total_reads || 0) + readCount;
  lt.total_writes = (lt.total_writes || 0) + writeCount;
  lt.total_tokens_estimated = (lt.total_tokens_estimated || 0) + inputTokens + outputTokens;
  lt.anatomy_hits = (lt.anatomy_hits || 0) + sessionMeta.anatomyHits;
  lt.anatomy_misses = (lt.anatomy_misses || 0) + sessionMeta.anatomyMisses;
  lt.repeated_reads_blocked = (lt.repeated_reads_blocked || 0) + sessionMeta.repeatedWarned;
  const savedFromAnatomy = sessionMeta.anatomyHits * ANATOMY_SAVINGS_PER_HIT;
  let savedFromRepeats = 0;
  for (const info of readHistory.values()) {
    if (info.count > 1) savedFromRepeats += info.tokens * (info.count - 1);
  }
  lt.estimated_savings_vs_bare_cli = (lt.estimated_savings_vs_bare_cli || 0) + savedFromAnatomy + savedFromRepeats;
  try { writeJson(ledgerFile, ledger); } catch {}

  // Memory summary
  if (writeCount > 0) {
    const memoryFile = wolfPath(projectDir, "memory.md");
    const timeHhMm = now.toTimeString().slice(0, 5);
    const uniqueBasenames = [...new Set(writtenFiles.map(f => basename(f)))].slice(0, 5).join(", ");
    const totalTok = inputTokens + outputTokens;
    const row = "| " + timeHhMm + " | Session end: " + writeCount + " writes across " + uniqueBasenames + " | " + readCount + " reads | ~" + totalTok + " tok |\n";
    try { appendFileSync(memoryFile, row); } catch {}
  }

  // Missing buglog nag — stored in sessionNags, surfaced via wolf_status
  const multiEditFiles = Object.entries(editCounts).filter(([, c]) => c >= REPEATED_EDIT_THRESHOLD).map(([f]) => f);
  if (multiEditFiles.length > 0) {
    const hasBuglogEdit = writtenFiles.some(f => f.includes("buglog.json"));
    if (!hasBuglogEdit) {
      sessionMeta.sessionNags.multiEditFiles = multiEditFiles.map(basename);
    }
  }

  // Cerebrum freshness — stored in sessionNags, surfaced via wolf_status
  const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
  if (existsSync(cerebrumFile) && writeCount >= 3) {
    const stat = statSync(cerebrumFile);
    const hoursSince = (Date.now() - stat.mtimeMs) / 3600000;
    if (hoursSince > 24) {
      sessionMeta.sessionNags.cerebrumHoursSinceUpdate = Math.floor(hoursSince);
    }
  }
}

// ─────────────────────────────────────────────
// Graphify Auto-Update (debounced)
// ─────────────────────────────────────────────

function scheduleGraphifyUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    const manifestPath = join(projectDir, "graphify-out", "manifest.json");
    const before = readJson(manifestPath);
    const beforeHash = before?.ast_hash || "";
    try {
      execSync("graphify update .", { cwd: projectDir, stdio: "pipe", timeout: 30000 });
      const after = readJson(manifestPath);
      const afterHash = after?.ast_hash || "";
      if (afterHash && afterHash !== beforeHash) {
        loadGraphifyData(projectDir);
      }
    } catch {}
    updateTimer = null;
  }, 5000);
  updateTimer.unref();
}

// ─────────────────────────────────────────────
// Plugin Export
// ─────────────────────────────────────────────

export const OpenWolfPlugin = async ({ directory, worktree }) => {
  projectDir = directory;
  worktreeDir = worktree || directory;
  ensureWolfDir(directory);

  return {
    // === Lifecycle hooks ===
    dispose: async () => {
      await stopSession();
      if (updateTimer) clearTimeout(updateTimer);
    },

    // === Event hooks (session.created, session.idle) ===
    event: async ({ event }) => {
      if (event.type === "session.created") {
        sessionStopped = false;
        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
        sessionMeta = {
          id: "session-" + dateStr + "-" + timeStr,
          started: now.toISOString(),
          anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
          recordedCerebrumWarnings: [],
          recordedBuglogMatches: [],
          sessionNags: {
            cerebrumEntryCount: null,
            cerebrumDaysSinceUpdate: null,
            cerebrumHoursSinceUpdate: null,
            buglogIsEmpty: false,
            multiEditFiles: [],
          },
        };
        ensureWolfDir(projectDir);
        try {
          writeJson(wolfPath(projectDir, "_session.json"), {
            session_id: sessionMeta.id, started: sessionMeta.started,
            files_read: {}, files_written: [], edit_counts: {},
            anatomy_hits: 0, anatomy_misses: 0,
            repeated_reads_warned: 0, cerebrum_warnings: 0, stop_count: 0,
          });
        } catch {}

        // Load anatomy cache
        const anatomyFile = wolfPath(projectDir, "anatomy.md");
        if (existsSync(anatomyFile)) anatomyCache = parseAnatomy(readFileSync(anatomyFile, "utf8"));

        // Load graphify
        loadGraphifyData(projectDir);

        // Append memory header
        const memoryFile = wolfPath(projectDir, "memory.md");
        const timeHhMm = now.toTimeString().slice(0, 5);
        const header = "\n## Session: " + dateStr + " " + timeHhMm + "\n\n| Time | Action | File(s) | Outcome | ~Tokens |\n|------|--------|---------|---------|---------|\n";
        try { appendFileSync(memoryFile, header); }
        catch { atomicWrite(memoryFile, header.trimStart()); }

        // Cerebrum freshness check — stored in sessionNags, surfaced via wolf_status
        const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
        if (existsSync(cerebrumFile)) {
          const content = readFileSync(cerebrumFile, "utf8");
          const entryLines = content.split("\n").filter(l => /^[-*]\s|\[.*\]/.test(l.trim()));
          sessionMeta.sessionNags.cerebrumEntryCount = entryLines.length;
          if (entryLines.length >= 3) {
            const stat = statSync(cerebrumFile);
            const daysSince = (Date.now() - stat.mtimeMs) / 86400000;
            sessionMeta.sessionNags.cerebrumDaysSinceUpdate = Math.floor(daysSince);
          }
        }

        // Buglog emptiness check — stored in sessionNags, surfaced via wolf_status
        const buglog = readJson(wolfPath(projectDir, "buglog.json"));
        if (buglog && Array.isArray(buglog.bugs) && buglog.bugs.length === 0) {
          sessionMeta.sessionNags.buglogIsEmpty = true;
        }

        // Increment ledger
        const ledgerFile = wolfPath(projectDir, "token-ledger.json");
        const ledger = readJson(ledgerFile) || { sessions: [], lifetime: { total_tokens_estimated: 0, total_reads: 0, total_writes: 0, total_sessions: 0, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_blocked: 0, estimated_savings_vs_bare_cli: 0 } };
        ledger.lifetime.total_sessions++;
        try { writeJson(ledgerFile, ledger); } catch {}

        // Clean stale .tmp files
        try {
          for (const f of readdirSync(wolfPath(projectDir))) {
            if (f.endsWith(".tmp")) try { unlinkSync(wolfPath(projectDir, f)); } catch {}
          }
        } catch {}
      }

      if (event.type === "session.idle") {
        await stopSession();
      }
    },

    // === Tool hooks (pre/post Read/Write/Edit) ===
    "tool.execute.before": async (input, output) => {
      const toolName = input.tool;

      // --- Pre-Read: no-op (enrichment moved to tool.execute.after) ---
      if (toolName === "read") {
        return;
      }

      // --- Pre-Write/Edit: cerebrum + buglog ---
      if (toolName === "write" || toolName === "edit") {
        const filePath = output.args?.filePath || output.args?.file_path || output.args?.path || "";
        if (!filePath) return;
        const normalizedFile = normalizePath(filePath);
        const fileBase = basename(filePath);
        const newStr = output.args?.newString || output.args?.content || "";
        const oldStr = output.args?.oldString || "";

        // Cerebrum check
        const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
        if (existsSync(cerebrumFile)) {
          const cerebrum = readFileSync(cerebrumFile, "utf8");
          const dnrIdx = cerebrum.indexOf("## Do-Not-Repeat");
          if (dnrIdx >= 0) {
            const afterDnr = cerebrum.slice(dnrIdx);
            const nextH2 = afterDnr.indexOf("\n## ", 1);
            const dnrSection = nextH2 >= 0 ? afterDnr.slice(0, nextH2) : afterDnr;
            const entries = dnrSection.split("\n").filter(l => l.trim().startsWith("- ") || l.trim().startsWith("* ") || /^\[/.test(l.trim()));
            for (const entry of entries) {
              const trimmed = entry.replace(/^\s*[-*]\s/, "").replace(/^\[.*?\]\s*/, "").trim();
              if (!trimmed) continue;
              const patterns = [];
              const quoted = trimmed.match(/["'`]([^"'`]+)["'`]/g) || [];
              for (const q of quoted) patterns.push(q.slice(1, -1));
              const kwMatch = trimmed.match(/(?:never use|avoid|don't use|do not use)\s+(\w+)/i);
              if (kwMatch) patterns.push(kwMatch[1]);
              const combined = newStr + oldStr;
              for (const pat of patterns) {
                try {
                  const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                  const re = new RegExp("\\b" + escaped + "\\b", "i");
                  if (re.test(combined)) {
                    process.stderr.write("⚠️ OpenWolf cerebrum warning: \"" + trimmed.slice(0, 120) + "\" — check your code.\n");
                    sessionMeta.cerebrumWarnings++;
                    break;
                  }
                } catch {}
              }
            }
          }
        }

        // Buglog search
        const buglog = readJson(wolfPath(projectDir, "buglog.json"));
        if (buglog && Array.isArray(buglog.bugs) && buglog.bugs.length > 0) {
          const tokenize = (s) => s.replace(/[^a-zA-Z0-9_\s]/g, "").split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w.toLowerCase())).map(w => w.toLowerCase());
          const sameFileBugs = buglog.bugs.filter(b => basename(b.file || "") === fileBase);
          const editTokens = tokenize(newStr + " " + oldStr);
          const matched = [];
          for (const bug of sameFileBugs) {
            const bugContent = (bug.error_message || "") + " " + (bug.root_cause || "");
            const bugTags = (bug.tags || []).map(t => t.toLowerCase());
            const editLower = (newStr + oldStr).toLowerCase();
            const tagHit = bugTags.some(t => editLower.includes(t));
            const bugTokens = tokenize(bugContent);
            const overlap = editTokens.filter(t => bugTokens.includes(t)).length;
            if (tagHit || overlap >= 3) matched.push(bug);
            if (matched.length >= 2) break;
          }
          if (matched.length > 0) {
            process.stderr.write("📋 OpenWolf buglog: " + matched.length + " past bug(s) for " + fileBase + ":\n");
            for (const bug of matched) {
              process.stderr.write("   [" + bug.id + "] \"" + (bug.error_message || "").slice(0, 70) + "\"\n");
              process.stderr.write("   Cause: " + (bug.root_cause || "").slice(0, 80) + "\n");
              process.stderr.write("   Fix: " + (bug.fix || "").slice(0, 80) + "\n");
            }
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      // --- Post-Read: token estimation ---
      if (input.tool === "read") {
        const filePath = input.args?.filePath || input.args?.file_path || input.args?.path || "";
        if (!filePath || filePath.includes("/.wolf/")) return;
        const normalizedFile = normalizePath(filePath);
        const content = output.output || "";
        const type = classifyFileType(filePath);
        let tokens = estimateTokens(content, type);
        if (tokens === 0) {
          for (const entries of anatomyCache.values()) {
            const entry = entries.find(e => normalizedFile.endsWith(normalizePath(e.file)));
            if (entry) { tokens = entry.tokens; break; }
          }
        }
        if (readHistory.has(normalizedFile)) {
          readHistory.get(normalizedFile).tokens = tokens;
        } else {
          readHistory.set(normalizedFile, { count: 1, tokens, firstRead: new Date().toISOString() });
        }
        const sessionFile = wolfPath(projectDir, "_session.json");
        const session = readJson(sessionFile);
        if (session) {
          if (!session.files_read) session.files_read = {};
          const info = readHistory.get(normalizedFile);
          session.files_read[normalizedFile] = { count: info.count, tokens, first_read: info.firstRead };
          try { writeJson(sessionFile, session); } catch {}
        }

        const enrichParts = [];
        for (const [, entries] of anatomyCache.entries()) {
          const entry = entries.find(e => normalizedFile.endsWith(normalizePath(e.file)));
          if (entry) { enrichParts.push("📋 " + entry.file + ": " + entry.description + " (~" + entry.tokens + " tok)"); break; }
        }
        const relPath = normalizePath(relative(worktreeDir, filePath));
        const graphNodes = graphifyByFile.get(relPath) || graphifyByFile.get(normalizedFile) || [];
        if (graphNodes.length > 0) {
          const relatedIds = new Set();
          for (const link of graphifyLinks) {
            for (const n of graphNodes.slice(0, 3)) {
              if (link.source === n.id) relatedIds.add(link.target);
              if (link.target === n.id) relatedIds.add(link.source);
            }
          }
          if (relatedIds.size > 0) {
            const related = [...relatedIds].slice(0, 5).map(id => {
              for (const nodes of graphifyNodes.values()) {
                const found = nodes.find(n => n.id === id);
                if (found) return found.label;
              }
              return id;
            });
            enrichParts.push("🕸️ Related: " + related.join(", "));
          }
        }
        if (enrichParts.length > 0) {
          output.output = "[OpenWolf] " + enrichParts.join(" | ") + "\n\n" + (output.output || "");
        }
      }

      // --- Post-Write/Edit: anatomy update + memory + bug detection + graphify ---
      if (input.tool === "write" || input.tool === "edit") {
        const filePath = input.args?.filePath || input.args?.file_path || input.args?.path || "";
        if (!filePath || filePath.includes("/.wolf/")) return;
        const normalizedFile = normalizePath(filePath);
        const relPath = normalizePath(relative(worktreeDir, filePath));
        const fileBase = basename(filePath);

        // Track write
        writeHistory.set(normalizedFile, (writeHistory.get(normalizedFile) || 0) + 1);
        const sessionFile = wolfPath(projectDir, "_session.json");
        const session = readJson(sessionFile) || {};
        if (!session.files_written) session.files_written = [];
        if (!session.files_written.includes(relPath)) session.files_written.push(relPath);
        if (!session.edit_counts) session.edit_counts = {};
        session.edit_counts[relPath] = (session.edit_counts[relPath] || 0) + 1;

        // Repeated-edit warning
        if (session.edit_counts[relPath] >= REPEATED_EDIT_THRESHOLD) {
          process.stderr.write("⚠️ OpenWolf: " + fileBase + " edited " + session.edit_counts[relPath] + " times. Log bugs to .wolf/buglog.json.\n");
        }

        // Anatomy update
        const newStr = input.args?.newString || input.args?.content || "";
        const oldStr = input.args?.oldString || "";
        let fileContent = "";
        try { fileContent = readFileSync(filePath, "utf8"); } catch { fileContent = newStr; }
        if (fileContent) {
          const sectionKey = normalizePath(dirname(relPath)) + "/";
          const type = classifyFileType(filePath);
          const tokens = estimateTokens(fileContent, type);
          const description = extractDescription(filePath).slice(0, MAX_DESCRIPTION_LENGTH);
          if (!anatomyCache.has(sectionKey)) anatomyCache.set(sectionKey, []);
          const entries = anatomyCache.get(sectionKey);
          const existingIdx = entries.findIndex(e => relPath.endsWith(normalizePath(e.file)));
          const entry = { file: basename(filePath), description, tokens };
          if (existingIdx >= 0) entries[existingIdx] = entry;
          else entries.push(entry);
          // Persist anatomy
          try { atomicWrite(wolfPath(projectDir, "anatomy.md"), serializeAnatomy(anatomyCache)); } catch {}
        }

        // Memory log
        const memoryFile = wolfPath(projectDir, "memory.md");
        const now = new Date();
        const timeHhMm = now.toTimeString().slice(0, 5);
        const action = input.tool === "write" ? "Created" : "Edited";
        const changeDesc = summarizeEdit(oldStr, newStr, fileBase);
        const writeTokens = estimateTokens(newStr || "", classifyFileType(filePath));
        const row = "| " + timeHhMm + " | " + action + " " + relPath + " | " + changeDesc + " | ~" + writeTokens + " |\n";
        try { appendFileSync(memoryFile, row); } catch {}

        // Bug detection
        if (oldStr && newStr) {
          const ext = extname(filePath).replace(".", "");
          const detection = detectFixPattern(oldStr, newStr, extname(filePath).toLowerCase());
          if (detection) {
            const buglogFile = wolfPath(projectDir, "buglog.json");
            const buglog = readJson(buglogFile) || { version: 1, bugs: [] };
            if (!Array.isArray(buglog.bugs)) buglog.bugs = [];
            const newBug = {
              id: "bug-" + String(buglog.bugs.length + 1).padStart(3, "0"),
              timestamp: now.toISOString(),
              error_message: detection.summary,
              file: relPath,
              root_cause: detection.rootCause,
              fix: detection.fix,
              tags: ["auto-detected", detection.category, ext].filter(Boolean),
              related_bugs: [],
              occurrences: 1,
              last_seen: now.toISOString(),
            };
            // Dedup: same file + category within 5 min
            const recent = buglog.bugs.find(b =>
              b.file === relPath &&
              b.tags.includes("auto-detected") &&
              b.tags.includes(detection.category) &&
              (Date.now() - new Date(b.last_seen || b.timestamp).getTime()) < 300000
            );
            if (recent) {
              recent.occurrences = (recent.occurrences || 1) + 1;
              recent.last_seen = now.toISOString();
            } else {
              buglog.bugs.push(newBug);
            }
            try { writeJson(buglogFile, buglog); } catch {}
          }
        }

        try { writeJson(sessionFile, session); } catch {}

        // Graphify auto-update
        scheduleGraphifyUpdate();
      }
    },

    // === System prompt injection ===
    "experimental.chat.system.transform": async (input, output) => {
      const parts = [];
      const anatomyCount = [...anatomyCache.values()].reduce((sum, entries) => sum + entries.length, 0);
      parts.push("[OpenWolf] Project intelligence active. " + anatomyCount + " files indexed. " + readHistory.size + " files read this session. Use wolf_status, wolf_search, wolf_graph tools.");
      if (graphifyNodes.size > 0) {
        const godNodes = computeGodNodes(10);
        const nodeLines = godNodes.map(n => "  - " + n.label + " (deg " + n.degree + ", community " + n.community + ")" + (n.sourceFile ? " [" + basename(n.sourceFile) + "]" : ""));
        const graphPart = "[Graphify] " + graphifyNodes.size + " symbols, " + graphifyLinks.length + " relationships.";
        parts.push(nodeLines.length > 0 ? graphPart + "\nKey nodes:\n" + nodeLines.join("\n") + "\nUse wolf_graph tool for queries." : graphPart);
      }
      if (parts.length > 0) output.system.push(parts.join("\n\n"));
    },

    // === Session compaction ===
    "experimental.session.compacting": async (input, output) => {
      const parts = [];
      parts.push("[OpenWolf] " + readHistory.size + " files read, " + writeHistory.size + " written. Anatomy hits: " + sessionMeta.anatomyHits + ", misses: " + sessionMeta.anatomyMisses + ".");
      const topReads = [...readHistory.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([f, info]) => basename(f) + " (" + info.count + "x, ~" + info.tokens + "tok)");
      if (topReads.length > 0) parts.push("Most-read: " + topReads.join(", "));
      output.context.push(parts.join("\n"));
    },

    // === Custom Tools ===
    tool: {
      wolf_status: tool({
        description: "Show OpenWolf session status — anatomy coverage, token usage, graphify state",
        args: {},
        execute: async (_args, ctx) => {
          const lines = [];
          lines.push("🐺 OpenWolf Status");
          lines.push("==================");
          lines.push("Session: " + sessionMeta.id);
          lines.push("Started: " + (sessionMeta.started || "not started"));
          lines.push("");
          const anatomyCount = [...anatomyCache.values()].reduce((sum, e) => sum + e.length, 0);
          lines.push("Anatomy: " + anatomyCount + " files indexed");
          lines.push("  Hits: " + sessionMeta.anatomyHits + ", Misses: " + sessionMeta.anatomyMisses);
          lines.push("");
          lines.push("Files read: " + readHistory.size);
          lines.push("Repeated-read warnings: " + sessionMeta.repeatedWarned);
          let totalReadTokens = 0;
          for (const info of readHistory.values()) totalReadTokens += info.tokens * info.count;
          lines.push("Estimated read tokens: ~" + totalReadTokens);
          lines.push("");
          lines.push("Files written: " + writeHistory.size);
          lines.push("Cerebrum warnings: " + sessionMeta.cerebrumWarnings);
          lines.push("");
          lines.push("Graphify: " + graphifyNodes.size + " symbols, " + graphifyLinks.length + " relationships");
          return { title: "OpenWolf Status", output: lines.join("\n") };
        },
      }),

      wolf_search: tool({
        description: "Search OpenWolf project intelligence — anatomy, cerebrum, memory, buglog",
        args: {
          query: z.string().describe("Search term"),
          scope: z.enum(["anatomy", "cerebrum", "memory", "buglog", "all"]).default("all").describe("Scope to search"),
        },
        execute: async ({ query, scope }, ctx) => {
          const results = [];
          const q = query.toLowerCase();
          if (scope === "all" || scope === "anatomy") {
            for (const [section, entries] of anatomyCache) {
              for (const e of entries) {
                if (e.file.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)) {
                  results.push("[anatomy] " + section + "/" + e.file + " — " + e.description + " (~" + e.tokens + " tok)");
                }
              }
            }
          }
          if (scope === "all" || scope === "cerebrum") {
            const cf = wolfPath(projectDir, "cerebrum.md");
            if (existsSync(cf)) {
              for (const line of readFileSync(cf, "utf8").split("\n")) {
                if (line.toLowerCase().includes(q) && line.trim()) results.push("[cerebrum] " + line.trim());
              }
            }
          }
          if (scope === "all" || scope === "memory") {
            const mf = wolfPath(projectDir, "memory.md");
            if (existsSync(mf)) {
              for (const line of readFileSync(mf, "utf8").split("\n")) {
                if (line.toLowerCase().includes(q) && line.trim().startsWith("|")) results.push("[memory] " + line.trim());
              }
            }
          }
          if (scope === "all" || scope === "buglog") {
            const bl = readJson(wolfPath(projectDir, "buglog.json"));
            if (bl && bl.bugs) {
              for (const bug of bl.bugs) {
                const text = [bug.error_message, bug.root_cause, bug.fix, ...(bug.tags || [])].join(" ");
                if (text.toLowerCase().includes(q)) {
                  results.push("[buglog] [" + bug.id + "] " + bug.error_message + " — " + bug.root_cause);
                }
              }
            }
          }
          if (results.length === 0) return { title: "Wolf Search", output: "No results for: " + query };
          return { title: "Wolf Search: " + query + " (" + results.length + ")", output: results.join("\n") };
        },
      }),

      wolf_graph: tool({
        description: "Query the graphify knowledge graph — find symbols, relationships, communities",
        args: {
          query: z.string().describe("Symbol name or concept"),
          depth: z.number().default(1).describe("Relationship depth (1 or 2)"),
        },
        execute: async ({ query, depth }, ctx) => {
          if (graphifyNodes.size === 0) return { title: "Wolf Graph", output: "Graph not loaded. Run 'graphify update .' first." };
          const q = query.toLowerCase();
          const direct = graphifyNodes.get(q) || [];
          if (direct.length === 0) {
            const partial = [];
            for (const [label, nodes] of graphifyNodes) {
              if (label.includes(q)) partial.push(...nodes);
            }
            if (partial.length > 0) {
              const lines = ["Partial matches for '" + query + "' (" + partial.length + "):"];
              for (const n of partial.slice(0, 10)) {
                lines.push("  " + n.label + " — " + (n.file_type || "?") + " in " + (n.source_file || "?") + " (community " + (n.community || "?") + ")");
              }
              return { title: "Wolf Graph", output: lines.join("\n") };
            }
            return { title: "Wolf Graph", output: "No nodes matching '" + query + "'." };
          }
          const lines = ["Exact match: " + query + " (" + direct.length + ")"];
          for (const n of direct) {
            lines.push("  " + n.label + " — " + (n.file_type || "?") + " in " + (n.source_file || "?") + " (community " + (n.community || "?") + ")");
          }
          if (depth >= 1) {
            const directIds = new Set(direct.map(n => n.id));
            const relatedIds = new Set();
            for (const n of direct) {
              for (const link of graphifyLinks) {
                if (link.source === n.id) relatedIds.add(link.target);
                if (link.target === n.id) relatedIds.add(link.source);
              }
            }
            if (relatedIds.size > 0) {
              lines.push("\nRelated (" + relatedIds.size + "):");
              const allNodes = new Map();
              for (const nodes of graphifyNodes.values()) for (const n of nodes) allNodes.set(n.id, n);
              for (const id of [...relatedIds].slice(0, 15)) {
                const node = allNodes.get(id);
                if (node) lines.push("  " + node.label + " (" + (node.file_type || "?") + ")");
              }
            }
            if (depth >= 2) {
              const twoHopIds = new Set();
              for (const id of relatedIds) {
                for (const link of graphifyLinks) {
                  if (link.source === id && !relatedIds.has(link.target) && !directIds.has(link.target)) twoHopIds.add(link.target);
                  if (link.target === id && !relatedIds.has(link.source) && !directIds.has(link.source)) twoHopIds.add(link.source);
                }
              }
              if (twoHopIds.size > 0) {
                lines.push("\n2-hop (" + twoHopIds.size + "):");
                const allNodes = new Map();
                for (const nodes of graphifyNodes.values()) for (const n of nodes) allNodes.set(n.id, n);
                for (const id of [...twoHopIds].slice(0, 10)) {
                  const node = allNodes.get(id);
                  if (node) lines.push("  " + node.label + " (" + (node.file_type || "?") + ")");
                }
              }
            }
          }
          return { title: "Wolf Graph: " + query, output: lines.join("\n") };
        },
      }),
    },
  };
};
