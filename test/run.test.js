import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeAssistantText,
  analyzeToolResult,
  detectExitCode,
  isFailureResult,
  projectCommandKind,
} from '../lib/extract.js';
import { BugStore } from '../lib/store.js';
import { Capture } from '../lib/capture.js';
import { featureFromText } from '../lib/features.js';
import { parseGitCommit } from '../lib/git.js';
import { analyzeUserText, classifyUserMessage, isUserConfirmation } from '../lib/user-report.js';
import { moduleFromPath } from '../lib/util.js';

test('detectExitCode reads bracket and plain markers', () => {
  assert.equal(detectExitCode('out\n[exit code: 2]'), 2);
  assert.equal(detectExitCode('exit code: 1'), 1);
  assert.equal(detectExitCode('[exit code: 0]'), 0);
  assert.equal(detectExitCode('all good'), null);
});

test('isFailureResult ignores explicit sandbox/policy denials', () => {
  assert.equal(isFailureResult('PATH_RESTRICTED', true), false);
  assert.equal(isFailureResult('normal output', false), false);
  assert.equal(isFailureResult('[exit code: 3]', false), true);
  assert.equal(isFailureResult('Traceback (most recent call last):', false), true);
});

test('analyzeToolResult classifies a TypeScript build failure', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm run build' },
    text: "src/App.tsx:12:5 - error TS2304: Cannot find name 'foo'.\n[exit code: 2]",
    isError: true,
  });
  assert.ok(draft);
  assert.match(draft.title, /构建失败/);
  assert.match(draft.title, /TS2304/);
  assert.equal(draft.severity, 'major');
  assert.match(draft.signature, /^tool:/);
  assert.equal(draft.trigger.tool, 'ops_bash');
  assert.match(draft.trigger.command, /npm run build/);
  assert.match(draft.description, /npm run build/);
});

test('analyzeToolResult returns null for successful output', () => {
  assert.equal(analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'ls' },
    text: 'file-a\nfile-b',
    isError: false,
  }), null);
});

test('analyzeToolResult ignores harness tool-call failures', () => {
  assert.equal(analyzeToolResult({
    tool: 'bash',
    args: { command: 'true' },
    text: 'Error: unknown tool "bash"',
    isError: true,
  }), null);
  assert.equal(analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'node -e "process.exit(9)"' },
    text: 'SyntaxError: Unexpected token\n    at [eval]:1:1',
    isError: true,
  }), null);
  assert.equal(analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'git status' },
    text: 'fatal: not a git repository',
    isError: true,
  }), null);
});

test('analyzeToolResult accepts a project test failure without a file path', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm test' },
    text: 'Tests: 1 failed, 2 passed\n[exit code: 1]',
    isError: true,
  });
  assert.ok(draft);
  assert.match(draft.title, /测试失败/);
});

test('node --test failures are classified as test failures', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'node --test tmp_fail.test.mjs' },
    text: '# Subtest: intentional failure\nnot ok 1 - intentional failure\n# fail 1',
    isError: true,
  });
  assert.ok(draft);
  assert.match(draft.title, /测试失败/);
});

test('projectCommandKind separates checks, runs and other commands', () => {
  assert.equal(projectCommandKind('npm test'), 'check');
  assert.equal(projectCommandKind('pnpm run build'), 'check');
  assert.equal(projectCommandKind('node app.js'), 'run');
  assert.equal(projectCommandKind('git status'), 'other');
});

test('analyzeToolResult ignores cancelled calls and empty failures', () => {
  assert.equal(analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'sleep 30' },
    text: 'Operation cancelled by user',
    isError: true,
  }), null);
  assert.equal(analyzeToolResult({
    tool: 'ops_bash',
    args: {},
    text: '',
    isError: true,
  }), null);
});

test('analyzeAssistantText extracts defect and resolution separately', () => {
  const result = analyzeAssistantText('复现了一个 bug：退款回调重复入账，订单金额翻倍。\n已修复退款幂等校验。');
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /退款回调/);
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.resolutions[0].verified, false);
});

test('analyzeAssistantText recognizes risks and everyday fix wording', () => {
  const result = analyzeAssistantText('发现一个隐患：上传接口未校验文件类型。\n已改为白名单校验，现在可以正常上传。');
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /上传接口/);
  assert.equal(result.resolutions.length, 1);
});

test('analyzeAssistantText recognizes a fix heading', () => {
  const result = analyzeAssistantText('## 已修复\n\n- `port()` 现在对缺失 key 返回空值。');
  assert.equal(result.resolutions.length, 1);
});

test('analyzeAssistantText ignores requirement wording from plans', () => {
  const plan = analyzeAssistantText('5. 失败时弹窗显示具体原因。\n失败状态保留在按钮旁，不再只弹窗后消失。\n模拟接口失败后：');
  assert.equal(plan.bugs.length, 0);
  const defect = analyzeAssistantText('失败时页面白屏，控制台报错。');
  assert.equal(defect.bugs.length, 1);
});

test('analyzeAssistantText does not turn negative statements into defects', () => {
  const result = analyzeAssistantText('没有发现 bug，测试全部通过。');
  assert.equal(result.bugs.length, 0);
});

test('analyzeAssistantText ignores tracker documentation and fenced code', () => {
  const documentation = analyzeAssistantText('缺陷看板提供待确认、待修复、待验证三个状态，形成缺陷列表和追踪动态。');
  assert.equal(documentation.bugs.length, 0);
  const code = analyzeAssistantText('```\nthrow new Error("bug")\n```\n没有发现 bug。');
  assert.equal(code.bugs.length, 0);
});

test('defect statements without an observation verb are ignored', () => {
  const result = analyzeAssistantText('缺陷管理流程包括登记、分派与回归。');
  assert.equal(result.bugs.length, 0);
});

test('classifyUserMessage separates defects from feature requests', () => {
  assert.equal(classifyUserMessage('检索模版怎么用 点击了没反应').kind, 'bug');
  assert.equal(classifyUserMessage('业务明细和日志总量为什么都是0').kind, 'bug');
  assert.equal(classifyUserMessage('失败时弹窗显示具体原因。').kind, 'feature');
  assert.equal(classifyUserMessage('需要新增登录审计页面').kind, 'feature');
  assert.equal(classifyUserMessage('活跃agent怎么定义的').kind, 'question');
  assert.equal(analyzeUserText('失败时弹窗显示具体原因。').bugs.length, 0);
});

test('parseGitCommit reads a conventional fix commit', () => {
  const commit = parseGitCommit(
    'cd repo && git commit -m "fix(viewer): keep closed defects out of the board"',
    '[main 29fcc98] fix(viewer): keep closed defects out of the board\n 2 files changed',
  );
  assert.ok(commit);
  assert.equal(commit.sha, '29fcc98');
  assert.equal(commit.type, 'fix');
  assert.equal(commit.scope, 'viewer');
  assert.match(commit.subject, /keep closed defects/);
  assert.equal(parseGitCommit('git commit -m "feat: add calendar"', '[main abc1234] feat: add calendar'), null);
});

test('attachGitCommit verifies the matching defect and records evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const bug = store.create({
      title: '看板中已关闭的缺陷会一直留在看板',
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      status: 'open',
    });
    const attached = store.attachGitCommit({
      workspace: 'C:\\demo',
      sessionId: 's1',
      sha: '29fcc98',
      subject: 'fix(viewer): 看板中已关闭的缺陷不消失',
      message: 'fix(viewer): 看板中已关闭的缺陷不消失',
      scope: 'viewer',
    });
    assert.ok(attached);
    assert.equal(attached.id, bug.id);
    assert.equal(store.get(bug.id).status, 'verify');
    assert.equal(store.get(bug.id).evidence.at(-1).kind, 'git-commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('analyzeUserText splits a mixed bug-and-feature message', () => {
  const result = analyzeUserText('1. 看板中已关闭无法消失会一直留着 2. 增加个日历吧 可以追踪每天的情况');
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /看板中已关闭/);
  assert.doesNotMatch(result.bugs[0].title, /日历/);
});

test('analyzeUserText extracts real user bug reports', () => {
  const reports = [
    '用script/up.sh 好像没有启动8110',
    '运行up.sh 没有任何反应 是不新加的代码把程序终止掉了',
    'grafana跳转过去时localhost 而且没有自动填充用户名密码进去 能否直接自动登录',
    '检索里面 选择了业务 agent列表里包含了其他业务的agent',
    '业务明细和日志总量为什么都是0 检索能查到最近的日志',
    '感觉提取的不是很准 会漏掉很多 bug',
  ];
  for (const report of reports) {
    const result = analyzeUserText(report);
    assert.equal(result.bugs.length, 1, report);
    assert.equal(result.bugs[0].title, report);
  }
});

test('analyzeUserText ignores requirements and questions', () => {
  const messages = [
    '帮我写个日志查看界面 可以根据不同的业务查看日志 直接和日志系统联动',
    '1. 私有部署 不需要认证\n2. grafana可以iframe嵌入，都是部署在同一台机器',
    'grafana密码是!ailab@123 试下',
    '不要影响grafana正常使用',
    '提交下代码',
    '活跃agent怎么定义的',
    '把活跃与否的口径加上 比如24小时未有日志',
    '继续 同时可增加多选、全选、一键忽略、一键解决等 有时太多 没有自动更改状态下 不想一个一个处理',
    '命令执行失败：unknown tool "bash" 这种是DSH自己调用工具出现的失败情况吧 不是项目bug',
    '不要漏掉任何日志',
    '[dsh-mnemon:delegated review]\nBounded completed checkpoint\n[user/message; checkpoint event 1]\n运行 up.sh 没有任何反应',
  ];
  for (const message of messages) {
    assert.equal(analyzeUserText(message).bugs.length, 0, message);
  }
});

test('user confirmation closes the loop only without a new symptom', () => {
  assert.equal(isUserConfirmation('好了，现在正常了'), true);
  assert.equal(isUserConfirmation('可以了，谢谢'), true);
  assert.equal(isUserConfirmation('好了，但是另一个页面还是不行'), false);
  assert.equal(isUserConfirmation('现在正常了吗？'), false);
});

test('duplicate user reports merge and reopen a closed defect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const first = store.recordUserReport({
      draft: { title: 'script/up.sh 没有启动 8110', description: 'up.sh 没启动 8110', severity: 'critical' },
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '没有启动' },
    });
    assert.equal(first.created, true);
    assert.equal(first.bug.source, 'user');
    const second = store.recordUserReport({
      draft: { title: '运行 up.sh 还是没有任何反应', description: '还是没反应', severity: 'critical' },
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '还是没反应' },
    });
    assert.equal(second.created, false);
    assert.equal(second.bug.occurrence, 2);
    store.update(second.bug.id, { status: 'closed' }, { note: '用户确认' });
    const third = store.recordUserReport({
      draft: { title: '运行 up.sh 又没有反应了', description: '回归', severity: 'critical' },
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '没反应' },
    });
    assert.equal(third.reopened, true);
    assert.equal(third.bug.status, 'open');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('featureFromText maps user-visible wording to a module', () => {
  assert.equal(featureFromText('用script/up.sh 好像没有启动8110'), '启动与部署');
  assert.equal(featureFromText('grafana跳转过去时localhost'), 'Grafana 集成');
  assert.equal(featureFromText('业务明细和日志总量为什么都是0'), '统计看板');
  assert.equal(featureFromText('Prometheus 为什么没有值'), 'Prometheus 指标');
  assert.equal(featureFromText('检索里面 选择了业务 agent列表里包含了其他业务的agent'), '日志检索');
});

test('analyzeUserText attaches a feature module', () => {
  const result = analyzeUserText('业务明细和日志总量为什么都是0');
  assert.equal(result.bugs[0].module, '统计看板');
});

test('moduleFromPath derives a stable functional module', () => {
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\scripts\\up.sh'), 'scripts');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\backend\\app\\static\\app.css'), 'backend/app');
  assert.equal(moduleFromPath('D:\\demo', 'src\\components\\Button.tsx'), 'src/components');
  assert.equal(moduleFromPath('D:\\demo', 'node_modules\\x\\index.js'), '');
});

test('user reports start as 待修复 and move to 修复中 on fix activity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const report = store.recordUserReport({
      draft: { title: '运行 up.sh 没有任何反应', description: 'up.sh', severity: 'critical' },
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '没有反应' },
    });
    assert.equal(report.bug.status, 'open');
    const fixing = store.noteFixActivity({
      workspace: 'C:\\demo',
      sessionId: 's1',
      module: 'scripts',
    });
    assert.ok(fixing);
    assert.equal(fixing.status, 'progress');
    assert.equal(fixing.module, 'scripts');
    const last = fixing.history[fixing.history.length - 1];
    assert.equal(last.actor, 'agent');
    assert.equal(last.to, 'progress');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a generic “已修复” does not close an unrelated defect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const bug = store.create({
      title: '业务明细和日志总量为什么都是0',
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      status: 'open',
    });
    assert.equal(store.findResolutionTarget({ workspace: 'C:\\demo', sessionId: 's1', snippet: '## 已修复' }), null);
    const matched = store.findResolutionTarget({
      workspace: 'C:\\demo',
      sessionId: 's1',
      snippet: '已修复业务明细和日志总量为0的问题',
    });
    assert.equal(matched && matched.id, bug.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a user report moves to 修复中 on the next DSH tool action', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const capture = new Capture({ store, config: {}, log: () => {} });
    const session = { id: 's1', header: { cwd: 'C:\\demo' }, snapshotEvents: () => [] };
    const tracker = capture.ensure(session);
    capture.onUserMessage(tracker, {
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '业务明细和日志总量为什么都是0' }],
      },
      time: Date.now(),
    });
    const bug = store.list()[0];
    assert.ok(bug);
    assert.equal(bug.status, 'open');
    capture.onToolCall(tracker, {
      data: { callId: 'c1', name: 'ops_bash', arguments: '{"command":"ls"}' },
      time: Date.now(),
    });
    assert.equal(store.get(bug.id).status, 'progress');
    const last = store.get(bug.id).history[store.get(bug.id).history.length - 1];
    assert.equal(last.actor, 'agent');
    assert.equal(last.to, 'progress');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assignModule attaches a fix location to the latest open report', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const report = store.recordUserReport({
      draft: { title: '运行 up.sh 没有任何反应', description: 'up.sh', severity: 'critical' },
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '没有反应' },
    });
    assert.equal(report.bug.module, '');
    const assigned = store.assignModule({
      workspace: 'C:\\demo',
      sessionId: 's1',
      module: 'scripts',
    });
    assert.ok(assigned);
    assert.equal(assigned.id, report.bug.id);
    assert.equal(store.get(report.bug.id).module, 'scripts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BugStore survives a reload and keeps status history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const file = path.join(dir, 'data.json');
    const store = await new BugStore({ filePath: file }).load();
    const bug = store.create({ title: '登录接口 500', description: '复现步骤', severity: 'critical' });
    assert.equal(bug.status, 'open');
    store.update(bug.id, { status: 'progress' }, { note: '开始排查' });
    assert.equal(store.get(bug.id).status, 'progress');
    assert.equal(store.get(bug.id).history.length, 2);
    await store.flush();

    const reloaded = await new BugStore({ filePath: file }).load();
    assert.equal(reloaded.get(bug.id).status, 'progress');
    assert.equal(reloaded.get(bug.id).notes.length, 1);
    assert.equal(reloaded.stats().total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tool failures dedupe, reopen, and verify on a successful rerun', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-'));
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json') }).load();
    const draft = analyzeToolResult({
      tool: 'ops_bash',
      args: { command: 'npm test' },
      text: 'FAIL src/login.test.ts\nTests: 1 failed, 2 passed\n[exit code: 1]',
      isError: true,
    });
    assert.ok(draft);
    const first = store.recordToolFailure({
      draft,
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '修复登录',
      evidence: { excerpt: draft.excerpt, tool: 'ops_bash' },
    });
    assert.equal(first.created, true);
    assert.equal(first.bug.status, 'new');

    store.update(first.bug.id, { status: 'closed' }, { note: '已修复' });
    const second = store.recordToolFailure({
      draft,
      workspace: 'C:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '修复登录',
      evidence: { excerpt: draft.excerpt, tool: 'ops_bash' },
    });
    assert.equal(second.created, false);
    assert.equal(second.reopened, true);
    assert.equal(second.bug.status, 'open');
    assert.equal(second.bug.occurrence, 2);

    const verified = store.markVerifiedByRerun({
      workspace: 'C:\\demo',
      trigger: draft.trigger,
      tool: 'ops_bash',
      sessionId: 's1',
    });
    assert.ok(verified);
    assert.equal(verified.status, 'verify');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});