## ADDED Requirements

### Requirement: wolf_status custom tool
The plugin SHALL register a `wolf_status` custom tool that returns the current session state including files read, files written, tokens consumed, bugs detected, and cerebrum patterns matched.

#### Scenario: Agent queries session status
- **WHEN** the agent invokes the `wolf_status` tool
- **THEN** the tool returns a JSON object with: totalReads (number), totalWrites (number), estimatedTokens (number), bugsDetected (number), cerebrumMatches (number), graphStats (node/edge/community counts), and topReadFiles (top 5 by read count)

#### Scenario: No session activity yet
- **WHEN** the agent invokes `wolf_status` at session start before any reads or writes
- **THEN** the tool returns a JSON object with all counters at zero and empty topReadFiles

### Requirement: wolf_search custom tool
The plugin SHALL register a `wolf_search` custom tool that searches `.wolf/` state files (anatomy.md, cerebrum.md, memory.md, buglog.json) for a given query string.

#### Scenario: Search anatomy.md
- **WHEN** the agent invokes `wolf_search` with scope="anatomy" and query="authentication"
- **THEN** the tool returns all anatomy entries matching "authentication" in file path or description

#### Scenario: Search buglog.json
- **WHEN** the agent invokes `wolf_search` with scope="buglog" and query="console.log"
- **THEN** the tool returns all buglog entries matching "console.log"

#### Scenario: Search all scopes
- **WHEN** the agent invokes `wolf_search` with scope="all" and query="handler"
- **THEN** the tool searches anatomy.md, cerebrum.md, memory.md, and buglog.json
- **AND** returns results grouped by scope

### Requirement: wolf_graph custom tool
The plugin SHALL register a `wolf_graph` custom tool that queries the in-memory graphify knowledge graph using subcommands: `query`, `explain`, `path`, `neighbors`.

#### Scenario: Graph query
- **WHEN** the agent invokes `wolf_graph` with action="query" and term="authentication middleware"
- **THEN** the tool searches graph node labels and descriptions for matches
- **AND** returns matching nodes with their community, type, and top 3 edges

#### Scenario: Graph explain
- **WHEN** the agent invokes `wolf_graph` with action="explain" and term="session management"
- **THEN** the tool returns the subgraph of nodes related to "session management" including their community context and relationships

#### Scenario: Graph path
- **WHEN** the agent invokes `wolf_graph` with action="path", from="src/auth/login.ts", and to="src/db/users.ts"
- **THEN** the tool returns the shortest path between the two file nodes in the graph
- **AND** lists each intermediate node with its label and relation type

#### Scenario: Graph neighbors
- **WHEN** the agent invokes `wolf_graph` with action="neighbors" and node="src/api/routes.ts"
- **THEN** the tool returns all nodes directly connected to the specified node
- **AND** includes relation type and confidence for each edge

#### Scenario: Graph data not loaded
- **WHEN** the agent invokes `wolf_graph` but no graph data was loaded (graph.json missing)
- **THEN** the tool returns an error message indicating graphify data is not available
