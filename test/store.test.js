import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BugStore } from '../lib/store.js';
import { analyzeToolResult } from '../lib/extract.js';
import { cleanupDir, newStore, tempDir } from './helpers.js';

async function withStore(fn, prefix = 'qa-store-') {
  const dir = await tempDir(prefix);
  const store = await newStore(dir);
  try {
    return await fn(store, dir);
  } finally {
    try {
      await store.dispose();
    } catch {
      // best effort
    }
    await cleanupDir(dir);
  }
}

function draftInput(overrides = {}) {
  return {
    title: '登录接口 500',
    description: '复现步骤：打开登录页',
    severity: 'critical',
    ...overrides,
  };
}

test('create assigns sequential ids, defaults and a creation history entry', async () => {
  await withStore(async store => {
    const first = store.create(draftInput());
    const second = store.create(draftInput({ title: '导出失败' }));
    assert.equal(first.id, 'BUG-0001');
    assert.equal(second.id, 'BUG-0002');
    assert.equal(first.status, 'open');
    assert.equal(first.source, 'manual');
    assert.equal(first.occurrence, 1);
    assert.equal(first.history.length, 1);
    assert.equal(first.history[0].from, null);
    assert.equal(first.history[0].actor, 'human');
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[0].id, 'BUG-0002');
  });
});

test('create uses 待确认 for automatic captures and normalizes fields', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({
      title: '  多行\n标题  ',
      description: 'x'.repeat(5000),
      severity: 'nope',
      source: 'auto',
      tags: ['a', 1, 'b', 'c'],
    }));
    assert.equal(bug.status, 'new');
    assert.equal(bug.severity, 'major');
    assert.equal(bug.title, '多行 标题');
    assert.equal(bug.description.length, 4000);
    assert.deepEqual(bug.tags, ['a', 'b', 'c']);
    assert.match(bug.signature, /^manual:/);
  });
});

test('create rejects an empty title', async () => {
  await withStore(async store => {
    assert.throws(() => store.create({ title: '   ' }), /缺陷标题不能为空/);
  });
});

test('create clips the title and caps evidence, notes and history', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({ title: 'x'.repeat(300) }));
    assert.equal(bug.title.length, 160);
    for (let index = 0; index < 15; index += 1) {
      store.addEvidence(bug, { kind: 'observation', excerpt: `e${index}` });
    }
    assert.equal(bug.evidence.length, 12);
    assert.equal(bug.evidence.at(-1).excerpt, 'e14');

    for (let index = 0; index < 45; index += 1) {
      store.update(bug.id, {}, { note: `note ${index}` });
    }
    assert.equal(bug.notes.length, 40);
    assert.equal(bug.notes.at(-1).text, 'note 44');

    let status = 'open';
    for (let index = 0; index < 90; index += 1) {
      status = status === 'open' ? 'closed' : 'open';
      store.update(bug.id, { status }, { note: '' });
    }
    assert.equal(bug.history.length, 80);
  });
});

test('update changes editable fields and records activity', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput());
    const before = bug.updatedAt;
    const updated = store.update(bug.id, {
      title: '登录接口 502',
      description: '新描述',
      severity: 'major',
      module: '认证',
      assignee: 'alice',
      tags: ['auth'],
    });
    assert.equal(updated.title, '登录接口 502');
    assert.equal(updated.description, '新描述');
    assert.equal(updated.severity, 'major');
    assert.equal(updated.module, '认证');
    assert.equal(updated.assignee, 'alice');
    assert.deepEqual(updated.tags, ['auth']);
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(before));
    assert.equal(store.activity(null, 10).some(item => item.type === 'updated'), true);
  });
});

test('update ignores blank titles and unknown severity values', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput());
    store.update(bug.id, { title: '   ', severity: 'bogus' });
    assert.equal(bug.title, '登录接口 500');
    assert.equal(bug.severity, 'critical');
  });
});

test('update transitions status, appends history and notes', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput());
    store.update(bug.id, { status: 'progress' }, { actor: 'agent', note: '开始排查' });
    assert.equal(bug.status, 'progress');
    assert.equal(bug.history.length, 2);
    assert.deepEqual(bug.history[1], {
      at: bug.history[1].at,
      from: 'open',
      to: 'progress',
      actor: 'agent',
      note: '开始排查',
    });
    assert.equal(bug.notes.length, 1);
    assert.equal(bug.notes[0].text, '开始排查');

    store.update(bug.id, {}, { actor: 'human', note: '补充说明' });
    assert.equal(bug.notes.length, 2);
    assert.equal(bug.notes[1].text, '补充说明');
    assert.equal(bug.history.length, 2, 'a same-status update must not add history');
    assert.equal(store.activity(null, 20).filter(item => item.type === 'note').length, 2);
  });
});

test('update rejects unknown status and unknown ids', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput());
    assert.throws(() => store.update(bug.id, { status: 'bogus' }), /unknown status/);
    assert.throws(() => store.update('BUG-9999', { title: 'x' }), /未找到缺陷/);
  });
});

test('remove deletes a defect and records activity', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput());
    assert.equal(store.remove(bug.id), true);
    assert.equal(store.get(bug.id), null);
    assert.equal(store.remove(bug.id), false);
    assert.equal(store.activity(null, 5)[0].type, 'deleted');
  });
});

test('removeMany prunes merge links and cleanupTargets filters status and age', async () => {
  await withStore(async store => {
    const master = store.create(draftInput({ title: '主缺陷' }));
    const dup = store.create(draftInput({ title: '重复缺陷' }));
    store.mergeBugs(master.id, [dup.id]);
    const ignored = store.create(draftInput({ title: '忽略缺陷' }));
    store.update(ignored.id, { status: 'ignored' });
    ignored.updatedAt = new Date(Date.now() - 40 * 86400000).toISOString();

    assert.deepEqual(store.cleanupTargets({ scope: 'ignored', days: 30 }).map(bug => bug.id), [ignored.id]);
    assert.deepEqual(store.cleanupTargets({ scope: 'duplicate' }).map(bug => bug.id), [dup.id]);

    const result = store.removeMany([dup.id, ignored.id], { note: '测试清理' });
    assert.equal(result.removed.length, 2);
    assert.equal(store.get(ignored.id), null);
    assert.equal(store.get(master.id).mergedIds.includes(dup.id), false);
    const latest = store.activity(null, 5)[0];
    assert.equal(latest.type, 'deleted');
    assert.match(latest.title, /批量删除 2 条/);

    const otherMaster = store.create(draftInput({ title: '另一个主缺陷' }));
    const otherDup = store.create(draftInput({ title: '另一个重复' }));
    store.mergeBugs(otherMaster.id, [otherDup.id]);
    store.remove(otherMaster.id);
    assert.equal(store.get(otherDup.id).duplicateOf, '');
  });
});

test('stats filters by workspace and counts statuses and severities', async () => {
  await withStore(async store => {
    const a = store.create(draftInput({ workspace: 'D:\\demo', severity: 'critical' }));
    store.create(draftInput({ workspace: 'D:\\demo', title: '小问题', severity: 'minor', status: 'ignored' }));
    store.create(draftInput({ workspace: 'D:\\other', title: '其他项目', severity: 'blocker' }));
    store.update(a.id, { status: 'verify' });

    const scoped = store.stats('D:\\demo');
    assert.equal(scoped.total, 2);
    assert.equal(scoped.open, 0);
    assert.equal(scoped.verify, 1);
    assert.equal(scoped.ignored, 1);
    assert.equal(scoped.byStatus.ignored, 1);
    assert.equal(scoped.bySeverity.critical, 1);
    assert.equal(scoped.bySeverity.minor, 1);
    assert.equal(scoped.todayNew, 2);

    assert.equal(store.stats().total, 3);
  });
});

test('projects groups defects and sorts by latest activity', async () => {
  await withStore(async store => {
    const older = store.create(draftInput({ workspace: 'D:\\demo', workspaceName: 'demo' }));
    store.create(draftInput({ workspace: 'D:\\other', workspaceName: 'other', title: 'x' }));
    older.updatedAt = new Date(Date.now() - 60_000).toISOString();
    older.lastSeenAt = older.updatedAt;
    const projects = store.projects();
    assert.equal(projects[0].path, 'D:\\other');
    const demo = projects.find(project => project.path === 'D:\\demo');
    assert.equal(demo.total, 1);
    assert.equal(demo.active, 1);
    assert.equal(demo.name, 'demo');
  });
});

test('activity is newest-first, workspace-scoped and limited', async () => {
  await withStore(async store => {
    const a = store.create(draftInput({ workspace: 'D:\\demo' }));
    store.create(draftInput({ workspace: 'D:\\other', title: 'other' }));
    store.update(a.id, { status: 'progress' }, { note: '' });
    const items = store.activity('D:\\demo', 10);
    assert.equal(items.every(item => item.workspace === 'D:\\demo'), true);
    assert.equal(items.length, 2);
    assert.equal(items[0].type, 'status');
    assert.equal(store.activity('D:\\demo', 1).length, 1);
  });
});

test('findSimilar matches active defects in the same workspace only', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({ workspace: 'D:\\demo', title: '登录接口 500 报错' }));
    assert.equal(store.findSimilar({ workspace: 'D:\\demo', title: '登录接口 500' }).id, bug.id);
    assert.equal(store.findSimilar({ workspace: 'D:\\other', title: '登录接口 500' }), null);
    store.update(bug.id, { status: 'closed' });
    assert.equal(store.findSimilar({ workspace: 'D:\\demo', title: '登录接口 500' }), null);
    store.update(bug.id, { status: 'verify' });
    assert.equal(store.findSimilar({ workspace: 'D:\\demo', title: '登录接口 500' }).id, bug.id);
  });
});

test('recordUserReport creates a user defect and merges a same-session repeat', async () => {
  await withStore(async store => {
    const base = {
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '没有反应' },
    };
    const first = store.recordUserReport({
      ...base,
      draft: { title: 'script/up.sh 没有启动 8110', description: 'up.sh 没启动', severity: 'critical' },
    });
    assert.equal(first.created, true);
    assert.equal(first.bug.source, 'user');
    assert.equal(first.bug.status, 'open');
    assert.equal(first.reopened, false);

    const second = store.recordUserReport({
      ...base,
      draft: { title: '运行 up.sh 还是没有任何反应', description: '还是没反应', severity: 'critical' },
    });
    assert.equal(second.created, false);
    assert.equal(second.bug.id, first.bug.id);
    assert.equal(second.bug.occurrence, 2);
    assert.equal(second.bug.evidence.length, 2);
  });
});

test('recordUserReport reopens a closed defect and tracks the transition', async () => {
  await withStore(async store => {
    const base = {
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '日志系统',
      evidence: { kind: 'user-report', excerpt: '又不行了' },
    };
    const first = store.recordUserReport({
      ...base,
      draft: { title: '运行 up.sh 没有任何反应', description: 'x', severity: 'critical' },
    });
    store.update(first.bug.id, { status: 'closed' }, { actor: 'user', note: '用户确认' });
    const again = store.recordUserReport({
      ...base,
      draft: { title: '运行 up.sh 又没有反应了', description: '回归', severity: 'critical' },
    });
    assert.equal(again.created, false);
    assert.equal(again.reopened, true);
    assert.equal(again.bug.status, 'open');
    assert.equal(again.bug.occurrence, 2);
  });
});

test('recordUserReport keeps workspaces apart and replaces ignored candidates', async () => {
  await withStore(async store => {
    const base = { sessionId: 's1', sessionTitle: 't', evidence: { kind: 'user-report' } };
    const demo = store.recordUserReport({
      ...base,
      workspace: 'D:\\demo',
      draft: { title: '登录接口 500', severity: 'critical' },
    });
    const other = store.recordUserReport({
      ...base,
      workspace: 'D:\\other',
      draft: { title: '登录接口 500', severity: 'critical' },
    });
    assert.notEqual(demo.bug.id, other.bug.id);

    store.update(demo.bug.id, { status: 'ignored' });
    const fresh = store.recordUserReport({
      ...base,
      workspace: 'D:\\demo',
      draft: { title: '登录接口 500', severity: 'critical' },
    });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.bug.id, demo.bug.id);
  });
});

test('recordToolFailure dedupes by signature, reopens and keeps evidence', async () => {
  await withStore(async store => {
    const draft = analyzeToolResult({
      tool: 'ops_bash',
      args: { command: 'npm test' },
      text: 'FAIL src/login.test.ts\nTests: 1 failed, 2 passed\n[exit code: 1]',
      isError: true,
    });
    assert.ok(draft);
    const base = {
      draft,
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '修复登录',
      evidence: { kind: 'tool-error', excerpt: draft.excerpt, tool: 'ops_bash' },
    };
    const first = store.recordToolFailure(base);
    assert.equal(first.created, true);
    assert.equal(first.bug.status, 'new');
    assert.equal(first.bug.source, 'auto');

    const second = store.recordToolFailure({ ...base, evidence: { ...base.evidence } });
    assert.equal(second.created, false);
    assert.equal(second.bug.occurrence, 2);
    assert.equal(second.bug.evidence.length, 2);

    store.update(first.bug.id, { status: 'closed' });
    const third = store.recordToolFailure(base);
    assert.equal(third.reopened, true);
    assert.equal(third.bug.status, 'open');
    assert.equal(third.bug.history.at(-1).note, '缺陷再次出现，已自动重新打开');
  });
});

test('recordAssistantBug merges a similar active defect but not a closed one', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      title: '退款回调重复入账，订单金额翻倍',
    }));
    const merged = store.recordAssistantBug({
      draft: { title: '退款回调重复入账，金额翻倍', description: 'x', severity: 'major' },
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      evidence: { kind: 'assistant-text', excerpt: 'x' },
    });
    assert.equal(merged.created, false);
    assert.equal(merged.bug.id, bug.id);
    assert.equal(merged.bug.occurrence, 2);

    store.update(bug.id, { status: 'closed' });
    const fresh = store.recordAssistantBug({
      draft: { title: '退款回调重复入账，金额翻倍', description: 'x', severity: 'major' },
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      evidence: { kind: 'assistant-text', excerpt: 'x' },
    });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.bug.id, bug.id);
  });
});

test('assignModule picks the most recent unclassified active defect', async () => {
  await withStore(async store => {
    const first = store.recordUserReport({
      draft: { title: '运行 up.sh 没有任何反应', severity: 'critical' },
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: 't',
      evidence: { kind: 'user-report' },
    });
    const second = store.recordUserReport({
      draft: { title: '订单页面白屏', severity: 'major' },
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: 't',
      evidence: { kind: 'user-report' },
    });
    first.bug.updatedAt = new Date(Date.now() - 60_000).toISOString();
    second.bug.updatedAt = new Date().toISOString();
    const assigned = store.assignModule({ workspace: 'D:\\demo', sessionId: 's1', module: 'scripts' });
    assert.equal(assigned.id, second.bug.id);
    assert.equal(second.bug.module, 'scripts');
    assert.equal(first.bug.module, '');

    assert.equal(store.assignModule({ workspace: 'D:\\demo', sessionId: 's1', module: 'x' }).id, first.bug.id);
    assert.equal(store.assignModule({ workspace: 'D:\\demo', sessionId: 's1', module: 'y' }), null);
    assert.equal(store.assignModule({ workspace: 'D:\\demo', sessionId: 's1', module: '   ' }), null);
  });
});

test('noteFixActivity prefers a module match, then an unclassified defect', async () => {
  await withStore(async store => {
    const withModule = store.create(draftInput({ workspace: 'D:\\demo', sessionId: 's1', module: '认证' }));
    const plain = store.create(draftInput({ workspace: 'D:\\demo', sessionId: 's1', title: '未归类缺陷' }));
    const matched = store.noteFixActivity({ workspace: 'D:\\demo', sessionId: 's1', module: '认证' });
    assert.equal(matched.id, withModule.id);
    assert.equal(withModule.status, 'progress');

    const unclassified = store.noteFixActivity({ workspace: 'D:\\demo', sessionId: 's1', module: '其他' });
    assert.equal(unclassified.id, plain.id);
    assert.equal(plain.module, '其他');
    assert.equal(plain.status, 'progress');
  });
});

test('noteFixActivity does not pick finished or stale defects', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({ workspace: 'D:\\demo', sessionId: 's1' }));
    store.update(bug.id, { status: 'verify' });
    assert.equal(store.noteFixActivity({ workspace: 'D:\\demo', sessionId: 's1' }), null);

    store.update(bug.id, { status: 'open' });
    bug.updatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    assert.equal(store.noteFixActivity({ workspace: 'D:\\demo', sessionId: 's1', maxAgeMs: 60_000 }), null);
  });
});

test('markVerifiedByRerun moves an automatic defect to 待验证', async () => {
  await withStore(async store => {
    const draft = analyzeToolResult({
      tool: 'ops_bash',
      args: { command: 'npm test' },
      text: 'Tests: 1 failed, 2 passed\n[exit code: 1]',
      isError: true,
    });
    const result = store.recordToolFailure({
      draft,
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: 't',
      evidence: { excerpt: draft.excerpt, tool: 'ops_bash' },
    });
    const verified = store.markVerifiedByRerun({
      workspace: 'D:\\demo',
      trigger: draft.trigger,
      tool: 'ops_bash',
      sessionId: 's1',
    });
    assert.equal(verified.id, result.bug.id);
    assert.equal(verified.status, 'verify');
    assert.equal(verified.evidence.at(-1).kind, 'rerun-ok');

    assert.equal(store.markVerifiedByRerun({
      workspace: 'D:\\demo',
      trigger: { key: 'other' },
      tool: 'ops_bash',
      sessionId: 's1',
    }), null);
    assert.equal(store.markVerifiedByRerun({
      workspace: 'D:\\demo',
      trigger: null,
      tool: 'ops_bash',
      sessionId: 's1',
    }), null);
  });
});

test('findResolutionTarget needs a matching snippet and boosts the same session', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({
      workspace: 'D:\\demo',
      sessionId: 's1',
      title: '业务明细和日志总量为什么都是0',
    }));
    assert.equal(store.findResolutionTarget({
      workspace: 'D:\\demo',
      sessionId: 's1',
      snippet: '## 已修复',
    }), null);
    const matched = store.findResolutionTarget({
      workspace: 'D:\\demo',
      sessionId: 's1',
      snippet: '已修复业务明细和日志总量为0的问题',
    });
    assert.equal(matched.id, bug.id);
    assert.equal(store.findResolutionTarget({
      workspace: 'D:\\other',
      sessionId: 's1',
      snippet: '已修复业务明细和日志总量为0的问题',
    }), null);
  });
});

test('backfill stamps are numeric and oldest entries are evicted', async () => {
  await withStore(async store => {
    assert.equal(store.backfillStamp('missing'), 0);
    store.markBackfilled('session-1', 1234);
    assert.equal(store.backfillStamp('session-1'), 1234);
    for (let index = 0; index < 505; index += 1) {
      store.markBackfilled(`session-${index}`, index + 1);
    }
    const keys = Object.keys(store.data.backfill);
    assert.equal(keys.length, 500);
    assert.equal(store.data.backfill['session-0'], undefined);
  });
});

test('persistence survives a flush and reload', async () => {
  const dir = await tempDir('qa-store-persist-');
  try {
    const file = path.join(dir, 'data.json');
    const store = await new BugStore({ filePath: file, log: () => {} }).load();
    const bug = store.create(draftInput({ tags: ['auth'] }));
    store.update(bug.id, { status: 'progress' }, { note: '开始排查' });
    await store.flush();

    const reloaded = await new BugStore({ filePath: file, log: () => {} }).load();
    const loaded = reloaded.get(bug.id);
    assert.equal(loaded.status, 'progress');
    assert.equal(loaded.notes.length, 1);
    assert.deepEqual(loaded.tags, ['auth']);
    assert.equal(reloaded.stats().total, 1);
    await reloaded.dispose();
  } finally {
    await cleanupDir(dir);
  }
});

test('dispose flushes a pending debounced write', async () => {
  const dir = await tempDir('qa-store-dispose-');
  try {
    const file = path.join(dir, 'data.json');
    const store = await new BugStore({ filePath: file, log: () => {} }).load();
    store.create(draftInput());
    await store.dispose();
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.bugs.length, 1);
  } finally {
    await cleanupDir(dir);
  }
});

test('load repairs malformed records and keeps the id sequence', async () => {
  const dir = await tempDir('qa-store-load-');
  try {
    const file = path.join(dir, 'data.json');
    await writeFile(file, JSON.stringify({
      version: 1,
      seq: 0,
      bugs: [{
        id: 'BUG-0007',
        title: '  多行\n标题  ',
        description: 42,
        status: 'bogus',
        severity: 'bogus',
        source: 'bogus',
        createdAt: 'not-a-date',
        tags: [1, 'ok'],
        evidence: [null, { kind: 'observation', excerpt: 'e' }],
        history: [null, { from: null, to: 'open' }],
        notes: [null],
      }],
      activity: [null],
      backfill: 'bad',
    }), 'utf8');

    const store = await new BugStore({ filePath: file, log: () => {} }).load();
    const bug = store.get('BUG-0007');
    assert.equal(bug.title, '多行 标题');
    assert.equal(bug.description, '42');
    assert.equal(bug.status, 'new');
    assert.equal(bug.severity, 'major');
    assert.equal(bug.source, 'manual');
    assert.deepEqual(bug.tags, ['ok']);
    assert.equal(bug.evidence.length, 1);
    assert.equal(bug.history.length, 1);
    assert.equal(store.stats().total, 1);
    assert.equal(store.create(draftInput()).id, 'BUG-0008');
    await store.dispose();
  } finally {
    await cleanupDir(dir);
  }
});

test('load starts empty for invalid JSON instead of crashing', async () => {
  const dir = await tempDir('qa-store-corrupt-');
  try {
    const file = path.join(dir, 'data.json');
    await writeFile(file, '{not json', 'utf8');
    const store = await new BugStore({ filePath: file, log: () => {} }).load();
    assert.equal(store.stats().total, 0);
    assert.equal(store.list().length, 0);
    await store.dispose();
  } finally {
    await cleanupDir(dir);
  }
});

test('subscribers are notified once per debounced burst', async () => {
  await withStore(async store => {
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.create(draftInput());
    store.create(draftInput({ title: '第二个' }));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(calls, 1);
    unsubscribe();
    store.create(draftInput({ title: '第三个' }));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(calls, 1);
  });
});

test('mute rules suppress matching captures, count hits and expire', async () => {
  await withStore(async store => {
    const draft = analyzeToolResult({
      tool: 'ops_bash',
      args: { command: 'npm test' },
      text: 'FAIL src/login.test.ts\nTests: 1 failed, 2 passed\n[exit code: 1]',
      isError: true,
    });
    assert.ok(draft);
    const base = {
      draft,
      workspace: 'D:\\\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      sessionTitle: '修复登录',
      evidence: { kind: 'tool-error', excerpt: draft.excerpt, tool: 'ops_bash' },
    };
    const rule = store.createMuteRule({
      workspace: base.workspace,
      signature: draft.signature,
      tool: 'ops_bash',
      days: 30,
    });
    assert.equal(rule.id, 'MUTE-0001');
    assert.ok(rule.expiresAt);

    const muted = store.recordToolFailure(base);
    assert.equal(muted.muted, true);
    assert.equal(muted.bug, null);
    assert.equal(store.list().length, 0);
    assert.equal(store.listMuteRules()[0].hits, 1);

    const blocker = store.recordToolFailure({ ...base, draft: { ...draft, severity: 'blocker' } });
    assert.equal(blocker.muted, undefined);
    assert.equal(store.list().length, 1);

    const expiring = store.createMuteRule({ workspace: 'D:\\\\demo', signature: 'tool:expired', days: 1 });
    expiring.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(store.matchMuteRule({ workspace: 'D:\\\\demo', signature: 'tool:expired' }), null);
    assert.equal(store.listMuteRules({ includeExpired: true }).some(item => item.id === expiring.id), false);
  });
});

test('requestClose defers closing for 24 hours and blockers wait for a human', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({ title: '普通缺陷', severity: 'major' }));
    const deferred = store.requestClose(bug, { actor: 'agent', note: '测试通过' });
    assert.equal(deferred.mode, 'deferred');
    assert.equal(bug.status, 'verify');
    assert.ok(bug.autoCloseAt);
    assert.equal(store.sweepAutoClose(), 0);
    assert.equal(store.sweepAutoClose({ now: Date.now() + 25 * 3600000 }), 1);
    assert.equal(bug.status, 'closed');
    assert.equal(bug.autoCloseAt, '');
    assert.equal(bug.evidence.at(-1).kind, 'auto-close');

    const blocker = store.create(draftInput({ title: '致命缺陷', severity: 'blocker' }));
    const confirm = store.requestClose(blocker, { actor: 'agent' });
    assert.equal(confirm.mode, 'confirm');
    assert.equal(blocker.status, 'verify');
    assert.equal(blocker.autoCloseAt, '');
    assert.equal(store.sweepAutoClose({ now: Date.now() + 48 * 3600000 }), 0);
    assert.equal(blocker.status, 'verify');
  });
});

test('a human touch cancels the quiet window and undo reverts the last status', async () => {
  await withStore(async store => {
    const bug = store.create(draftInput({ title: '撤销测试', severity: 'major' }));
    store.update(bug.id, { status: 'progress' }, { actor: 'agent' });
    store.requestClose(bug, { actor: 'agent' });
    assert.ok(bug.autoCloseAt);

    store.update(bug.id, {}, { actor: 'human', note: '先别关，我再看看' });
    assert.equal(bug.autoCloseAt, '');
    assert.equal(store.sweepAutoClose({ now: Date.now() + 48 * 3600000 }), 0);

    const undone = store.undoStatus(bug.id, { actor: 'human' });
    assert.equal(undone.status, 'progress');
    assert.equal(undone.history.at(-1).undo, true);
  });
});

test('pendingSummary reports actionable work and mute rules survive reload', async () => {
  await withStore(async (store, dir) => {
    store.create(draftInput({ title: '待分诊', source: 'auto' }));
    const verify = store.create(draftInput({ title: '待验证' }));
    store.requestClose(verify, { actor: 'agent' });
    const stale = store.create(draftInput({ title: '停滞' }));
    store.update(stale.id, { status: 'progress' }, { actor: 'agent' });
    stale.updatedAt = new Date(Date.now() - 5 * 86400000).toISOString();
    store.create(draftInput({ title: '致命', severity: 'blocker' }));

    const pending = store.pendingSummary('');
    assert.equal(pending.untriaged.count, 1);
    assert.equal(pending.pendingVerify.count, 1);
    assert.equal(pending.staleProgress.count, 1);
    assert.equal(pending.blockers.count, 1);

    store.createMuteRule({ workspace: '', signature: 'tool:abc', days: 30 });
    await store.flush();
    const reloaded = await new BugStore({ filePath: path.join(dir, 'data.json'), log: () => {} }).load();
    assert.equal(reloaded.listMuteRules().length, 1);
    assert.equal(reloaded.list().length, 4);
    await reloaded.dispose();
  });
});