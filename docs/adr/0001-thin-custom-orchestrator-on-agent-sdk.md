# 0001. Thin custom orchestrator on the Claude Agent SDK

- Status: Accepted
- Date: 2026-10-23

## Context

We need unattended Linear → Claude Code → GitHub PR automation across several repos, with
approval gates, a decision policy, budgets, dependency-aware scheduling, leases and crash recovery.

## Options considered

1. **Cyrus**, a Linear agent runner for Claude Code. Its docs establish issue → worktree → PR automation. The original comparison asserted missing policy, budgets, scheduling, leases and independent review without inspecting its source; those negative claims are withdrawn. A source-level comparison is needed before deciding that extending Cyrus cannot meet the requirements.
2. **Claude Code GitHub Action / cloud routines.** These are event-driven and per-PR, with no
   cross-ticket scheduling or shared state. They're useful as an extra CI reviewer, not as the
   orchestrator.
3. **Workflow engines** (Temporal, BullMQ). Durable, but they add infrastructure and operational
   load that two to four agents on one VM don't need.
4. **A thin custom orchestrator**: one Node process, SQLite, the Claude Agent SDK, Linear GraphQL
   and Octokit.

## Decision

Option 4. The SDK provides the hard parts: the agent loop, tools, sandbox, structured output,
budgets, sessions and rate-limit events. Linear and GitHub stay the user-facing systems. The custom
code is limited to what neither provides: policy, scheduling, leases and recovery, budgets, and
reporting.

## Consequences

- Around 3k lines of TypeScript to own, covered by end-to-end simulations against real git repos.
- Single-instance by design (an instance lock in SQLite). Running several VMs would need a shared DB.
- If further evaluation favors Linear's Agents API or Cyrus, the implementation can be replaced:
  the `Tracker`, `Scm` and `AgentRunner` seams isolate those integrations.
