# QA Guardian

English | [中文](README.md)

QA Guardian captures defects produced during coding sessions in DeepSeek Harness (DSH) and turns them into a traceable QA board. The plugin runs locally by default and does not call an additional model or use the network.

It tracks newly discovered bugs, bugs being fixed, fixes awaiting regression, and regressions that reappear after a fix. Besides tool/build signals, it captures defects reported directly by the user and can backfill historical sessions. The board uses SSE for live updates.

## What it covers

- **Automatic capture**: failed builds, tests, type checks and runtime commands enter `Pending`; observed user-reported defects enter `Open`.
- **Defect vs. requirement**: user messages are classified first. Only observed defects enter the board; feature requests, design changes and questions are skipped with `kind:"feature"` or `kind:"question"`.
- **Mixed messages**: a message containing both a bug and a requirement can be split with `items[]`; only bug items are recorded.
- **Git commit evidence**: `fix(scope): ...` commits are parsed and linked to matching defects.
- **Verification loop**: record the verification command, output summary and outcome; pass closes, fail returns to progress, cannot-reproduce is terminal.
- **Duplicate merging**: merge duplicates into a master while preserving records, evidence, notes and occurrence counts.
- **Owner, priority and versions**: edit, filter and display owner, priority, due date, found/fix version and tags.
- **Saved views**: keep project/status/severity/source/module/priority/owner/search filters in local browser storage.
- **Export, import and backup**: JSON/CSV/Markdown export, JSON import with automatic backup, and seven retained backup copies.
- **Historical backfill**: user reports from earlier sessions can be replayed through `qa_backfill_sessions`.
- **Not recorded**: DSH tool-call failures (`Unknown tool`, invalid arguments, sandbox or approval denials, cancellations), arbitrary command failures without a project source location, environment problems, and requirement changes.
- **Status updates**: a failed command that succeeds on rerun moves to `Verify`; a recurring defect is reopened.
- **Live views**: board, list and calendar receive changes over SSE, with a 15-second polling fallback.
- **QA board**: Pending → Open → In progress → Verify. Closed defects leave the board; use the “closed N” link to open them in the list.
- **Defect list**: filter by project, severity, status, module and keyword; inspect evidence, history and notes.
- **Calendar**: monthly view of new, fixed and changed defects, with per-day details.
- **Bulk actions**: select one, many or all visible defects and close, ignore or mark them for verification.
- **Activity feed**: creation, status changes, evidence and notes in chronological order.
- **Agent tools**: six core tools that accept `id / title / query / latest`.
- **Manual fallback**: create, edit, annotate, delete or ignore defects that were captured incorrectly.

## Opening the panel

After installation and activation, the sidebar shows **QA 缺陷追踪**. Clicking it opens the native panel in the main area. The title bar shows a live indicator; the panel falls back to 15-second polling when SSE is unavailable. The **说明** button documents the Agent tools, source/fix labels and automatic rules.

## Automatic capture and linking

Only DSH session events are read; no extra model request is made.

| Signal | Result |
| --- | --- |
| A project check (`npm test`, `pnpm build`, `tsc`, `pytest`, `go test`, `dotnet build`, lint, etc.) exits non-zero with a real error/test failure | Create or merge a defect in `Pending` |
| A project runtime command (`node`, `python`, `go run`, `npm run dev`, etc.) throws with a stack pointing into project source | Create a defect in `Pending` |
| The same workspace and error signature appear again | Increment occurrence; reopen a closed or verified defect |
| A failed check/runtime command succeeds on rerun | Move the matching defect to `Verify` |
| A user message describes a real symptom such as “did not start”, “no response”, “cannot”, “error”, “wrong value”, “data is 0”, “includes another tenant”, “redirects to localhost” | Record a user report in `Open`; merge similar reports in the same session |
| The user says “fixed”, “works now”, “resolved” | Close the most recent active defect in that session |
| A `git commit` subject matching `fix(scope): ...` links to an existing defect | Attach Git commit evidence and move it to `Verify` |
| Assistant text contains an explicit bug/fix statement (requires `captureAssistant`) | Extract a candidate or advance status; disabled by default |

Assistant-text extraction is disabled by default to avoid treating requirement lists, status legends and design notes as defects. Status is maintained primarily through `qa_begin_fix` and `qa_mark_fixed`.

Failures of read-only tools (file reads, search, web search) are ignored. `Unknown tool`, invalid arguments, sandbox/approval denials, cancellations, `Missing script`, missing commands and command failures without a project source location are also ignored. Per-message and per-turn creation limits prevent flooding.

## Git commits

The plugin observes `git commit` calls in the current session and parses both the command arguments and the command output:

```bash
git commit -m "fix(viewer): keep closed defects out of the board"
```

```text
[main 29fcc98] fix(viewer): keep closed defects out of the board
```

It extracts the conventional type (`fix`, `bugfix`, `hotfix`), scope, SHA, subject and full message.

Linking order:

1. A `BUG-0025` reference in the commit message links by id.
2. Otherwise the workspace and title similarity (≥ 0.4) are used.
3. A scope matching the defect module adds weight.

On a match, the plugin:

- writes a `Git commit` evidence entry (SHA, subject, message);
- moves `Pending`, `Open` or `In progress` to `Verify`;
- does not close the defect automatically; tests or user confirmation are still required.

No defect is created when no match is found, so `chore`, refactor and documentation commits do not pollute the board.

A model can also pass a commit explicitly:

```json
{
  "id": "BUG-0025",
  "verified": true,
  "commit": "29fcc98 fix(viewer): keep closed defects out of the board",
  "note": "Four-column board; closed defects moved to the list"
}
```

`qa_mark_fixed` and `qa_capture.fixed[]` both accept `commit`.

## Verification and merging

- The drawer records a verification command, output summary and outcome:
  - pass → Closed
  - fail → In progress
  - cannot reproduce → Cannot reproduce (terminal)
- Results are stored as `Verification` evidence and in status history.
- Duplicate defects can be merged into a master. The duplicate becomes `Duplicate`; its record, evidence, notes and occurrence count remain available.
- Owner, priority, due date, found/fix version and tags are editable in the drawer and available as filters.

## Export and import

- Export JSON, CSV or Markdown from the header.
- Import a JSON export; the current data is backed up before replacement.
- Keep the latest seven `data.backup-*.json` files beside the data file.
- Saved views live in browser localStorage and are not written to the data file.

## Status

`Pending → Open → In progress → Verify → Closed`, plus `Cannot reproduce`, `Duplicate` and `Ignored`. Every transition records time, actor and note.

- **User report**: enters `Open` directly; no manual confirmation.
- **Automatic capture**: tool/build candidates enter `Pending`.
- **Fix start**: `qa_begin_fix`, the first effective action or an actual file edit moves the defect to `In progress` with a **Robot fixing** label.
- **Fix complete**: `qa_mark_fixed`; a successful rerun or a matching Git fix commit can also move it to `Verify`.
- **Verified**: `qa_mark_fixed({verified:true})`, the drawer’s “verification passed” action or user confirmation closes the defect.
- **Cannot reproduce**: recording this outcome moves the defect to a terminal state.
- **Duplicate**: merging into a master keeps the original record with a duplicate link.
- **Fallback scope**: once a QA status tool has been called within 10 minutes, automatic transitions stop; set `autoStatusFallback:false` to leave status entirely to the model.

Severity values: Blocker, Critical, Major, Minor.

## Labels and filtering

Cards, list rows and the detail drawer show two labels:

- **Source**: `User report` / `DSH automatic` / `Agent report` / `Manual`.
- **Fix state**: `Unconfirmed` / `Open` / `In progress` / `Robot fixing` / `Verify` / `Closed` / `Ignored`.

The board can filter by source; the list can filter by status and module. Labels are derived from the stored defect, so they update after every transition.

## Modules

Each defect is linked to a functional module where possible:

- **Code path first**: tool errors, stacks, commands and edited files are normalized, e.g. `scripts/up.sh → Startup and deployment`, `backend/app/static/app.css → backend/app`, `viewer/templates/agents.html → viewer`.
- **User wording**: keyword rules map terms such as `search / filter → Log search`, `business detail / log volume → Statistics board`, `Grafana → Grafana integration`, `Prometheus → Prometheus metrics`, `up.sh / startup → Startup and deployment`.
- **Fix-location backfill**: files edited after a user report fill the module of the most recent unclassified defect.
- **Git scope**: a commit scope matching the module increases linking weight.
- **Manual correction**: edit the module in the drawer; the list can filter by it.

These rules are suggestions, not hard constraints. Unmatched defects show `Unclassified`.

## Agent tools

Only six core tools are registered to reduce selection ambiguity:

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `qa_from_user_report` | Classify and record user messages | `report` + `kind`, or `items:[{text,kind}]` |
| `qa_capture` | Batch findings and fixes for a turn | `found[]`, `fixed[]` (with optional `commit`) |
| `qa_begin_fix` | Start a fix and enter `Robot fixing` | `id / title / query / latest`, `module`, `note` |
| `qa_mark_fixed` | Finish a fix; `Verify` or `Closed` | same target fields, `verified`, `commit`, `note` |
| `qa_list_bugs` | Check duplicates and find ids | `status`, `severity`, `query`, `limit` |
| `qa_backfill_sessions` | Historical backfill | `workspace`, `days`, `limit`, `force` |

All status tools accept `id / title / query / latest`. When the id is unknown, pass a distinctive phrase from the user report as `query`. The tool returns the matched BUG id; reuse it in later calls. Single-item reports belong in `qa_capture.found`; non-standard status changes belong in `qa_begin_fix` / `qa_mark_fixed`.

## Agent preset

Installation adds the **Coding and defect tracking** preset (id `coding-qa`):

- Path: `preset/coding-qa/cordis.patch.yml`
- Copies the standard coding preset and appends a QA workflow persona: classify first, call `qa_begin_fix` before fixing, call `qa_mark_fixed` after fixing, and use `qa_capture` for multiple items.
- Listed in `dsh.bundle.patch` and registered as `include:preset-coding-qa`.

Select the preset for a new session. Existing sessions are not switched automatically; standard sessions are still covered by the plugin system prompt.

## Skill

The plugin includes the `qa-defect-tracking` skill:

- Workspace: `skills/qa-defect-tracking/SKILL.md`
- Installed: `~/.dsh/skills/qa-defect-tracking/SKILL.md`

It covers the tool-selection table, bug/feature/question classification, mixed-message examples, `id / title / query / latest` linking, status transitions, a checklist and anti-patterns. The skill follows Claude skill practice: the description states both purpose and trigger conditions, the body stays short, and tool schemas are not duplicated.

## Configuration

Override the `qa-guardian` row in the profile `cordis.patch.yml`:

```yaml
- id: qa-guardian
  config:
    autoCapture: true        # false: no automatic capture; manual/Agent records only
    captureAssistant: false  # default off; enabling extracts defects from assistant text
    maxBugsPerTurn: 6        # maximum new defects per turn
    autoStatusFallback: true # false: status changes only through model tools
    ignoreTools: []          # additional tool names to ignore
    backfillOnStart: true    # backfill recent sessions at most once every 6 hours
    backfillDays: 2          # backfill window
    dataDir: ""              # default ~/.dsh/qa-guardian
```

## Data and permissions

- Data file: `~/.dsh/qa-guardian/data.json` (atomic writes, preserved across restarts).
- Panel APIs: `/api/qa-guardian/state`, `/api/qa-guardian/action`, `/api/qa-guardian/events` (SSE) and `/api/qa-guardian/health`; loopback and same-origin requests only.
- The plugin does not read project file contents. It reads DSH session events (tool names, tool output, user/assistant text), the session workspace, and `git commit` calls/output in the current session. Historical backfill uses DSH `sessionQuery`.
- Disabling the plugin stops automatic capture but retains data; re-enabling resumes from new session events.

## Limitations

- Extraction is deterministic rather than semantic; `Pending` items need review, and false positives can be deleted or ignored.
- User-report extraction is conservative about requirements, design questions and configuration notes; very short or implicit reports may be missed. Use `qa_from_user_report` to add them.
- Assistant-text extraction is off by default; when enabled it can still misclassify plans or documentation.
- Backfill covers top-level sessions in the recent window and skips subagent and delegated-review sessions to avoid quoting review context.
- Git parsing covers conventional fix commits in the current session only. Historical `git log` is not scanned, and messages such as “fix login” require an explicit `commit` argument.
- Git commits are evidence, not verification; matching does not replace tests.
- Only DSH session signals are covered; external defect systems and Jira are not synchronized.
- Rerun matching uses tool name plus command text; changed command text requires a manual status update.
- The panel UI is currently Chinese; plugin metadata has Chinese and English titles/descriptions.

## Project layout

```
index.js                       Host: capture, store, Agent tools, HTTP API
lib/capture.js                 Session event capture
lib/extract.js                 Deterministic tool/assistant extraction
lib/git.js                     git commit parsing
lib/features.js                Module keyword rules
lib/user-report.js             User-report classification and splitting
lib/backfill.js                Historical backfill via sessionQuery
lib/store.js                   Store, dedupe, transitions, Git evidence
lib/constants.js               Status and severity vocabularies
client.js                      Browser: sidebar entry and native panel
preset/coding-qa/              Coding + QA agent preset
skills/qa-defect-tracking/     QA tracking skill
locale/*.json                  Plugin manager titles and descriptions
icon.svg                       Plugin icon
test/                          Unit and integration tests
```

## Related documents

- [Chinese README](README.md)
- [CHANGELOG](CHANGELOG.md)
- [LICENSE](LICENSE)

## Development

```bash
npm test
# or
node --test
```

Install from a local directory through **Plugin manager → Add plugin → Select this directory**, or use `plugin_manager` `install_bundle` in an authorized environment. After installing or updating a bundle that contains a preset, create a new session to see **Coding and defect tracking** in the preset selector.

## License

MIT License. See [LICENSE](LICENSE).