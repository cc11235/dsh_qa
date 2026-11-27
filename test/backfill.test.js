import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillSessions } from '../lib/backfill.js';
import { Capture } from '../lib/capture.js';
import { cleanupDir, newStore, tempDir } from './helpers.js';

async function withBackfill(fn) {
  const dir = await tempDir('qa-backfill-');
  const store = await newStore(dir);
  const capture = new Capture({ store, config: {}, log: () => {} });
  try {
    return await fn({ store, capture });
  } finally {
    try {
      await store.dispose();
    } catch {
      // best effort
    }
    await cleanupDir(dir);
  }
}

function record(id = 'old-1', cwd = 'D:\\demo', extra = {}) {
  return {
    header: {
      id,
      cwd,
      createdAt: Date.now() - 60 * 60 * 1000,
      ...extra,
    },
  };
}

function userEvent(text, time = 1000) {
  return {
    type: 'user/message',
    time,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

function assistantEvent(text, time = 2000) {
  return {
    type: 'assistant/message',
    time,
    data: { message: { content: [{ type: 'text', text }] } },
  };
}

function snapshot(id = 'old-1', cwd = 'D:\\demo', events = []) {
  return { session: { id, cwd }, events };
}

function service({ records = [], snapshots = {} } = {}) {
  return {
    async listSessions() {
      return records;
    },
    async readSession(id) {
      const value = snapshots[id];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

test('backfill reports an unavailable session query service', async () => {
  await withBackfill(async ({ store, capture }) => {
    for (const sessionQuery of [null, {}, { listSessions() {} }]) {
      const result = await backfillSessions({ store, capture, sessionQuery });
      assert.equal(result.ok, false);
      assert.match(result.error, /sessionQuery/);
      assert.equal(result.scanned, 0);
      assert.equal(result.created, 0);
    }
  });
});

test('backfill survives a failing listSessions call', async () => {
  await withBackfill(async ({ store, capture }) => {
    const logs = [];
    const sessionQuery = {
      async listSessions() {
        throw new Error('disk offline');
      },
      async readSession() {},
    };
    const result = await backfillSessions({ store, capture, sessionQuery, log: message => logs.push(message) });
    assert.equal(result.ok, false);
    assert.match(result.error, /disk offline/);
    assert.equal(logs.some(message => /backfill list failed/.test(message)), true);
  });
});

test('backfill continues when one session cannot be read', async () => {
  await withBackfill(async ({ store, capture }) => {
    const sessionQuery = service({
      records: [record('old-1'), record('old-2')],
      snapshots: {
        'old-1': new Error('unreadable'),
        'old-2': snapshot('old-2', 'D:\\demo', [userEvent('运行 up.sh 没有任何反应')]),
      },
    });
    const result = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(result.ok, true);
    assert.equal(result.files, 2);
    assert.equal(result.scanned, 1);
    assert.equal(result.created, 1);
    assert.equal(store.stats().total, 1);
  });
});

test('backfill skips subagents, review sessions and old sessions', async () => {
  await withBackfill(async ({ store, capture }) => {
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const records = [
      record('good'),
      record('sub-origin', 'D:\\demo', { origin: 'subagent' }),
      record('delegated', 'D:\\demo', { delegationDepth: 1 }),
      record('mnemon-review-1'),
      record('old', 'D:\\demo', { createdAt: old }),
      { header: {} },
    ];
    const events = [userEvent('登录接口报错了')];
    const sessionQuery = service({
      records,
      snapshots: {
        good: snapshot('good', 'D:\\demo', events),
        'sub-origin': snapshot('sub-origin', 'D:\\demo', events),
        delegated: snapshot('delegated', 'D:\\demo', events),
      },
    });
    const result = await backfillSessions({ store, capture, sessionQuery, days: 2 });
    assert.equal(result.files, 1, 'only the session inside the window is a candidate');
    assert.equal(result.scanned, 1);
    assert.equal(result.created, 1);
    assert.equal(result.touched.length, 1);
    assert.match(result.touched[0], /^good: \+1$/);
  });
});

test('backfill honors the limit before reading sessions', async () => {
  await withBackfill(async ({ store, capture }) => {
    const records = [record('s1'), record('s2'), record('s3')];
    const sessionQuery = service({
      records,
      snapshots: {
        s1: snapshot('s1', 'D:\\demo', [userEvent('登录接口报错了')]),
        s2: snapshot('s2', 'D:\\demo', [userEvent('订单页面白屏了')]),
        s3: snapshot('s3', 'D:\\demo', [userEvent('上传功能崩溃了')]),
      },
    });
    const result = await backfillSessions({ store, capture, sessionQuery, limit: 2 });
    assert.equal(result.files, 2);
    assert.equal(result.scanned, 2);
    assert.equal(result.created, 2);
  });
});

test('backfill filters sessions by normalized workspace path', async () => {
  await withBackfill(async ({ store, capture }) => {
    const sessionQuery = service({
      records: [record('inside', 'D:\\Demo'), record('outside', 'D:\\Other')],
      snapshots: {
        inside: snapshot('inside', 'D:\\Demo', [userEvent('登录接口报错了')]),
        outside: snapshot('outside', 'D:\\Other', [userEvent('订单页面白屏了')]),
      },
    });
    const result = await backfillSessions({
      store,
      capture,
      sessionQuery,
      workspace: 'd:/demo',
    });
    assert.equal(result.files, 2);
    assert.equal(result.scanned, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.created, 1);
    assert.equal(store.stats('D:\\Demo').total, 1);
  });
});

test('backfill imports user reports, records a stamp and a session title', async () => {
  await withBackfill(async ({ store, capture }) => {
    const events = [
      userEvent('运行 up.sh 没有任何反应', 5000),
      userEvent('另外订单页面白屏了', 6000),
      assistantEvent('已修复登录接口的问题。', 7000),
    ];
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': snapshot('old-1', 'D:\\demo', events) },
    });
    const result = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(result.ok, true);
    assert.equal(result.processed, 3);
    assert.equal(result.created, 2);
    assert.equal(store.stats().total, 2);
    assert.equal(store.backfillStamp('old-1'), 7000);
    assert.equal(capture.sessions.get('old-1').title, '运行 up.sh 没有任何反应');
  });
});

test('backfill applies only resolutions from assistant text, never new defects', async () => {
  await withBackfill(async ({ store, capture }) => {
    const bug = store.create({
      title: '退款回调重复入账，金额翻倍',
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 'old-1',
      status: 'open',
    });
    const events = [
      assistantEvent('发现一个 bug：导出接口没有校验权限。', 5000),
      assistantEvent('已修复退款回调重复入账的问题。', 6000),
    ];
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': snapshot('old-1', 'D:\\demo', events) },
    });
    const result = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(result.created, 0);
    assert.equal(store.stats().total, 1);
    assert.equal(store.get(bug.id).status, 'verify');
  });
});

test('backfill skips an unchanged session on the next run', async () => {
  await withBackfill(async ({ store, capture }) => {
    const events = [userEvent('运行 up.sh 没有任何反应', 5000)];
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': snapshot('old-1', 'D:\\demo', events) },
    });
    const first = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(first.scanned, 1);
    assert.equal(first.created, 1);

    const second = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(second.files, 1);
    assert.equal(second.scanned, 0);
    assert.equal(second.created, 0);
    assert.equal(store.stats().total, 1);
  });
});

test('force rescans even when the stamp is current', async () => {
  await withBackfill(async ({ store, capture }) => {
    const events = [userEvent('运行 up.sh 没有任何反应', 5000)];
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': snapshot('old-1', 'D:\\demo', events) },
    });
    await backfillSessions({ store, capture, sessionQuery });
    const forced = await backfillSessions({ store, capture, sessionQuery, force: true });
    assert.equal(forced.scanned, 1);
    assert.equal(forced.processed, 1);
    assert.equal(forced.created, 0);
  });
});

test('backfill skips a snapshot without a session id', async () => {
  await withBackfill(async ({ store, capture }) => {
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': { session: {}, events: [userEvent('登录接口报错了')] } },
    });
    const result = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 1);
    assert.equal(store.stats().total, 0);
  });
});

test('backfill handles a session with no events', async () => {
  await withBackfill(async ({ store, capture }) => {
    const sessionQuery = service({
      records: [record('old-1')],
      snapshots: { 'old-1': snapshot('old-1', 'D:\\demo', []) },
    });
    const result = await backfillSessions({ store, capture, sessionQuery });
    assert.equal(result.scanned, 1);
    assert.equal(result.processed, 0);
    assert.equal(result.created, 0);
    assert.ok(store.backfillStamp('old-1') > 0);
  });
});