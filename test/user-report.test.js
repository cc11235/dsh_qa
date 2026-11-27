import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeUserText,
  classifyUserMessage,
  isUserConfirmation,
  severityOfUserText,
} from '../lib/user-report.js';

test('classifyUserMessage recognizes observed defects', () => {
  const reports = [
    '检索模版怎么用 点击了没反应',
    '业务明细和日志总量为什么都是0',
    '用script/up.sh 好像没有启动8110',
    '看板中已关闭无法消失会一直留着',
    '上传接口报错了',
    '数据丢失了',
    '列表包含了其他业务的agent',
    '这个页面白屏',
    '系统崩溃了',
  ];
  for (const report of reports) {
    assert.equal(classifyUserMessage(report).kind, 'bug', report);
  }
});

test('classifyUserMessage recognizes feature requests and requirements', () => {
  const features = [
    '失败时弹窗显示具体原因。',
    '需要新增登录审计页面',
    '增加个日历吧',
    '把活跃与否的口径加上',
    '不要影响grafana正常使用',
    '帮我写个日志查看界面',
    '能否支持多选',
    '继续 同时可增加多选、全选、一键忽略',
  ];
  for (const message of features) {
    assert.equal(classifyUserMessage(message).kind, 'feature', message);
  }
});

test('classifyUserMessage recognizes questions without an observed failure', () => {
  assert.equal(classifyUserMessage('活跃agent怎么定义的').kind, 'question');
  assert.equal(classifyUserMessage('这个功能怎么用？').kind, 'question');
  assert.equal(classifyUserMessage('为什么没有日志？').kind, 'question');
});

test('classifyUserMessage filters harness noise and checkpoint text', () => {
  assert.equal(classifyUserMessage('命令执行失败：unknown tool "bash" 这种是DSH自己调用工具出现的失败').kind, 'noise');
  assert.equal(classifyUserMessage('工具调用失败，不是项目 bug').kind, 'noise');
  assert.equal(classifyUserMessage('[dsh-mnemon:delegated review]\nBounded completed checkpoint\n运行 up.sh').kind, 'noise');
});

test('classifyUserMessage detects confirmations', () => {
  assert.equal(classifyUserMessage('好了，现在正常了').kind, 'confirmation');
  assert.equal(classifyUserMessage('可以了，谢谢').kind, 'confirmation');
});

test('classifyUserMessage leaves neutral messages unclassified', () => {
  assert.equal(classifyUserMessage('').kind, 'other');
  assert.equal(classifyUserMessage('提交下代码').kind, 'other');
  assert.equal(classifyUserMessage('grafana密码是!ailab@123 试下').kind, 'other');
  assert.equal(classifyUserMessage('仔细诊断下这个插件：').kind, 'other');
});

test('isUserConfirmation requires confirmation without a new symptom or question', () => {
  assert.equal(isUserConfirmation('好了，现在正常了'), true);
  assert.equal(isUserConfirmation('可以了，谢谢'), true);
  assert.equal(isUserConfirmation('好了，但是另一个页面还是不行'), false);
  assert.equal(isUserConfirmation('现在正常了吗？'), false);
  assert.equal(isUserConfirmation(''), false);
  assert.equal(isUserConfirmation('好了'), true);
  assert.equal(isUserConfirmation('a'.repeat(200) + '好了'), false);
});

test('severityOfUserText maps wording to severity', () => {
  assert.equal(severityOfUserText('系统崩溃，数据丢失'), 'blocker');
  assert.equal(severityOfUserText('登录无法跳转'), 'critical');
  assert.equal(severityOfUserText('样式错位，颜色不对'), 'minor');
  assert.equal(severityOfUserText('有点小问题'), 'major');
});

test('analyzeUserText extracts a single user defect', () => {
  const result = analyzeUserText('业务明细和日志总量为什么都是0 检索能查到最近的日志');
  assert.equal(result.kind, 'bug');
  assert.equal(result.bugs.length, 1);
  const bug = result.bugs[0];
  assert.equal(bug.title, '业务明细和日志总量为什么都是0 检索能查到最近的日志');
  assert.equal(bug.severity, 'critical');
  assert.equal(bug.module, '统计看板');
  assert.match(bug.signature, /^user:[0-9a-f]{8}$/);
  assert.equal(bug.description, bug.title);
});

test('analyzeUserText splits numbered bug and feature items', () => {
  const result = analyzeUserText('1. 看板中已关闭无法消失会一直留着 2. 增加个日历吧 可以追踪每天的情况');
  assert.equal(result.bugs.length, 1);
  assert.match(result.bugs[0].title, /看板中已关闭/);
  assert.doesNotMatch(result.bugs[0].title, /日历/);
  assert.match(result.bugs[0].description, /原消息：/);
});

test('analyzeUserText keeps several distinct bug segments', () => {
  const result = analyzeUserText([
    '1. 登录接口报错了',
    '2. 订单页面白屏了',
    '3. 上传功能崩溃了',
  ].join('\n'));
  assert.equal(result.bugs.length, 3);
  assert.match(result.bugs[0].title, /登录接口/);
  assert.match(result.bugs[1].title, /订单页面/);
  assert.match(result.bugs[2].title, /上传功能/);
});

test('analyzeUserText caps extracted defects at four', () => {
  const lines = [
    '登录报错',
    '订单白屏',
    '上传崩溃',
    '检索没反应',
    '导出失败',
  ].map((line, index) => `${index + 1}. ${line}`).join('\n');
  assert.equal(analyzeUserText(lines).bugs.length, 4);
});

test('analyzeUserText ignores requirements, questions and noise', () => {
  const messages = [
    '帮我写个日志查看界面 可以根据不同的业务查看日志 直接和日志系统联动',
    '1. 私有部署 不需要认证\n2. grafana可以iframe嵌入，都是部署在同一台机器',
    'grafana密码是!ailab@123 试下',
    '不要影响grafana正常使用',
    '提交下代码',
    '活跃agent怎么定义的',
    '把活跃与否的口径加上 比如24小时未有日志',
    '命令执行失败：unknown tool "bash" 这种是DSH自己调用工具出现的失败情况吧 不是项目bug',
  ];
  for (const message of messages) {
    const result = analyzeUserText(message);
    assert.equal(result.bugs.length, 0, message);
  }
});

test('analyzeUserText reports confirmation and question kinds', () => {
  const confirmed = analyzeUserText('好了，现在正常了');
  assert.equal(confirmed.confirmation, true);
  assert.equal(confirmed.kind, 'confirmation');
  assert.equal(confirmed.bugs.length, 0);

  const question = analyzeUserText('活跃agent怎么定义的');
  assert.equal(question.kind, 'question');
  assert.equal(question.confirmation, false);
});

test('analyzeUserText does not create a defect from a two-character title', () => {
  const result = analyzeUserText('报错');
  assert.equal(result.bugs.length, 0);
  assert.equal(result.kind, 'other');
});

test('analyzeUserText derives a module from a file path in the report', () => {
  const result = analyzeUserText('打开 D:\\demo\\src\\a.ts 报错了', 'D:\\demo');
  assert.equal(result.bugs.length, 1);
  assert.equal(result.bugs[0].module, 'src');
});

test('analyzeUserText deduplicates identical segments', () => {
  const result = analyzeUserText('登录接口报错了\n登录接口报错了');
  assert.equal(result.bugs.length, 1);
});

test('analyzeUserText handles empty and whitespace-only input', () => {
  for (const input of ['', '   ', '\n\t']) {
    const result = analyzeUserText(input);
    assert.deepEqual(result.bugs, []);
    assert.equal(result.confirmation, false);
  }
});