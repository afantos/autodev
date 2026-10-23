import type { CheckResult, PullRequest } from '../types.ts';

export interface Scm {
  /** URL to clone from. */
  cloneUrl(repo: string): string;
  /** Extra `git -c` args that authenticate a single git command (never persisted to .git/config). */
  gitAuthArgs(): string[];
  defaultBranch(repo: string): Promise<string>;
  findPr(repo: string, head: string): Promise<PullRequest | null>;
  getPr(repo: string, number: number): Promise<PullRequest>;
  createPr(repo: string, pr: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequest>;
  updatePr(repo: string, number: number, patch: { title?: string; body?: string; base?: string }): Promise<void>;
  /** Aggregate CI state for the PR head commit. */
  checks(repo: string, pr: PullRequest, required: string[]): Promise<CheckResult>;
  /** Preview deployment URL for the PR head, if a preview platform reported one. */
  previewUrl(repo: string, pr: PullRequest): Promise<string | null>;
  /** True if `branch`'s tip is contained in `base` (i.e. merged). */
  branchMerged?(repo: string, branch: string, base: string): Promise<boolean>;
}
