# Changelog

## Unreleased

## 0.2.0 - 2026-11-27

### 中文

#### 新增

- 验证闭环：记录验证命令、输出摘要和结果；验证通过关闭、验证未通过回到修复中、无法复现进入终态。
- 重复合并：把重复缺陷合并到主缺陷，保留原记录、证据、备注、出现次数和重复关系。
- 负责人、优先级、截止日期、发现/修复版本和标签，可编辑、筛选和展示。
- 本地保存筛选视图。
- JSON / CSV / Markdown 导出，JSON 导入前自动备份，保留最近 7 份备份。

#### 验证

- `npm test`：198 个单元/API 测试通过。
- 新增验证、合并、导入导出、备份和字段持久化测试。

### English

#### Added

- Verification loop with command/output summary and outcomes: pass closes, fail returns to progress, cannot-reproduce is terminal.
- Duplicate merging into a master defect while preserving records, evidence, notes, occurrence and duplicate links.
- Owner, priority, due date, found/fix version and tags, editable, filterable and visible on cards/lists.
- Locally saved filter views.
- JSON/CSV/Markdown export, JSON import with automatic backup and seven retained backup copies.

#### Verification

- `npm test`: 198 unit/API tests passed.
- Added verification, merge, export/import, backup and field persistence tests.

## 0.1.0 - 2026-11-27

### 中文

#### 新增

- 自动捕获构建、测试、类型检查、运行失败和用户反馈的实际缺陷。
- 用户消息分类：bug / feature / question；混合消息通过 `items[]` 拆分。
- 6 个 Agent 工具：`qa_from_user_report`、`qa_capture`、`qa_begin_fix`、`qa_mark_fixed`、`qa_list_bugs`、`qa_backfill_sessions`。
- 看板、缺陷列表、日历、追踪动态、批量解决 / 忽略 / 标记待验证。
- 已关闭缺陷从看板隐藏，可从「已关闭 N 条」进入列表查看。
- Git `fix(scope): ...` 提交解析、SHA/scope/message 提取和缺陷关联。
- 功能模块推断：代码路径、用户措辞、修复位置回填和 Git scope。
- 「编码与缺陷追踪」Agent 预设（`coding-qa`）。
- `qa-defect-tracking` skill，覆盖分类、拆分、关联、状态流转和反模式。

#### 改进

- 助手文本自动提取默认关闭，减少需求清单和状态图例误报。
- 自动「已修复」匹配要求相似度 ≥ 0.3，取消“最近一条”兜底，避免误关。
- 状态工具统一支持 `id / title / query / latest`；`qa_list_bugs` 支持关键词。
- 工具精简为 6 个核心入口，降低相似工具之间的选择歧义。
- 统一 LF 换行，增加 `.gitignore`、`npm test` 和完整 README。

#### 验证

- `npm test`：190 个单元/集成测试通过。
- `node --check`：`index.js`、`client.js`、`lib/*.js`、`test/*.js` 通过。
- `git diff --check`：通过。

### English

#### Added

- Automatic capture for failed builds, tests, type checks, runtime commands and user-reported defects.
- User-message classification into bug, feature or question, with `items[]` splitting for mixed messages.
- Six Agent tools: `qa_from_user_report`, `qa_capture`, `qa_begin_fix`, `qa_mark_fixed`, `qa_list_bugs` and `qa_backfill_sessions`.
- Kanban board, defect list, calendar, activity feed and bulk close/ignore/verify actions.
- Closed defects leave the board and remain available through the “closed N” list link.
- Git `fix(scope): ...` parsing with SHA/scope/message extraction and defect linking.
- Module inference from code paths, user wording, fix locations and Git scope.
- Optional `coding-qa` Agent preset.
- `qa-defect-tracking` skill covering classification, splitting, linking, status transitions and anti-patterns.

#### Changed

- Assistant-text extraction is disabled by default to reduce false positives from requirement lists and status legends.
- Automatic “fixed” matching requires similarity ≥ 0.3 and no longer falls back to the most recent defect.
- Status tools accept `id / title / query / latest`; `qa_list_bugs` supports keyword search.
- Tool surface reduced to six core entries to avoid selection ambiguity.
- Normalized line endings, added `.gitignore`, `npm test` and complete README files.

#### Verification

- `npm test`: 190 unit and integration tests passed.
- `node --check`: `index.js`, `client.js`, `lib/*.js` and `test/*.js` passed.
- `git diff --check`: passed.