## ADDED Requirements

### Requirement: Plugin message display convention
The plugin SHALL NOT emit messages via `process.stderr.write()` or `process.stdout.write()`. The plugin SHALL NOT prepend metadata blocks as leading prefixes to Read tool output (`output.output`). All plugin-originated text visible to the agent SHALL use one of: (a) trailing delimited block appended to tool output, (b) system prompt injection, (c) session compaction context, or (d) custom tool return values. The plugin SHALL NOT use emoji characters in any message. The plugin SHALL use the `[OpenWolf]` bracket prefix (capital O, capital W) consistently for all branded messages, and `[Graphify]` for graphify-specific messages.

#### Scenario: No stderr writes during session
- **WHEN** the plugin is loaded and a full session runs (reads, writes, session start, session idle)
- **THEN** the plugin makes zero `process.stderr.write()` calls
- **AND** the plugin makes zero `process.stdout.write()` calls

#### Scenario: Read tool output starts with file content
- **WHEN** the agent reads any file and the plugin enriches the output
- **THEN** the first characters of `output.output` are the original file content, not a plugin metadata prefix
- **AND** any plugin enrichment appears after a `---` delimiter following the file content

#### Scenario: Trailing enrichment block format
- **WHEN** the plugin appends anatomy, graphify, or repeated-read context to a Read tool result
- **THEN** the enrichment is separated from file content by a line containing only `---`
- **AND** the enrichment begins with `OpenWolf:` followed by pipe-separated `key: value` pairs
- **AND** the enrichment contains no emoji characters

#### Scenario: No emoji in any plugin output
- **WHEN** any plugin message is produced (tool output, system prompt, compaction context, tool return)
- **THEN** the message contains no emoji characters (no `⚠️`, `💡`, `📋`, `⚡`, `🕸️`, `🐺`, or similar)

### Requirement: wolf_status tool output format
The `wolf_status` custom tool SHALL return a structured plain-text status report. The tool SHALL NOT use emoji characters or ASCII underline art in its output. The tool title SHALL be `OpenWolf Status` (no emoji prefix).

#### Scenario: wolf_status invocation
- **WHEN** the agent invokes the `wolf_status` tool
- **THEN** the tool returns `{ title: "OpenWolf Status", output: <structured text> }`
- **AND** the output contains no emoji characters
- **AND** the output contains no `==================` ASCII underline art
- **AND** the output includes anatomy coverage, token usage, graphify state, cerebrum freshness, and buglog status sections

## MODIFIED Requirements

### Requirement: Pre-read anatomy lookup
The plugin SHALL intercept Read tool calls via `tool.execute.after` and append anatomy information for the file being read as a trailing delimited block after the file content. The plugin SHALL look up the file in `.wolf/anatomy.md`. The plugin SHALL NOT prepend metadata as a leading prefix to the file content. The plugin SHALL NOT emit anatomy information via `process.stderr.write()`.

#### Scenario: File has anatomy entry
- **WHEN** the agent reads a file that has an entry in anatomy.md
- **THEN** the plugin appends a trailing block after the file content, separated by a `---` delimiter
- **AND** the trailing block contains the file's description and token estimate in `key: value` format
- **AND** the file content itself is unmodified at the start of the output

#### Scenario: File has no anatomy entry
- **WHEN** the agent reads a file with no anatomy entry
- **THEN** the plugin passes the read through without appending any trailing block

#### Scenario: Repeated read advisory
- **WHEN** the agent reads the same file more than once in a session
- **THEN** the plugin appends a repeated-read advisory to the trailing enrichment block
- **AND** the advisory states the file was already read and the estimated token cost
- **AND** the plugin does NOT emit a `process.stderr.write()` warning

### Requirement: Pre-write cerebrum and buglog check
The plugin SHALL intercept Write/Edit tool calls via `tool.execute.before` and perform two checks: (1) check `.wolf/cerebrum.md` for patterns the agent has already learned, and (2) check `.wolf/buglog.json` for known bugs in the target file. The plugin SHALL NOT inject warnings into tool output or stderr. The plugin SHALL record matches in session state for surfacing via the `wolf_status` and `wolf_search` tools. The system prompt SHALL advise the agent to query `wolf_search` before writing to files with known patterns.

#### Scenario: Write matches learned pattern
- **WHEN** the agent writes code that matches a pattern in cerebrum.md
- **THEN** the plugin records the match in session state (incrementing `cerebrumWarnings`)
- **AND** the plugin does NOT inject a warning into the tool output
- **AND** the plugin does NOT emit a `process.stderr.write()` warning
- **AND** the match is surfaced when the agent queries `wolf_status`

#### Scenario: Target file has known bugs
- **WHEN** the agent writes to a file that has entries in buglog.json (matching by filename, tag overlap, or keyword overlap)
- **THEN** the plugin records the matched bugs in session state
- **AND** the plugin does NOT inject an FYI comment into the tool output
- **AND** the plugin does NOT emit `process.stderr.write()` messages
- **AND** the bugs are surfaced when the agent queries `wolf_search` with scope `buglog`

#### Scenario: Write does not match any pattern and no known bugs
- **WHEN** the agent writes code that does not match any cerebrum pattern and the target file has no buglog entries
- **THEN** the plugin passes the write through without recording any warning state

### Requirement: Session summary on idle
The plugin SHALL flush the token ledger and session state when the session goes idle or the plugin is disposed. The plugin SHALL NOT emit session-lifecycle nags (cerebrum freshness, buglog emptiness, missing buglog updates, graphify update notifications) via `process.stderr.write()`. Session-lifecycle advisory information SHALL be available via the `wolf_status` tool output.

#### Scenario: Session idle
- **WHEN** OpenCode fires a session idle event
- **THEN** the plugin persists the in-memory token ledger to `.wolf/_session.json`
- **AND** the plugin logs a session summary to `.wolf/memory.md`
- **AND** the plugin does NOT emit any `process.stderr.write()` messages

#### Scenario: Plugin dispose
- **WHEN** OpenCode disposes the plugin
- **THEN** the plugin flushes all in-memory state to filesystem
- **AND** the plugin does NOT emit `process.stderr.write()` nag messages about missing buglog updates or stale cerebrum

#### Scenario: Cerebrum freshness advisory available on demand
- **WHEN** the agent queries the `wolf_status` tool
- **THEN** the output includes cerebrum freshness information (entry count, days since last update) if `.wolf/cerebrum.md` exists
- **AND** the output includes buglog status (entry count) if `.wolf/buglog.json` exists
- **AND** this information is NOT emitted automatically via stderr at session start

