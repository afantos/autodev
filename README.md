# autodev

A persistent orchestrator that turns your Linear tickets into reviewed, CI-green **draft PRs**
across several GitHub repos. It uses Claude Code agents in isolated git worktrees and runs
continuously on a small VM, including overnight.

You set direction and approve. autodev plans, implements, asks for decisions, reviews, and
reports. When enabled, autodev auto-merges clean PRs after CI, policy checks, and an independent
second review pass; otherwise, you review and merge.

```
idea ──▶ Planning Agent (reads the repo) ──▶ [Plan] + tickets in Backlog
                                   you approve ──▶ Ready
Ready ──▶ scheduler (priority, dependencies, conflicts, budget) ──▶ atomic claim + lease
      ──▶ worktree ──▶ Coding Agent ──(questions)──▶ Decision Agent ──▶ policy: auto | you
      ──▶ orchestrator-run validation ──▶ commit + secret scan ──▶ push ──▶ draft PR ──▶ CI
      ──▶ independent Review Agent ──(changes)──▶ bounded fix loop
      ──▶ In Review (+ preview URL) ──▶ auto-merge (if enabled and checks pass) or you merge
      ──▶ Done (verified on GitHub)
```

## Architecture

One Node process (systemd) owns job state. Linear and GitHub stay the source of truth for tickets and code.

### Overview

```mermaid
flowchart LR
  you(["You"]) --> plan["Planning"]
  plan --> tickets[("Linear tickets")]
  tickets --> orch["Orchestrator"]
  orch --> coding["Coding pipeline"]
  coding --> review["AI review"]
  review --> merge{"Auto-merge or<br/>human review"}
  merge --> done(["Done"])

  classDef user fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef core fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef agent fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef external fill:#e5e7eb,stroke:#4b5563,color:#0f172a
  classDef finish fill:#dcfce7,stroke:#16a34a,color:#0f172a
  class you user
  class plan,orch,coding core
  class review agent
  class tickets external
  class merge,done finish
```

### Components

Solid arrows carry work; dashed arrows record state and spend.

```mermaid
flowchart LR
  you(["You"])

  subgraph proc["autodev process"]
    cli["Command line"]
    status["Dashboard and reports"]
    orch["Orchestrator<br/>reconcile, schedule"]
    plan["Planning"]
    pipe["Coding pipeline<br/>implement, validate, PR, review"]
    dec["Decisions and policy"]
    merge["Auto-merge<br/>clean PRs only"]
    sandbox["Command sandbox"]
  end

  subgraph agents["AI agents"]
    claude["Claude agents<br/>planning, coding, decision, review"]
    gpt["Second reviewer<br/>OpenAI"]
  end

  subgraph ext["External services"]
    linear[("Linear")]
    github[("GitHub")]
  end

  subgraph state["Local state"]
    db[("SQLite<br/>jobs, leases, decisions")]
    budget["Budget caps"]
    repos[("Git worktrees")]
  end

  you --> cli
  you -->|"Ready, /answer"| linear
  you -->|"review, merge"| github
  status --> you

  cli --> orch
  cli --> plan
  orch --> pipe
  orch --> merge
  orch <-->|sync| linear
  orch <-->|sync| github

  plan --> claude
  pipe --> claude
  pipe --> dec
  dec --> claude
  pipe --> sandbox --> repos
  pipe -->|"push, draft PR"| github
  merge --> gpt
  merge -->|"approve, squash-merge"| github

  orch -.-> db
  agents -.->|spend| budget

  classDef user fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef core fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef agent fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef external fill:#e5e7eb,stroke:#4b5563,color:#0f172a
  classDef data fill:#dcfce7,stroke:#16a34a,color:#0f172a
  class you user
  class cli,status,orch,plan,pipe,dec,merge,sandbox core
  class claude,gpt agent
  class linear,github external
  class db,budget,repos data
```

| Box | Code |
|---|---|
| Command line | `src/cli.ts` |
| Dashboard and reports | `src/dashboard.ts`, `src/report.ts` |
| Orchestrator | `src/orchestrator.ts` (tick loop, reconcile) and `src/scheduler.ts` (priority, dependencies, conflicts) |
| Planning | `src/planning.ts`: idea → tickets |
| Coding pipeline | `src/pipeline.ts` |
| Decisions and policy | `src/decisions.ts`, `src/policy.ts` (policy can only escalate) |
| Auto-merge | `src/automerge.ts` (off unless `autoMerge: true`) |
| Command sandbox | `src/command-sandbox.ts`: bubblewrap or Seatbelt, offline |
| Claude agents | `src/agents/runner.ts` (Claude Agent SDK) |
| Second reviewer | `src/agents/second-review.ts` (OpenAI Responses API) |
| Linear | `src/tracker/linear.ts` (GraphQL) |
| GitHub | `src/scm/github.ts` (Octokit) |
| Git worktrees | `src/scm/git.ts` |
| SQLite | `src/db.ts`: jobs, leases, decisions, usage; every component reads and writes it |
| Budget caps | `src/budget.ts`: daily, monthly and per-ticket limits, recorded in SQLite |

`Tracker` (Linear | Local), `Scm` (GitHub | Local) and `AgentRunner` (Claude | Fake) are swappable seams, so
the whole flow runs in tests offline with no AI spend. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Phases 1–10 are implemented and tested:

- Automated unit, pipeline and audit regression tests on real git repositories.
- Audit fixes cover outgoing-history scanning, command isolation, budget reservations, mandatory diff policy, cancellation, conflicts and reconciliation.
- Historical live-Claude verification was reported separately; retained evidence is not included in this repo:
  - planning
  - ticket → PR
  - decision escalation
  - independent review
  - merge → Done

Connecting to **your** Linear, GitHub, and cloud VM needs your credentials and approval. See
[docs/SETUP.md](docs/SETUP.md).

## Adding a project

Start with [config/autodev.example.yaml](config/autodev.example.yaml) for a new instance, or add
another entry to `projects:` in your existing instance's config. Project setup is configuration;
the orchestrator and agents work across repositories without changes to `src/`.

```yaml
projects:
  - key: webapp
    repo: your-org/webapp
    linear:
      teamKey: ENG
      projectName: Web App
    setup: ["npm ci --offline --no-audit"]
    npmCacheDir: ./cache/webapp/npm
    validate: ["npm run typecheck", "npm run lint", "npm test", "NODE_ENV=production npm run build"]
    requiredChecks: [checks, audit]
    approvedDependencies: []
    humanReviewPaths: ['^docs/product-spec\.md$', '^docs/adr/']
    protectTests: true
    autoMerge: false
    docs: [README.md, docs/product-spec.md, docs/adr]
```

Adapt the commands, required check names, approved dependencies and protected paths to that
repository. Seed its dedicated offline dependency cache and keep `workspaceDir` outside the
config, state and HOME directories, as described in the [setup guide](docs/SETUP.md#workspace-layout-and-release-gate).
Projects sharing a Linear team need a `projectName` scope or `project:<key>` ticket labels.

Give the coding bot access to the new GitHub repository and the Linear account access to its
team. Copy and adapt [templates/github/ci.yml](templates/github/ci.yml), then configure branch
protection and matching required checks. Auto-merge additionally needs the separate GitHub
reviewer account and `secondReview.enabled`; setup steps are in
[GitHub setup](docs/SETUP.md#3-github-you) and
[independent review](docs/SETUP.md#3b-auto-merge-with-an-independent-second-reviewer-optional-you).
Keep credentials in the instance's gitignored `.env`; tickets can be approved by moving them
to Ready after the workflow mapping passes `autodev linear-check`.

The `hold-merge` Linear label stops automated approval and merging while leaving coding and
validation available. Set `linear.holdMergeLabel` to change the label name, and remove the
label when owner review is complete. Budgets and concurrency limits apply across all projects
in the same instance; use separate instance configs and data directories for independent limits.

## Commands

```bash
autodev plan "Add Stripe subscriptions with Free, Personal and Business plans" --project webapp --publish
autodev plan-approve <planId>        # or move the [Plan] issue to Ready in Linear
autodev run                          # the service (systemd)
autodev status | report | usage | decisions --pending
autodev answer ENG-42 "Use $12/month for Personal"   # or comment "/answer …" in Linear + move to Ready
autodev pause "reason" | resume
```

## Docs

- [Architecture](docs/ARCHITECTURE.md): components, lifecycle, leases and recovery, decision
  policy, costs, and build-vs-reuse findings
- [Security model](docs/SECURITY.md)
- [Setup](docs/SETUP.md): Claude auth choice, Linear, GitHub bot and branch protection, VM, previews, cost estimates
- [Runbook](docs/RUNBOOK.md): day-to-day operation, failure modes, local simulation

## Layout

```
src/
  cli.ts            commands
  orchestrator.ts   tick loop: recover leases → reconcile with Linear/GitHub → poll CI → schedule
  pipeline.ts       per-job stages, fix and review loops, blockers, PR body
  scheduler.ts      ranking + hard filters (dependencies, conflicts, capacity)
  planning.ts       idea → plan → tickets (dedupe, dependency graph, approval)
  decisions.ts      decision log, limits, Decision Agent, ADRs
  policy.ts         what may be decided without you (can only escalate)
  budget.ts         daily/monthly/ticket budgets, usage-limit and outage pauses
  db.ts             SQLite state: jobs/leases, decisions, plans, usage, events
  report.ts         morning summary (file + optional ntfy/Slack webhook)
  dashboard.ts      read-only mobile status page
  agents/           Claude Agent SDK runner, prompts, output schemas, fake runner
  tracker/          Linear (GraphQL) and local implementations
  scm/              GitHub (Octokit), local implementation, git worktrees
deploy/             systemd unit, cloud-init, Dockerfile
templates/github/   CI workflow for target repos
scripts/            branch protection helper
```

Requirements: Node ≥ 24, git, and a working OS sandbox (bubblewrap on Linux or Seatbelt on macOS). Setup and validation run offline with a private temporary HOME. Prepare dependencies in the worktree or a dedicated offline npm cache before running commands; see the setup guide.

The orchestrator keeps authoritative hashes and independent Git objects in protected `dataDir`; `workspaceDir` contains disposable agent checkouts and separate validation/review snapshots. Agent-visible refs are never used as policy or secret-scan boundaries. See the setup guide for the required folder layout and migration restrictions. Ubuntu VM and live-Claude verification of this latest change remain outstanding.
