import type { NewTicket, Status, Ticket, TicketComment } from '../types.ts';

export const LABEL_SUGGESTED = 'autodev-suggested';
export const LABEL_PLAN = 'autodev-plan';
export const LABEL_MANAGED = 'autodev';

export interface Tracker {
  /** Tickets for configured projects, optionally filtered by status. */
  listTickets(filter?: { statuses?: Status[]; projectKey?: string }): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | null>;
  setStatus(id: string, status: Status): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  listComments(id: string): Promise<TicketComment[]>;
  createTicket(t: NewTicket): Promise<Ticket>;
  addBlockedBy(id: string, blockerId: string): Promise<void>;
  attachLink(id: string, url: string, title: string): Promise<void>;
  addLabel(id: string, label: string): Promise<void>;
}
