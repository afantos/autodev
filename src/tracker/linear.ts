import type { Config, ProjectConfig } from '../config.ts';
import type { NewTicket, Priority, Status, Ticket, TicketComment } from '../types.ts';
import { STATUSES } from '../types.ts';
import type { Tracker } from './types.ts';

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `
  id identifier title description priority estimate url createdAt updatedAt
  state { id name }
  team { id key }
  project { id name }
  parent { id }
  labels { nodes { id name } }
  relations { nodes { type relatedIssue { id } } }
  inverseRelations { nodes { type issue { id } } }
`;

interface RawIssue {
  id: string; identifier: string; title: string; description: string | null; priority: number; estimate: number | null; url: string;
  createdAt: string; updatedAt: string; state: { id: string; name: string }; team: { id: string; key: string };
  project: { id: string; name: string } | null; parent: { id: string } | null; labels: { nodes: { id: string; name: string }[] };
  relations: { nodes: { type: string; relatedIssue: { id: string } }[] };
  inverseRelations: { nodes: { type: string; issue: { id: string } }[] };
}

/**
 * Linear via GraphQL with a personal API key (polling, no inbound webhooks).
 * Workflow state names are mapped through config.linear.states.
 */
export class LinearTracker implements Tracker {
  private cfg: Config;
  private apiKey: string;
  private teamIds = new Map<string, string>();          // teamKey -> id
  private states = new Map<string, Map<Status, string>>(); // teamId -> status -> stateId
  private stateNames = new Map<string, Status>();        // lowercased name -> status
  private labelIds = new Map<string, string>();          // teamId:name -> id
  private projectIds = new Map<string, string>();        // name -> id
  private viewerId: string | null = null;

  constructor(cfg: Config, apiKey: string) {
    this.cfg = cfg;
    this.apiKey = apiKey;
    for (const s of STATUSES) this.stateNames.set(cfg.linear.states[s].toLowerCase(), s);
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) throw new RetryableError(`Linear HTTP ${res.status}`);
        const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
        if (body.errors?.length) {
          const msg = body.errors.map((e) => e.message).join('; ');
          if (body.errors.some((e) => e.extensions?.code === 'RATELIMITED')) throw new RetryableError(msg);
          throw new Error(`Linear: ${msg}`);
        }
        return body.data as T;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RetryableError) && !(e instanceof TypeError) && (e as Error).name !== 'TimeoutError') throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  async viewer(): Promise<string> {
    if (!this.viewerId) this.viewerId = (await this.gql<{ viewer: { id: string } }>('{ viewer { id } }')).viewer.id;
    return this.viewerId;
  }

  async teamId(key: string): Promise<string> {
    if (!this.teamIds.has(key)) {
      const d = await this.gql<{ teams: { nodes: { id: string; key: string }[] } }>('query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes { id key } } }', { k: key });
      if (!d.teams.nodes[0]) throw new Error(`Linear team ${key} not found`);
      this.teamIds.set(key, d.teams.nodes[0].id);
    }
    return this.teamIds.get(key)!;
  }

  /** Workflow states for a team, mapped to internal statuses. Missing states are reported by `checkSetup`. */
  async teamStates(teamId: string): Promise<Map<Status, string>> {
    if (!this.states.has(teamId)) {
      const d = await this.gql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
        'query($t:ID!){ workflowStates(filter:{team:{id:{eq:$t}}}, first: 100){ nodes { id name } } }', { t: teamId });
      const m = new Map<Status, string>();
      for (const n of d.workflowStates.nodes) {
        const s = this.stateNames.get(n.name.toLowerCase());
        if (s) m.set(s, n.id);
      }
      this.states.set(teamId, m);
    }
    return this.states.get(teamId)!;
  }

  /** Lists missing workflow states per team (used by `autodev linear-check`). */
  async checkSetup(): Promise<{ team: string; missing: string[] }[]> {
    const out: { team: string; missing: string[] }[] = [];
    for (const key of new Set(this.cfg.projects.map((p) => p.linear?.teamKey).filter(Boolean) as string[])) {
      const m = await this.teamStates(await this.teamId(key));
      out.push({ team: key, missing: STATUSES.filter((s) => !m.has(s)).map((s) => this.cfg.linear.states[s]) });
    }
    return out;
  }

  /** Create missing workflow states (only when the user runs `autodev linear-setup --apply`). */
  async createMissingStates(): Promise<string[]> {
    const created: string[] = [];
    const typeFor: Record<Status, string> = { ideas: 'backlog', backlog: 'backlog', ready: 'unstarted', in_progress: 'started', review: 'started', blocked: 'started', done: 'completed', failed: 'canceled', canceled: 'canceled' };
    const colors: Record<Status, string> = { ideas: '#bec2c8', backlog: '#bec2c8', ready: '#e2e2e2', in_progress: '#f2c94c', review: '#5e6ad2', blocked: '#eb5757', done: '#5e6ad2', failed: '#95a2b3', canceled: '#95a2b3' };
    for (const key of new Set(this.cfg.projects.map((p) => p.linear?.teamKey).filter(Boolean) as string[])) {
      const teamId = await this.teamId(key);
      const m = await this.teamStates(teamId);
      for (const s of STATUSES) {
        if (m.has(s)) continue;
        const name = this.cfg.linear.states[s];
        await this.gql('mutation($i:WorkflowStateCreateInput!){ workflowStateCreate(input:$i){ success } }', { i: { teamId, name, type: typeFor[s], color: colors[s] } });
        created.push(`${key}: ${name}`);
      }
      this.states.delete(teamId);
    }
    return created;
  }

  private projectOf(issue: RawIssue): ProjectConfig | null {
    const candidates = this.cfg.projects.filter((p) => p.linear?.teamKey === issue.team.key);
    for (const p of candidates) {
      if (p.linear?.projectName && issue.project?.name === p.linear.projectName) return p;
      if (issue.labels.nodes.some((l) => l.name === `project:${p.key}`)) return p;
    }
    const unscoped = candidates.filter((p) => !p.linear?.projectName);
    return unscoped.length === 1 ? unscoped[0] : null;
  }

  private toTicket(i: RawIssue): Ticket {
    return {
      id: i.id, identifier: i.identifier, title: i.title, description: i.description ?? '',
      status: this.stateNames.get(i.state.name.toLowerCase()) ?? 'backlog',
      priority: (i.priority ?? 0) as Priority, estimate: i.estimate ?? null,
      labels: i.labels.nodes.map((l) => l.name), projectKey: this.projectOf(i)?.key ?? null,
      blockedBy: i.inverseRelations.nodes.filter((r) => r.type === 'blocks').map((r) => r.issue.id),
      blocks: i.relations.nodes.filter((r) => r.type === 'blocks').map((r) => r.relatedIssue.id),
      parentId: i.parent?.id ?? null, url: i.url, createdAt: i.createdAt, updatedAt: i.updatedAt,
    };
  }

  async listTickets(filter: { statuses?: Status[]; projectKey?: string } = {}): Promise<Ticket[]> {
    const teams = new Set(this.cfg.projects.filter((p) => !filter.projectKey || p.key === filter.projectKey).map((p) => p.linear?.teamKey).filter(Boolean) as string[]);
    const out: Ticket[] = [];
    for (const key of teams) {
      const stateNames = filter.statuses?.map((s) => this.cfg.linear.states[s]);
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const d: { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await this.gql(
          // Linear rejects declared-but-unused variables, so $s is declared only when the state filter uses it.
          `query($k:String!${stateNames ? ', $s:[String!]' : ''}, $after:String){ issues(first: 100, after: $after, filter:{ team:{ key:{ eq:$k } }${stateNames ? ', state:{ name:{ in:$s } }' : ''} }){
             nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
          stateNames ? { k: key, s: stateNames, after } : { k: key, after });
        for (const i of d.issues.nodes) {
          const t = this.toTicket(i);
          if (!t.projectKey) continue;
          if (filter.projectKey && t.projectKey !== filter.projectKey) continue;
          if (this.cfg.linear.requireLabel && !t.labels.includes(this.cfg.linear.requireLabel)) continue;
          out.push(t);
        }
        if (!d.issues.pageInfo.hasNextPage) break;
        after = d.issues.pageInfo.endCursor;
      }
    }
    return out;
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const d = await this.gql<{ issue: RawIssue | null }>(`query($id:String!){ issue(id:$id){ ${ISSUE_FIELDS} } }`, { id });
    return d.issue ? this.toTicket(d.issue) : null;
  }

  private async rawTeamOf(id: string): Promise<string> {
    const d = await this.gql<{ issue: { team: { id: string } } }>('query($id:String!){ issue(id:$id){ team { id } } }', { id });
    return d.issue.team.id;
  }

  async setStatus(id: string, status: Status): Promise<void> {
    const teamId = await this.rawTeamOf(id);
    const stateId = (await this.teamStates(teamId)).get(status);
    if (!stateId) throw new Error(`Linear team has no workflow state named "${this.cfg.linear.states[status]}" (run autodev linear-check)`);
    await this.gql('mutation($id:String!, $s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }', { id, s: stateId });
  }

  async comment(id: string, body: string): Promise<void> {
    // The marker lets us tell our comments apart from a human using the same API key's account.
    await this.gql('mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }', { i: { issueId: id, body: `${body}\n\n<!-- autodev -->` } });
  }

  async listComments(id: string): Promise<TicketComment[]> {
    const me = await this.viewer();
    const d = await this.gql<{ issue: { comments: { nodes: { id: string; body: string; createdAt: string; user: { id: string } | null }[] } } }>(
      'query($id:String!){ issue(id:$id){ comments(first: 100){ nodes { id body createdAt user { id } } } } }', { id });
    return d.issue.comments.nodes
      .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, byAutomation: c.user?.id === me && c.body.includes('<!-- autodev -->') }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async labelId(teamId: string, name: string): Promise<string> {
    const k = `${teamId}:${name}`;
    if (!this.labelIds.has(k)) {
      const d = await this.gql<{ issueLabels: { nodes: { id: string }[] } }>(
        'query($n:String!){ issueLabels(filter:{ name:{ eq:$n } }){ nodes { id } } }', { n: name });
      let id = d.issueLabels.nodes[0]?.id;
      if (!id) {
        const c = await this.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
          'mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel { id } } }', { i: { name, teamId } });
        id = c.issueLabelCreate.issueLabel.id;
      }
      this.labelIds.set(k, id);
    }
    return this.labelIds.get(k)!;
  }

  private async projectId(name: string): Promise<string | undefined> {
    if (!this.projectIds.has(name)) {
      const d = await this.gql<{ projects: { nodes: { id: string }[] } }>('query($n:String!){ projects(filter:{ name:{ eq:$n } }){ nodes { id } } }', { n: name });
      if (d.projects.nodes[0]) this.projectIds.set(name, d.projects.nodes[0].id);
    }
    return this.projectIds.get(name);
  }

  async createTicket(t: NewTicket): Promise<Ticket> {
    const p = this.cfg.projects.find((x) => x.key === t.projectKey);
    if (!p?.linear) throw new Error(`project ${t.projectKey} has no linear config`);
    const teamId = await this.teamId(p.linear.teamKey);
    const stateId = (await this.teamStates(teamId)).get(t.status);
    const labels = [...(t.labels ?? [])];
    if (!p.linear.projectName && this.cfg.projects.filter((x) => x.linear?.teamKey === p.linear!.teamKey).length > 1) labels.push(`project:${p.key}`);
    if (this.cfg.linear.requireLabel) labels.push(this.cfg.linear.requireLabel);
    const labelIds = await Promise.all([...new Set(labels)].map((l) => this.labelId(teamId, l)));
    const input: Record<string, unknown> = { teamId, title: t.title, description: t.description, priority: t.priority, labelIds };
    if (stateId) input.stateId = stateId;
    if (t.estimate) input.estimate = t.estimate;
    if (t.parentId) input.parentId = t.parentId;
    if (p.linear.projectName) input.projectId = await this.projectId(p.linear.projectName);
    const d = await this.gql<{ issueCreate: { issue: RawIssue } }>(`mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue { ${ISSUE_FIELDS} } } }`, { i: input });
    return this.toTicket(d.issueCreate.issue);
  }

  async addBlockedBy(id: string, blockerId: string): Promise<void> {
    await this.gql('mutation($i:IssueRelationCreateInput!){ issueRelationCreate(input:$i){ success } }', { i: { issueId: blockerId, relatedIssueId: id, type: 'blocks' } });
  }

  async attachLink(id: string, url: string, title: string): Promise<void> {
    await this.gql('mutation($id:String!, $u:String!, $t:String){ attachmentLinkURL(issueId:$id, url:$u, title:$t){ success } }', { id, u: url, t: title });
  }

  async addLabel(id: string, label: string): Promise<void> {
    const d = await this.gql<{ issue: { team: { id: string }; labels: { nodes: { id: string }[] } } }>(
      'query($id:String!){ issue(id:$id){ team { id } labels { nodes { id } } } }', { id });
    const lid = await this.labelId(d.issue.team.id, label);
    const ids = new Set(d.issue.labels.nodes.map((l) => l.id));
    if (ids.has(lid)) return;
    ids.add(lid);
    await this.gql('mutation($id:String!, $l:[String!]){ issueUpdate(id:$id, input:{ labelIds:$l }){ success } }', { id, l: [...ids] });
  }
}

class RetryableError extends Error {}
