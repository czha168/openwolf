# OpenWolf for OpenCode: Getting Started Guide

OpenWolf gives your AI coding agent a **second brain** — a file index so it reads less, a learning memory so it avoids past mistakes, a knowledge graph for architecture awareness, and a token ledger so you see where tokens go. All invisible. Zero workflow changes.

This guide covers setup, configuration, graphify integration, and daily usage with [OpenCode](https://opencode.ai).

---

## Table of Contents

1. [What You Get](#1-what-you-get)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [First Run](#4-first-run)
5. [How It Works (Invisible)](#5-how-it-works-invisible)
6. [The `.wolf/` Directory](#6-the-wolf-directory)
7. [Custom Tools](#7-custom-tools)
8. [Graphify Knowledge Graph](#8-graphify-knowledge-graph)
9. [AGENTS.md Integration](#9-agentsmd-integration)
10. [Configuration Reference](#10-configuration-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What You Get

| Feature | What it does |
|---------|-------------|
| **Anatomy Index** | Before the agent reads a file, it sees what the file contains and how large it is. Skips unnecessary reads. |
| **Read Tracking** | Warns the agent when it re-reads a file it already opened this session. Prevents wasted tokens. |
| **Cerebrum Guard** | Before every write, scans a Do-Not-Repeat list. Warns if the agent is about to repeat a known mistake. |
| **Bug Memory** | Auto-detects bug-fix patterns in edits. Logs them so the same bug is never re-discovered. |
| **Token Ledger** | Estimates token usage per session. Tracks lifetime totals so you see real savings. |
| **Knowledge Graph** | Builds a symbol-level graph of your codebase. Shows the agent architectural context before it acts. |
| **God Nodes** | Injects the 10 most-connected symbols into the system prompt so the agent knows what matters. |

---

## 2. Prerequisites

- **Node.js 20+** — [download](https://nodejs.org)
- **OpenCode** — install with `npm install -g @opencode-ai/cli`
- **Graphify** (optional but recommended) — powers the knowledge graph features:

```bash
npm install -g graphify
```

Verify:

```bash
opencode --version
graphify --version    # should print something like "graphify 0.8.x"
```

---

## 3. Install

### Step 1: Copy the Plugin

Place `openwolf-plugin.js` in your project:

```
your-project/
├── .opencode/
│   └── plugins/
│       └── openwolf-plugin.js      ← the plugin file
```

### Step 2: Install SDK Dependency

The plugin imports from `@opencode-ai/plugin`. Set up a local node_modules:

```bash
cd your-project/.opencode
npm init -y
npm install @opencode-ai/plugin
```

Or symlink from an existing OpenCode installation if you already have it.

### Step 3: Register in Config

Create `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ".opencode/plugins/openwolf-plugin.js"
  ]
}
```

### Step 4: Build the Knowledge Graph (Optional)

```bash
cd your-project
graphify .
```

This creates `graphify-out/` with a symbol-level graph of your codebase. Takes 10–60 seconds depending on project size. The plugin loads this data automatically on session start.

### Step 5: Add AGENTS.md Instructions

Create or edit `AGENTS.md` in your project root (see [Section 9](#9-agentsmd-integration)).

---

## 4. First Run

Start OpenCode normally:

```bash
cd your-project
opencode
```

That's it. OpenWolf is active. Try:

```
> What files are in this project?
```

The agent now has access to `wolf_status`, `wolf_search`, and `wolf_graph` tools, plus invisible enrichment on every read and write.

### Verify It's Working

Ask the agent to use the status tool:

```
> Use wolf_status to show OpenWolf session info
```

You should see something like:

```
🐺 OpenWolf Status
==================
Session: session-2026-06-13-1400
Started: 2026-06-13T21:00:00.000Z

Anatomy: 47 files indexed
  Hits: 3, Misses: 1

Files read: 5
Repeated-read warnings: 0
Estimated read tokens: ~2840

Files written: 2
Cerebrum warnings: 0

Graphify: 312 symbols, 891 relationships
```

---

## 5. How It Works (Invisible)

OpenWolf runs 7 hooks that fire automatically on every agent action. You never call them directly.

```
Session starts
    ↓
    OpenWolf loads anatomy cache + graphify data
    Creates .wolf/_session.json
    Checks cerebrum.md freshness, buglog emptiness
    Increments token ledger
    ↓
Agent reads a file
    ↓
    BEFORE: Shows anatomy description + graphify neighbors
            Warns if already read this session
    AFTER:  Estimates tokens, injects enrichment into output
    ↓
Agent writes/edits a file
    ↓
    BEFORE: Checks cerebrum Do-Not-Repeat patterns
            Searches buglog for matching past bugs
    AFTER:  Updates anatomy.md with new file info
            Appends to memory.md action log
            Auto-detects bug-fix patterns → logs to buglog.json
            Schedules graphify update (5s debounce)
    ↓
Session ends / goes idle
    ↓
    Writes session totals to token-ledger.json
```

### System Prompt Injection

On every turn, OpenWolf injects context into the system prompt:

```
[OpenWolf] Project intelligence active. 47 files indexed. 5 files read this session. Use wolf_status, wolf_search, wolf_graph tools.

[Graphify] 312 symbols, 891 relationships.
Key nodes:
  - createServer (deg 18, community 3) [server.ts]
  - authenticate (deg 14, community 5) [auth.ts]
  - parseConfig (deg 12, community 2) [config.ts]
  ...
Use wolf_graph tool for queries.
```

The **god nodes** (top 10 by relationship count) give the agent architectural awareness before it even reads a single file.

---

## 6. The `.wolf/` Directory

OpenWolf creates a `.wolf/` directory in your project root. All intelligence is stored here.

| File | Purpose | Written When |
|------|---------|-------------|
| `_session.json` | Current session state: files read, files written, edit counts | Session start + every read/write |
| `anatomy.md` | File index with descriptions and token estimates | Updated after every write |
| `cerebrum.md` | Learned preferences, Do-Not-Repeat list, key learnings | You maintain this manually (or the agent does) |
| `memory.md` | Chronological action log (markdown table) | Appended after every write |
| `buglog.json` | Bug fix memory — auto-detected and searchable | Updated when bug patterns detected |
| `token-ledger.json` | Lifetime totals: sessions, tokens, savings | Updated at session start and end |

### Example: anatomy.md

```markdown
## src/

- `index.ts` — Main entry point. Exports createProgram(). (~180 tok)
- `server.ts` — Express HTTP server with middleware chain. (~520 tok)

## src/api/

- `auth.ts` — JWT validation middleware. Reads env.JWT_SECRET. (~340 tok)
```

### Example: cerebrum.md

```markdown
## Do--Not-Repeat

- Never use `var` — always `const` or `let`
- The auth middleware reads from `cfg.talk`, not `cfg.tts`
- Don't mock the database in integration tests

## User Preferences

- Prefers functional components over class components
- Always use named exports
```

### Example: buglog.json

```json
{
  "version": 1,
  "bugs": [
    {
      "id": "bug-001",
      "error_message": "TypeError: Cannot read properties of undefined",
      "file": "src/components/UserList.tsx",
      "root_cause": "API response was null when array expected",
      "fix": "Added optional chaining: data?.users?.map()",
      "tags": ["auto-detected", "null-check", "tsx"],
      "occurrences": 2
    }
  ]
}
```

---

## 7. Custom Tools

OpenWolf adds three tools the agent can call on demand.

### `wolf_status`

Shows a live snapshot of the current session.

```
> Use wolf_status to check our session
```

Output includes: session ID, anatomy hit/miss counts, files read, repeated-read warnings, estimated tokens, files written, cerebrum warnings, and graphify symbol/relationship counts.

### `wolf_search`

Searches all OpenWolf intelligence stores.

```
> Use wolf_search to find anything about "authentication"
```

Arguments:

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `query` | string | (required) | Search term |
| `scope` | enum | `"all"` | One of: `anatomy`, `cerebrum`, `memory`, `buglog`, `all` |

Searches:
- **anatomy** — file descriptions and token estimates
- **cerebrum** — Do-Not-Repeat entries and preferences
- **memory** — chronological action log
- **buglog** — past bug fixes with root causes

### `wolf_graph`

Queries the graphify knowledge graph for symbols and relationships.

```
> Use wolf_graph to find createServer and its relationships
```

Arguments:

| Arg | Type | Default | Description |
|-----|------|---------|-------------|
| `query` | string | (required) | Symbol name or concept |
| `depth` | number | `1` | Relationship depth: `1` = direct neighbors, `2` = include 2-hop |

Output shows:
- **Exact matches** — symbol name, file type, source file, community
- **Related (depth 1)** — directly connected symbols
- **2-hop (depth 2)** — symbols connected through intermediaries

If no exact match, returns **partial matches** (symbols containing the query string).

---

## 8. Graphify Knowledge Graph

Graphify builds a structural graph of your codebase. OpenWolf uses it to give the agent architectural awareness without reading files.

### How It Works

```
graphify .
    ↓
    Parses all source files (AST-based, no AI)
    Extracts symbols (functions, classes, types, variables)
    Builds relationship edges (calls, imports, references)
    Clusters symbols into communities
    Outputs graphify-out/graph.json + graph.html + GRAPH_REPORT.md
```

### Installation

```bash
npm install -g graphify
```

Or build from source: [github.com/safishamsi/graphify](https://github.com/safishamsi/graphify)

### Initial Build

```bash
cd your-project
graphify .
```

This creates `graphify-out/`:

```
graphify-out/
├── graph.json          ← machine-readable graph (loaded by OpenWolf)
├── graph.html          ← interactive visualization (open in browser)
├── GRAPH_REPORT.md     ← human-readable summary (god nodes, communities)
├── manifest.json       ← build metadata (hash, timestamp)
└── cost.json           ← build cost info
```

### Incremental Updates

```bash
graphify update .
```

Only re-parses changed files. Much faster than a full rebuild. Takes 1–5 seconds for typical projects.

### Automatic Updates

OpenWolf **automatically runs `graphify update .`** after every file write, with a 5-second debounce. You never need to update manually. The graph stays current as the agent works.

### What the Graph Contains

Each node (symbol) has:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier |
| `label` | Symbol name (e.g., `createServer`) |
| `file_type` | Type (function, class, type, variable, etc.) |
| `source_file` | Path to the source file |
| `community` | Cluster ID (symbols that work together) |

Each link (relationship) has:

| Field | Description |
|-------|-------------|
| `source` | Node ID that references |
| `target` | Node ID being referenced |
| `type` | Relationship type (call, import, reference) |

### God Nodes

At session start, OpenWolf computes **god nodes** — the 10 symbols with the most relationships (highest degree centrality). These are the architectural pillars of your codebase.

The agent sees them in its system prompt:

```
Key nodes:
  - createServer (deg 18, community 3) [server.ts]
  - authenticate (deg 14, community 5) [auth.ts]
  - parseConfig (deg 12, community 2) [config.ts]
```

This tells the agent what matters most before it reads a single file.

### Reading the Graph Report

```bash
cat graphify-out/GRAPH_REPORT.md
```

Or open the interactive visualization:

```bash
open graphify-out/graph.html
```

### Communities

Graphify clusters symbols into communities — groups of symbols that are densely connected to each other but sparsely connected to the rest. Communities typically correspond to modules, subsystems, or layers.

When the agent queries `wolf_graph`, each result shows its community ID, helping the agent understand which symbols belong together.

---

## 9. AGENTS.md Integration

OpenCode reads `AGENTS.md` at the start of every session. Add graphify instructions so the agent uses the graph proactively.

### Recommended AGENTS.md

```markdown
## OpenWolf + Graphify

This project uses OpenWolf with a graphify knowledge graph at `graphify-out/`.

Rules:
- For codebase questions, use the `wolf_graph` tool to find symbols and relationships.
- Use `wolf_search` to search project intelligence (anatomy, cerebrum, buglog).
- Use `wolf_status` to check session token usage.
- After modifying code, OpenWolf auto-runs `graphify update .` — no manual action needed.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture questions.
```

### Keeping AGENTS.md Focused

Put the most important rules at the top. OpenCode reads the full file but earlier content has more weight. Keep it under 500 lines.

---

## 10. Configuration Reference

### `.opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ".opencode/plugins/openwolf-plugin.js"
  ]
}
```

That's the minimum. OpenWolf has no required configuration — it works out of the box.

### Plugin with Options

If the plugin accepts options in the future, the format is:

```json
{
  "plugin": [
    [".opencode/plugins/openwolf-plugin.js", { "verbose": true }]
  ]
}
```

### Directory Structure After Setup

```
your-project/
├── .opencode/
│   ├── opencode.json              ← plugin registration
│   ├── plugins/
│   │   └── openwolf-plugin.js     ← the OpenWolf plugin
│   ├── node_modules/              ← SDK dependencies
│   │   └── @opencode-ai/
│   │       └── plugin/
│   └── package.json               ← npm manifest for deps
├── .wolf/                         ← OpenWolf intelligence (auto-created)
│   ├── _session.json
│   ├── anatomy.md
│   ├── cerebrum.md
│   ├── memory.md
│   ├── buglog.json
│   └── token-ledger.json
├── graphify-out/                  ← Knowledge graph (auto-updated)
│   ├── graph.json
│   ├── graph.html
│   ├── GRAPH_REPORT.md
│   └── manifest.json
├── AGENTS.md                      ← Project instructions for the agent
└── src/                           ← Your actual code
```

### .gitignore

Add these to avoid committing intelligence state:

```gitignore
# OpenWolf runtime state
.wolf/_session.json
.wolf/*.tmp

# OpenCode build artifacts
.opencode/node_modules/
.opencode/package.json
.opencode/package-lock.json

# Graphify (regenerate with `graphify .`)
graphify-out/
```

You **should** commit `.wolf/anatomy.md`, `.wolf/cerebrum.md`, `.wolf/buglog.json`, and `.wolf/token-ledger.json` — these represent accumulated project intelligence that's valuable across team members.

---

## 11. Troubleshooting

### Plugin Not Loading

```bash
# Verify the file exists
ls -la .opencode/plugins/openwolf-plugin.js

# Check syntax
node --check .opencode/plugins/openwolf-plugin.js

# Verify the SDK is installed
ls .opencode/node_modules/@opencode-ai/plugin/dist/index.js

# Check config is valid JSON
node -e "JSON.parse(require('fs').readFileSync('.opencode/opencode.json','utf8')); console.log('OK')"
```

### Graphify Not Working

```bash
# Check graphify is installed
graphify --version

# Check graph output exists
ls graphify-out/graph.json

# Rebuild from scratch
rm -rf graphify-out/
graphify .
```

### Tools Not Appearing

Verify the plugin exports correctly:

```bash
node -e "
  import('./.opencode/plugins/openwolf-plugin.js')
    .then(m => m.OpenWolfPlugin({ directory: '.', worktree: undefined }))
    .then(h => {
      console.log('Hooks:', Object.keys(h));
      console.log('Tools:', Object.keys(h.tool));
    })
    .catch(e => console.error('FAIL:', e.message));
"
```

Expected output:

```
Hooks: dispose,event,tool.execute.before,tool.execute.after,experimental.chat.system.transform,experimental.session.compacting,tool
Tools: wolf_status,wolf_search,wolf_graph
```

### Token Estimates Seem Wrong

OpenWolf estimates tokens using a character-to-token ratio (3.5 for code, 4.0 for prose). Estimates are accurate to within ~15%. This is not exact API token counts — it's an estimation for tracking trends.

### Cerebrum Warnings Not Firing

The cerebrum check scans `.wolf/cerebrum.md` for a `## Do-Not-Repeat` section. If the section is missing or has fewer than 3 entries, OpenWolf prints a freshness reminder at session start.

To fix: add entries to `cerebrum.md`:

```markdown
## Do-Not-Repeat

- Never use `var` — always `const` or `let`
- Don't suppress errors with `as any`
- The config module reads from `cfg.talk`, not `cfg.tts`
```

### Bug Detection Not Logging

Bug detection uses pattern matching on edit diffs. It detects common patterns: null checks added, error handling added, type casts fixed, imports reordered, async/await added. It won't catch every bug — it catches structural fix patterns.

To see logged bugs:

```
> Use wolf_search with scope "buglog" to show all bugs
```

---

## Quick Reference

| What | Command / Location |
|------|-------------------|
| Install graphify | `npm install -g graphify` |
| Build knowledge graph | `graphify .` |
| Update knowledge graph | `graphify update .` (or let OpenWolf do it automatically) |
| View graph visualization | `open graphify-out/graph.html` |
| Read graph report | `cat graphify-out/GRAPH_REPORT.md` |
| Check session status | Ask agent: `wolf_status` |
| Search intelligence | Ask agent: `wolf_search "query"` |
| Query graph | Ask agent: `wolf_graph "symbolName"` |
| Plugin file | `.opencode/plugins/openwolf-plugin.js` |
| Plugin config | `.opencode/opencode.json` |
| Project instructions | `AGENTS.md` |
| Intelligence data | `.wolf/` |
| Graph data | `graphify-out/` |

---

That's it. OpenWolf runs silently in the background. Just use OpenCode as normal — the intelligence compounds with every session.
