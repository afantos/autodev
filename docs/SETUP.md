# Setup guide

Each step is marked **(you)** when it needs your accounts, money, or admin rights. autodev never
does these steps itself.

## 0. Try it locally without any accounts (5 minutes, no AI spend)

```bash
npm ci && npm run check            # typecheck + pipeline and regression tests
```

A full local simulation uses a local tracker, local git remote, and either the fake runner or
real Claude. See `docs/RUNBOOK.md` › "Local simulation".

## Workspace layout and release gate

Keep credentials/configuration, trusted state and agent-visible workspaces separate:

| Setting | Example | Contents |
|---|---|---|
| config directory | `/opt/autodev/instance` | `.env`, `autodev.config.yaml` |
| `dataDir` | `/opt/autodev/instance/data` | SQLite, worktree/ref records, private Git object stores, candidate manifests |
| `workspaceDir` | `/opt/autodev/instance-work` | disposable reference clones, coding worktrees, validation/review candidate snapshots |

`workspaceDir` defaults to a sibling named `<config-folder>-work`. It must be outside HOME, the config directory and `dataDir`; symlink-resolved paths are checked. For local tests use directories under `/tmp`, or set an explicit workspace outside these protected roots. Coding agents cannot access the private object stores in `dataDir`.

The systemd unit allows `/opt/autodev/instance-work` to be written, and cloud-init creates it with the service user's ownership. If you customize `workspaceDir`, update `ReadWritePaths` and create that directory first. Docker needs separate writable state and workspace volumes; the image declares both default paths.

The reviewed Debian 12 Docker test required all three options below for nested bubblewrap:

```text
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
```

The `systempaths` option permits bubblewrap to mount its private `/proc`. These options relax Docker's outer isolation; the inner OS sandbox remains mandatory. This container result does not verify Ubuntu 24.04's kernel/AppArmor configuration.

Before connecting accounts, run `AUTODEV_REQUIRE_SANDBOX_TEST=1 npm run check` on the intended host. Ubuntu 24.04 kernel/AppArmor verification and a live-Claude check of these latest changes remain outstanding. Earlier Debian container evidence does not establish the Ubuntu VM configuration.

For a free command-sandbox preflight, run `node scripts/diagnose-sandbox.ts` directly in Terminal first. It uses only synthetic fixtures and never starts an agent or resumes a job. On macOS a successful native profile compilation is insufficient: the runtime, Node/npm fixture and isolation probes must also pass. The macOS bootstrap correction remains unverified end to end until this host-level diagnostic succeeds.

## 1. Claude authentication: decide this first (you)

| Option | Billing | Fit for 24/7 unattended use |
|---|---|---|
| **Claude Console API key** (`ANTHROPIC_API_KEY`) | pay per token, with a hard monthly spend limit set in the Console | **Operational preference.** A dedicated credential separates accounting and permits provider-side limits. |
| Claude subscription (Pro/Max) login on the VM | flat plan, with usage limits | Anthropic documents Agent SDK use against subscription limits. Its October 7, 2026 update also documents API credits for Max and Team; those credits do not apply to Pro. Usage availability depends on the plan and workload. |

Recommendation: create a **dedicated** Console API key for autodev, set a monthly spend limit in
the Console that matches `budget.monthlyUsd`, and store it only in `/opt/autodev/instance/.env`.
autodev's own budgets are estimates and act as a second layer; the Console limit is the hard stop.

See [Anthropic's current subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## 2. Linear (you)

1. Create a **personal API key** in Linear Settings → Security & access → API keys. For a cleaner
   audit trail, create it while signed in as a dedicated "autodev" member. Name it `autodev`; use Read and Write without Admin and restrict it to the intended teams.
2. Put it in `.env` as `LINEAR_API_KEY=…`.
3. Map projects to teams in `autodev.config.yaml`, then run:
   ```bash
   autodev linear-check                 # lists missing workflow states
   # Add missing states manually in Linear workflow settings.
   # linear-setup --apply requires Admin; do not grant it to the bot.
   ```
4. Board: `Ideas → Backlog → Ready → In Progress → In Review → Done` plus `Blocked`, `Failed`
   and `Canceled`. Rename states freely, but keep `linear.states` in sync.

How you work in Linear:
- **Approve** by moving tickets, or a `[Plan]` issue, to **Ready**.
- **Answer a blocker** with a comment starting `/answer …`, then move the ticket to Ready.
- **Request rework** on a PR in Review by commenting and moving the ticket back to Ready.
- **Stop** a ticket by moving it to Backlog or Canceled. Its branch is kept.

## 3. GitHub (you)

1. Create a machine user (for example `yourname-autodev`) or a GitHub App, and give it **write**
   access to only the target repos.
2. Create the bot's token. Which kind depends on who owns the repo:
   - **Repo owned by an organization:** a fine-grained token with the org as resource owner,
     scoped to only the target repos, with these permissions:
     - Read and write: Contents, Pull requests
     - Read only: Checks, Actions, Commit statuses, Deployments, Metadata
     - **No** Administration, Secrets or Workflows write
   - **Repo owned by a personal account (bot invited as a collaborator):** fine-grained tokens
     don't support contributing to repos where you're a collaborator (a gap GitHub's token docs
     list). Use a **classic** token with the `repo` scope and an expiry, for example 90 days.
     In practice its reach is limited to the repos the bot was invited to, with write access.
     Branch protection is what stops it from merging or pushing to `main`, so it's required.

   Store it as `GITHUB_TOKEN` in `.env`.
3. In each repo, add CI (`templates/github/ci.yml`), then protect `main` with your own admin
   credentials. Branch protection on **private** repos needs a paid plan: GitHub Pro for
   personal accounts, Team for organizations. On GitHub Free the API returns HTTP 403.
   Command:
   ```bash
   ./scripts/protect-branch.sh your-org/webapp main "checks,audit"
   ```
4. Enable Settings → Code security → Secret scanning and Push protection.

Using a separate bot account matters: PRs are authored by the bot, so **you** can approve them,
and the bot can never approve its own work.

### 3b. Auto-merge with an independent second reviewer (optional; you)

With `autoMerge: true` on a project and `secondReview.enabled: true`, autodev merges a PR without a human only when
all of these hold for the exact validated commit:
- CI passes;
- Claude's review approves;
- the second reviewer (OpenAI `gpt-6.1-sol`) approves;
- the diff policy flags nothing (dependencies, protected paths, existing tests, security keywords);
- the branch contains the current base. When the base has moved, autodev merges it in and revalidates everything first;
  conflicts go back to the coding agent.

Anything flagged still waits for you. Setup:
1. **Reviewer GitHub account.** Create a second machine account (e.g. `afantos-reviewer`) and invite it as a
   collaborator with **write** access. Create a classic token with the `repo` scope and save it as
   `GITHUB_REVIEWER_TOKEN`. Branch protection's "approval from someone other than the last pusher" is satisfied
   because the coding bot pushes and the reviewer approves. Keep `enforce_admins` on.
2. **OpenAI.** Create a dedicated project and API key (`OPENAI_API_KEY`), and set the project's monthly budget to the
   same value as `secondReview.monthlyUsd`. autodev keeps a separate ledger for it (`autodev usage`); it never counts
   against Claude's budget.
3. **Turn off** by setting `autoMerge: false`. PRs then wait for a human again.

### Automatic autodev deployment

The `Check` workflow's deploy job runs after `checks` only for pushes to `main`. It deploys
the tested SHA and skips a commit superseded on main. Deployment concurrency follows
[GitHub's deployment guidance](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

One-time host setup (root, after the existing bootstrap): install `deploy/ci-deploy.sh` and
`deploy/ci-receive.sh` into `/opt/autodev/deploy/`, owned by root, mode 0755. This directory
must be traversable by the service user so it can read the `pending` startup guard. Install
`deploy/autodev.service`, then `systemctl daemon-reload` (CI performs the first restart).
Create a dedicated Ed25519 key and add only its public key to root's `authorized_keys` as:

```text
restrict,command="/opt/autodev/deploy/ci-receive.sh" ssh-ed25519 PUBLIC_KEY autodev-ci
```

Set repository secrets `AUTODEV_DEPLOY_KEY` (dedicated private key) and
`AUTODEV_DEPLOY_KNOWN_HOSTS` (the independently verified SSH host public key); set repository
variable `AUTODEV_DEPLOY_HOST` to the hostname/IP. The key cannot open a shell or forward ports;
its only command accepts a SHA, workflow run number and release archive. The receiver starts
a systemd transaction so SSH disconnection cannot interrupt rollback. No account/API credentials
from the running instance are given to GitHub. Host prerequisites: Node 24+, npm, Python 3.12+,
sqlite3, flock and systemd (all available in the Ubuntu host setup).

CI updates app code and its unit. The deployment controller lives outside releases so a failed
release cannot replace the code responsible for its rollback. Updating the controller itself
requires explicitly installing its reviewed version under the same host lock. Runtime config,
credentials and app databases are not release artifacts. See the [upgrade runbook](RUNBOOK.md#upgrading).

## 4. Cloud VM (you: this costs money)

Sizing for 2 concurrent agents: **4 vCPU, 8–16 GB RAM, 80 GB SSD**, Ubuntu 24.04. Claude runs in
the cloud, so local CPU mostly goes to your test suites and builds. Size up if your builds are heavy.

| Provider (examples) | Approx. monthly |
|---|---|
| Hetzner CPX31 / CCX23 | ~€15–30 |
| DigitalOcean 4 vCPU / 8 GB | ~$48 |
| AWS t3.xlarge (on-demand) | ~$120 |

Check current prices before buying. AI usage is usually the larger cost; see §8.

Bootstrap with `deploy/cloud-init.yaml`, then join Tailscale (`sudo tailscale up`) so your phone can
reach the dashboard privately.

## 5. Install on the VM

**Credential-free preparation.** As root, run `deploy/prepare-host.sh <bundle-or-repo> <commit>`. It:
- checks the host: Ubuntu 24.04, Node 24, bubblewrap, the `bwrap` AppArmor profile, the userns restriction enabled, and an `autodev` user without sudo;
- installs the app root-owned and read-only at the exact commit;
- creates the instance and workspace directories;
- installs `deploy/droplet.config.yaml` and `deploy/env.template` (placeholders only) if they are absent;
- installs the systemd unit without enabling or starting it;
- validates the config schema.

Then fill in the `DECISION` fields and `.env` (mode 0600), and run `linear-check` before enabling the service. The manual flow below is the equivalent long form.

```bash
sudo -u autodev -i
git clone https://github.com/<you>/autodev /opt/autodev/app && cd /opt/autodev/app && npm ci --omit=dev
cd /opt/autodev/instance
cp /opt/autodev/app/config/autodev.example.yaml autodev.config.yaml   # edit projects/teams/budgets
cat > .env <<'EOF'
ANTHROPIC_API_KEY=...
LINEAR_API_KEY=...
GITHUB_TOKEN=...
AUTODEV_DASHBOARD_TOKEN=<random 32+ chars>
AUTODEV_REPORT_WEBHOOK=https://ntfy.sh/<private-topic>
EOF
chmod 600 .env
node /opt/autodev/app/src/cli.ts linear-check
exit
sudo cp /opt/autodev/app/deploy/autodev.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now autodev
journalctl -u autodev -f
```

Dashboard: `http://<vm-tailscale-name>:7777/?token=…` after setting `dashboard.host: 0.0.0.0`.
That's only safe behind Tailscale with the firewall denying public traffic. Alternatively, keep
`127.0.0.1` and use `tailscale serve`.

## 6. Onboarding a repository

1. Add a `CLAUDE.md` with the build and test commands, conventions and architecture notes.
   Agents read it first.
2. Setup and validation run offline in an OS sandbox with a private temporary HOME. For npm, set `npmCacheDir` to a dedicated cache populated by the operator from the approved lockfile before jobs start. Only its `_cacache` package data is copied into each command sandbox; no host `.npmrc` or credentials are copied. Use `npm ci --offline --no-audit` for setup. Other stacks need self-contained dependency artifacts in the worktree. Host caches, credential files, network databases and sockets are unavailable. Make validation self-contained.
3. Before adding credentials, run `AUTODEV_REQUIRE_SANDBOX_TEST=1 npm run check` on the target host. Unavailable isolation must fail this check.
4. Give each concurrent job isolated resources through `env` templating, for example a database
   per job: `postgres://localhost/app_test_{{jobId}}` and `PORT={{port}}`.
5. Begin with `maxConcurrent: 1` per repo and `concurrency.global: 2`.

## 7. Preview environments (optional; you)

autodev only **reads** preview URLs that GitHub Deployments report for the PR head. It never
creates infrastructure.
- **Vercel:** install the Vercel GitHub app. Enable *Deployment Protection* (Vercel Authentication)
  for previews of sensitive apps. Set Preview-environment variables to non-production values only.
  Use Neon or Supabase branch databases per PR, never the production database.
- **Railway:** enable PR environments, give them their own variables and database, and turn on
  auto-delete on PR close.
- Make migrations in previews additive. Destructive migrations are a human-only decision category.

## 8. Expected AI cost (estimates; benchmark your own with `autodev usage`)

A historical small-ticket run was reported at about **$0.23** per the SDK estimate; its retained evidence is not included in this repository. Rough planning numbers for typical web-app tickets:

| Activity | Model | Typical |
|---|---|---|
| Plan a feature (repo research, 4–8 tickets) | Opus | $1–5 |
| Implement a ticket (complexity 1–3) | Sonnet | $0.5–4 |
| Implement a complex ticket (4–5) | Opus | $3–12 |
| Independent review | Opus | $0.3–2 |
| Decision research | Sonnet | $0.1–1 |

At 2 agents, overnight throughput of about 6–15 tickets typically costs **$10–40 per night**.
These are estimates, not measured overnight throughput. Reservations limit concurrent authorized allowances; use a provider-side limit as the billing backstop.

## Trusted candidates and compatibility

The orchestrator records the base and current commit hashes in protected SQLite state before an agent can run. It clones an independent per-worktree object store directly from the configured remote with `--no-local`; it never imports objects, refs, alternates, grafts or indexes from the agent-visible clone. Policies, outgoing history scans and pushes use these pinned hashes.

The coder leaves changes in its working directory. The orchestrator commits them privately, then creates a separate snapshot of that exact candidate for validation and review. Setup runs again in this snapshot to prepare dependencies from the offline cache. The snapshot has no `.git`; validation and review must use file-based tools, and the reviewer receives the full trusted diff. Submodules are currently refused. Tracked inputs must remain unchanged; additional generated outputs/dependencies must be ignored by the approved repository. Ignored outputs are never committed or pushed.

Existing workspaces created before trusted hashes/object stores were introduced are refused. Stop the service, back up the database, protected Git stores and workspace files, then explicitly reconcile or recreate affected jobs/workspaces from the real remote. Do not resolve or copy their mutable refs into trusted state as a migration shortcut.
