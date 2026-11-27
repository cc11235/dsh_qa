import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../index.js';
import { cleanupDir, invokeRoute, makeContext, routeOf, tempDir } from './helpers.js';

async function withApi(fn, config = {}) {
  const dir = await tempDir('qa-api-');
  const { ctx, routes, cleanup } = makeContext();
  await apply(ctx, {
    dataDir: dir,
    autoCapture: false,
    backfillOnStart: false,
    ...config,
  });
  try {
    return await fn({ dir, routes });
  } finally {
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 120));
    await cleanupDir(dir);
  }
}

function jsonBody(value) {
  return JSON.stringify(value);
}

test('state returns a complete snapshot with loopback and same-origin requests', async () => {
  await withApi(async ({ routes }) => {
    const state = routeOf(routes, '/state');
    const { res } = await invokeRoute(state);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /application\/json/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const snapshot = res.json;
    assert.equal(snapshot.ok, true);
    assert.equal(typeof snapshot.currentUser, 'string');
    assert.ok(snapshot.currentUser.length > 0);
    assert.deepEqual(snapshot.bugs, []);
    assert.equal(snapshot.stats.total, 0);
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.activity, []);
    assert.ok(snapshot.updatedAt);

    const sameOrigin = await invokeRoute(state, { headers: { origin: 'http://127.0.0.1:50739' } });
    assert.equal(sameOrigin.res.statusCode, 200);
  });
});

test('state rejects non-loopback, cross-site, foreign-origin and foreign-host requests', async () => {
  await withApi(async ({ routes }) => {
    const state = routeOf(routes, '/state');
    const cases = [
      { remoteAddress: '10.0.0.8' },
      { headers: { 'sec-fetch-site': 'cross-site' } },
      { headers: { origin: 'http://evil.example' } },
      { headers: { origin: 'null' } },
      { host: 'evil.example:50739' },
    ];
    for (const options of cases) {
      const { res } = await invokeRoute(state, options);
      assert.equal(res.statusCode, 403, JSON.stringify(options));
      assert.equal(res.json.ok, false);
    }
  });
});

test('state rejects non-GET methods', async () => {
  await withApi(async ({ routes }) => {
    const { res } = await invokeRoute(routeOf(routes, '/state'), { method: 'POST', body: '{}' });
    assert.equal(res.statusCode, 405);
  });
});

test('health reports the plugin, defect count and missing client registry', async () => {
  await withApi(async ({ routes }) => {
    const { res } = await invokeRoute(routeOf(routes, '/health'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.plugin, 'qa-guardian');
    assert.equal(res.json.bugs, 0);
    assert.equal(res.json.client, null);
  });
});

test('action create stores a human defect and it appears in state', async () => {
  await withApi(async ({ routes }) => {
    const response = await invokeRoute(routeOf(routes, '/action'), {
      method: 'POST',
      body: jsonBody({
        action: 'create',
        title: '  登录接口 500  ',
        description: '复现步骤',
        severity: 'critical',
        workspace: 'D:\\demo',
        tags: ['auth'],
      }),
    });
    assert.equal(response.res.statusCode, 200);
    const created = response.res.json;
    assert.equal(created.ok, true);
    assert.equal(created.bug.id, 'BUG-0001');
    assert.equal(created.bug.title, '登录接口 500');
    assert.equal(created.bug.source, 'manual');
    assert.equal(created.bug.status, 'open');
    assert.equal(created.bug.workspaceName, 'demo');

    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.bugs.length, 1);
    assert.equal(state.stats.total, 1);
    assert.equal(state.projects[0].name, 'demo');
  });
});

test('action create falls back to the latest workspace and defaults severity', async () => {
  await withApi(async ({ routes }) => {
    const { res } = await invokeRoute(routeOf(routes, '/action'), {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '匿名缺陷', severity: 'bogus' }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.bug.severity, 'major');
    assert.equal(res.json.bug.workspace, '');
    assert.equal(res.json.bug.workspaceName, '未归类');
  });
});

test('action create rejects an empty title', async () => {
  await withApi(async ({ routes }) => {
    const { res } = await invokeRoute(routeOf(routes, '/action'), {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '   ' }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /缺陷标题不能为空/);
  });
});

test('action update edits fields and transitions status', async () => {
  await withApi(async ({ routes, dir }) => {
    const action = routeOf(routes, '/action');
    const created = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500', workspace: 'D:\\demo' }),
    })).res.json.bug;
    const { res } = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({
        action: 'update',
        id: created.id,
        title: '登录接口 502',
        severity: 'major',
        module: '认证',
        status: 'progress',
        note: '开始排查',
      }),
    });
    assert.equal(res.statusCode, 200);
    const bug = res.json.bug;
    assert.equal(bug.title, '登录接口 502');
    assert.equal(bug.severity, 'major');
    assert.equal(bug.module, '认证');
    assert.equal(bug.status, 'progress');
    assert.equal(bug.notes.length, 1);
    assert.equal(bug.history.at(-1).to, 'progress');
    assert.ok(dir);
  });
});

test('action update rejects unknown ids and invalid statuses', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const missing = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'update', id: 'BUG-9999', title: 'x' }),
    });
    assert.equal(missing.res.statusCode, 400);
    assert.match(missing.res.json.error, /未找到缺陷/);

    const created = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500' }),
    })).res.json.bug;
    const invalid = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'update', id: created.id, status: 'bogus' }),
    });
    assert.equal(invalid.res.statusCode, 400);
    assert.match(invalid.res.json.error, /unknown status/);
  });
});

test('action note appends a note without changing status', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const created = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500' }),
    })).res.json.bug;
    const { res } = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'note', id: created.id, note: '补充说明' }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.bug.status, 'open');
    assert.equal(res.json.bug.notes[0].text, '补充说明');
  });
});

test('action bulk updates selected defects and reports missing ids', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const first = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500' }),
    })).res.json.bug;
    const second = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '订单白屏' }),
    })).res.json.bug;
    const { res } = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({
        action: 'bulk',
        ids: [first.id, second.id, first.id, 'BUG-9999'],
        status: 'closed',
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.updated, 2);
    assert.deepEqual(res.json.missing, ['BUG-9999']);
    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.bugs.every(bug => bug.status === 'closed'), true);
  });
});

test('action bulk validates its inputs', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const empty = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'bulk', ids: [], status: 'closed' }),
    });
    assert.equal(empty.res.statusCode, 400);
    assert.match(empty.res.json.error, /未选择缺陷/);

    const invalid = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'bulk', ids: ['BUG-0001'], status: 'bogus' }),
    });
    assert.equal(invalid.res.statusCode, 400);
    assert.match(invalid.res.json.error, /无效的目标状态/);
  });
});

test('action delete removes a defect and reports missing ids', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const created = (await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500' }),
    })).res.json.bug;
    const deleted = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'delete', id: created.id }),
    });
    assert.equal(deleted.res.statusCode, 200);
    assert.equal(deleted.res.json.ok, true);

    const missing = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'delete', id: created.id }),
    });
    assert.equal(missing.res.statusCode, 404);
    assert.equal(missing.res.json.ok, false);
  });
});

test('action rejects unknown actions, bad methods and foreign origins', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const unknown = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'nope' }),
    });
    assert.equal(unknown.res.statusCode, 400);
    assert.match(unknown.res.json.error, /未知操作/);

    const wrongMethod = await invokeRoute(action, { method: 'GET' });
    assert.equal(wrongMethod.res.statusCode, 405);

    const foreign = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: 'x' }),
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(foreign.res.statusCode, 403);
  });
});

test('action rejects malformed JSON and oversized bodies', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const malformed = await invokeRoute(action, { method: 'POST', body: '{bad json' });
    assert.equal(malformed.res.statusCode, 400);
    assert.equal(malformed.res.json.ok, false);

    const oversized = await invokeRoute(action, {
      method: 'POST',
      body: JSON.stringify({ action: 'create', title: 'x'.repeat(11 * 1024 * 1024) }),
    });
    assert.equal(oversized.res.statusCode, 400);
    assert.match(oversized.res.json.error, /请求体过大/);
  });
});

test('events streams a hello frame and pushes a change after a mutation', async () => {
  await withApi(async ({ routes }) => {
    const events = routeOf(routes, '/events');
    const { req, res } = await invokeRoute(events, { open: true });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    assert.match(res.body, /retry: 3000/);
    assert.match(res.body, /event: hello/);

    const created = await invokeRoute(routeOf(routes, '/action'), {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '登录接口 500' }),
    });
    assert.equal(created.res.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.match(res.body, /event: change/);
    assert.match(res.body, /"total":1/);
    req.emit('close');
  });
});

test('events validates method and loopback origin', async () => {
  await withApi(async ({ routes }) => {
    const events = routeOf(routes, '/events');
    const foreign = await invokeRoute(events, {
      open: true,
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(foreign.res.statusCode, 403);
    const wrongMethod = await invokeRoute(events, { method: 'POST', body: '{}' });
    assert.equal(wrongMethod.res.statusCode, 405);
  });
});

test('action and state share one in-memory store', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    for (let index = 0; index < 3; index += 1) {
      const { res } = await invokeRoute(action, {
        method: 'POST',
        body: jsonBody({ action: 'create', title: `缺陷 ${index}` }),
      });
      assert.equal(res.statusCode, 200);
    }
    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.bugs.length, 3);
    assert.equal(state.stats.open, 3);
  });
});
test('action verify closes a defect and action merge marks duplicates', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const first = (await invokeRoute(action, { method: 'POST', body: jsonBody({ action: 'create', title: '退款回调重复入账', workspace: 'D:\\demo' }) })).res.json.bug;
    const second = (await invokeRoute(action, { method: 'POST', body: jsonBody({ action: 'create', title: '退款回调重复入账（重复）', workspace: 'D:\\demo' }) })).res.json.bug;

    const merged = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'merge', masterId: first.id, duplicateIds: [second.id] }),
    });
    assert.equal(merged.res.statusCode, 200);
    assert.deepEqual(merged.res.json.merged, [second.id]);

    const verified = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'verify', id: first.id, outcome: 'passed', command: 'npm test' }),
    });
    assert.equal(verified.res.statusCode, 200);
    assert.equal(verified.res.json.bug.status, 'closed');

    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.bugs.find(bug => bug.id === second.id).status, 'duplicate');
    assert.equal(state.bugs.find(bug => bug.id === second.id).duplicateOf, first.id);
  });
});

test('export route returns JSON, CSV and Markdown; action import restores it', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    await invokeRoute(action, { method: 'POST', body: jsonBody({ action: 'create', title: '登录接口 500', workspace: 'D:\\demo' }) });
    const jsonExport = await invokeRoute(routeOf(routes, '/export'), { url: '/export?format=json', headers: { host: '127.0.0.1:50739' } });
    assert.equal(jsonExport.res.statusCode, 200);
    assert.match(jsonExport.res.headers['Content-Type'], /application\/json/);
    const data = JSON.parse(jsonExport.res.body);
    assert.equal(data.bugs.length, 1);

    const csv = await invokeRoute(routeOf(routes, '/export'), { url: '/export?format=csv', headers: { host: '127.0.0.1:50739' } });
    assert.equal(csv.res.statusCode, 200);
    assert.match(csv.res.headers['Content-Type'], /text\/csv/);
    assert.match(csv.res.body, /登录接口 500/);

    const md = await invokeRoute(routeOf(routes, '/export'), { url: '/export?format=md', headers: { host: '127.0.0.1:50739' } });
    assert.equal(md.res.statusCode, 200);
    assert.match(md.res.headers['Content-Type'], /text\/markdown/);
    assert.match(md.res.body, /QA 缺陷导出/);

    await invokeRoute(action, { method: 'POST', body: jsonBody({ action: 'create', title: '导出失败', workspace: 'D:\\demo' }) });
    const imported = await invokeRoute(action, { method: 'POST', body: jsonBody({ action: 'import', data }) });
    assert.equal(imported.res.statusCode, 200);
    assert.equal(imported.res.json.imported, 1);
    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.bugs.length, 1);
  });
});

test('action mute creates a rule, ignores the defect and unmute removes it', async () => {
  await withApi(async ({ routes }) => {
    const action = routeOf(routes, '/action');
    const created = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'create', title: '重复误报', severity: 'major', workspace: 'D:\\\\demo' }),
    });
    const id = created.res.json.bug.id;

    const muted = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'mute', id, days: 30, ignore: true }),
    });
    assert.equal(muted.res.statusCode, 200);
    assert.equal(muted.res.json.rule.id, 'MUTE-0001');
    assert.ok(muted.res.json.rule.expiresAt);

    const state = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(state.muteRules.length, 1);
    assert.equal(state.bugs.find(bug => bug.id === id).status, 'ignored');

    const off = await invokeRoute(action, {
      method: 'POST',
      body: jsonBody({ action: 'unmute', ruleId: 'MUTE-0001' }),
    });
    assert.equal(off.res.statusCode, 200);
    const after = (await invokeRoute(routeOf(routes, '/state'))).res.json;
    assert.equal(after.muteRules.length, 0);
  });
});
