/**
 * Durable bug store for the QA tracker.
 *
 * One JSON document per profile under `~/.dsh/qa-guardian/data.json`. Writes are
 * debounced and atomic (temp file + rename), and every mutation records a
 * status-history entry plus a bounded activity feed.
 */

import { mkdir, readFile, rename, writeFile, copyFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATUSES,
  AUTO_CLOSE_HOURS,
  MAX_ACTIVITY,
  MAX_DESCRIPTION,
  MAX_EVIDENCE,
  MAX_TITLE,
  MUTE_DEFAULT_DAYS,
  MUTE_MAX_DAYS,
  PRIORITIES,
  SEVERITIES,
  STATUSES,
} from './constants.js';
import { baseName, clip, entitiesOf, hash, nowIso, oneLine, similarity } from './util.js';

const DATA_VERSION = 1;

function emptyData() {
  return { version: DATA_VERSION, seq: 0, muteSeq: 0, bugs: [], activity: [], backfill: {}, muteRules: [] };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Normalize one mute rule; expired rules stay on disk until the next match. */
function normalizeMuteRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const signature = typeof raw.signature === 'string' ? raw.signature.trim() : '';
  if (!signature) return null;
  const workspace = typeof raw.workspace === 'string' ? raw.workspace : '';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `MUTE-${hash(`${workspace}|${signature}`).slice(0, 10)}`,
    workspace,
    signature,
    tool: clip(String(raw.tool || ''), 60),
    note: clip(String(raw.note || ''), 200),
    createdAt: validDate(raw.createdAt) ? raw.createdAt : nowIso(),
    expiresAt: validDate(raw.expiresAt) ? raw.expiresAt : '',
    hits: Number.isSafeInteger(raw.hits) && raw.hits > 0 ? raw.hits : 0,
    lastHitAt: validDate(raw.lastHitAt) ? raw.lastHitAt : '',
    createdBy: clip(String(raw.createdBy || ''), 60),
  };
}

function normalizeBug(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title);
  if (!title) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'new';
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'major';
  const createdAt = validDate(raw.createdAt) ? raw.createdAt : nowIso();
  const updatedAt = validDate(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `BUG-${String(raw.seq || 1).padStart(4, '0')}`,
    title: clip(title, MAX_TITLE),
    description: clip(String(raw.description || ''), MAX_DESCRIPTION),
    severity,
    status,
    source: ['auto', 'user', 'agent', 'manual'].includes(raw.source) ? raw.source : 'manual',
    workspace: typeof raw.workspace === 'string' ? raw.workspace : '',
    workspaceName: typeof raw.workspaceName === 'string' && raw.workspaceName
      ? raw.workspaceName
      : baseName(raw.workspace || '') || '未归类',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    sessionTitle: typeof raw.sessionTitle === 'string' ? raw.sessionTitle : '',
    signature: typeof raw.signature === 'string' ? raw.signature : '',
    trigger: raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : null,
    occurrence: Number.isSafeInteger(raw.occurrence) && raw.occurrence > 0 ? raw.occurrence : 1,
    createdAt,
    updatedAt,
    lastSeenAt: validDate(raw.lastSeenAt) ? raw.lastSeenAt : updatedAt,
    evidence: asArray(raw.evidence).filter(item => item && typeof item === 'object').slice(-MAX_EVIDENCE),
    history: asArray(raw.history).filter(item => item && typeof item === 'object'),
    notes: asArray(raw.notes).filter(item => item && typeof item === 'object'),
    tags: asArray(raw.tags).filter(tag => typeof tag === 'string').slice(0, 12),
    assignee: typeof raw.assignee === 'string' ? raw.assignee : '',
    module: typeof raw.module === 'string' ? clip(raw.module, 80) : '',
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    dueAt: validDate(raw.dueAt) ? raw.dueAt : '',
    fixVersion: typeof raw.fixVersion === 'string' ? clip(raw.fixVersion, 60) : '',
    foundVersion: typeof raw.foundVersion === 'string' ? clip(raw.foundVersion, 60) : '',
    verification: raw.verification && typeof raw.verification === 'object'
      ? {
        outcome: ['passed', 'failed', 'cannot-reproduce'].includes(raw.verification.outcome)
          ? raw.verification.outcome
          : '',
        command: clip(String(raw.verification.command || ''), 500),
        note: clip(String(raw.verification.note || ''), 1000),
        at: validDate(raw.verification.at) ? raw.verification.at : '',
        by: clip(String(raw.verification.by || ''), 60),
      }
      : null,
    duplicateOf: typeof raw.duplicateOf === 'string' ? raw.duplicateOf : '',
    mergedIds: asArray(raw.mergedIds).filter(id => typeof id === 'string').slice(0, 100),
    autoCloseAt: validDate(raw.autoCloseAt) ? raw.autoCloseAt : '',
  };
}

export class BugStore {
  constructor({ filePath, log = () => {}, owner = '', botAssignee = 'bot' }) {
    this.filePath = filePath;
    this.log = log;
    this.owner = clip(oneLine(owner), 60);
    this.botAssignee = clip(oneLine(botAssignee), 60) || 'bot';
    this.data = emptyData();
    this.timer = null;
    this.changeTimer = null;
    this.changeListeners = new Set();
    this.writing = Promise.resolve();
  }

  /** Default owner: bot for automatic/agent findings, current user for human reports. */
  defaultAssignee(source) {
    return ['auto', 'agent'].includes(source) ? this.botAssignee : this.owner;
  }

  /** Replace a legacy default owner (OS username) with the signed-in account name. */
  reassignOwner(from, to) {
    const source = clip(oneLine(from), 60);
    const target = clip(oneLine(to), 60);
    if (!source || !target || source === target) return 0;
    let changed = 0;
    for (const bug of this.data.bugs) {
      if (bug.assignee === source) {
        bug.assignee = target;
        changed += 1;
      }
    }
    return changed;
  }

  /** Fill empty assignees on existing records according to their source. */
  assignDefaultOwners() {
    let changed = 0;
    for (const bug of this.data.bugs) {
      if (bug.assignee) continue;
      const assignee = this.defaultAssignee(bug.source);
      if (assignee) {
        bug.assignee = assignee;
        changed += 1;
      }
    }
    return changed;
  }

  /** Subscribe to debounced "the board changed" notifications (SSE fan-out). */
  subscribe(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  emitChange() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      for (const listener of this.changeListeners) {
        try {
          listener();
        } catch (error) {
          this.log(`change listener failed: ${error && error.message}`);
        }
      }
    }, 120);
    if (typeof this.changeTimer.unref === 'function') this.changeTimer.unref();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const bugs = asArray(parsed.bugs).map(normalizeBug).filter(Boolean);
      const seq = bugs.reduce((max, bug) => {
        const match = /^BUG-(\d+)$/.exec(bug.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, Number.isSafeInteger(parsed.seq) ? parsed.seq : 0);
      const muteRules = asArray(parsed.muteRules).map(normalizeMuteRule).filter(Boolean);
      const muteSeq = muteRules.reduce((max, rule) => {
        const match = /^MUTE-(\d+)$/.exec(rule.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, Number.isSafeInteger(parsed.muteSeq) ? parsed.muteSeq : 0);
      this.data = {
        version: DATA_VERSION,
        seq,
        muteSeq,
        bugs,
        activity: asArray(parsed.activity).filter(item => item && typeof item === 'object').slice(-MAX_ACTIVITY),
        backfill: parsed.backfill && typeof parsed.backfill === 'object' && !Array.isArray(parsed.backfill)
          ? parsed.backfill
          : {},
        muteRules,
      };
      this.log(`loaded ${bugs.length} tracked defects from ${this.filePath}`);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.log(`store read failed (${error.message}); starting with an empty board`);
      }
      this.data = emptyData();
    }
    return this;
  }

  scheduleSave() {
    this.emitChange();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 350);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, 'utf8');
      await rename(temp, this.filePath);
    }).catch(error => {
      this.log(`store write failed: ${error && error.message}`);
    });
    await this.writing;
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    return this.flush();
  }

  /** All bugs, newest activity first. */
  list() {
    return [...this.data.bugs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  get(id) {
    return this.data.bugs.find(bug => bug.id === id) || null;
  }

  recordActivity(entry) {
    this.data.activity.push({ at: nowIso(), ...entry });
    if (this.data.activity.length > MAX_ACTIVITY) {
      this.data.activity = this.data.activity.slice(-MAX_ACTIVITY);
    }
  }

  addEvidence(bug, evidence) {
    if (!evidence) return;
    const next = {
      at: evidence.at || nowIso(),
      kind: evidence.kind || 'observation',
      tool: evidence.tool || '',
      seq: Number.isSafeInteger(evidence.seq) ? evidence.seq : null,
      excerpt: clip(String(evidence.excerpt || ''), 700),
      sessionId: evidence.sessionId || '',
      note: clip(String(evidence.note || ''), 300),
    };
    bug.evidence = [...bug.evidence, next].slice(-MAX_EVIDENCE);
  }

  transition(bug, status, { actor = 'auto', note = '' } = {}) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
    if (bug.status === status) return false;
    const from = bug.status;
    bug.status = status;
    if (status !== 'verify') bug.autoCloseAt = '';
    bug.updatedAt = nowIso();
    bug.history = [...bug.history, { at: bug.updatedAt, from, to: status, actor, note }].slice(-80);
    this.recordActivity({
      type: 'status',
      bugId: bug.id,
      title: bug.title,
      from,
      to: status,
      actor,
      note: clip(note, 300),
      workspace: bug.workspace,
      sessionId: bug.sessionId,
    });
    return true;
  }

  /**
   * Create or extend a mute rule for one failure signature. `days === 0` keeps
   * the rule until it is removed by hand.
   */
  createMuteRule({ workspace, signature, tool = '', days = MUTE_DEFAULT_DAYS, note = '', actor = 'human' } = {}) {
    const ws = typeof workspace === 'string' ? workspace : '';
    const sig = typeof signature === 'string' ? signature.trim() : '';
    if (!sig) throw new Error('静音规则缺少签名');
    const span = Number.isFinite(days)
      ? Math.min(MUTE_MAX_DAYS, Math.max(0, Math.round(days)))
      : MUTE_DEFAULT_DAYS;
    const expiresAt = span === 0 ? '' : new Date(Date.now() + span * 86400000).toISOString();
    const existing = this.data.muteRules.find(rule => rule.workspace === ws && rule.signature === sig);
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.note = clip(note, 200) || existing.note;
      existing.tool = clip(tool, 60) || existing.tool;
      existing.lastHitAt = '';
      this.scheduleSave();
      return existing;
    }
    this.data.muteSeq += 1;
    const rule = normalizeMuteRule({
      id: `MUTE-${String(this.data.muteSeq).padStart(4, '0')}`,
      workspace: ws,
      signature: sig,
      tool,
      note,
      createdAt: nowIso(),
      expiresAt,
      createdBy: actor,
    });
    this.data.muteRules.push(rule);
    this.scheduleSave();
    return rule;
  }

  removeMuteRule(id) {
    const before = this.data.muteRules.length;
    this.data.muteRules = this.data.muteRules.filter(rule => rule.id !== id);
    const removed = this.data.muteRules.length !== before;
    if (removed) this.scheduleSave();
    return removed;
  }

  /** Active rules, newest first; expired rules are excluded by default. */
  listMuteRules({ workspace, includeExpired = false, now = Date.now() } = {}) {
    return this.data.muteRules
      .filter(rule => (workspace === undefined || rule.workspace === workspace)
        && (includeExpired || !rule.expiresAt || Date.parse(rule.expiresAt) > now))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * Match an incoming automatic failure against the active rules. A hit bumps
   * the counter instead of creating a defect; an expired rule deletes itself.
   */
  matchMuteRule({ workspace, signature, tool = '', at = Date.now() } = {}) {
    const sig = typeof signature === 'string' ? signature : '';
    if (!sig) return null;
    const rule = this.data.muteRules.find(item => item.workspace === workspace
      && item.signature === sig
      && (!item.tool || !tool || item.tool === tool));
    if (!rule) return null;
    if (rule.expiresAt && Date.parse(rule.expiresAt) <= at) {
      this.data.muteRules = this.data.muteRules.filter(item => item !== rule);
      this.scheduleSave();
      return null;
    }
    rule.hits += 1;
    rule.lastHitAt = new Date(at).toISOString();
    this.scheduleSave();
    return rule;
  }

  /**
   * Policy B: a model-verified defect moves to 待验证 and closes after a quiet
   * window. Blocker defects never auto-close and wait for a human.
   */
  requestClose(bug, { actor = 'agent', note = '', hours = AUTO_CLOSE_HOURS } = {}) {
    if (!bug) return { bug: null, mode: 'missing' };
    if (bug.status === 'closed') return { bug, mode: 'closed', at: '' };
    const reason = clip(note, 300) || '模型验证通过';
    if (bug.severity === 'blocker') {
      if (bug.status !== 'verify') {
        this.transition(bug, 'verify', { actor, note: `${reason}；致命缺陷需人工确认` });
      } else {
        bug.autoCloseAt = '';
        bug.updatedAt = nowIso();
        this.scheduleSave();
      }
      return { bug, mode: 'confirm', at: '' };
    }
    if (bug.status !== 'verify') {
      this.transition(bug, 'verify', { actor, note: reason });
    } else {
      bug.updatedAt = nowIso();
    }
    bug.autoCloseAt = new Date(Date.now() + Math.max(1, hours) * 3600000).toISOString();
    this.recordActivity({
      type: 'auto-close',
      bugId: bug.id,
      title: bug.title,
      actor,
      note: `${hours} 小时无反对将自动关闭`,
      workspace: bug.workspace,
      sessionId: bug.sessionId,
    });
    this.scheduleSave();
    return { bug, mode: 'deferred', at: bug.autoCloseAt };
  }

  /** Close defects whose quiet window has elapsed. Safe to call on every read. */
  sweepAutoClose({ now = Date.now(), actor = 'rule' } = {}) {
    let closed = 0;
    for (const bug of this.data.bugs) {
      if (bug.status !== 'verify' || !bug.autoCloseAt) continue;
      if (Date.parse(bug.autoCloseAt) > now) continue;
      bug.autoCloseAt = '';
      this.transition(bug, 'closed', { actor, note: '静默期结束，自动关闭' });
      this.addEvidence(bug, {
        kind: 'auto-close',
        excerpt: '静默期结束，自动关闭',
        sessionId: bug.sessionId,
      });
      closed += 1;
    }
    if (closed > 0) this.scheduleSave();
    return closed;
  }

  /** Revert the latest status change for one defect (human correction). */
  undoStatus(id, { actor = 'human' } = {}) {
    const bug = this.get(id);
    if (!bug) throw new Error(`未找到缺陷 ${id}`);
    const entry = [...bug.history].reverse().find(item => item && item.from && item.from !== item.to && !item.undo);
    if (!entry) return null;
    this.transition(bug, entry.from, { actor, note: '撤销上一步状态变更' });
    const last = bug.history[bug.history.length - 1];
    if (last) last.undo = true;
    this.scheduleSave();
    return bug;
  }

  /** Work the model should pick up on its next turn, scoped to one workspace. */
  pendingSummary(workspace, { now = Date.now() } = {}) {
    const scope = this.data.bugs.filter(bug => !workspace || bug.workspace === workspace);
    const ids = list => list.map(bug => bug.id).slice(0, 8);
    const untriaged = scope.filter(bug => bug.status === 'new');
    const staleProgress = scope.filter(bug => bug.status === 'progress'
      && now - Date.parse(bug.updatedAt) > 3 * 86400000);
    const pendingVerify = scope.filter(bug => bug.status === 'verify');
    const autoClosing = scope.filter(bug => bug.status === 'verify' && bug.autoCloseAt);
    const blockers = scope.filter(bug => bug.severity === 'blocker'
      && ['new', 'open', 'progress', 'verify'].includes(bug.status));
    const overdue = scope.filter(bug => bug.dueAt && Date.parse(bug.dueAt) < now
      && !['closed', 'ignored', 'duplicate', 'cannot-reproduce'].includes(bug.status));
    return {
      untriaged: { count: untriaged.length, ids: ids(untriaged) },
      staleProgress: { count: staleProgress.length, ids: ids(staleProgress) },
      pendingVerify: { count: pendingVerify.length, ids: ids(pendingVerify) },
      autoClosing: { count: autoClosing.length, ids: ids(autoClosing) },
      blockers: { count: blockers.length, ids: ids(blockers) },
      overdue: { count: overdue.length, ids: ids(overdue) },
    };
  }

  create(input, { actor = 'human' } = {}) {
    const title = oneLine(input.title);
    if (!title) throw new Error('缺陷标题不能为空');
    const now = nowIso();
    this.data.seq += 1;
    const bug = normalizeBug({
      id: `BUG-${String(this.data.seq).padStart(4, '0')}`,
      title: clip(title, MAX_TITLE),
      description: clip(String(input.description || ''), MAX_DESCRIPTION),
      severity: input.severity,
      status: input.status || (input.source === 'auto' ? 'new' : 'open'),
      source: input.source || 'manual',
      workspace: input.workspace || '',
      workspaceName: input.workspaceName || baseName(input.workspace || ''),
      sessionId: input.sessionId || '',
      sessionTitle: input.sessionTitle || '',
      signature: input.signature || `manual:${hash(title)}`,
      trigger: input.trigger || null,
      occurrence: 1,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      evidence: [],
      history: [{ at: now, from: null, to: input.status || 'new', actor, note: '创建缺陷' }],
      notes: [],
      tags: input.tags || [],
      assignee: input.assignee || this.defaultAssignee(input.source || 'manual'),
      module: input.module || '',
      priority: input.priority || 'normal',
      dueAt: input.dueAt || '',
      fixVersion: input.fixVersion || '',
      foundVersion: input.foundVersion || '',
      verification: null,
      duplicateOf: '',
      mergedIds: [],
    });
    if (!bug) throw new Error('缺陷数据无效');
    if (input.evidence) this.addEvidence(bug, input.evidence);
    this.data.bugs.push(bug);
    this.recordActivity({
      type: 'created',
      bugId: bug.id,
      title: bug.title,
      to: bug.status,
      actor,
      note: bug.source === 'auto' ? '自动捕获' : '手动创建',
      workspace: bug.workspace,
      sessionId: bug.sessionId,
    });
    this.scheduleSave();
    return bug;
  }

  update(id, patch, { actor = 'human', note = '' } = {}) {
    const bug = this.get(id);
    if (!bug) throw new Error(`未找到缺陷 ${id}`);
    let fieldsChanged = false;
    let changed = false;
    if (typeof patch.title === 'string' && oneLine(patch.title) && oneLine(patch.title) !== bug.title) {
      bug.title = clip(oneLine(patch.title), MAX_TITLE);
      fieldsChanged = true;
    }
    if (typeof patch.description === 'string' && patch.description !== bug.description) {
      bug.description = clip(patch.description, MAX_DESCRIPTION);
      fieldsChanged = true;
    }
    if (SEVERITIES.includes(patch.severity) && patch.severity !== bug.severity) {
      bug.severity = patch.severity;
      fieldsChanged = true;
    }
    if (typeof patch.assignee === 'string' && patch.assignee !== bug.assignee) {
      bug.assignee = clip(oneLine(patch.assignee), 60);
      fieldsChanged = true;
    }
    if (typeof patch.module === 'string' && oneLine(patch.module) !== bug.module) {
      bug.module = clip(oneLine(patch.module), 80);
      fieldsChanged = true;
    }
    if (Array.isArray(patch.tags)) {
      const tags = patch.tags.filter(tag => typeof tag === 'string').slice(0, 12);
      if (tags.join('\u0000') !== bug.tags.join('\u0000')) {
        bug.tags = tags;
        fieldsChanged = true;
      }
    }
    if (PRIORITIES.includes(patch.priority) && patch.priority !== bug.priority) {
      bug.priority = patch.priority;
      fieldsChanged = true;
    }
    if (typeof patch.dueAt === 'string' && (patch.dueAt === '' || validDate(patch.dueAt)) && patch.dueAt !== bug.dueAt) {
      bug.dueAt = patch.dueAt;
      fieldsChanged = true;
    }
    if (typeof patch.fixVersion === 'string' && clip(oneLine(patch.fixVersion), 60) !== bug.fixVersion) {
      bug.fixVersion = clip(oneLine(patch.fixVersion), 60);
      fieldsChanged = true;
    }
    if (typeof patch.foundVersion === 'string' && clip(oneLine(patch.foundVersion), 60) !== bug.foundVersion) {
      bug.foundVersion = clip(oneLine(patch.foundVersion), 60);
      fieldsChanged = true;
    }
    if (patch.status && patch.status !== bug.status) {
      this.transition(bug, patch.status, { actor, note });
      changed = true;
    }
    if (note.trim()) {
      const entry = { at: nowIso(), text: clip(note.trim(), 1000), actor };
      bug.notes = [...bug.notes, entry].slice(-40);
      this.recordActivity({
        type: 'note',
        bugId: bug.id,
        title: bug.title,
        actor,
        note: clip(note.trim(), 300),
        workspace: bug.workspace,
        sessionId: bug.sessionId,
      });
      changed = true;
    }
    if (fieldsChanged) {
      this.recordActivity({
        type: 'updated',
        bugId: bug.id,
        title: bug.title,
        actor,
        note: '',
        workspace: bug.workspace,
        sessionId: bug.sessionId,
      });
      changed = true;
    }
    // Any human touch of a 待验证 defect counts as a review: cancel the timer.
    if (bug.status === 'verify' && ['human', 'user'].includes(actor) && (fieldsChanged || note.trim())) {
      bug.autoCloseAt = '';
    }
    if (changed) {
      bug.updatedAt = nowIso();
      this.scheduleSave();
    }
    return bug;
  }

  remove(id, { actor = 'human' } = {}) {
    const index = this.data.bugs.findIndex(bug => bug.id === id);
    if (index < 0) return false;
    const [bug] = this.data.bugs.splice(index, 1);
    this.recordActivity({
      type: 'deleted',
      bugId: bug.id,
      title: bug.title,
      actor,
      note: '删除缺陷',
      workspace: bug.workspace,
      sessionId: bug.sessionId,
    });
    this.scheduleSave();
    return true;
  }

  /**
   * Fold one tool-failure draft into the board: reuse the same signature, bump
   * its occurrence count, and reopen it when a verified/closed defect recurs.
   */
  recordToolFailure({ draft, workspace, workspaceName, sessionId, sessionTitle, evidence, actor = 'auto' }) {
    if (!draft) return null;
    // A muted signature is counted, never surfaced. Blocker drafts bypass rules.
    if (draft.severity !== 'blocker') {
      const muted = this.matchMuteRule({
        workspace,
        signature: draft.signature,
        tool: draft.trigger && draft.trigger.tool ? draft.trigger.tool : '',
      });
      if (muted) return { bug: null, created: false, reopened: false, muted: true, rule: muted };
    }
    const existing = this.data.bugs.find(bug => bug.workspace === workspace && bug.signature === draft.signature);
    if (existing) {
      existing.occurrence += 1;
      existing.lastSeenAt = nowIso();
      existing.updatedAt = existing.lastSeenAt;
      existing.sessionId = sessionId || existing.sessionId;
      existing.sessionTitle = sessionTitle || existing.sessionTitle;
      this.addEvidence(existing, evidence);
      const recovers = existing.status === 'verify' || existing.status === 'closed';
      if (recovers) {
        this.transition(existing, 'open', {
          actor,
          note: '缺陷再次出现，已自动重新打开',
        });
      } else {
        this.recordActivity({
          type: 'evidence',
          bugId: existing.id,
          title: existing.title,
          actor,
          note: '再次出现',
          workspace: existing.workspace,
          sessionId: existing.sessionId,
        });
      }
      this.scheduleSave();
      return { bug: existing, created: false, reopened: recovers };
    }
    const bug = this.create({
      ...draft,
      source: 'auto',
      status: 'new',
      workspace,
      workspaceName,
      sessionId,
      sessionTitle,
      evidence,
    }, { actor });
    return { bug, created: true, reopened: false };
  }

  /** Fold an assistant-message defect statement into the board. */
  recordAssistantBug({ draft, workspace, workspaceName, sessionId, sessionTitle, evidence, actor = 'auto' }) {
    if (!draft) return null;
    if (draft.severity !== 'blocker') {
      const muted = this.matchMuteRule({ workspace, signature: draft.signature });
      if (muted) return { bug: null, created: false, muted: true, rule: muted };
    }
    const open = this.data.bugs.filter(bug => bug.workspace === workspace
      && (ACTIVE_STATUSES.includes(bug.status) || bug.status === 'verify')
      && Date.now() - Date.parse(bug.updatedAt) < 1000 * 60 * 60 * 24 * 14);
    let best = null;
    let bestScore = 0;
    for (const bug of open) {
      const score = similarity(bug.title, draft.title);
      if (score > bestScore) {
        best = bug;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.5) {
      best.occurrence += 1;
      best.lastSeenAt = nowIso();
      best.updatedAt = best.lastSeenAt;
      this.addEvidence(best, evidence);
      this.recordActivity({
        type: 'evidence',
        bugId: best.id,
        title: best.title,
        actor,
        note: '对话中再次提及',
        workspace: best.workspace,
        sessionId: sessionId || best.sessionId,
      });
      this.scheduleSave();
      return { bug: best, created: false };
    }
    const bug = this.create({
      ...draft,
      source: 'auto',
      status: 'new',
      workspace,
      workspaceName,
      sessionId,
      sessionTitle,
      evidence,
    }, { actor });
    return { bug, created: true };
  }

  /** Fold a user-reported defect into the board, preferring the same session. */
  recordUserReport({ draft, workspace, workspaceName, sessionId, sessionTitle, evidence, actor = 'user' }) {
    if (!draft) return null;
    const now = Date.now();
    const candidates = this.data.bugs.filter(bug => bug.workspace === workspace
      && bug.status !== 'ignored'
      && now - Date.parse(bug.updatedAt) < 1000 * 60 * 60 * 24 * 30);
    let best = null;
    let bestScore = 0;
    for (const bug of candidates) {
      let score = similarity(bug.title, draft.title);
      if (bug.sessionId === sessionId && now - Date.parse(bug.updatedAt) < 1000 * 60 * 60 * 2) {
        score += 0.12;
      }
      if (score > bestScore) {
        best = bug;
        bestScore = score;
      }
    }
    const threshold = best && best.sessionId === sessionId ? 0.32 : 0.46;
    const sharedEntity = Boolean(best && best.sessionId === sessionId
      && [...entitiesOf(draft.title)].some(entity => entitiesOf(best.title).has(entity)));
    if (best && (bestScore >= threshold || sharedEntity)) {
      const wasClosed = best.status === 'closed' || best.status === 'verify';
      best.occurrence += 1;
      best.lastSeenAt = nowIso();
      best.updatedAt = best.lastSeenAt;
      this.addEvidence(best, evidence);
      if (wasClosed) {
        this.transition(best, 'open', {
          actor,
          note: '用户再次反馈，缺陷重新打开',
        });
      } else {
        this.recordActivity({
          type: 'evidence',
          bugId: best.id,
          title: best.title,
          actor,
          note: '用户再次反馈',
          workspace: best.workspace,
          sessionId: sessionId || best.sessionId,
        });
      }
      this.scheduleSave();
      return { bug: best, created: false, reopened: wasClosed };
    }
    const bug = this.create({
      ...draft,
      source: 'user',
      status: 'open',
      workspace,
      workspaceName,
      sessionId,
      sessionTitle,
      evidence,
    }, { actor });
    return { bug, created: true, reopened: false };
  }

  /** Attach a module to the most recent unclassified defect in this session. */
  assignModule({ workspace, sessionId, module, maxAgeMs = 6 * 60 * 60 * 1000 }) {
    const value = clip(oneLine(module), 80);
    if (!value) return null;
    const now = Date.now();
    const candidate = this.data.bugs
      .filter(bug => bug.workspace === workspace
        && bug.sessionId === sessionId
        && !bug.module
        && (ACTIVE_STATUSES.includes(bug.status) || bug.status === 'verify')
        && now - Date.parse(bug.updatedAt) < maxAgeMs)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (!candidate) return null;
    candidate.module = value;
    candidate.updatedAt = nowIso();
    this.recordActivity({
      type: 'updated',
      bugId: candidate.id,
      title: candidate.title,
      actor: 'auto',
      note: `功能模块：${value}`,
      workspace: candidate.workspace,
      sessionId: candidate.sessionId,
    });
    this.scheduleSave();
    return candidate;
  }

  /** Mark the defect DSH is touching as 修复中, and attach the touched module. */
  noteFixActivity({ workspace, sessionId, module = '', note = 'DSH 开始修复', maxAgeMs = 6 * 60 * 60 * 1000 }) {
    const now = Date.now();
    const value = clip(oneLine(module), 80);
    const candidates = this.data.bugs.filter(bug => bug.workspace === workspace
      && bug.sessionId === sessionId
      && ['new', 'open', 'progress'].includes(bug.status)
      && now - Date.parse(bug.updatedAt) < maxAgeMs);
    if (candidates.length === 0) return null;
    const matched = value ? candidates.find(bug => bug.module && bug.module.toLowerCase() === value.toLowerCase()) : null;
    const unclassified = candidates.filter(bug => !bug.module).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const recent = candidates.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const freshEnough = recent && now - Date.parse(recent.updatedAt) < 30 * 60 * 1000;
    const target = matched || unclassified || (freshEnough ? recent : null);
    if (!target) return null;
    let changed = false;
    if (value && !target.module) {
      target.module = value;
      changed = true;
    }
    if (target.status === 'new' || target.status === 'open') {
      this.transition(target, 'progress', {
        actor: 'agent',
        note: value ? `${note}（${value}）` : note,
      });
      changed = true;
    } else if (changed) {
      target.updatedAt = nowIso();
      this.recordActivity({
        type: 'updated',
        bugId: target.id,
        title: target.title,
        actor: 'agent',
        note: `功能模块：${value}`,
        workspace: target.workspace,
        sessionId: target.sessionId,
      });
    }
    if (changed) this.scheduleSave();
    return target;
  }

  /** Attach a Git fix commit to the most plausible existing defect. */
  attachGitCommit({ workspace, sessionId, sha, subject, message, scope, at }) {
    const commitText = `${subject}\n${message || ''}`;
    let target = null;
    const idMatch = String(subject).match(/BUG-\d+/i);
    if (idMatch) target = this.get(idMatch[0].toUpperCase());
    if (!target) {
      let best = null;
      let bestScore = 0;
      for (const bug of this.data.bugs) {
        if (bug.workspace !== workspace || bug.status === 'ignored') continue;
        let score = similarity(bug.title, commitText);
        if (scope && bug.module && bug.module.toLowerCase() === scope.toLowerCase()) score += 0.1;
        if (score > bestScore) {
          best = bug;
          bestScore = score;
        }
      }
      if (best && bestScore >= 0.4) target = best;
    }
    if (!target) return null;
    const excerpt = `${sha ? `${sha} ` : ''}${subject}`;
    if (sha && target.evidence.some(item => item.kind === 'git-commit' && item.excerpt.includes(sha))) {
      return target;
    }
    this.addEvidence(target, {
      at: at || nowIso(),
      kind: 'git-commit',
      excerpt,
      note: clip(message || '', 500),
      sessionId: sessionId || target.sessionId,
    });
    if (['new', 'open', 'progress'].includes(target.status)) {
      this.transition(target, 'verify', {
        actor: 'agent',
        note: `Git 修复提交${sha ? ` ${sha}` : ''}`,
      });
    } else {
      this.recordActivity({
        type: 'evidence',
        bugId: target.id,
        title: target.title,
        actor: 'agent',
        note: `Git 修复提交${sha ? ` ${sha}` : ''}`,
        workspace: target.workspace,
        sessionId: target.sessionId,
      });
    }
    this.scheduleSave();
    return target;
  }

  /** Record a verification attempt and move the defect to its outcome status. */
  recordVerification({ id, outcome, command = '', note = '', actor = 'human' } = {}) {
    if (!['passed', 'failed', 'cannot-reproduce'].includes(outcome)) {
      throw new Error('无效的验证结果');
    }
    const bug = this.get(id);
    if (!bug) throw new Error(`未找到缺陷 ${id}`);
    const at = nowIso();
    bug.verification = {
      outcome,
      command: clip(oneLine(command), 500),
      note: clip(note, 1000),
      at,
      by: actor,
    };
    this.addEvidence(bug, {
      at,
      kind: 'verification',
      excerpt: `${outcome === 'passed' ? '验证通过' : outcome === 'cannot-reproduce' ? '无法复现' : '验证未通过'}${command ? `：${oneLine(command)}` : ''}`,
      note: clip(note, 300),
      sessionId: bug.sessionId,
    });
    const next = outcome === 'passed' ? 'closed' : outcome === 'cannot-reproduce' ? 'cannot-reproduce' : 'progress';
    this.transition(bug, next, {
      actor,
      note: outcome === 'passed' ? '验证通过，关闭缺陷' : outcome === 'cannot-reproduce' ? '无法复现' : '验证未通过，回到修复中',
    });
    this.scheduleSave();
    return bug;
  }

  /** Merge duplicate defects into one master record without deleting them. */
  mergeBugs(masterId, duplicateIds, { actor = 'human' } = {}) {
    const master = this.get(masterId);
    if (!master) throw new Error(`未找到主缺陷 ${masterId}`);
    const ids = [...new Set(asArray(duplicateIds).filter(id => typeof id === 'string' && id && id !== masterId))];
    const merged = [];
    for (const id of ids) {
      const duplicate = this.get(id);
      if (!duplicate || duplicate.status === 'duplicate') continue;
      master.occurrence += duplicate.occurrence;
      if (!master.assignee && duplicate.assignee) master.assignee = duplicate.assignee;
      if (Date.parse(duplicate.lastSeenAt) > Date.parse(master.lastSeenAt)) master.lastSeenAt = duplicate.lastSeenAt;
      master.tags = [...new Set([...master.tags, ...duplicate.tags])].slice(0, 12);
      master.evidence = [...master.evidence, ...duplicate.evidence].slice(-MAX_EVIDENCE);
      master.notes = [...master.notes, {
        at: nowIso(),
        text: `合并 ${duplicate.id}：${duplicate.title}`,
        actor,
      }].slice(-40);
      master.mergedIds = [...new Set([...master.mergedIds, duplicate.id])];
      duplicate.duplicateOf = master.id;
      this.addEvidence(duplicate, {
        kind: 'merge',
        excerpt: `已合并到 ${master.id}：${master.title}`,
        sessionId: duplicate.sessionId,
      });
      this.transition(duplicate, 'duplicate', { actor, note: `合并到 ${master.id}` });
      merged.push(duplicate.id);
    }
    if (merged.length > 0) {
      master.updatedAt = nowIso();
      this.addEvidence(master, {
        kind: 'merge',
        excerpt: `合并重复缺陷：${merged.join(', ')}`,
        sessionId: master.sessionId,
      });
      this.recordActivity({
        type: 'merged',
        bugId: master.id,
        title: master.title,
        actor,
        note: `合并 ${merged.length} 条重复缺陷`,
        workspace: master.workspace,
        sessionId: master.sessionId,
      });
      this.scheduleSave();
    }
    return { master, merged };
  }

  exportData() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** Replace the store from an exported JSON document. */
  async importData(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.bugs)) {
      throw new Error('导入数据缺少 bugs 数组');
    }
    const bugs = asArray(raw.bugs).map(normalizeBug).filter(Boolean);
    if (bugs.length === 0) throw new Error('导入数据没有有效缺陷');
    const seq = bugs.reduce((max, bug) => {
      const match = /^BUG-(\d+)$/.exec(bug.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, Number.isSafeInteger(raw.seq) ? raw.seq : 0);
    const muteRules = asArray(raw.muteRules).map(normalizeMuteRule).filter(Boolean);
    const muteSeq = muteRules.reduce((max, rule) => {
      const match = /^MUTE-(\d+)$/.exec(rule.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, Number.isSafeInteger(raw.muteSeq) ? raw.muteSeq : 0);
    this.data = {
      version: DATA_VERSION,
      seq,
      muteSeq,
      bugs,
      activity: asArray(raw.activity).filter(item => item && typeof item === 'object').slice(-MAX_ACTIVITY),
      backfill: raw.backfill && typeof raw.backfill === 'object' && !Array.isArray(raw.backfill) ? raw.backfill : {},
      muteRules,
    };
    this.assignDefaultOwners();
    await this.flush();
    this.emitChange();
    return { imported: bugs.length };
  }

  /** Copy the current data file and retain the most recent seven backups. */
  async createBackup() {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath, '.json');
      await mkdir(dir, { recursive: true });
      const stamp = nowIso().replace(/[:.]/g, '-');
      const name = `${base}.backup-${stamp}.json`;
      await copyFile(this.filePath, path.join(dir, name));
      const backups = (await readdir(dir))
        .filter(file => file.startsWith(`${base}.backup-`) && file.endsWith('.json'))
        .sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - 7))) {
        await unlink(path.join(dir, old));
      }
      return name;
    } catch (error) {
      if (error && error.code === 'ENOENT') return '';
      throw error;
    }
  }

  /** Mark a defect as fixed when the same command that failed now succeeds. */
  markVerifiedByRerun({ workspace, trigger, tool, sessionId }) {
    if (!trigger || !trigger.key) return null;
    const candidates = this.data.bugs.filter(bug => bug.workspace === workspace
      && ACTIVE_STATUSES.includes(bug.status)
      && bug.trigger && bug.trigger.key === trigger.key
      && bug.source === 'auto');
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const bug = candidates[0];
    const changed = this.transition(bug, 'verify', {
      actor: 'auto',
      note: `同一命令重跑成功（${tool}）`,
    });
    if (changed) {
      bug.lastSeenAt = nowIso();
      this.addEvidence(bug, {
        kind: 'rerun-ok',
        tool,
        excerpt: '同一命令重跑成功',
        sessionId,
      });
      this.scheduleSave();
    }
    return changed ? bug : null;
  }

  /** Find an existing active defect with a similar title. */
  findSimilar({ workspace, title, threshold = 0.62 }) {
    let best = null;
    let bestScore = 0;
    for (const bug of this.data.bugs) {
      if (bug.workspace !== workspace) continue;
      if (!ACTIVE_STATUSES.includes(bug.status) && bug.status !== 'verify') continue;
      const score = similarity(bug.title, title);
      if (score > bestScore) {
        best = bug;
        bestScore = score;
      }
    }
    return bestScore >= threshold ? best : null;
  }

  /** Choose the most plausible active defect for a resolution sentence. */
  findResolutionTarget({ workspace, sessionId, snippet }) {
    const candidates = this.data.bugs.filter(bug => bug.workspace === workspace
      && ACTIVE_STATUSES.includes(bug.status));
    if (candidates.length === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const bug of candidates) {
      const score = similarity(bug.title, snippet)
        + (bug.sessionId === sessionId ? 0.12 : 0)
        + Math.max(0, 0.08 - (Date.now() - Date.parse(bug.updatedAt)) / (1000 * 60 * 60 * 24 * 30) * 0.08);
      if (score > bestScore) {
        best = bug;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.3) return best;
    return null;
  }

  stats(workspace) {
    const bugs = workspace ? this.data.bugs.filter(bug => bug.workspace === workspace) : this.data.bugs;
    const byStatus = Object.fromEntries(STATUSES.map(status => [status, 0]));
    const bySeverity = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
    let todayNew = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const bug of bugs) {
      byStatus[bug.status] += 1;
      bySeverity[bug.severity] += 1;
      if (bug.createdAt.slice(0, 10) === today) todayNew += 1;
    }
    return {
      total: bugs.length,
      open: byStatus.new + byStatus.open + byStatus.progress,
      verify: byStatus.verify,
      closed: byStatus.closed,
      ignored: byStatus.ignored,
      todayNew,
      byStatus,
      bySeverity,
    };
  }

  projects() {
    const map = new Map();
    for (const bug of this.data.bugs) {
      const key = bug.workspace || '';
      const entry = map.get(key) || {
        path: key,
        name: bug.workspaceName || baseName(key) || '未归类',
        total: 0,
        active: 0,
        verify: 0,
        lastSeenAt: '',
      };
      entry.total += 1;
      if (ACTIVE_STATUSES.includes(bug.status)) entry.active += 1;
      if (bug.status === 'verify') entry.verify += 1;
      if (!entry.lastSeenAt || Date.parse(bug.lastSeenAt) > Date.parse(entry.lastSeenAt)) entry.lastSeenAt = bug.lastSeenAt;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  activity(workspace, limit = 120) {
    const items = workspace ? this.data.activity.filter(item => item.workspace === workspace) : this.data.activity;
    return items.slice(-limit).reverse();
  }

  /** Last processed mtime for one historical session file. */
  backfillStamp(sessionId) {
    const value = this.data.backfill[sessionId];
    return typeof value === 'number' ? value : 0;
  }

  markBackfilled(sessionId, stamp) {
    this.data.backfill[sessionId] = stamp;
    const keys = Object.keys(this.data.backfill);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) delete this.data.backfill[key];
    }
    this.scheduleSave();
  }
}