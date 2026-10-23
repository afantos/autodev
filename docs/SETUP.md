# Setup guide

Each step is marked **(you)** when it needs your accounts, money, or admin rights. autodev never
does these steps itself.

## 0. Try it locally without any accounts (5 minutes, no AI spend)

```bash
npm ci && npm run check            # typecheck + pipeline and regression tests
```

A full local simulation uses a local tracker, local git remote, and either the fake runner or
real Claude. See `docs/RUNBOOK.md` › "Local simulation".

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
2. Create a fine-grained PAT for it with these permissions on those repos only:
   - Contents: Read & write
   - Pull requests: Read & write
   - Checks: Read
   - Actions: Read
   - Commit statuses: Read
   - Deployments: Read
   - Metadata: Read
   - **No** Administration, Secrets or Workflows write.

   Store it as `GITHUB_TOKEN` in `.env`.
3. In each repo, add CI (`templates/github/ci.yml`), then protect `main` with your own admin
   credentials:
   ```bash
   ./scripts/protect-branch.sh your-org/webapp main "checks,audit"
   ```
4. Enable Settings → Code security → Secret scanning and Push protection.

Using a separate bot account matters: PRs are authored by the bot, so **you** can approve them,
and the bot can never approve its own work.

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
3. Before adding credentials, run `AUTODEV_REQUIRE_SANDBOX_TEST=1 node --test test/regressions.test.ts` on the target host. Unavailable isolation must fail this check.
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
