# Runbook

## Daily loop (from your phone)

1. Morning: read the report (ntfy/Slack, `autodev report`, or the dashboard). It opens with
   **Needs your attention**.
2. **In Review** tickets: open the PR and preview, then merge or request rework. To request rework,
   comment on the Linear ticket and move it back to **Ready**.
3. **Blocked** tickets: read the question and recommendation, then comment `/answer …` and move to
   **Ready**. Moving to Ready without a comment accepts a decision recommendation, except mandatory diff-policy blockers: those require an explicit `/answer approve` for the exact reviewed diff.
4. **Backlog**: suggested tickets (label `autodev-suggested`) and new plans wait for you. Move
   whatever you approve to Ready.
5. New idea: `autodev plan "…" --publish` (or ask on the VM), review the `[Plan]` issue, answer its
   open questions in comments, then move it to Ready.

## What autodev does by itself vs. what it waits for

| Situation | Behavior |
|---|---|
| Ready ticket, dependencies merged, capacity free | Claims it and works on it |
| Dependency only in Review (not merged) | Waits, unless `stackedBranches: true` and exactly one dependency PR exists |
| Routine technical question | Decision Agent decides, logs it, and continues |
| Pricing, auth policy, privacy, destructive data, new paid service, new dependency, product behavior | Blocks the ticket, posts options and a recommendation, and continues other work |
| Validation or CI fails | Up to `maxFixAttempts` fix passes with the logs, then **Failed** |
| Review requests changes | Up to `maxReviewCycles` fix passes, then **Blocked** with the findings |
| Claude usage limit | Pauses new runs until the reset time; the job is re-queued without counting an attempt |
| API outage | Exponential backoff pause |
| Budget reached | Starts nothing new and resumes next period (or after `autodev resume` if `onExhausted: manual`) |
| Crash or VM restart | Expired leases are recovered, and each job resumes from its last completed stage. Existing branches and PRs are looked up before creation; interrupted plan publication repairs missing dependency links. Reservations of the dead process are settled at startup (charged, `budget.settled` events). |
| You move an active ticket to Backlog or Canceled | Stops; the branch is kept |
| PR merged | Done (only after GitHub confirms the merge), and the clean worktree is removed |

## Failure handling

- `autodev status` lists jobs, stages, errors and pauses.
- The dashboard's per-job log shows every event for a job.
- Each job's worktree lives in `<workspaceDir>/worktrees/<TICKET>`. Blocked, failed and canceled work is committed locally and is never pushed by failure handling. Inspect it on the host; do not assume it exists remotely. Agent-visible git refs are a disposable reference checkout and do not advance when the orchestrator commits. The authoritative commit and private `git_dir` are in the protected `git_states` table. Operators can inspect that store explicitly with `git --git-dir=<git_dir> --work-tree=<worktree> show <head_sha>`; never expose it to an agent.
- A secret in any outgoing commit prevents every push, even if a later commit removes it. Remove the credential from the entire unpublished history before retrying.
- `autodev usage` lists durable budget reservations. A run that ends without a usage total (runner threw, canceled, incomplete result) is settled immediately; a reservation whose owner process is dead (same host, pid gone or reused) is settled at orchestrator startup. Settlement charges the reservation minus usage already recorded for that run as one `usage_unknown_settled` row and deletes the reservation in the same transaction, at most once per reservation id (`budget.settled` event). Live runs, live CLI processes and owners on other hosts keep theirs. Never delete a reservation by hand just to unblock spending.
- Claude SDK results are cumulative across resumed sessions. Autodev stores a durable baseline per session ID and records only each call's cost and token increments, in the same transaction as settling its reservation. Fresh sessions are charged in full. New `usage` rows include `session_id` for auditing. Historical rows are not rewritten: pre-fix resumes may have inflated ticket, daily and monthly totals. A resumed session with no saved baseline (for example, one started before this fix) is conservatively charged in full once and logs `budget.session_baseline_missing`; audit that session before correcting historical spend. Decreasing or invalid session totals log `budget.session_usage_unknown` and settle the run's reservation conservatively.
- Run `AUTODEV_REQUIRE_SANDBOX_TEST=1 npm run check` on the target host before connecting accounts. This makes unavailable OS isolation a test failure rather than a skip. Setup and validation fail closed and have no network access.
- Retry a Failed ticket by moving it to Ready. A new job continues on the existing branch.
- Inspect state: `sqlite3 data/autodev.db 'select ticket_identifier,status,stage,error from jobs order by updated_at desc limit 20'`.
- Back up state: `sqlite3 data/autodev.db ".backup data/backup.db"`. The database is WAL mode, so
  this is safe while running. Also preserve the private object stores under `data/trusted-git` and the candidate/ref records; a database backup alone is insufficient to recover unpublished commits. Stop work while taking a consistent full backup.

## Local simulation (no Linear or GitHub; optional real Claude)

```bash
mkdir /tmp/sim && cd /tmp/sim
git init --bare -b main remote.git
# push a seed project to remote.git (any repo with `npm test`), then:
cat > autodev.config.yaml <<EOF
tracker: local
scm: local
runner: fake          # or: claude (uses your local Claude login / ANTHROPIC_API_KEY)
localCi: npm test
projects: [{ key: demo, repo: /tmp/sim/remote.git, validate: ["npm test"] }]
EOF
autodev ticket-add --project demo --title "Add multiply()" --status ready
autodev tick           # one scheduling round: implement → validate → PR → review
autodev sim-merge 1    # act as the human merging PR #1
autodev tick           # → Done
```

## Upgrading

Push reviewed changes to `main`. The `Check` workflow deploys that exact commit only after its
checks pass. The outbound `autodev-deploy.timer` notices successful main CI within about two
minutes, verifies that main still matches, and runs the transaction under `/opt/autodev/deploy/lock`.
Older queued runs are skipped. `prepare-host.sh` is for a new host only.

The controller stages dependencies before stopping the old process, backs up the stopped
SQLite database and installed unit, and switches `/opt/autodev/app` to an immutable release.
The candidate starts behind a root-owned guard: it acquires its instance lock and runs schema
migrations, but makes no tracker, GitHub or agent calls during the check. For 15 seconds the
controller requires a stable systemd PID, a fresh startup event and that process's fresh
instance lock. A failure restores code, unit and the database snapshot, restarts the previous
release, and fails the deployment service. State rollback is safe during this window because the guard
prevents candidate work. After the guard is removed, later operational failures require
investigation; this is a startup rollback, not an automatic rollback of already published work.

Inspect `journalctl -u autodev-deploy` and `journalctl -u autodev`. Backups are under
`/opt/autodev/backups/`; releases are under `/opt/autodev/releases/`. Retain these for recovery.
An abandoned `deploy/pending` marker stops subsequent deployments for recovery; do not remove
it until the installed release and state are checked. See [deployment setup](SETUP.md#automatic-autodev-deployment)
for the one-time service installation. To explicitly retry a rolled-back commit after resolving
its cause, remove `/opt/autodev/deploy/failed-sha` and run `systemctl start autodev-deploy`. Runtime config and `.env` are never copied from a release.

After restarting, inspect queued work and unsettled budget reservations. Leases and stages preserve progress; remote writes are retried and reconciliation checks merges before marking Done.

## Trusted-hash security blocks

- `security.worktree_tampered` includes changed `.git` pointers, refs, `packed-refs`, HEAD, candidate files, missing trusted state, and remote PR head drift. A security block preserves files and publishes nothing further. Inspect the recorded event before retrying.
- Shared ref snapshots are checked after every coding, planning, decision and review run. Disposable object corruption cannot alter the private policy/scan range; it may still break the agent's own git commands and require rebuilding that reference checkout.
- Agents must leave edits uncommitted. A habitual `git commit` or `git stash` changes refs and blocks the job even when the edits are otherwise valid. Keep the event for inspection; do not disable the guard to accommodate it. A real-Claude smoke run is still needed to measure how often agents follow this contract.
- Jobs record `base_sha`, `candidate_sha`, `validated_sha`, `reviewed_sha` and `candidate_worktree`. Validation and review use the separate candidate snapshot; the remote PR must have the same candidate SHA. No new commit is made after validation.
- Keep Ubuntu VM verification explicitly outstanding until the required suite passes on the actual kernel/AppArmor setup. No new live-Claude evidence was gathered for this change.

## Command sandbox launch failures (no AI needed)

Run `node scripts/diagnose-sandbox.ts` in Terminal on the intended host, outside any surrounding sandbox. It creates an isolated temporary fixture and does not import the agent runner, open a job database, or retry queued work. No Claude, Linear, GitHub or cloud calls are made.

The diagnostic separates a denied basic sandbox launch (`host_unavailable`) from a working OS sandbox with a broken autodev profile (`profile_failed`). Only the first condition may skip local integration tests; a broken profile must fail. `AUTODEV_REQUIRE_SANDBOX_TEST=1` makes either condition fail the release gate.

On macOS the report includes exit signals, profile files, a tagged Seatbelt log, and a comparison of the legacy policy with literal-root-directory and executable-mapping corrections. Apple's local `dyld-support.sb` documents the loader's need to open `/` as an openat base. The root grant is a **literal** directory grant, not recursive filesystem access. Compilation alone does not prove runtime compatibility.

If the profile launches, the diagnostic also runs fixed Node/npm fixture tests and checks synthetic secret-file, symlink, `.git`, host-write and network boundaries. It saves `report.json` and profile/log artifacts in the printed temporary directory. A failed baseline or probe leaves the report unsuccessful; it never falls back to unsandboxed repository execution.

Every coding attempt, including a requeued attempt, first checks the command sandbox with a fixed Node marker. Failure blocks the ticket before starting an agent. Repair and verify isolation before resuming it. The stopped paid smoke job remains separate, and another real-Claude run still requires explicit authorization.
