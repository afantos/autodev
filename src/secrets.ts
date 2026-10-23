/** Patterns are a backstop; GitHub push protection should also be enabled. */
const PATTERNS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, 'private key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{50,}/, 'GitHub PAT'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
  [/sk_live_[A-Za-z0-9]{20,}/, 'Stripe live key'],
  [/rk_live_[A-Za-z0-9]{20,}/, 'Stripe restricted live key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/lin_api_[A-Za-z0-9]{30,}/, 'Linear key'],
];

export function scanSecrets(diff: string): string[] {
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  return PATTERNS.filter(([re]) => re.test(added)).map(([, name]) => name);
}

export class UnsafePushError extends Error {
  constructor(kinds: string[]) { super(`Push refused: possible secrets in outgoing commit history (${kinds.join(', ')}). Work remains local.`); }
}
