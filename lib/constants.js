/** Shared vocabulary for the QA tracker (Host and Client keep their own copy). */

export const STATUSES = ['new', 'open', 'progress', 'verify', 'closed', 'ignored'];

export const STATUS_LABELS = {
  new: '待确认',
  open: '待修复',
  progress: '修复中',
  verify: '待验证',
  closed: '已关闭',
  ignored: '已忽略',
};

/** Statuses that represent unfinished work. */
export const ACTIVE_STATUSES = ['new', 'open', 'progress'];

/** Kanban columns, in display order. `ignored` stays out of the board. */
export const KANBAN_COLUMNS = ['new', 'open', 'progress', 'verify', 'closed'];

export const SEVERITIES = ['blocker', 'critical', 'major', 'minor'];

export const SEVERITY_LABELS = {
  blocker: '致命',
  critical: '严重',
  major: '一般',
  minor: '轻微',
};

export const SEVERITY_ORDER = { blocker: 0, critical: 1, major: 2, minor: 3 };

export const SOURCE_LABELS = {
  auto: 'DSH 自动',
  user: '用户提出',
  agent: 'Agent 上报',
  manual: '人工记录',
};

export const MAX_TITLE = 160;
export const MAX_DESCRIPTION = 4000;
export const MAX_EVIDENCE = 12;
export const MAX_ACTIVITY = 1200;