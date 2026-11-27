# QA 缺陷追踪（QA Guardian）

[English](README_EN.md) | 中文

在 DeepSeek Harness 内捕获编码过程中产生的缺陷，并沉淀成可追踪的 QA 看板。插件默认本地运行，不额外调用模型、不联网。

用于追踪 DSH 编码时：新发现的 bug、正在修复的 bug、已修复待回归的 bug，以及修复后再次复现的回归问题。除工具/构建信号外，也会捕获用户在对话中直接报告的现象，并支持回填安装前的历史会话。看板通过 SSE 实时推送变更，无需手动刷新。

## 它解决什么

- **自动捕获**：项目构建 / 测试 / 类型检查 / 运行失败进入「待确认」；用户明确反馈的实际现象进入「待修复」。
- **区分缺陷与需求**：用户消息先分类；只有实际发生的缺陷进入看板，新增功能、交互调整、提问和需求变更用 `kind:"feature"` / `"question"` 明确跳过。
- **混合消息拆分**：一条消息同时包含 bug 和需求时，用 `items[]` 逐条分类，只把 bug 部分登记为缺陷。
- **Git 提交关联**：解析 `fix(scope): ...` 形式的提交，匹配已有缺陷后写入提交证据并推进到「待验证」。
- **验证闭环**：详情页记录验证命令、验证输出和结果；「验证通过」关闭缺陷，「验证未通过」回到修复中，「无法复现」进入终态。
- **重复合并**：把重复缺陷合并到主缺陷，保留原记录、证据、备注和出现次数；重复项标记为「重复」。
- **负责人与优先级**：负责人、优先级、截止日期、发现/修复版本、标签可编辑、筛选和批量处理。
- **保存视图**：把项目、状态、严重度、来源、模块、优先级、负责人和搜索词保存为本地视图。
- **导出、导入与备份**：支持 JSON / CSV / Markdown 导出、JSON 导入（导入前自动备份）；数据文件自动保留最近 7 份备份。
- **历史回填**：安装前已经发生的用户反馈，可扫描最近会话日志补录；也可用 `qa_backfill_sessions` 指定工作区和天数。
- **不记录**：DSH 工具调用自身的问题（`Unknown tool`、参数校验、权限/沙箱拒绝、取消、审批失败）、无源码位置的任意命令失败、纯环境问题、需求变更。
- **自动更新**：同一条失败命令重跑成功进入「待验证」；缺陷再次出现自动重新打开。
- **实时列表**：看板、列表和日历通过 SSE 订阅宿主变更，新捕获、状态流转、证据补充立即出现；连接中断时降级为 15 秒轮询。
- **QA 看板**：待确认 → 待修复 → 修复中 → 待验证，可拖动卡片流转；已关闭不再占看板列，从「已关闭 N 条」去列表查看。
- **缺陷列表**：按项目、严重度、状态、模块、关键词筛选，点击查看证据、状态历史和备注。
- **日历**：按月查看每天的新增、已修复和状态变化，点击日期查看当天动态。
- **批量处理**：看板和列表都支持单选、多选、全选当前筛选结果；一键解决、一键忽略、批量标记待验证。
- **追踪动态**：按时间记录新建、状态变更、证据补充、备注等全部动作。
- **Agent 工具**：6 个核心工具，支持 `id / title / query / latest`，让助手主动登记、开始修复和关闭缺陷。
- **人工兜底**：可新建、编辑、备注、删除误报；自动捕获的误报可直接忽略。

## 打开方式

安装并启用后，左侧边栏出现「QA 缺陷追踪」，点击即在主区域打开。看板通过 SSE 实时接收变更（标题栏右侧显示「实时」）；连接不可用时自动降级为 15 秒轮询。顶部「说明」按钮可查看全部 Agent 工具、来源/修复状态标签和自动兜底规则。

## 自动捕获与关联

只读取 DSH 会话事件，不额外请求模型：

| 信号 | 结果 |
| --- | --- |
| 项目检查命令（`npm test`、`pnpm build`、`tsc`、`pytest`、`go test`、`dotnet build`、lint 等）非零退出，且输出含真实错误/测试失败 | 新建或累加缺陷，状态「待确认」 |
| 项目运行命令（`node`、`python`、`go run`、`npm run dev` 等）抛出异常，且堆栈指向项目源码文件 | 新建缺陷，状态「待确认」 |
| 同一工作区、同一错误特征再次出现 | 出现次数 +1；已关闭或待验证则重新打开 |
| 失败的项目检查/运行命令重跑成功 | 对应缺陷进入「待验证」 |
| 用户消息中出现「没有启动 / 没反应 / 无法 / 报错 / 显示不对 / 数据是 0 / 包含其他业务 / 跳转 localhost」等 | 记录为「用户反馈」，状态「待修复」；同一会话内相似报告自动合并 |
| 用户说「好了 / 可以了 / 正常了 / 解决了」 | 关闭该会话最近一条未关闭缺陷 |
| `git commit` 的 `fix(scope): ...` 标题与已有缺陷匹配 | 记录 Git 提交证据，并推进到「待验证」 |
| 助手文本中出现明确的 bug/修复表述（需开启 `captureAssistant`） | 提取候选或推进状态；默认关闭 |

助手文本自动提取默认关闭，避免把需求清单、状态图例、设计说明误当缺陷；状态优先由模型调用 `qa_begin_fix` / `qa_mark_fixed` 维护。

只读类工具（文件读取、搜索、网页搜索等）的失败默认忽略；`Unknown tool`、参数错误、权限/沙箱拒绝、审批失败、取消、`Missing script`、命令不存在、无项目源码位置的任意命令失败也不会进看板。每条消息、每个回合都有创建上限，防止刷屏。

## Git 提交

插件监听当前会话里执行的 `git commit`，解析调用参数和输出中的提交信息：

```bash
git commit -m "fix(viewer): keep closed defects out of the board"
```

```text
[main 29fcc98] fix(viewer): keep closed defects out of the board
```

可解析出：

- 类型：`fix / bugfix / hotfix`
- scope：`viewer`
- SHA：`29fcc98`
- subject / 完整 message

匹配顺序：

1. 提交信息里出现 `BUG-0025` → 直接按编号关联
2. 否则按工作区 + 标题相似度（≥ 0.4）匹配
3. scope 与缺陷模块一致时加权

命中后：

- 写入 `Git 提交` 证据（SHA、标题、message）
- 状态从「待确认 / 待修复 / 修复中」推进到「待验证」
- 不会直接标「已修复」，仍需测试或用户确认

匹配不到时不会凭空创建缺陷，避免把 `chore`、重构、文档提交误当 bug。

模型也可以显式传递提交：

```json
{
  "id": "BUG-0025",
  "verified": true,
  "commit": "29fcc98 fix(viewer): keep closed defects out of the board",
  "note": "四列看板，已关闭移到列表"
}
```

`qa_mark_fixed` 和 `qa_capture.fixed[]` 都支持 `commit`。

## 验证与合并

- 详情页「验证与复现」记录验证命令、输出摘要和结果：
  - 验证通过 → 已关闭
  - 验证未通过 → 修复中
  - 无法复现 → 无法复现（终态）
- 验证结果写入证据（`验证记录`），并保留在状态历史中。
- 详情页「重复与合并」选择主缺陷后，把当前缺陷合并过去；重复项状态变为「重复」，原记录、证据、备注和出现次数保留。
- 负责人、优先级、截止日期、发现/修复版本、标签在编辑模式中维护，并可作为筛选条件。

## 导出与导入

- 顶部「导出」支持 JSON / CSV / Markdown。
- 「导入」读取 JSON 导出文件，导入前自动备份当前数据；导入为替换模式。
- 数据文件旁保留最近 7 份 `data.backup-*.json`。
- 保存视图使用浏览器 localStorage，不写入数据文件。

## 状态

`待确认 → 待修复 → 修复中 → 待验证 → 已关闭`，另有「无法复现」「重复」「已忽略」。所有状态变化都会写入状态历史，记录时间、操作者和备注。

- **用户反馈**：默认直接进入「待修复」，不需要人工确认。
- **自动捕获**：工具失败等候选先进入「待确认」，确认后再处理。
- **开始修复**：模型调用 `qa_begin_fix`，或第一次有效动作/实际编辑文件时自动兜底，进入「修复中」并显示 **机器人修复中**。
- **修复完成**：模型调用 `qa_mark_fixed`；重跑成功、匹配到的 Git 修复提交也可推进到「待验证」。
- **验证通过**：`qa_mark_fixed({verified:true})`、详情页「验证通过」或用户确认后进入「已关闭」。
- **无法复现**：详情页记录「无法复现」后进入终态，不再占用待验证队列。
- **重复**：合并到主缺陷后进入「重复」终态，保留原记录和跳转关系。
- **兜底范围**：模型 10 分钟内调用过 QA 状态工具时，不再自动推进；可设 `autoStatusFallback:false` 完全交给模型。

严重度：致命 / 严重 / 一般 / 轻微。

## 标签与筛选

每张卡片、列表行和详情页都会显示两个标签：

- **提出方式**：`用户提出` / `DSH 自动` / `Agent 上报` / `人工记录`
- **修复状态**：`未确认` / `未修复` / `修复中` / `机器人修复中` / `待验证` / `已修复` / `已忽略`

看板顶部可按提出方式筛选；缺陷列表可按修复状态和功能模块筛选。来源与状态来自缺陷记录本身，状态流转后标签同步更新。

## 功能模块

每条缺陷尽量关联一个功能模块，方便判断归属和筛选：

- **代码路径优先**：工具错误、堆栈、命令或修复编辑里的文件路径会归一成模块，例如 `scripts/up.sh → 启动与部署`、`backend/app/static/app.css → backend/app`、`viewer/templates/agents.html → viewer`。
- **用户措辞推断**：没有文件路径时，用功能词规则映射，例如 `检索 / 筛选 → 日志检索`、`业务明细 / 日志总量 → 统计看板`、`Grafana → Grafana 集成`、`Prometheus → Prometheus 指标`、`up.sh / 启动 → 启动与部署`。
- **修复位置回填**：用户报告后，DSH 实际编辑的文件会把模块补到最近一条未归类缺陷上。
- **Git scope 参考**：提交 scope 与模块一致时提高关联权重。
- **人工修正**：详情抽屉里可直接编辑「功能模块」；列表支持按模块筛选。

规则是启发式建议，不是强约束；判断不了时显示「未归类」。

## Agent 工具

只注册 6 个核心工具，避免模型在相似工具之间选错：

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `qa_from_user_report` | 用户消息分类与登记 | `report` + `kind`，或 `items:[{text,kind}]` |
| `qa_capture` | 一轮多条：新发现 + 已修复 | `found[]`、`fixed[]`（可带 `commit`） |
| `qa_begin_fix` | 开始修复，进入「机器人修复中」 | `id / title / query / latest`、`module`、`note` |
| `qa_mark_fixed` | 修复完成，待验证 / 已修复 | 同一套定位参数、`verified`、`commit`、`note` |
| `qa_list_bugs` | 查重、找编号 | `status`、`severity`、`query`、`limit` |
| `qa_backfill_sessions` | 历史回填 | `workspace`、`days`、`limit`、`force` |

- 所有状态工具支持 `id / title / query / latest`；不知道编号时用用户原话中有区分度的短句作 `query`。
- 工具返回实际匹配到的 BUG 编号，后续调用直接复用。
- 单条上报合并进 `qa_capture.found`；状态调整由 `qa_begin_fix` / `qa_mark_fixed` 覆盖；统计直接看看板或列表。

## Agent 预设

安装后新增预设 **「编码与缺陷追踪」**（id `coding-qa`）：

- 路径：`preset/coding-qa/cordis.patch.yml`
- 复制标准编码预设的全部工具
- persona 中追加 QA 工作流：先分类、开始修调 `qa_begin_fix`、修完调 `qa_mark_fixed`、一轮多条用 `qa_capture`
- 已加入 `dsh.bundle.patch`，重新安装后注册为 `include:preset-coding-qa`

用法：新建会话时在 Agent 预设里选择「编码与缺陷追踪」。现有会话不会自动切换；标准模式仍受插件系统提示约束。

## Skill

附带 `qa-defect-tracking` skill：

- 工作区：`skills/qa-defect-tracking/SKILL.md`
- 安装后：`~/.dsh/skills/qa-defect-tracking/SKILL.md`

内容包括：工具选择表、bug/feature/question 分类规则、混合消息示例、`id / title / query / latest` 关联优先级、状态流转、检查清单和反模式。按 Claude skill 实践编写：description 同时说明用途与触发场景，正文保持短小，不重复工具 schema。

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id `qa-guardian` 覆盖：

```yaml
- id: qa-guardian
  config:
    autoCapture: true        # 关闭后不再自动捕获，仅保留人工/Agent 记录
    captureAssistant: false  # 默认关闭；开启后额外从助手文本提取缺陷，误报会增多
    maxBugsPerTurn: 6        # 每回合最多新建条数
    autoStatusFallback: true # false = 状态只由模型调用工具决定，规则不再自动推进
    ignoreTools: []          # 追加要忽略的工具名
    backfillOnStart: true    # 启用后自动回填最近会话（每 6 小时最多一次）
    backfillDays: 2          # 回填窗口
    dataDir: ""              # 默认 ~/.dsh/qa-guardian
```

## 数据与权限

- 数据文件：`~/.dsh/qa-guardian/data.json`（原子写入，重启保留）。
- 面板 API：`/api/qa-guardian/state`、`/api/qa-guardian/action`、`/api/qa-guardian/events`（SSE）、`/api/qa-guardian/health`，仅接受本机回环请求与同源页面。
- 插件不读取项目文件内容，只读取 DSH 会话事件（工具名、工具输出、用户/助手文本）、会话工作目录和当前会话里的 `git commit` 调用/输出；历史回填通过 DSH 的 `sessionQuery` 读取已持久化的会话日志。
- 关闭插件后自动捕获停止，历史数据仍保留；重新启用后继续读取新会话事件。

## 局限

- 自动提取基于确定性规则，不做语义模型判断；「待确认」条目需要人工确认，误报可直接删除或忽略。
- 用户反馈提取对需求、设计问题、配置说明偏保守，可能漏掉极短或隐含的表达；可随时让 Agent 用 `qa_from_user_report` 补录。
- 助手文本提取默认关闭；开启后仍可能把计划/文档里的描述当成 bug。
- 历史回填只覆盖最近窗口内的顶层会话，跳过 subagent 和 delegated review 会话，避免把评审上下文里的引用当成用户反馈。
- Git 只解析当前会话中 `git commit` 的 conventional fix 提交；历史 `git log` 不自动扫描，普通“修复登录”这类提交需要模型显式传 `commit`。
- Git 提交只作为证据，不替代测试；匹配不到时不会创建缺陷。
- 仅覆盖 DSH 会话内的信号；外部缺陷管理系统、Jira 等不同步。
- 「同一命令重跑成功」按工具名 + 命令文本匹配，命令文本变化时不会自动推进，需人工改状态。
- 面板语言目前为中文；插件元数据提供中英文标题与描述。

## 相关文档

- [English README](README_EN.md)
- [CHANGELOG](CHANGELOG.md)
- [LICENSE](LICENSE)

## 目录

```
index.js                       宿主半：捕获、存储、Agent 工具、HTTP API
lib/capture.js                 会话事件捕获
lib/extract.js                 工具失败 / 助手文本的确定性提取规则
lib/git.js                     git commit 解析
lib/features.js                功能模块关键词规则
lib/user-report.js             用户反馈分类、拆分与确认语句
lib/backfill.js                历史会话回填（经 sessionQuery）
lib/store.js                   缺陷存储、去重、状态流转、Git 证据
lib/constants.js               状态 / 严重度词表
client.js                      浏览器半：侧边栏入口 + 原生面板
preset/coding-qa/              编码 + QA Agent 预设
skills/qa-defect-tracking/     qa-defect-tracking skill
locale/*.json                  插件管理器的标题与描述
icon.svg                       插件图标
test/                          提取、存储与工具集成测试
```

## 开发

```bash
npm test
# 或 node --test
```

插件以本地目录方式安装：**插件管理 → 添加插件 → 选择本目录**，或在已授权环境使用 `plugin_manager` 的 `install_bundle`。安装或更新包含预设的 bundle 后，需要新建会话才能在选择器里看到「编码与缺陷追踪」预设。

## 许可证

MIT License，见 [LICENSE](LICENSE)。