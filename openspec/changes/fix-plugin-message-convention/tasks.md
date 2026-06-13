## 1. Session-state tracking for deferred warnings

- [x] 1.1 Add `recordedCerebrumWarnings` array to `sessionMeta` to store cerebrum pattern matches (pattern text, file, timestamp) instead of emitting them immediately
- [x] 1.2 Add `recordedBuglogMatches` array to `sessionMeta` to store buglog FYI matches (bug id, file, timestamp) instead of emitting them immediately
- [x] 1.3 Add `sessionNags` object to `sessionMeta` to store lifecycle advisory state (cerebrumEntryCount, cerebrumDaysSinceUpdate, buglogIsEmpty, buglogMissingUpdateFiles) populated at session start and session idle

## 2. Remove all `process.stderr.write()` calls

- [x] 2.1 Remove `process.stderr.write("⚠️ OpenWolf: Files edited 3+ times...")` from `stopSession()` (line ~1061) — move the multi-edit-file detection into `sessionNags`
- [x] 2.2 Remove `process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in Nh...")` from `stopSession()` (line ~1071) — move into `sessionNags`
- [x] 2.3 Remove `process.stderr.write("🕸️ Graphify: knowledge graph updated.")` from `scheduleGraphifyUpdate()` (line ~1091) — graphify update is silent; state is queryable via `wolf_status`
- [x] 2.4 Remove `process.stderr.write("💡 OpenWolf: cerebrum.md has only N entries...")` from `session.created` handler (line ~1158) — store in `sessionNags.cerebrumEntryCount`
- [x] 2.5 Remove `process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in N days...")` from `session.created` handler (line ~1162) — store in `sessionNags.cerebrumDaysSinceUpdate`
- [x] 2.6 Remove `process.stderr.write("📋 OpenWolf: buglog.json is empty...")` from `session.created` handler (line ~1169) — store in `sessionNags.buglogIsEmpty`
- [x] 2.7 Remove `process.stderr.write("⚡ OpenWolf: <file> was already read...")` from `tool.execute.before` read handler (line ~1207) — repeated-read advisory moves to trailing block (task 3.2)
- [x] 2.8 Remove `process.stderr.write("📋 OpenWolf anatomy: ...")` from `tool.execute.before` read handler (line ~1217) — anatomy info moves to trailing block (task 3.2)
- [x] 2.9 Remove `process.stderr.write("🕸️ Graphify: N node(s) in <file>...")` from `tool.execute.before` read handler (line ~1233) — graphify enrichment moves to trailing block (task 3.2)
- [x] 2.10 Remove `process.stderr.write("🕸️ Related: ...")` from `tool.execute.before` read handler (line ~1249) — related symbols move to trailing block (task 3.2)
- [x] 2.11 Remove `process.stderr.write("⚠️ OpenWolf cerebrum warning: ...")` from `tool.execute.before` write/edit handler (line ~1287) — record match in `recordedCerebrumWarnings` instead
- [x] 2.12 Remove `process.stderr.write("📋 OpenWolf buglog: ...")` and the 3 continuation lines (lines ~1315-1319) from `tool.execute.before` write/edit handler — record matches in `recordedBuglogMatches` instead
- [x] 2.13 Remove `process.stderr.write("⚠️ OpenWolf: <file> edited N times...")` from `tool.execute.after` write/edit handler (line ~1405) — repeated-edit state is already tracked in `session.edit_counts`, queryable via `wolf_status`

## 3. Convert Read enrichment from leading prefix to trailing delimited block

- [x] 3.1 Remove the `tool.execute.before` read handler's enrichment logic entirely (anatomy lookup, graphify enrichment, related symbols) — this logic moves to `tool.execute.after` where output exists to append to
- [x] 3.2 In `tool.execute.after` read handler, replace the leading-prefix `output.output = "[OpenWolf] " + enrichParts.join(" | ") + "\n\n" + ...` with a trailing append: `output.output = (output.output || "") + "\n\n---\nOpenWolf: " + enrichParts.join(" | ") + "\n"`
- [x] 3.3 Strip all emoji from enrichment part builders: change `"📋 " + entry.file + ": "` to `entry.file + ": "`, change `"🕸️ Related: "` to `"Related: "`
- [x] 3.4 Add repeated-read advisory to the trailing block: when `readHistory.get(normalizedFile).count > 1`, append `"already read (count: N, ~M tokens)"` to the enrichment parts
- [x] 3.5 Verify that when no enrichment parts exist (no anatomy, no graphify, no repeat), no `---` delimiter or trailing block is added — file content passes through unmodified

## 4. Rework pre-write hook to record, not emit

- [x] 4.1 In `tool.execute.before` write/edit handler, keep the cerebrum pattern-matching logic but replace the `process.stderr.write` warning with a push to `sessionMeta.recordedCerebrumWarnings.push({ pattern, file, timestamp })`
- [x] 4.2 Keep the buglog search logic but replace the `process.stderr.write` FYI block with a push to `sessionMeta.recordedBuglogMatches.push({ bugIds, file, timestamp })`
- [x] 4.3 Ensure the write/edit tool call proceeds without any output mutation in the before-hook (the before-hook for write/edit should not touch `output`)

## 5. Reformat system prompt and compaction context

- [x] 5.1 In `experimental.chat.system.transform`, strip emoji and verbose formatting: change to concise one-line `[OpenWolf] N files indexed. N read this session.` (no `🐺`, no multi-line god-node dump unless graphify exists — keep god nodes but plain text)
- [x] 5.2 Add a system-prompt advisory line: `Before writing to files, query wolf_search (scope: buglog, cerebrum) for known issues.` so the agent knows to proactively check
- [x] 5.3 In `experimental.session.compacting`, strip emoji: keep `[OpenWolf] N files read, N written. Anatomy hits: N, misses: N.` and `Most-read: ...` as plain text

## 6. Reformat `wolf_status` tool output

- [x] 6.1 Change title from `"OpenWolf Status"` (keep as-is, already no emoji in title field) and remove `🐺 OpenWolf Status` + `==================` from the output body — use plain `OpenWolf Status` header line
- [x] 6.2 Add a `Cerebrum` section to wolf_status output showing: entry count, days since last update (from `sessionNags`)
- [x] 6.3 Add a `Buglog` section to wolf_status output showing: total bug count, whether empty (from `sessionNags`)
- [x] 6.4 Add a `Recorded warnings` section to wolf_status output showing counts of `recordedCerebrumWarnings` and `recordedBuglogMatches` from this session, with a hint to use `wolf_search` for details
- [x] 6.5 Strip any emoji from wolf_status output lines (currently `🐺` in header)

## 7. Fix graphify.js branding

- [x] 7.1 In `.opencode/plugins/graphify.js` line 16, change `echo "[graphify] ..."` to `echo "[Graphify] ..."` (capital G) for brand consistency with the system prompt's `[Graphify]`

## 8. Verification

- [x] 8.1 Grep the plugin file for `process.stderr.write` and `process.stdout.write` — confirm zero matches
- [x] 8.2 Grep the plugin file for emoji characters (`🕸️`, `⚡`, `📋`, `⚠️`, `💡`, `🐺`) — confirm zero matches
- [x] 8.3 Read a file in OpenCode and confirm the tool output starts with file content (not `[OpenWolf]`) and any enrichment appears after a `---` delimiter at the end
- [x] 8.4 Invoke `wolf_status` tool and confirm output has no emoji, shows cerebrum/buglog sections, and shows recorded warning counts
- [x] 8.5 Write/edit a file that triggers a cerebrum match and confirm no stderr noise appears in the TUI, then query `wolf_search` to confirm the match was recorded
- [x] 8.6 Confirm graphify.js bash echo now shows `[Graphify]` (capital G)
