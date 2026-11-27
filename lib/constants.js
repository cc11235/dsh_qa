/** Shared vocabulary for the QA tracker (Host and Client keep their own copy). */

export const STATUSES = ['new', 'open', 'progress', 'verify', 'cannot-reproduce', 'duplicate', 'closed', 'ignored'];

export const STATUS_LABELS = {
  new: '待确认',
  open: '待修复',
  progress: '修复中',
  verify: '待验证',
  'cannot-reproduce': '无法复现',
  duplicate: '重复',
  closed: '已关闭',
  ignored: '已忽略',
};

/** Statuses that represent unfinished work. */
export const ACTIVE_STATUSES = ['new', 'open', 'progress'];

/** Kanban columns, in display order. `closed` and terminal states stay out. */
export const KANBAN_COLUMNS = ['new', 'open', 'progress', 'verify'];

export const TERMINAL_STATUSES = ['cannot-reproduce', 'duplicate', 'closed', 'ignored'];

export const SEVERITIES = ['blocker', 'critical', 'major', 'minor'];

export const SEVERITY_LABELS = {
  blocker: '致命',
  critical: '严重',
  major: '一般',
  minor: '轻微',
};

export const SEVERITY_ORDER = { blocker: 0, critical: 1, major: 2, minor: 3 };

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export const PRIORITY_LABELS = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

export const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

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