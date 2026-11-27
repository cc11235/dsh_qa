import assert from 'node:assert/strict';
import test from 'node:test';
import {
  argSummary,
  baseName,
  cleanText,
  clip,
  entitiesOf,
  hash,
  moduleFromPath,
  moduleFromText,
  nowIso,
  oneLine,
  similarity,
  splitSentences,
  textOfMessage,
  tokensOf,
} from '../lib/util.js';

test('cleanText strips ANSI SGR and normalizes CRLF', () => {
  assert.equal(cleanText('\u001b[31mred\u001b[0m\r\nnext\rend'), 'red\nnext\nend');
  assert.equal(cleanText(null), '');
});

test('clip keeps short text and appends an ellipsis only when cut', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abcdef', 6), 'abcdef');
  assert.equal(clip(undefined, 5), '');
});

test('oneLine collapses whitespace runs', () => {
  assert.equal(oneLine('  a \n\t b  '), 'a b');
  assert.equal(oneLine(''), '');
});

test('hash is stable FNV-1a 32-bit hex', () => {
  assert.equal(hash(''), '811c9dc5');
  assert.equal(hash('abc'), hash('abc'));
  assert.match(hash('缺陷'), /^[0-9a-f]{8}$/);
  assert.notEqual(hash('abc'), hash('abd'));
});

test('nowIso returns a parseable ISO timestamp', () => {
  const value = nowIso();
  assert.equal(Number.isNaN(Date.parse(value)), false);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T/);
});

test('baseName handles Windows and POSIX paths', () => {
  assert.equal(baseName('C:\\demo\\scripts\\up.sh'), 'up.sh');
  assert.equal(baseName('C:\\demo\\'), 'demo');
  assert.equal(baseName('/home/user/project/'), 'project');
  assert.equal(baseName(''), '');
  assert.equal(baseName('/'), '');
});

test('argSummary prefers readable tool arguments', () => {
  assert.equal(argSummary(null), '');
  assert.equal(argSummary('npm test'), 'npm test');
  assert.equal(argSummary({ command: 'npm test', file_path: 'src/a.ts' }), 'npm test · file_path: src/a.ts');
  assert.equal(argSummary({ foo: 'bar' }), '{"foo":"bar"}');
});

test('textOfMessage joins only text blocks', () => {
  assert.equal(textOfMessage({
    content: [
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'x' },
      { type: 'text', text: 'second' },
    ],
  }), 'first\nsecond');
  assert.equal(textOfMessage(null), '');
  assert.equal(textOfMessage({ content: 'not-an-array' }), '');
});

test('splitSentences keeps punctuation and short bullet lines', () => {
  assert.deepEqual(splitSentences('第一句。第二句！\n- 第三行'), ['第一句。', '第二句！', '- 第三行']);
  assert.deepEqual(splitSentences(''), []);
});

test('tokensOf indexes Latin words and Chinese bigrams', () => {
  const tokens = tokensOf('登录接口 500');
  assert.equal(tokens.has('500'), true);
  assert.equal(tokens.has('登录'), true);
  assert.equal(tokens.has('录接'), true);
  assert.equal(tokens.has('接口'), true);
  assert.equal(tokensOf('').size, 0);
});

test('similarity is symmetric, bounded, and zero for empty input', () => {
  const a = '登录接口 500';
  const b = '登录接口超时';
  assert.equal(similarity(a, b), similarity(b, a));
  assert.ok(similarity(a, b) > 0.5);
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity('', a), 0);
  assert.equal(similarity('foo', 'bar'), 0);
});

test('moduleFromPath maps project paths to stable module labels', () => {
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\scripts\\up.sh'), 'scripts');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\backend\\app\\static\\app.css'), 'backend/app');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\viewer\\templates\\agents.html'), 'viewer');
  assert.equal(moduleFromPath('D:\\demo', 'src\\components\\Button.tsx'), 'src/components');
  assert.equal(moduleFromPath('D:\\demo', 'node_modules\\pkg\\index.js'), '');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo'), 'demo');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\index.js'), 'index');
  assert.equal(moduleFromPath('D:\\demo', ''), '');
});

test('moduleFromPath is case-insensitive about the workspace prefix', () => {
  assert.equal(moduleFromPath('D:\\Demo', 'd:\\demo\\scripts\\up.sh'), 'scripts');
  assert.equal(moduleFromPath('D:\\demo', 'D:\\demo\\src\\a.ts'), 'src');
});

test('moduleFromText extracts a module from a file path or cd command', () => {
  assert.equal(moduleFromText('D:\\demo', '打开 scripts/up.sh 看看'), 'scripts');
  assert.equal(moduleFromText('D:\\demo', 'cd backend/app && ls'), 'backend');
  assert.equal(moduleFromText('D:\\demo', '没有任何路径'), '');
});

test('entitiesOf collects filenames, paths and loopback hosts', () => {
  const entities = entitiesOf('打开 C:\\demo\\up.sh，访问 localhost:5173 和 src/app.ts');
  assert.equal(entities.has('localhost'), true);
  assert.equal(entities.has('up.sh'), true);
  assert.equal(entities.has('app.ts'), true);
  assert.equal(entitiesOf('').size, 0);
});