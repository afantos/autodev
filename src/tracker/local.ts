import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { NewTicket, Priority, Status, Ticket, TicketComment } from '../types.ts';
import type { Tracker } from './types.ts';

interface Row {
  id: string; identifier: string; project: string; title: string; description: string; status: string;
  priority: number; estimate: number | null; labels_json: string; blocked_by_json: string; parent_id: string | null;
  comments_json: string; links_json: string; created_at: string; updated_at: string;
}

/** SQLite-backed stand-in for Linear, used for simulation and tests. */
export class LocalTracker implements Tracker {
  db: Db;
  constructor(db: Db) { this.db = db; }

  private toTicket(r: Row, all: Row[]): Ticket {
    const blockedBy = JSON.parse(r.blocked_by_json) as string[];
    const blocks = all.filter((x) => (JSON.parse(x.blocked_by_json) as string[]).includes(r.id)).map((x) => x.id);
    return {
      id: r.id, identifier: r.identifier, title: r.title, description: r.description, status: r.status as Status,
      priority: r.priority as Priority, estimate: r.estimate, labels: JSON.parse(r.labels_json), projectKey: r.project,
      blockedBy, blocks, parentId: r.parent_id, url: `local://ticket/${r.identifier}`, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
  private rows(): Row[] { return this.db.prepare('SELECT * FROM local_tickets ORDER BY created_at').all() as unknown as Row[]; }
  private row(id: string): Row | undefined { return this.db.prepare('SELECT * FROM local_tickets WHERE id = ? OR identifier = ?').get(id, id) as unknown as Row | undefined; }
  private touch(id: string, col: string, val: unknown) {
    this.db.prepare(`UPDATE local_tickets SET ${col} = ?, updated_at = ? WHERE id = ?`).run(val as never, new Date().toISOString(), id);
  }

  async listTickets(filter: { statuses?: Status[]; projectKey?: string } = {}) {
    const all = this.rows();
    return all.map((r) => this.toTicket(r, all))
      .filter((t) => (!filter.statuses || filter.statuses.includes(t.status)) && (!filter.projectKey || t.projectKey === filter.projectKey));
  }
  async getTicket(id: string) {
    const r = this.row(id);
    return r ? this.toTicket(r, this.rows()) : null;
  }
  async setStatus(id: string, status: Status) { const r = this.must(id); this.touch(r.id, 'status', status); }
  async comment(id: string, body: string) {
    const r = this.must(id);
    const c = JSON.parse(r.comments_json) as TicketComment[];
    c.push({ id: randomUUID(), body, byAutomation: true, createdAt: new Date().toISOString() });
    this.touch(r.id, 'comments_json', JSON.stringify(c));
  }
  /** Simulates a human comment (tests / CLI). */
  humanComment(id: string, body: string) {
    const r = this.must(id);
    const c = JSON.parse(r.comments_json) as TicketComment[];
    c.push({ id: randomUUID(), body, byAutomation: false, createdAt: new Date(Date.now() + 1).toISOString() });
    this.touch(r.id, 'comments_json', JSON.stringify(c));
  }
  async listComments(id: string) { return JSON.parse(this.must(id).comments_json) as TicketComment[]; }
  async createTicket(t: NewTicket) {
    const id = randomUUID();
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM local_tickets WHERE project = ?').get(t.projectKey) as { n: number }).n + 1;
    const identifier = `${t.projectKey.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)}-${n}`;
    const ts = new Date().toISOString();
    this.db.prepare(`INSERT INTO local_tickets (id, identifier, project, title, description, status, priority, estimate, labels_json, parent_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, identifier, t.projectKey, t.title, t.description, t.status, t.priority, t.estimate ?? null, JSON.stringify(t.labels ?? []), t.parentId ?? null, ts, ts);
    return (await this.getTicket(id))!;
  }
  async addBlockedBy(id: string, blockerId: string) {
    const r = this.must(id);
    const b = new Set(JSON.parse(r.blocked_by_json) as string[]);
    b.add(this.must(blockerId).id);
    this.touch(r.id, 'blocked_by_json', JSON.stringify([...b]));
  }
  async attachLink(id: string, url: string, title: string) {
    const r = this.must(id);
    const l = JSON.parse(r.links_json) as { url: string; title: string }[];
    if (!l.some((x) => x.url === url)) l.push({ url, title });
    this.touch(r.id, 'links_json', JSON.stringify(l));
  }
  async addLabel(id: string, label: string) {
    const r = this.must(id);
    const l = new Set(JSON.parse(r.labels_json) as string[]);
    l.add(label);
    this.touch(r.id, 'labels_json', JSON.stringify([...l]));
  }
  private must(id: string): Row {
    const r = this.row(id);
    if (!r) throw new Error(`ticket ${id} not found`);
    return r;
  }
}
