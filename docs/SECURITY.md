# Security model

autodev runs AI-generated code and shell commands unattended. The design rule is that
**authorization lives in code and credentials, never in prompts**.

## Trust boundaries

| Principal | Can | Cannot |
|---|---|---|
| **You** | approve plans (move to Ready), answer blockers, review, merge, deploy | — |
| **Orchestrator process** (holds `GITHUB_TOKEN`, `LINEAR_API_KEY`) | push feature branches, open/update draft PRs, set ticket states (except → Ready), comment | merge to protected branches (branch protection), approve PRs, bypass checks, move tickets to Ready (no code path except `plan-approve` / human plan approval) |
| **Coding agent** (Claude Code in a worktree) | read/edit files in its worktree, run sandboxed commands, leave edits for the orchestrator to commit, ask for decisions, propose Backlog tickets | push, use `gh`, `curl`/`wget`, `ssh`, `docker`, cloud CLIs, `git config`/`remote`; see GitHub or Linear tokens; reach non-allowlisted hosts (sandbox) |
| **Decision / Planning / Review agents** | read the repo, inspect files and reference git metadata (planning/decision), inspect a file-only candidate plus supplied diff (review), web research (planning/decision only) | write files (Edit/Write are removed), run arbitrary Bash |

## Controls

1. **Credential isolation.** Agents get an allowlisted environment (`agentEnv` in
   `src/agents/runner.ts`). The orchestrator's GitHub and Linear tokens are never passed to them.
   Any project `env` entry that looks like a secret is refused unless its name marks it as a test
   value. Setup and validation use a separate allowlisted environment and a private temporary HOME. Their OS sandbox exposes system runtimes and the current worktree, with no orchestrator state or credential files.
2. **Git credentials are per command.** Pushes and fetches use `-c http.extraheader=…` for that
   one invocation. The token is never written to `.git/config`, which the agent could read.
3. **Tool permissions.** Agents run with `permissionMode: 'dontAsk'`, so anything not explicitly
   allowed is denied. Dangerous Bash patterns are in `disallowedTools`, which applies in every
   permission mode.
4. **OS sandbox.** Real agents require the SDK sandbox and fail closed if it is unavailable. Project settings and hooks are not loaded; conventions are read explicitly. Native reads outside the working directory are blocked, and commands cannot read the host HOME or orchestrator configuration/state. Setup, validation and simulated local CI use a separate bubblewrap (Linux) or Seatbelt (macOS) sandbox: readable inputs are system runtimes and the worktree; writes are restricted to the worktree and a private temporary HOME. Command networking is disabled. Tests inject a command double only for trusted generated fixtures; there is no configuration switch to bypass isolation in the CLI.
5. **GitHub.** The bot is a separate machine-user account or GitHub App with Contents and Pull
   requests set to write, Checks/Actions/Statuses/Deployments set to read, and no Administration.
   Branch protection (`scripts/protect-branch.sh`) requires passing checks plus **your** approving
   review, applies to admins, and forbids force-pushes. The bot authors the PRs, so it can't approve
   them, and the protection rules stop it from merging.
6. **Secret scanning.** Every push scans all outgoing commits, including intermediate changes, and pins the scanned SHA. Incomplete scanner output fails closed. Failure handling preserves WIP locally and never pushes. In GitHub, also enable secret scanning with push protection and gitleaks in CI.
7. **Test integrity.** Validation is re-run by the orchestrator, not taken on the agent's word.
   When a diff removes more assertions than it adds, the reviewer gets a warning. The coding
   prompt forbids weakening tests.
8. **Decision policy.** `src/policy.ts` can only escalate. Human-only categories, sensitive
   keywords, low confidence, and new dependencies outside the allowlist all block the ticket for you.
9. **Prompt injection.** Tickets, comments, repo files, CI logs and web content go to agents inside
   `<untrusted>` blocks with explicit instructions. More importantly, a successful injection still
   can't reach tokens, push, merge, or contact arbitrary hosts, because those limits are enforced
   below the model.
10. **Production.** Agents get no production credentials or database URLs. Previews must use
    non-production databases (see `docs/SETUP.md` §7). autodev never deploys.
11. **Audit.** Every claim, agent run (model, cost, outcome), decision, push, PR, state change and
    error goes to the `events` table, which you can read with `autodev status`, the dashboard, or SQL.
12. **Host.** The VM user has no sudo. The systemd unit uses `ProtectSystem=strict` and
    `NoNewPrivileges`, and the firewall denies inbound traffic. The dashboard binds to localhost
    and is reached over Tailscale, with token auth.

## Known residual risks

- The SDK process itself needs the Anthropic credential. SDK sandbox credential rules deny it to tool subprocesses, but the SDK and host OS remain trusted. Use a dedicated credential with a provider-side spending limit.
- Semantic policy detection and secret patterns are incomplete by nature. Human review, GitHub push protection, and least-privilege credentials remain required.
- Allowed agent network domains such as github.com can carry data. Keep the allowlist minimal.
- Command sandboxing must pass the required smoke test on the target host. Nested sandboxing is unavailable in some development environments; local test skips do not establish successful isolation.
- Setup and validation are offline and cannot reach package registries, local databases, or service sockets. Prepare dependency artifacts inside the worktree or configure a dedicated `npmCacheDir`; only package data is copied into the private HOME. Use self-contained tests. Workflows requiring network services need a separately reviewed isolation design.
- Budget reservations cap concurrent allowances, but SDK cost estimates can differ from billing and a model call can cross its configured threshold. Provider-side limits remain the spending backstop. Unknown/crashed runs are charged their whole reservation (settled once; crashed owners at the next startup).

## Git trust boundary

The SDK can implicitly allow writes to some agent-visible Git metadata even when autodev supplies no write grant. Those refs, `packed-refs`, objects, `info/` and indexes are untrusted. Raw ref snapshots in protected state detect unexpected ref/HEAD changes at agent and command boundaries; a restored transient edit is not proof of absence of tampering. Security does not depend on those refs being immutable.

Each coding/research worktree has a second, independent object store under `dataDir/trusted-git`. It is cloned directly from the configured remote with `--no-local`, so it has no object hardlinks or alternates into the disposable checkout. Its location is never an agent-visible `.git` pointer or SDK permission grant. Authoritative base/head hashes live in SQLite `git_states`, outside agent reach. Orchestrator commands use this private git directory, its private index and disabled hooks/fsmonitor. No objects or history are imported from the mutable agent repository.

Policies and secret scans use the pinned base/candidate hashes. Every commit in `base_sha..candidate_sha` is scanned, including commits whose added credentials were later removed. Push sends that exact validated SHA. Remote PR head drift blocks CI/review handoff.

Validation and review run on a separate checkout of the protected candidate. The original coding sandbox cannot write this sibling. Protected manifests fingerprint tracked bytes, symlinks and executable bits independently of git's stat cache; non-ignored extra inputs and any `.git` metadata are rejected. The reviewer receives the full protected diff and has no git repository grant. Any modification to candidate inputs blocks handoff. Setup is repeated to prepare offline dependencies; ignored build artifacts are not published.

This relies on OS/SDK isolation of HOME/config/data and sibling writes. The latest implementation has not been exercised with real Claude, and Ubuntu 24.04 kernel/AppArmor verification remains outstanding. A skipped local OS test is not a deployment approval.
