# Fix Plugin Message Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `process.stderr.write()` calls and emoji from the OpenWolf OpenCode plugin, convert leading-prefix metadata to trailing delimited blocks, and route pre-write warnings to session state instead of stderr.

**Architecture:** Single-file refactor of `.opencode/plugins/openwolf-plugin.js` (1655 lines). The plugin's six message channels are consolidated: stderr is deleted entirely, leading-prefix `output.output` mutation becomes a trailing `---`-delimited append, session-lifecycle nags move to `sessionMeta.sessionNags` (queryable via `wolf_status`), and pre-write cerebrum/buglog warnings move to `sessionMeta.recordedCerebrumWarnings` / `recordedBuglogMatches` (queryable via `wolf_search`). Data collection logic is untouched — only the display surface changes.

**Tech Stack:** Node.js ESM, OpenCode plugin API (`@opencode-ai/plugin`), no test framework (verification is grep-based + `node --check` syntax validation + manual runtime checks).

**Spec:** `openspec/changes/fix-plugin-message-convention/`

**Files Modified:**
- `.opencode/plugins/openwolf-plugin.js` — all 10 tasks touch this file
- `.opencode/plugins/graphify.js` — Task 9 only (1-line casing fix)

---

## File Structure

The plugin is a single 1655-line file with these sections:

| Lines | Section | Responsibility |
|-------|---------|---------------|
| 1-36 | Constants | Config values, file extension sets |
| 37-88 | Shared utilities | Path helpers, token estimation, JSON I/O |
| 89-170 | Anatomy parsing | Parse/serialize `anatomy.md` |
| 170-820 | Description extraction + bug detection | Heuristics for file descriptions and fix patterns |
| 820-925 | Module-level state | `let` declarations for all mutable state (line 926-936) |
| 926-936 | State variables | `sessionMeta`, `readHistory`, `anatomyCache`, etc. |
| 940-1074 | `stopSession()` | Session teardown, ledger flush, memory log |
| 1076-1098 | `scheduleGraphifyUpdate()` | Debounced graph rebuild |
| 1104-1655 | Plugin export | Lifecycle hooks, event hooks, tool hooks, tools |

No file split is needed. The file is large but cohesive — all changes are display-surface edits within the existing structure.

---

## Task 1: Add session-state tracking fields

Add three new fields to `sessionMeta` for deferred warning storage and lifecycle nag state.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:934` (state declaration)
- Modify: `.opencode/plugins/openwolf-plugin.js:1123-1127` (session.created init)

- [ ] **Step 1: Modify the `sessionMeta` declaration (line 934)**

Replace this exact line:

```javascript
let sessionMeta = { id: "", started: "", anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0 };
```

With:

```javascript
let sessionMeta = {
  id: "", started: "",
  anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
  recordedCerebrumWarnings: [],
  recordedBuglogMatches: [],
  sessionNags: {
    cerebrumEntryCount: null,
    cerebrumDaysSinceUpdate: null,
    cerebrumHoursSinceUpdate: null,
    buglogIsEmpty: false,
    multiEditFiles: [],
  },
};
```

- [ ] **Step 2: Modify the `session.created` initialization (lines 1123-1127)**

The `session.created` handler resets `sessionMeta` on each new session. Find this block inside the `session.created` branch (around line 1123):

```javascript
        sessionMeta = {
          id: "session-" + dateStr + "-" + timeStr,
          started: now.toISOString(),
          anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
        };
```

Replace with:

```javascript
        sessionMeta = {
          id: "session-" + dateStr + "-" + timeStr,
          started: now.toISOString(),
          anatomyHits: 0, anatomyMisses: 0, repeatedWarned: 0, cerebrumWarnings: 0,
          recordedCerebrumWarnings: [],
          recordedBuglogMatches: [],
          sessionNags: {
            cerebrumEntryCount: null,
            cerebrumDaysSinceUpdate: null,
            cerebrumHoursSinceUpdate: null,
            buglogIsEmpty: false,
            multiEditFiles: [],
          },
        };
```

- [ ] **Step 3: Verify syntax**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0). No syntax errors.

- [ ] **Step 4: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): add sessionMeta fields for deferred warnings and nags"
```

---

## Task 2: Remove lifecycle stderr writes from stopSession and scheduleGraphifyUpdate

Remove 3 `process.stderr.write()` calls from session lifecycle functions. Move their data into `sessionMeta.sessionNags` instead of emitting to stderr.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1056-1073` (stopSession buglog nag + cerebrum freshness)
- Modify: `.opencode/plugins/openwolf-plugin.js:1091` (scheduleGraphifyUpdate success message)

- [ ] **Step 1: Replace the buglog nag in stopSession (lines 1056-1063)**

Find this block:

```javascript
  // Missing buglog nag
  const multiEditFiles = Object.entries(editCounts).filter(([, c]) => c >= REPEATED_EDIT_THRESHOLD).map(([f]) => f);
  if (multiEditFiles.length > 0) {
    const hasBuglogEdit = writtenFiles.some(f => f.includes("buglog.json"));
    if (!hasBuglogEdit) {
      process.stderr.write("⚠️ OpenWolf: Files edited 3+ times (" + multiEditFiles.map(basename).join(", ") + ") but buglog.json was not updated.\n");
    }
  }
```

Replace with:

```javascript
  // Missing buglog nag — stored in sessionNags, surfaced via wolf_status
  const multiEditFiles = Object.entries(editCounts).filter(([, c]) => c >= REPEATED_EDIT_THRESHOLD).map(([f]) => f);
  if (multiEditFiles.length > 0) {
    const hasBuglogEdit = writtenFiles.some(f => f.includes("buglog.json"));
    if (!hasBuglogEdit) {
      sessionMeta.sessionNags.multiEditFiles = multiEditFiles.map(basename);
    }
  }
```

- [ ] **Step 2: Replace the cerebrum freshness nag in stopSession (lines 1065-1073)**

Find this block:

```javascript
  // Cerebrum freshness nag
  const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
  if (existsSync(cerebrumFile) && writeCount >= 3) {
    const stat = statSync(cerebrumFile);
    const hoursSince = (Date.now() - stat.mtimeMs) / 3600000;
    if (hoursSince > 24) {
      process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in " + Math.floor(hoursSince) + "h. Did you learn any preferences this session?\n");
    }
  }
```

Replace with:

```javascript
  // Cerebrum freshness — stored in sessionNags, surfaced via wolf_status
  const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
  if (existsSync(cerebrumFile) && writeCount >= 3) {
    const stat = statSync(cerebrumFile);
    const hoursSince = (Date.now() - stat.mtimeMs) / 3600000;
    if (hoursSince > 24) {
      sessionMeta.sessionNags.cerebrumHoursSinceUpdate = Math.floor(hoursSince);
    }
  }
```

- [ ] **Step 3: Remove the graphify update stderr write (line 1091)**

Find this block inside `scheduleGraphifyUpdate()`:

```javascript
      if (afterHash && afterHash !== beforeHash) {
        process.stderr.write("🕸️ Graphify: knowledge graph updated.\n");
        loadGraphifyData(projectDir);
      }
```

Replace with:

```javascript
      if (afterHash && afterHash !== beforeHash) {
        loadGraphifyData(projectDir);
      }
```

- [ ] **Step 4: Verify syntax and stderr count**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -c "process.stderr.write" .opencode/plugins/openwolf-plugin.js`
Expected: `13` (was 16, removed 3)

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): remove lifecycle stderr writes from stopSession and graphify update"
```

---

## Task 3: Remove session.created stderr writes

Remove 3 `process.stderr.write()` calls from the `session.created` event handler. Move cerebrum/buglog data into `sessionMeta.sessionNags`.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1152-1170` (cerebrum freshness + buglog emptiness checks)

- [ ] **Step 1: Replace the cerebrum entry count check (lines 1152-1164)**

Find this block:

```javascript
        // Cerebrum freshness check
        const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
        if (existsSync(cerebrumFile)) {
          const content = readFileSync(cerebrumFile, "utf8");
          const entryLines = content.split("\n").filter(l => /^[-*]\s|\[.*\]/.test(l.trim()));
          if (entryLines.length < 3) {
            process.stderr.write("💡 OpenWolf: cerebrum.md has only " + entryLines.length + " entries. Learn from this session.\n");
          } else {
            const stat = statSync(cerebrumFile);
            const daysSince = (Date.now() - stat.mtimeMs) / 86400000;
            if (daysSince > 3) process.stderr.write("💡 OpenWolf: cerebrum.md hasn't been updated in " + Math.floor(daysSince) + " days.\n");
          }
        }
```

Replace with:

```javascript
        // Cerebrum freshness check — stored in sessionNags, surfaced via wolf_status
        const cerebrumFile = wolfPath(projectDir, "cerebrum.md");
        if (existsSync(cerebrumFile)) {
          const content = readFileSync(cerebrumFile, "utf8");
          const entryLines = content.split("\n").filter(l => /^[-*]\s|\[.*\]/.test(l.trim()));
          sessionMeta.sessionNags.cerebrumEntryCount = entryLines.length;
          if (entryLines.length >= 3) {
            const stat = statSync(cerebrumFile);
            const daysSince = (Date.now() - stat.mtimeMs) / 86400000;
            sessionMeta.sessionNags.cerebrumDaysSinceUpdate = Math.floor(daysSince);
          }
        }
```

- [ ] **Step 2: Replace the buglog emptiness check (lines 1166-1170)**

Find this block:

```javascript
        // Buglog emptiness check
        const buglog = readJson(wolfPath(projectDir, "buglog.json"));
        if (buglog && Array.isArray(buglog.bugs) && buglog.bugs.length === 0) {
          process.stderr.write("📋 OpenWolf: buglog.json is empty. Bugs will be auto-logged when detected.\n");
        }
```

Replace with:

```javascript
        // Buglog emptiness check — stored in sessionNags, surfaced via wolf_status
        const buglog = readJson(wolfPath(projectDir, "buglog.json"));
        if (buglog && Array.isArray(buglog.bugs) && buglog.bugs.length === 0) {
          sessionMeta.sessionNags.buglogIsEmpty = true;
        }
```

- [ ] **Step 3: Verify syntax and stderr count**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -c "process.stderr.write" .opencode/plugins/openwolf-plugin.js`
Expected: `10` (was 13, removed 3)

- [ ] **Step 4: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): remove session.created stderr writes, store nags in sessionMeta"
```

---

## Task 4: Strip enrichment and stderr from pre-read hook

Remove all enrichment logic and stderr writes from the `tool.execute.before` read handler. This logic moves to the `tool.execute.after` handler in Task 5. The before-hook for reads becomes a no-op.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1195-1252` (the `if (toolName === "read")` block inside `tool.execute.before`)

- [ ] **Step 1: Replace the entire pre-read block**

Find the block starting at the comment `// --- Pre-Read: anatomy + graphify enrichment ---` and ending at the closing `}` before `// --- Pre-Write/Edit: cerebrum + buglog ---`. This is approximately lines 1195-1252.

Replace the entire `if (toolName === "read") { ... }` block with:

```javascript
      // --- Pre-Read: no-op (enrichment moved to tool.execute.after) ---
      if (toolName === "read") {
        return;
      }
```

This removes:
- The repeated-read stderr warning (was line 1207)
- The anatomy lookup stderr write (was line 1217)
- The anatomyHits/anatomyMisses counting (moved to after-hook in Task 5)
- The graphify enrichment stderr writes (were lines 1233, 1249)
- The `return` on repeated read that skipped further processing

- [ ] **Step 2: Verify syntax and stderr count**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -c "process.stderr.write" .opencode/plugins/openwolf-plugin.js`
Expected: `6` (was 10, removed 4: repeated-read, anatomy, graphify-nodes, graphify-related)

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): strip enrichment and stderr from pre-read hook"
```

---

## Task 5: Convert post-read enrichment to trailing delimited block

Rework the `tool.execute.after` read handler: strip emoji from enrichment part builders, change the leading-prefix prepend to a trailing `---`-delimited append, add repeated-read advisory, and add anatomyHits/anatomyMisses counting (moved from the before-hook).

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1326-1384` (the `if (input.tool === "read")` block inside `tool.execute.after`)

- [ ] **Step 1: Add count increment to readHistory update block**

The before-hook (now a no-op after Task 4) previously incremented `readHistory.count` and `sessionMeta.repeatedWarned` on repeated reads. This logic must move to the after-hook.

Find this block (approximately lines 1341-1345):

```javascript
        if (readHistory.has(normalizedFile)) {
          readHistory.get(normalizedFile).tokens = tokens;
        } else {
          readHistory.set(normalizedFile, { count: 1, tokens, firstRead: new Date().toISOString() });
        }
```

Replace with:

```javascript
        if (readHistory.has(normalizedFile)) {
          const info = readHistory.get(normalizedFile);
          info.count++;
          info.tokens = tokens;
          sessionMeta.repeatedWarned++;
        } else {
          readHistory.set(normalizedFile, { count: 1, tokens, firstRead: new Date().toISOString() });
        }
```

This adds the `info.count++` increment and `sessionMeta.repeatedWarned++` tracking that was previously in the before-hook. The session file update block immediately below (lines 1346-1353) reads `info.count` from `readHistory`, so it will now see the correct incremented count.

- [ ] **Step 2: Replace the post-read enrichment section**

Find the section inside `tool.execute.after` that starts after the readHistory/session-file update and builds `enrichParts`. This is approximately lines 1355-1383:

```javascript
        const enrichParts = [];
        for (const [, entries] of anatomyCache.entries()) {
          const entry = entries.find(e => normalizedFile.endsWith(normalizePath(e.file)));
          if (entry) { enrichParts.push("📋 " + entry.file + ": " + entry.description + " (~" + entry.tokens + " tok)"); break; }
        }
        const relPath = normalizePath(relative(worktreeDir, filePath));
        const graphNodes = graphifyByFile.get(relPath) || graphifyByFile.get(normalizedFile) || [];
        if (graphNodes.length > 0) {
          const relatedIds = new Set();
          for (const link of graphifyLinks) {
            for (const n of graphNodes.slice(0, 3)) {
              if (link.source === n.id) relatedIds.add(link.target);
              if (link.target === n.id) relatedIds.add(link.source);
            }
          }
          if (relatedIds.size > 0) {
            const related = [...relatedIds].slice(0, 5).map(id => {
              for (const nodes of graphifyNodes.values()) {
                const found = nodes.find(n => n.id === id);
                if (found) return found.label;
              }
              return id;
            });
            enrichParts.push("🕸️ Related: " + related.join(", "));
          }
        }
        if (enrichParts.length > 0) {
          output.output = "[OpenWolf] " + enrichParts.join(" | ") + "\n\n" + (output.output || "");
        }
```

Replace with:

```javascript
        // Build trailing enrichment block (anatomy + graphify + repeated-read)
        const enrichParts = [];

        // Anatomy lookup (moved from before-hook)
        let anatomyFound = false;
        for (const [, entries] of anatomyCache.entries()) {
          const entry = entries.find(e => normalizedFile.endsWith(normalizePath(e.file)));
          if (entry) {
            enrichParts.push(entry.file + ": " + entry.description + " (~" + entry.tokens + " tok)");
            anatomyFound = true;
            break;
          }
        }
        if (anatomyFound) sessionMeta.anatomyHits++;
        else sessionMeta.anatomyMisses++;

        // Repeated-read advisory
        const readInfo = readHistory.get(normalizedFile);
        if (readInfo && readInfo.count > 1) {
          enrichParts.push("already read (count: " + readInfo.count + ", ~" + readInfo.tokens + " tokens)");
        }

        // Graphify enrichment
        const relPath = normalizePath(relative(worktreeDir, filePath));
        const graphNodes = graphifyByFile.get(relPath) || graphifyByFile.get(normalizedFile) || [];
        if (graphNodes.length > 0) {
          const relatedIds = new Set();
          for (const link of graphifyLinks) {
            for (const n of graphNodes.slice(0, 3)) {
              if (link.source === n.id) relatedIds.add(link.target);
              if (link.target === n.id) relatedIds.add(link.source);
            }
          }
          if (relatedIds.size > 0) {
            const related = [...relatedIds].slice(0, 5).map(id => {
              for (const nodes of graphifyNodes.values()) {
                const found = nodes.find(n => n.id === id);
                if (found) return found.label;
              }
              return id;
            });
            enrichParts.push("Related: " + related.join(", "));
          }
        }

        // Append trailing block only if enrichment exists
        if (enrichParts.length > 0) {
          output.output = (output.output || "") + "\n\n---\nOpenWolf: " + enrichParts.join(" | ") + "\n";
        }
```

Note the three changes from the original:
1. `"📋 " + entry.file` → `entry.file` (emoji stripped)
2. `"🕸️ Related: "` → `"Related: "` (emoji stripped)
3. Leading prepend `"[OpenWolf] " + ... + "\n\n" + output.output` → trailing append `output.output + "\n\n---\nOpenWolf: " + ...`

Also added: anatomyHits/anatomyMisses counting (moved from before-hook) and repeated-read advisory.

- [ ] **Step 3: Verify syntax and check for remaining leading-prefix prepends**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -n 'output.output = "\[OpenWolf\]' .opencode/plugins/openwolf-plugin.js`
Expected: No output (zero matches — the leading-prefix prepend is gone).

Run: `grep -n 'output.output = (output.output' .opencode/plugins/openwolf-plugin.js`
Expected: One match at the trailing-append line (confirms the new pattern exists).

- [ ] **Step 4: Verify no emoji remains in enrichment builders**

Run: `grep -n "📋\|🕸️" .opencode/plugins/openwolf-plugin.js`
Expected: No output (zero matches).

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): convert read enrichment from leading prefix to trailing delimited block"
```

---

## Task 6: Rework pre-write hook to record warnings instead of emitting

Replace the two `process.stderr.write()` call groups in the `tool.execute.before` write/edit handler with pushes to `sessionMeta.recordedCerebrumWarnings` and `sessionMeta.recordedBuglogMatches`.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1263-1322` (cerebrum check + buglog search inside `tool.execute.before` write/edit)

- [ ] **Step 1: Replace the cerebrum warning stderr write (line 1287)**

Find this line inside the cerebrum pattern-matching loop:

```javascript
                    process.stderr.write("⚠️ OpenWolf cerebrum warning: \"" + trimmed.slice(0, 120) + "\" — check your code.\n");
                    sessionMeta.cerebrumWarnings++;
```

Replace with:

```javascript
                    sessionMeta.recordedCerebrumWarnings.push({
                      pattern: trimmed.slice(0, 120),
                      file: fileBase,
                      timestamp: new Date().toISOString(),
                    });
                    sessionMeta.cerebrumWarnings++;
```

- [ ] **Step 2: Replace the buglog FYI stderr block (lines 1314-1321)**

Find this block:

```javascript
          if (matched.length > 0) {
            process.stderr.write("📋 OpenWolf buglog: " + matched.length + " past bug(s) for " + fileBase + ":\n");
            for (const bug of matched) {
              process.stderr.write("   [" + bug.id + "] \"" + (bug.error_message || "").slice(0, 70) + "\"\n");
              process.stderr.write("   Cause: " + (bug.root_cause || "").slice(0, 80) + "\n");
              process.stderr.write("   Fix: " + (bug.fix || "").slice(0, 80) + "\n");
            }
          }
```

Replace with:

```javascript
          if (matched.length > 0) {
            sessionMeta.recordedBuglogMatches.push({
              bugIds: matched.map(b => b.id),
              file: fileBase,
              timestamp: new Date().toISOString(),
            });
          }
```

This removes 5 stderr writes (the header line + 3 continuation lines per bug, though only the first bug's 3 lines were static; the loop wrote 3 lines per matched bug). The match data is now stored in session state and queryable via `wolf_search`.

- [ ] **Step 3: Verify syntax and stderr count**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -c "process.stderr.write" .opencode/plugins/openwolf-plugin.js`
Expected: `1` (was 6, removed 5: 1 cerebrum + 4 buglog stderr calls)

- [ ] **Step 4: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): record pre-write cerebrum/buglog warnings in session state"
```

---

## Task 7: Remove post-write repeated-edit stderr write

Remove the last remaining `process.stderr.write()` call from the `tool.execute.after` write/edit handler.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1403-1406` (repeated-edit warning)

- [ ] **Step 1: Remove the repeated-edit stderr write**

Find this block:

```javascript
        // Repeated-edit warning
        if (session.edit_counts[relPath] >= REPEATED_EDIT_THRESHOLD) {
          process.stderr.write("⚠️ OpenWolf: " + fileBase + " edited " + session.edit_counts[relPath] + " times. Log bugs to .wolf/buglog.json.\n");
        }
```

Replace with:

```javascript
        // Repeated-edit tracking — state already in session.edit_counts, queryable via wolf_status
```

The edit counts are already tracked in `session.edit_counts` and persisted to `_session.json`. The `wolf_status` tool already shows `Cerebrum warnings` count. No data is lost — only the stderr broadcast is removed.

- [ ] **Step 2: Verify zero stderr writes remain**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -c "process.stderr.write" .opencode/plugins/openwolf-plugin.js`
Expected: `0`

Run: `grep -c "process.stdout.write" .opencode/plugins/openwolf-plugin.js`
Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): remove last stderr write (repeated-edit warning)"
```

---

## Task 8: Reformat system prompt and compaction context

Strip any remaining emoji from the system prompt injection and compaction context. Add an advisory line telling the agent to query `wolf_search` before writing.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1483-1494` (`experimental.chat.system.transform`)
- Modify: `.opencode/plugins/openwolf-plugin.js:1497-1503` (`experimental.session.compacting`)

- [ ] **Step 1: Add advisory line to system prompt transform**

The system prompt transform (line 1483-1494) currently has no emoji (already clean). Add one advisory line after the existing `[OpenWolf]` push.

Find this line (approximately line 1486):

```javascript
      parts.push("[OpenWolf] Project intelligence active. " + anatomyCount + " files indexed. " + readHistory.size + " files read this session. Use wolf_status, wolf_search, wolf_graph tools.");
```

Replace with:

```javascript
      parts.push("[OpenWolf] Project intelligence active. " + anatomyCount + " files indexed. " + readHistory.size + " files read this session. Use wolf_status, wolf_search, wolf_graph tools.");
      parts.push("[OpenWolf] Before writing to files, query wolf_search (scope: buglog, cerebrum) for known issues.");
```

- [ ] **Step 2: Verify compaction context has no emoji**

The compaction context (lines 1497-1503) currently reads:

```javascript
      parts.push("[OpenWolf] " + readHistory.size + " files read, " + writeHistory.size + " written. Anatomy hits: " + sessionMeta.anatomyHits + ", misses: " + sessionMeta.anatomyMisses + ".");
```

This line has no emoji — it is already clean. No change needed. Leave it as-is.

- [ ] **Step 3: Verify syntax**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

- [ ] **Step 4: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): add pre-write advisory to system prompt"
```

---

## Task 9: Reformat wolf_status tool output

Remove the `🐺` emoji and `==================` ASCII underline from the `wolf_status` tool. Add Cerebrum, Buglog, and Recorded warnings sections that surface the deferred state from `sessionMeta.sessionNags` and the recorded warning arrays.

**Files:**
- Modify: `.opencode/plugins/openwolf-plugin.js:1510-1532` (wolf_status tool execute function)

- [ ] **Step 1: Replace the wolf_status execute function body**

Find the `wolf_status` tool's `execute` function (approximately lines 1510-1532):

```javascript
        execute: async (_args, ctx) => {
          const lines = [];
          lines.push("🐺 OpenWolf Status");
          lines.push("==================");
          lines.push("Session: " + sessionMeta.id);
          lines.push("Started: " + (sessionMeta.started || "not started"));
          lines.push("");
          const anatomyCount = [...anatomyCache.values()].reduce((sum, e) => sum + e.length, 0);
          lines.push("Anatomy: " + anatomyCount + " files indexed");
          lines.push("  Hits: " + sessionMeta.anatomyHits + ", Misses: " + sessionMeta.anatomyMisses);
          lines.push("");
          lines.push("Files read: " + readHistory.size);
          lines.push("Repeated-read warnings: " + sessionMeta.repeatedWarned);
          let totalReadTokens = 0;
          for (const info of readHistory.values()) totalReadTokens += info.tokens * info.count;
          lines.push("Estimated read tokens: ~" + totalReadTokens);
          lines.push("");
          lines.push("Files written: " + writeHistory.size);
          lines.push("Cerebrum warnings: " + sessionMeta.cerebrumWarnings);
          lines.push("");
          lines.push("Graphify: " + graphifyNodes.size + " symbols, " + graphifyLinks.length + " relationships");
          return { title: "OpenWolf Status", output: lines.join("\n") };
        },
```

Replace with:

```javascript
        execute: async (_args, ctx) => {
          const lines = [];
          lines.push("OpenWolf Status");
          lines.push("Session: " + sessionMeta.id);
          lines.push("Started: " + (sessionMeta.started || "not started"));
          lines.push("");
          const anatomyCount = [...anatomyCache.values()].reduce((sum, e) => sum + e.length, 0);
          lines.push("Anatomy: " + anatomyCount + " files indexed");
          lines.push("  Hits: " + sessionMeta.anatomyHits + ", Misses: " + sessionMeta.anatomyMisses);
          lines.push("");
          lines.push("Files read: " + readHistory.size);
          lines.push("Repeated-read warnings: " + sessionMeta.repeatedWarned);
          let totalReadTokens = 0;
          for (const info of readHistory.values()) totalReadTokens += info.tokens * info.count;
          lines.push("Estimated read tokens: ~" + totalReadTokens);
          lines.push("");
          lines.push("Files written: " + writeHistory.size);
          lines.push("Cerebrum warnings: " + sessionMeta.cerebrumWarnings);
          lines.push("");
          lines.push("Graphify: " + graphifyNodes.size + " symbols, " + graphifyLinks.length + " relationships");
          lines.push("");
          // Cerebrum section
          lines.push("Cerebrum:");
          if (sessionMeta.sessionNags.cerebrumEntryCount !== null) {
            lines.push("  Entries: " + sessionMeta.sessionNags.cerebrumEntryCount);
          }
          if (sessionMeta.sessionNags.cerebrumDaysSinceUpdate !== null) {
            lines.push("  Days since update: " + sessionMeta.sessionNags.cerebrumDaysSinceUpdate);
          }
          if (sessionMeta.sessionNags.cerebrumHoursSinceUpdate !== null) {
            lines.push("  Hours since update: " + sessionMeta.sessionNags.cerebrumHoursSinceUpdate);
          }
          lines.push("");
          // Buglog section
          lines.push("Buglog:");
          const bl = readJson(wolfPath(projectDir, "buglog.json"));
          if (bl && Array.isArray(bl.bugs)) {
            lines.push("  Total bugs: " + bl.bugs.length);
          } else {
            lines.push("  Total bugs: 0");
          }
          if (sessionMeta.sessionNags.buglogIsEmpty) {
            lines.push("  Status: empty (bugs will be auto-logged when detected)");
          }
          if (sessionMeta.sessionNags.multiEditFiles.length > 0) {
            lines.push("  Multi-edit files missing buglog update: " + sessionMeta.sessionNags.multiEditFiles.join(", "));
          }
          lines.push("");
          // Recorded warnings section
          lines.push("Recorded warnings:");
          lines.push("  Cerebrum matches this session: " + sessionMeta.recordedCerebrumWarnings.length);
          lines.push("  Buglog matches this session: " + sessionMeta.recordedBuglogMatches.length);
          if (sessionMeta.recordedCerebrumWarnings.length > 0 || sessionMeta.recordedBuglogMatches.length > 0) {
            lines.push("  Use wolf_search for details.");
          }
          return { title: "OpenWolf Status", output: lines.join("\n") };
        },
```

Changes from original:
1. Removed `"🐺 OpenWolf Status"` → `"OpenWolf Status"` (no emoji)
2. Removed `"=================="` line entirely
3. Added Cerebrum section (entry count, days/hours since update from `sessionNags`)
4. Added Buglog section (total count, empty status, multi-edit-file nag from `sessionNags`)
5. Added Recorded warnings section (cerebrum/buglog match counts from recorded arrays)

- [ ] **Step 2: Verify syntax and no emoji**

Run: `node --check .opencode/plugins/openwolf-plugin.js`
Expected: No output (exit code 0).

Run: `grep -n "🐺\|===" .opencode/plugins/openwolf-plugin.js`
Expected: No output (zero emoji wolf, zero ASCII underline).

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/openwolf-plugin.js
git commit -m "refactor(plugin): reformat wolf_status output, add cerebrum/buglog/recorded-warnings sections"
```

---

## Task 10: Fix graphify.js branding

Change `[graphify]` to `[Graphify]` (capital G) in the bash echo injection for brand consistency with the system prompt's `[Graphify]` prefix.

**Files:**
- Modify: `.opencode/plugins/graphify.js:16`

- [ ] **Step 1: Fix the casing**

Find this line in `.opencode/plugins/graphify.js` (line 16):

```javascript
          'echo "[graphify] knowledge graph at graphify-out/. For focused questions, run `graphify query \"<question>\"` (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context." && ' +
```

Replace `"[graphify]` with `"[Graphify]`:

```javascript
          'echo "[Graphify] knowledge graph at graphify-out/. For focused questions, run `graphify query \"<question>\"` (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context." && ' +
```

- [ ] **Step 2: Verify the fix**

Run: `grep -n '\[graphify\]' .opencode/plugins/graphify.js`
Expected: No output (zero lowercase matches).

Run: `grep -n '\[Graphify\]' .opencode/plugins/graphify.js`
Expected: One match at line 16.

- [ ] **Step 3: Commit**

```bash
git add .opencode/plugins/graphify.js
git commit -m "fix(graphify): capitalize [Graphify] prefix for brand consistency"
```

---

## Task 11: Final verification

Run the complete verification suite defined in the spec's scenarios. All checks must pass.

**Files:** None modified — verification only.

- [ ] **Step 1: Confirm zero stderr/stdout writes in plugin**

Run: `grep -c "process.stderr.write\|process.stdout.write" .opencode/plugins/openwolf-plugin.js`
Expected: `0`

- [ ] **Step 2: Confirm zero emoji in plugin**

Run: `grep -cP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2190}-\x{21FF}]" .opencode/plugins/openwolf-plugin.js`
Expected: `0`

If the above grep doesn't work on your system (macOS grep), use this alternative:

Run: `grep -c "⚠️\|💡\|📋\|⚡\|🕸️\|🐺" .opencode/plugins/openwolf-plugin.js`
Expected: `0`

- [ ] **Step 3: Confirm no leading-prefix output mutation**

Run: `grep -n 'output.output = "\[OpenWolf\]' .opencode/plugins/openwolf-plugin.js`
Expected: No output (zero matches).

- [ ] **Step 4: Confirm trailing-append pattern exists**

Run: `grep -n '---\\nOpenWolf:' .opencode/plugins/openwolf-plugin.js`
Expected: One match (the trailing enrichment append).

- [ ] **Step 5: Confirm graphify.js uses capital G**

Run: `grep -c '\[graphify\]' .opencode/plugins/graphify.js`
Expected: `0`

Run: `grep -c '\[Graphify\]' .opencode/plugins/graphify.js`
Expected: `1`

- [ ] **Step 6: Syntax validation**

Run: `node --check .opencode/plugins/openwolf-plugin.js && node --check .opencode/plugins/graphify.js && echo "OK"`
Expected: `OK`

- [ ] **Step 7: Manual runtime verification**

Start OpenCode with the plugin loaded and verify:

1. **Read a file** that has an anatomy entry (e.g., any file in `src/`). Confirm:
   - The tool output starts with file content (not `[OpenWolf]`)
   - Any enrichment appears after a `---` delimiter at the end
   - No floating stderr lines appear in the TUI

2. **Read the same file again.** Confirm:
   - The trailing block includes `already read (count: 2, ~N tokens)`
   - No `⚡` stderr warning appears

3. **Invoke `wolf_status` tool.** Confirm:
   - Title shows `OpenWolf Status` (no `🐺`)
   - No `==================` ASCII underline
   - Cerebrum section appears with entry count
   - Buglog section appears with total count
   - Recorded warnings section appears with zero counts (no warnings triggered yet)

4. **Write/edit a file** that triggers a cerebrum match. Confirm:
   - No stderr noise appears in the TUI
   - Then invoke `wolf_status` — the Recorded warnings section shows cerebrum matches > 0

5. **Run a bash command.** Confirm:
   - The graphify echo shows `[Graphify]` (capital G)

- [ ] **Step 8: Update OpenSpec tasks checklist**

Mark all tasks in `openspec/changes/fix-plugin-message-convention/tasks.md` as complete by changing `- [ ]` to `- [x]` for all items.

Run:
```bash
sed -i '' 's/- \[ \]/- [x]/g' openspec/changes/fix-plugin-message-convention/tasks.md
```

- [ ] **Step 9: Final commit**

```bash
git add openspec/changes/fix-plugin-message-convention/tasks.md
git commit -m "docs(openspec): mark fix-plugin-message-convention tasks complete"
```

---

## Summary

| Task | What changes | stderr removed | Emoji removed |
|------|-------------|----------------|---------------|
| 1 | Add sessionMeta fields | 0 | 0 |
| 2 | stopSession + graphifyUpdate | 3 | 3 |
| 3 | session.created handler | 3 | 3 |
| 4 | Pre-read hook stripped | 4 | 4 |
| 5 | Post-read trailing block | 0 | 2 |
| 6 | Pre-write records warnings | 5 | 2 |
| 7 | Post-write edit tracking | 1 | 1 |
| 8 | System prompt advisory | 0 | 0 |
| 9 | wolf_status reformat | 0 | 2 |
| 10 | graphify.js casing | 0 | 0 |
| 11 | Verification | 0 | 0 |
| **Total** | | **16** | **17** |

All 16 `process.stderr.write()` calls eliminated. All emoji stripped. Leading-prefix mutation converted to trailing delimited block. Pre-write warnings moved to pull-based session state. Data collection unchanged.
