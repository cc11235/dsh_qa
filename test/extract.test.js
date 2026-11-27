import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeAssistantText,
  analyzeToolResult,
  classifyFailure,
  detectExitCode,
  isFailureResult,
  normalizeSignature,
  pickErrorLine,
  projectCommandKind,
  sentenceTitle,
  severityOfText,
} from '../lib/extract.js';

test('detectExitCode reads bracket, plain, negative and zero markers', () => {
  assert.equal(detectExitCode('out\n[exit code: 2]'), 2);
  assert.equal(detectExitCode('exit code: 1'), 1);
  assert.equal(detectExitCode('[exit code: 0]'), 0);
  assert.equal(detectExitCode('[exit code: -9]'), -9);
  assert.equal(detectExitCode('all good'), null);
  assert.equal(detectExitCode(''), null);
});

test('isFailureResult ignores sandbox and approval noise', () => {
  assert.equal(isFailureResult('PATH_RESTRICTED', true), false);
  assert.equal(isFailureResult('approval required for this action', true), false);
  assert.equal(isFailureResult('denied by the user', true), false);
  assert.equal(isFailureResult('normal output', false), false);
  assert.equal(isFailureResult('[exit code: 3]', false), true);
  assert.equal(isFailureResult('exit code: 0', false), false);
  assert.equal(isFailureResult('Traceback (most recent call last):', false), true);
  assert.equal(isFailureResult('npm ERR! code ENOENT', false), true);
  assert.equal(isFailureResult('FAILED src/a.test.ts', false), true);
  assert.equal(isFailureResult('', true), true);
});

test('normalizeSignature removes volatile paths, ids and line numbers', () => {
  const signature = normalizeSignature('Error C:\\demo\\src\\app.ts line 12 at 0xDEADBEEF 12345');
  assert.match(signature, /^error /);
  assert.match(signature, /<path>/);
  assert.match(signature, /<hex>/);
  assert.match(signature, /<n>/);
  assert.doesNotMatch(signature, /demo|DEADBEEF|12345|line 12/i);
  assert.equal(normalizeSignature('A  B'), 'a b');
});

test('pickErrorLine prefers the explanatory line and strips noise prefixes', () => {
  assert.equal(pickErrorLine('[stderr] TypeError: boom\n    at src/a.ts:1:2\n[exit code: 1]'), 'TypeError: boom');
  assert.equal(pickErrorLine('error: boom\nnoise'), 'boom');
  assert.equal(pickErrorLine('first line\nlast line'), 'last line');
  assert.equal(pickErrorLine(''), '');
});

test('classifyFailure maps tool output to category and severity', () => {
  assert.deepEqual(classifyFailure('ops_bash', 'FAIL src/a.test.ts\nTests: 1 failed, 2 passed'), {
    category: '测试失败', severity: 'major',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'src/a.ts:1:1 - error TS2322: bad'), {
    category: '构建失败', severity: 'major',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'pnpm install failed'), {
    category: '依赖安装失败', severity: 'major',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'panic: runtime error'), {
    category: '运行故障', severity: 'blocker',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'EACCES: permission denied'), {
    category: '权限错误', severity: 'critical',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'ENOENT: no such file'), {
    category: '文件或命令缺失', severity: 'minor',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'request timeout after 30s'), {
    category: '执行超时', severity: 'minor',
  });
  assert.deepEqual(classifyFailure('ops_bash', 'process exited'), {
    category: '命令执行失败', severity: 'major',
  });
});

test('projectCommandKind separates checks, runs and other commands', () => {
  assert.equal(projectCommandKind('npm test'), 'check');
  assert.equal(projectCommandKind('pnpm run build'), 'check');
  assert.equal(projectCommandKind('npx vitest run'), 'check');
  assert.equal(projectCommandKind('pytest -q'), 'check');
  assert.equal(projectCommandKind('node app.js'), 'run');
  assert.equal(projectCommandKind('python main.py'), 'run');
  assert.equal(projectCommandKind('git status'), 'other');
  assert.equal(projectCommandKind('npm install'), 'other');
});

test('analyzeToolResult captures a TypeScript build failure', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm run build' },
    text: "src/App.tsx:12:5 - error TS2304: Cannot find name 'foo'.\n[exit code: 2]",
    isError: true,
  });
  assert.ok(draft);
  assert.match(draft.title, /^构建失败/);
  assert.match(draft.title, /TS2304/);
  assert.equal(draft.severity, 'major');
  assert.equal(draft.kind, 'tool');
  assert.match(draft.signature, /^tool:/);
  assert.equal(draft.trigger.tool, 'ops_bash');
  assert.match(draft.trigger.command, /npm run build/);
  assert.match(draft.description, /触发命令：npm run build/);
  assert.match(draft.description, /error TS2304/);
});

test('analyzeToolResult captures a test failure without a source location', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm test' },
    text: 'Tests: 1 failed, 2 passed\n[exit code: 1]',
    isError: true,
  });
  assert.ok(draft);
  assert.match(draft.title, /测试失败/);
});

test('analyzeToolResult captures a run failure only with a project source location', () => {
  const withFile = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'node app.js' },
    text: 'TypeError: Cannot read properties of undefined\n    at handler (src/app.js:12:9)\n[exit code: 1]',
    isError: true,
  });
  assert.ok(withFile);
  assert.match(withFile.title, /命令执行失败/);
  assert.match(withFile.description, /src\/app\.js/);

  const withoutFile = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'node app.js' },
    text: 'TypeError: Cannot read properties of undefined\n[exit code: 1]',
    isError: true,
  });
  assert.equal(withoutFile, null);
});

test('analyzeToolResult detects failure from an exit code even when isError is false', () => {
  const draft = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'pnpm build' },
    text: 'error TS2304: nope\n[exit code: 2]',
    isError: false,
  });
  assert.ok(draft);
  assert.match(draft.title, /构建失败/);
});

test('analyzeToolResult rejects harness, environment, cancellation and empty failures', () => {
  const cases = [
    { tool: 'ops_bash', args: { command: 'true' }, text: 'Error: unknown tool "bash"', isError: true },
    { tool: 'ops_bash', args: { command: 'npm run build' }, text: 'npm ERR! Missing script: "build"', isError: true },
    { tool: 'ops_bash', args: { command: 'pnpm build' }, text: 'sh: pnpm: command not found', isError: true },
    { tool: 'ops_bash', args: { command: 'sleep 30' }, text: 'Operation cancelled by user', isError: true },
    { tool: 'ops_bash', args: { command: 'cat x' }, text: 'approval denied by the user', isError: true },
    { tool: 'ops_bash', args: { command: 'true' }, text: '[exit code: 1]', isError: true },
    { tool: 'ops_bash', args: {}, text: 'boom', isError: true },
    { tool: 'ops_grep', args: { command: 'x' }, text: 'error TS1\n[exit code: 1]', isError: true },
  ];
  for (const input of cases) {
    assert.equal(analyzeToolResult(input), null, JSON.stringify(input));
  }
});

test('analyzeToolResult keeps a failing script_path only with project evidence', () => {
  const captured = analyzeToolResult({
    tool: 'ops_bash',
    args: { script_path: 'scripts/run.sh' },
    text: 'TypeError: boom\n    at main (src/a.js:1:1)\n[exit code: 1]',
    isError: true,
  });
  assert.ok(captured);
  assert.match(captured.description, /scripts\/run\.sh/);

  const ignored = analyzeToolResult({
    tool: 'ops_bash',
    args: { script_path: 'scripts/test.sh' },
    text: 'FAILED src/a.test.js\n[exit code: 1]',
    isError: true,
  });
  assert.equal(ignored, null);
});

test('analyzeToolResult keeps one signature when only absolute paths and ids differ', () => {
  const first = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm run build' },
    text: 'C:\\demo\\src\\a.ts:10:1 - error TS1: boom\n[exit code: 2]',
    isError: true,
  });
  const second = analyzeToolResult({
    tool: 'ops_bash',
    args: { command: 'npm run build' },
    text: 'D:\\other\\src\\a.ts:10:1 - error TS1: boom\n[exit code: 2]',
    isError: true,
  });
  assert.ok(first && second);
  assert.equal(first.signature, second.signature);
  assert.equal(first.trigger.key, second.trigger.key);
});

test('severityOfText and sentenceTitle normalize assistant prose', () => {
  assert.equal(severityOfText('服务崩溃，数据丢失'), 'blocker');
  assert.equal(severityOfText('严重权限问题'), 'critical');
  assert.equal(severityOfText('界面样式错位'), 'minor');
  assert.equal(severityOfText('一般问题'), 'major');
  assert.equal(sentenceTitle('## 已修复：**登录** 接口'), '已修复：登录 接口');
  assert.equal(sentenceTitle('- `port()` 现在返回空值'), 'port() 现在返回空值');
});

test('analyzeAssistantText extracts defects and resolutions separately', () => {
  const result = analyzeAssistantText('复现了一个 bug：退款回调重复入账，订单金额翻倍。\n已修复退款幂等校验。');
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /退款回调/);
  assert.equal(result.bugs[0].kind, 'assistant');
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.resolutions[0].verified, false);
});

test('analyzeAssistantText marks verified resolutions', () => {
  const result = analyzeAssistantText('已修复登录校验，并测试全部通过。');
  assert.equal(result.bugs.length, 0);
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.resolutions[0].verified, true);
});

test('analyzeAssistantText keeps a defect that follows a fix sentence', () => {
  const result = analyzeAssistantText('已修复登录校验。但订单页面仍然白屏。');
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /订单页面/);
});

test('analyzeAssistantText ignores requirements, questions and negations', () => {
  const plan = analyzeAssistantText('5. 失败时弹窗显示具体原因。\n失败状态保留在按钮旁，不再只弹窗后消失。');
  assert.equal(plan.bugs.length, 0);
  assert.equal(analyzeAssistantText('没有发现 bug，测试全部通过。').bugs.length, 0);
  assert.equal(analyzeAssistantText('是否需要再检查一下？').bugs.length, 0);
  assert.equal(analyzeAssistantText('建议检查登录超时的问题。').bugs.length, 0);
});

test('analyzeAssistantText ignores tracker documentation and fenced code', () => {
  assert.equal(analyzeAssistantText('缺陷看板提供待确认、待修复、待验证三个状态。').bugs.length, 0);
  assert.equal(analyzeAssistantText('```\nthrow new Error("bug")\n```\n没有发现 bug。').bugs.length, 0);
  assert.equal(analyzeAssistantText('| 状态 | 说明 |\n|---|---|').bugs.length, 0);
  assert.equal(analyzeAssistantText('失败时页面白屏，控制台报错。').bugs.length, 1);
});

test('analyzeAssistantText caps defects at two per message', () => {
  const result = analyzeAssistantText([
    '登录接口报错，用户无法登录。',
    '订单页面白屏，数据无法加载。',
    '上传功能崩溃，文件丢失。',
  ].join('\n'));
  assert.equal(result.bugs.length, 2);
});