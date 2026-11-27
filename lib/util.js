/** Small dependency-free helpers shared by the Host plugin. */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI SGR sequences and normalize line endings. */
export function cleanText(value) {
  return String(value ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n');
}

/** Keep the first `limit` characters, appending an ellipsis only when cut. */
export function clip(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Collapse all whitespace runs into single spaces. */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit hash rendered as eight lowercase hex characters. */
export function hash(value) {
  const text = String(value ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Windows-safe base name for a path; falls back to the whole string. */
export function baseName(path) {
  const text = String(path ?? '').trim().replace(/[\\/]+$/, '');
  if (!text) return '';
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

/** ISO timestamp for "now". */
export function nowIso() {
  return new Date().toISOString();
}

/** Coerce any tool argument value into a readable single line. */
export function argSummary(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return oneLine(args);
  if (typeof args !== 'object') return String(args);
  const preferred = ['command', 'description', 'file_path', 'path', 'query', 'pattern', 'url', 'title'];
  const parts = [];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(key === 'command' || key === 'description' ? value.trim() : `${key}: ${value.trim()}`);
    }
  }
  if (parts.length === 0) {
    try {
      return oneLine(JSON.stringify(args));
    } catch {
      return '';
    }
  }
  return oneLine(parts.join(' · '));
}

/** Extract the text blocks of an LLM message-like object. */
export function textOfMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

/** Split prose into sentences while keeping short bullet lines intact. */
export function splitSentences(text) {
  return cleanText(text)
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[。！？!?；;])/))
    .map(part => part.trim())
    .filter(Boolean);
}

/** Tokens used for fuzzy matching: Latin words, numbers, and Chinese bigrams. */
export function tokensOf(value) {
  const text = String(value ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9_]{3,}/g) || []) tokens.add(word);
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** Derive a functional module label from a file path relative to the workspace. */
export function moduleFromPath(workspace, filePath) {
  let pathText = String(filePath ?? '').trim().replace(/\\/g, '/');
  if (!pathText) return '';
  const root = String(workspace ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && pathText.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    pathText = pathText.slice(root.length + 1);
  }
  pathText = pathText.replace(/^[a-z]:\//i, '').replace(/^\/+/, '');
  const parts = pathText.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].replace(/\.[^.]+$/, '');
  const first = parts[0].toLowerCase();
  if (['node_modules', 'dist', 'build', '.git', 'coverage', '.next'].includes(first)) return '';
  if (['src', 'app', 'packages', 'backend', 'frontend', 'server', 'client', 'web', 'ui', 'api', 'lib'].includes(first)) {
    return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
  }
  return parts[0];
}

/** Guess a module from the first file path or project directory mentioned in text. */
export function moduleFromText(workspace, text) {
  const body = String(text ?? '');
  const file = body.match(/(?:[a-z]:[\\/]|\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.[a-z0-9]{1,8}\b/i);
  if (file) {
    const fromFile = moduleFromPath(workspace, file[0]);
    if (fromFile) return fromFile;
  }
  const cd = body.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;]+))/i);
  if (cd) {
    const fromDir = moduleFromPath(workspace, cd[1] || cd[2] || cd[3]);
    if (fromDir) return fromDir;
  }
  return '';
}

/** Stable entity tokens (filenames, URLs, services) used to merge user reports. */
export function entitiesOf(value) {
  const text = String(value ?? '').toLowerCase();
  const entities = new Set();
  for (const match of text.match(/[a-z0-9_./\\-]+\.(?:sh|bash|js|mjs|cjs|ts|tsx|jsx|py|json|ya?ml|html|css|scss|md|toml|ini|env|ps1|bat|cmd)|localhost|127\.0\.0\.1/g) || []) {
    entities.add(match);
    const base = match.split(/[\\/]/).pop();
    if (base && base !== match) entities.add(base);
  }
  return entities;
}

/** Cosine-like overlap between two token sets, from 0 to 1. */
export function similarity(left, right) {
  const a = typeof left === 'string' ? tokensOf(left) : left;
  const b = typeof right === 'string' ? tokensOf(right) : right;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
}