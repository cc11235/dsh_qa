/** Parse a DSH shell call/output pair for a Git commit message. */

/** Extract the commit message from `-m` flags or a small heredoc. */
function commitMessage(command) {
  const messages = [];
  const pattern = /(?:^|\s)-[a-z]*m\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) messages.push(value);
  }
  if (messages.length > 0) return messages.join('\n');
  const heredoc = command.match(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?\s*\n([\s\S]*?)\n\s*\1/);
  if (heredoc) return heredoc[2];
  return '';
}

/**
 * Return `{ sha, subject, message, type, scope }` for a `fix|bugfix|hotfix`
 * conventional commit, otherwise null.
 */
export function parseGitCommit(command, output = '') {
  if (typeof command !== 'string' || !/\bgit\s+commit\b/.test(command)) return null;
  const message = commitMessage(command);
  const outputMatch = String(output).match(/\[[^\]\n]*?([0-9a-f]{7,40})\]\s+([^\n]+)/i);
  const sha = outputMatch ? outputMatch[1] : '';
  const subject = (message.split('\n')[0] || (outputMatch ? outputMatch[2] : '')).trim();
  if (!subject) return null;
  const conventional = subject.match(/^(fix|bugfix|hotfix)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  if (!conventional) return null;
  return {
    sha,
    subject: subject.slice(0, 200),
    message: (message || subject).slice(0, 2000),
    type: conventional[1].toLowerCase(),
    scope: (conventional[2] || '').trim(),
  };
}