/**
 * QA Guardian browser half.
 *
 * A native Harness panel registered at `main` plus one `sidebar.panellist`
 * entry. Data comes from `/api/qa-guardian/state`; mutations go through
 * `/api/qa-guardian/action`. No iframe, no external assets, no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-qa-guardian',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/api/qa-guardian';
    const PANEL_ID = 'qa-guardian';
    const PANEL_LABEL = 'QA 缺陷追踪';

    const STATUS = {
      new: { label: '待确认', tone: 'neutral' },
      open: { label: '待修复', tone: 'danger' },
      progress: { label: '修复中', tone: 'business' },
      verify: { label: '待验证', tone: 'warning' },
      'cannot-reproduce': { label: '无法复现', tone: 'neutral' },
      duplicate: { label: '重复', tone: 'neutral' },
      closed: { label: '已关闭', tone: 'success' },
      ignored: { label: '已忽略', tone: 'neutral' },
    };

    const FIX_STATE = {
      new: { label: '未确认', tone: 'neutral' },
      open: { label: '未修复', tone: 'danger' },
      progress: { label: '修复中', tone: 'business' },
      verify: { label: '待验证', tone: 'warning' },
      'cannot-reproduce': { label: '无法复现', tone: 'neutral' },
      duplicate: { label: '重复', tone: 'neutral' },
      closed: { label: '已修复', tone: 'success' },
      ignored: { label: '已忽略', tone: 'neutral' },
    };

    function fixStateOf(status) {
      return FIX_STATE[status] || FIX_STATE.new;
    }

    const SOURCE_TONE = {
      user: 'user',
      auto: 'auto',
      agent: 'agent',
      manual: 'manual',
    };
    const BOARD_COLUMNS = ['new', 'open', 'progress', 'verify'];
    const SEVERITY = {
      blocker: { label: '致命', tone: 'danger' },
      critical: { label: '严重', tone: 'critical' },
      major: { label: '一般', tone: 'warning' },
      minor: { label: '轻微', tone: 'neutral' },
    };
    const PRIORITY = {
      urgent: { label: '紧急', tone: 'danger' },
      high: { label: '高', tone: 'warning' },
      normal: { label: '普通', tone: 'neutral' },
      low: { label: '低', tone: 'neutral' },
    };
    const SOURCE = { auto: 'DSH 自动', user: '用户提出', agent: 'Agent 上报', manual: '人工记录' };
    const EVIDENCE_KIND = {
      'tool-error': '工具失败',
      'assistant-text': '对话提取',
      resolution: '修复表述',
      'rerun-ok': '重跑通过',
      'git-commit': 'Git 提交',
      verification: '验证记录',
      merge: '合并记录',
      'fix-start': '开始修复',
      'agent-report': 'Agent 报告',
      'user-report': '用户提出',
      'user-confirm': '用户确认',
      observation: '观察',
    };
    const ACTIVITY_TYPE = {
      created: '新建缺陷',
      status: '状态变更',
      evidence: '新增证据',
      note: '记录备注',
      updated: '更新缺陷',
      deleted: '删除缺陷',
      merged: '合并缺陷',
    };

    const HELP_TOOLS = [
      {
        name: 'qa_capture',
        tag: '每轮编码后',
        purpose: '批量登记本轮新发现和已修复的缺陷，一次调用处理多条。',
        params: 'found[]：title / description / severity / evidence；fixed[]：id / title / note / verified',
      },
      {
        name: 'qa_from_user_report',
        tag: '用户反馈',
        purpose: '用户消息先分类：bug 进看板；feature/question 用 kind 跳过。一条消息混了 bug 和需求时，用 items[] 拆开逐条分类。',
        params: 'report、items[]（text + kind）、kind、title、severity',
      },
      {
        name: 'qa_begin_fix',
        tag: '开始修复',
        purpose: '开始改代码/跑命令前调用，把缺陷标为机器人修复中；支持 id、title、query 或 latest，无需先查编号。',
        params: 'id / title / query / latest、module、note',
      },
      {
        name: 'qa_mark_fixed',
        tag: '修复后',
        purpose: '修复完成后标记待验证或已修复；同样支持 id、title、query、latest，可附带 Git commit。',
        params: 'id / title / query / latest、verified、commit、note',
      },
      {
        name: 'qa_list_bugs',
        tag: '查询',
        purpose: '按状态、严重度或关键词查看当前工作区缺陷，用于查重和找编号。',
        params: 'status、severity、query、limit',
      },
      {
        name: 'qa_backfill_sessions',
        tag: '历史回填',
        purpose: '扫描最近会话日志，补录安装前遗漏的用户反馈。',
        params: 'workspace、days、limit、force',
      },
    ];

    async function requestState(signal) {
      const response = await fetch(`${API}/state`, { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`读取看板失败（HTTP ${response.status}）`);
      const data = await response.json();
      if (!data || data.ok !== true) throw new Error((data && data.error) || '读取看板失败');
      return data;
    }

    async function sendAction(payload) {
      const response = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || `操作失败（HTTP ${response.status}）`);
      }
      return data;
    }

    function localDay(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = number => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function timeAgo(iso) {
      const value = Date.parse(iso || '');
      if (Number.isNaN(value)) return '—';
      const diff = Date.now() - value;
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
      if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
      const date = new Date(value);
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    function fullTime(iso) {
      const value = Date.parse(iso || '');
      if (Number.isNaN(value)) return '—';
      const date = new Date(value);
      const pad = number => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function actorLabel(actor) {
      if (actor === 'auto') return '自动';
      if (actor === 'agent') return 'Agent';
      if (actor === 'user') return '用户';
      return '人工';
    }

    function dayGroup(iso) {
      const value = Date.parse(iso || '');
      if (Number.isNaN(value)) return '未知时间';
      const date = new Date(value);
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (value >= start) return '今天';
      if (value >= start - 86400000) return '昨天';
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }

    function dateKey(year, month, day) {
      const pad = number => String(number).padStart(2, '0');
      return `${year}-${pad(month + 1)}-${pad(day)}`;
    }

    function monthCells(year, month) {
      const first = new Date(year, month, 1);
      const offset = (first.getDay() + 6) % 7;
      const start = new Date(year, month, 1 - offset);
      return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
        return {
          date,
          key: dateKey(date.getFullYear(), date.getMonth(), date.getDate()),
          inMonth: date.getMonth() === month,
        };
      });
    }

    const CALENDAR_KIND = {
      created: { label: '新增', tone: 'business' },
      closed: { label: '已修复', tone: 'success' },
      progress: { label: '修复中', tone: 'business' },
      verify: { label: '待验证', tone: 'warning' },
      reopened: { label: '重新打开', tone: 'danger' },
      status: { label: '状态变化', tone: 'neutral' },
    };

    const ICONS = {
      bug: ['M5 5.5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0v-5Z', 'M11 7h2.5M11 10h2.5M5 7H2.5M5 10H2.5', 'M6.5 2.5 7.4 4M9.5 2.5 8.6 4', 'M6.5 13.5l.9-1.5M9.5 13.5l-.9-1.5'],
      plus: ['M8 3.2v9.6M3.2 8h9.6'],
      refresh: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.7', 'M13.4 2.6v3.2h-3.2'],
      search: ['M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Z', 'm11.2 11.2 2.6 2.6'],
      close: ['M4 4l8 8M12 4l-8 8'],
      board: ['M2.5 3.5h11v9h-11z', 'M5.6 3.5v9M10.4 3.5v9'],
      list: ['M5.5 4h8M5.5 8h8M5.5 12h8', 'M2.6 4h.1M2.6 8h.1M2.6 12h.1'],
      activity: ['M2.4 8h2.4l1.4-3.6L8.6 12l1.5-4h3.5'],
      calendar: ['M3.2 4.2h9.6v9H3.2z', 'M3.2 7h9.6', 'M5.8 2.8v2.8M10.2 2.8v2.8', 'M5.5 9.2h.1M8 9.2h.1M10.5 9.2h.1M5.5 11.3h.1M8 11.3h.1'],
      check: ['M3.2 8.4 6.4 11.5 12.8 4.8'],
      alert: ['M8 2.5 14 13H2L8 2.5Z', 'M8 6v3.4M8 11.2v.1'],
      trash: ['M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.6 8.5h4.8l.6-8.5', 'M6.8 6.8v4M9.2 6.8v4'],
      edit: ['M10.7 2.8 13.2 5.3 5.6 12.9 2.7 13.3l.4-2.9 7.6-7.6Z'],
      help: ['M8 14.2a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4Z', 'M6.2 6.1a1.9 1.9 0 1 1 3.1 1.5c-.8.6-1.3 1-1.3 2', 'M8 11.6v.1'],
      bot: ['M4.2 5.8h7.6v5.4H4.2z', 'M8 2.6v3.2', 'M2.8 7v3M13.2 7v3', 'M6.4 8.2v.1M9.6 8.2v.1', 'M6.4 9.9h3.2'],
      inbox: ['M2.4 9.2h3l1 1.8h3.2l1-1.8h3', 'M2.4 9.2 4 3.4h8l1.6 5.8v3.4H2.4V9.2Z'],
      chevron: ['m6 3.5 4.5 4.5L6 12.5'],
    };

    function icon(name, size = 16) {
      const paths = ICONS[name] || [];
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.45,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    function SeverityPill({ severity }) {
      const meta = SEVERITY[severity] || SEVERITY.major;
      return h('span', { className: `qag-pill qag-pill--${meta.tone}` }, meta.label);
    }

    function StatusPill({ status }) {
      const meta = STATUS[status] || STATUS.new;
      return h('span', { className: `qag-status qag-status--${meta.tone}` }, meta.label);
    }

    function SourceTag({ source }) {
      const label = SOURCE[source] || '人工记录';
      return h('span', { className: `qag-chip qag-chip--src-${SOURCE_TONE[source] || 'manual'}` }, label);
    }

    function isBotFix(bug) {
      if (!bug || bug.status !== 'progress') return false;
      const history = Array.isArray(bug.history) ? bug.history : [];
      const lastProgress = [...history].reverse().find(entry => entry && entry.to === 'progress');
      return Boolean(lastProgress && (lastProgress.actor === 'agent' || lastProgress.actor === 'auto'));
    }

    function FixTag({ bug, status }) {
      const effective = bug ? bug.status : status;
      const meta = fixStateOf(effective);
      const bot = isBotFix(bug);
      const label = bot ? '机器人修复中' : meta.label;
      return h('span', {
        className: `qag-chip qag-chip--fix-${meta.tone}${bot ? ' is-bot' : ''}`,
        title: `修复状态：${label}`,
      }, [
        bot ? h('span', { key: 'i', className: 'qag-chip__icon' }, icon('bot', 11)) : null,
        h('span', { key: 'l' }, label),
      ]);
    }

    function ModuleTag({ module }) {
      if (!module) return null;
      return h('span', {
        className: 'qag-chip qag-chip--module',
        title: `功能模块：${module}`,
      }, module);
    }

    function PriorityTag({ priority }) {
      if (!priority || priority === 'normal') return null;
      const meta = PRIORITY[priority] || PRIORITY.normal;
      return h('span', {
        className: `qag-chip qag-chip--priority qag-tone-${meta.tone}`,
        title: `优先级：${meta.label}`,
      }, meta.label);
    }

    function AssigneeTag({ assignee }) {
      if (!assignee) return null;
      return h('span', {
        className: 'qag-chip qag-chip--assignee',
        title: `负责人：${assignee}`,
      }, assignee);
    }

    function Stat({ label, value, tone, active, onClick }) {
      return h('button', {
        type: 'button',
        className: `qag-stat${active ? ' is-active' : ''}`,
        onClick,
        'aria-pressed': active ? 'true' : 'false',
      }, [
        h('span', { key: 'v', className: `qag-stat__value${tone ? ` qag-tone-${tone}` : ''}` }, String(value)),
        h('span', { key: 'l', className: 'qag-stat__label' }, label),
      ]);
    }

    function EmptyState({ title, hint }) {
      return h('div', { className: 'qag-empty' }, [
        h('span', { key: 'i', className: 'qag-empty__icon' }, icon('inbox', 26)),
        h('div', { key: 't', className: 'qag-empty__title' }, title),
        hint ? h('div', { key: 'h', className: 'qag-empty__hint' }, hint) : null,
      ]);
    }

    function BulkBar({ count, hiddenCount, busy, onVerify, onSolve, onIgnore, onClear }) {
      return h('div', { className: 'qag-bulkbar' }, [
        h('span', { key: 'count', className: 'qag-bulkbar__count' }, `已选 ${count} 条${hiddenCount > 0 ? `（${hiddenCount} 条不在当前筛选）` : ''}`),
        h('span', { key: 'spacer', className: 'qag-bulkbar__spacer' }),
        h('button', {
          key: 'verify',
          type: 'button',
          className: 'qag-btn qag-btn--ghost qag-btn--sm',
          disabled: busy,
          onClick: onVerify,
        }, '标记待验证'),
        h('button', {
          key: 'closed',
          type: 'button',
          className: 'qag-btn qag-btn--primary qag-btn--sm',
          disabled: busy,
          onClick: onSolve,
        }, [icon('check', 13), h('span', { key: 'l' }, '一键解决')]),
        h('button', {
          key: 'ignored',
          type: 'button',
          className: 'qag-btn qag-btn--danger-ghost qag-btn--sm',
          disabled: busy,
          onClick: onIgnore,
        }, '一键忽略'),
        h('button', {
          key: 'clear',
          type: 'button',
          className: 'qag-linkbtn',
          onClick: onClear,
        }, '取消选择'),
      ]);
    }

    function Card({ bug, onOpen, onDragStart, selected, onToggle }) {
      return h('article', {
        className: `qag-card qag-card--${(SEVERITY[bug.severity] || SEVERITY.major).tone}`,
        tabIndex: 0,
        role: 'button',
        draggable: true,
        onDragStart: event => onDragStart(event, bug.id),
        onClick: () => onOpen(bug.id),
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(bug.id);
          }
        },
        'aria-label': `${bug.id} ${bug.title}`,
      }, [
        h('div', { key: 'top', className: 'qag-card__top' }, [
          h('input', {
            key: 'check',
            type: 'checkbox',
            className: 'qag-check qag-card__check',
            checked: Boolean(selected),
            onClick: event => event.stopPropagation(),
            onChange: () => onToggle(bug.id),
            'aria-label': `选择 ${bug.id}`,
          }),
          h(SeverityPill, { key: 'sev', severity: bug.severity }),
          bug.occurrence > 1
            ? h('span', { key: 'occ', className: 'qag-card__occ', title: `共出现 ${bug.occurrence} 次` }, `×${bug.occurrence}`)
            : null,
        ]),
        h('h3', { key: 'title', className: 'qag-card__title' }, bug.title),
        h('div', { key: 'tags', className: 'qag-card__tags' }, [
          h(SourceTag, { key: 'src', source: bug.source }),
          h(FixTag, { key: 'fix', bug }),
          h(PriorityTag, { key: 'priority', priority: bug.priority }),
          h(ModuleTag, { key: 'module', module: bug.module }),
          h(AssigneeTag, { key: 'assignee', assignee: bug.assignee }),
        ]),
        h('div', { key: 'meta', className: 'qag-card__meta' }, [
          h('span', { key: 'p', className: 'qag-card__project', title: bug.workspace || '' }, bug.workspaceName || '未归类'),
          h('span', { key: 'dot', className: 'qag-dot' }),
          h('span', { key: 't' }, timeAgo(bug.updatedAt)),
        ]),
        h('div', { key: 'id', className: 'qag-card__id' }, bug.id),
      ]);
    }

    function Board({ bugs, onOpen, onDropStatus, onDragStart, selectedIds, onToggle, onToggleAll, onBulk, onClear, busy, closedCount, onShowClosed }) {
      const [over, setOver] = useState('');
      const visibleSelected = bugs.filter(bug => selectedIds.has(bug.id)).length;
      const allSelected = bugs.length > 0 && visibleSelected === bugs.length;
      const someSelected = visibleSelected > 0 && !allSelected;
      return h('div', { className: 'qag-board-wrap' }, [
        h('div', { key: 'bar', className: 'qag-boardbar' }, [
          h('label', { key: 'all', className: 'qag-inline-field' }, [
            h('input', {
              type: 'checkbox',
              className: 'qag-check',
              checked: allSelected,
              ref: node => {
                if (node) node.indeterminate = Boolean(someSelected);
              },
              onChange: () => onToggleAll(bugs),
              'aria-label': '全选当前看板',
            }),
            h('span', { key: 'l' }, `全选当前看板（${bugs.length}）`),
          ]),
          closedCount > 0 ? h('button', {
            key: 'closed',
            type: 'button',
            className: 'qag-linkbtn',
            onClick: onShowClosed,
          }, `已关闭 ${closedCount} 条 · 去列表查看`) : null,
          selectedIds.size > 0 ? h(BulkBar, {
            key: 'bulk',
            count: selectedIds.size,
            hiddenCount: Math.max(0, selectedIds.size - visibleSelected),
            busy,
            onVerify: () => onBulk('verify', '待验证'),
            onSolve: () => onBulk('closed', '已修复'),
            onIgnore: () => onBulk('ignored', '已忽略'),
            onClear,
          }) : null,
        ]),
        h('div', { key: 'board', className: 'qag-board' }, BOARD_COLUMNS.map(column => {
          const meta = STATUS[column];
          const items = bugs.filter(bug => bug.status === column);
          return h('section', {
            key: column,
            className: `qag-column${over === column ? ' is-over' : ''}`,
            onDragOver: event => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (over !== column) setOver(column);
            },
            onDragLeave: event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setOver('');
            },
            onDrop: event => {
              event.preventDefault();
              setOver('');
              const id = event.dataTransfer.getData('text/plain');
              if (id) onDropStatus(id, column);
            },
          }, [
            h('header', { key: 'h', className: 'qag-column__head' }, [
              h('span', { key: 't', className: `qag-column__title qag-tone-${meta.tone}` }, meta.label),
              h('span', { key: 'c', className: 'qag-column__count' }, String(items.length)),
            ]),
            h('div', { key: 'body', className: 'qag-column__body' }, items.length === 0
              ? h('div', { className: 'qag-column__empty' }, '暂无缺陷')
              : items.map(bug => h(Card, {
                key: bug.id,
                bug,
                onOpen,
                onDragStart,
                selected: selectedIds.has(bug.id),
                onToggle,
              }))),
          ]);
        })),
      ]);
    }

    function BugTable({ bugs, onOpen, selectedIds, onToggle, onToggleAll, allSelected, someSelected }) {
      if (bugs.length === 0) {
        return h(EmptyState, { title: '没有匹配的缺陷', hint: '调整筛选条件，或在右上角新建一条缺陷。' });
      }
      return h('div', { className: 'qag-table-wrap' }, h('table', { className: 'qag-table' }, [
        h('thead', { key: 'head' }, h('tr', null, [
          h('th', { key: 'check', className: 'qag-col-check' }, h('input', {
            type: 'checkbox',
            className: 'qag-check',
            checked: allSelected,
            ref: node => {
              if (node) node.indeterminate = Boolean(someSelected);
            },
            onChange: onToggleAll,
            'aria-label': '全选当前筛选结果',
            title: '全选当前筛选结果',
          })),
          h('th', { key: 'id', className: 'qag-col-id' }, '编号'),
          h('th', { key: 'title' }, '缺陷'),
          h('th', { key: 'sev', className: 'qag-col-sev' }, '严重度'),
          h('th', { key: 'priority', className: 'qag-col-priority' }, '优先级'),
          h('th', { key: 'source', className: 'qag-col-source' }, '提出方式'),
          h('th', { key: 'status', className: 'qag-col-status' }, '修复状态'),
          h('th', { key: 'module', className: 'qag-col-module' }, '功能模块'),
          h('th', { key: 'assignee', className: 'qag-col-assignee' }, '负责人'),
          h('th', { key: 'project', className: 'qag-col-project' }, '项目'),
          h('th', { key: 'updated', className: 'qag-col-time' }, '最近更新'),
          h('th', { key: 'occ', className: 'qag-col-occ' }, '次数'),
        ])),
        h('tbody', { key: 'body' }, bugs.map(bug => h('tr', {
          key: bug.id,
          tabIndex: 0,
          onClick: () => onOpen(bug.id),
          onKeyDown: event => {
            if (event.key === 'Enter') onOpen(bug.id);
          },
        }, [
          h('td', { key: 'check', className: 'qag-col-check', onClick: event => event.stopPropagation() }, h('input', {
            type: 'checkbox',
            className: 'qag-check',
            checked: selectedIds.has(bug.id),
            onChange: () => onToggle(bug.id),
            'aria-label': `选择 ${bug.id}`,
          })),
          h('td', { key: 'id', className: 'qag-mono' }, bug.id),
          h('td', { key: 'title' }, h('div', { className: 'qag-table__title' }, bug.title)),
          h('td', { key: 'sev', className: 'qag-col-sev' }, h(SeverityPill, { severity: bug.severity })),
          h('td', { key: 'priority', className: 'qag-col-priority' }, bug.priority && bug.priority !== 'normal' ? h(PriorityTag, { priority: bug.priority }) : h('span', { className: 'qag-muted' }, '—')),
          h('td', { key: 'source', className: 'qag-col-source' }, h(SourceTag, { source: bug.source })),
          h('td', { key: 'status', className: 'qag-col-status' }, h(FixTag, { bug })),
          h('td', { key: 'module', className: 'qag-col-module' }, bug.module ? h(ModuleTag, { module: bug.module }) : h('span', { className: 'qag-muted' }, '—')),
          h('td', { key: 'assignee', className: 'qag-col-assignee' }, bug.assignee || h('span', { className: 'qag-muted' }, '—')),
          h('td', { key: 'project', className: 'qag-col-project' }, bug.workspaceName || '未归类'),
          h('td', { key: 'time', className: 'qag-col-time', title: fullTime(bug.updatedAt) }, timeAgo(bug.updatedAt)),
          h('td', { key: 'occ', className: 'qag-col-occ' }, String(bug.occurrence)),
        ]))),
      ]));
    }

    function ActivityFeed({ items }) {
      if (!items || items.length === 0) {
        return h(EmptyState, { title: '还没有追踪动态', hint: '自动捕获或手动记录缺陷后，这里会按时间显示全部变化。' });
      }
      const groups = [];
      for (const item of items) {
        const label = dayGroup(item.at);
        let group = groups[groups.length - 1];
        if (!group || group.label !== label) {
          group = { label, items: [] };
          groups.push(group);
        }
        group.items.push(item);
      }
      return h('div', { className: 'qag-feed' }, groups.map(group => h('section', { key: group.label, className: 'qag-feed__group' }, [
        h('div', { key: 'label', className: 'qag-feed__date' }, group.label),
        h('ol', { key: 'list', className: 'qag-feed__list' }, group.items.map(item => h('li', {
          key: `${item.at}-${item.type}-${item.bugId}`,
          className: `qag-feed__item qag-feed__item--${item.type}`,
        }, [
          h('span', { key: 'dot', className: 'qag-feed__dot' }),
          h('div', { key: 'body', className: 'qag-feed__body' }, [
            h('div', { key: 'line', className: 'qag-feed__line' }, [
              h('span', { key: 'id', className: 'qag-mono' }, item.bugId || ''),
              h('span', { key: 'type', className: 'qag-feed__type' }, ACTIVITY_TYPE[item.type] || item.type),
              item.from && item.to
                ? h('span', { key: 'flow' }, `${(STATUS[item.from] || {}).label || item.from} → ${(STATUS[item.to] || {}).label || item.to}`)
                : null,
            ]),
            h('div', { key: 'title', className: 'qag-feed__title' }, item.title || ''),
            item.note ? h('div', { key: 'note', className: 'qag-feed__note' }, item.note) : null,
            h('div', { key: 'at', className: 'qag-feed__time' }, fullTime(item.at)),
          ]),
        ]))),
      ])));
    }

    function Calendar({ bugs, onOpen }) {
      const now = new Date();
      const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
      const [selectedDate, setSelectedDate] = useState(localDay(now.toISOString()));
      const todayKey = localDay(now.toISOString());

      const events = useMemo(() => {
        const list = [];
        for (const bug of bugs) {
          if (bug.createdAt) {
            list.push({ at: bug.createdAt, date: localDay(bug.createdAt), kind: 'created', bug });
          }
          for (const entry of Array.isArray(bug.history) ? bug.history : []) {
            if (!entry || !entry.at || !entry.from || entry.from === entry.to) continue;
            const kind = entry.to === 'closed' ? 'closed'
              : entry.to === 'progress' ? 'progress'
                : entry.to === 'verify' ? 'verify'
                  : entry.to === 'open' ? 'reopened' : 'status';
            list.push({ at: entry.at, date: localDay(entry.at), kind, bug, entry });
          }
        }
        return list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      }, [bugs]);

      const dayMap = useMemo(() => {
        const map = new Map();
        for (const event of events) {
          if (!event.date) continue;
          const entry = map.get(event.date) || { created: 0, closed: 0, changes: 0, events: [] };
          if (event.kind === 'created') entry.created += 1;
          else if (event.kind === 'closed') entry.closed += 1;
          else entry.changes += 1;
          entry.events.push(event);
          map.set(event.date, entry);
        }
        return map;
      }, [events]);

      const monthPrefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;
      const monthEvents = events.filter(event => (event.date || '').startsWith(monthPrefix));
      const monthCreated = monthEvents.filter(event => event.kind === 'created').length;
      const monthClosed = monthEvents.filter(event => event.kind === 'closed').length;
      const monthChanges = monthEvents.length - monthCreated - monthClosed;
      const cells = monthCells(cursor.year, cursor.month);
      const selectedEvents = dayMap.get(selectedDate)?.events || [];

      function shiftMonth(delta) {
        const date = new Date(cursor.year, cursor.month + delta, 1);
        setCursor({ year: date.getFullYear(), month: date.getMonth() });
      }

      return h('div', { className: 'qag-cal' }, [
        h('div', { key: 'head', className: 'qag-cal__head' }, [
          h('div', { key: 'nav', className: 'qag-cal__nav' }, [
            h('button', { key: 'prev', type: 'button', className: 'qag-icon-btn qag-cal__prev', 'aria-label': '上个月', onClick: () => shiftMonth(-1) }, icon('chevron', 14)),
            h('div', { key: 'title', className: 'qag-cal__title' }, `${cursor.year}年${cursor.month + 1}月`),
            h('button', { key: 'next', type: 'button', className: 'qag-icon-btn qag-cal__next', 'aria-label': '下个月', onClick: () => shiftMonth(1) }, icon('chevron', 14)),
            h('button', {
              key: 'today',
              type: 'button',
              className: 'qag-btn qag-btn--ghost qag-btn--sm',
              onClick: () => {
                const current = new Date();
                setCursor({ year: current.getFullYear(), month: current.getMonth() });
                setSelectedDate(localDay(current.toISOString()));
              },
            }, '今天'),
          ]),
          h('div', { key: 'stats', className: 'qag-cal__stats' }, [
            h('span', { key: 'c', className: 'qag-cal__stat qag-tone-business' }, `新增 ${monthCreated}`),
            h('span', { key: 'f', className: 'qag-cal__stat qag-tone-success' }, `已修复 ${monthClosed}`),
            h('span', { key: 's', className: 'qag-cal__stat qag-tone-neutral' }, `状态变化 ${monthChanges}`),
          ]),
        ]),
        h('div', { key: 'week', className: 'qag-cal__week' }, ['一', '二', '三', '四', '五', '六', '日'].map(day => h('span', { key: day, className: 'qag-cal__weekday' }, day))),
        h('div', { key: 'grid', className: 'qag-cal__grid' }, cells.map(cell => {
          const info = dayMap.get(cell.key);
          const level = info ? Math.min(3, info.created + info.closed + info.changes) : 0;
          return h('button', {
            key: cell.key,
            type: 'button',
            className: `qag-cal__day${cell.inMonth ? '' : ' is-outside'}${cell.key === todayKey ? ' is-today' : ''}${cell.key === selectedDate ? ' is-selected' : ''}${level ? ` has-events level-${level}` : ''}`,
            onClick: () => setSelectedDate(cell.key),
            'aria-label': `${cell.key}${info ? `，新增 ${info.created}，已修复 ${info.closed}，状态变化 ${info.changes}` : ''}`,
          }, [
            h('span', { key: 'd', className: 'qag-cal__daynum' }, String(cell.date.getDate())),
            info ? h('span', { key: 'c', className: 'qag-cal__counts' }, [
              info.created ? h('span', { key: 'n', className: 'qag-cal__badge qag-cal__badge--new' }, `+${info.created}`) : null,
              info.closed ? h('span', { key: 'f', className: 'qag-cal__badge qag-cal__badge--fixed' }, `✓${info.closed}`) : null,
              info.changes ? h('span', { key: 's', className: 'qag-cal__badge' }, `·${info.changes}`) : null,
            ]) : null,
          ]);
        })),
        h('div', { key: 'legend', className: 'qag-cal__legend' }, [
          h('span', { key: 'n', className: 'qag-cal__legend-item' }, [h('span', { key: 'd', className: 'qag-cal__badge qag-cal__badge--new' }, '+'), ' 新建']),
          h('span', { key: 'f', className: 'qag-cal__legend-item' }, [h('span', { key: 'd', className: 'qag-cal__badge qag-cal__badge--fixed' }, '✓'), ' 已修复']),
          h('span', { key: 's', className: 'qag-cal__legend-item' }, [h('span', { key: 'd', className: 'qag-cal__badge' }, '·'), ' 状态变化']),
        ]),
        h('div', { key: 'detail', className: 'qag-cal__detail' }, [
          h('h3', { key: 'title', className: 'qag-cal__detail-title' }, `${selectedDate} 的缺陷动态`),
          selectedEvents.length === 0
            ? h('p', { key: 'empty', className: 'qag-muted' }, '这一天没有缺陷新增或状态变化。')
            : h('ul', { key: 'list', className: 'qag-cal__events' }, selectedEvents.map(event => {
              const kind = CALENDAR_KIND[event.kind] || CALENDAR_KIND.status;
              return h('li', { key: `${event.bug.id}-${event.at}-${event.kind}`, className: 'qag-cal__event' }, [
                h('button', {
                  key: 'body',
                  type: 'button',
                  className: 'qag-cal__event-main',
                  onClick: () => onOpen(event.bug.id),
                }, [
                  h('span', { key: 'time', className: 'qag-cal__event-time' }, fullTime(event.at).slice(11)),
                  h('span', { key: 'kind', className: `qag-chip qag-chip--fix-${kind.tone}` }, kind.label),
                  h('span', { key: 'id', className: 'qag-mono' }, event.bug.id),
                  h('span', { key: 'title', className: 'qag-cal__event-title' }, event.bug.title),
                ]),
              ]);
            })),
        ]),
      ]);
    }

    function Drawer({ bug, onClose, onTransition, onDelete, onSaveEdit, onVerify, onMerge, allBugs, busy }) {
      const [note, setNote] = useState('');
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState({
        title: '', description: '', severity: 'major', module: '', assignee: '', priority: 'normal',
        dueAt: '', fixVersion: '', foundVersion: '', tags: [],
      });
      const [verifyCommand, setVerifyCommand] = useState('');
      const [verifyNote, setVerifyNote] = useState('');
      const [mergeTarget, setMergeTarget] = useState('');
      const noteRef = useRef(null);

      useEffect(() => {
        setEditing(false);
        setNote('');
        setVerifyCommand('');
        setVerifyNote('');
        setMergeTarget('');
        setDraft({
          title: bug.title,
          description: bug.description || '',
          severity: bug.severity,
          module: bug.module || '',
          assignee: bug.assignee || '',
          priority: bug.priority || 'normal',
          dueAt: bug.dueAt ? bug.dueAt.slice(0, 10) : '',
          fixVersion: bug.fixVersion || '',
          foundVersion: bug.foundVersion || '',
          tags: Array.isArray(bug.tags) ? bug.tags : [],
        });
      }, [bug.id]);

      const onCloseRef = useRef(onClose);
      useEffect(() => {
        onCloseRef.current = onClose;
      });
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') onCloseRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      function startEdit() {
        setDraft({ title: bug.title, description: bug.description || '', severity: bug.severity, module: bug.module || '' });
        setEditing(true);
      }

      return h(React.Fragment, null, [
        h('div', { key: 'scrim', className: 'qag-scrim', onClick: onClose }),
        h('aside', { key: 'drawer', className: 'qag-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${bug.id} 缺陷详情` }, [
          h('header', { key: 'head', className: 'qag-drawer__head' }, [
            h('div', { key: 'left', className: 'qag-drawer__headline' }, [
              h('div', { key: 'id', className: 'qag-drawer__id' }, [
                h('span', { className: 'qag-mono' }, bug.id),
                h(StatusPill, { status: bug.status }),
                h(SeverityPill, { severity: bug.severity }),
                h(SourceTag, { source: bug.source }),
              ]),
              editing
                ? h('input', {
                  key: 'title',
                  className: 'qag-input qag-drawer__title-input',
                  value: draft.title,
                  maxLength: 160,
                  onChange: event => setDraft({ ...draft, title: event.target.value }),
                  'aria-label': '缺陷标题',
                })
                : h('h2', { key: 'title', className: 'qag-drawer__title' }, bug.title),
            ]),
            h('div', { key: 'actions', className: 'qag-drawer__actions' }, [
              editing
                ? h('button', {
                  key: 'save',
                  type: 'button',
                  className: 'qag-btn qag-btn--primary qag-btn--sm',
                  disabled: busy || !draft.title.trim(),
                  onClick: () => onSaveEdit(bug.id, draft).then(ok => {
                    if (ok) setEditing(false);
                  }),
                }, '保存')
                : h('button', {
                  key: 'edit',
                  type: 'button',
                  className: 'qag-icon-btn',
                  title: '编辑缺陷',
                  'aria-label': '编辑缺陷',
                  onClick: startEdit,
                }, icon('edit', 15)),
              editing
                ? h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'qag-btn qag-btn--ghost qag-btn--sm',
                  onClick: () => setEditing(false),
                }, '取消')
                : null,
              h('button', {
                key: 'close',
                type: 'button',
                className: 'qag-icon-btn',
                title: '关闭',
                'aria-label': '关闭',
                onClick: onClose,
              }, icon('close', 15)),
            ]),
          ]),
          h('div', { key: 'body', className: 'qag-drawer__body' }, [
            editing
              ? h('div', { key: 'editor', className: 'qag-field' }, [
                h('label', { key: 'l', className: 'qag-field__label' }, '严重度'),
                h('select', {
                  key: 's',
                  className: 'qag-select',
                  value: draft.severity,
                  onChange: event => setDraft({ ...draft, severity: event.target.value }),
                }, Object.keys(SEVERITY).map(value => h('option', { key: value, value }, SEVERITY[value].label))),
                h('label', { key: 'ml', className: 'qag-field__label' }, '功能模块'),
                h('input', {
                  key: 'm',
                  className: 'qag-input',
                  value: draft.module || '',
                  maxLength: 80,
                  placeholder: '例如：backend/app、viewer、scripts',
                  onChange: event => setDraft({ ...draft, module: event.target.value }),
                }),
                h('label', { key: 'al', className: 'qag-field__label' }, '负责人'),
                h('input', {
                  key: 'a',
                  className: 'qag-input',
                  value: draft.assignee || '',
                  maxLength: 60,
                  placeholder: '例如：cc112、后端组',
                  onChange: event => setDraft({ ...draft, assignee: event.target.value }),
                }),
                h('label', { key: 'pl', className: 'qag-field__label' }, '优先级'),
                h('select', {
                  key: 'p',
                  className: 'qag-select',
                  value: draft.priority || 'normal',
                  onChange: event => setDraft({ ...draft, priority: event.target.value }),
                }, Object.keys(PRIORITY).map(value => h('option', { key: value, value }, PRIORITY[value].label))),
                h('label', { key: 'ddl', className: 'qag-field__label' }, '截止日期'),
                h('input', {
                  key: 'dd',
                  type: 'date',
                  className: 'qag-input',
                  value: draft.dueAt || '',
                  onChange: event => setDraft({ ...draft, dueAt: event.target.value }),
                }),
                h('label', { key: 'fvl', className: 'qag-field__label' }, '发现版本 / 修复版本'),
                h('div', { key: 'versions', className: 'qag-inline-fields' }, [
                  h('input', {
                    key: 'fv',
                    className: 'qag-input',
                    value: draft.foundVersion || '',
                    maxLength: 60,
                    placeholder: '发现版本',
                    onChange: event => setDraft({ ...draft, foundVersion: event.target.value }),
                  }),
                  h('input', {
                    key: 'fx',
                    className: 'qag-input',
                    value: draft.fixVersion || '',
                    maxLength: 60,
                    placeholder: '修复版本',
                    onChange: event => setDraft({ ...draft, fixVersion: event.target.value }),
                  }),
                ]),
                h('label', { key: 'tl', className: 'qag-field__label' }, '标签（逗号分隔）'),
                h('input', {
                  key: 't',
                  className: 'qag-input',
                  value: (draft.tags || []).join(', '),
                  placeholder: '例如：auth, regression',
                  onChange: event => setDraft({
                    ...draft,
                    tags: event.target.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean).slice(0, 12),
                  }),
                }),
                h('label', { key: 'dl', className: 'qag-field__label' }, '缺陷描述'),
                h('textarea', {
                  key: 'd',
                  className: 'qag-textarea',
                  rows: 6,
                  value: draft.description,
                  onChange: event => setDraft({ ...draft, description: event.target.value }),
                }),
              ])
              : h('p', { key: 'desc', className: `qag-drawer__desc${bug.description ? '' : ' is-empty'}` }, bug.description || '暂无描述。'),

            h('section', { key: 'facts', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '基本信息'),
              h('dl', { key: 'grid', className: 'qag-facts' }, [
                ['提出方式', SOURCE[bug.source] || '—'],
                ['修复状态', isBotFix(bug) ? '机器人修复中' : fixStateOf(bug.status).label],
                ['优先级', PRIORITY[bug.priority]?.label || '普通'],
                ['负责人', bug.assignee || '—'],
                ['功能模块', bug.module || '未归类'],
                ['项目', bug.workspaceName || '未归类'],
                ['发现版本', bug.foundVersion || '—'],
                ['修复版本', bug.fixVersion || '—'],
                ['截止日期', bug.dueAt ? fullTime(bug.dueAt).slice(0, 10) : '—'],
                ['会话', bug.sessionTitle || (bug.sessionId ? bug.sessionId.slice(0, 18) : '—')],
                ['首次发现', fullTime(bug.createdAt)],
                ['最近更新', fullTime(bug.updatedAt)],
                ['出现次数', `×${bug.occurrence}`],
              ].map(([label, value]) => h('div', { key: label, className: 'qag-facts__row' }, [
                h('dt', { key: 'k' }, label),
                h('dd', { key: 'v', title: typeof value === 'string' ? value : '' }, value),
              ]))),
            ]),

            h('section', { key: 'status', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '流转状态'),
              h('div', { key: 'buttons', className: 'qag-status-actions' }, Object.keys(STATUS).map(status => h('button', {
                key: status,
                type: 'button',
                className: `qag-btn qag-btn--sm${bug.status === status ? ' qag-btn--primary' : ' qag-btn--ghost'}`,
                disabled: busy || bug.status === status,
                onClick: () => onTransition(bug.id, status, note),
              }, STATUS[status].label))),
              h('div', { key: 'note', className: 'qag-note-box' }, [
                h('textarea', {
                  key: 'input',
                  ref: noteRef,
                  className: 'qag-textarea qag-textarea--sm',
                  rows: 2,
                  placeholder: '附一条进度说明（可选），例如：已修复登录校验，等待回归。',
                  value: note,
                  onChange: event => setNote(event.target.value),
                }),
                h('button', {
                  key: 'add',
                  type: 'button',
                  className: 'qag-btn qag-btn--ghost qag-btn--sm',
                  disabled: busy || !note.trim(),
                  onClick: () => onTransition(bug.id, bug.status, note).then(() => {
                    setNote('');
                    if (noteRef.current) noteRef.current.focus();
                  }),
                }, '记录备注'),
              ]),
            ]),

            h('section', { key: 'verify', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '验证与复现'),
              bug.verification
                ? h('p', { key: 'last', className: 'qag-muted' }, `最近验证：${bug.verification.outcome === 'passed' ? '通过' : bug.verification.outcome === 'cannot-reproduce' ? '无法复现' : '未通过'} · ${fullTime(bug.verification.at)}${bug.verification.command ? ` · ${bug.verification.command}` : ''}`)
                : h('p', { key: 'none', className: 'qag-muted' }, '尚未记录验证结果。'),
              h('input', {
                key: 'command',
                className: 'qag-input',
                value: verifyCommand,
                placeholder: '验证命令（可选），例如：npm test -- auth',
                onChange: event => setVerifyCommand(event.target.value),
              }),
              h('textarea', {
                key: 'vnote',
                className: 'qag-textarea qag-textarea--sm',
                rows: 2,
                value: verifyNote,
                placeholder: '验证输出摘要 / 无法复现说明（可选）',
                onChange: event => setVerifyNote(event.target.value),
              }),
              h('div', { key: 'actions', className: 'qag-status-actions' }, [
                h('button', {
                  key: 'pass',
                  type: 'button',
                  className: 'qag-btn qag-btn--primary qag-btn--sm',
                  disabled: busy,
                  onClick: () => onVerify(bug.id, 'passed', verifyCommand, verifyNote),
                }, '验证通过'),
                h('button', {
                  key: 'fail',
                  type: 'button',
                  className: 'qag-btn qag-btn--ghost qag-btn--sm',
                  disabled: busy,
                  onClick: () => onVerify(bug.id, 'failed', verifyCommand, verifyNote),
                }, '验证未通过'),
                h('button', {
                  key: 'cannot',
                  type: 'button',
                  className: 'qag-btn qag-btn--ghost qag-btn--sm',
                  disabled: busy,
                  onClick: () => onVerify(bug.id, 'cannot-reproduce', verifyCommand, verifyNote),
                }, '无法复现'),
              ]),
            ]),

            h('section', { key: 'merge', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '重复与合并'),
              bug.duplicateOf
                ? h('p', { key: 'dup', className: 'qag-muted' }, `已合并到 ${bug.duplicateOf}`)
                : null,
              (allBugs || []).filter(item => item.id !== bug.id && item.status !== 'duplicate' && item.status !== 'ignored').length === 0
                ? h('p', { key: 'none', className: 'qag-muted' }, '暂无可合并的其他缺陷。')
                : h('div', { key: 'row', className: 'qag-inline-fields' }, [
                  h('select', {
                    key: 'target',
                    className: 'qag-select',
                    value: mergeTarget,
                    onChange: event => setMergeTarget(event.target.value),
                  }, [
                    h('option', { key: 'none', value: '' }, '选择主缺陷…'),
                    ...(allBugs || [])
                      .filter(item => item.id !== bug.id && item.status !== 'duplicate' && item.status !== 'ignored')
                      .map(item => h('option', { key: item.id, value: item.id }, `${item.id} ${item.title.length > 42 ? `${item.title.slice(0, 42)}…` : item.title}`)),
                  ]),
                  h('button', {
                    key: 'merge',
                    type: 'button',
                    className: 'qag-btn qag-btn--ghost qag-btn--sm',
                    disabled: busy || !mergeTarget,
                    onClick: () => {
                      if (!mergeTarget) return;
                      if (window.confirm(`把 ${bug.id} 合并到 ${mergeTarget}？合并后本条标记为重复。`)) {
                        onMerge(mergeTarget, [bug.id]).then(() => setMergeTarget(''));
                      }
                    },
                  }, '合并到主缺陷'),
                ]),
            ]),

            h('section', { key: 'evidence', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, `证据与触发（${bug.evidence.length}）`),
              bug.evidence.length === 0
                ? h('p', { key: 'none', className: 'qag-muted' }, '暂无证据记录。')
                : h('ul', { key: 'list', className: 'qag-evidence' }, bug.evidence.slice().reverse().map((item, index) => h('li', {
                  key: `${item.at}-${index}`,
                  className: 'qag-evidence__item',
                }, [
                  h('div', { key: 'top', className: 'qag-evidence__top' }, [
                    h('span', { key: 'kind', className: 'qag-tag' }, EVIDENCE_KIND[item.kind] || item.kind),
                    item.tool ? h('span', { key: 'tool', className: 'qag-mono qag-muted' }, item.tool) : null,
                    h('span', { key: 'time', className: 'qag-evidence__time' }, fullTime(item.at)),
                  ]),
                  h('pre', { key: 'excerpt', className: 'qag-evidence__excerpt' }, item.excerpt || ''),
                ]))),
            ]),

            h('section', { key: 'history', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '状态历史'),
              bug.history.length === 0
                ? h('p', { key: 'none', className: 'qag-muted' }, '暂无状态变化。')
                : h('ol', { key: 'list', className: 'qag-history' }, bug.history.slice().reverse().map((item, index) => h('li', {
                  key: `${item.at}-${index}`,
                  className: 'qag-history__item',
                }, [
                  h('span', { key: 'dot', className: 'qag-history__dot' }),
                  h('div', { key: 'body' }, [
                    h('div', { key: 'line' }, [
                      h('span', { key: 'to', className: `qag-status qag-status--${(STATUS[item.to] || STATUS.new).tone}` }, (STATUS[item.to] || STATUS.new).label),
                      h('span', { key: 'actor', className: 'qag-muted' }, ` · ${actorLabel(item.actor)}`),
                      h('span', { key: 'at', className: 'qag-history__time' }, fullTime(item.at)),
                    ]),
                    item.note ? h('div', { key: 'note', className: 'qag-history__note' }, item.note) : null,
                  ]),
                ]))),
            ]),

            bug.notes.length > 0 ? h('section', { key: 'notes', className: 'qag-section' }, [
              h('h3', { key: 't', className: 'qag-section__title' }, '备注'),
              h('ul', { key: 'list', className: 'qag-notes' }, bug.notes.slice().reverse().map((item, index) => h('li', {
                key: `${item.at}-${index}`,
                className: 'qag-notes__item',
              }, [
                h('div', { key: 'text' }, item.text),
                h('div', { key: 'meta', className: 'qag-muted' }, `${actorLabel(item.actor)} · ${fullTime(item.at)}`),
              ]))),
            ]) : null,
          ]),
          h('footer', { key: 'foot', className: 'qag-drawer__foot' }, [
            h('span', { key: 'hint', className: 'qag-muted' }, '状态变化会立即写入追踪动态。'),
            h('button', {
              key: 'delete',
              type: 'button',
              className: 'qag-btn qag-btn--danger-ghost qag-btn--sm',
              disabled: busy,
              onClick: () => {
                if (window.confirm(`确定删除 ${bug.id}「${bug.title}」？该操作用于清理误报，删除后不可恢复。`)) onDelete(bug.id);
              },
            }, [icon('trash', 14), h('span', { key: 'l' }, '删除')]),
          ]),
        ]),
      ]);
    }

    function HelpDialog({ onClose }) {
      const closeRef = useRef(onClose);
      useEffect(() => {
        closeRef.current = onClose;
      });
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') closeRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      return h(React.Fragment, null, [
        h('div', { key: 'scrim', className: 'qag-scrim', onClick: onClose }),
        h('div', {
          key: 'dialog',
          className: 'qag-modal qag-help-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'qag-help-title',
        }, [
          h('header', { key: 'head', className: 'qag-modal__head' }, [
            h('div', { key: 'title-wrap' }, [
              h('h2', { key: 'title', id: 'qag-help-title', className: 'qag-modal__title' }, '工具与说明'),
              h('div', { key: 'sub', className: 'qag-help__sub' }, 'DSH 通过这些工具登记缺陷；插件同时自动兜底。'),
            ]),
            h('button', { key: 'close', type: 'button', className: 'qag-icon-btn', 'aria-label': '关闭说明', onClick: onClose }, icon('close', 15)),
          ]),
          h('div', { key: 'body', className: 'qag-help__body' }, [
            h('section', { key: 'tools', className: 'qag-help__section' }, [
              h('h3', { key: 't', className: 'qag-help__title' }, '已注册的工具'),
              h('div', { key: 'list', className: 'qag-help__tools' }, HELP_TOOLS.map(tool => h('div', {
                key: tool.name,
                className: 'qag-help__tool',
              }, [
                h('div', { key: 'head', className: 'qag-help__tool-head' }, [
                  h('code', { key: 'n', className: 'qag-help__code' }, tool.name),
                  h('span', { key: 'tag', className: 'qag-help__badge' }, tool.tag),
                ]),
                h('p', { key: 'purpose', className: 'qag-help__tool-purpose' }, tool.purpose),
                h('div', { key: 'params', className: 'qag-help__tool-params' }, [
                  h('span', { key: 'l', className: 'qag-help__label' }, '参数'),
                  h('span', { key: 'v' }, tool.params),
                ]),
              ]))),
            ]),
            h('section', { key: 'tags', className: 'qag-help__section' }, [
              h('h3', { key: 't', className: 'qag-help__title' }, '来源与修复状态'),
              h('div', { key: 'source', className: 'qag-help__chips' }, [
                h('span', { key: 'l', className: 'qag-help__label' }, '来源'),
                h(SourceTag, { key: 'u', source: 'user' }),
                h(SourceTag, { key: 'a', source: 'auto' }),
                h(SourceTag, { key: 'g', source: 'agent' }),
                h(SourceTag, { key: 'm', source: 'manual' }),
              ]),
              h('div', { key: 'fix', className: 'qag-help__chips' }, [
                h('span', { key: 'l', className: 'qag-help__label' }, '修复状态'),
                h(FixTag, { key: 'n', status: 'new' }),
                h(FixTag, { key: 'o', status: 'open' }),
                h(FixTag, { key: 'p', status: 'progress' }),
                h(FixTag, { key: 'v', status: 'verify' }),
                h(FixTag, { key: 'c', status: 'closed' }),
              ]),
              h('p', { key: 'note', className: 'qag-help__note' }, '来源决定这条缺陷是用户提出、DSH 自动抓到，还是 Agent / 人工登记；修复状态随看板流转自动更新。'),
            ]),
            h('section', { key: 'ui', className: 'qag-help__section' }, [
              h('h3', { key: 't', className: 'qag-help__title' }, '看板与日历'),
              h('ul', { key: 'list', className: 'qag-help__bullets' }, [
                h('li', { key: '1' }, '看板只显示待确认、待修复、修复中、待验证；已关闭不再占列，可从「已关闭 N 条」去列表查看。'),
                h('li', { key: '2' }, '「日历」按天汇总新增、已修复和状态变化，点击日期查看当天缺陷动态。'),
                h('li', { key: '3' }, '看板和列表都支持多选 / 全选，批量解决、忽略或标记待验证。'),
                h('li', { key: '4' }, '详情页可记录验证命令和结果：验证通过关闭、验证未通过回到修复中、无法复现进入终态。'),
                h('li', { key: '5' }, '重复缺陷可在详情页合并到主缺陷，原记录保留并标记为「重复」。'),
                h('li', { key: '6' }, '顶部可导出 JSON / CSV / Markdown，导入 JSON 前会自动备份；负责人、优先级、版本和标签可编辑和筛选。'),
              ]),
            ]),
            h('section', { key: 'auto', className: 'qag-help__section' }, [
              h('h3', { key: 't', className: 'qag-help__title' }, '自动兜底'),
              h('ul', { key: 'list', className: 'qag-help__bullets' }, [
                h('li', { key: '1' }, '用户反馈直接进入「待修复」；构建 / 测试 / 运行失败等自动候选先进入「待确认」。'),
                h('li', { key: '2' }, '用户反馈或自动候选产生后的第一次有效动作、DSH 说「开始修复 / 定位到原因」或实际编辑文件时，最近一条未关闭缺陷自动进入「机器人修复中」。'),
                h('li', { key: '3' }, '模型调用 qa_mark_fixed、同命令重跑成功或匹配到 Git 修复提交时推进到「待验证」；助手文本提取默认关闭。'),
                h('li', { key: '4' }, '用户消息或助手回复中出现 bug 现象会自动提取；同一文件的重复反馈会合并。'),
                h('li', { key: '5' }, '只记录实际项目缺陷；功能需求、提问、工具调用失败、环境问题都不会进看板。'),
              ]),
            ]),
            h('section', { key: 'usage', className: 'qag-help__section' }, [
              h('h3', { key: 't', className: 'qag-help__title' }, '推荐用法'),
              h('ol', { key: 'list', className: 'qag-help__bullets qag-help__bullets--ordered' }, [
                h('li', { key: '1' }, '用户消息先判断类型；一条消息混有 bug 和需求时，用 qa_from_user_report 的 items[] 拆开，仅 bug 进看板。'),
                h('li', { key: '2' }, '开始修复前，调用 qa_begin_fix（可用 query / latest），进入机器人修复中。'),
                h('li', { key: '3' }, '每轮编码结束，调用 qa_capture 汇总本轮新发现和已修复。'),
                h('li', { key: '4' }, '单条修复完成用 qa_mark_fixed；一批多条用 qa_capture。'),
                h('li', { key: '5' }, '看板和缺陷列表都支持多选 / 全选，可批量「一键解决」「一键忽略」或「标记待验证」。'),
              ]),
            ]),
          ]),
          h('footer', { key: 'foot', className: 'qag-modal__foot' }, [
            h('button', { key: 'ok', type: 'button', className: 'qag-btn qag-btn--primary', onClick: onClose }, '知道了'),
          ]),
        ]),
      ]);
    }

    function AddDialog({ projects, defaultWorkspace, onClose, onCreate, busy }) {
      const [form, setForm] = useState({
        title: '',
        description: '',
        severity: 'major',
        workspace: defaultWorkspace || (projects[0] ? projects[0].path : ''),
      });
      const titleRef = useRef(null);
      const closeRef = useRef(onClose);
      useEffect(() => {
        closeRef.current = onClose;
      });
      useEffect(() => {
        if (titleRef.current) titleRef.current.focus();
        const onKey = event => {
          if (event.key === 'Escape') closeRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      return h(React.Fragment, null, [
        h('div', { key: 'scrim', className: 'qag-scrim', onClick: onClose }),
        h('div', { key: 'dialog', className: 'qag-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'qag-add-title' }, [
          h('header', { key: 'head', className: 'qag-modal__head' }, [
            h('h2', { key: 't', id: 'qag-add-title', className: 'qag-modal__title' }, '新建缺陷'),
            h('button', { key: 'c', type: 'button', className: 'qag-icon-btn', 'aria-label': '关闭', onClick: onClose }, icon('close', 15)),
          ]),
          h('div', { key: 'body', className: 'qag-modal__body' }, [
            h('label', { key: 't', className: 'qag-field__label' }, '标题 *'),
            h('input', {
              key: 'title',
              ref: titleRef,
              className: 'qag-input',
              value: form.title,
              maxLength: 160,
              placeholder: '例如：退款回调重复入账，订单金额翻倍',
              onChange: event => setForm({ ...form, title: event.target.value }),
            }),
            h('label', { key: 'p', className: 'qag-field__label' }, '所属项目'),
            h('select', {
              key: 'proj',
              className: 'qag-select',
              value: form.workspace,
              onChange: event => setForm({ ...form, workspace: event.target.value }),
            }, projects.length === 0
              ? h('option', { value: '' }, '当前工作区')
              : projects.map(project => h('option', { key: project.path, value: project.path }, project.name))),
            h('label', { key: 's', className: 'qag-field__label' }, '严重度'),
            h('select', {
              key: 'sev',
              className: 'qag-select',
              value: form.severity,
              onChange: event => setForm({ ...form, severity: event.target.value }),
            }, Object.keys(SEVERITY).map(value => h('option', { key: value, value }, SEVERITY[value].label))),
            h('label', { key: 'd', className: 'qag-field__label' }, '现象与复现步骤'),
            h('textarea', {
              key: 'desc',
              className: 'qag-textarea',
              rows: 5,
              placeholder: '预期结果、实际结果、复现步骤、相关日志或文件。',
              value: form.description,
              onChange: event => setForm({ ...form, description: event.target.value }),
            }),
          ]),
          h('footer', { key: 'foot', className: 'qag-modal__foot' }, [
            h('button', { key: 'c', type: 'button', className: 'qag-btn qag-btn--ghost', onClick: onClose }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'qag-btn qag-btn--primary',
              disabled: busy || !form.title.trim(),
              onClick: () => onCreate({
                action: 'create',
                title: form.title.trim(),
                description: form.description,
                severity: form.severity,
                workspace: form.workspace,
              }).then(ok => {
                if (ok) onClose();
              }),
            }, '创建缺陷'),
          ]),
        ]),
      ]);
    }

    function Panel() {
      const [snapshot, setSnapshot] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [live, setLive] = useState(false);
      const [tab, setTab] = useState('board');
      const [project, setProject] = useState('all');
      const [query, setQuery] = useState('');
      const [severity, setSeverity] = useState('all');
      const [sourceFilter, setSourceFilter] = useState('all');
      const [moduleFilter, setModuleFilter] = useState('all');
      const [status, setStatus] = useState('all');
      const [priorityFilter, setPriorityFilter] = useState('all');
      const [assigneeFilter, setAssigneeFilter] = useState('all');
      const [savedViews, setSavedViews] = useState(() => {
        try {
          const saved = JSON.parse(window.localStorage.getItem('qa-guardian-views') || '[]');
          return Array.isArray(saved) ? saved : [];
        } catch {
          return [];
        }
      });
      const [selectedId, setSelectedId] = useState('');
      const [adding, setAdding] = useState(false);
      const [helpOpen, setHelpOpen] = useState(false);
      const [selectedIds, setSelectedIds] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState('');
      const [exportFormat, setExportFormat] = useState('json');
      const fileInputRef = useRef(null);
      const inflight = useRef(false);
      const mounted = useRef(true);
      const reloadTimer = useRef(null);

      useEffect(() => () => {
        mounted.current = false;
      }, []);

      const load = useCallback(async () => {
        if (inflight.current) return;
        inflight.current = true;
        try {
          const data = await requestState();
          if (!mounted.current) return;
          setSnapshot(data);
          setError('');
        } catch (loadError) {
          if (mounted.current && loadError.name !== 'AbortError') setError(loadError.message || '读取看板失败');
        } finally {
          inflight.current = false;
          if (mounted.current) setLoading(false);
        }
      }, []);

      const scheduleReload = useCallback(() => {
        if (reloadTimer.current) return;
        reloadTimer.current = setTimeout(() => {
          reloadTimer.current = null;
          void load();
        }, 180);
      }, [load]);

      useEffect(() => {
        load();
        // Live push: the Host streams a `change` event after every mutation.
        let source = null;
        let retry = null;
        let disposed = false;
        const connect = () => {
          if (disposed) return;
          try {
            source = new EventSource(`${API}/events`);
          } catch {
            setLive(false);
            return;
          }
          source.addEventListener('hello', () => setLive(true));
          source.addEventListener('change', () => scheduleReload());
          source.onerror = () => {
            setLive(false);
            try {
              source.close();
            } catch {
              // already closed
            }
            if (!disposed) {
              retry = setTimeout(connect, 4000);
            }
          };
        };
        connect();
        // Fallback poll, and a focus refresh for the degraded case.
        const timer = setInterval(load, 15000);
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        return () => {
          disposed = true;
          clearTimeout(retry);
          clearTimeout(reloadTimer.current);
          reloadTimer.current = null;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          if (source) {
            try {
              source.close();
            } catch {
              // already closed
            }
          }
        };
      }, [load, scheduleReload]);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(''), 2600);
        return () => clearTimeout(timer);
      }, [toast]);

      const bugs = useMemo(() => (snapshot && Array.isArray(snapshot.bugs) ? snapshot.bugs : []), [snapshot]);
      useEffect(() => {
        setSelectedIds(previous => {
          if (previous.size === 0) return previous;
          const existing = new Set(bugs.map(bug => bug.id));
          const next = new Set([...previous].filter(id => existing.has(id)));
          return next.size === previous.size ? previous : next;
        });
      }, [bugs]);
      const projects = useMemo(() => {
        if (snapshot && Array.isArray(snapshot.projects) && snapshot.projects.length > 0) return snapshot.projects;
        return [];
      }, [snapshot]);

      const scoped = useMemo(() => bugs.filter(bug => project === 'all' || bug.workspace === project), [bugs, project]);
      const moduleOptions = useMemo(() => [...new Set(scoped.map(bug => bug.module).filter(Boolean))].sort(), [scoped]);
      const assigneeOptions = useMemo(() => [...new Set(scoped.map(bug => bug.assignee).filter(Boolean))].sort(), [scoped]);
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return scoped.filter(bug => {
          if (severity !== 'all' && bug.severity !== severity) return false;
          if (sourceFilter !== 'all' && bug.source !== sourceFilter) return false;
          if (moduleFilter !== 'all' && (bug.module || '') !== moduleFilter) return false;
          if (priorityFilter !== 'all' && (bug.priority || 'normal') !== priorityFilter) return false;
          if (assigneeFilter !== 'all' && (bug.assignee || '') !== assigneeFilter) return false;
          if (status === 'active' && !['new', 'open', 'progress'].includes(bug.status)) return false;
          if (status === 'unfixed' && !['new', 'open'].includes(bug.status)) return false;
          if (status !== 'all' && status !== 'active' && status !== 'unfixed' && bug.status !== status) return false;
          if (!needle) return true;
          return `${bug.id} ${bug.title} ${bug.description} ${bug.workspaceName} ${bug.sessionTitle}`.toLowerCase().includes(needle);
        });
      }, [scoped, query, severity, sourceFilter, moduleFilter, priorityFilter, assigneeFilter, status]);

      const persistViews = next => {
        setSavedViews(next);
        try {
          window.localStorage.setItem('qa-guardian-views', JSON.stringify(next));
        } catch {
          // localStorage may be unavailable; the views still work for this session.
        }
      };
      const applySavedView = name => {
        const view = savedViews.find(item => item.name === name);
        if (!view) return;
        setProject(view.project || 'all');
        setQuery(view.query || '');
        setSeverity(view.severity || 'all');
        setSourceFilter(view.sourceFilter || 'all');
        setModuleFilter(view.moduleFilter || 'all');
        setStatus(view.status || 'all');
        setPriorityFilter(view.priorityFilter || 'all');
        setAssigneeFilter(view.assigneeFilter || 'all');
      };
      const saveCurrentView = () => {
        const name = window.prompt('视图名称', '我的待验证');
        if (!name || !name.trim()) return;
        const view = {
          name: name.trim(),
          project, query, severity, sourceFilter, moduleFilter, status, priorityFilter, assigneeFilter,
        };
        persistViews([...savedViews.filter(item => item.name !== view.name), view]);
        setToast(`已保存视图「${view.name}」`);
      };
      const removeCurrentView = () => {
        if (!savedViews.length) return;
        const name = window.prompt(`删除哪个视图？可选：${savedViews.map(item => item.name).join(' / ')}`, savedViews[0].name);
        if (!name) return;
        persistViews(savedViews.filter(item => item.name !== name.trim()));
      };

      const selectedVisibleCount = filtered.reduce((count, bug) => count + (selectedIds.has(bug.id) ? 1 : 0), 0);
      const allVisibleSelected = filtered.length > 0 && selectedVisibleCount === filtered.length;
      const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
      const hiddenSelectedCount = Math.max(0, selectedIds.size - selectedVisibleCount);

      const stats = useMemo(() => {
        const today = localDay(new Date().toISOString());
        let active = 0;
        let verify = 0;
        let todayNew = 0;
        for (const bug of scoped) {
          if (bug.status === 'new' || bug.status === 'open' || bug.status === 'progress') active += 1;
          if (bug.status === 'verify') verify += 1;
          if (localDay(bug.createdAt) === today) todayNew += 1;
        }
        return { total: scoped.length, active, verify, todayNew };
      }, [scoped]);

      const selected = useMemo(() => bugs.find(bug => bug.id === selectedId) || null, [bugs, selectedId]);

      const mutate = useCallback(async payload => {
        setBusy(true);
        try {
          await sendAction(payload);
          await load();
          return true;
        } catch (actionError) {
          setToast(actionError.message || '操作失败');
          return false;
        } finally {
          if (mounted.current) setBusy(false);
        }
      }, [load]);

      const toggleSelected = useCallback(id => {
        setSelectedIds(previous => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);

      const toggleSelectList = useCallback(list => {
        setSelectedIds(previous => {
          const allSelected = list.length > 0 && list.every(bug => previous.has(bug.id));
          const next = new Set(previous);
          for (const bug of list) {
            if (allSelected) next.delete(bug.id);
            else next.add(bug.id);
          }
          return next;
        });
      }, []);

      const bulkStatus = useCallback(async (status, label) => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        const ok = await mutate({ action: 'bulk', ids, status });
        if (ok) {
          setSelectedIds(new Set());
          setToast(`已批量更新 ${ids.length} 条为「${label}」`);
        }
      }, [selectedIds, mutate]);

      const onTransition = useCallback(async (id, next, note) => {
        const ok = await mutate({ action: 'update', id, status: next, note: note || '' });
        if (ok) setToast(`已更新为「${STATUS[next].label}」`);
      }, [mutate]);

      const onSaveEdit = useCallback(async (id, draft) => {
        const ok = await mutate({
          action: 'update',
          id,
          title: draft.title.trim(),
          description: draft.description,
          severity: draft.severity,
          module: draft.module || '',
          assignee: draft.assignee || '',
          priority: draft.priority || 'normal',
          dueAt: draft.dueAt || '',
          fixVersion: draft.fixVersion || '',
          foundVersion: draft.foundVersion || '',
          tags: Array.isArray(draft.tags) ? draft.tags : [],
        });
        if (ok) setToast('缺陷已保存');
      }, [mutate]);

      const onVerification = useCallback(async (id, outcome, command, note) => {
        const ok = await mutate({ action: 'verify', id, outcome, command, note });
        if (ok) setToast(outcome === 'passed' ? '验证通过，缺陷已关闭' : outcome === 'cannot-reproduce' ? '已标记为无法复现' : '验证未通过，已回到修复中');
        return ok;
      }, [mutate]);

      const onMerge = useCallback(async (masterId, duplicateIds) => {
        const ok = await mutate({ action: 'merge', masterId, duplicateIds });
        if (ok) setToast('已合并重复缺陷');
        return ok;
      }, [mutate]);

      const onDelete = useCallback(async id => {
        const ok = await mutate({ action: 'delete', id });
        if (ok) {
          setSelectedId('');
          setToast('缺陷已删除');
        }
      }, [mutate]);

      const onCreate = useCallback(async payload => {
        const ok = await mutate(payload);
        if (ok) setToast('缺陷已创建');
        return ok;
      }, [mutate]);

      const downloadExport = () => {
        const link = document.createElement('a');
        link.href = `${API}/export?format=${encodeURIComponent(exportFormat)}`;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setToast(`已导出 ${exportFormat.toUpperCase()}`);
      };

      const onImportFile = async event => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (!data || !Array.isArray(data.bugs)) throw new Error('文件中没有 bugs 数组');
          if (!window.confirm(`导入将替换当前 ${bugs.length} 条缺陷，并先自动备份。继续？`)) return;
          const ok = await mutate({ action: 'import', data });
          if (ok) setToast(`已导入 ${data.bugs.length} 条缺陷`);
        } catch (importError) {
          setToast(importError.message || '导入失败');
        }
      };

      const onDropStatus = useCallback((id, next) => {
        const bug = bugs.find(item => item.id === id);
        if (!bug || bug.status === next) return;
        void onTransition(id, next, '通过看板拖动更新状态');
      }, [bugs, onTransition]);

      const onDragStart = useCallback((event, id) => {
        event.dataTransfer.setData('text/plain', id);
        event.dataTransfer.effectAllowed = 'move';
      }, []);

      const activity = useMemo(() => {
        const items = snapshot && Array.isArray(snapshot.activity) ? snapshot.activity : [];
        return project === 'all' ? items : items.filter(item => item.workspace === project);
      }, [snapshot, project]);

      const updatedAt = snapshot && snapshot.updatedAt ? snapshot.updatedAt : '';

      if (loading) {
        return h('div', { className: 'qag qag--center' }, h('div', { className: 'qag-loading' }, [
          h('span', { key: 's', className: 'qag-spinner' }),
          h('span', { key: 't' }, '正在读取缺陷看板…'),
        ]));
      }

      return h('div', { className: 'qag' }, [
        h('header', { key: 'top', className: 'qag-top' }, [
          h('div', { key: 'brand', className: 'qag-brand' }, [
            h('span', { key: 'logo', className: 'qag-logo' }, icon('bug', 19)),
            h('div', { key: 'text', className: 'qag-brand__text' }, [
              h('div', { key: 'title', className: 'qag-brand__title' }, PANEL_LABEL),
              h('div', { key: 'sub', className: 'qag-brand__sub' }, '编码缺陷 · 实时追踪 · 回归验证'),
            ]),
          ]),
          h('div', { key: 'filters', className: 'qag-filters' }, [
            h('label', { key: 'project', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '项目筛选'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: project,
                onChange: event => setProject(event.target.value),
              }, [
                h('option', { key: 'all', value: 'all' }, `全部项目（${bugs.length}）`),
                ...projects.map(item => h('option', { key: item.path || 'none', value: item.path }, `${item.name}（${item.total}）`)),
              ]),
            ]),
            h('label', { key: 'search', className: 'qag-search' }, [
              h('span', { key: 'i', className: 'qag-search__icon' }, icon('search', 14)),
              h('input', {
                key: 'input',
                type: 'search',
                className: 'qag-search__input',
                placeholder: '搜索编号、标题、描述…',
                value: query,
                onChange: event => setQuery(event.target.value),
                'aria-label': '搜索缺陷',
              }),
            ]),
            h('label', { key: 'severity', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '严重度筛选'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: severity,
                onChange: event => setSeverity(event.target.value),
              }, [
                h('option', { key: 'all', value: 'all' }, '全部严重度'),
                ...Object.keys(SEVERITY).map(value => h('option', { key: value, value }, SEVERITY[value].label)),
              ]),
            ]),
            h('label', { key: 'source', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '提出方式筛选'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: sourceFilter,
                onChange: event => setSourceFilter(event.target.value),
              }, [
                h('option', { key: 'all', value: 'all' }, '全部来源'),
                h('option', { key: 'user', value: 'user' }, '用户提出'),
                h('option', { key: 'auto', value: 'auto' }, 'DSH 自动'),
                h('option', { key: 'agent', value: 'agent' }, 'Agent 上报'),
                h('option', { key: 'manual', value: 'manual' }, '人工记录'),
              ]),
            ]),
            h('label', { key: 'priority', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '优先级筛选'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: priorityFilter,
                onChange: event => setPriorityFilter(event.target.value),
              }, [
                h('option', { key: 'all', value: 'all' }, '全部优先级'),
                ...Object.keys(PRIORITY).map(value => h('option', { key: value, value }, PRIORITY[value].label)),
              ]),
            ]),
            h('label', { key: 'assignee', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '负责人筛选'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: assigneeFilter,
                onChange: event => setAssigneeFilter(event.target.value),
              }, [
                h('option', { key: 'all', value: 'all' }, '全部负责人'),
                ...assigneeOptions.map(value => h('option', { key: value, value }, value)),
              ]),
            ]),
            h('label', { key: 'views', className: 'qag-select-wrap' }, [
              h('span', { key: 'l', className: 'qag-visually-hidden' }, '保存的视图'),
              h('select', {
                key: 's',
                className: 'qag-select qag-select--compact',
                value: '',
                onChange: event => {
                  const value = event.target.value;
                  if (value === '__save__') saveCurrentView();
                  else if (value === '__delete__') removeCurrentView();
                  else if (value) applySavedView(value);
                  event.target.value = '';
                },
              }, [
                h('option', { key: 'none', value: '' }, `视图（${savedViews.length}）`),
                ...savedViews.map(view => h('option', { key: view.name, value: view.name }, view.name)),
                h('option', { key: 'save', value: '__save__' }, '保存当前筛选…'),
                savedViews.length > 0 ? h('option', { key: 'delete', value: '__delete__' }, '删除视图…') : null,
              ]),
            ]),
            h('div', { key: 'export', className: 'qag-export-group' }, [
              h('select', {
                key: 'format',
                className: 'qag-select qag-select--compact',
                value: exportFormat,
                onChange: event => setExportFormat(event.target.value),
                'aria-label': '导出格式',
              }, [
                h('option', { key: 'json', value: 'json' }, 'JSON'),
                h('option', { key: 'csv', value: 'csv' }, 'CSV'),
                h('option', { key: 'md', value: 'md' }, 'Markdown'),
              ]),
              h('button', {
                key: 'download',
                type: 'button',
                className: 'qag-btn qag-btn--ghost qag-btn--sm',
                onClick: downloadExport,
              }, '导出'),
              h('button', {
                key: 'import',
                type: 'button',
                className: 'qag-btn qag-btn--ghost qag-btn--sm',
                onClick: () => fileInputRef.current && fileInputRef.current.click(),
              }, '导入'),
              h('input', {
                key: 'file',
                ref: fileInputRef,
                type: 'file',
                accept: 'application/json,.json',
                className: 'qag-visually-hidden',
                onChange: onImportFile,
              }),
            ]),
            h('button', {
              key: 'help',
              type: 'button',
              className: 'qag-btn qag-btn--ghost',
              title: '工具与说明',
              'aria-label': '工具与说明',
              onClick: () => setHelpOpen(true),
            }, [icon('help', 14), h('span', { key: 'l' }, '说明')]),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'qag-icon-btn',
              title: '刷新',
              'aria-label': '刷新',
              onClick: () => load(),
            }, icon('refresh', 15)),
            h('button', {
              key: 'add',
              type: 'button',
              className: 'qag-btn qag-btn--primary',
              onClick: () => setAdding(true),
            }, [icon('plus', 14), h('span', { key: 'l' }, '新建缺陷')]),
          ]),
        ]),

        error ? h('div', { key: 'error', className: 'qag-banner' }, [
          h('span', { key: 'i', className: 'qag-banner__icon' }, icon('alert', 15)),
          h('span', { key: 'm' }, error),
          h('button', { key: 'r', type: 'button', className: 'qag-btn qag-btn--ghost qag-btn--sm', onClick: () => load() }, '重试'),
        ]) : null,

        h('div', { key: 'stats', className: 'qag-stats' }, [
          h(Stat, { key: 'total', label: '全部缺陷', value: stats.total, onClick: () => { setStatus('all'); setTab('list'); } }),
          h(Stat, { key: 'active', label: '待处理', value: stats.active, tone: 'danger', onClick: () => { setStatus('active'); setTab('list'); } }),
          h(Stat, { key: 'verify', label: '待验证', value: stats.verify, tone: 'warning', onClick: () => { setStatus('verify'); setTab('list'); } }),
          h(Stat, { key: 'today', label: '今日新增', value: stats.todayNew, tone: 'business', onClick: () => { setStatus('all'); setTab('activity'); } }),
        ]),

        h('div', { key: 'tabs', className: 'qag-tabs' }, [
          h('div', { key: 'left', className: 'qag-tabs__left' }, [
            ['board', '看板', 'board'],
            ['list', '缺陷列表', 'list'],
            ['calendar', '日历', 'calendar'],
            ['activity', '追踪动态', 'activity'],
          ].map(([key, label, iconName]) => h('button', {
            key,
            type: 'button',
            className: `qag-tab${tab === key ? ' is-active' : ''}`,
            onClick: () => setTab(key),
            'aria-current': tab === key ? 'page' : undefined,
          }, [icon(iconName, 14), h('span', { key: 'l' }, label)]))),
          h('div', { key: 'right', className: 'qag-tabs__meta' }, [
            h('span', {
              key: 'live',
              className: `qag-live${live ? ' is-live' : ''}`,
              title: live ? '已连接实时推送' : '实时连接断开，正在降级轮询',
            }, [
              h('span', { key: 'dot', className: 'qag-live__dot' }),
              h('span', { key: 'label' }, live ? '实时' : '轮询'),
            ]),
            status !== 'all' || severity !== 'all' || sourceFilter !== 'all' || moduleFilter !== 'all' || query.trim()
              ? h('button', {
                key: 'clear',
                type: 'button',
                className: 'qag-linkbtn',
                onClick: () => { setStatus('all'); setSeverity('all'); setSourceFilter('all'); setModuleFilter('all'); setQuery(''); },
              }, '清除筛选')
              : null,
            h('span', { key: 'count' }, `${filtered.length} / ${scoped.length} 条`),
            h('span', { key: 'sep', className: 'qag-dot' }),
            h('span', { key: 'updated', title: updatedAt ? fullTime(updatedAt) : '' }, `更新于 ${timeAgo(updatedAt)}`),
          ]),
        ]),

        h('div', { key: 'content', className: 'qag-content' }, [
          tab === 'board'
            ? h(Board, {
              key: 'board',
              bugs: filtered.filter(bug => ['new', 'open', 'progress', 'verify'].includes(bug.status)),
              onOpen: setSelectedId,
              onDropStatus,
              onDragStart,
              selectedIds,
              onToggle: toggleSelected,
              onToggleAll: toggleSelectList,
              onBulk: bulkStatus,
              onClear: () => setSelectedIds(new Set()),
              busy,
              closedCount: filtered.filter(bug => bug.status === 'closed').length,
              onShowClosed: () => {
                setStatus('closed');
                setTab('list');
              },
            })
            : null,
          tab === 'list' ? h('div', { key: 'list' }, [
            h('div', { key: 'bar', className: 'qag-listbar' }, [
              h('div', { key: 'filters', className: 'qag-inline-filters' }, [
                h('label', { key: 'status', className: 'qag-inline-field' }, [
                  h('span', { key: 'l' }, '修复状态'),
                  h('select', {
                    key: 's',
                    className: 'qag-select qag-select--compact',
                    value: status,
                    onChange: event => setStatus(event.target.value),
                  }, [
                    h('option', { key: 'all', value: 'all' }, '全部修复状态'),
                    h('option', { key: 'active', value: 'active' }, '待处理（未关闭）'),
                    h('option', { key: 'unfixed', value: 'unfixed' }, '未修复'),
                    h('option', { key: 'progress', value: 'progress' }, '修复中'),
                    h('option', { key: 'verify', value: 'verify' }, '待验证'),
                    h('option', { key: 'cannot-reproduce', value: 'cannot-reproduce' }, '无法复现'),
                    h('option', { key: 'duplicate', value: 'duplicate' }, '重复'),
                    h('option', { key: 'closed', value: 'closed' }, '已修复'),
                    h('option', { key: 'ignored', value: 'ignored' }, '已忽略'),
                  ]),
                ]),
                h('label', { key: 'module', className: 'qag-inline-field' }, [
                  h('span', { key: 'l' }, '功能模块'),
                  h('select', {
                    key: 's',
                    className: 'qag-select qag-select--compact',
                    value: moduleFilter,
                    onChange: event => setModuleFilter(event.target.value),
                  }, [
                    h('option', { key: 'all', value: 'all' }, '全部模块'),
                    ...moduleOptions.map(value => h('option', { key: value, value }, value)),
                  ]),
                ]),
              ]),
              h('span', { key: 'hint', className: 'qag-muted' }, '点击行查看详情与状态历史；看板中也可拖动卡片流转。'),
            ]),
            selectedIds.size > 0 ? h(BulkBar, {
              key: 'bulk',
              count: selectedIds.size,
              hiddenCount: hiddenSelectedCount,
              busy,
              onVerify: () => bulkStatus('verify', '待验证'),
              onSolve: () => bulkStatus('closed', '已修复'),
              onIgnore: () => bulkStatus('ignored', '已忽略'),
              onClear: () => setSelectedIds(new Set()),
            }) : null,
            h(BugTable, {
              key: 'table',
              bugs: filtered,
              onOpen: setSelectedId,
              selectedIds,
              onToggle: toggleSelected,
              onToggleAll: () => toggleSelectList(filtered),
              allSelected: allVisibleSelected,
              someSelected: someVisibleSelected,
            }),
          ]) : null,
          tab === 'activity' ? h(ActivityFeed, { key: 'activity', items: activity }) : null,
          tab === 'calendar' ? h(Calendar, { key: 'calendar', bugs: scoped, onOpen: setSelectedId }) : null,
        ]),

        selected ? h(Drawer, {
          key: 'drawer',
          bug: selected,
          busy,
          onClose: () => setSelectedId(''),
          onTransition,
          onDelete,
          onSaveEdit,
          onVerify: onVerification,
          onMerge,
          allBugs: bugs,
        }) : null,

        adding ? h(AddDialog, {
          key: 'add',
          projects,
          defaultWorkspace: project === 'all' ? '' : project,
          busy,
          onClose: () => setAdding(false),
          onCreate,
        }) : null,

        helpOpen ? h(HelpDialog, {
          key: 'help',
          onClose: () => setHelpOpen(false),
        }) : null,

        toast ? h('div', { key: 'toast', className: 'qag-toast', role: 'status' }, toast) : null,
      ]);
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        console.error('[qa-guardian] panel crashed', error);
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'qag qag--center' }, h('div', { className: 'qag-empty' }, [
            h('span', { key: 'i', className: 'qag-empty__icon' }, icon('alert', 26)),
            h('div', { key: 't', className: 'qag-empty__title' }, '看板渲染失败'),
            h('div', { key: 'h', className: 'qag-empty__hint' }, '刷新页面后重试；缺陷数据保存在本机，不会丢失。'),
          ]));
        }
        return this.props.children;
      }
    }

    function PanelRoot() {
      return h(ErrorBoundary, null, h(Panel));
    }

    function PanelIcon(props) {
      return h('span', {
        className: 'qag-sidebar-icon',
        'aria-hidden': 'true',
        style: { width: props && props.size ? props.size : 16, height: props && props.size ? props.size : 16 },
      }, icon('bug', props && props.size ? props.size : 16));
    }

    const CSS = `
.qag { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-module-platform, #f4f6f8); color: var(--dsw-alias-label-primary, #1c2333);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.55; }
.qag *, .qag *::before, .qag *::after { box-sizing: border-box; }
.qag button, .qag input, .qag select, .qag textarea { font: inherit; color: inherit; }
.qag--center { align-items: center; justify-content: center; }
.qag-sidebar-icon { display: inline-flex; align-items: center; justify-content: center; color: currentColor; }
.qag-top { flex: none; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 20px;
  background: var(--dsw-alias-bg-base, #fff); border-bottom: 1px solid var(--dsw-alias-border-l2, #e4e7ec); }
.qag-brand { display: flex; align-items: center; gap: 10px; min-width: 180px; }
.qag-logo { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; flex: none;
  border-radius: 9px; color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 11%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 20%, transparent); }
.qag-brand__title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.qag-brand__sub { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); margin-top: 1px; }
.qag-filters { display: flex; align-items: center; gap: 8px; flex: 1; justify-content: flex-end; flex-wrap: wrap; min-width: 0; }
.qag-export-group { display: inline-flex; align-items: center; gap: 6px; }
.qag-select-wrap { display: inline-flex; min-width: 0; }
.qag-select { appearance: none; border: 1px solid var(--dsw-alias-border-l2, #d5dae2); border-radius: 8px;
  background-color: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1c2333);
  padding: 7px 28px 7px 10px; font-size: 12.5px; line-height: 18px; min-width: 0; max-width: 100%;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; cursor: pointer; }
.qag-select--compact { height: 32px; padding-top: 0; padding-bottom: 0; }
.qag-select:focus-visible, .qag-input:focus-visible, .qag-textarea:focus-visible, .qag-search:focus-within {
  outline: none; border-color: var(--dsw-alias-state-business-primary, #2563a8);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 18%, transparent); }
.qag-search { display: flex; align-items: center; gap: 6px; height: 32px; width: 240px; max-width: 100%;
  padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #d5dae2); border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-tertiary, #667085); }
.qag-search__icon { display: inline-flex; flex: none; }
.qag-search__input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-size: 12.5px; }
.qag-search__input::placeholder { color: var(--dsw-alias-label-tertiary, #98a2b3); }
.qag-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: 8px; border: 1px solid transparent; font-size: 12.5px; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, color .12s ease; }
.qag-btn:disabled { opacity: .5; cursor: not-allowed; }
.qag-btn--sm { height: 27px; padding: 0 9px; font-size: 12px; border-radius: 7px; }
.qag-btn--primary { background: var(--dsw-alias-state-business-primary, #2563a8); color: #fff; }
.qag-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 86%, #000); }
.qag-btn--ghost { background: transparent; border-color: var(--dsw-alias-border-l2, #d5dae2); color: var(--dsw-alias-label-secondary, #475467); }
.qag-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f2f4f7); }
.qag-btn--danger-ghost { background: transparent; color: var(--dsw-alias-state-error-primary, #b42318); }
.qag-btn--danger-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 9%, transparent); }
.qag-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; flex: none;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #475467); cursor: pointer; }
.qag-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f4f7); }
.qag-icon-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #2563a8); }
.qag-stats { flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 14px 20px 0; }
.qag-stat { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-radius: 10px; background: var(--dsw-alias-bg-base, #fff); cursor: pointer; }
.qag-stat:hover { border-color: var(--dsw-alias-border-l2, #d5dae2); }
.qag-stat__value { font-size: 21px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.qag-stat__label { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-tone-danger { color: var(--dsw-alias-state-error-primary, #b42318); }
.qag-tone-critical { color: var(--dsw-alias-state-error-primary, #b42318); }
.qag-tone-warning { color: var(--dsw-alias-state-warn-label, #b54708); }
.qag-tone-business { color: var(--dsw-alias-state-business-primary, #2563a8); }
.qag-tone-success { color: var(--dsw-alias-state-success-primary, #067647); }
.qag-tone-neutral { color: var(--dsw-alias-label-secondary, #475467); }
.qag-tabs { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px 0; flex-wrap: wrap; }
.qag-tabs__left { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid transparent; }
.qag-tab { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #475467); font-size: 12.5px; cursor: pointer; position: relative; }
.qag-tab:hover { background: var(--dsw-alias-interactive-bg-hover, #eef1f5); }
.qag-tab.is-active { color: var(--dsw-alias-state-business-primary, #2563a8); font-weight: 600;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 9%, transparent); }
.qag-tabs__meta { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-live { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8px; border-radius: 999px;
  color: var(--dsw-alias-label-tertiary, #667085); background: var(--dsw-alias-bg-layer-2, #eef1f5);
  border: 1px solid transparent; white-space: nowrap; }
.qag-live__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #98a2b3); }
.qag-live.is-live { color: var(--dsw-alias-state-success-primary, #067647);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 22%, transparent); }
.qag-live.is-live .qag-live__dot { background: var(--dsw-alias-state-success-primary, #067647); }
.qag-linkbtn { border: 0; background: transparent; color: var(--dsw-alias-state-business-primary, #2563a8); cursor: pointer; padding: 0; font-size: 11.5px; }
.qag-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; display: inline-block; }
.qag-content { flex: 1; min-height: 0; overflow: auto; padding: 14px 20px 24px; }
.qag-board { display: flex; align-items: flex-start; gap: 12px; width: 100%; min-width: 100%; }
.qag-boardbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.qag-boardbar .qag-bulkbar { flex: 1; margin-bottom: 0; }
.qag-cal { max-width: 1120px; }
.qag-cal__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.qag-cal__nav { display: flex; align-items: center; gap: 6px; }
.qag-cal__prev svg { transform: rotate(180deg); }
.qag-cal__title { min-width: 104px; text-align: center; font-size: 15px; font-weight: 600; }
.qag-cal__stats { display: flex; align-items: center; gap: 14px; font-size: 12px; flex-wrap: wrap; }
.qag-cal__stat { font-weight: 500; }
.qag-cal__week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; margin-bottom: 6px; }
.qag-cal__weekday { padding: 4px 0; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-cal__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.qag-cal__day { min-height: 86px; padding: 6px 7px; display: flex; flex-direction: column; gap: 5px; text-align: left; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-radius: 9px; background: var(--dsw-alias-bg-base, #fff);
  transition: border-color .12s ease, background .12s ease; }
.qag-cal__day:hover { border-color: var(--dsw-alias-border-l3, #c3cad6); }
.qag-cal__day.is-outside { opacity: .42; }
.qag-cal__day.is-today { border-color: var(--dsw-alias-state-business-primary, #2563a8); }
.qag-cal__day.is-selected { border-color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 7%, var(--dsw-alias-bg-base, #fff)); }
.qag-cal__daynum { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #344054); }
.qag-cal__counts { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.qag-cal__badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; padding: 2px 4px;
  border-radius: 4px; font-size: 10px; line-height: 1.1; color: var(--dsw-alias-label-secondary, #475467);
  background: var(--dsw-alias-bg-layer-2, #eef1f5); }
.qag-cal__badge--new { color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 10%, transparent); }
.qag-cal__badge--fixed { color: var(--dsw-alias-state-success-primary, #067647);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 10%, transparent); }
.qag-cal__legend { display: flex; align-items: center; gap: 14px; margin-top: 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-cal__legend-item { display: inline-flex; align-items: center; gap: 4px; }
.qag-cal__detail { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1, #e4e7ec); }
.qag-cal__detail-title { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475467); }
.qag-cal__events { list-style: none; margin: 0; padding: 0; max-height: 380px; overflow: auto; }
.qag-cal__event { border-bottom: 1px dashed var(--dsw-alias-border-l1, #e4e7ec); }
.qag-cal__event:last-child { border-bottom: 0; }
.qag-cal__event-main { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 4px; border: 0; background: transparent;
  text-align: left; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary, #1c2333); }
.qag-cal__event-main:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f4f7); }
.qag-cal__event-time { flex: none; width: 38px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #667085); }
.qag-cal__event-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qag-card__check { position: absolute; top: 9px; right: 9px; z-index: 1; margin: 0; }
.qag-column { flex: 1 1 200px; min-width: 200px; max-width: 340px; border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 52%, transparent);
  border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); padding: 8px; min-height: 160px; transition: border-color .12s, background .12s; }
.qag-column.is-over { border-color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 5%, var(--dsw-alias-bg-base, #fff)); }
.qag-column__head { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
.qag-column__title { font-size: 12.5px; font-weight: 600; }
.qag-column__count { font-size: 11px; min-width: 20px; text-align: center; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #475467); background: var(--dsw-alias-bg-layer-2, #eef1f5); font-variant-numeric: tabular-nums; }
.qag-column__body { display: flex; flex-direction: column; gap: 8px; }
.qag-column__empty { padding: 18px 8px; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #98a2b3);
  border: 1px dashed var(--dsw-alias-border-l2, #d5dae2); border-radius: 9px; }
.qag-card { position: relative; padding: 10px 11px 9px; border-radius: 9px; background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-left-width: 3px; cursor: pointer;
  box-shadow: 0 1px 1px rgba(16,24,40,.03); transition: border-color .12s, box-shadow .12s, transform .12s; }
.qag-card:hover { border-color: var(--dsw-alias-border-l3, #c3cad6); box-shadow: 0 3px 10px rgba(16,24,40,.07); }
.qag-card:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #2563a8); }
.qag-card--danger { border-left-color: var(--dsw-alias-state-error-primary, #b42318); }
.qag-card--critical { border-left-color: var(--dsw-alias-state-error-secondary, #d9480f); }
.qag-card--warning { border-left-color: var(--dsw-alias-state-warn-primary, #dc8a12); }
.qag-card--neutral { border-left-color: var(--dsw-alias-border-l3, #98a2b3); }
.qag-card__top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; padding-right: 18px; }
.qag-card__source { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #98a2b3); white-space: nowrap; }
.qag-card__tags { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.qag-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px;
  font-size: 10.5px; line-height: 1; font-weight: 500; white-space: nowrap; border: 1px solid transparent; }
.qag-chip--src-user { color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 24%, transparent); }
.qag-chip--src-auto, .qag-chip--src-agent, .qag-chip--src-manual { color: var(--dsw-alias-label-secondary, #475467);
  background: var(--dsw-alias-bg-layer-2, #eef1f5); border-color: var(--dsw-alias-border-l1, #e4e7ec); }
.qag-chip--module { color: var(--dsw-alias-label-secondary, #475467); background: transparent;
  border-color: var(--dsw-alias-border-l2, #d5dae2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.qag-chip--priority { font-weight: 600; background: color-mix(in srgb, currentColor 9%, transparent); }
.qag-chip--assignee { color: var(--dsw-alias-label-secondary, #475467); background: var(--dsw-alias-bg-layer-2, #eef1f5); }
.qag-chip--fix-danger { color: var(--dsw-alias-state-error-primary, #b42318);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 22%, transparent); }
.qag-chip--fix-business { color: var(--dsw-alias-state-business-primary, #2563a8);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 22%, transparent); }
.qag-chip__icon { display: inline-flex; align-items: center; margin-right: 3px; }
.qag-chip.is-bot { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 10%, transparent); }
.qag-chip--fix-warning { color: var(--dsw-alias-state-warn-label, #b54708);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc8a12) 11%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc8a12) 24%, transparent); }
.qag-chip--fix-success { color: var(--dsw-alias-state-success-primary, #067647);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 22%, transparent); }
.qag-chip--fix-neutral { color: var(--dsw-alias-label-secondary, #475467);
  background: var(--dsw-alias-bg-layer-2, #eef1f5); border-color: var(--dsw-alias-border-l1, #e4e7ec); }
.qag-card__occ { font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475467);
  background: var(--dsw-alias-bg-layer-2, #eef1f5); border-radius: 999px; padding: 0 5px; }
.qag-card__title { margin: 0; font-size: 12.8px; line-height: 1.5; font-weight: 600; color: var(--dsw-alias-label-primary, #1c2333);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.qag-card__meta { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #667085); min-width: 0; }
.qag-card__project { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qag-card__id { margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #98a2b3); letter-spacing: .02em; }
.qag-pill { display: inline-flex; align-items: center; height: 19px; padding: 0 7px; border-radius: 999px;
  font-size: 10.5px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.qag-pill--danger { color: var(--dsw-alias-state-error-primary, #b42318); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 22%, transparent); }
.qag-pill--critical { color: var(--dsw-alias-state-error-secondary, #d9480f); background: color-mix(in srgb, var(--dsw-alias-state-error-secondary, #d9480f) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-secondary, #d9480f) 22%, transparent); }
.qag-pill--warning { color: var(--dsw-alias-state-warn-label, #b54708); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc8a12) 11%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc8a12) 24%, transparent); }
.qag-pill--neutral { color: var(--dsw-alias-label-secondary, #475467); background: var(--dsw-alias-bg-layer-2, #eef1f5); border-color: var(--dsw-alias-border-l1, #e4e7ec); }
.qag-status { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.qag-status--neutral { color: var(--dsw-alias-label-secondary, #475467); background: var(--dsw-alias-bg-layer-2, #eef1f5); }
.qag-status--danger { color: var(--dsw-alias-state-error-primary, #b42318); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 10%, transparent); }
.qag-status--business { color: var(--dsw-alias-state-business-primary, #2563a8); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 10%, transparent); }
.qag-status--warning { color: var(--dsw-alias-state-warn-label, #b54708); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc8a12) 12%, transparent); }
.qag-status--success { color: var(--dsw-alias-state-success-primary, #067647); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #067647) 10%, transparent); }
.qag-listbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.qag-inline-filters { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.qag-bulkbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 7px 10px; margin-bottom: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 22%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563a8) 6%, transparent);
  border-radius: 9px; }
.qag-bulkbar__count { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-business-primary, #2563a8); white-space: nowrap; }
.qag-bulkbar__spacer { flex: 1; }
.qag-check { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-state-business-primary, #2563a8); cursor: pointer; vertical-align: middle; }
.qag-col-check { width: 40px; text-align: center; }
.qag-inline-field { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #475467); }
.qag-table-wrap { border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-radius: 12px; overflow: auto; background: var(--dsw-alias-bg-base, #fff); }
.qag-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; min-width: 1120px; }
.qag-table th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 9px 14px; font-size: 11.5px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary, #667085); background: var(--dsw-alias-bg-layer-1, #f8f9fb); border-bottom: 1px solid var(--dsw-alias-border-l1, #e4e7ec); white-space: nowrap; }
.qag-table td { padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e4e7ec); vertical-align: middle; }
.qag-table tbody tr { cursor: pointer; }
.qag-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, #f8f9fb); }
.qag-table tbody tr:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary, #2563a8); }
.qag-table tbody tr:last-child td { border-bottom: 0; }
.qag-table__title { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.qag-col-id { width: 96px; }
.qag-col-sev, .qag-col-status { width: 84px; }
.qag-col-priority { width: 70px; }
.qag-col-assignee { width: 96px; }
.qag-col-source { width: 92px; }
.qag-col-project { width: 120px; }
.qag-col-module { width: 108px; }
.qag-col-time { width: 100px; }
.qag-col-occ { width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
.qag-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; }
.qag-muted { color: var(--dsw-alias-label-tertiary, #667085); }
.qag-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 64px 20px; text-align: center; }
.qag-empty__icon { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 14px;
  color: var(--dsw-alias-label-tertiary, #98a2b3); background: var(--dsw-alias-bg-layer-2, #eef1f5); margin-bottom: 4px; }
.qag-empty__title { font-size: 13.5px; font-weight: 600; }
.qag-empty__hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #667085); max-width: 360px; line-height: 1.6; }
.qag-feed { max-width: 920px; }
.qag-feed__group { margin-bottom: 18px; }
.qag-feed__date { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #667085); margin-bottom: 6px; padding-left: 2px; }
.qag-feed__list { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--dsw-alias-border-l2, #d5dae2); margin-left: 6px; }
.qag-feed__item { position: relative; display: flex; gap: 12px; padding: 8px 0 8px 18px; }
.qag-feed__dot { position: absolute; left: -4.5px; top: 15px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-border-l3, #98a2b3); border: 2px solid var(--dsw-alias-bg-module-platform, #f4f6f8); }
.qag-feed__item--created .qag-feed__dot { background: var(--dsw-alias-state-business-primary, #2563a8); }
.qag-feed__item--status .qag-feed__dot { background: var(--dsw-alias-state-warn-primary, #dc8a12); }
.qag-feed__item--deleted .qag-feed__dot { background: var(--dsw-alias-state-error-primary, #b42318); }
.qag-feed__body { min-width: 0; }
.qag-feed__line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12.5px; }
.qag-feed__type { font-weight: 600; }
.qag-feed__title { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #475467); margin-top: 1px; }
.qag-feed__note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); margin-top: 2px; }
.qag-feed__time { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #98a2b3); margin-top: 3px; }
.qag-scrim { position: absolute; inset: 0; z-index: 30; background: rgba(15,23,42,.18); }
.qag-drawer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 31; width: min(470px, 94%); display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff); border-left: 1px solid var(--dsw-alias-border-l2, #d5dae2);
  box-shadow: -16px 0 40px rgba(16,24,40,.14); animation: qag-slide-in .18s ease-out; }
@keyframes qag-slide-in { from { transform: translateX(18px); opacity: .6; } to { transform: none; opacity: 1; } }
.qag-drawer__head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 16px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e4e7ec); }
.qag-drawer__headline { min-width: 0; flex: 1; }
.qag-drawer__id { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; flex-wrap: wrap; }
.qag-drawer__title { margin: 0; font-size: 15px; line-height: 1.45; font-weight: 600; }
.qag-drawer__title-input { margin-top: 2px; }
.qag-drawer__actions { display: flex; align-items: center; gap: 4px; flex: none; }
.qag-drawer__body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 20px; }
.qag-drawer__desc { margin: 0 0 16px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-secondary, #344054); }
.qag-drawer__desc.is-empty { color: var(--dsw-alias-label-tertiary, #98a2b3); }
.qag-drawer__foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, #e4e7ec); background: var(--dsw-alias-bg-layer-1, #f8f9fb); }
.qag-section { margin-top: 18px; }
.qag-section__title { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475467); }
.qag-facts { margin: 0; display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 6px 10px; font-size: 12px; }
.qag-facts__row { display: contents; }
.qag-facts dt { color: var(--dsw-alias-label-tertiary, #667085); }
.qag-facts dd { margin: 0; color: var(--dsw-alias-label-primary, #1c2333); overflow-wrap: anywhere; }
.qag-status-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.qag-note-box { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
.qag-note-box .qag-textarea { flex: 1; }
.qag-input, .qag-textarea { width: 100%; border: 1px solid var(--dsw-alias-border-l2, #d5dae2); border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1c2333); padding: 8px 10px; font-size: 12.5px; line-height: 1.6; }
.qag-textarea { resize: vertical; min-height: 64px; }
.qag-textarea--sm { min-height: 52px; }
.qag-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.qag-inline-fields { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qag-inline-fields .qag-input, .qag-inline-fields .qag-select { flex: 1; min-width: 120px; }
.qag-field__label { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475467); margin: 10px 0 5px; }
.qag-field__label:first-child { margin-top: 0; }
.qag-evidence, .qag-history, .qag-notes { list-style: none; margin: 0; padding: 0; }
.qag-evidence__item { padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-radius: 9px; margin-bottom: 7px;
  background: var(--dsw-alias-bg-layer-1, #f8f9fb); }
.qag-evidence__top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qag-evidence__time { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #98a2b3); }
.qag-tag { display: inline-flex; height: 19px; align-items: center; padding: 0 6px; border-radius: 5px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #475467); background: var(--dsw-alias-bg-layer-2, #eef1f5); }
.qag-evidence__excerpt { margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #344054); max-height: 120px; overflow: auto; }
.qag-history__item { position: relative; display: flex; gap: 10px; padding: 6px 0 6px 14px; }
.qag-history__dot { position: absolute; left: 0; top: 12px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-border-l3, #98a2b3); }
.qag-history__time { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #98a2b3); }
.qag-history__note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); margin-top: 2px; }
.qag-notes__item { padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1, #e4e7ec); font-size: 12px; }
.qag-notes__item:last-child { border-bottom: 0; }
.qag-modal { position: absolute; z-index: 31; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100% - 32px));
  max-height: calc(100% - 48px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #fff); border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, #d5dae2); box-shadow: 0 20px 50px rgba(16,24,40,.2); overflow: hidden; }
.qag-modal__head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; }
.qag-modal__title { margin: 0; font-size: 15px; font-weight: 600; }
.qag-modal__body { padding: 4px 16px 12px; overflow: auto; }
.qag-help-modal { width: min(760px, calc(100% - 32px)); max-height: calc(100% - 40px); }
.qag-help__sub { margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-help__body { flex: 1; min-height: 0; padding: 4px 20px 18px; overflow: auto; }
.qag-help__section { margin-bottom: 18px; }
.qag-help__title { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #475467); }
.qag-help__tools { display: flex; flex-direction: column; gap: 7px; }
.qag-help__tool { padding: 8px 11px; border: 1px solid var(--dsw-alias-border-l1, #e4e7ec); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1, #f8f9fb); }
.qag-help__tool-head { display: flex; align-items: center; gap: 8px; }
.qag-help__code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; font-weight: 600;
  color: var(--dsw-alias-state-business-primary, #2563a8); }
.qag-help__badge { padding: 1px 6px; border-radius: 5px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #475467);
  background: var(--dsw-alias-bg-layer-2, #eef1f5); }
.qag-help__tool-purpose { margin: 5px 0 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #344054); }
.qag-help__tool-params { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-help__label { flex: none; min-width: 56px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-help__chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.qag-help__note { margin: 6px 0 0; font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-help__bullets { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.8; color: var(--dsw-alias-label-secondary, #344054); }
.qag-help__bullets--ordered { list-style: decimal; }
.qag-modal__foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l1, #e4e7ec);
  background: var(--dsw-alias-bg-layer-1, #f8f9fb); }
.qag-toast { position: absolute; z-index: 60; left: 50%; bottom: 22px; transform: translateX(-50%);
  padding: 8px 14px; border-radius: 9px; font-size: 12.5px; color: #fff; background: rgba(23,32,48,.92);
  box-shadow: 0 8px 24px rgba(16,24,40,.2); max-width: 80%; }
.qag-banner { flex: none; display: flex; align-items: center; gap: 8px; margin: 10px 20px 0; padding: 8px 12px; border-radius: 8px;
  color: var(--dsw-alias-state-error-primary, #b42318); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 20%, transparent); font-size: 12px; }
.qag-banner__icon { display: inline-flex; }
.qag-loading { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #667085); }
.qag-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, #d5dae2);
  border-top-color: var(--dsw-alias-state-business-primary, #2563a8); animation: qag-spin .8s linear infinite; }
@keyframes qag-spin { to { transform: rotate(360deg); } }
.qag-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 860px) {
  .qag-top { padding: 12px 14px; gap: 10px; }
  .qag-filters { justify-content: flex-start; }
  .qag-search { width: 100%; order: 5; }
  .qag-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 14px 0; }
  .qag-tabs { padding: 10px 14px 0; }
  .qag-content { padding: 12px 14px 20px; }
  .qag-banner { margin: 8px 14px 0; }
  .qag-col-project, .qag-col-source, .qag-col-module, .qag-col-priority, .qag-col-assignee { display: none; }
  .qag-table { min-width: 620px; }
  .qag-cal__day { min-height: 66px; padding: 4px 5px; }
  .qag-cal__grid, .qag-cal__week { gap: 4px; }
  .qag-cal__weekday { font-size: 10.5px; }
  .qag-cal__event-title { font-size: 11.5px; }
}
@media (max-width: 560px) {
  .qag-brand__sub { display: none; }
  .qag-stat__value { font-size: 18px; }
  .qag-tabs__meta .qag-dot, .qag-tabs__meta span:last-child { display: none; }
  .qag-drawer { width: 100%; }
}
`;

    function apply(ctx) {
      const style = document.createElement('style');
      style.setAttribute('data-qa-guardian', '');
      style.textContent = CSS;
      document.head.appendChild(style);

      ctx.effect(() => () => {
        style.remove();
      }, 'qa-guardian: panel styles');

      const sidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        label: PANEL_LABEL,
        order: 25,
      }, PanelIcon));
      const main = ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, PanelRoot));

      ctx.effect(() => () => {
        try {
          sidebar();
        } catch {
          // slot may already be disposed
        }
        try {
          main();
        } catch {
          // slot may already be disposed
        }
      }, 'qa-guardian: panel slots');
    }

    return { inject: ['slots'], apply };
  },
});