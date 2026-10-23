import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunner, AgentRunResult, AgentRunSpec } from './runner.ts';

export type FakeBehavior = (spec: AgentRunSpec, call: number) => Promise<Partial<AgentRunResult>>;

const base = (): AgentRunResult => ({ ok: true, structured: null, text: '', sessionId: 'fake-session', costUsd: 0.01, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, durationMs: 5, numTurns: 1, usageComplete: true });

/**
 * Deterministic stand-in for Claude used by tests and `runner: fake` simulations. No AI spend.
 * Default behavior: the coding agent appends a line to CHANGES.md (the orchestrator commits it); reviewers approve;
 * decisions resolve as an internal_structure choice.
 */
export class FakeRunner implements AgentRunner {
  calls: AgentRunSpec[] = [];
  behaviors: Partial<Record<AgentRunSpec['role'], FakeBehavior>>;
  constructor(behaviors: Partial<Record<AgentRunSpec['role'], FakeBehavior>> = {}) { this.behaviors = behaviors; }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    this.calls.push(spec);
    const n = this.calls.filter((c) => c.role === spec.role).length;
    const b = this.behaviors[spec.role] ?? DEFAULTS[spec.role];
    return { ...base(), ...(b ? await b(spec, n) : {}) };
  }
}

export const DEFAULTS: Partial<Record<AgentRunSpec['role'], FakeBehavior>> = {
  coding: async (spec) => {
    const m = spec.prompt.match(/# ([A-Z0-9]+-\d+): (.*)/);
    appendFileSync(join(spec.cwd, 'CHANGES.md'), `- ${m?.[1] ?? 'ticket'}: ${m?.[2] ?? 'change'}\n`);
    return { structured: { status: 'completed', summary: `Implemented ${m?.[2] ?? 'ticket'} (fake)`, filesChanged: ['CHANGES.md'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
  },
  review: async () => ({ structured: { outcome: 'approved', summary: 'Looks good (fake review).', acceptanceCriteria: [], findings: [], followUps: [] } }),
  decision: async () => ({ structured: { category: 'internal_structure', options: [{ name: 'A', pros: [], cons: [] }], recommendation: 'Use option A, matching existing patterns', reasoning: 'Consistent with existing modules.', evidence: ['src/'], confidence: 0.9, requiresHuman: false, significantArchitecture: false } }),
  classify: async (spec) => ({ structured: { projectKey: (spec.prompt.match(/^- ([a-z0-9-]+):/m)?.[1]) ?? 'unknown', confidence: 0.9 } }),
};
