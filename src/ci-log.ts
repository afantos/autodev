/**
 * Turn a raw GitHub Actions job log into the excerpt the coding agent sees after a CI failure.
 *
 * A plain tail of the log is often useless: integration jobs end with `docker compose logs` output (one prefixed line
 * per service log line), which pushes the test runner's own failure report out of the tail. Instead:
 *  1. strip GitHub's timestamps, ANSI escapes and the byte-order mark, and drop Compose service lines (`<svc>-N  | …`)
 *     and `##[group]`/`##[endgroup]` markers;
 *  2. if node:test's "failing tests:" summary is present, take it (with what follows, which carries each failure's
 *     location, assertion and stack);
 *  3. otherwise take a window after each failure marker (✖, `not ok`, AssertionError, `Error:`, `npm ERR!`,
 *     `##[error]`), merged where they overlap;
 *  4. without any marker, fall back to a bounded tail of the cleaned log.
 * The result never exceeds `max` characters.
 */

const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\^\[\[[0-9;]*m/g;
const COMPOSE = /^[A-Za-z0-9][\w.-]*-\d+\s+\|/;
const NOISE = /^##\[(?:group|endgroup)\]/;
const MARKER = /(?:^|\s)(?:✖|not ok\b)|AssertionError|\bError:|npm ERR!|^##\[error\]|failing tests:|^\s*test at /;

export function cleanCiLog(raw: string): string[] {
  const out: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(TIMESTAMP, '').replace(ANSI, '').replace(/\s+$/, '');
    if (!line || COMPOSE.test(line) || NOISE.test(line)) continue;
    out.push(line);
  }
  return collapseRepeats(out);
}

/**
 * Collapse runs of repeated lines and repeated multi-line blocks (node:test prints the same hook error once per test
 * in the file) into one copy plus a "(repeated N×)" note, so one cause cannot crowd every other line out of the budget.
 */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let best = 1; let bestCount = 1;
    for (let size = 1; size <= 12 && i + size * 2 <= lines.length; size++) {
      let count = 1;
      while (i + size * (count + 1) <= lines.length && sameBlock(lines, i, i + size * count, size)) count++;
      if (count > 1 && count * size > bestCount * best) { best = size; bestCount = count; }
    }
    for (let k = 0; k < best; k++) out.push(lines[i + k]!);
    if (bestCount > 1) out.push(`… (the ${best === 1 ? 'line' : `${best} lines`} above repeated ${bestCount}×)`);
    i += best * bestCount;
  }
  return out;
}

function sameBlock(lines: string[], a: number, b: number, size: number): boolean {
  for (let k = 0; k < size; k++) if (normalize(lines[a + k]!) !== normalize(lines[b + k]!)) return false;
  return true;
}
/** Near-identical: ignore durations and pids that differ between repeats. */
const normalize = (l: string) => l.replace(/\(\d+(?:\.\d+)?ms\)/g, '(…ms)').replace(/\[\d+\]/g, '[…]');

export function excerptCiLog(raw: string, max = 5000, window = 25): string {
  const lines = cleanCiLog(raw);
  const clip = (s: string) => (s.length > max ? s.slice(0, max - 20) + '\n… (truncated)' : s);
  const summary = lines.findIndex((l) => /^\s*✖ failing tests:/.test(l) || /^\s*failing tests:/.test(l));
  if (summary >= 0) {
    // The summary lists every failure with its location and error; keep the earlier per-test diagnostics too when
    // they fit, since hook errors ("generated asynchronous activity after the test ended") are reported above it.
    // The summary ends where the step fails (##[error]) or GitHub's post-job steps begin; what follows is runner noise.
    const stop = lines.findIndex((l, i) => i > summary && (/^##\[error\]/.test(l) || /^Post job cleanup\./.test(l)));
    const tailPart = lines.slice(summary, stop < 0 ? undefined : stop + (/^##\[error\]/.test(lines[stop] ?? '') ? 1 : 0)).join('\n');
    // Fill the remaining budget with the marker windows nearest the summary (walking backwards), so the cause that
    // node:test printed just above it survives even when everything earlier does not fit.
    const windows = markedWindows(lines.slice(0, summary), window);
    const kept: string[] = [];
    let used = tailPart.length;
    for (let k = windows.length - 1; k >= 0; k--) {
      const w = windows[k]!;
      const cost = w.length + 3;
      if (used + cost > max) {
        const room = max - used - 30;
        if (room > 200 && !kept.length) kept.unshift('… ' + w.slice(w.length - room)); // at least the nearest window, trimmed from its start
        break;
      }
      kept.unshift(w); used += cost;
    }
    return clip(kept.length ? `${kept.join('\n…\n')}\n…\n${tailPart}` : tailPart);
  }
  const windows = markedWindows(lines, window);
  if (windows.length) return clip(windows.join('\n…\n'));
  const tail = lines.join('\n');
  return tail.length > max ? '… (start omitted)\n' + tail.slice(tail.length - max + 20) : tail;
}

function markedWindows(lines: string[], window: number): string[] {
  const ranges: Array<[number, number]> = [];
  lines.forEach((l, i) => {
    if (!MARKER.test(l)) return;
    const start = Math.max(0, i - 2); const end = Math.min(lines.length, i + window);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else ranges.push([start, end]);
  });
  return ranges.map(([a, b]) => lines.slice(a, b).join('\n'));
}
