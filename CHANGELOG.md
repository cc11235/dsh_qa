# Changelog

## Unreleased

### 中文

#### 新增

- 同类静音：自动捕获的缺陷可静音同类 30 天，命中只计数、不新建缺陷，到期自动恢复；致命缺陷不可静音；顶部「静音规则」可查看与解除。
- 延迟关闭（策略 B）：模型 `verified:true` 先进入「待验证」，24 小时无人工操作后自动关闭；致命缺陷需人工确认；期间任何人工操作都会取消计时。
- 状态撤销：详情页可撤销上次状态变更，撤销记录写入状态历史。
- 待办摘要：`qa_list_bugs` 返回未分诊、待验证、自动关闭、致命、超期和停滞摘要，推动模型主动处理。
- 批量删除：只允许「已忽略 / 重复」，删除前自动备份，并在追踪动态记录一条汇总。
- 清理入口：顶部「清理」按项目清理已忽略超过 30 天或重复项；已关闭缺陷保留，用于趋势与回归判断。

#### 改进

- 追踪动态显示操作者，并支持按模型 / 人工 / 规则筛选。
- 模型验证通过不再直接关闭，关闭前保留人工观测窗口。
- 自动关闭在下次加载或每 5 分钟巡检时执行，并写入「自动关闭」证据。
- 单条删除、批量删除和清理都会先生成数据备份，并清理合并关系中的悬空引用。

#### 验证

- `npm test`：212 个测试通过。

### English

#### Added

- Signature muting: mute matching automatic failures for 30 days; hits are counted instead of creating defects, and capture resumes at expiry. Blockers cannot be muted; the rule dialog lists and removes rules.
- Quiet close (policy B): model `verified:true` enters `Verify` and closes after 24 hours without human action; blockers wait for human confirmation, and any human action cancels the timer.
- Status undo in the defect drawer, recorded in the history.
- Pending summary in `qa_list_bugs` covering untriaged, pending verification, scheduled closes, blockers, overdue and stalled defects.
- Bulk delete for ignored and duplicate defects, with an automatic backup and one summary activity entry.
- Cleanup dialog for ignored defects older than 30 days and duplicates, scoped to the current project; closed defects stay.

#### Changed

- The activity feed shows the actor and filters by model / human / rule.
- Model verification no longer closes immediately; a human observation window is preserved.
- Auto-close runs on load or the 5-minute sweep and records `auto-close` evidence.
- Single delete, bulk delete and cleanup back up the data file first and prune dangling merge links.

#### Verification

- `npm test`: 212 tests passed.

## 0.2.2 - 2026-11-27

### 中文

- 负责人优先使用已登录的 DSH 账号显示名，未登录、读取失败或超时回退系统用户名。
- 当前用户账号解析增加超时保护，避免账号服务拖慢插件激活。
- 历史数据中的旧系统用户名会迁移为 DSH 账号名；为空时继续按来源补齐。
- 保留 `currentUser` 强制覆盖和显式负责人优先。

### English

- Prefer the signed-in DSH account display name for the current user, falling back to the OS username when signed out, failed or timed out.
- Add a timeout to account-name resolution so the account service cannot delay plugin activation.
- Migrate legacy system-name assignees to the DSH account name; empty assignees remain filled by source.
- Keep the `currentUser` override and explicit-assignee precedence.

## 0.2.1 - 2026-11-27

### 中文

- 负责人默认规则：`auto` / `agent` 来源为 `bot`，`user` / `manual` 来源为当前用户账号。
- 当前用户账号默认取操作系统用户名，可用 `currentUser` 配置覆盖。
- 启动时为历史空负责人按来源补齐；合并重复项时主缺陷为空则继承重复项负责人。
- 面板状态返回 `currentUser`，负责人标签将 `bot` 显示为「机器人」。

### English

- Default assignees: `auto`/`agent` sources use `bot`; `user`/`manual` sources use the current user account.
- The current user account defaults to the OS username and can be overridden with `currentUser`.
- Empty historical assignees are filled by source at startup; merging lets an empty master inherit the duplicate’s assignee.
- Panel state exposes `currentUser`, and the `bot` assignee renders as “机器人”.

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