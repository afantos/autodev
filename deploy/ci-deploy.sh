#!/usr/bin/env bash
# Root-owned CI deploy controller, outside the release being replaced. Called by ci-poll.ts.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'root required' >&2; exit 2; }
sha=${1:?SHA required}
sequence=${2:?RUN_NUMBER required}
stage=${3:?staged archive required}
[[ $sha =~ ^[0-9a-f]{40}$ && $sequence =~ ^[0-9]+$ ]] || exit 2
root=${AUTODEV_DEPLOY_ROOT:-/opt/autodev}
unit=${AUTODEV_DEPLOY_UNIT:-/etc/systemd/system/autodev.service}
app=$root/app
control=$root/deploy
config=$root/instance/autodev.config.yaml
install -d -m 0755 "$control"
install -d -m 0700 "$root/backups"
install -d -m 0755 "$root/releases"
exec 9>"$control/lock"
flock -w 600 9 || { echo 'another deployment holds the lock' >&2; exit 1; }
deployment_allowed() {
  local result=0
  node "$control/deployment-config.ts" "$root" || result=$?
  if (( result == 3 )); then echo 'Automatic deployment is disabled (autoDeployEnabled=false)'; exit 0; fi
  if (( result != 0 )); then echo 'Invalid deployment setting; leaving the running app untouched' >&2; exit 1; fi
}
deployment_allowed
# A delayed older CI run must never replace a newer successful deployment.
if [[ -f $control/sequence && $sequence -le $(cat "$control/sequence") ]]; then
  echo 'Skipping superseded deployment'; exit 0
fi
[[ -f $stage/package-lock.json && -f $stage/src/cli.ts && -f $stage/deploy/health.ts ]] || exit 2
[[ -e $app && -f $app/.installed-commit ]] || { echo 'bootstrap the host first' >&2; exit 2; }
previous=$(readlink -f "$app")
previous_sha=$(cat "$app/.installed-commit")
[[ $previous_sha =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ ! -e $control/pending ]] || { echo 'an unfinished deployment needs recovery' >&2; exit 1; }
# Stage while the old service is still running; install scripts cannot read its credentials.
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
node --input-type=module -e 'const {loadConfig}=await import(process.argv[1]);loadConfig(process.argv[2])' "$stage/src/config.ts" "$config"
printf '%s\n' "$sha" > "$stage/.installed-commit"
chown -R root:root "$stage"
chmod -R go-w "$stage"
# mktemp creates mode 0700; the unprivileged service must be able to traverse the installed release.
chmod 0755 "$stage"
release=$(mktemp -d "$root/releases/$sha-$sequence.XXXXXXXX")
rmdir "$release"
mv "$stage" "$release"
backup=$(mktemp -d "$root/backups/deploy.XXXXXXXX")
cp -p "$unit" "$backup/autodev.service"
db=$(node --input-type=module -e 'const {loadConfig}=await import(process.argv[1]);console.log(loadConfig(process.argv[2]).dataDir+"/autodev.db")' "$release/src/config.ts" "$config")
[[ -f $db ]] || { echo 'state database missing' >&2; exit 1; }
swapping=0
stopped=0
snapshot=0
switch_app() {
  ln -s "$1" "$root/app.next"
  node --input-type=module -e 'import {renameSync} from "node:fs";renameSync(process.argv[1],process.argv[2])' "$root/app.next" "$app"
}
rollback() {
  result=$?
  trap - EXIT HUP INT TERM
  if (( result != 0 && stopped )); then
    echo "Deployment failed; restoring $previous_sha" >&2
    systemctl stop autodev || true
    if (( swapping )); then
      rm -f "$root/app.next"
      switch_app "$previous"
      cp -p "$backup/autodev.service" "$unit"
      systemctl daemon-reload
    fi
    if (( snapshot )); then
      # Both processes are stopped; the guarded candidate has made no remote or agent writes.
      rm -f "$db-wal" "$db-shm"
      cp -p "$backup/autodev.db" "$db"
      chown autodev:autodev "$db"
    fi
    rm -f "$control/pending"
    systemctl reset-failed autodev || true
    if systemctl start autodev && systemctl is-active --quiet autodev; then
      echo "ROLLED_BACK $previous_sha" >&2
    else
      echo 'ROLLBACK FAILED: inspect journalctl -u autodev' >&2
    fi
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
# Re-read after dependency installation/lock waits: an operator can turn deployment off before the app is stopped.
deployment_allowed
# Prevent any candidate work during the startup observation window. The unit's sandbox self-test runs as usual.
printf '%s\n' "$sha" > "$control/pending"
stopped=1
systemctl stop autodev
sqlite3 "$db" ".backup '$backup/autodev.db'"
snapshot=1
# One-time migration from the original directory install to immutable releases.
if [[ ! -L $app ]]; then
  previous=$root/releases/bootstrap-$previous_sha
  [[ ! -e $previous ]] || exit 1
  mv "$app" "$previous"
  swapping=1
  ln -s "$previous" "$app"
fi
swapping=1
switch_app "$release"
install -m 0644 "$release/deploy/autodev.service" "$unit"
systemctl daemon-reload
systemctl reset-failed autodev || true
since=$(date +%s000)
systemctl start autodev
pid=$(systemctl show autodev -p MainPID --value)
[[ $pid =~ ^[1-9][0-9]*$ ]] || exit 1
# A stable PID alone is insufficient: require a fresh startup event and instance lock belonging to this process.
for ((i=0; i<15; i++)); do
  sleep 1
  systemctl is-active --quiet autodev
  [[ $(systemctl show autodev -p MainPID --value) == "$pid" ]] || exit 1
  node "$release/deploy/health.ts" "$db" "$pid" "$since"
done
printf '%s\n' "$sequence" > "$control/sequence.next"
mv "$control/sequence.next" "$control/sequence"
rm -f "$control/pending"
stopped=0
trap - EXIT HUP INT TERM
printf 'DEPLOYED %s (previous %s; backup %s)\n' "$sha" "$previous_sha" "$backup"
