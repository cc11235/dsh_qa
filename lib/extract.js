/**
 * Deterministic bug extraction from one DSH turn.
 *
 * The tracker intentionally avoids a second model call: every signal below is
 * derived from durable session events (tool results and assistant text), so
 * extraction is instant, free, and reproducible on replay.
 */

import { featureFromText } from './features.js';
import { cleanText, clip, hash, moduleFromText, oneLine, splitSentences, tokensOf } from './util.js';

/** Tools whose failures are lookups or user dialogue, not product defects. */
export const DEFAULT_IGNORED_TOOLS = [
  'ops_inspect_local_file',
  'ops_glob',
  'ops_grep',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
  'ask_user_question',
  'present',
  'update_goal',
  'get_goal',
  'list_agents',
  'wait_agent',
];

const NOISE_RE = /(?:PATH_RESTRICTED|approval required|approval denied|denied by the user|user_denied|approval policy)/i;

/** Failures caused by the Agent/harness calling a tool wrongly, not by the project. */
const INFRA_FAILURE_RE = /(?:unknown tool|tool\s+["'][^"']+["']\s+not found|not a recognized tool|invalid tool|tool activation failed|invalid arguments|schema validation|additionalProperties|approval (?:required|denied)|permission policy|PATH_RESTRICTED|user denied|denied by the user|未知工具|工具未启用|参数校验|工具调用失败)/i;

/** Tools that execute project commands; everything else cannot produce a project defect here. */
const EXEC_TOOL_RE = /(?:bash|shell|pwsh|powershell|terminal|command|exec|spawn|run)/i;

/** Build, test, lint and type-check commands: a non-zero exit is project evidence. */
const CHECK_COMMAND_RE = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile|typecheck|type-check|lint|test|check)\b|\b(?:tsc|vite\s+build|webpack|rollup|esbuild|next\s+build|nuxt\s+build|go\s+(?:build|test|vet)|cargo\s+(?:build|test|check|clippy)|mvnw?|gradlew?|dotnet\s+(?:build|test)|make|cmake|pytest|ruff|eslint|mypy|pyright|vitest|jest|playwright\s+test|phpunit|rspec|node\s+--test|manage\.py\s+test)\b)/i;

/** Run commands: only an exception with a project source location counts. */
const RUN_COMMAND_RE = /(?:\bnode\b|\bpython(?:3)?\b|\bgo\s+run\b|\bdotnet\s+run\b|\bjava\b|\buvicorn\b|\bgunicorn\b|\bflask\s+run\b|\bnpm\s+run\s+dev\b|\bpnpm\s+(?:run\s+)?dev\b|\byarn\s+dev\b|\bbun\s+run\b)/i;

/** Concrete project failure evidence in command output. */
const PROJECT_ERROR_RE = /(?:error\s+TS\d+|error\[E\d+\]|SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|Assertion failed|Uncaught|UnhandledPromiseRejection|Traceback \(most recent call last\)|panic:|Segmentation fault|segmentation fault|FAIL(?:ED)?\b|Tests? failed|failed[,\s]+\d+|编译错误|构建失败|测试失败|错误|失败)/i;

/** Broad check-command failure wording (lint/build/test tools). */
const CHECK_FAILURE_RE = /(?:error|fail|FAIL|ERR!|失败|错误|异常|traceback|panic)/i;

/** A project source location such as `src/app.ts:12` or `File "x.py", line 3`. */
const FILE_REF_RE = /(?:\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|kts|cs|php|rb|swift|css|scss|html|json):\d+|File\s+["'][^"']+["'],\s+line\s+\d+|at\s+(?!\[eval\]|node:internal|internal\/|<anonymous>|eval at)[^\n]+:\d+:\d+)/i;

/** Bad invocation/environment, not a defect in the project. */
const MISSING_SCRIPT_RE = /(?:Missing script|command not found|is not recognized|No such file or directory|spawn\s+\S+\s+ENOENT|npm ERR! code ENOENT)/i;

const RESOLUTION_RE = /(?:已修复|修复完成|已解决|问题已解决|已修正|已处理|已排除|已改为|改好了|修好了|现在(?:已)?(?:可以|能)?正常|恢复正常|验证通过|回归通过|已确认修复|确认已修复|测试通过|全部通过)|\b(?:fixed|resolved|patched|verified)\b/i;
const VERIFIED_RE = /(?:验证通过|回归通过|已确认修复|确认已修复|测试通过|全部通过)|\bverified\b/i;

const BUG_NOUN_RE = /(?:\bbug\b|缺陷|故障|漏洞|隐患|BUG)/i;
const FAILURE_RE = /(?:报错|抛异常|异常|崩溃|闪退|白屏|卡死|死循环|内存泄漏|数据不一致|无法(?:启动|打开|加载|保存|登录|运行|连接|提交)|不生效|失效|失败|超时)/;
const OBSERVATION_RE = /(?:发现|找到|定位|复现|出现|存在|导致|引发|造成|报错|崩溃|失败|异常|不生效|无法|错误)/;
const META_RE = /(?:缺陷看板|缺陷列表|追踪动态|自动捕获|提取规则|状态流转|qa_[a-z_]+|qa-guardian|QA 缺陷追踪)/i;
const NEGATIVE_RE = /(?:没有|未|无|不存在)(?:发现|找到|复现|出现)|没有(?:问题|异常|报错)|一切正常/;
const SUGGESTION_RE = /^(?:建议|可以考虑|应该|需要检查|如果|假如|是否需要)/;
const TRIVIAL_RE = /^(?:好的|收到|明白|已完成|完成|谢谢|OK\b|Done\b)/i;
/** Requirement/acceptance wording: desired behavior, not an observed defect. */
const REQUIREMENT_SENTENCE_RE = /(?:失败|成功|异常|错误|超时|空数据|无数据|失败状态)(?:时|后|状态下)?[^。；\n]{0,24}(?:显示|保留|弹出|提示|不再|自动|支持|允许|应|需要|要)/;
const OBSERVED_FAILURE_RE = /(?:出现|发生|导致|引发|复现|报错|崩溃|白屏|闪退|卡死|无法)/;
const FAILURE_HEADING_RE = /^[^。！？]{0,30}(?:失败|异常|报错)(?:后|时|状态下)?[:：]\s*$/;

/** Detect an explicit exit code marker in tool output. */
export function detectExitCode(text) {
  const raw = cleanText(text);
  const bracket = raw.match(/\[exit code:\s*(-?\d+)\]/i);
  if (bracket) return Number(bracket[1]);
  const plain = raw.match(/(?:^|\n)\s*exit code:\s*(-?\d+)/i);
  return plain ? Number(plain[1]) : null;
}

/** Whether a tool result represents a failure worth considering. */
export function isFailureResult(text, isError) {
  if (NOISE_RE.test(cleanText(text))) return false;
  if (isError === true) return true;
  const code = detectExitCode(text);
  if (code !== null && code !== 0) return true;
  return /(?:^|\n)\s*(?:Traceback \(most recent call last\)|panic:|fatal error|npm ERR!|error TS\d+|FAILED\b)/m.test(cleanText(text));
}

/** Remove volatile fragments so the same defect keeps one signature. */
export function normalizeSignature(text) {
  return oneLine(text)
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+/gi, '<path>')
    .replace(/(?:\/[\w.-]+){2,}/g, '<path>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?:line|第)\s*\d+\b/gi, '')
    .slice(0, 320);
}

/** Pick the line that best explains a failure. */
export function pickErrorLine(text) {
  const lines = cleanText(text)
    .split('\n')
    .map(line => oneLine(line.replace(/^\s*\[(?:stderr|stdout|exit code)[^\]]*\]\s*/i, '')))
    .filter(line => line && !/^(?:\[?EXIT_CODE|exit code:)/i.test(line));
  const preferred = lines.filter(line => /(?:error|fail|exception|fatal|denied|refused|not found|missing|unable|panic|assert|not ok|失败|错误|异常|超时|拒绝|找不到|不存在)/i.test(line));
  const line = preferred[0] || lines[lines.length - 1] || '';
  return clip(oneLine(line.replace(/^(?:error|错误|exception|fatal)\s*[:：]\s*/i, '')), 150);
}

/** Category and default severity for a failed tool result. */
export function classifyFailure(tool, text) {
  const hay = `${tool}\n${cleanText(text)}`.toLowerCase();
  if (/(?:pytest|vitest|jest|mocha|playwright|cypress|go test|cargo test|dotnet test|node\s+--test|not ok\b|# fail\s*\d+|tests? failed|failed,\s*\d+|failed tests|测试失败)/.test(hay)) {
    return { category: '测试失败', severity: 'major' };
  }
  if (/(?:webpack|rollup|esbuild|next build|vite build|tsc\b|build failed|构建失败|error ts\d+|compile(?:r)? error)/.test(hay)) {
    return { category: '构建失败', severity: 'major' };
  }
  if (/(?:npm (?:install|i)\b|pnpm (?:install|i|add)\b|yarn (?:install|add)\b|pip install|依赖安装)/.test(hay)) {
    return { category: '依赖安装失败', severity: 'major' };
  }
  if (/(?:segmentation fault|panic:|crash|数据丢失|数据损坏|安全漏洞|信息泄漏|凭据泄漏|无法启动)/i.test(text)) {
    return { category: '运行故障', severity: 'blocker' };
  }
  if (/(?:eacces|eperm|permission denied|access denied|权限不足)/i.test(text)) {
    return { category: '权限错误', severity: 'critical' };
  }
  if (/(?:enoent|not found|no such file|command not found|is not recognized|找不到|不存在)/i.test(text)) {
    return { category: '文件或命令缺失', severity: 'minor' };
  }
  if (/(?:timeout|timed out|etimedout|超时|killed)/i.test(text)) {
    return { category: '执行超时', severity: 'minor' };
  }
  return { category: '命令执行失败', severity: 'major' };
}

/** Classify a shell command as project check, project run, or other. */
export function projectCommandKind(command) {
  const text = oneLine(command);
  if (CHECK_COMMAND_RE.test(text)) return 'check';
  if (RUN_COMMAND_RE.test(text)) return 'run';
  return 'other';
}

/** Build a bug draft from a failed tool result. Returns null when not a defect. */
export function analyzeToolResult({ tool, args, text, isError, workspace = '' }) {
  const toolName = String(tool || 'tool');
  if (!EXEC_TOOL_RE.test(toolName)) return null;
  const command = oneLine(
    (args && typeof args === 'object' ? args.command : '')
    || (args && typeof args === 'object' ? args.script_path : ''),
  );
  if (!command) return null;
  if (!isFailureResult(text, isError)) return null;
  const body = cleanText(text).trim();
  // A cancelled call or an empty failure envelope is not a product defect.
  if (!body) return null;
  // Tool misuse, bad arguments, approvals and sandbox denials are harness issues.
  if (INFRA_FAILURE_RE.test(body)) return null;
  if (/(?:操作已取消|cancelled|canceled|aborted|interrupted|用户中断|已停止)/i.test(body) && body.length < 600) return null;
  const meaningful = body
    .split('\n')
    .map(line => oneLine(line))
    .filter(line => line && !/^\[?(?:exit code|EXIT_CODE)/i.test(line));
  if (meaningful.length === 0) return null;

  // Only failures attributable to project code/toolchain reach the board.
  const commandKind = projectCommandKind(command);
  const hasProjectError = PROJECT_ERROR_RE.test(body) || (commandKind === 'check' && CHECK_FAILURE_RE.test(body));
  const hasFileRef = FILE_REF_RE.test(body);
  if (commandKind === 'check') {
    if (MISSING_SCRIPT_RE.test(body)) return null;
    if (!hasProjectError) return null;
  } else if (!hasProjectError || !hasFileRef) {
    // Run/other commands need an exception plus a source location.
    return null;
  }

  const line = pickErrorLine(body);
  const { category, severity } = classifyFailure(toolName, body);
  const triggerText = command;
  const suffix = line ? `：${line}` : '';
  const title = clip(`${category}${suffix}`, 150);
  const description = [
    `触发命令：${triggerText}`,
    line ? `错误摘要：${line}` : '',
    '',
    clip(body.slice(0, 900), 900),
  ].filter((part, index) => part !== '' || index === 2).join('\n').trim();

  return {
    kind: 'tool',
    title,
    description,
    severity,
    module: moduleFromText(workspace, `${triggerText}\n${body}`) || featureFromText(`${triggerText}\n${body}`),
    signature: `tool:${hash(`${toolName}|${normalizeSignature(line || body)}`)}`,
    trigger: {
      tool: toolName,
      command: triggerText,
      key: hash(`${toolName}|${normalizeSignature(triggerText || line || body)}`),
    },
    excerpt: clip(line || body, 400),
  };
}

/** Severity implied by wording in an assistant message. */
export function severityOfText(text) {
  if (/(?:致命|崩溃|白屏|数据丢失|数据损坏|安全漏洞|信息泄漏|无法启动|P0|blocker)/i.test(text)) return 'blocker';
  if (/(?:阻塞|P1|critical|严重|权限|泄露)/i.test(text)) return 'critical';
  if (/(?:样式|文案|拼写|对齐|UI|界面|minor|轻微)/i.test(text)) return 'minor';
  return 'major';
}

/** Normalize one prose sentence into a defect title. */
export function sentenceTitle(sentence) {
  return clip(
    oneLine(
      String(sentence)
        .replace(/^[#>*\-–—\d.\s|]+/, '')
        .replace(/`{1,3}/g, '')
        .replace(/\*\*/g, '')
        .trim(),
    ),
    130,
  );
}

/**
 * Scan assistant prose for defect statements and resolution statements.
 * Returns at most two defect candidates per message to keep the board signal-rich.
 */
export function analyzeAssistantText(text) {
  const bugs = [];
  const resolutions = [];
  // Fenced code is evidence, not prose: quoting a snippet must not create a defect.
  const prose = cleanText(text).replace(/```[\s\S]*?```/g, '\n');
  for (const sentence of splitSentences(prose)) {
    if (!sentence || sentence.length > 320) continue;
    if (TRIVIAL_RE.test(sentence)) continue;
    if (META_RE.test(sentence)) continue;
    if (INFRA_FAILURE_RE.test(sentence)) continue;

    if (RESOLUTION_RE.test(sentence) && !NEGATIVE_RE.test(sentence)) {
      resolutions.push({
        snippet: clip(sentence, 260),
        verified: VERIFIED_RE.test(sentence),
      });
      continue;
    }

    if (/^[|#]/.test(sentence)) continue;
    if (FAILURE_HEADING_RE.test(sentence)) continue;
    if (REQUIREMENT_SENTENCE_RE.test(sentence) && !OBSERVED_FAILURE_RE.test(sentence)) continue;
    if (sentence.length < 8) continue;
    if (NEGATIVE_RE.test(sentence)) continue;
    if (/[?？]\s*$/.test(sentence)) continue;
    if (SUGGESTION_RE.test(sentence) && !BUG_NOUN_RE.test(sentence)) continue;
    const failure = FAILURE_RE.test(sentence);
    const bugNoun = BUG_NOUN_RE.test(sentence);
    if (!failure && !(bugNoun && OBSERVATION_RE.test(sentence))) continue;

    const title = sentenceTitle(sentence);
    if (title.length < 8) continue;
    const duplicate = bugs.some(bug => similarityOfTitle(bug.title, title) > 0.7);
    if (duplicate) continue;

    bugs.push({
      kind: 'assistant',
      title,
      description: clip(sentence, 600),
      severity: severityOfText(sentence),
      module: featureFromText(sentence),
      signature: `say:${hash(normalizeSignature(title))}`,
      excerpt: clip(sentence, 400),
    });
    if (bugs.length >= 2) break;
  }
  return { bugs, resolutions };
}

function similarityOfTitle(left, right) {
  const a = tokensOf(left);
  const b = tokensOf(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}