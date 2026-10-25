// Child process for v8CodeAtBoundaries (test-updates.ts). Reads {source, ts, boundaries} as JSON on stdin and prints
// {ok, goal, code} where code[i] says whether boundary boundaries[i] (k = between line k-1 and line k) is executable
// code according to V8 itself. Untrusted source is only compiled (vm.SourceTextModule / vm.compileFunction parse it),
// never linked or evaluated, and the parent runs this with Node's permission model and no environment.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const out = (v: unknown) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const input = JSON.parse(readFileSync(0, 'utf8')) as { source: string; ts: boolean; boundaries: number[] };

let js = input.source;
if (input.ts) {
  try { js = stripTypeScriptTypes(input.source, { mode: 'strip' }); } catch { out({ ok: false, why: 'the TypeScript could not be type-stripped' }); }
}
const parses = (code: string, goal: 'module' | 'commonjs') => {
  try {
    if (goal === 'module') new vm.SourceTextModule(code);
    else vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname']);
    return true;
  } catch { return false; }
};
const goal = parses(js, 'module') ? 'module' : parses(js, 'commonjs') ? 'commonjs' : null;
if (!goal) out({ ok: false, why: 'the file is not valid JavaScript' });
const lines = js.split('\n');
if (lines.length !== input.source.split('\n').length) out({ ok: false, why: 'type stripping changed the line count' });

// A line holding only `#@!` is a syntax error anywhere in code, but plain text inside a template literal or a block
// comment (strings and regexes cannot span lines). So: inserted at a boundary, V8 rejects the file iff that boundary
// is code.
const SENTINEL = '#@!';
const code = input.boundaries.map((k) => !parses([...lines.slice(0, k), SENTINEL, ...lines.slice(k)].join('\n'), goal!));
out({ ok: true, goal, code });
