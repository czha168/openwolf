## ADDED Requirements

### Requirement: System prompt graphify context injection
The plugin SHALL inject graphify-derived architectural context into the system prompt via `experimental.chat.system.transform`. The injected content SHALL include god nodes (highest-degree nodes), community structure summary, and key cross-community edges.

#### Scenario: Graph data available
- **WHEN** `graphify-out/GRAPH_REPORT.md` exists and contains god nodes and communities
- **THEN** the plugin extracts the top 10 god nodes (by degree) with their labels and community assignments
- **AND** the plugin extracts community names and their primary technology/domain
- **AND** the plugin injects a structured block (~300 tokens) into the system prompt listing architectural context

#### Scenario: Graph data unavailable
- **WHEN** `graphify-out/GRAPH_REPORT.md` does not exist or is empty
- **THEN** the plugin does not modify the system prompt

#### Scenario: System prompt transform hook unavailable
- **WHEN** OpenCode version does not support `experimental.chat.system.transform`
- **THEN** the plugin logs a warning and skips system prompt injection
- **AND** other plugin features continue to work normally

### Requirement: Pre-read file community enrichment
The plugin SHALL enrich Read tool calls with graphify community context. When the agent reads a file, the plugin SHALL look up the file's node in the graph and prepend community membership, architectural role, and top-connected neighbor files.

#### Scenario: File has graph node with community
- **WHEN** the agent reads a file that has a corresponding node in `graphify-out/graph.json` (matched by `source_file` or `norm_label`) with a `community` field
- **THEN** the plugin prepends a comment block with: community id, `file_type`, `label`, and up to 5 neighbor nodes from the `links` array with their `relation` types

#### Scenario: File has graph node without community
- **WHEN** the agent reads a file with a graph node but no `community` field
- **THEN** the plugin prepends the node `label` and neighbor nodes without community id

#### Scenario: File not in graph
- **WHEN** the agent reads a file with no corresponding node in the graph
- **THEN** the plugin passes the read through without enrichment

### Requirement: Graph data loaded once into memory
The plugin SHALL load `graphify-out/graph.json` once at initialization and build an in-memory lookup index (file path → node, community → nodes, node id → edges). The graph JSON uses a top-level `nodes` array and a separate top-level `links` array (not embedded edges). Node fields: `id`, `label`, `file_type`, `community`, `source_file`, `source_location`, `norm_label`. Link fields: `source`, `target`, `relation`, `confidence`, `confidence_score`, `weight`.

#### Scenario: Successful graph load
- **WHEN** the plugin initializes and `graphify-out/graph.json` exists
- **THEN** the plugin parses the JSON and builds 3 lookup maps: source_file/norm_label-to-node, community-to-nodes, and node-id-to-links (from the top-level `links` array)
- **AND** the plugin logs the graph statistics (node count, link count, community count)

#### Scenario: Graph file too large
- **WHEN** `graphify-out/graph.json` exceeds 5MB
- **THEN** the plugin logs a warning and loads only the node index (skipping edge details for performance)
