/**
 * Narrow existing-test updates (option B, 2026-10-25). An edit to an existing test file normally needs a human. It may
 * instead go to a dedicated second-review test-integrity check ONLY when every change is one of:
 *  - a test rename: same test()/it()/describe()/suite() call (no .skip/.only/.todo), same arguments after the name;
 *  - an expected-value update: the same assert.equal/strictEqual/deepEqual/deepStrictEqual call, the same actual
 *    expression and message, and a new expected value that is a plain literal (not an expression).
 * Edits must be one-for-one line replacements: no existing line is deleted, no line is inserted into an existing file
 * (new coverage goes in new test files), and nothing else changes. Anything else is a broader edit for a human.
 * A superseding requirement must also be on record (see findSupersedingRequirement).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface TestUpdateChange { kind: 'name' | 'expected'; line: number; before: string; after: string }
export interface TestUpdateAnalysis { eligible: boolean; why: string | null; changes: TestUpdateChange[] }

const ASSERT_METHODS = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'] as const;
const TEST_CALL = /^(\s*)(test|it|describe|suite)(\s*\(\s*)(['"])((?:\\.|(?!\4).)*)\4(.*)$/;
const ASSERT_CALL = /^(\s*)assert\.([A-Za-z]+)\((.*)\)(;?)(\s*)$/;

export function analyzeTestUpdate(oldText: string, newText: string, file = 'test.js'): TestUpdateAnalysis {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const changes: TestUpdateChange[] = [];
  const fail = (why: string): TestUpdateAnalysis => ({ eligible: false, why, changes });
  if (a.length !== b.length) return fail(`lines were ${a.length < b.length ? 'added to' : 'removed from'} an existing test file (only in-place renames and expected values may change; add new coverage in new test files)`);
  // Line patterns alone ignore surrounding syntax: text that looks like an assertion may sit inside a template literal,
  // string or comment, and an edit there can break out into executable code. Lex both whole files and require every
  // changed line to start AND end in top-level code in both versions; anything ambiguous is ineligible.
  const la = lexLines(oldText);
  const lb = lexLines(newText);
  if (!la.ok || !lb.ok) return fail('the test file could not be lexed unambiguously');
  if (la.codeAtStart.length !== a.length || lb.codeAtStart.length !== b.length) return fail('line context does not match the file length');
  if (/\.[cm]?[jt]sx$/.test(file)) return fail('JSX test files are not eligible (JSX text is not lexed)');
  if (!/\.[cm]?[jt]s$/.test(file)) return fail('only JavaScript and TypeScript test files are eligible');
  const changed: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!la.codeAtStart[i] || !la.codeAtEnd[i] || !lb.codeAtStart[i] || !lb.codeAtEnd[i]) {
      return fail(`line ${i + 1}: the edit is inside (or leaves open) a string, template literal, comment or regular expression`);
    }
    const kind = classifyPair(a[i]!, b[i]!);
    if (typeof kind !== 'string' || (kind !== 'name' && kind !== 'expected')) return fail(`line ${i + 1}: ${kind.why}`);
    changes.push({ kind, line: i + 1, before: a[i]!, after: b[i]! });
    changed.push(i);
  }
  if (!changes.length) return fail('no changes');
  // Cross-check with the real parser: V8 must agree that both boundaries of every changed line are code, in both
  // versions. The boundary before line i is k = i, the one after it k = i + 1.
  const boundaries = [...new Set(changed.flatMap((i) => [i, i + 1]))];
  const ts = /\.[cm]?ts$/.test(file);
  for (const [label, text] of [['old', oldText], ['new', newText]] as const) {
    const v = v8CodeAtBoundaries(text, ts, boundaries);
    if (!v.ok) return fail(`V8 could not confirm the ${label} file's line context: ${v.why}`);
    const bad = boundaries.find((_, j) => !v.code[j]);
    if (bad !== undefined) return fail(`line ${bad + 1}: V8 reads the ${label} file differently: this edit is not in top-level code`);
  }
  return { eligible: true, why: null, changes };
}

function classifyPair(before: string, after: string): 'name' | 'expected' | { why: string } {
  const tb = TEST_CALL.exec(before);
  const ta = TEST_CALL.exec(after);
  if (tb || ta) {
    if (!tb || !ta) return { why: 'a test declaration was changed into something else (or vice versa)' };
    const [, indB, fnB, openB, , , restB] = tb;
    const [, indA, fnA, openA, , , restA] = ta;
    if (indB !== indA || fnB !== fnA || openB !== openA) return { why: `test call changed (${fnB} → ${fnA})` };
    if (restB !== restA) return { why: 'test declaration changed beyond its name' };
    return 'name';
  }
  const ab = ASSERT_CALL.exec(before);
  const aa = ASSERT_CALL.exec(after);
  if (!ab || !aa) return { why: 'edit is neither a test rename nor an expected-value update' };
  const [, indB, mB, argsB, semiB, wsB] = ab;
  const [, indA, mA, argsA, semiA, wsA] = aa;
  if (indB !== indA || semiB !== semiA || wsB !== wsA) return { why: 'assertion formatting changed' };
  if (mB !== mA) return { why: `assertion changed from assert.${mB} to assert.${mA}` };
  if (!(ASSERT_METHODS as readonly string[]).includes(mA!)) return { why: `assert.${mA} is not an eligible value assertion` };
  const xb = splitArgs(argsB!);
  const xa = splitArgs(argsA!);
  if (!xb || !xa || xb.length !== xa.length || xb.length < 2 || xb.length > 3) return { why: 'assertion arguments could not be compared' };
  if (xb[0] !== xa[0]) return { why: 'the asserted (actual) expression changed' };
  if (xb.length === 3 && xb[2] !== xa[2]) return { why: 'the assertion message changed' };
  if (xb[1] === xa[1]) return { why: 'no expected-value change' };
  if (!isLiteral(xa[1]!)) return { why: `the new expected value ${xa[1]} is not a plain literal` };
  if (xa[1] === xa[0]) return { why: 'the expected value equals the actual expression' };
  return 'expected';
}

/** Split a call's argument list at top-level commas; null if quotes/brackets don't balance. */
export function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0, cur = '', quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth < 0) return null;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (quote || depth !== 0) return null;
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A plain literal: number, single/double-quoted string, boolean, null, or arrays/objects of those. */
export function isLiteral(s: string): boolean {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i]!)) i++; };
  const value = (): boolean => {
    ws();
    const rest = s.slice(i);
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) { i += num[0].length; return true; }
    const kw = /^(?:true|false|null)\b/.exec(rest);
    if (kw) { i += kw[0].length; return true; }
    if (s[i] === "'" || s[i] === '"') return str();
    if (s[i] === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return true; }
      for (;;) { if (!value()) return false; ws(); if (s[i] === ',') { i++; ws(); if (s[i] === ']') { i++; return true; } continue; } if (s[i] === ']') { i++; return true; } return false; }
    }
    if (s[i] === '{') {
      i++; ws();
      if (s[i] === '}') { i++; return true; }
      for (;;) {
        ws();
        if (s[i] === "'" || s[i] === '"') { if (!str()) return false; } else { const k = /^[A-Za-z_$][\w$]*/.exec(s.slice(i)); if (!k) return false; i += k[0].length; }
        ws(); if (s[i] !== ':') return false; i++;
        if (!value()) return false; ws();
        if (s[i] === ',') { i++; ws(); if (s[i] === '}') { i++; return true; } continue; }
        if (s[i] === '}') { i++; return true; }
        return false;
      }
    }
    return false;
  };
  const str = (): boolean => {
    const q = s[i]; i++;
    while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
    if (s[i] !== q) return false;
    i++; return true;
  };
  const ok = value(); ws();
  return ok && i === s.length;
}

export interface SupersedingSource { source: string; text: string }

/**
 * Text that explicitly establishes that earlier behavior is superseded: the ticket's own description, or a human
 * (non-automation) comment or human decision on the ticket that says so ("supersede/supersedes/superseded/superseding").
 * autodev's own comments never count.
 */
export function findSupersedingRequirement(input: { description: string; comments: { body: string; byAutomation: boolean }[]; humanDecisions: { question: string; decision: string | null }[] }): SupersedingSource[] {
  const SUPERSEDE = /\bsupersed(?:e|es|ed|ing)\b/i;
  const out: SupersedingSource[] = [];
  if (SUPERSEDE.test(input.description)) out.push({ source: 'ticket description', text: input.description });
  for (const c of input.comments) if (!c.byAutomation && SUPERSEDE.test(c.body)) out.push({ source: 'human comment', text: c.body });
  for (const d of input.humanDecisions) if (d.decision && SUPERSEDE.test(d.decision)) out.push({ source: 'human decision', text: `Q: ${d.question}\nA: ${d.decision}` });
  return out;
}

const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '{', ';', '&', '|', '?', '+', '-', '*', '%', '<', '~', '^', '=>', ')control']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'new', 'delete', 'void', 'throw', 'instanceof', 'extends', 'default']);
/** Tokens after which a '/' could be either a regex or a division depending on context this lexer does not track. */
const AMBIGUOUS_BEFORE_SLASH = new Set([
  '}', // end of a block (regex follows) or of an object literal / function expression (division follows)
  ')?', // `await (x) / 2` versus `for await (...) /re/`
  '!', // logical not (regex) or a TypeScript non-null assertion `x! / 2` (division)
  '>', // greater-than (regex) or the end of TypeScript type arguments `f<T> / 2`
  '++', '--', // prefix (regex) or postfix (division)
  'of', 'yield', 'await', // keywords in some contexts, plain identifiers in others
  '.', // `.` / `?.` / `...` followed by '/' is not valid; refuse rather than guess
]);
const CONTROL_PARENS = new Set(['if', 'while', 'for', 'with']);

/** What a '/' (not starting a comment) means after the token `prev`: anything not clearly decided is ambiguous. */
function slashAfter(prev: string): 'regex' | 'division' | 'ambiguous' {
  if (REGEX_AFTER.has(prev) || REGEX_KEYWORDS.has(prev)) return 'regex';
  if (AMBIGUOUS_BEFORE_SLASH.has(prev)) return 'ambiguous';
  // Division only after something that ends a value: a number, string, template, regex, `]`, a non-control `)`, an
  // identifier (or a property name after '.').
  if (['num', 'str', 'regex', ']', ')', 'ident'].includes(prev) || /^[A-Za-z_$][\w$]*$/.test(prev)) return 'division';
  return 'ambiguous';
}

/**
 * Conservative JavaScript/TypeScript lexer for line context. Tracks strings, template literals (with nested ${...}
 * expressions), line and block comments, and regex literals. A '/' is a regex or a division only where the preceding
 * token decides it (see slashAfter; a ')' is resolved by what opened it); any ambiguous '/' makes the file not ok, as do
 * HTML-like comments. For each line it records whether that line starts and ends in top-level code. `ok` is false if
 * the file ends inside a string, template, comment, regex, ${...} expression or parenthesis. analyzeTestUpdate also
 * cross-checks its answers against V8 (v8CodeAtBoundaries), so a lexer mistake alone cannot make an edit eligible.
 */
export function lexLines(text: string): { ok: boolean; codeAtStart: boolean[]; codeAtEnd: boolean[] } {
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'regex' | 'regexClass';
  let mode: Mode = 'code';
  const exprDepth: number[] = []; // one entry per open ${...}: its current {} nesting depth
  let lastSig = ''; // last significant code token, for the regex/division decision
  const parens: string[] = []; // for each open '(', the token before it: `if (...) /re/` is a regex, `f(x) / 2` division
  const codeAtStart: boolean[] = [];
  const codeAtEnd: boolean[] = [];
  const fail = () => ({ ok: false, codeAtStart, codeAtEnd });
  const topLevel = () => mode === 'code' && exprDepth.length === 0;
  codeAtStart.push(true);
  if (text.startsWith('#!')) mode = 'line'; // hashbang
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    // JavaScript also ends lines (and // comments) at a lone CR, U+2028 and U+2029; this lexer only counts '\n'.
    if ((c === '\r' && n !== '\n') || c === '\u2028' || c === '\u2029') return fail();
    if (c === '\n') {
      if (mode === 'line') mode = 'code';
      codeAtEnd.push(topLevel());
      if (mode === 'sq' || mode === 'dq' || mode === 'regex' || mode === 'regexClass') return { ok: false, codeAtStart, codeAtEnd }; // unterminated
      codeAtStart.push(topLevel());
      continue;
    }
    switch (mode) {
      case 'line': break;
      case 'block': if (c === '*' && n === '/') { mode = 'code'; i++; } break;
      case 'sq': case 'dq':
        if (c === '\\') { if (n === '\n') return { ok: false, codeAtStart, codeAtEnd }; i++; break; } // no line continuations
        if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) { mode = 'code'; lastSig = 'str'; }
        break;
      case 'tpl':
        // An escaped newline is a template line continuation: consume only the backslash so the newline below is
        // still seen (and recorded) as a physical line break; skipping it would shift every later line's context.
        if (c === '\\') { if (n !== '\n') i++; break; }
        if (c === '`') { mode = 'code'; lastSig = 'str'; break; }
        if (c === '$' && n === '{') { exprDepth.push(0); mode = 'code'; lastSig = '{'; i++; }
        break;
      case 'regex':
        if (c === '\\') { if (n !== '\n') i++; break; } // a newline inside a regex is then rejected as unterminated
        if (c === '[') { mode = 'regexClass'; break; }
        if (c === '/') { mode = 'code'; lastSig = 'regex'; while (/[a-z]/i.test(text[i + 1] ?? '')) i++; }
        break;
      case 'regexClass':
        if (c === '\\') { if (n !== '\n') i++; break; }
        if (c === ']') mode = 'regex';
        break;
      case 'code': {
        if (/\s/.test(c)) break;
        if (c === '/' && n === '/') { mode = 'line'; i++; break; }
        if (c === '/' && n === '*') { mode = 'block'; i++; break; }
        if (c === "'") { mode = 'sq'; break; }
        if (c === '"') { mode = 'dq'; break; }
        if (c === '`') { mode = 'tpl'; break; }
        if (c === '/') {
          const after = slashAfter(lastSig);
          if (after === 'ambiguous') return fail();
          if (after === 'regex') { mode = 'regex'; break; }
          lastSig = '/'; break;
        }
        // HTML-like comments (<!-- and -->) are comments in scripts but operators in modules: never guess.
        if ((c === '<' && text.startsWith('!--', i + 1)) || (c === '-' && n === '-' && text[i + 2] === '>')) return fail();
        if ((c === '+' || c === '-') && n === c) { lastSig = c + c; i++; break; } // ++ / -- (a postfix one ends a value)
        if (c === '=' && n === '>') { lastSig = '=>'; i++; break; }
        if (c === '(') { parens.push(lastSig); lastSig = '('; break; }
        if (c === ')') {
          if (!parens.length) return fail();
          const opener = parens.pop()!;
          lastSig = CONTROL_PARENS.has(opener) ? ')control' : opener === 'await' ? ')?' : ')';
          break;
        }
        if (exprDepth.length) {
          if (c === '{') exprDepth[exprDepth.length - 1]!++;
          if (c === '}') {
            if (exprDepth[exprDepth.length - 1] === 0) { exprDepth.pop(); mode = 'tpl'; break; }
            exprDepth[exprDepth.length - 1]!--;
          }
        }
        const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
        // After '.' (or '?.') a keyword is just a property name: `a.return / 2` is a division.
        if (word) { lastSig = lastSig === '.' ? 'ident' : word[0]; i += word[0].length - 1; break; }
        const num = /^\d[\w.]*/.exec(text.slice(i));
        if (num) { lastSig = 'num'; i += num[0].length - 1; break; }
        lastSig = c;
        break;
      }
    }
  }
  codeAtEnd.push(mode === 'line' ? exprDepth.length === 0 : topLevel());
  // Every physical line must have exactly one start and one end entry; any mismatch means the lexer lost track.
  const lines = text.split('\n').length;
  const ok = (mode === 'code' || mode === 'line') && exprDepth.length === 0 && parens.length === 0 && codeAtStart.length === lines && codeAtEnd.length === lines;
  return { ok, codeAtStart, codeAtEnd };
}

const PROBE = fileURLToPath(new URL('./syntax-probe-child.ts', import.meta.url));

/**
 * V8's own reading of line boundaries (boundary k lies between line k-1 and line k): code[j] is true iff boundaries[j]
 * is executable code. Runs src/syntax-probe-child.ts, which only compiles the source (never evaluates it), under Node's
 * permission model with read access to the probe alone and an empty environment. Any failure is reported as not ok.
 */
export function v8CodeAtBoundaries(source: string, ts: boolean, boundaries: number[]): { ok: true; code: boolean[] } | { ok: false; why: string } {
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${PROBE}`, '--experimental-vm-modules', '--disable-warning=ExperimentalWarning', PROBE], {
    input: JSON.stringify({ source, ts, boundaries }), encoding: 'utf8', env: {}, timeout: 30_000, maxBuffer: 1 << 20,
  });
  if (r.error || r.status !== 0) return { ok: false, why: `syntax probe failed (${r.error?.message ?? `exit ${r.status}`})` };
  let v: unknown;
  try { v = JSON.parse(r.stdout); } catch { return { ok: false, why: 'syntax probe returned invalid output' }; }
  if (!v || typeof v !== 'object') return { ok: false, why: 'syntax probe returned invalid output' };
  const o = v as { ok?: unknown; why?: unknown; code?: unknown };
  if (o.ok !== true) return { ok: false, why: typeof o.why === 'string' ? o.why : 'syntax probe refused the file' };
  if (!Array.isArray(o.code) || o.code.length !== boundaries.length || !o.code.every((x) => typeof x === 'boolean')) return { ok: false, why: 'syntax probe returned invalid output' };
  return { ok: true, code: o.code as boolean[] };
}
