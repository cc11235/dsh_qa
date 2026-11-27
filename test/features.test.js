import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { cleanupDir, newStore, tempDir } from './helpers.js';

function draft(overrides = {}) {
  return {
    title: '退款回调重复入账',
    workspace: 'D:\\demo',
    workspaceName: 'demo',
    sessionId: 's1',
    ...overrides,
  };
}

test('verification passed closes a defect with evidence', async () => {
  const dir = await tempDir('qa-feature-verify-');
  try {
    const store = await newStore(dir);
    const bug = store.create(draft({ status: 'verify' }));
    store.recordVerification({
      id: bug.id,
      outcome: 'passed',
      command: 'npm test -- refund',
      note: '3 tests passed',
      actor: 'human',
    });
    const updated = store.get(bug.id);
    assert.equal(updated.status, 'closed');
    assert.equal(updated.verification.outcome, 'passed');
    assert.equal(updated.evidence.at(-1).kind, 'verification');
    assert.match(updated.evidence.at(-1).excerpt, /npm test/);
  } finally {
    await cleanupDir(dir);
  }
});

test('verification failed returns to progress and cannot-reproduce is terminal', async () => {
  const dir = await tempDir('qa-feature-verify2-');
  try {
    const store = await newStore(dir);
    const failed = store.create(draft({ title: '导出失败' }));
    store.recordVerification({ id: failed.id, outcome: 'failed', note: '仍然失败' });
    assert.equal(store.get(failed.id).status, 'progress');

    const cannot = store.create(draft({ title: '偶现白屏' }));
    store.recordVerification({ id: cannot.id, outcome: 'cannot-reproduce', note: '多次尝试未复现' });
    assert.equal(store.get(cannot.id).status, 'cannot-reproduce');
  } finally {
    await cleanupDir(dir);
  }
});

test('mergeBugs folds duplicates into the master without deleting history', async () => {
  const dir = await tempDir('qa-feature-merge-');
  try {
    const store = await newStore(dir);
    const master = store.create(draft({ title: '退款回调重复入账', tags: ['refund'] }));
    const duplicate = store.create(draft({ title: '退款回调重复入账（重复）', tags: ['billing'] }));
    duplicate.occurrence = 2;
    const result = store.mergeBugs(master.id, [duplicate.id]);
    assert.deepEqual(result.merged, [duplicate.id]);
    const updatedMaster = store.get(master.id);
    const updatedDuplicate = store.get(duplicate.id);
    assert.equal(updatedMaster.occurrence, 3);
    assert.ok(updatedMaster.mergedIds.includes(duplicate.id));
    assert.deepEqual([...updatedMaster.tags].sort(), ['billing', 'refund']);
    assert.equal(updatedDuplicate.status, 'duplicate');
    assert.equal(updatedDuplicate.duplicateOf, master.id);
    assert.equal(updatedDuplicate.evidence.at(-1).kind, 'merge');
  } finally {
    await cleanupDir(dir);
  }
});

test('priority, due date and versions are persisted', async () => {
  const dir = await tempDir('qa-feature-fields-');
  try {
    const store = await newStore(dir);
    const bug = store.create(draft({ priority: 'high', dueAt: '2026-12-01', fixVersion: '1.2.0', foundVersion: '1.1.0' }));
    assert.equal(bug.priority, 'high');
    assert.equal(bug.dueAt, '2026-12-01');
    assert.equal(bug.fixVersion, '1.2.0');
    assert.equal(bug.foundVersion, '1.1.0');
    store.update(bug.id, { priority: 'urgent', dueAt: '2026-12-02' });
    assert.equal(store.get(bug.id).priority, 'urgent');
    assert.equal(store.get(bug.id).dueAt, '2026-12-02');
  } finally {
    await cleanupDir(dir);
  }
});

test('exportData and importData round-trip the board', async () => {
  const firstDir = await tempDir('qa-feature-export-');
  const secondDir = await tempDir('qa-feature-import-');
  try {
    const store = await newStore(firstDir);
    store.create(draft({ title: '登录接口 500', priority: 'high', assignee: 'cc112' }));
    store.create(draft({ title: '导出失败', status: 'closed' }));
    const exported = store.exportData();

    const target = await newStore(secondDir);
    const result = await target.importData(exported);
    assert.equal(result.imported, 2);
    assert.equal(target.list().length, 2);
    assert.equal(target.list().find(item => item.title === '登录接口 500').assignee, 'cc112');
    assert.equal(target.create(draft({ title: '第三只' })).id, 'BUG-0003');
  } finally {
    await cleanupDir(firstDir);
    await cleanupDir(secondDir);
  }
});

test('createBackup keeps the latest seven copies', async () => {
  const dir = await tempDir('qa-feature-backup-');
  try {
    const store = await newStore(dir);
    store.create(draft());
    await store.flush();
    for (let index = 0; index < 9; index += 1) {
      await store.createBackup();
    }
    const files = (await readdir(dir)).filter(name => name.startsWith('data.backup-'));
    assert.equal(files.length, 7);
  } finally {
    await cleanupDir(dir);
  }
});