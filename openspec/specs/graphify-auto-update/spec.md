## ADDED Requirements

### Requirement: Automatic graph update after code writes
The plugin SHALL run `graphify update .` automatically after Write/Edit tool calls complete, keeping the knowledge graph current with zero manual intervention.

#### Scenario: Single file write triggers update
- **WHEN** the agent writes to a file via Write or Edit tool
- **THEN** the plugin schedules a deferred `graphify update .` execution after a 5-second debounce window
- **AND** the update runs asynchronously without blocking the tool response

#### Scenario: Rapid writes are debounced
- **WHEN** the agent writes to multiple files within a 5-second window
- **THEN** the plugin batches all writes into a single `graphify update .` call after the window expires
- **AND** only one update runs regardless of the number of writes in the window

### Requirement: Change detection via manifest hashes
The plugin SHALL skip graphify update if no source files have actually changed since the last update, as determined by comparing `ast_hash` values from `graphify-out/manifest.json` (MD5 hashes, 32-char hex).

#### Scenario: No files changed since last update
- **WHEN** the debounce window expires and all `ast_hash` values in manifest.json match the current file state
- **THEN** the plugin skips the `graphify update .` call entirely

#### Scenario: Files changed since last update
- **WHEN** at least one `ast_hash` differs from manifest.json
- **THEN** the plugin proceeds with `graphify update .`

### Requirement: Graph data refresh after update
The plugin SHALL reload in-memory graph data after a successful `graphify update .` execution.

#### Scenario: Successful update
- **WHEN** `graphify update .` completes with exit code 0
- **THEN** the plugin reloads `graphify-out/graph.json` into memory
- **AND** the plugin rebuilds the lookup indexes (source_file/norm_label-to-node, community-to-nodes, node-id-to-links)
- **AND** subsequent reads use the fresh graph data

#### Scenario: Update fails
- **WHEN** `graphify update .` exits with non-zero code or times out (30-second limit)
- **THEN** the plugin logs the error and continues using the existing in-memory graph data
- **AND** the plugin does NOT crash or block further tool operations

### Requirement: Update runs only when graphify CLI is available
The plugin SHALL verify that the `graphify` CLI is available on `$PATH` before attempting updates.

#### Scenario: graphify CLI available
- **WHEN** the plugin detects `graphify` on `$PATH` at initialization
- **THEN** auto-update is enabled

#### Scenario: graphify CLI not available
- **WHEN** the plugin cannot find `graphify` on `$PATH`
- **THEN** auto-update is disabled
- **AND** the plugin logs a one-time warning at initialization
- **AND** all other plugin features continue to work
