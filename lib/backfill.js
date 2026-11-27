/**
 * Historical session backfill.
 *
 * Live capture starts when the plugin is installed, so defects reported before
 * that moment are absent from the board. DSH already has a replay-validated
 * session query service; this module asks it for recent logs and replays the
 * same user-report / fix rules over durable events.
 */

import path from 'node:path';
import { oneLine, textOfMessage } from './util.js';

function normalizeWorkspace(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function processSession({ snapshot, store, capture, workspaceFilter, log }) {
  const header = snapshot.session || {};
  const sessionId = typeof header.id === 'string' ? header.id : '';
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  if (workspaceFilter && normalizeWorkspace(cwd) !== workspaceFilter) {
    return { skipped: true, processed: 0, created: 0, lastTime: 0 };
  }
  const tracker = capture.ensure({
    id: sessionId,
    header: { cwd },
    snapshotEvents: () => [],
  });
  if (!tracker) return { skipped: true, processed: 0, created: 0, lastTime: 0 };

  const before = store.list().length;
  let processed = 0;
  let lastTime = 0;
  for (const event of snapshot.events || []) {
    if (event && Number.isFinite(event.time)) lastTime = Math.max(lastTime, event.time);
    if (event && event.type === 'tool/call') {
      capture.ingestToolCall(tracker, event);
      continue;
    }
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'session/title')) continue;
    const time = Number.isFinite(event.time) ? event.time : Date.now();
    if (event.type === 'session/title') {
      const title = event.data && typeof event.data.title === 'string' ? oneLine(event.data.title) : '';
      if (title) tracker.title = title;
      continue;
    }
    tracker.createdThisTurn = 0;
    if (event.type === 'user/message') {
      if (!tracker.title && event.data && event.data.source && event.data.source.kind === 'user') {
        const preview = oneLine(textOfMessage(event.data));
        if (preview) tracker.title = preview.slice(0, 48);
      }
      capture.onUserMessage(tracker, { data: event.data, time });
    } else {
      const message = event.data && event.data.message;
      if (message) {
        capture.markPendingProgress(tracker, time, 'DSH 开始处理用户反馈');
        capture.ingestAssistantResolutions(tracker, textOfMessage(message), new Date(time).toISOString());
      }
    }
    processed += 1;
  }
  return {
    skipped: false,
    processed,
    created: Math.max(0, store.list().length - before),
    lastTime,
  };
}

/**
 * Backfill recent sessions. Returns aggregate counts for tool output.
 * @param {object} options
 * @param {import('./store.js').BugStore} options.store
 * @param {import('./capture.js').Capture} options.capture
 * @param {object} options.sessionQuery - DSH session query service (`ctx.sessionQuery`).
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.workspace] - absolute workspace path filter.
 * @param {number} [options.days] - recent creation window.
 * @param {number} [options.limit] - maximum sessions.
 * @param {boolean} [options.force] - rescan sessions already stamped.
 */
export async function backfillSessions({
  store,
  capture,
  sessionQuery,
  log = () => {},
  workspace = '',
  days = 2,
  limit = 20,
  force = false,
}) {
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function' || typeof sessionQuery.readSession !== 'function') {
    return { ok: false, scanned: 0, skipped: 0, processed: 0, created: 0, touched: [], files: 0, error: 'sessionQuery service unavailable' };
  }
  const workspaceFilter = workspace ? normalizeWorkspace(workspace) : '';
  const since = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  let records = [];
  try {
    records = await sessionQuery.listSessions();
  } catch (error) {
    log(`backfill list failed: ${error && error.message}`);
    return { ok: false, scanned: 0, skipped: 0, processed: 0, created: 0, touched: [], files: 0, error: error && error.message };
  }
  const candidates = records
    .filter(record => record && record.header && typeof record.header.id === 'string')
    .filter(record => !/^mnemon-review/i.test(record.header.id))
    .filter(record => record.header.origin !== 'subagent' && !(Number(record.header.delegationDepth) > 0))
    .filter(record => {
      const createdAt = Number(record.header.createdAt) || 0;
      return createdAt >= since;
    })
    .slice(0, Math.max(1, Math.min(60, limit)));
  let scanned = 0;
  let skipped = 0;
  let processed = 0;
  let created = 0;
  const touched = [];
  for (const record of candidates) {
    const id = record.header.id;
    let snapshot;
    try {
      snapshot = await sessionQuery.readSession(id);
    } catch (error) {
      log(`backfill read ${id} failed: ${error && error.message}`);
      continue;
    }
    const lastEvent = (snapshot.events || []).reduce((max, event) => (Number.isFinite(event.time) ? Math.max(max, event.time) : max), 0);
    if (!force && store.backfillStamp(id) >= lastEvent && lastEvent > 0) continue;
    scanned += 1;
    const result = processSession({ snapshot, store, capture, workspaceFilter, log });
    if (result.skipped) {
      skipped += 1;
      continue;
    }
    processed += result.processed;
    created += result.created;
    store.markBackfilled(id, lastEvent || Number(record.header.createdAt) || Date.now());
    if (result.created > 0) touched.push(`${id}: +${result.created}`);
  }
  return { ok: true, scanned, skipped, processed, created, touched, files: candidates.length };
}