## 1. Plugin Skeleton & State Management

- [ ] 1.1 Create `.opencode/plugins/openwolf-plugin.js` with named export `export const OpenWolfPlugin = async ({ directory, client, project, worktree, serverUrl, $ }) => { ... }` returning a `Hooks` object
- [ ] 1.2 Implement in-memory state initialization: `anatomyCache` (Map), `readHistory` (Map), `tokenLedger` (Map), `cerebrumPatterns` (Array), `sessionStats` (object with counters)
- [ ] 1.3 Implement `loadGraphData()` — parse `graphify-out/graph.json` into 3 lookup indexes (source_file/norm_label → node, community → nodes, node id → links from top-level `links` array), with 5MB size guard. Node fields: `id`, `label`, `file_type`, `community`, `source_file`. Link fields: `source`, `target`, `relation`, `confidence`, `weight`.
- [ ] 1.4 Implement `loadGraphReport()` — parse `graphify-out/GRAPH_REPORT.md` to extract god nodes (top 10 by degree) and community summaries
- [ ] 1.5 Implement anatomy parsing functions inlined from `shared.ts`: `parseAnatomy()`, `extractDescription()`, `estimateTokens()`

## 2. Tool Interception Hooks

- [ ] 2.1 Implement `tool.execute.before` handler for Read tool: anatomy lookup from `.wolf/anatomy.md`, repeated-read warning (threshold: 3), graphify community enrichment from in-memory index
- [ ] 2.2 Implement `tool.execute.after` handler for Read tool: token estimation via whitespace heuristic, update readHistory and tokenLedger
- [ ] 2.3 Implement `tool.execute.before` handler for Write/Edit tools: load `.wolf/cerebrum.md` patterns, match against write content, inject warning if matched; also search `.wolf/buglog.json` for known bugs matching the target file (by filename, tag overlap, or keyword overlap), surface top 2 as FYI
- [ ] 2.4 Implement `tool.execute.after` handler for Write/Edit tools: anatomy update (extract description, upsert into `.wolf/anatomy.md`), memory log append to `.wolf/memory.md` (if >50 lines), bug pattern scan (console.log, empty catch, TODO/FIXME/HACK) append to `.wolf/buglog.json`

## 3. Graphify Context Injection

- [ ] 3.1 Implement `experimental.chat.system.transform` handler: inject god nodes + community map (~300 tokens) with version availability guard
- [ ] 3.2 Implement pre-read file community enrichment: lookup file node by matching `source_file`/`norm_label`, get community id + `label` + `file_type` + top 5 linked nodes from `links` array with relation types, prepend as structured comment block

## 4. Graphify Auto-Update

- [ ] 4.1 Implement debounced `graphify update .` trigger in Write/Edit `tool.execute.after` handler: 5-second debounce timer, async execution, 30-second timeout
- [ ] 4.2 Implement change detection: read `graphify-out/manifest.json`, compare `ast_hash` values (MD5, 32-char hex) against current file hashes, skip update if unchanged
- [ ] 4.3 Implement graph data refresh after successful update: reload `graphify-out/graph.json`, rebuild lookup indexes (source_file/norm_label-to-node, community-to-nodes, node-id-to-links), log updated stats
- [ ] 4.4 Implement graphify CLI availability check at initialization: verify `graphify` on `$PATH`, disable auto-update if missing, log one-time warning

## 5. Custom Tools

- [ ] 5.1 Register `wolf_status` tool via `tool()` API with zod schema (no args), returning session stats JSON (totalReads, totalWrites, estimatedTokens, bugsDetected, cerebrumMatches, graphStats, topReadFiles)
- [ ] 5.2 Register `wolf_search` tool with zod schema (scope: enum[anatomy,cerebrum,memory,buglog,all], query: string), searching `.wolf/` files and returning grouped results
- [ ] 5.3 Register `wolf_graph` tool with zod schema (action: enum[query,explain,path,neighbors], term: string, from: optional string, to: optional string), querying in-memory graph indexes

## 6. Session Lifecycle

- [ ] 6.1 Implement `event` hook handler for `session.created`: initialize state, load graph data, load anatomy cache from `.wolf/anatomy.md`
- [ ] 6.2 Implement `event` hook handler for `session.idle`: persist token ledger to `.wolf/_session.json`, log session summary
- [ ] 6.3 Implement `experimental.session.compacting` handler: inject wolf session context (top read files, token stats, cerebrum matches, graph stats) into compaction prompt (~100 tokens) to preserve wolf awareness across compaction
- [ ] 6.4 Implement `dispose` hook: flush all in-memory state to filesystem, cancel pending debounce timers

## 7. Integration & Configuration

- [ ] 7.1 Update `.opencode/opencode.json` to reference `openwolf-plugin.js` (replace `graphify.js`)
- [ ] 7.2 Remove or archive `.opencode/plugins/graphify.js` (replaced by integrated plugin)
- [ ] 7.3 Test plugin load in OpenCode: verify all hooks register, no errors in console
- [ ] 7.4 Test end-to-end: read a file (verify enrichment), write a file (verify anatomy update + graphify update), invoke custom tools
