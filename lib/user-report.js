/** A user message that reports broken/undesired behavior rather than asking for a feature. */
import { normalizeSignature } from './extract.js';
import { featureFromText } from './features.js';
import { cleanText, clip, hash, moduleFromText, oneLine } from './util.js';

const USER_SYMPTOM_RE = /(?:没有[^，。；\n]{0,10}(?:反应|启动|生效|显示|填充|数据|日志|返回|加载|保存|刷新|出现)|没(?:有)?(?:启动|反应|生效|显示|正常)|不(?:对|正常|生效|显示|工作|兼容|行|准|准确)|无法|报错|错误|异常|崩溃|闪退|白屏|卡死|超时|失败|丢失|不一致|重复|包含了其他|都是\s*0|为空|空白|漏掉|漏了|少了|多了|乱码|(?:跳转|重定向|链接|地址)[^，。\n]{0,20}(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|为什么[^，。\n]{0,20}(?:0|空|没有|不))/i;

/** Requirement/instruction wording; only overridden when a strong defect symptom appears. */
/** Desired behavior / feature-request wording, distinct from an observed defect. */
const USER_REQUIREMENT_HINT_RE = /(?:帮我写|请帮我|实现|添加|加个|增加|新增|支持|设计|优化|调整|改成|换成|加上|去掉|删除|接入|整合|需要|希望|应该|建议|能否|可以|不要|别|功能需求|需求|要求|显示|保留|弹出|提示|不再|自动|允许)/;

/** Concrete observed failure wording. A requirement may mention “失败” without one. */
const USER_OBSERVED_RE = /(?:报错|错误|异常|崩溃|闪退|白屏|卡死|没(?:有)?反应|无法|失败|丢失|不一致|包含(?:了)?其他|都是\s*0|为\s*0|没有值|为空|空白|没(?:有)?启动|没有自动填充|跳转[^，。\n]{0,20}localhost|没有触发|不准|不准确|漏掉)/;

const USER_CONFIRM_RE = /(?:^|[\s，。！!])(?:好了|可以了|正常了|解决了|修复了|没问题了|成功了|生效了|现在可以了|已恢复|恢复正常|能用了|通过了)(?:[\s，。！!]|$)/;

const USER_BUG_NOUN_RE = /(?:\bbug\b|缺陷|故障|漏洞|隐患)/i;

/** Strong observed-failure wording; a requirement cannot supply these. */
const USER_STRONG_OBSERVED_RE = /(?:报错|错误|异常|崩溃|闪退|白屏|卡死|没(?:有)?[^，。\n]{0,8}反应|无法|丢失|不一致|包含(?:了)?其他|都是\s*0|为\s*0|没有值|为空|空白|没(?:有)?启动|没有自动填充|跳转[^，。\n]{0,20}localhost|没有触发|不准|不准确|漏掉)/;

/** Classify a user message before it can enter the defect board. */
export function classifyUserMessage(text) {
  const body = cleanText(text).trim();
  if (!body) return { kind: 'other' };
  if (/\[dsh-mnemon:|Bounded completed checkpoint|\[user\/message; checkpoint event/i.test(body)) return { kind: 'noise' };
  if (/(?:unknown tool|工具调用失败|不是项目\s*bug|DSH\s*工具调用|工具名不存在)/i.test(body)) return { kind: 'noise' };
  if (isUserConfirmation(body)) return { kind: 'confirmation' };

  const requirement = USER_REQUIREMENT_HINT_RE.test(body);
  const imperative = /^(?:不要|别|请|建议|需要|应该|帮我|请帮我)/.test(body);
  if (imperative && !/(?:报错|崩溃|白屏|无法|没(?:有)?[^，。\n]{0,8}反应|失败|错误|异常)/.test(body)) {
    return { kind: 'feature' };
  }
  if (USER_STRONG_OBSERVED_RE.test(body)) return { kind: 'bug' };
  if (requirement) return { kind: 'feature' };
  if (/失败/.test(body)) return { kind: 'bug' };
  if (USER_BUG_NOUN_RE.test(body)) return { kind: 'bug' };
  if (/(?:怎么|如何|是否|为什么|能否|可以吗)|[?？]\s*$/.test(body)) return { kind: 'question' };
  return { kind: 'other' };
}

/** Whether a short user message confirms that a previously reported defect is gone. */
export function isUserConfirmation(text) {
  const body = oneLine(text);
  if (!body || body.length > 120) return false;
  if (/[?？]/.test(body)) return false;
  if (USER_SYMPTOM_RE.test(body)) return false;
  return USER_CONFIRM_RE.test(body);
}

/** Severity implied by a user defect report. */
export function severityOfUserText(text) {
  if (/(?:崩溃|闪退|白屏|数据丢失|数据损坏|安全漏洞|信息泄漏|无法启动)/i.test(text)) return 'blocker';
  if (/(?:无法|启动|服务|数据|日志|都是\s*0|不一致|登录|密码|跳转|localhost|包含了其他|丢失)/i.test(text)) return 'critical';
  if (/(?:样式|文案|排版|错别字|对齐|颜色|间距|UI)/i.test(text)) return 'minor';
  return 'major';
}

/**
 * Extract one project defect from a real user message.
 * Requirements, design questions, credentials and pasted logs are ignored.
 */
/** Split a message that mixes numbered items, e.g. “1. bug 2. feature”. */
function splitUserSegments(body) {
  const normalized = body.replace(/\s+(?=\d{1,2}[.、)])/g, '\n');
  return normalized
    .split(/\n+/)
    .map(line => oneLine(line.replace(/^[\s>*\-–—\d.、)|]+/, '')))
    .filter(line => line.length >= 4);
}

/**
 * Extract project defects from a real user message.
 * Requirements, design questions, credentials and pasted logs are ignored.
 * A message can mix numbered bug and requirement items; only bug segments enter the board.
 */
export function analyzeUserText(text, workspace = '') {
  const body = cleanText(text).trim();
  if (!body) return { bugs: [], confirmation: false, kind: 'other' };
  const classification = classifyUserMessage(body);
  if (classification.kind !== 'bug') {
    return { bugs: [], confirmation: classification.kind === 'confirmation', kind: classification.kind };
  }

  const segments = splitUserSegments(body);
  const bugs = [];
  for (const segment of segments) {
    if (classifyUserMessage(segment).kind !== 'bug') continue;
    const title = clip(oneLine(segment), 150);
    if (title.length < 4) continue;
    if (bugs.some(bug => bug.title === title)) continue;
    bugs.push({
      kind: 'user',
      title,
      description: clip(segment === body ? body : `${segment}\n\n原消息：\n${body}`, 1500),
      severity: severityOfUserText(segment),
      module: featureFromText(segment) || moduleFromText(workspace, segment),
      signature: `user:${hash(normalizeSignature(title))}`,
      excerpt: clip(segment, 400),
    });
    if (bugs.length >= 4) break;
  }
  if (bugs.length === 0 && classification.kind === 'bug') {
    const title = clip(oneLine(body), 150);
    if (title.length >= 4) {
      bugs.push({
        kind: 'user',
        title,
        description: clip(body, 1500),
        severity: severityOfUserText(body),
        module: featureFromText(body) || moduleFromText(workspace, body),
        signature: `user:${hash(normalizeSignature(title))}`,
        excerpt: clip(body, 400),
      });
    }
  }
  return { bugs, confirmation: false, kind: bugs.length > 0 ? 'bug' : 'other' };
}