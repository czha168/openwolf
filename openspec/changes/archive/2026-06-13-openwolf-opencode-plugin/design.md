## Context

OpenWolf is a "second brain" system for AI coding agents. It currently runs as 6 Claude Code hooks (`session-start`, `pre-read`, `post-read`, `pre-write`, `post-write`, `stop`) that communicate via stdin/stdout/exit-codes. Each hook invocation spawns a new Node.js process, parses JSON from stdin, and emits JSON to stdout.

OpenCode provides a plugin API (`@opencode-ai/plugin` v1.17.4) with a fundamentally different model: a single long-lived JavaScript module that registers hook handlers via `Hooks` interface. Hooks receive typed context objects and can mutate arguments in-place, inject system prompt content, register custom tools, and maintain in-memory state across the session.

The existing `.opencode/plugins/graphify.js` is 22 lines and only injects a bash reminder to run graphify commands. The graphify knowledge graph (`graphify-out/graph.json`, 681 nodes, 1147 edges, 53 communities) is underutilized.

Key source files:
- `src/hooks/shared.ts` (592 lines): anatomy parsing, description extraction, token estimation, JSON I/O
- `src/hooks/post-write.ts` (500+ lines): most complex hook — anatomy update, memory log, bug detection
- `src/hooks/pre-read.ts`: anatomy lookup, repeated-read warning
- `src/hooks/pre-write.ts`: cerebrum Do-Not-Repeat check
- `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`: full SDK types

## Goals / Non-Goals

**Goals:**
- Replicate all 6 Claude Code hook behaviors in a single OpenCode plugin
- Enrich agent context with graphify knowledge graph data (system prompt + pre-read + post-write)
- Auto-update graphify graph after code changes (zero LLM cost)
- Provide custom tools for agent-driven queries (`wolf_status`, `wolf_search`, `wolf_graph`)
- Replace the minimal `graphify.js` plugin with the integrated solution

**Non-Goals:**
- Rewriting OpenWolf core logic — reuse existing `shared.ts` patterns
- Making this work with Claude Code (that already works via existing hooks)
- Building a UI or dashboard for the knowledge graph
- Modifying graphify CLI itself
- Supporting multiple OpenCode versions (pin to v1.17.4+ API)

## Decisions

### D1: Single plugin file vs modular plugin package

**Decision**: Single file `.opencode/plugins/openwolf-plugin.js` with internal module separation. Uses named export `export const OpenWolfPlugin = async (input: PluginInput) => { ... }` matching OpenCode's `Plugin` type.

**Rationale**: OpenCode loads plugins from `.opencode/plugins/*.js` using the `Plugin` type: `(input: PluginInput, options?: PluginOptions) => Promise<Hooks>`. The `PluginInput` provides `client`, `project`, `directory`, `worktree`, `serverUrl`, `experimental_workspace`, and `$` (BunShell). A named export (like the existing `graphify.js` uses `GraphifyPlugin`) avoids ambiguity. Internal concerns separated by clear comment sections. The file will be ~400-600 lines, which is manageable.

**Alternative considered**: Multi-file plugin with `import` from relative modules. Rejected because OpenCode's plugin loader may not support ESM imports from arbitrary paths reliably.

### D2: In-memory state vs filesystem state

**Decision**: In-memory `Map` objects for session state (anatomy cache, read history, token ledger, cerebrum patterns) with lazy persistence to `.wolf/_session.json` on session idle and plugin dispose.

**Rationale**: OpenCode plugins are long-lived — the module persists for the entire session. In-memory state eliminates filesystem I/O on every hook invocation (currently each Claude Code hook reads `_session.json` on every call). Persistence on idle/dispose prevents data loss.

**Alternative considered**: Keep filesystem-based state for crash recovery. Rejected because the overhead is unnecessary for session-scoped data that resets every session anyway.

### D3: Hook mapping strategy

**Decision**: Map Claude Code hooks to OpenCode hooks as follows:

| Claude Code Hook | OpenCode Hook | Notes |
|---|---|---|
| `session-start` | `event` (on `session.created`) | Initialize in-memory state |
| `pre-read` | `tool.execute.before` (filter: Read) | Anatomy lookup + graphify enrichment |
| `post-read` | `tool.execute.after` (filter: Read) | Token estimation |
| `pre-write` | `tool.execute.before` (filter: Write, Edit) | Cerebrum check + buglog lookup |
| `post-write` | `tool.execute.after` (filter: Write, Edit) | Anatomy update + memory + bug detection + graphify update |
| `stop` | `event` (on `session.idle`) + `dispose` | Summary + ledger flush |

**Rationale**: OpenCode's `tool.execute.before/after` provide direct access to tool arguments and results, enabling richer interception than Claude Code's stdin/stdout model. The `event` hook covers session lifecycle. `dispose` handles cleanup.

**Alternative considered**: Using `experimental.chat.messages.transform` for all interception. Rejected because it operates at the chat message level, not the tool level — we'd have to parse tool calls out of messages.

### D4: Graphify integration architecture

**Decision**: 3-layer integration:

1. **System prompt injection** (`experimental.chat.system.transform`): Load `graphify-out/GRAPH_REPORT.md` once, extract god nodes + community map, inject ~300 tokens of architectural context into every system prompt.

2. **Pre-read enrichment** (`tool.execute.before` for Read): When the agent reads a file, look up that file's node in `graphify-out/graph.json` by matching `source_file` or `norm_label` against the file path, find its community and top-connected neighbors from the `links` array, and prepend a comment block with related files and architectural role (~50-100 tokens).

3. **Post-write auto-update** (`tool.execute.after` for Write/Edit): After any code write, run `graphify update .` (AST-only, no API cost). Debounce by 5 seconds to batch rapid writes. Skip if `graphify-out/manifest.json` `ast_hash` values haven't changed.

**Rationale**: Each layer adds value at a different granularity. System prompt gives broad architectural awareness. Pre-read gives file-specific context. Post-write keeps the graph current. The debouncing and hash-check prevent unnecessary work.

**Alternative considered**: Only system prompt injection. Rejected because it doesn't provide file-specific context or keep the graph current.

### D5: Custom tools vs hook-only

**Decision**: Register 3 custom tools (`wolf_status`, `wolf_search`, `wolf_graph`) via the `tool` property in the `Hooks` return object, using the `tool()` factory from `@opencode-ai/plugin` to create `ToolDefinition` values.

**Rationale**: Hooks are passive (intercept tool calls). Custom tools let the agent actively query wolf state and graphify data when needed. The `Hooks` interface defines `tool` as `{ [key: string]: ToolDefinition }` — a dictionary mapping tool names to definitions. The `tool()` factory (from `@opencode-ai/plugin`) creates those definitions with zod schemas and execute functions. Example:
```javascript
import { tool } from "@opencode-ai/plugin";
// In Hooks return:
tool: {
  wolf_status: tool({ description: "...", args: {}, execute: async (args, ctx) => "..." }),
  wolf_graph: tool({ description: "...", args: { action: z.string() }, execute: ... }),
}
```

**Alternative considered**: Hook-only, enrich passively. Rejected because the agent sometimes needs on-demand graph queries that hooks can't provide.

### D6: Reusing shared.ts logic

**Decision**: Inline the required functions from `shared.ts` (anatomy parsing, description extraction, token estimation) into the plugin. Do not import from `src/hooks/shared.ts`.

**Rationale**: The plugin runs in OpenCode's JavaScript runtime, not in the TypeScript/Node.js build pipeline for Claude Code hooks. Inlining avoids build dependency issues and keeps the plugin self-contained. The functions are small (<50 lines each) and well-understood.

**Alternative considered**: Import from compiled `dist/`. Rejected because OpenCode plugins run in a different module context and may not resolve paths correctly.

## Risks / Trade-offs

- **Risk**: OpenCode plugin API is marked `experimental` for some hooks (`chat.system.transform`, `chat.messages.transform`) → **Mitigation**: Pin to v1.17.4 API, add version check at plugin load, graceful degradation if experimental hooks unavailable
- **Risk**: `graphify update .` may be slow on large codebases → **Mitigation**: Debounce by 5 seconds, skip if SHA-256 hashes unchanged, run async (don't block tool execution)
- **Risk**: Single file grows too large → **Mitigation**: Clear section headers, each concern <150 lines. If it exceeds 800 lines, reconsider modular approach
- **Risk**: In-memory state lost on crash → **Mitigation**: Acceptable for session-scoped data. Critical state (anatomy.md, memory.md, buglog.json) is persisted to filesystem by post-write hooks as before
- **Trade-off**: System prompt injection adds ~300 tokens to every request → Worth it for architectural awareness; agent can make better decisions with community context
- **Trade-off**: Pre-read enrichment adds latency to every Read call → Minimal (JSON lookup + string formatting, <5ms). Graph data loaded once into memory at session start

### D7: Session compaction state preservation

**Decision**: Register an `experimental.session.compacting` hook that injects wolf session context (files read, token stats, cerebrum patterns matched) into the compaction prompt so the agent retains wolf awareness after compaction.

**Rationale**: OpenCode compacts long sessions by summarizing context. Without intervention, wolf's in-memory state context would be lost post-compaction — the agent would forget which files it already read and what patterns it matched. The `experimental.session.compacting` hook allows appending context strings to the compaction prompt. We inject a wolf session summary (~100 tokens) to preserve continuity.

**Alternative considered**: Accept state loss on compaction. Rejected because repeated-read warnings and token tracking would reset mid-session, defeating wolf's purpose.

## Open Questions

- Should `wolf_graph` tool support write operations (e.g., adding manual edges to the graph)? Current design is read-only.
- Should the plugin support configuration via `opencode.json` (e.g., toggle graphify integration, set token budget)? Currently hardcoded.
- Is there an OpenCode event for "session resume" (context restore)? If so, should we reload graph data?
