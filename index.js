/**
 * QA Guardian — automatic defect capture and tracking for DeepSeek Harness.
 *
 * Host half:
 *  - folds tool failures and assistant defect statements into a durable store
 *  - exposes agent tools (`qa_capture`, `qa_from_user_report`, `qa_begin_fix`, `qa_mark_fixed`, `qa_list_bugs`, `qa_backfill_sessions`)
 *  - serves the panel API under `/api/qa-guardian/*`
 */

import os from 'node:os';
import path from 'node:path';
import { backfillSessions } from './lib/backfill.js';
import { Capture } from './lib/capture.js';
import { featureFromText } from './lib/features.js';
import {
  MAX_DESCRIPTION,
  PRIORITIES,
  PRIORITY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SOURCE_LABELS,
  STATUSES,
  STATUS_LABELS,
} from './lib/constants.js';
import { BugStore } from './lib/store.js';
import { analyzeUserText } from './lib/user-report.js';
import { baseName, clip, moduleFromText, oneLine } from './lib/util.js';

export const name = 'qa-guardian';
export const inject = ['tools', 'systemPrompt', 'webServer'];

const API_BASE = '/api/qa-guardian';

const ANNOUNCEMENT = `【QA 缺陷追踪 · 请主动维护状态】
先判断用户消息类型：只有「实际发生的缺陷」才进看板；功能需求/新增能力/提问不是 bug，请用 qa_from_user_report({report, kind:'feature'|'question'}) 明确跳过，不要登记为缺陷。
一条消息混有 bug 和需求时，用 qa_from_user_report({items:[{text, kind}...]}) 拆开逐条分类，只有 kind:'bug' 的进看板。
修 bug 时按下面流程调用工具，不要依赖自动兜底：
1. 用户报告实际缺陷 → qa_from_user_report({report, title?, severity?, kind:'bug'})。
2. 开始修复前 → qa_begin_fix({query:"用户现象或关键词", module?, note?})，也可用 {id} 或 {latest:true}；工具会返回匹配到的 BUG 编号。
3. 修复完成 → qa_mark_fixed({id 或 query/latest, verified:true|false, note})。
4. 一轮修了多条 → qa_capture({found:[...], fixed:[...]})。
5. 查询 / 查重 → qa_list_bugs({status?, severity?, query?})。
这些工具都支持 id / title / query / latest，不需要先查编号。只记录项目缺陷，不记录工具调用失败、环境问题、需求变更。
插件仍会自动捕获工具失败和用户反馈作为兜底，但状态流转请用上述工具完成。`;

function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'qa-guardian');
}

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = req.headers && req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function cleanTitle(value, fallback) {
  const title = oneLine(value);
  return title || fallback;
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv(bugs) {
  const header = ['id', 'title', 'severity', 'status', 'priority', 'module', 'assignee', 'source', 'occurrence', 'workspace', 'foundVersion', 'fixVersion', 'createdAt', 'updatedAt'];
  const rows = bugs.map(bug => [
    bug.id,
    bug.title,
    bug.severity,
    bug.status,
    bug.priority,
    bug.module,
    bug.assignee,
    bug.source,
    bug.occurrence,
    bug.workspaceName || bug.workspace,
    bug.foundVersion,
    bug.fixVersion,
    bug.createdAt,
    bug.updatedAt,
  ].map(csvCell).join(','));
  return `\ufeff${header.join(',')}\n${rows.join('\n')}\n`;
}

function exportMarkdown(bugs) {
  const lines = [
    '# QA 缺陷导出',
    '',
    `- 导出时间：${new Date().toISOString()}`,
    `- 缺陷数量：${bugs.length}`,
    '',
    '| 编号 | 标题 | 严重度 | 状态 | 优先级 | 模块 | 负责人 | 次数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...bugs.map(bug => `| ${bug.id} | ${String(bug.title).replace(/\|/g, '\\|')} | ${SEVERITY_LABELS[bug.severity] || bug.severity} | ${STATUS_LABELS[bug.status] || bug.status} | ${PRIORITY_LABELS[bug.priority] || bug.priority} | ${bug.module || '未归类'} | ${bug.assignee || '—'} | ${bug.occurrence} |`),
    '',
  ];
  return lines.join('\n');
}

function sendDownload(res, contentType, filename, body) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function normalizeSeverity(value) {
  return SEVERITIES.includes(value) ? value : 'major';
}

/**
 * Resolve the signed-in DSH account display name without exposing credentials.
 * Returns an empty string when signed out, unavailable, failed, or timed out.
 */
export async function resolveAccountName(ctx, timeoutMs = 2000) {
  const account = ctx && typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null;
  if (!account || typeof account.getProfile !== 'function') return '';
  let timer;
  try {
    const profile = await Promise.race([
      account.getProfile({
        version: '1.0.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (!profile || profile.status !== 'ready' || !profile.value) return '';
    const value = profile.value;
    return cleanTitle(value.name || '', '');
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeStatus(value) {
  return STATUSES.includes(value) ? value : 'open';
}

function projectLabel(workspace) {
  return baseName(workspace) || '未归类';
}

function statusLine(bug) {
  return `${bug.id} [${STATUS_LABELS[bug.status] || bug.status}] ${bug.title}`;
}

/** Resolve a defect from id, title, free-text query, or latest active entry. */
function resolveBugTarget(store, workspace, input = {}) {
  const id = cleanTitle(input.id, '');
  if (id) return store.get(id);
  if (input.latest === true) {
    return store.list()
      .filter(bug => (!workspace || bug.workspace === workspace)
        && ['new', 'open', 'progress', 'verify'].includes(bug.status))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  }
  const text = cleanTitle(input.query, '') || cleanTitle(input.title, '');
  if (!text) return null;
  const all = store.list().filter(bug => !workspace || bug.workspace === workspace);
  const exact = all.find(bug => bug.title.includes(text) || text.includes(bug.title));
  if (exact) return exact;
  return store.findSimilar({ workspace, title: text, threshold: 0.32 });
}

export async function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const log = message => {
    try {
      ctx.logger?.info(`[qa-guardian] ${message}`);
    } catch {
      // logging must never break capture
    }
  };
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir.trim()
    : defaultDataDir();
  const configuredUser = typeof config.currentUser === 'string' && config.currentUser.trim()
    ? config.currentUser.trim()
    : '';
  const systemUser = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return '';
    }
  })();
  const accountUser = configuredUser ? '' : await resolveAccountName(ctx);
  const currentUser = configuredUser || accountUser || systemUser;
  const store = await new BugStore({
    filePath: path.join(dataDir, 'data.json'),
    log,
    owner: currentUser,
  }).load();
  let reassigned = 0;
  if (accountUser && systemUser && accountUser !== systemUser) {
    reassigned = store.reassignOwner(systemUser, accountUser);
  }
  const assignedOwners = store.assignDefaultOwners();
  if (assignedOwners > 0 || reassigned > 0) await store.flush();
  const sseClients = new Set();
  const notifyClients = () => {
    if (sseClients.size === 0) return;
    const payload = JSON.stringify({
      at: new Date().toISOString(),
      stats: store.stats(),
    });
    for (const client of sseClients) {
      try {
        client.write(`event: change\ndata: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const unsubscribeChange = store.subscribe(notifyClients);

  const capture = config.autoCapture === false
    ? {
      attach: () => () => {},
      contextFor: () => ({ tracker: null, workspace: '', workspaceName: '未归类', sessionId: '', sessionTitle: '' }),
      latestWorkspace: () => '',
      summary: () => [],
    }
    : new Capture({ store, config, log });
  let sessionQuery = null;
  try {
    sessionQuery = ctx.get('sessionQuery');
  } catch {
    sessionQuery = null;
  }

  const stateSnapshot = () => {
    const bugs = store.list();
    const known = new Map();
    for (const project of store.projects()) known.set(project.path, project);
    for (const session of capture.summary()) {
      if (!session.workspace || known.has(session.workspace)) continue;
      known.set(session.workspace, {
        path: session.workspace,
        name: session.workspaceName,
        total: 0,
        active: 0,
        verify: 0,
        lastSeenAt: '',
      });
    }
    const projects = [...known.values()].sort((a, b) => {
      if (!a.lastSeenAt) return 1;
      if (!b.lastSeenAt) return -1;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });
    return {
      ok: true,
      bugs,
      currentUser: store.owner,
      stats: store.stats(),
      projects,
      activity: store.activity(null, 160),
      sessions: capture.summary(),
      updatedAt: new Date().toISOString(),
    };
  };

  const registerRoute = options => ctx.effect(() => ctx.webServer.register(options));

  const stateRoute = registerRoute({
    kind: 'exact',
    path: `${API_BASE}/state`,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      try {
        writeJson(res, 200, stateSnapshot());
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
      }
    },
  });

  const healthRoute = registerRoute({
    kind: 'exact',
    path: `${API_BASE}/health`,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
      let client = null;
      try {
        const registry = ctx.get('clientModules');
        if (registry && typeof registry.graph === 'function') {
          const graph = registry.graph();
          const entries = graph && Array.isArray(graph.entries) ? graph.entries : [];
          const entry = entries.find(item => item && item.id === 'dsh-qa-guardian');
          client = {
            registered: Boolean(entry),
            rev: entry ? entry.rev : null,
            clientPath: typeof registry.clientPath === 'function' ? registry.clientPath('dsh-qa-guardian') || null : null,
            total: entries.length,
            batches: Array.isArray(graph && graph.batches)
              ? graph.batches.map(batch => ({ phase: batch.phase, url: batch.url }))
              : [],
          };
        }
      } catch (error) {
        client = { error: error && error.message ? error.message : String(error) };
      }
      writeJson(res, 200, { ok: true, plugin: name, bugs: store.list().length, client });
    },
  });

  const exportRoute = registerRoute({
    kind: 'exact',
    path: `${API_BASE}/export`,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const format = (url.searchParams.get('format') || 'json').toLowerCase();
        const bugs = store.list();
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === 'csv') {
          return sendDownload(res, 'text/csv; charset=utf-8', `qa-bugs-${stamp}.csv`, exportCsv(bugs));
        }
        if (format === 'md' || format === 'markdown') {
          return sendDownload(res, 'text/markdown; charset=utf-8', `qa-bugs-${stamp}.md`, exportMarkdown(bugs));
        }
        if (format === 'json') {
          return sendDownload(res, 'application/json; charset=utf-8', `qa-bugs-${stamp}.json`, JSON.stringify(store.exportData(), null, 2));
        }
        return writeJson(res, 400, { ok: false, error: 'format must be json, csv or md' });
      } catch (error) {
        return writeJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
      }
    },
  });

  const eventsRoute = registerRoute({
    kind: 'exact',
    path: `${API_BASE}/events`,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseClients.add(res);
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), stats: store.stats() })}\n\n`);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(ping);
          sseClients.delete(res);
        }
      }, 25000);
      if (typeof ping.unref === 'function') ping.unref();
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
    },
  });

  const actionRoute = registerRoute({
    kind: 'exact',
    path: `${API_BASE}/action`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' });
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' });
      try {
        const body = await readJsonBody(req, 10 * 1024 * 1024);
        const action = String(body.action || '');
        if (action === 'create') {
          const workspace = typeof body.workspace === 'string' && body.workspace.trim()
            ? body.workspace.trim()
            : capture.latestWorkspace();
          const bug = store.create({
            title: cleanTitle(body.title, ''),
            description: clip(String(body.description || ''), MAX_DESCRIPTION),
            severity: normalizeSeverity(body.severity),
            status: 'open',
            source: 'manual',
            workspace,
            workspaceName: projectLabel(workspace),
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            tags: Array.isArray(body.tags) ? body.tags : [],
            assignee: typeof body.assignee === 'string' ? body.assignee : '',
            priority: body.priority,
            dueAt: typeof body.dueAt === 'string' ? body.dueAt : '',
            fixVersion: typeof body.fixVersion === 'string' ? body.fixVersion : '',
            foundVersion: typeof body.foundVersion === 'string' ? body.foundVersion : '',
          }, { actor: 'human' });
          return writeJson(res, 200, { ok: true, bug });
        }
        if (action === 'bulk') {
          const ids = Array.isArray(body.ids)
            ? [...new Set(body.ids.filter(id => typeof id === 'string' && id))].slice(0, 200)
            : [];
          if (ids.length === 0) return writeJson(res, 400, { ok: false, error: '未选择缺陷' });
          if (!STATUSES.includes(body.status)) return writeJson(res, 400, { ok: false, error: '无效的目标状态' });
          const note = typeof body.note === 'string' && body.note.trim()
            ? clip(body.note.trim(), 300)
            : `批量操作：${STATUS_LABELS[body.status]}`;
          let updated = 0;
          const missing = [];
          for (const id of ids) {
            if (!store.get(id)) {
              missing.push(id);
              continue;
            }
            store.update(id, { status: body.status }, { actor: 'human', note });
            updated += 1;
          }
          return writeJson(res, 200, { ok: true, updated, missing });
        }
        if (action === 'verify') {
          const bug = store.recordVerification({
            id: String(body.id || ''),
            outcome: String(body.outcome || ''),
            command: String(body.command || ''),
            note: String(body.note || ''),
            actor: 'human',
          });
          return writeJson(res, 200, { ok: true, bug });
        }
        if (action === 'merge') {
          const result = store.mergeBugs(String(body.masterId || ''), body.duplicateIds, { actor: 'human' });
          return writeJson(res, 200, { ok: true, master: result.master, merged: result.merged });
        }
        if (action === 'import') {
          if (store.list().length > 0) {
            await store.flush();
            await store.createBackup();
          }
          const result = await store.importData(body.data);
          return writeJson(res, 200, { ok: true, imported: result.imported });
        }
        if (action === 'backup') {
          const name = await store.createBackup();
          return writeJson(res, 200, { ok: true, name });
        }
        if (action === 'update') {
          const id = String(body.id || '');
          const patch = {};
          for (const key of ['title', 'description', 'severity', 'status', 'assignee', 'module', 'tags', 'priority', 'dueAt', 'fixVersion', 'foundVersion']) {
            if (body[key] !== undefined) patch[key] = body[key];
          }
          const bug = store.update(id, patch, {
            actor: 'human',
            note: typeof body.note === 'string' ? body.note : '',
          });
          return writeJson(res, 200, { ok: true, bug });
        }
        if (action === 'note') {
          const bug = store.update(String(body.id || ''), {}, {
            actor: 'human',
            note: String(body.note || ''),
          });
          return writeJson(res, 200, { ok: true, bug });
        }
        if (action === 'delete') {
          const removed = store.remove(String(body.id || ''), { actor: 'human' });
          return writeJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: '未找到缺陷' });
        }
        return writeJson(res, 400, { ok: false, error: `未知操作：${action || '(empty)'}` });
      } catch (error) {
        return writeJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) });
      }
    },
  });

  const toolOutput = render => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
        lines: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'message'],
    },
    render: (_args, value) => [{ type: 'text', text: value && value.message ? value.message : render }],
  });

  const reportTool = {
    name: 'qa_report_bug',
    description: '【单条缺陷上报】仅用于 DSH 自己发现、不属于用户消息、也不方便用 qa_capture 的单条缺陷。用户消息请用 qa_from_user_report；一轮多条请用 qa_capture。title 必填；描述写现象、预期、复现和证据；相似未关闭缺陷会自动合并。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise defect title (what is broken and where).' },
        description: { type: 'string', description: 'Observed behavior, expected behavior, reproduction steps, and evidence.' },
        severity: { type: 'string', enum: SEVERITIES, description: 'blocker | critical | major | minor (default major).' },
        status: { type: 'string', enum: STATUSES, description: 'Initial status (default open).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
      },
      required: ['title'],
    },
    output: toolOutput('缺陷已记录'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const title = cleanTitle(input.title, '');
      if (!title) return { ok: false, message: '缺陷标题不能为空' };
      const duplicate = store.findSimilar({ workspace: context.workspace, title });
      if (duplicate) {
        store.update(duplicate.id, {}, {
          actor: 'agent',
          note: `Agent 再次报告：${clip(String(input.description || title), 300)}`,
        });
        return { ok: true, message: `已关联到已有缺陷 ${statusLine(duplicate)}` };
      }
      const bug = store.create({
        title,
        description: clip(String(input.description || ''), MAX_DESCRIPTION),
        severity: normalizeSeverity(input.severity),
        status: normalizeStatus(input.status || 'open'),
        source: 'agent',
        workspace: context.workspace,
        workspaceName: context.workspaceName,
        sessionId: context.sessionId,
        sessionTitle: context.sessionTitle,
        module: moduleFromText(context.workspace, `${String(input.description || '')}\n${title}`) || featureFromText(`${String(input.description || '')}\n${title}`),
        tags: Array.isArray(input.tags) ? input.tags : [],
        evidence: context.sessionId ? {
          kind: 'agent-report',
          excerpt: clip(String(input.description || title), 400),
          sessionId: context.sessionId,
        } : null,
      }, { actor: 'agent' });
      return { ok: true, message: `已记录 ${statusLine(bug)}` };
    },
  };

  /**
   * One call per coding turn: record several newly found defects and several
   * fixes at once, so the Agent does not need a tool call per item.
   */
  const captureTool = {
    name: 'qa_capture',
    description: '【每轮编码批量登记】一轮结束（改了代码、跑了构建/测试）后调用，一次提交多条：found[] 新发现的项目缺陷（title 必填；description/severity/evidence 可选）；fixed[] 本轮修复（id/title/query/latest + note + verified）。只放项目缺陷；功能需求、工具调用失败、环境问题不要放进来。单条可用 qa_begin_fix / qa_mark_fixed，更精确。示例：{found:[{title:"登录接口500",severity:"critical"}], fixed:[{query:"点击没反应",verified:false}]}',
    parameters: {
      type: 'object',
      properties: {
        found: {
          type: 'array',
          description: 'Newly found project defects this turn (max 20).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: 'What is broken and where.' },
              description: { type: 'string', description: 'Observed behavior, expected behavior, evidence.' },
              severity: { type: 'string', enum: SEVERITIES, description: 'blocker | critical | major | minor (default major).' },
              module: { type: 'string', description: 'Optional functional module.' },
              assignee: { type: 'string', description: 'Optional owner.' },
              priority: { type: 'string', enum: PRIORITIES, description: 'urgent | high | normal | low.' },
              dueAt: { type: 'string', description: 'Optional due date (ISO date).' },
              fixVersion: { type: 'string', description: 'Optional fix version.' },
              foundVersion: { type: 'string', description: 'Optional found version.' },
              evidence: { type: 'string', description: 'Optional log/test/error excerpt or file location.' },
            },
            required: ['title'],
          },
        },
        fixed: {
          type: 'array',
          description: 'Defects fixed this turn (max 20).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Defect id such as BUG-0003; preferred.' },
              title: { type: 'string', description: 'Title used when the id is unknown; must match an existing defect.' },
              query: { type: 'string', description: 'Free-text symptom to match the defect.' },
              latest: { type: 'boolean', description: 'Use the newest active defect in this workspace.' },
              note: { type: 'string', description: 'What was changed and how it was verified.' },
              commit: { type: 'string', description: 'Optional Git commit SHA/subject that contains this fix.' },
              verified: { type: 'boolean', description: 'true closes it; false or omitted moves it to 待验证.' },
            },
          },
        },
      },
    },
    output: toolOutput('QA 本轮已登记'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const lines = [];
      const found = Array.isArray(input.found) ? input.found.slice(0, 20) : [];
      const fixed = Array.isArray(input.fixed) ? input.fixed.slice(0, 20) : [];
      const seen = new Set();
      for (const item of found) {
        if (!item || typeof item !== 'object') continue;
        const title = cleanTitle(item.title, '');
        if (!title || seen.has(title)) continue;
        seen.add(title);
        const duplicate = store.findSimilar({ workspace: context.workspace, title });
        if (duplicate) {
          store.update(duplicate.id, {}, {
            actor: 'agent',
            note: `本轮复核：${clip(String(item.description || item.evidence || title), 300)}`,
          });
          if (duplicate.status === 'closed' || duplicate.status === 'verify') {
            store.update(duplicate.id, { status: 'open' }, {
              actor: 'agent',
              note: '同类问题再次出现，重新打开',
            });
          }
          lines.push(`关联 ${statusLine(duplicate)}`);
          continue;
        }
        const bug = store.create({
          title,
          description: clip(String(item.description || ''), MAX_DESCRIPTION),
          severity: normalizeSeverity(item.severity),
          status: 'open',
          source: 'agent',
          workspace: context.workspace,
          workspaceName: context.workspaceName,
          sessionId: context.sessionId,
          sessionTitle: context.sessionTitle,
          module: item.module || moduleFromText(context.workspace, `${String(item.evidence || '')}\n${String(item.description || '')}`) || featureFromText(`${String(item.evidence || '')}\n${String(item.description || '')}`),
          assignee: item.assignee || '',
          priority: item.priority,
          dueAt: item.dueAt || '',
          fixVersion: item.fixVersion || '',
          foundVersion: item.foundVersion || '',
          evidence: {
            kind: 'agent-report',
            excerpt: clip(String(item.evidence || item.description || title), 700),
            sessionId: context.sessionId,
          },
        }, { actor: 'agent' });
        lines.push(`新增 ${statusLine(bug)}`);
      }
      for (const item of fixed) {
        if (!item || typeof item !== 'object') continue;
        const target = resolveBugTarget(store, context.workspace, item);
        if (!target) {
          lines.push(`未找到缺陷：${clip(String(item.id || item.title || '(empty)'), 60)}`);
          continue;
        }
        const status = item.verified === true ? 'closed' : 'verify';
        store.update(target.id, { status }, {
          actor: 'agent',
          note: cleanTitle(item.note, 'Agent 标记已修复'),
        });
        if (typeof item.commit === 'string' && item.commit.trim()) {
          store.addEvidence(target, {
            kind: 'git-commit',
            excerpt: clip(item.commit.trim(), 300),
            sessionId: context.sessionId,
          });
        }
        lines.push(`${target.id} → ${STATUS_LABELS[status]}`);
      }
      if (lines.length === 0) return { ok: true, message: '本轮没有需要登记的项目缺陷。' };
      return { ok: true, message: lines.join('\n'), lines };
    },
  };

  /** Record a bug that the user just reported, in the user's own words. */
  const fromUserReportTool = {
    name: 'qa_from_user_report',
    description: '【用户消息分类与登记】用户发来消息后先分类：bug（实际发生的现象）才进缺陷看板；feature（新增/调整需求）和 question（提问）不要登记为缺陷。单条用 report + kind；一条消息混有多种内容时用 items[] 逐条分类，只有 kind:"bug" 的项会创建缺陷。返回每条的处理结果（已记录 / 已合并 / 跳过（功能需求/提问））。示例：items:[{text:"看板中已关闭项不消失",kind:"bug"},{text:"增加日历",kind:"feature"}]',
    parameters: {
      type: 'object',
      properties: {
        report: { type: 'string', description: 'The user report, quoted or lightly normalized.' },
        items: {
          type: 'array',
          description: 'Split a mixed message into separately classified items (max 20).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', description: 'One part of the user message.' },
              kind: { type: 'string', enum: ['bug', 'feature', 'question'], description: 'Classification of this part.' },
              title: { type: 'string', description: 'Optional concise defect title.' },
              severity: { type: 'string', enum: SEVERITIES, description: 'blocker | critical | major | minor.' },
            },
            required: ['text', 'kind'],
          },
        },
        title: { type: 'string', description: 'Optional concise defect title for a single report.' },
        severity: { type: 'string', enum: SEVERITIES, description: 'blocker | critical | major | minor.' },
        kind: { type: 'string', enum: ['bug', 'feature', 'question'], description: 'Classification for a single report. Only bug creates a defect.' },
      },
    },
    output: toolOutput('用户反馈已记录'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const rawItems = Array.isArray(input.items) ? input.items.slice(0, 20) : [];
      const report = cleanTitle(input.report, '');
      if (rawItems.length === 0 && !report) return { ok: false, message: '用户反馈内容不能为空' };
      const sourceReport = report || rawItems.map(item => cleanTitle(item.text, '')).filter(Boolean).join('\n');
      const items = rawItems.length > 0
        ? rawItems
        : [{ text: report, kind: input.kind, title: input.title, severity: input.severity }];
      const lines = [];
      for (const item of items) {
        const text = cleanTitle(item.text, '');
        if (!text) continue;
        const parsed = analyzeUserText(text, context.workspace);
        const kind = ['bug', 'feature', 'question'].includes(item.kind) ? item.kind : parsed.kind;
        if (kind !== 'bug') {
          const label = kind === 'feature' ? '功能需求' : kind === 'question' ? '提问' : '非缺陷';
          lines.push(`跳过（${label}）：${clip(text, 60)}`);
          continue;
        }
        const draft = parsed.bugs[0];
        const title = cleanTitle(item.title, '') || (draft ? draft.title : clip(text, 120));
        const description = sourceReport && sourceReport !== text
          ? `${text}\n\n原消息：\n${sourceReport}`
          : text;
        const result = store.recordUserReport({
          draft: {
            title,
            description: clip(description, MAX_DESCRIPTION),
            severity: normalizeSeverity(item.severity || (draft ? draft.severity : 'major')),
            module: draft ? draft.module : featureFromText(text),
            signature: draft ? draft.signature : '',
            excerpt: clip(text, 400),
          },
          workspace: context.workspace,
          workspaceName: context.workspaceName,
          sessionId: context.sessionId,
          sessionTitle: context.sessionTitle,
          evidence: {
            kind: 'user-report',
            excerpt: clip(text, 500),
            sessionId: context.sessionId,
          },
          actor: 'agent',
        });
        if (!result || !result.bug) return { ok: false, message: '用户反馈未能记录' };
        lines.push(`${result.created ? '已记录' : '已合并到'} ${statusLine(result.bug)}`);
      }
      return {
        ok: true,
        message: lines.length > 0 ? lines.join('\n') : '已分类：没有需要登记的缺陷。',
        lines,
      };
    },
  };

  /** Replay recent session logs to recover user-reported defects from before install. */
  const backfillTool = {
    name: 'qa_backfill_sessions',
    description: '【历史回填】仅在用户说历史 bug 没抓到、或刚安装插件时调用。扫描最近 days 天的会话日志，只补录用户反馈和修复表述；跳过 subagent 和评审会话。可能耗时，不要每轮调用。',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Absolute workspace path; defaults to the current session workspace.' },
        days: { type: 'integer', description: 'How many recent days of session logs to scan (default 2).' },
        limit: { type: 'integer', description: 'Maximum session files (default 20, cap 60).' },
        force: { type: 'boolean', description: 'Rescan sessions already processed.' },
      },
    },
    output: toolOutput('历史会话扫描完成'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const workspace = typeof input.workspace === 'string' && input.workspace.trim()
        ? input.workspace.trim()
        : context.workspace;
      const result = await backfillSessions({
        store,
        capture,
        sessionQuery,
        log,
        workspace,
        days: Number.isSafeInteger(input.days) ? Math.max(1, Math.min(30, input.days)) : 2,
        limit: Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(60, input.limit)) : 40,
        force: input.force === true,
      });
      const lines = [
        `扫描 ${result.scanned} 个会话（候选 ${result.files} 个，跳过 ${result.skipped} 个）`,
        `新增 ${result.created} 条缺陷，处理 ${result.processed} 条消息`,
        ...result.touched,
      ];
      return { ok: true, message: lines.join('\n'), lines };
    },
  };

  /**
   * Dedicated fix transition: after changing code, mark the matching defect
   * 待验证, or 已修复 when the same turn verified it.
   */
  /**
   * Simple, model-friendly transition: start fixing a defect before editing.
   * Accepts id/title/query/latest so the model does not need to list first.
   */
  const beginFixTool = {
    name: 'qa_begin_fix',
    description: '【开始修复】在第一次编辑文件、跑命令或改配置之前调用。把匹配缺陷改为「机器人修复中」，记录 module/note，并返回实际 BUG 编号。目标定位优先级：id > title > query（用户原话或症状）> latest:true（当前工作区最近未关闭）。不要用它登记新缺陷，也不要用它把缺陷标成已修复。示例：{query:"点击没反应", module:"日志检索", note:"先查事件绑定"}',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Defect id such as BUG-0001.' },
        title: { type: 'string', description: 'Defect title or a distinctive part of it.' },
        query: { type: 'string', description: 'Free-text symptom, e.g. “点击没反应” or “日志总量为0”.' },
        latest: { type: 'boolean', description: 'Use the newest active defect in this workspace.' },
        module: { type: 'string', description: 'Optional functional module, e.g. 日志检索.' },
        note: { type: 'string', description: 'Short note about what you are about to change.' },
      },
    },
    output: toolOutput('修复状态已开始'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      let target = resolveBugTarget(store, context.workspace, input);
      if (!target && !input.id && !input.title && !input.query) {
        target = resolveBugTarget(store, context.workspace, { latest: true });
      }
      if (!target) {
        return { ok: false, message: '未找到匹配缺陷；可先调用 qa_list_bugs 查看当前看板，或传入 latest:true。' };
      }
      const patch = { status: 'progress' };
      if (typeof input.module === 'string' && input.module.trim()) patch.module = clip(oneLine(input.module), 80);
      store.update(target.id, patch, {
        actor: 'agent',
        note: cleanTitle(input.note, 'DSH 开始修复'),
      });
      return {
        ok: true,
        message: `${target.id} → 机器人修复中${patch.module ? `（${patch.module}）` : ''}`,
      };
    },
  };

  const markFixedTool = {
    name: 'qa_mark_fixed',
    description: '【修复完成】改完代码后调用。默认改为「待验证」；verified:true 改为「已修复」。目标支持 id / title / query / latest，返回实际 BUG 编号。只有在跑过测试或实际验证通过时才传 verified:true；只是“代码改完了”请用默认值进入待验证。若已提交 Git，可把 commit（SHA 或提交标题）一起传入。多个修复请用 qa_capture.fixed。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Defect id such as BUG-0001; preferred.' },
        title: { type: 'string', description: 'Exact or similar defect title when the id is unknown.' },
        query: { type: 'string', description: 'Free-text symptom to match a defect.' },
        latest: { type: 'boolean', description: 'Use the newest active defect in this workspace.' },
        note: { type: 'string', description: 'What was changed and how it was verified.' },
        commit: { type: 'string', description: 'Optional Git commit SHA/subject that contains this fix.' },
        verified: { type: 'boolean', description: 'true closes the defect; false or omitted moves it to 待验证.' },
      },
    },
    output: toolOutput('缺陷修复状态已更新'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const target = resolveBugTarget(store, context.workspace, input);
      if (!target) {
        return { ok: false, message: '未找到匹配缺陷；可先调用 qa_list_bugs 查看当前看板，或传入 latest:true。' };
      }
      const status = input.verified === true ? 'closed' : 'verify';
      store.update(target.id, { status }, {
        actor: 'agent',
        note: cleanTitle(input.note, input.verified === true ? 'Agent 修复并验证通过' : 'Agent 标记已修复'),
      });
      if (typeof input.commit === 'string' && input.commit.trim()) {
        store.addEvidence(target, {
          kind: 'git-commit',
          excerpt: clip(input.commit.trim(), 300),
          sessionId: context.sessionId,
        });
      }
      return { ok: true, message: `${target.id} → ${STATUS_LABELS[status]}` };
    },
  };

  const updateTool = {
    name: 'qa_update_bug',
    description: '【状态/备注调整】用于 progress / ignored / closed 等非标准流转，或只追加备注。目标支持 id / title / query / latest。开始修复优先用 qa_begin_fix，修复完成优先用 qa_mark_fixed；不要用本工具重复登记缺陷。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Defect id such as BUG-0001.' },
        title: { type: 'string', description: 'Defect title or distinctive part.' },
        query: { type: 'string', description: 'Free-text symptom to match a defect.' },
        latest: { type: 'boolean', description: 'Use the newest active defect in this workspace.' },
        status: { type: 'string', enum: STATUSES, description: 'New status.' },
        note: { type: 'string', description: 'Short progress/verification note.' },
      },
    },
    output: toolOutput('缺陷已更新'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const target = resolveBugTarget(store, context.workspace, input);
      if (!target) return { ok: false, message: '未找到匹配缺陷；可先调用 qa_list_bugs，或传入 latest:true。' };
      if (!input.status && !String(input.note || '').trim()) {
        return { ok: false, message: '请至少提供 status 或 note。' };
      }
      const bug = store.update(target.id, {
        ...(input.status ? { status: input.status } : {}),
      }, { actor: 'agent', note: String(input.note || '') });
      return { ok: true, message: `已更新 ${statusLine(bug)}` };
    },
  };

  const listTool = {
    name: 'qa_list_bugs',
    description: '【查看看板】列出当前工作区缺陷，返回 BUG 编号 / 状态 / 标题 / 严重度。开始新任务前查重，或需要 BUG 编号时调用。status / severity / query 可过滤，limit 默认 20。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'Filter by status.' },
        severity: { type: 'string', enum: SEVERITIES, description: 'Filter by severity.' },
        query: { type: 'string', description: 'Search title/description, e.g. a user symptom.' },
        limit: { type: 'integer', description: 'Maximum rows (default 20, max 50).' },
      },
    },
    output: toolOutput('缺陷列表'),
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      const context = capture.contextFor(exec && exec.agent);
      const limit = Math.min(50, Math.max(1, Number.isSafeInteger(input.limit) ? input.limit : 20));
      const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const bugs = store.list().filter(bug => (!context.workspace || bug.workspace === context.workspace)
        && (!input.status || bug.status === input.status)
        && (!input.severity || bug.severity === input.severity)
        && (!needle || `${bug.id} ${bug.title} ${bug.description}`.toLowerCase().includes(needle))).slice(0, limit);
      if (bugs.length === 0) return { ok: true, message: '当前工作区没有匹配的缺陷。' };
      const lines = bugs.map(bug => `${statusLine(bug)}（${SEVERITY_LABELS[bug.severity] || bug.severity}）`);
      return { ok: true, message: `共 ${bugs.length} 条缺陷：\n${lines.join('\n')}`, lines };
    },
  };

  const statsTool = {
    name: 'qa_bug_stats',
    description: '【缺陷统计】返回当前工作区按状态、严重度的计数，用于快速汇报；只读，不修改数据。',
    parameters: { type: 'object', properties: {} },
    output: toolOutput('缺陷统计'),
    async execute(_args, exec) {
      const context = capture.contextFor(exec && exec.agent);
      const stats = store.stats(context.workspace || undefined);
      const lines = [
        `总计 ${stats.total} 条`,
        ...STATUSES.map(status => `${STATUS_LABELS[status]} ${stats.byStatus[status] || 0}`),
        ...SEVERITIES.map(severity => `${SEVERITY_LABELS[severity]} ${stats.bySeverity[severity] || 0}`),
      ];
      return { ok: true, message: lines.join(' · '), lines };
    },
  };

  ctx.effect(() => {
    const disposers = [];
    disposers.push(capture.attach(ctx));
    if (typeof ctx.systemPrompt?.section === 'function') {
      disposers.push(ctx.systemPrompt.section({
        name: 'plugin:qa-guardian',
        order: 40,
        text: typeof config.announcement === 'string' && config.announcement ? config.announcement : ANNOUNCEMENT,
      }));
    }
    const tools = [captureTool, fromUserReportTool, beginFixTool, markFixedTool, listTool, backfillTool];
    for (const tool of tools) ctx.tools.register(tool);
    disposers.push(eventsRoute, stateRoute, healthRoute, actionRoute);
    // Recover defects reported before this install; stamped so it runs once per file.
    const backfillTimer = config.backfillOnStart !== false && config.autoCapture !== false
      ? setTimeout(() => {
        if (Date.now() - store.backfillStamp('__auto__') < 6 * 60 * 60 * 1000) return;
        void backfillSessions({
          store,
          capture,
          sessionQuery,
          log,
          days: Number.isSafeInteger(config.backfillDays) ? Math.max(1, Math.min(30, config.backfillDays)) : 2,
          limit: 40,
        }).then(result => {
          store.markBackfilled('__auto__', Date.now());
          if (result.created > 0) {
            log(`backfill imported ${result.created} defects from ${result.scanned} recent sessions`);
          }
        }).catch(error => log(`backfill failed: ${error && error.message}`));
      }, 4000)
      : null;
    if (backfillTimer && typeof backfillTimer.unref === 'function') backfillTimer.unref();
    return () => {
      if (backfillTimer) clearTimeout(backfillTimer);
      unsubscribeChange();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // stream may already be closed
        }
      }
      sseClients.clear();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          // teardown is best effort
        }
      }
      void store.dispose();
    };
  }, 'qa-guardian: capture, tools, routes');

  log(`ready: ${store.list().length} defects, data at ${dataDir}`);
}