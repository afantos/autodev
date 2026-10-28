import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';

/** No network or migrations. Check that this exact systemd process acquired the lock and logged its startup. */
export function checkStartup(path: string, pid: number, since: number, now = Date.now()): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(since) || since <= 0) throw new Error('invalid health-check arguments');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const lock = db.prepare("SELECT v, updated_at FROM kv WHERE k = 'instance_lock'").get() as { v: string; updated_at: number } | undefined;
    if (!lock || lock.v.split(':')[1] !== String(pid) || lock.updated_at < since || now - lock.updated_at > 10_000) throw new Error('missing or stale process instance lock');
    const event = db.prepare("SELECT 1 FROM events WHERE type = 'orchestrator.start' AND ts >= ? AND message LIKE ? LIMIT 1").get(since, `owner=${lock.v} %`);
    if (!event) throw new Error('fresh startup event for this process missing');
  } finally { db.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) checkStartup(process.argv[2], Number(process.argv[3]), Number(process.argv[4]));
