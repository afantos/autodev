import { excerptCiLog } from '../ci-log.ts';
import { Octokit } from '@octokit/rest';
import type { CheckFailure, CheckResult, PullRequest } from '../types.ts';
import type { Scm } from './types.ts';

function split(repo: string) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`repo must be owner/name, got ${repo}`);
  return { owner, repo: name };
}

/**
 * GitHub via a least-privilege bot token (fine-grained PAT of a machine user, or an App installation token):
 * contents rw, pull requests rw, actions rw (to re-run failed jobs), checks/statuses/deployments read. No admin, no bypass.
 */
export class GitHubScm implements Scm {
  private gh: Octokit;
  private token: string;
  /** Separate reviewer account (approvals only). Branch protection rejects approvals from the last pusher. */
  private reviewer: Octokit | null;
  constructor(token: string, reviewerToken?: string) {
    this.token = token;
    this.gh = new Octokit({ auth: token, userAgent: 'autodev', request: { timeout: 30_000 } });
    this.reviewer = reviewerToken ? new Octokit({ auth: reviewerToken, userAgent: 'autodev-reviewer', request: { timeout: 30_000 } }) : null;
  }

  async branchSha(repo: string, branch: string) {
    return (await this.gh.repos.getBranch({ ...split(repo), branch })).data.commit.sha;
  }

  async markReady(_repo: string, pr: PullRequest) {
    if (!pr.draft) return;
    const { repository } = await this.gh.graphql<{ repository: { pullRequest: { id: string } } }>(
      'query($o:String!,$n:String!,$num:Int!){ repository(owner:$o, name:$n){ pullRequest(number:$num){ id } } }',
      { o: split(_repo).owner, n: split(_repo).repo, num: pr.number });
    await this.gh.graphql('mutation($id:ID!){ markPullRequestReadyForReview(input:{ pullRequestId:$id }){ clientMutationId } }', { id: repository.pullRequest.id });
  }

  async approve(repo: string, number: number, sha: string, body: string) {
    if (!this.reviewer) throw new Error('no reviewer account configured (GITHUB_REVIEWER_TOKEN)');
    await this.reviewer.pulls.createReview({ ...split(repo), pull_number: number, commit_id: sha, event: 'APPROVE', body });
  }

  async mergePr(repo: string, number: number, sha: string, title: string) {
    await this.gh.pulls.merge({ ...split(repo), pull_number: number, sha, merge_method: 'squash', commit_title: title });
  }

  cloneUrl(repo: string) { return `https://github.com/${repo}.git`; }

  gitAuthArgs() {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    return ['-c', 'credential.helper=', '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  async defaultBranch(repo: string) {
    return (await this.gh.repos.get(split(repo))).data.default_branch;
  }

  private toPr(p: { number: number; html_url: string; head: { ref: string; sha: string }; base: { ref: string }; state: string; merged_at?: string | null; draft?: boolean; mergeable?: boolean | null; mergeable_state?: string }): PullRequest {
    // pulls.get reports mergeability (null while GitHub computes it); pulls.list does not.
    const mergeable = p.mergeable === false || p.mergeable_state === 'dirty' ? 'conflicting' : p.mergeable === true ? 'mergeable' : 'unknown';
    return { number: p.number, url: p.html_url, headBranch: p.head.ref, baseBranch: p.base.ref, headSha: p.head.sha, state: p.merged_at ? 'merged' : (p.state as 'open' | 'closed'), draft: !!p.draft, mergeable };
  }

  async findPr(repo: string, head: string) {
    const r = split(repo);
    const { data } = await this.gh.pulls.list({ ...r, head: `${r.owner}:${head}`, state: 'all', per_page: 10 });
    const open = data.find((p) => p.state === 'open') ?? data[0];
    return open ? this.toPr(open) : null;
  }

  async getPr(repo: string, number: number) {
    return this.toPr((await this.gh.pulls.get({ ...split(repo), pull_number: number })).data);
  }

  async createPr(repo: string, pr: { head: string; base: string; title: string; body: string; draft: boolean }) {
    const { data } = await this.gh.pulls.create({ ...split(repo), ...pr });
    return this.toPr(data);
  }

  async updatePr(repo: string, number: number, patch: { title?: string; body?: string; base?: string }) {
    await this.gh.pulls.update({ ...split(repo), pull_number: number, ...patch });
  }

  async checks(repo: string, pr: PullRequest, required: string[]): Promise<CheckResult> {
    const r = split(repo);
    const runs = await this.gh.paginate(this.gh.checks.listForRef, { ...r, ref: pr.headSha, per_page: 100 });
    const statuses = (await this.gh.repos.getCombinedStatusForRef({ ...r, ref: pr.headSha })).data.statuses;
    type C = { name: string; state: 'pending' | 'success' | 'failure'; summary: string; url?: string; jobId?: number; completedAt?: number };
    const all: C[] = [
      ...runs.map((c) => ({
        name: c.name,
        state: (c.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(c.conclusion ?? '') ? 'success' : 'failure') as C['state'],
        summary: `${c.conclusion ?? c.status}${c.output?.title ? `: ${c.output.title}` : ''}${c.output?.summary ? `\n${c.output.summary.slice(0, 800)}` : ''}`,
        url: c.details_url ?? undefined,
        jobId: c.app?.slug === 'github-actions' ? c.id : undefined,
        completedAt: c.completed_at ? Date.parse(c.completed_at) : undefined,
      })),
      ...statuses.map((s) => ({ name: s.context, state: (s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure') as C['state'], summary: s.description ?? s.state, url: s.target_url ?? undefined, completedAt: s.updated_at ? Date.parse(s.updated_at) : undefined })),
    ];
    const relevant = required.length ? all.filter((c) => required.includes(c.name)) : all;
    if (required.length && required.some((n) => !all.some((c) => c.name === n))) {
      // A required check that hasn't been reported yet counts as pending.
      return { state: 'pending', failures: [], logExcerpt: '' };
    }
    if (!relevant.length) return { state: 'none', failures: [], logExcerpt: '' };
    const failing = relevant.filter((c) => c.state === 'failure');
    if (failing.length) {
      const failures: CheckFailure[] = failing.map((c) => ({ name: c.name, summary: c.summary, detailsUrl: c.url, ...(c.completedAt ? { completedAt: c.completedAt } : {}) }));
      let logs = '';
      for (const c of failing.slice(0, 3)) {
        if (!c.jobId) continue;
        try {
          const res = await this.gh.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { ...r, job_id: c.jobId });
          logs += `\n===== ${c.name} =====\n${excerptCiLog(String(res.data), 5000)}`;
        } catch { /* logs may be unavailable; summary still helps */ }
      }
      return { state: 'failure', failures, logExcerpt: logs };
    }
    if (relevant.some((c) => c.state === 'pending')) return { state: 'pending', failures: [], logExcerpt: '' };
    return { state: 'success', failures: [], logExcerpt: '' };
  }

  /** Interval between checks that GitHub registered a re-run (10 checks at most). */
  rerunPollMs = 3000;

  async rerunFailedJobs(repo: string, pr: PullRequest) {
    const r = split(repo);
    const { data } = await this.gh.actions.listWorkflowRunsForRepo({ ...r, head_sha: pr.headSha, per_page: 50 });
    const failed = data.workflow_runs.filter((w) => w.status === 'completed' && ['failure', 'timed_out'].includes(w.conclusion ?? ''));
    if (!failed.length) throw new Error(`no failed workflow run for ${pr.headSha.slice(0, 8)}`);
    for (const w of failed) await this.gh.actions.reRunWorkflowFailedJobs({ ...r, run_id: w.id });
    // Until GitHub registers the new attempt, the check runs still read as the old failure, and the next poll would take
    // it for the re-run's result. Confirm each run started a new attempt; otherwise throw, so the caller does not count
    // this as a re-run.
    for (const w of failed) {
      let registered = false;
      for (let i = 0; i < 10 && !registered; i++) {
        if (i) await new Promise((res) => setTimeout(res, this.rerunPollMs));
        const run = (await this.gh.actions.getWorkflowRun({ ...r, run_id: w.id })).data;
        registered = (run.run_attempt ?? 0) > (w.run_attempt ?? 0) || run.status !== 'completed';
      }
      if (!registered) throw new Error(`GitHub did not register the re-run of workflow run ${w.id} (attempt ${w.run_attempt ?? '?'})`);
    }
  }

  async previewUrl(repo: string, pr: PullRequest): Promise<string | null> {
    const r = split(repo);
    const { data: deps } = await this.gh.repos.listDeployments({ ...r, sha: pr.headSha, per_page: 10 });
    for (const d of deps) {
      if (/production/i.test(d.environment)) continue;
      const { data: sts } = await this.gh.repos.listDeploymentStatuses({ ...r, deployment_id: d.id, per_page: 5 });
      const ok = sts.find((s) => s.state === 'success' && (s.environment_url || s.target_url));
      if (ok) return ok.environment_url || ok.target_url || null;
    }
    return null;
  }
}
