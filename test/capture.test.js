import assert from 'node:assert/strict';
import test from 'node:test';
import { Capture, describeCall } from '../lib/capture.js';
import { fakeSession, makeContext, userMessage } from './helpers.js';
import { cleanupDir, newStore, tempDir } from './helpers.js';

async function withCapture(fn, config = {}) {
  const dir = await tempDir('qa-capture-');
  const store = await newStore(dir);
  const capture = new Capture({ store, config, log: () => {} });
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

function toolCall(callId, name, args, time = Date.now(), seq = 1) {
  return {
    data: { callId, name, arguments: JSON.stringify(args) },
    time,
    seq,
  };
}

function toolResult(callId, text, isError = false, time = Date.now(), seq = 1) {
  return {
    data: {
      message: {
        toolCallId: callId,
        isError,
        content: [{ type: 'text', text }],
      },
    },
    time,
    seq,
  };
}

test('ensure derives workspace and title from the session', async () => {
  await withCapture(async ({ capture }) => {
    const session = fakeSession({ id: 's1', cwd: 'D:\\demo', title: '日志系统' });
    const tracker = capture.ensure(session);
    assert.equal(tracker.id, 's1');
    assert.equal(tracker.workspace, 'D:\\demo');
    assert.equal(tracker.workspaceName, 'demo');
    assert.equal(tracker.title, '日志系统');
    assert.equal(capture.latestWorkspace(), 'D:\\demo');
    assert.deepEqual(capture.summary(), [{
      id: 's1',
      title: '日志系统',
      workspace: 'D:\\demo',
      workspaceName: 'demo',
    }]);
  });
});

test('ensure returns the same tracker and updates the latest workspace', async () => {
  await withCapture(async ({ capture }) => {
    const first = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    assert.equal(capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' })), first);
    capture.ensure(fakeSession({ id: 's2', cwd: 'D:\\other' }));
    assert.equal(capture.latestWorkspace(), 'D:\\other');
    assert.equal(capture.summary().length, 2);
  });
});

test('session events update title, turn counters and clear disposed sessions', async () => {
  const { ctx, listeners } = makeContext();
  await withCapture(async ({ store, capture }) => {
    capture.attach(ctx);
    const session = fakeSession({ id: 's1', cwd: 'D:\\demo' });
    listeners.get('session/created')[0](session);
    listeners.get('session/event')[0](session, {
      type: 'session/title',
      data: { title: '新标题' },
      time: Date.now(),
    });
    assert.equal(capture.summary()[0].title, '新标题');

    listeners.get('session/event')[0](session, {
      type: 'turn/start',
      data: { turn: 4 },
      time: Date.now(),
    });
    assert.equal(capture.sessions.get('s1').turn, 4);
    assert.equal(capture.sessions.get('s1').createdThisTurn, 0);
    assert.equal(store.stats().total, 0);

    listeners.get('session/disposed')[0](session);
    assert.equal(capture.summary().length, 0);
  });
});

test('captures a tool failure with evidence and dedupes repeats', async () => {
  await withCapture(async ({ store, capture }) => {
    const session = fakeSession({ id: 's1', cwd: 'D:\\demo' });
    const tracker = capture.ensure(session);
    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'npm test' }, Date.now(), 7));
    capture.onToolResult(tracker, toolResult(
      'c1',
      'Tests: 1 failed, 2 passed\n[exit code: 1]',
      true,
      Date.now(),
      8,
    ));
    const bug = store.list()[0];
    assert.ok(bug);
    assert.equal(bug.source, 'auto');
    assert.equal(bug.status, 'new');
    assert.equal(bug.evidence[0].kind, 'tool-error');
    assert.equal(bug.evidence[0].tool, 'ops_bash');
    assert.equal(bug.evidence[0].seq, 8);
    assert.match(bug.title, /测试失败/);

    capture.onToolCall(tracker, toolCall('c2', 'ops_bash', { command: 'npm test' }, Date.now(), 9));
    capture.onToolResult(tracker, toolResult(
      'c2',
      'Tests: 1 failed, 2 passed\n[exit code: 1]',
      true,
      Date.now(),
      10,
    ));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].occurrence, 2);
    assert.equal(store.list()[0].evidence.length, 3);
  });
});

test('a successful rerun moves the matching defect to 待验证', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'npm test' }));
    capture.onToolResult(tracker, toolResult('c1', 'Tests: 1 failed, 2 passed\n[exit code: 1]', true));
    const bug = store.list()[0];
    assert.equal(bug.status, 'new');

    capture.onToolCall(tracker, toolCall('c2', 'ops_bash', { command: 'npm test' }));
    capture.onToolResult(tracker, toolResult('c2', 'Tests: 2 passed', false));
    assert.equal(store.get(bug.id).status, 'verify');
  });
});

test('ignored tools and non-exec tools never create defects', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onToolCall(tracker, toolCall('c1', 'read', { file_path: 'src/a.ts' }));
    capture.onToolResult(tracker, toolResult('c1', 'error TS1: boom', true));
    capture.onToolCall(tracker, toolCall('c2', 'ops_grep', { pattern: 'x' }));
    capture.onToolResult(tracker, toolResult('c2', 'error TS1: boom\n[exit code: 1]', true));
    assert.equal(store.stats().total, 0);
  });
});

test('a configured ignoreTools entry suppresses capture', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'npm test' }));
    capture.onToolResult(tracker, toolResult('c1', 'Tests: 1 failed, 2 passed\n[exit code: 1]', true));
    assert.equal(store.stats().total, 0);
  }, { ignoreTools: ['ops_bash'] });
});

test('maxBugsPerTurn limits captures and resets on the next turn', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了\n订单页面白屏了'));
    assert.equal(store.stats().total, 1);

    capture.handle(trackerSession(capture), { type: 'turn/start', data: { turn: 2 } });
    capture.onUserMessage(tracker, userMessage('上传功能崩溃了'));
    assert.equal(store.stats().total, 2);
  }, { maxBugsPerTurn: 1 });
});

function trackerSession(capture) {
  return fakeSession({ id: capture.lastSessionId, cwd: 'D:\\demo' });
}

test('user reports start 待修复 and the next tool action marks 修复中', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('业务明细和日志总量为什么都是0'));
    const bug = store.list()[0];
    assert.equal(bug.status, 'open');
    assert.equal(bug.source, 'user');

    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'ls' }));
    assert.equal(store.get(bug.id).status, 'progress');
    assert.equal(store.get(bug.id).history.at(-1).actor, 'agent');
    assert.equal(store.get(bug.id).evidence.at(-1).kind, 'fix-start');
  });
});

test('a recent qa tool call suppresses the automatic 修复中 fallback', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了'));
    const bug = store.list()[0];
    capture.onToolCall(tracker, toolCall('c1', 'qa_begin_fix', { query: '登录接口' }));
    assert.equal(store.get(bug.id).status, 'open');
    assert.equal(tracker.pendingReportIds.length, 0);
  });
});

test('a stale pending report is not promoted by a later tool call', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了'));
    const bug = store.list()[0];
    tracker.pendingReportAt = Date.now() - 31 * 60 * 1000;
    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'ls' }));
    assert.equal(store.get(bug.id).status, 'open');
  });
});

test('autoStatusFallback:false disables automatic status transitions', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了'));
    const bug = store.list()[0];
    capture.onToolCall(tracker, toolCall('c1', 'ops_bash', { command: 'ls' }));
    assert.equal(store.get(bug.id).status, 'open');
  }, { autoStatusFallback: false });
});

test('a user confirmation closes the latest session defect', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('运行 up.sh 没有任何反应'));
    const bug = store.list()[0];
    capture.onUserMessage(tracker, userMessage('好了，现在正常了'));
    assert.equal(store.get(bug.id).status, 'closed');
    assert.equal(store.get(bug.id).evidence.at(-1).kind, 'user-confirm');
  });
});

test('a confirmation containing a new symptom does not close anything', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('运行 up.sh 没有任何反应'));
    const bug = store.list()[0];
    capture.onUserMessage(tracker, userMessage('好了，但是另一个页面还是不行'));
    assert.equal(store.get(bug.id).status, 'open');
  });
});

test('assistant messages are ignored unless captureAssistant is enabled', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.handle(tracker, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '发现一个 bug：退款回调重复入账，金额翻倍。' }] } },
      time: Date.now(),
    });
    assert.equal(store.stats().total, 0);
  });

  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.handle(tracker, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '发现一个 bug：退款回调重复入账，金额翻倍。' }] } },
      time: Date.now(),
    });
    assert.equal(store.stats().total, 1);
    assert.equal(store.list()[0].source, 'auto');
  }, { captureAssistant: true });
});

test('assistant fix statements advance a matching defect', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    const bug = store.create({
      title: '退款回调重复入账，金额翻倍',
      workspace: 'D:\\demo',
      workspaceName: 'demo',
      sessionId: 's1',
      status: 'open',
    });
    capture.onAssistantMessage(tracker, {
      data: { message: { content: [{ type: 'text', text: '已修复退款回调重复入账的问题。' }] } },
      time: Date.now(),
      seq: 3,
    });
    assert.equal(store.get(bug.id).status, 'verify');
    assert.equal(store.get(bug.id).evidence.at(-1).kind, 'resolution');
  }, { captureAssistant: true });
});

test('editing a file assigns its module without changing status when fallback is off', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('运行 up.sh 没有任何反应'));
    const bug = store.list()[0];
    assert.equal(bug.module, '启动与部署');
    bug.module = '';
    capture.onToolCall(tracker, toolCall('c1', 'edit', { file_path: 'D:\\demo\\scripts\\up.sh' }));
    assert.equal(store.get(bug.id).module, 'scripts');
    assert.equal(store.get(bug.id).status, 'open');
  }, { autoStatusFallback: false });
});

test('editing a file after a manual qa call only backfills the module', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了'));
    const bug = store.list()[0];
    bug.module = '';
    tracker.lastQaManageAt = Date.now();
    capture.onToolCall(tracker, toolCall('c1', 'edit', { file_path: 'D:\\demo\\src\\auth.ts' }));
    assert.equal(store.get(bug.id).module, 'src');
    assert.equal(store.get(bug.id).status, 'open');
  });
});

test('editing a file without a manual qa call marks the defect 修复中', async () => {
  await withCapture(async ({ store, capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    capture.onUserMessage(tracker, userMessage('登录接口报错了'));
    const bug = store.list()[0];
    bug.module = '';
    capture.onToolCall(tracker, toolCall('c1', 'edit', { file_path: 'D:\\demo\\src\\auth.ts' }));
    assert.equal(store.get(bug.id).module, 'src');
    assert.equal(store.get(bug.id).status, 'progress');
    assert.equal(store.get(bug.id).history.at(-1).actor, 'agent');
  });
});

test('tool call bookkeeping is bounded and pending ids are capped', async () => {
  await withCapture(async ({ capture }) => {
    const tracker = capture.ensure(fakeSession({ id: 's1', cwd: 'D:\\demo' }));
    for (let index = 0; index < 90; index += 1) {
      capture.onToolCall(tracker, toolCall(`c${index}`, 'ops_bash', { command: 'ls' }));
    }
    assert.equal(tracker.calls.size, 80);
    for (let index = 0; index < 25; index += 1) {
      capture.queuePending(tracker, `BUG-${String(index).padStart(4, '0')}`);
    }
    assert.equal(tracker.pendingReportIds.length, 10);
    assert.equal(tracker.recentBugIds.length, 0);
  });
});

test('contextFor exposes the session tracker and workspace', async () => {
  await withCapture(async ({ capture }) => {
    const session = fakeSession({ id: 's1', cwd: 'D:\\demo', title: '标题' });
    const context = capture.contextFor({ session });
    assert.equal(context.workspace, 'D:\\demo');
    assert.equal(context.workspaceName, 'demo');
    assert.equal(context.sessionId, 's1');
    assert.equal(context.sessionTitle, '标题');
    assert.ok(context.tracker);
    assert.deepEqual(capture.contextFor(null), {
      tracker: null,
      workspace: '',
      workspaceName: '未归类',
    });
  });
});

test('describeCall summarizes a tool invocation', () => {
  assert.equal(describeCall('ops_bash', { command: 'npm test' }), 'ops_bash: npm test');
  assert.equal(describeCall('tool', {}), 'tool: {}');
  assert.equal(describeCall('tool', null), 'tool: (no arguments)');
});