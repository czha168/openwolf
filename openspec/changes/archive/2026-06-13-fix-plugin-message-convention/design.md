## Context

The OpenWolf OpenCode plugin (`.opencode/plugins/openwolf-plugin.js`, 1655 lines) currently emits messages through **six distinct mechanisms**, only some of which are sanctioned OpenCode plugin API channels:

1. **`process.stderr.write()` — 16 calls**: Raw stderr writes with emoji prefixes (`⚠️`, `💡`, `📋`, `⚡`, `🕸️`). These bypass the plugin API entirely and land as floating, context-free strings in the TUI.
2. **`output.output` prepend — 1 call (line 1382)**: Injects `[OpenWolf] 📋 ... | 🕸️ Related: ...` as a **leading prefix** before file content in Read tool results, polluting the file the agent is trying to read.
3. **System prompt injection** (`experimental.chat.system.transform`): `[OpenWolf] ...` and `[Graphify] ...` blocks — currently working but verbose.
4. **Session compaction** (`experimental.session.compacting`): `[OpenWolf] ...` stats block — working but emoji-laden.
5. **Tool returns** (`wolf_status`, `wolf_search`, `wolf_graph`): `{ title, output }` — properly structured, but `wolf_status` uses `🐺` emoji + ASCII underline.
6. **Bash echo prepend** (graphify.js): `[graphify]` (lowercase) echo injected before bash commands — inconsistent with `[Graphify]` used elsewhere.

The OpenCode TUI renders stderr writes and output-prefix mutations poorly, creating visual noise between tool results and making file reads begin with non-file metadata. The plugin's data collection (anatomy, cerebrum, buglog, graphify, token tracking) is correct and complete — only the **display surface** is broken.

## Goals / Non-Goals

**Goals:**
- Eliminate all raw `process.stderr.write()` calls from the plugin — zero stderr noise in the TUI
- Stop polluting Read tool output with leading `[OpenWolf]` metadata prefixes — file content reaches the agent unmodified at the start
- Route actionable warnings (repeated read, cerebrum pattern match, buglog match) through a structured, trailing delimited block in the relevant tool output so the agent still sees them at decision time
- Standardize branding: single `[OpenWolf]` prefix convention, no emoji, consistent casing
- Fix `[graphify]` vs `[Graphify]` casing inconsistency in graphify.js
- Preserve all data collection and `.wolf/` state — nothing stops being tracked

**Non-Goals:**
- Redesigning the plugin's intelligence features (anatomy, cerebrum, buglog, graphify logic stays as-is)
- Adding new OpenCode plugin API channels that don't already exist in the codebase
- Changing the system prompt injection or compaction context mechanisms (only their formatting changes)
- Removing the `wolf_status` / `wolf_search` / `wolf_graph` custom tools
- Touching the Claude Code hooks in `src/hooks/` (those use stdin/stderr/exit-codes by design — this change is OpenCode-plugin-only)

## Decisions

### Decision 1: Remove all 16 `process.stderr.write()` calls

**Choice**: Delete every `process.stderr.write()` call in `openwolf-plugin.js`.

**Rationale**: stderr is not a sanctioned OpenCode plugin message channel. The TUI renders these as floating strings with no tool-result context. The information they carry falls into two categories:
- **Session-lifecycle nags** (cerebrum freshness, buglog emptiness, missing buglog updates, graphify updated) — these are FYI, not actionable at read/write time. They belong in `wolf_status` output and compaction context, where the agent (or user) can check them on demand.
- **Tool-time warnings** (repeated read, anatomy hit, graphify enrichment, cerebrum match, buglog match) — these ARE actionable and must reach the agent. They move to Decision 2.

**Alternatives considered**:
- *Keep stderr but strip emoji*: Still produces floating strings in the TUI. Doesn't fix the core rendering issue.
- *Use `console.warn()`/`console.error()`*: Same stderr channel, same problem.

### Decision 2: Actionable warnings move to trailing delimited block in tool output

**Choice**: For warnings the agent needs at decision time (repeated-read, cerebrum match, buglog match), append a clearly-delimited **trailing** block to the tool output instead of prepending a leading prefix.

Format for Read tool (`tool.execute.after`):
```
<original file content>

---
OpenWolf: <file> already read this session (~N tokens). | Anatomy: <desc> (~N tok). | Related: <symbols>.
```

Format for Write/Edit (`tool.execute.before`): these fire BEFORE the tool runs, so they cannot append to output. Instead, cerebrum/buglog warnings move to the **system prompt** (already injected) and the `wolf_search` tool. The agent can proactively query `wolf_search` before writing. The pre-write interception stops injecting warnings inline.

**Rationale**: 
- Trailing blocks don't pollute the file content the agent reads first.
- The `---` delimiter clearly separates file content from plugin metadata.
- Pre-write warnings via `tool.execute.before` have no output to append to (the tool hasn't run yet), so they cannot use the same pattern. Moving them to system prompt + on-demand tools is cleaner than prepending to a tool result that doesn't exist yet.

**Alternatives considered**:
- *Keep leading prefix but strip emoji*: Still pollutes file content. The agent reads `[OpenWolf] ...` before the actual file. Rejected.
- *Drop enrichment entirely*: Loses value. The anatomy/related info is useful context. Rejected.
- *Use a separate "notification" API*: OpenCode plugin API (as used in this codebase) has no dedicated notification channel beyond output mutation, system prompt, and tool returns. No such API to use.

### Decision 3: System prompt and compaction context — strip emoji, keep bracket prefix

**Choice**: Keep `experimental.chat.system.transform` and `experimental.session.compacting` but reformat:
- Remove emoji (`🕸️`, `🐺`, `📋`, etc.)
- Keep `[OpenWolf]` and `[Graphify]` bracket prefixes (these are system-prompt-internal, not TUI-rendered noise)
- Make them concise (one-line summary + key data)

**Rationale**: System prompt and compaction context are seen by the agent, not rendered as TUI noise. They're the correct channel for persistent context. Only their verbosity needs trimming.

### Decision 4: `wolf_status` tool — remove emoji title, keep structured output

**Choice**: Reformat `wolf_status` output:
- Remove `🐺 OpenWolf Status` + `==================` ASCII underline
- Use plain `OpenWolf Status` title
- Keep the structured multi-line output (it's returned via `{ title, output }` which OpenCode renders correctly as a tool result)

**Rationale**: Tool returns are a sanctioned channel and render properly. Only the emoji/ASCII styling is unnecessary.

### Decision 5: graphify.js — fix casing, keep echo mechanism

**Choice**: In graphify.js, change `[graphify]` to `[Graphify]` for brand consistency. Keep the bash echo mechanism (it's a one-time reminder that renders as part of bash tool output, which is properly structured).

**Rationale**: The bash echo renders inside a tool result panel, not as floating stderr. It's acceptable. Only the casing is inconsistent.

### Decision 6: Standardize prefix convention

**Choice**: All plugin-originated text uses `[OpenWolf]` (brackets, capital O, capital W) when it needs a brand prefix. No emoji anywhere. Exceptions: `[Graphify]` for graphify-specific messages.

**Rationale**: Currently the codebase uses `[OpenWolf]`, `OpenWolf:`, `OpenWolf anatomy:`, `OpenWolf cerebrum warning:`, `[Graphify]`, `[graphify]`, `Graphify:` — seven variants. Standardizing to two (`[OpenWolf]`, `[Graphify]`) makes filtering and mental parsing easier.

## Risks / Trade-offs

- **[Risk] Agent loses inline pre-write warnings (cerebrum/buglog)** → *Mitigation*: The system prompt already tells the agent to use `wolf_search` before writing. Cerebrum and buglog data remain in `.wolf/` files. The agent can query proactively. Net effect: warnings are pull-based instead of push-based.

- **[Risk] Trailing enrichment block may be missed by agent if file is long** → *Mitigation*: The `---` delimiter and `OpenWolf:` prefix make it scannable. Most files read in this codebase are under 500 lines. The enrichment is a summary, not critical instructions.

- **[Risk] Removing session-start nags (cerebrum freshness, buglog emptiness) reduces agent awareness** → *Mitigation*: These nags now appear in `wolf_status` output and in the compaction context. The agent is prompted to use `wolf_status` by the system prompt.

- **[Trade-off] Less immediate feedback in exchange for cleaner TUI** → The TUI becomes readable. The cost is that the agent must actively query `wolf_status` / `wolf_search` instead of passively receiving stderr warnings. This aligns with how OpenCode plugins are designed to work (tool-based interaction, not stderr broadcasting).

- **[Trade-off] Pre-write cerebrum/buglog interception becomes advisory, not blocking** → The `tool.execute.before` hook for write/edit no longer injects warnings. It still collects data. This is acceptable because the warnings were FYI, not hard blocks.
