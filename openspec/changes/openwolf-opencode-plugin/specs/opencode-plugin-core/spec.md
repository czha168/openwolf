## ADDED Requirements

### Requirement: Plugin lifecycle initialization
The plugin SHALL initialize in-memory state (anatomy cache, read history, token ledger, cerebrum patterns) when loaded by OpenCode. The plugin SHALL load graphify graph data into memory at initialization.

#### Scenario: First session start
- **WHEN** OpenCode fires a `session.created` event (first load of the plugin in a session)
- **THEN** the plugin creates empty in-memory maps for anatomy cache, read history, token ledger, and cerebrum patterns
- **AND** the plugin loads `graphify-out/graph.json` into memory if it exists
- **AND** the plugin loads `graphify-out/GRAPH_REPORT.md` god nodes and community map if it exists

#### Scenario: No graphify data present
- **WHEN** `graphify-out/graph.json` does not exist at plugin load
- **THEN** the plugin initializes with empty graph data and continues without error
- **AND** graphify-related features are disabled gracefully

### Requirement: Pre-read anatomy lookup
The plugin SHALL intercept Read tool calls via `tool.execute.before` and provide anatomy information for the file being read. The plugin SHALL look up the file in `.wolf/anatomy.md` and prepend relevant anatomy metadata.

#### Scenario: File has anatomy entry
- **WHEN** the agent reads a file that has an entry in anatomy.md
- **THEN** the plugin prepends a structured comment with the file's description, last modified timestamp, and related files from anatomy

#### Scenario: File has no anatomy entry
- **WHEN** the agent reads a file with no anatomy entry
- **THEN** the plugin passes the read through without modification

#### Scenario: Repeated read warning
- **WHEN** the agent reads the same file more than 3 times in a session
- **THEN** the plugin prepends a warning that this file was already read N times, suggesting the agent may be stuck

### Requirement: Post-read token estimation
The plugin SHALL estimate the token count of files read by the agent and track cumulative token usage in the token ledger.

#### Scenario: Token tracking after read
- **WHEN** the agent reads a file successfully
- **THEN** the plugin estimates token count using whitespace-based heuristic
- **AND** the plugin adds the token count to the in-memory token ledger
- **AND** the plugin updates the read history for the file

### Requirement: Pre-write cerebrum and buglog check
The plugin SHALL intercept Write/Edit tool calls via `tool.execute.before` and perform two checks: (1) check `.wolf/cerebrum.md` for patterns the agent has already learned, and (2) check `.wolf/buglog.json` for known bugs in the target file. If the write introduces a previously-learned pattern, the plugin SHALL inject a warning. If the target file has known bugs, the plugin SHALL surface the top 2 as FYI.

#### Scenario: Write matches learned pattern
- **WHEN** the agent writes code that matches a pattern in cerebrum.md
- **THEN** the plugin injects a warning comment indicating this pattern was previously applied and suggesting review

#### Scenario: Target file has known bugs
- **WHEN** the agent writes to a file that has entries in buglog.json (matching by filename, tag overlap, or keyword overlap)
- **THEN** the plugin injects an FYI comment with up to 2 known bugs for that file

#### Scenario: Write does not match any pattern and no known bugs
- **WHEN** the agent writes code that does not match any cerebrum pattern and the target file has no buglog entries
- **THEN** the plugin passes the write through without modification

### Requirement: Post-write anatomy update
The plugin SHALL intercept Write/Edit tool calls via `tool.execute.after` and update `.wolf/anatomy.md` with the file's new description extracted from the written content.

#### Scenario: New file written
- **WHEN** the agent writes to a file not yet in anatomy.md
- **THEN** the plugin extracts a description from the file content (module docstring, class/function names)
- **AND** the plugin appends a new entry to anatomy.md

#### Scenario: Existing file updated
- **WHEN** the agent writes to a file already in anatomy.md
- **THEN** the plugin updates the description and last-modified timestamp

### Requirement: Post-write memory logging
The plugin SHALL append significant write operations to `.wolf/memory.log` with a timestamp and summary.

#### Scenario: Significant write logged
- **WHEN** the agent writes more than 50 lines to a file
- **THEN** the plugin appends an entry to memory.log with timestamp, file path, line count delta, and extracted description

### Requirement: Post-write bug detection
The plugin SHALL scan written content for common bug patterns (TODO/FIXME/HACK comments, empty catch blocks, console.log statements) and append to `.wolf/buglog.json`.

#### Scenario: Bug pattern detected
- **WHEN** the agent writes code containing `console.log`, empty catch, or TODO with severity keywords
- **THEN** the plugin appends an entry to buglog.json (format: `{ bugs: [{ id, error_message, file, root_cause, fix, tags }] }`) with the pattern type, file path, line number, and surrounding context

### Requirement: Session summary on idle
The plugin SHALL flush the token ledger and session state when the session goes idle or the plugin is disposed.

#### Scenario: Session idle
- **WHEN** OpenCode fires a session idle event
- **THEN** the plugin persists the in-memory token ledger to `.wolf/_session.json`
- **AND** the plugin logs a session summary (total tokens, files read, files written, bugs detected)

#### Scenario: Plugin dispose
- **WHEN** OpenCode disposes the plugin
- **THEN** the plugin flushes all in-memory state to filesystem
