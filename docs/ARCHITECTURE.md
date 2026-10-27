# autodev — Architecture

autodev is a single persistent orchestrator process. It turns Linear tickets into reviewed,
CI-green draft pull requests by running Claude Code agents (through the Claude Agent SDK) in
isolated git worktrees. It also turns natural-language ideas into planned Linear tickets.

Linear is the board, GitHub is the code and CI system, and autodev owns only what those two
don't: job state, leases, the decision log, budgets, and agent execution.

## 1. Build-vs-reuse findings (researched 2026-10-23)

| Need | Option evaluated | Verdict |
|---|---|---|
| Run Claude Code unattended | `claude -p` CLI, **Claude Agent SDK (TS)** | **SDK**: typed results (`total_cost_usd`, `session_id`), `outputFormat` JSON schema, in-process MCP tools (used for `request_decision`), `maxBudgetUsd`, `maxTurns`, `sandbox`, `rate_limit_event`, and `resume`. |
| Linear ↔ Claude Code | **Cyrus** (open source, GPLv3, Linear agent runner with worktrees) | Good fit for "assign an issue and get a PR". Its docs establish issue-to-worktree automation. The earlier claims that it lacks specific safety and scheduling features were not verified against source. **Not adopted** for this prototype; a source-level comparison is needed before ruling out reuse. |
| Linear Agents API (`actor=app`, agent sessions) | OAuth app with webhooks | Needs a public webhook endpoint and an OAuth app. For a single-user system, a **personal API key with GraphQL polling** (60 s) is simpler and has no inbound attack surface. It can be upgraded later. |
| GitHub integration | Claude Code GitHub Action, Octokit | **Octokit** in the orchestrator, used for PRs, checks and deployments. The official `anthropics/claude-code-action` is offered as an *optional extra* PR reviewer in CI, but the in-orchestrator Review Agent is the required gate because it can see the ticket and decision log. |
| `feature-dev` plugin | `/feature-dev` command | The command **waits for the user** in 5 phases ("DO NOT START WITHOUT USER APPROVAL"), so it's unusable unattended. Its **subagents** (code-explorer, code-architect) are loaded for complexity ≥ 3 when `featureDevPluginPath` is set. |
| Previews | Vercel / Railway GitHub integrations | They already create per-PR previews. autodev only **discovers** preview URLs (GitHub Deployments API) and never creates infrastructure. |
| State store | Postgres, Redis, SQLite | **SQLite** (`node:sqlite`, built into Node 24). One process on one VM needs no server. |
| Queue / workflow engine | Temporal, BullMQ | Overkill for 2–4 concurrent agents. Durable stages and leases in SQLite cover it. |

## 2. Components (one process, plain modules)

```
                ┌──────────────────────── autodev (single Node process, systemd) ───────────────────────┐
 you ──CLI────▶ │ cli.ts ── plan / approve / answer / run / report / status                            │
 you ──phone──▶ │ dashboard.ts (read-only HTML, token auth, bind 127.0.0.1 → Tailscale)                │
                │                                                                                        │
                │ orchestrator.ts  tick loop (30 s)                                                      │
                │   ├─ reconcile.ts  Linear+GitHub truth → job table (merges, cancels, lost PRs)        │
                │   ├─ scheduler.ts  rank Ready tickets (priority, unblocks, deps, conflicts, cost)     │
                │   ├─ leases (db.ts) atomic claim, heartbeat, expiry recovery                          │
                │   └─ pipeline.ts   workspace → implement → validate → commit → push → PR → CI →       │
                │                    review → (fix loop) → Review                                        │
                │ agents/  planning · coding · decision · review   (Claude Agent SDK, per-role tools)    │
                │ policy.ts  decision authorization (can only escalate)                                  │
                │ budget.ts  daily/monthly/per-ticket USD + usage-limit pause                            │
                └───────┬───────────────────────┬──────────────────────────┬────────────────────────────┘
                        │ GraphQL (API key)     │ REST (bot token)         │ git (token per command)
                     Linear                   GitHub (PRs, checks, deploys) data/repos + data/worktrees
```

**Seams**: `Tracker` (Linear | Local), `Scm` (GitHub | Local), and `AgentRunner` (Claude | Fake).
The Local and Fake implementations exist so that the whole ticket-to-PR flow runs in tests
without network access or AI spend.

## 3. Ticket lifecycle

`Ideas → Backlog → Ready → In Progress → Review → Done`, plus `Blocked`, `Failed` and `Canceled`.

| Transition | Who |
|---|---|
| → Ideas/Backlog | Planning Agent (plan tickets) and Coding/Review agents (suggestions, label `autodev-suggested`) |
| Backlog → Ready | **Human only**: drag in Linear, move the `[Plan]` parent issue to Ready (approves all children), or run `autodev plan approve` |
| Ready → In Progress | orchestrator, after an atomic claim |
| In Progress → Review | orchestrator, only when validation, CI and AI review all pass and a draft PR exists |
| Review → Done | orchestrator, only after it **observes the PR merged** on GitHub |
| → Blocked | orchestrator, on a human-required decision, unmet external dependency, or exhausted review loop with open issues |
| Blocked → Ready | **Human**, after answering in a Linear comment (`/answer …`) or with `autodev answer` |
| → Failed | orchestrator, after retries are exhausted |

No code path moves a ticket to Ready except `plan approve` (a human CLI command) and plan-parent
promotion, which a human triggers by moving the parent.

## 4. Job pipeline (durable, resumable)

Each claimed ticket gets a `jobs` row. `stage` records the **last completed** stage, so every
stage is idempotent and a restart re-runs at most one stage:

1. **workspace**: fetch, then `git worktree add data/worktrees/<ID> -b autodev/<id>-<slug>`. On
   recovery, reuse an existing worktree or check out the existing remote branch. A dirty
   worktree is never deleted.
2. **implement**: Coding Agent (Sonnet, or Opus when complexity ≥ 4) with in-process tools
   `request_decision`, `propose_ticket` and `report_blocker`. Returns structured JSON.
3. **validate**: the orchestrator itself runs the repo's configured commands (typecheck, lint,
   test, build). It doesn't trust the agent's claims. Failures feed bounded fix attempts.
4. **commit**: commit anything left uncommitted, scan the diff for secrets, and flag removed
   assertions for the reviewer.
5. **push**: authenticated with a per-command header, so the token never touches `.git/config`.
6. **pr**: find a PR by head branch first, then create a draft. This is idempotent after
   network failures.
7. **ci**: the job releases its agent slot while waiting. Failures give the agent the failed
   check logs for bounded fixes.
8. **review**: an independent Review Agent (Opus, read-only tools) sees the ticket, the diff and
   the CI results, **not** the coder's summary. If it requests changes, the job goes back to
   implement with the findings (max N cycles).
9. **handoff**: rewrite the PR body (summary, decisions, tests, limitations, preview URL), move
   the ticket to Review, and comment links in Linear.
10. **merged** (reconcile): ticket → Done, clean worktree removed.

## 5. Leases and recovery

- A partial unique index `jobs(ticket_id) WHERE active` makes double-claims impossible at the DB level.
- A claim is a `BEGIN IMMEDIATE` transaction. The lease holds `owner = host:pid:boot` and
  `expires = now + 5 min`, and a heartbeat every 30 s extends it.
- An instance lock in the same DB stops two orchestrators from sharing the state file.
- On start, and every tick: if a job's lease has expired, it's `interrupted` and re-queued from its
  last completed stage. The Claude session ID is stored, so the coding agent resumes the session
  when possible. Otherwise it gets a "previous attempt left changes, inspect `git status`" preamble.
- Reconcile checks real state before acting: does a PR already exist for the branch? Was it merged?
  Did a human cancel the ticket? A failed HTTP call is never treated as "didn't happen". The next
  step always looks first.

## 6. Decision Agent and policy

1. The coding agent calls `request_decision`.
2. The orchestrator checks the decision log (same repo, same normalized question hash, or the
   ticket's own prior decisions) and returns any existing answer.
3. Limits: 3 per ticket, 2 attempts per question, 1 in flight per question. When limits are
   exceeded, the job is blocked.
4. The Decision Agent (read-only repo plus web research) returns a category, options, a
   recommendation, evidence and confidence.
5. `policy.ts` decides `auto` vs `human`. It **can only escalate**: human-only categories,
   sensitive keywords (pricing, billing, auth policy, PII, drop/delete, production, new paid
   service, new dependency outside the allowlist), confidence below the threshold, or the agent's
   own `requiresHuman`.
6. If the result is `auto`, the answer is logged and returned to the coder, and an ADR is written
   if flagged. If it's `human`, the coder is told to stop and commit WIP, and the job becomes
   Blocked with the options and recommendation posted to Linear.

## 7. Cost and usage

- Every agent run records `total_cost_usd` and tokens from the SDK result into the `usage` table.
- Limits are `daily_usd`, `monthly_usd`, `per_ticket_usd` and `per_run_usd` (passed to SDK
  `maxBudgetUsd`, clamped to the remaining daily/monthly/ticket allowance after durable reservations). When a limit is hit, no new runs start,
  current progress is kept, and an event is recorded. Reservation and usage settlement are transactional. A run that ends without a usage total (thrown, aborted, incomplete) is settled at once, and a reservation whose owner process died is settled at the next startup: the reservation minus usage already recorded for it is charged as `usage_unknown_settled`, once per reservation id.
- A `rate_limit_event` with status `rejected`, or a usage-limit error, sets a global
  `paused_until` (the reported reset time, or exponential backoff). Jobs are re-queued without
  using up a retry attempt. **autodev never switches credentials or billing to get around a limit.**
- Model routing: Haiku for classification, Sonnet for routine coding and decisions, Opus for
  planning, review and complexity ≥ 4. All of this is configurable. `autodev usage` shows cost per
  role and model so routing can be benchmarked.

## 8. Security model (summary; see SECURITY.md)

- Agents get a **scrubbed environment**: no GitHub token, no Linear key, and no cloud or
  production secrets. Only the orchestrator holds the GitHub and Linear tokens.
- Agents can't push, open PRs or change ticket states. Those actions exist only in orchestrator
  code. Bash patterns such as `git push`, `gh`, `curl` to arbitrary hosts and `rm -rf /` are
  denied even under any permission mode.
- With `sandbox.enabled`, Bash runs in the OS sandbox (bubblewrap on Linux): writes are limited to
  the worktree, and network is limited to an allowlist (package registries).
- The GitHub bot account has write access but no admin or bypass. Branch protection requires
  checks and **your** approving review, so the bot can't merge or approve.
- Ticket text, repo files and web pages are passed to agents as data inside delimited blocks.
  Authorization lives in code (policy, tool allowlists), never in prompts.
- Every significant operation goes to the `events` audit table.

## 9. Data model

See `src/db.ts`: `jobs`, `decisions`, `plans`, `usage`, `events`, `kv` (instance lock, pauses),
and `local_tickets`/`local_prs` (simulation backends).

## Audit remediation

- All outgoing commits are scanned at the single push boundary; the exact scanned SHA is pushed. Blocked/failed/canceled WIP stays local.
- Setup and validation always run in a separate offline OS sandbox, with a private temporary HOME and allowlisted environment. Repository hooks/settings cannot widen SDK permissions.
- Budget allowances are reserved in `BEGIN IMMEDIATE` transactions and settled atomically with usage. Unknown spend never expires automatically.
- Every completed implementation and final push passes a mandatory manifest/path/pattern policy gate. Explicit human approval applies only to the exact reviewed tree and diff.
- Workers refresh ticket state between stages and poll it during execution. Cancellation propagates to agent and subprocess abort signals. A remote operation already accepted cannot be recalled; later stages stop at the next check.
- Scheduling rechecks candidates against current jobs and claims from the same batch.
- Plan retries repair missing dependency relations. Linear is updated before the job is finalized as Done, so failures stay eligible for reconciliation.
