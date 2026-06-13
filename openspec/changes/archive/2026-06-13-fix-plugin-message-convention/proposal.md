## Why

The OpenWolf OpenCode plugin emits messages through two channels that the OpenCode TUI renders poorly: (1) raw `process.stderr.write()` calls prefixed with emoji (`⚡`, `📋`, `🕸️`, `⚠️`, `💡`), and (2) prepended `[OpenWolf] ...` metadata blocks injected into Read tool output via `output.output` mutation. Both produce unstructured visual noise in the TUI — stderr lines appear as floating, context-free strings outside any tool result panel, and the prepended metadata pollutes the file content the agent is trying to read. This makes tool output hard to scan and breaks the agent's read flow, since every file read now begins with a `[OpenWolf] 🕸️ Related: ...` line that is not part of the file.

## What Changes

- Remove all emoji-prefixed `process.stderr.write()` diagnostic calls from the plugin (anatomy lookup, repeated-read warning, graphify enrichment, cerebrum warning, buglog FYI, session nags)
- Stop prepending the `[OpenWolf] <metadata>` line to Read tool output (`output.output`) — file content must reach the agent unmodified
- Move diagnostic/warning information that the agent genuinely needs into the Read tool output as a clearly-delimited, trailing summary block (not a leading prefix), only when the information is actionable
- Move session-lifecycle nags (cerebrum freshness, buglog emptiness, missing buglog updates) into the `wolf_status` tool output or the compaction context, not stderr
- Keep the system prompt injection (`experimental.chat.system.transform`) and compaction context (`experimental.session.compacting`) but strip emoji and verbose formatting
- Preserve all data-collection and state-tracking behavior — only the **display surface** changes

## Capabilities

### New Capabilities

<!-- No new capabilities; this modifies existing plugin behavior -->

### Modified Capabilities

- `opencode-plugin-core`: Message display behavior changes — all plugin-to-TUI communication moves from raw `process.stderr.write` + leading `output.output` prefix to either (a) silent state tracking, (b) trailing delimited summary in tool output, or (c) system prompt / compaction context. No behavioral data collection changes.

## Impact

- **Modified file**: `.opencode/plugins/openwolf-plugin.js` — ~15 `process.stderr.write()` call sites and 2 `output.output` prepend sites
- **No new dependencies**: Uses existing OpenCode plugin API only
- **No data loss**: All intelligence (anatomy, cerebrum, buglog, graphify, token tracking) continues to be collected and stored in `.wolf/`; only the inline TUI display changes
- **Agent experience**: Read tool output returns clean file content; warnings surface through structured channels (`wolf_status`, system prompt) instead of stderr noise
- **User experience**: TUI no longer shows floating emoji lines between tool calls; file reads are no longer prefixed with metadata blocks
