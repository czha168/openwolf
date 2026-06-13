## Why

OpenWolf's "second brain" intelligence (anatomy map, cerebrum learning, memory log, buglog, token tracking) only works with Claude Code via 6 lifecycle hooks that communicate through stdin/stderr/exit-codes. OpenCode has a richer plugin API with direct arg mutation, system prompt injection, custom tool registration, and in-memory state — none of which OpenWolf leverages. Meanwhile, the graphify knowledge graph in `graphify-out/` (681 nodes, 1147 edges, 53 communities) provides architectural context that anatomy.md alone cannot deliver, but is only used via a 22-line one-shot bash reminder plugin.

## What Changes

- Create a new OpenCode plugin (`openwolf-plugin.js`) that replicates all 6 Claude Code hook behaviors using OpenCode's `Hooks` interface
- Use `tool.execute.before` to intercept Read (anatomy lookup + repeated-read warning + graphify community enrichment) and Write/Edit (cerebrum pattern check + buglog search)
- Use `tool.execute.after` to intercept Read (token estimation) and Write/Edit (anatomy update + memory log + bug auto-detection + **graphify incremental update**)
- Use `experimental.chat.system.transform` to inject graphify-derived architectural context (god nodes, community map) into the system prompt (~300 tokens)
- Use `event` hook to handle session lifecycle (session start state init, session idle ledger flush)
- Register custom tools (`wolf_status`, `wolf_search`, `wolf_graph`) for agent-driven queries
- Use in-memory session state instead of filesystem `_session.json` with periodic persistence
- Replace the existing minimal `graphify.js` plugin with the integrated OpenWolf plugin

## Capabilities

### New Capabilities
- `opencode-plugin-core`: Port of all 6 Claude Code hook behaviors (anatomy, cerebrum, memory, buglog, token tracking) to OpenCode's `Hooks` interface using `tool.execute.before/after`, `event`, and `shell.env`
- `graphify-context-injection`: Enrichment of system prompts and pre-read context using graphify knowledge graph data (god nodes, communities, neighbor edges) via `experimental.chat.system.transform` and `tool.execute.before`
- `graphify-auto-update`: Automatic incremental graph update (`graphify update .`) after code writes via `tool.execute.after`, with SHA-256 change detection and debouncing
- `wolf-custom-tools`: Registration of `wolf_status`, `wolf_search`, and `wolf_graph` custom tools for agent-driven queries against `.wolf/` state and graphify graph

### Modified Capabilities
<!-- No existing specs to modify — this is new functionality -->

## Impact

- **New file**: `.opencode/plugins/openwolf-plugin.js` — the main plugin module (replaces existing `graphify.js`)
- **Modified file**: `.opencode/opencode.json` — update plugin reference from `graphify.js` to `openwolf-plugin.js`
- **New dependency**: `@opencode-ai/plugin` already installed in `.opencode/` (v1.17.4)
- **Shared code**: Reuses logic from `src/hooks/shared.ts` (anatomy parsing, description extraction, token estimation) — either import from compiled dist or inline the required functions
- **Runtime**: OpenCode plugin runs as a long-lived JS module (unlike Claude Code hooks which are per-invocation processes), enabling in-memory state caching
- **graphify CLI**: Requires graphify CLI at `$PATH` for `update`, `query`, `explain`, `path`, `affected` commands
- **Token budget**: ~300 tokens for system prompt injection (graphify context), ~50-100 tokens per pre-read enrichment
