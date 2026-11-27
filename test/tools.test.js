import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../index.js';

function fakeContext() {
  const tools = new Map();
  let cleanup = () => {};
  const ctx = {
    logger: { info() {} },
    on() {},
    effect(fn) {
      cleanup = fn();
      return () => {};
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
    systemPrompt: { section() { return () => {}; } },
    webServer: { register() { return () => {}; } },
    get() { return null; },
  };
  return { ctx, tools, cleanup: () => cleanup() };
}

test('qa_capture and qa_from_user_report work end to end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qa-guardian-tools-'));
  try {
    const { ctx, tools, cleanup } = fakeContext();
    await apply(ctx, { dataDir: dir, autoCapture: false, backfillOnStart: false });
    for (const name of ['qa_capture', 'qa_begin_fix', 'qa_mark_fixed', 'qa_from_user_report', 'qa_list_bugs']) {
      assert.ok(tools.has(name), name);
    }
    for (const name of ['qa_report_bug', 'qa_update_bug', 'qa_bug_stats']) {
      assert.equal(tools.has(name), false, `${name} should not be registered`);
    }
    const exec = {
      agent: {
        session: {
          id: 'session-test',
          header: { cwd: 'C:\\demo' },
          snapshotEvents: () => [],
        },
      },
    };

    const capture = await tools.get('qa_capture').execute({
      found: [{ title: '登录接口 500', severity: 'critical', description: '复现步骤' }],
      fixed: [],
    }, exec);
    assert.equal(capture.ok, true);
    assert.match(capture.message, /新增 BUG-/);
    const bugId = (capture.message.match(/BUG-\d+/) || [])[0];
    assert.ok(bugId);

    const begin = await tools.get('qa_begin_fix').execute({
      query: '登录接口',
      module: '认证',
      note: '开始修复登录接口',
    }, exec);
    assert.equal(begin.ok, true);
    assert.match(begin.message, /机器人修复中/);
    const afterBegin = await tools.get('qa_list_bugs').execute({ limit: 10 }, exec);
    assert.match(afterBegin.message, /修复中/);

    const fixed = await tools.get('qa_mark_fixed').execute({
      query: '登录接口 500',
      note: '修复空指针',
    }, exec);
    assert.equal(fixed.ok, true);
    assert.match(fixed.message, /待验证/);

    const closed = await tools.get('qa_mark_fixed').execute({
      latest: true,
      verified: true,
      note: '同轮测试通过',
    }, exec);
    assert.equal(closed.ok, true);
    assert.match(closed.message, /待验证/);
    assert.match(closed.message, /自动关闭/);

    const user = await tools.get('qa_from_user_report').execute({
      report: '业务明细和日志总量为什么都是0',
    }, exec);
    assert.equal(user.ok, true);
    assert.match(user.message, /BUG-/);

    const feature = await tools.get('qa_from_user_report').execute({
      report: '需要新增登录审计页面和导出按钮',
      kind: 'feature',
    }, exec);
    assert.equal(feature.ok, true);
    assert.match(feature.message, /功能需求/);

    const mixed = await tools.get('qa_from_user_report').execute({
      report: '1. 看板中已关闭无法消失会一直留着 2. 增加个日历吧 可以追踪每天的情况',
      items: [
        { text: '看板中已关闭无法消失会一直留着', kind: 'bug' },
        { text: '增加个日历吧 可以追踪每天的情况', kind: 'feature' },
      ],
    }, exec);
    assert.equal(mixed.ok, true);
    assert.match(mixed.message, /已记录/);
    assert.match(mixed.message, /功能需求/);

    const listed = await tools.get('qa_list_bugs').execute({ limit: 10 }, exec);
    assert.equal(listed.ok, true);
    assert.match(listed.message, /登录接口 500/);
    assert.match(listed.message, /业务明细/);
    assert.match(listed.message, /看板中已关闭/);

    const searched = await tools.get('qa_list_bugs').execute({ query: '看板中已关闭' }, exec);
    assert.equal(searched.ok, true);
    assert.match(searched.message, /看板中已关闭/);

    cleanup();
    await new Promise(resolve => setTimeout(resolve, 500));
    const data = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
    assert.equal(data.bugs.length, 3);
    assert.equal(data.bugs.find(bug => bug.title.includes('登录接口')).source, 'agent');
    assert.equal(data.bugs.find(bug => bug.title.includes('登录接口')).status, 'verify');
    assert.equal(data.bugs.find(bug => bug.title.includes('业务明细')).source, 'user');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});