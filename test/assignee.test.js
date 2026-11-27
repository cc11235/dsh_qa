import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { BugStore } from '../lib/store.js';
import { cleanupDir, tempDir } from './helpers.js';

test('default assignee follows source: bot for automatic, owner for human', async () => {
  const dir = await tempDir('qa-assignee-');
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json'), owner: 'alice', log: () => {} }).load();
    const auto = store.create({ title: '自动捕获的缺陷', source: 'auto' });
    const agent = store.create({ title: 'Agent 发现的缺陷', source: 'agent' });
    const user = store.create({ title: '用户反馈的缺陷', source: 'user' });
    const manual = store.create({ title: '人工新建的缺陷', source: 'manual' });
    const explicit = store.create({ title: '显式指定的缺陷', source: 'auto', assignee: 'carol' });
    assert.equal(auto.assignee, 'bot');
    assert.equal(agent.assignee, 'bot');
    assert.equal(user.assignee, 'alice');
    assert.equal(manual.assignee, 'alice');
    assert.equal(explicit.assignee, 'carol');
  } finally {
    await cleanupDir(dir);
  }
});

test('assignDefaultOwners fills empty historical assignees by source', async () => {
  const dir = await tempDir('qa-assignee-fill-');
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json'), owner: 'alice', log: () => {} }).load();
    const auto = store.create({ title: '自动缺陷', source: 'auto' });
    const user = store.create({ title: '用户缺陷', source: 'user' });
    auto.assignee = '';
    user.assignee = '';
    assert.equal(store.assignDefaultOwners(), 2);
    assert.equal(auto.assignee, 'bot');
    assert.equal(user.assignee, 'alice');
  } finally {
    await cleanupDir(dir);
  }
});

test('merge inherits the duplicate assignee when the master is empty', async () => {
  const dir = await tempDir('qa-assignee-merge-');
  try {
    const store = await new BugStore({ filePath: path.join(dir, 'data.json'), owner: 'alice', log: () => {} }).load();
    const master = store.create({ title: '主缺陷', source: 'manual' });
    const duplicate = store.create({ title: '重复缺陷', source: 'manual', assignee: 'carol' });
    master.assignee = '';
    store.mergeBugs(master.id, [duplicate.id]);
    assert.equal(master.assignee, 'carol');
  } finally {
    await cleanupDir(dir);
  }
});