/**
 * Session-event capture: the automatic half of the QA tracker.
 *
 * Listens on the post-commit `session/event` feed, correlates tool calls with
 * their results, and folds deterministic defect evidence into the store.
 */

import path from 'node:path';
import {
  DEFAULT_IGNORED_TOOLS,
  analyzeAssistantText,
  analyzeToolResult,
  normalizeSignature,
} from './extract.js';
import { analyzeUserText } from './user-report.js';
import { parseGitCommit } from './git.js';
import { argSummary, baseName, clip, hash, moduleFromPath, oneLine, textOfMessage } from './util.js';

const FIX_INTENT_RE = /(?:开始|正在|马上|我来|准备)(?:修复|排查|定位|处理|改)|定位到(?:问题|原因|根因)|根因(?:是|为)|已找到原因/;

/** Tools that only plan/ask, and therefore do not mean DSH started fixing. */
const META_TOOLS = new Set([
  'todo_write',
  'ask_user_question',
  'skill',
  'present',
  'update_goal',
  'get_goal',
  'wait_agent',
  'list_agents',
]);

function parseArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function sessionTitleOf(session) {
  let events = [];
  try {
    if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents();
    else if (Array.isArray(session.events)) events = session.events;
  } catch {
    events = [];
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      return oneLine(event.data.title);
    }
  }
  for (const event of events) {
    if (event && event.type === 'user/message' && event.data) {
      const text = oneLine(textOfMessage(event.data));
      if (text) return clip(text, 48);
    }
  }
  return '';
}

function workspaceOf(session) {
  const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : '';
  if (!cwd) return { workspace: '', workspaceName: '未归类' };
  const resolved = path.resolve(cwd);
  return { workspace: resolved, workspaceName: baseName(resolved) || resolved };
}

export class Capture {
  constructor({ store, config = {}, log = () => {} }) {
    this.store = store;
    this.log = log;
    this.sessions = new Map();
    this.ignoredTools = new Set([
      ...DEFAULT_IGNORED_TOOLS,
      ...(Array.isArray(config.ignoreTools) ? config.ignoreTools : []),
    ]);
    this.assistantEnabled = config.captureAssistant === true;
    this.statusFallback = config.autoStatusFallback !== false;
    this.maxBugsPerTurn = Number.isSafeInteger(config.maxBugsPerTurn) && config.maxBugsPerTurn > 0
      ? config.maxBugsPerTurn
      : 6;
    this.lastSessionId = '';
  }

  attach(ctx) {
    const onCreated = session => this.ensure(session);
    const onEvent = (session, event) => {
      try {
        this.handle(session, event);
      } catch (error) {
        this.log(`capture failed for ${event && event.type}: ${error && error.message}`);
      }
    };
    const onDisposed = session => {
      if (session && session.id) this.sessions.delete(session.id);
    };
    ctx.on('session/created', onCreated);
    ctx.on('session/event', onEvent);
    ctx.on('session/disposed', onDisposed);
    // The plugin context owns these listeners; no manual off is required.
    return () => {};
  }

  ensure(session) {
    if (!session || !session.id) return null;
    let tracker = this.sessions.get(session.id);
    if (!tracker) {
      const location = workspaceOf(session);
      tracker = {
        id: session.id,
        title: sessionTitleOf(session),
        workspace: location.workspace,
        workspaceName: location.workspaceName,
        turn: 0,
        calls: new Map(),
        recentBugIds: [],
        pendingReportIds: [],
        pendingReportAt: 0,
        lastQaManageAt: 0,
        createdThisTurn: 0,
      };
      this.sessions.set(session.id, tracker);
    }
    this.lastSessionId = tracker.id;
    return tracker;
  }

  /** Workspace of the most recently active top-level session. */
  latestWorkspace() {
    const tracker = this.sessions.get(this.lastSessionId);
    return tracker && tracker.workspace ? tracker.workspace : '';
  }

  handle(session, event) {
    if (!event || typeof event.type !== 'string') return;
    const tracker = this.ensure(session);
    if (!tracker) return;
    if (!tracker.workspace) {
      const location = workspaceOf(session);
      tracker.workspace = location.workspace;
      tracker.workspaceName = location.workspaceName;
    }

    switch (event.type) {
      case 'session/title': {
        const title = event.data && typeof event.data.title === 'string' ? oneLine(event.data.title) : '';
        if (title) tracker.title = title;
        break;
      }
      case 'turn/start': {
        tracker.turn = Number.isSafeInteger(event.data && event.data.turn) ? event.data.turn : tracker.turn + 1;
        tracker.createdThisTurn = 0;
        break;
      }
      case 'tool/call': {
        this.onToolCall(tracker, event);
        break;
      }
      case 'tool/result': {
        this.onToolResult(tracker, event);
        break;
      }
      case 'user/message': {
        this.onUserMessage(tracker, event);
        break;
      }
      case 'assistant/message': {
        if (this.assistantEnabled) this.onAssistantMessage(tracker, event);
        break;
      }
      default:
        break;
    }
  }

  onToolCall(tracker, event) {
    const data = event.data || {};
    if (typeof data.callId !== 'string' || typeof data.name !== 'string') return;
    if (/^qa_(?:begin_fix|mark_fixed|capture|update_bug|from_user_report|report_bug)$/.test(data.name)) {
      tracker.lastQaManageAt = Date.now();
    }
    if (!META_TOOLS.has(data.name)) {
      this.markPendingProgress(tracker, event.time, 'DSH 开始处理用户反馈');
    }
    const args = parseArgs(data.arguments);
    tracker.calls.set(data.callId, {
      name: data.name,
      args,
      argumentText: data.arguments,
      seq: event.seq,
    });
    if (tracker.calls.size > 80) {
      const oldest = tracker.calls.keys().next().value;
      tracker.calls.delete(oldest);
    }
    // A fix edit points at the functional module of the most recent open report.
    if (/^(?:edit|write|patch|create|apply|str_replace)/i.test(data.name)) {
      const filePath = typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string' ? args.path : '';
      if (filePath) this.assignModuleFromPath(tracker, filePath);
    }
  }

  /** Backfill entry point: same side effects as a live tool call. */
  ingestToolCall(tracker, event) {
    this.onToolCall(tracker, event);
  }

  assignModuleFromPath(tracker, filePath) {
    const module = moduleFromPath(tracker.workspace, filePath);
    if (!this.statusFallback || Date.now() - (tracker.lastQaManageAt || 0) < 10 * 60 * 1000) {
      const bug = this.store.assignModule({
        workspace: tracker.workspace,
        sessionId: tracker.id,
        module: module || '',
      });
      if (bug) this.log(`${bug.id} module -> ${module || '未归类'}`);
      return;
    }
    const bug = this.store.noteFixActivity({
      workspace: tracker.workspace,
      sessionId: tracker.id,
      module: module || '',
    });
    if (bug) this.log(`${bug.id} -> 修复中 (${module || '未归类'})`);
  }

  onGitCommit(tracker, call, output, event) {
    const command = call && call.args && typeof call.args.command === 'string' ? call.args.command : '';
    if (!command || !/\bgit\s+commit\b/.test(command)) return;
    const commit = parseGitCommit(command, output);
    if (!commit) return;
    const bug = this.store.attachGitCommit({
      workspace: tracker.workspace,
      sessionId: tracker.id,
      sha: commit.sha,
      subject: commit.subject,
      message: commit.message,
      scope: commit.scope,
      at: new Date(event.time || Date.now()).toISOString(),
    });
    if (bug) this.log(`git commit ${commit.sha || ''} -> ${bug.id} ${bug.status}`);
  }

  onToolResult(tracker, event) {
    const message = event.data && event.data.message;
    if (!message) return;
    const callId = message.toolCallId || (message.source && message.source.callId);
    const call = callId ? tracker.calls.get(callId) : undefined;
    if (callId) tracker.calls.delete(callId);
    const tool = call ? call.name : (message.source && message.source.toolName) || 'tool';
    if (this.ignoredTools.has(tool)) return;

    const text = textOfMessage(message);
    const isError = message.isError === true;
    if (!isError) this.onGitCommit(tracker, call, text, event);

    const draft = analyzeToolResult({ tool, args: call ? call.args : {}, text, isError, workspace: tracker.workspace });
    if (draft) {
      if (tracker.createdThisTurn >= this.maxBugsPerTurn) return;
      const result = this.store.recordToolFailure({
        draft,
        workspace: tracker.workspace,
        workspaceName: tracker.workspaceName,
        sessionId: tracker.id,
        sessionTitle: tracker.title,
        evidence: {
          at: new Date(event.time || Date.now()).toISOString(),
          kind: 'tool-error',
          tool,
          seq: event.seq,
          excerpt: draft.excerpt,
          sessionId: tracker.id,
        },
      });
      if (result && result.bug) {
        tracker.createdThisTurn += 1;
        tracker.recentBugIds = [result.bug.id, ...tracker.recentBugIds.filter(id => id !== result.bug.id)].slice(0, 20);
        this.queuePending(tracker, result.bug.id);
        if (result.created) {
          this.log(`captured ${result.bug.id} from ${tool}: ${clip(result.bug.title, 80)}`);
        }
      }
      return;
    }

    if (isError) return;
    const args = call ? call.args : {};
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command) return;
    const trigger = {
      tool,
      command,
      key: hash(`${tool}|${normalizeSignature(command)}`),
    };
    const verified = this.store.markVerifiedByRerun({
      workspace: tracker.workspace,
      trigger,
      tool,
      sessionId: tracker.id,
    });
    if (verified) {
      this.log(`rerun succeeded, ${verified.id} moved to 待验证`);
      tracker.recentBugIds = [verified.id, ...tracker.recentBugIds].slice(0, 20);
    }
  }

  onUserMessage(tracker, event) {
    const data = event.data;
    if (!data || !data.source || data.source.kind !== 'user') return;
    const text = textOfMessage(data);
    if (!text) return;
    if (/\[dsh-mnemon:|Bounded completed checkpoint/i.test(text)) return;
    const at = new Date(event.time || Date.now()).toISOString();
    const analysis = analyzeUserText(text, tracker.workspace);

    if (analysis.confirmation && analysis.bugs.length === 0) {
      const target = this.findUserConfirmationTarget(tracker);
      if (target) {
        this.store.update(target.id, { status: 'closed' }, {
          actor: 'user',
          note: '用户确认问题已恢复',
        });
        this.store.addEvidence(target, {
          at,
          kind: 'user-confirm',
          excerpt: clip(text, 300),
          sessionId: tracker.id,
        });
        this.log(`user confirmed ${target.id}; moved to 已关闭`);
      }
      return;
    }

    for (const draft of analysis.bugs) {
      if (tracker.createdThisTurn >= this.maxBugsPerTurn) break;
      const result = this.store.recordUserReport({
        draft,
        workspace: tracker.workspace,
        workspaceName: tracker.workspaceName,
        sessionId: tracker.id,
        sessionTitle: tracker.title,
        evidence: {
          at,
          kind: 'user-report',
          excerpt: draft.excerpt,
          sessionId: tracker.id,
        },
        actor: 'user',
      });
      if (result && result.bug) {
        tracker.createdThisTurn += 1;
        tracker.recentBugIds = [result.bug.id, ...tracker.recentBugIds.filter(id => id !== result.bug.id)].slice(0, 20);
        this.queuePending(tracker, result.bug.id);
        if (result.created) {
          this.log(`captured user report ${result.bug.id}: ${clip(result.bug.title, 80)}`);
        }
      }
    }
  }

  queuePending(tracker, id) {
    if (!id) return;
    tracker.pendingReportIds = [...new Set([...(tracker.pendingReportIds || []), id])].slice(-10);
    tracker.pendingReportAt = Date.now();
  }

  markPendingProgress(tracker, time, reason) {
    if (!this.statusFallback || Date.now() - (tracker.lastQaManageAt || 0) < 10 * 60 * 1000) {
      tracker.pendingReportIds = [];
      tracker.pendingReportAt = 0;
      return;
    }
    const ids = Array.isArray(tracker.pendingReportIds) ? tracker.pendingReportIds.splice(0) : [];
    if (ids.length === 0) return;
    const queuedAt = tracker.pendingReportAt || Date.now();
    tracker.pendingReportAt = 0;
    if (Date.now() - queuedAt > 30 * 60 * 1000) return;
    const at = new Date(time || Date.now()).toISOString();
    for (const id of ids) {
      const bug = this.store.get(id);
      if (!bug || (bug.status !== 'new' && bug.status !== 'open')) continue;
      this.store.update(id, { status: 'progress' }, { actor: 'agent', note: reason });
      this.store.addEvidence(bug, {
        at,
        kind: 'fix-start',
        excerpt: reason,
        sessionId: tracker.id,
      });
      this.log(`${id} -> 修复中（${reason}）`);
    }
  }

  /** The most recent active defect in this session, used when the user confirms a fix. */
  findUserConfirmationTarget(tracker) {
    const now = Date.now();
    return this.store.list()
      .filter(bug => bug.workspace === tracker.workspace
        && bug.sessionId === tracker.id
        && ['new', 'open', 'progress'].includes(bug.status)
        && now - Date.parse(bug.updatedAt) < 1000 * 60 * 60 * 24)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  }

  onAssistantMessage(tracker, event) {
    const message = event.data && event.data.message;
    if (!message) return;
    const text = textOfMessage(message);
    if (!text || text.length < 4) return;
    // Metadata about this tracker is documentation, not a defect observation.
    if (/(?:qa-guardian|qa_[a-z_]+|QA 缺陷追踪)/.test(text)) return;
    const analysis = analyzeAssistantText(text);
    const at = new Date(event.time || Date.now()).toISOString();
    this.markPendingProgress(tracker, event.time, 'DSH 开始处理用户反馈');
    this.applyResolutions(tracker, analysis.resolutions, at, event.seq);
    if (this.statusFallback
      && Date.now() - (tracker.lastQaManageAt || 0) > 10 * 60 * 1000
      && analysis.resolutions.length === 0
      && FIX_INTENT_RE.test(text)) {
      this.store.noteFixActivity({
        workspace: tracker.workspace,
        sessionId: tracker.id,
        note: `DSH 开始修复：${clip(oneLine(text), 140)}`,
      });
    }

    if (tracker.createdThisTurn >= this.maxBugsPerTurn) return;
    for (const draft of analysis.bugs) {
      if (tracker.createdThisTurn >= this.maxBugsPerTurn) break;
      const result = this.store.recordAssistantBug({
        draft,
        workspace: tracker.workspace,
        workspaceName: tracker.workspaceName,
        sessionId: tracker.id,
        sessionTitle: tracker.title,
        evidence: {
          at,
          kind: 'assistant-text',
          seq: event.seq,
          excerpt: draft.excerpt,
          sessionId: tracker.id,
        },
      });
      if (result && result.bug) {
        tracker.createdThisTurn += 1;
        tracker.recentBugIds = [result.bug.id, ...tracker.recentBugIds.filter(id => id !== result.bug.id)].slice(0, 20);
        this.queuePending(tracker, result.bug.id);
        if (result.created) {
          this.log(`captured ${result.bug.id} from assistant text: ${clip(result.bug.title, 80)}`);
        }
      }
    }
  }

  /** Apply only fix statements; used by historical backfill to avoid inventing old defects. */
  ingestAssistantResolutions(tracker, text, at) {
    if (!text || text.length < 4) return;
    if (/(?:qa-guardian|qa_[a-z_]+|QA 缺陷追踪)/.test(text)) return;
    const analysis = analyzeAssistantText(text);
    this.applyResolutions(tracker, analysis.resolutions, at, null);
  }

  applyResolutions(tracker, resolutions, at, seq) {
    for (const resolution of resolutions) {
      const target = this.store.findResolutionTarget({
        workspace: tracker.workspace,
        sessionId: tracker.id,
        snippet: resolution.snippet,
      });
      if (!target) continue;
      const status = resolution.verified ? 'closed' : 'verify';
      const previous = target.status;
      this.store.update(target.id, { status }, {
        actor: 'auto',
        note: `自动识别到修复表述：${clip(resolution.snippet, 180)}`,
      });
      if (target.status !== previous) {
        this.store.addEvidence(target, {
          at,
          kind: 'resolution',
          seq,
          excerpt: resolution.snippet,
          sessionId: tracker.id,
        });
        this.log(`${target.id} -> ${status} from assistant text`);
      }
    }
  }

  /** Context for a tool call made by an agent. */
  contextFor(agent) {
    const session = agent && agent.session;
    if (!session) return { tracker: null, workspace: '', workspaceName: '未归类' };
    const tracker = this.ensure(session);
    return {
      tracker,
      workspace: tracker.workspace,
      workspaceName: tracker.workspaceName,
      sessionId: session.id,
      sessionTitle: tracker.title,
    };
  }

  summary() {
    return [...this.sessions.values()].map(tracker => ({
      id: tracker.id,
      title: tracker.title,
      workspace: tracker.workspace,
      workspaceName: tracker.workspaceName,
    }));
  }
}

/** Readable one-line summary of a tool invocation, used for evidence text. */
export function describeCall(tool, args) {
  return `${tool}: ${argSummary(args) || '(no arguments)'}`;
}