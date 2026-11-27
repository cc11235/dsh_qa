import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { apply } from '../index.js';
import { cleanupDir, fakeSession, makeContext, tempDir } from './helpers.js';

async function withPlugin(fn, config = {}, { sessionQuery = null } = {}) {
  const dir = await tempDir('qa-tools-');
  const { ctx, tools, routes, sections, cleanup } = makeContext({ sessionQuery });
  await apply(ctx, {
    dataDir: dir,
    autoCapture: true,
    backfillOnStart: false,
    ...config,
  });
  try {
    return await fn({ dir, tools, routes, sections });
  } finally {
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 120));
    await cleanupDir(dir);
  }
}

function execFor(session = fakeSession({ id: 's1', cwd: 'D:\\demo' })) {
  return { agent: { session } };
}

function bugIdOf(message) {
  const match = /BUG-\d+/.exec(message || '');
  return match ? match[0] : '';
}

test('apply registers exactly the six supported tools and the prompt section', async () => {
  await withPlugin(async ({ tools, sections }) => {
    assert.deepEqual([...tools.keys()].sort(), [
      'qa_backfill_sessions',
      'qa_begin_fix',
      'qa_capture',
      'qa_from_user_report',
      'qa_list_bugs',
      'qa_mark_fixed',
    ]);
    for (const name of ['qa_report_bug', 'qa_update_bug', 'qa_bug_stats']) {
      assert.equal(tools.has(name), false, `${name} is dead code and must not be registered`);
    }
    for (const tool of tools.values()) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.output.schema.type, 'object');
      assert.equal(typeof tool.execute, 'function');
    }
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'plugin:qa-guardian');
    assert.equal(sections[0].order, 40);
    assert.match(sections[0].text, /qa_from_user_report/);
    assert.match(sections[0].text, /qa_begin_fix/);
  });
});

test('a configured announcement overrides the default prompt', async () => {
  await withPlugin(async ({ sections }) => {
    assert.equal(sections[0].text, '自定义提示');
  }, { announcement: '自定义提示' });
});

test('qa_capture records found defects with workspace context', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_capture').execute({
      found: [
        { title: '登录接口 500', severity: 'critical', description: '复现步骤', evidence: 'src/auth.ts:12' },
        { title: '订单页面白屏', severity: 'major' },
      ],
    }, execFor());
    assert.equal(result.ok, true);
    assert.match(result.message, /新增 BUG-0001/);
    assert.match(result.message, /新增 BUG-0002/);
    assert.equal(result.lines.length, 2);

    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /登录接口 500/);
    assert.match(listed.message, /订单页面白屏/);
  });
});

test('qa_capture merges a repeated found defect and reopens verify', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const first = await capture.execute({ found: [{ title: '登录接口 500' }] }, execFor());
    const id = bugIdOf(first.message);
    await tools.get('qa_mark_fixed').execute({ id, verified: false }, execFor());

    const second = await capture.execute({ found: [{ title: '登录接口 500' }] }, execFor());
    assert.match(second.message, new RegExp(`关联 ${id}`));
    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /待修复/);
  });
});

test('qa_capture fixed supports id, query and latest targets', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const one = bugIdOf((await capture.execute({ found: [{ title: '登录接口 500' }] }, execFor())).message);
    const two = bugIdOf((await capture.execute({ found: [{ title: '订单页面白屏' }] }, execFor())).message);

    const byId = await capture.execute({ fixed: [{ id: one, note: '已修复' }] }, execFor());
    assert.match(byId.message, new RegExp(`${one} → 待验证`));

    const byQuery = await capture.execute({ fixed: [{ query: '订单页面白屏', verified: true }] }, execFor());
    assert.match(byQuery.message, new RegExp(`${two} → 已关闭`));

    const byLatest = await capture.execute({ fixed: [{ latest: true }] }, execFor());
    assert.match(byLatest.message, /BUG-\d+ → 待验证/);
  });
});

test('qa_capture reports missing targets and empty batches', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const empty = await capture.execute({}, execFor());
    assert.equal(empty.ok, true);
    assert.match(empty.message, /没有需要登记/);

    const missing = await capture.execute({ fixed: [{ query: '根本不存在的缺陷' }] }, execFor());
    assert.equal(missing.ok, true);
    assert.match(missing.message, /未找到缺陷/);

    const invalid = await capture.execute({ found: [{ title: '   ' }] }, execFor());
    assert.match(invalid.message, /没有需要登记/);
  });
});

test('qa_from_user_report records a bug, skips feature and question kinds', async () => {
  await withPlugin(async ({ tools }) => {
    const report = tools.get('qa_from_user_report');
    const bug = await report.execute({ report: '业务明细和日志总量为什么都是0' }, execFor());
    assert.equal(bug.ok, true);
    assert.match(bug.message, /已记录 BUG-/);

    const feature = await report.execute({
      report: '需要新增登录审计页面和导出按钮',
      kind: 'feature',
    }, execFor());
    assert.equal(feature.ok, true);
    assert.match(feature.message, /跳过（功能需求）/);

    const question = await report.execute({
      report: '活跃agent怎么定义的',
      kind: 'question',
    }, execFor());
    assert.match(question.message, /跳过（提问）/);

    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /业务明细/);
    assert.doesNotMatch(listed.message, /登录审计/);
  });
});

test('qa_from_user_report splits mixed items and only records bugs', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_from_user_report').execute({
      items: [
        { text: '看板中已关闭无法消失会一直留着', kind: 'bug', severity: 'critical' },
        { text: '增加个日历吧 可以追踪每天的情况', kind: 'feature' },
        { text: '活跃agent怎么定义的', kind: 'question' },
      ],
    }, execFor());
    assert.equal(result.ok, true);
    assert.match(result.message, /已记录 BUG-/);
    assert.match(result.message, /跳过（功能需求）/);
    assert.match(result.message, /跳过（提问）/);
    assert.equal(result.lines.length, 3);

    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /看板中已关闭/);
    assert.doesNotMatch(listed.message, /日历/);
  });
});

test('qa_from_user_report trusts an explicit bug kind for weakly classified text', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_from_user_report').execute({
      report: '这个地方的交互很别扭',
      kind: 'bug',
      title: '交互别扭',
      severity: 'minor',
    }, execFor());
    assert.equal(result.ok, true);
    assert.match(result.message, /已记录 BUG-/);
    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /交互别扭/);
  });
});

test('qa_from_user_report merges repeated reports and rejects empty input', async () => {
  await withPlugin(async ({ tools }) => {
    const report = tools.get('qa_from_user_report');
    const first = await report.execute({ report: '运行 up.sh 没有任何反应' }, execFor());
    const second = await report.execute({ report: '运行 up.sh 还是没有任何反应' }, execFor());
    const firstId = bugIdOf(first.message);
    assert.match(second.message, new RegExp(`已合并到 ${firstId}`));
    assert.equal((await report.execute({}, execFor())).ok, false);
  });
});

test('qa_begin_fix updates status by id, query, latest and by default', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const one = bugIdOf((await capture.execute({ found: [{ title: '登录接口 500' }] }, execFor())).message);
    const two = bugIdOf((await capture.execute({ found: [{ title: '订单页面白屏' }] }, execFor())).message);

    const byId = await tools.get('qa_begin_fix').execute({ id: one, module: '认证', note: '开始排查' }, execFor());
    assert.equal(byId.ok, true);
    assert.match(byId.message, new RegExp(`${one} → 机器人修复中（认证）`));

    const byQuery = await tools.get('qa_begin_fix').execute({ query: '订单页面白屏' }, execFor());
    assert.equal(byQuery.ok, true);
    assert.match(byQuery.message, new RegExp(two));

    const byLatest = await tools.get('qa_begin_fix').execute({ latest: true }, execFor());
    assert.equal(byLatest.ok, true);
  });
});

test('qa_begin_fix falls back to latest only when no selector is given', async () => {
  await withPlugin(async ({ tools }) => {
    await tools.get('qa_capture').execute({ found: [{ title: '登录接口 500' }] }, execFor());
    const result = await tools.get('qa_begin_fix').execute({}, execFor());
    assert.equal(result.ok, true);
    assert.match(result.message, /机器人修复中/);

    const missing = await tools.get('qa_begin_fix').execute({ id: 'BUG-9999' }, execFor());
    assert.equal(missing.ok, false);
    assert.match(missing.message, /未找到匹配缺陷/);
  });
});

test('qa_begin_fix never creates a defect', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_begin_fix').execute({ query: '不存在的症状' }, execFor());
    assert.equal(result.ok, false);
    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /没有匹配的缺陷/);
  });
});

test('qa_mark_fixed moves to 待验证 by default and 已关闭 when verified', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const id = bugIdOf((await capture.execute({ found: [{ title: '登录接口 500' }] }, execFor())).message);

    const pending = await tools.get('qa_mark_fixed').execute({ id, note: '改完了' }, execFor());
    assert.equal(pending.ok, true);
    assert.match(pending.message, /待验证/);

    const closed = await tools.get('qa_mark_fixed').execute({ id, verified: true, note: '测试通过' }, execFor());
    assert.match(closed.message, /已关闭/);

    const missing = await tools.get('qa_mark_fixed').execute({ query: '不存在' }, execFor());
    assert.equal(missing.ok, false);
  });
});

test('qa_list_bugs filters by status, severity and query and clamps the limit', async () => {
  await withPlugin(async ({ tools }) => {
    const capture = tools.get('qa_capture');
    const one = bugIdOf((await capture.execute({
      found: [{ title: '登录接口 500', severity: 'critical' }],
    }, execFor())).message);
    await capture.execute({ found: [{ title: '样式错位', severity: 'minor' }] }, execFor());

    const critical = await tools.get('qa_list_bugs').execute({ severity: 'critical' }, execFor());
    assert.match(critical.message, /登录接口 500/);
    assert.doesNotMatch(critical.message, /样式错位/);

    const query = await tools.get('qa_list_bugs').execute({ query: '样式' }, execFor());
    assert.match(query.message, /样式错位/);
    assert.equal(query.lines.length, 1);

    const limited = await tools.get('qa_list_bugs').execute({ limit: 1 }, execFor());
    assert.equal(limited.lines.length, 1);

    const open = await tools.get('qa_list_bugs').execute({ status: 'open' }, execFor());
    assert.match(open.message, new RegExp(one));
  });
});

test('qa_list_bugs is scoped to the current workspace', async () => {
  await withPlugin(async ({ tools }) => {
    await tools.get('qa_capture').execute({
      found: [{ title: '演示项目缺陷' }],
    }, execFor(fakeSession({ id: 's1', cwd: 'D:\\demo' })));
    await tools.get('qa_capture').execute({
      found: [{ title: '其他项目缺陷' }],
    }, execFor(fakeSession({ id: 's2', cwd: 'D:\\other' })));

    const demo = await tools.get('qa_list_bugs').execute({}, execFor(fakeSession({ id: 's1', cwd: 'D:\\demo' })));
    assert.match(demo.message, /演示项目缺陷/);
    assert.doesNotMatch(demo.message, /其他项目缺陷/);
  });
});

test('tool context without an agent session still records and lists globally', async () => {
  await withPlugin(async ({ tools }) => {
    const created = await tools.get('qa_capture').execute({
      found: [{ title: '无会话缺陷' }],
    }, {});
    assert.equal(created.ok, true);
    const listed = await tools.get('qa_list_bugs').execute({}, {});
    assert.match(listed.message, /无会话缺陷/);
  });
});

test('qa_backfill_sessions replays a historical session through the provided service', async () => {
  const snapshot = {
    session: { id: 'old-1', cwd: 'D:\\demo' },
    events: [{
      type: 'user/message',
      time: 5000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '运行 up.sh 没有任何反应' }] },
    }],
  };
  const sessionQuery = {
    async listSessions() {
      return [{ header: { id: 'old-1', cwd: 'D:\\demo', createdAt: Date.now() - 3600_000 } }];
    },
    async readSession() {
      return snapshot;
    },
  };
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_backfill_sessions').execute({
      workspace: 'D:\\demo',
      days: 1,
      limit: 5,
    }, execFor());
    assert.equal(result.ok, true);
    assert.match(result.message, /扫描 1 个会话/);
    assert.match(result.message, /新增 1 条缺陷/);
    const listed = await tools.get('qa_list_bugs').execute({}, execFor());
    assert.match(listed.message, /运行 up.sh/);
  }, {}, { sessionQuery });
});

test('qa_backfill_sessions reports counts when no session service exists', async () => {
  await withPlugin(async ({ tools }) => {
    const result = await tools.get('qa_backfill_sessions').execute({ days: 1 }, execFor());
    assert.match(result.message, /扫描 0 个会话/);
    assert.match(result.message, /新增 0 条缺陷/);
  });
});

test('tool results persist to the configured data directory', async () => {
  await withPlugin(async ({ dir, tools }) => {
    const result = await tools.get('qa_capture').execute({
      found: [{ title: '持久化缺陷' }],
    }, execFor());
    assert.equal(result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 450));
    const data = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'));
    assert.equal(data.bugs.length, 1);
    assert.equal(data.bugs[0].title, '持久化缺陷');
  });
});

test('the prompt section is skipped when systemPrompt.section is unavailable', async () => {
  const dir = await tempDir('qa-tools-noprompt-');
  try {
    const { ctx, tools } = makeContext();
    ctx.systemPrompt = undefined;
    await apply(ctx, { dataDir: dir, autoCapture: false, backfillOnStart: false });
    assert.equal(tools.size, 6);
  } finally {
    await cleanupDir(dir);
  }
});