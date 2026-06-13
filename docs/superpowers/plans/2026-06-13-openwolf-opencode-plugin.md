# OpenWolf OpenCode Plugin — Implementation Plan

**Change**: openwolf-opencode-plugin  
**Date**: 2026-06-13  
**Source Specs**: `openspec/changes/openwolf-opencode-plugin/`  
**Target**: `.opencode/plugins/openwolf-plugin.js`  
**Existing hook source**: `src/hooks/*.ts`  
**Graphify repo**: https://github.com/safishamsi/graphify

---

## Architecture

Single-file OpenCode plugin at `.opencode/plugins/openwolf-plugin.js` with named export `OpenWolfPlugin`.
In-memory state (Maps) for session-scoped data. Filesystem persistence for anatomy.md, memory.md, buglog.json, token-ledger.json.
Graphify integration via graphify-out/graph.json loaded at init into lookup indexes.

### Hook Mapping (Claude Code → OpenCode)

| Claude Code Hook | OpenCode Hook | Handler |
|---|---|---|
| session.start | `event(session.created)` | initSession |
| pre-read | `tool.execute.before` (filter Read) | preRead |
| post-read | `tool.execute.after` (filter Read) | postRead |
| pre-write | `tool.execute.before` (filter Write/Edit) | preWrite |
| post-write | `tool.execute.after` (filter Write/Edit) | postWrite |
| stop | `event(session.idle)` + `dispose` | stopSession |

### Custom Tools (via `Hooks.tool` dictionary)

- `wolf_status` — Session stats and wolf health
- `wolf_search` — Search anatomy/cerebrum/memory/buglog
- `wolf_graph` — Query graphify knowledge graph

### State Model

```
In-memory:
  anatomyCache: Map<sectionKey, AnatomyEntry[]>  (from anatomy.md)
  readHistory: Map<normalizedPath, { count, tokens, firstRead }>
  writeHistory: Map<normalizedPath, number>  (edit counts)
  graphifyNodes: Map<normalizedLabel, GraphNode[]>  (from graph.json)
  graphifyByFile: Map<sourceFile, GraphNode[]>  (from graph.json)
  graphifyLinks: Link[]  (from graph.json)
  sessionMeta: { id, started, anatomyHits, anatomyMisses, repeatedWarned, cerebrumWarnings }
  updateTimer: Timeout | null  (debounced graphify update)

Filesystem (.wolf/):
  anatomy.md, cerebrum.md, memory.md, buglog.json, token-ledger.json, _session.json
```

---

## Task Groups

### Group 1: Plugin Skeleton + State (Tasks 1-2)

---

#### Task 1: Create plugin file with skeleton, imports, state, and shared utilities

**Goal**: Working plugin that loads in OpenCode with no errors. All shared utilities inlined.

**Approach**: Create `.opencode/plugins/openwolf-plugin.js` with the named export pattern from graphify.js. Inline all shared utilities from `src/hooks/shared.ts`.

**Verification**: OpenCode loads the plugin without errors and `OpenWolfPlugin` export is found.

**File**: `.opencode/plugins/openwolf-plugin.js`

```javascript
// .opencode/plugins/openwolf-plugin.js
// OpenWolf Plugin for OpenCode — project intelligence, token tracking, graphify integration
// Ported from src/hooks/*.ts (Claude Code hooks) to OpenCode plugin API

import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync,
         readdirSync, unlinkSync, statSync, mkdirSync } from "fs";
import { join, dirname, basename, extname, relative, normalize, posix } from "path";
import { z } from "zod";
import { tool } from "@opencode-ai/plugin";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const WOLF_DIR = ".wolf";
const CODE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".css", ".json", ".yaml", ".yml"]);
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
// extractDescription (from shared.ts L113-563)
// ─────────────────────────────────────────────
// This is a 451-line multi-language heuristic function.
// COPY VERBATIM from src/hooks/shared.ts lines 113-563 during implementation.
// Function signature: function extractDescription(content, relPath, tokens) { ... }
// Returns a string description capped at MAX_DESCRIPTION_LENGTH chars.

// ─────────────────────────────────────────────
// Edit Summarizer (from post-write.ts L186-274)
// ─────────────────────────────────────────────
// COPY VERBATIM from src/hooks/post-write.ts lines 186-274 during implementation.
// Function signature: function summarizeEdit(oldStr, newStr) { ... }

// ─────────────────────────────────────────────
// Bug Detection (from post-write.ts L175-538)
// ─────────────────────────────────────────────
// COPY VERBATIM from src/hooks/post-write.ts lines 175-538 during implementation.
// Function signature: function detectFixPattern(oldStr, newStr, filePath) { ... }
// Returns { category, summary, rootCause, fix } | null
// 14 pattern matchers in priority order.

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
let sessionMeta = { id: "", started: "", anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0 };
let updateTimer = null;

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

// ─────────────────────────────────────────────
// Session Stop (shared by event.idle and dispose)
// ─────────────────────────────────────────────

async function stopSession() {
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
  writeJson(ledgerFile, ledger);

  // Memory summary
  if (writeCount > 0) {
    const memoryFile = wolfPath(projectDir, "memory.md");
    const timeHhMm = now.toTimeString().slice(0, 5);
    const uniqueBasenames = [...new Set(writtenFiles.map(f => basename(f)))].slice(0, 5).join(", ");
    const totalTok = inputTokens + outputTokens;
    const row = "| " + timeHhMm + " | Session end: " + writeCount + " writes across " + uniqueBasenames + " | " + readCount + " reads | ~" + totalTok + " tok |\n";
    try { appendFileSync(memoryFile, row); } catch {}
  }

  // Missing buglog nag
  const multiEditFiles = Object.entries(editCounts).filter(([, c]) => c >= REPEATED_EDIT_THRESHOLD).map(([f]) => f);
  if (multiEditFiles.length > 0) {
    const hasBuglogEdit = writtenFiles.some(f => f.includes("buglog.json"));
    if (!hasBuglogEdit) {
      process.stderr.write("⚠️ OpenWolf: Files edited 3+ times (" + multiEditFiles.map(basename).join(", ") + ") but buglog.json was not updated.\n");
    }
  }

  // Cerebrum freshness nag
  const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
  if (existsSync(cerebrumFile) && writeCount >= 3) {
    const stat = statSync(cerebrumFile);
    const hoursSince = (Date.now() - stat.mtimeMs) / 3600000;
    if (hoursSince > 24) {
      process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in " + Math.floor(hoursSince) + "h. Did you learn any preferences this session?\n");
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
      const { execSync } = require("child_process");
      execSync("graphify update .", { cwd: projectDir, stdio: "pipe", timeout: 30000 });
      const after = readJson(manifestPath);
      const afterHash = after?.ast_hash || "";
      if (afterHash && afterHash !== beforeHash) {
        process.stderr.write("🕸️ Graphify: knowledge graph updated.\n");
        loadGraphifyData(projectDir);
      }
    } catch {}
    updateTimer = null;
  }, 5000);
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
        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
        sessionMeta = {
          id: "session-" + dateStr + "-" + timeStr,
          started: now.toISOString(),
          anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
        };
        ensureWolfDir(projectDir);
        writeJson(wolfPath(projectDir, "_session.json"), {
          session_id: sessionMeta.id, started: sessionMeta.started,
          files_read: {}, files_written: [], edit_counts: {},
          anatomy_hits: 0, anatomy_misses: 0,
          repeated_reads_warned: 0, cerebrum_warnings: 0, stop_count: 0,
        });

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

        // Cerebrum freshness check
        const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
        if (existsSync(cerebrumFile)) {
          const content = readFileSync(cerebrumFile, "utf8");
          const entryLines = content.split("\n").filter(l => /^[-*]\s|\[.*\]/.test(l.trim()));
          if (entryLines.length < 3) {
            process.stderr.write("💡 OpenWolf: cerebrum.md has only " + entryLines.length + " entries. Learn from this session.\n");
          } else {
            const stat = statSync(cerebrumFile);
            const daysSince = (Date.now() - stat.mtimeMs) / 86400000;
            if (daysSince > 3) process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in " + Math.floor(daysSince) + " days.\n");
          }
        }

        // Buglog emptiness check
        const buglog = readJson(wolfPath(projectDir, "buglog.json"));
        if (buglog && buglog.bugs && buglog.bugs.length === 0) {
          process.stderr.write("📋 OpenWolf: buglog.json is empty. Bugs will be auto-logged when detected.\n");
        }

        // Increment ledger
        const ledgerFile = wolfPath(projectDir, "token-ledger.json");
        const ledger = readJson(ledgerFile) || { sessions: [], lifetime: { total_tokens_estimated: 0, total_reads: 0, total_writes: 0, total_sessions: 0, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_blocked: 0, estimated_savings_vs_bare_cli: 0 } };
        ledger.lifetime.total_sessions++;
        writeJson(ledgerFile, ledger);

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

      // --- Pre-Read: anatomy + graphify enrichment ---
      if (toolName === "Read") {
        const filePath = output.args?.filePath || output.args?.file_path || output.args?.path || "";
        if (!filePath || filePath.includes("/.wolf/") || filePath.includes("\\.wolf\\")) return;
        const normalizedFile = normalizePath(filePath);
        const fileBase = basename(filePath);

        // Repeated read warning
        if (readHistory.has(normalizedFile)) {
          const info = readHistory.get(normalizedFile);
          info.count++;
          sessionMeta.repeatedWarned++;
          process.stderr.write("⚡ OpenWolf: " + fileBase + " was already read this session (~" + info.tokens + " tokens).\n");
          return;
        }

        // Anatomy lookup
        let anatomyFound = false;
        for (const [sectionKey, entries] of anatomyCache.entries()) {
          for (const entry of entries) {
            const entryRelPath = normalizePath(sectionKey + "/" + entry.file);
            if (normalizedFile.endsWith(entryRelPath) || normalizedFile.endsWith("/" + entryRelPath)) {
              process.stderr.write("📋 OpenWolf anatomy: " + entry.file + " — " + entry.description + " (~" + entry.tokens + " tok)\n");
              anatomyFound = true;
              sessionMeta.anatomyHits++;
              break;
            }
          }
          if (anatomyFound) break;
        }
        if (!anatomyFound) sessionMeta.anatomyMisses++;

        // Graphify enrichment
        const relPath = normalizePath(relative(worktreeDir, filePath));
        const graphNodes = graphifyByFile.get(relPath) || graphifyByFile.get(normalizedFile) || [];
        if (graphNodes.length > 0) {
          const topNodes = graphNodes.slice(0, 3);
          const nodeDescs = topNodes.map(n => n.label + " (" + (n.file_type || "unknown") + ", community " + (n.community || "?") + ")").join("; ");
          process.stderr.write("🕸️ Graphify: " + graphNodes.length + " node(s) in " + fileBase + ": " + nodeDescs + "\n");
          const relatedIds = new Set();
          for (const link of graphifyLinks) {
            for (const n of topNodes) {
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
            process.stderr.write("🕸️ Related: " + related.join(", ") + "\n");
          }
        }
      }

      // --- Pre-Write/Edit: cerebrum + buglog ---
      if (toolName === "Write" || toolName === "Edit") {
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
        if (buglog && buglog.bugs && buglog.bugs.length > 0) {
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
      if (input.tool === "Read") {
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
          writeJson(sessionFile, session);
        }
      }

      // --- Post-Write/Edit: anatomy update + memory + bug detection + graphify ---
      if (input.tool === "Write" || input.tool === "Edit") {
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
          // description from extractDescription (if available) or fallback
          const description = fileContent.split("\n").find(l => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("//"))?.trim().slice(0, MAX_DESCRIPTION_LENGTH) || "";
          if (!anatomyCache.has(sectionKey)) anatomyCache.set(sectionKey, []);
          const entries = anatomyCache.get(sectionKey);
          const existingIdx = entries.findIndex(e => relPath.endsWith(normalizePath(e.file)));
          const entry = { file: basename(filePath), description, tokens };
          if (existingIdx >= 0) entries[existingIdx] = entry;
          else entries.push(entry);
          // Persist anatomy
          atomicWrite(wolfPath(projectDir, "anatomy.md"), serializeAnatomy(anatomyCache));
        }

        // Memory log
        const memoryFile = wolfPath(projectDir, "memory.md");
        const now = new Date();
        const timeHhMm = now.toTimeString().slice(0, 5);
        const action = input.tool === "Write" ? "Created" : "Edited";
        const changeDesc = typeof summarizeEdit === "function" ? summarizeEdit(oldStr, newStr) : "—";
        const writeTokens = estimateTokens(newStr || "", classifyFileType(filePath));
        const row = "| " + timeHhMm + " | " + action + " " + relPath + " | " + changeDesc + " | ~" + writeTokens + " |\n";
        try { appendFileSync(memoryFile, row); } catch {}

        // Bug detection (if detectFixPattern available)
        if (typeof detectFixPattern === "function" && oldStr && newStr) {
          const detection = detectFixPattern(oldStr, newStr, filePath);
          if (detection) {
            const buglogFile = wolfPath(projectDir, "buglog.json");
            const buglog = readJson(buglogFile) || { version: 1, bugs: [] };
            const ext = extname(filePath).replace(".", "");
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
            writeJson(buglogFile, buglog);
          }
        }

        writeJson(sessionFile, session);

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
        parts.push("[Graphify] " + graphifyNodes.size + " indexed symbols, " + graphifyLinks.length + " relationships. Use wolf_graph tool for queries.");
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
          }
          return { title: "Wolf Graph: " + query, output: lines.join("\n") };
        },
      }),
    },
  };
};
```

**IMPORTANT — Functions to copy verbatim during implementation:**

1. **`extractDescription`** from `src/hooks/shared.ts` lines 113-563 (451 lines)
   - Signature: `function extractDescription(content, relPath, tokens) { ... }`
   - Multi-language heuristic file description extractor (30+ file types)
   - Falls back to first meaningful line, capped at `MAX_DESCRIPTION_LENGTH`

2. **`summarizeEdit`** from `src/hooks/post-write.ts` lines 186-274
   - Signature: `function summarizeEdit(oldStr, newStr) { ... }`
   - Produces human-readable edit descriptions

3. **`detectFixPattern`** from `src/hooks/post-write.ts` lines 175-538
   - Signature: `function detectFixPattern(oldStr, newStr, filePath) { ... }`
   - Returns `{ category, summary, rootCause, fix } | null`
   - 14 pattern matchers in priority order (error-handling, null-safety, guard-clause, wrong-value, wrong-reference, logic-fix, operator-fix, missing-import, return-value, async-fix x2, type-fix, style-fix, refactor)

---

#### Task 2: (Already included in Task 1 — graphify loading is in the skeleton)

---

### Group 2: Config + Integration (Task 3)

---

#### Task 3: Update .opencode/opencode.json and smoke test

**Goal**: Register the plugin and verify it works end-to-end.

**Steps**:
1. Update `.opencode/opencode.json` to include `"./plugins/openwolf-plugin.js"` in the plugin array
2. Start OpenCode — verify no import errors
3. Read a file — verify anatomy description in stderr
4. Edit a file — verify cerebrum check + memory log
5. Call `wolf_status` tool — verify session stats
6. Call `wolf_graph` tool with a symbol name — verify graph nodes returned
7. End session — verify token ledger updated

**Verification**: All 7 steps produce expected output with no errors.

---

## Task Summary

| # | Task | Source | Commit |
|---|------|--------|--------|
| 1 | Plugin skeleton + all logic | shared.ts, post-write.ts, all hooks | Commit 1 |
| 2 | (Merged into Task 1) | — | — |
| 3 | Config + smoke test | opencode.json | Commit 2 |

## Commit Points

- **Commit 1**: Complete plugin file (`.opencode/plugins/openwolf-plugin.js`) with all hooks, tools, and utilities
- **Commit 2**: Config update + verification — **SHIP READY**
