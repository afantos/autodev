#!/bin/sh
# Prepare an Ubuntu 24.04 host for autodev WITHOUT credentials and WITHOUT starting anything.
# Run as root:  sh prepare-host.sh /path/to/autodev.bundle <commit>
# Templates (droplet.config.yaml, env.template, autodev.service) are read from this script's directory.
# Idempotent: re-running reinstalls the app at the given commit and leaves config/.env/state untouched.
set -eu
BUNDLE="${1:?usage: prepare-host.sh BUNDLE COMMIT}"
COMMIT="${2:?usage: prepare-host.sh BUNDLE COMMIT}"
HERE=$(cd "$(dirname "$0")" && pwd)
APP=/opt/autodev/app
INSTANCE=/opt/autodev/instance
WORK=/opt/autodev/instance-work

echo "== preconditions"
. /etc/os-release; [ "$VERSION_ID" = "24.04" ] || { echo "expected Ubuntu 24.04, got $PRETTY_NAME"; exit 1; }
node -v | grep -q '^v24' || { echo "Node 24 required"; exit 1; }
command -v bwrap >/dev/null || { echo "bubblewrap required"; exit 1; }
[ -f /etc/apparmor.d/bwrap ] || { echo "documented /etc/apparmor.d/bwrap profile required"; exit 1; }
[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = 1 ] || { echo "host-wide userns restriction must stay enabled"; exit 1; }
id autodev >/dev/null 2>&1 || useradd -m -s /bin/bash autodev
if id -nG autodev | grep -qwE 'sudo|admin|wheel'; then echo "autodev must not have sudo"; exit 1; fi

echo "== app at $COMMIT (root-owned, read-only to the service user)"
TMP=$(mktemp -d)
git clone -q "$BUNDLE" "$TMP/app"
git -C "$TMP/app" checkout -q --detach "$COMMIT"
[ "$(git -C "$TMP/app" rev-parse HEAD)" = "$COMMIT" ] || { echo "commit mismatch"; exit 1; }
rm -rf "$APP.new" && mkdir -p /opt/autodev && cp -a "$TMP/app" "$APP.new" && rm -rf "$TMP"
(cd "$APP.new" && HOME=/root npm ci --omit=dev --no-audit --no-fund >/dev/null)
echo "$COMMIT" > "$APP.new/.installed-commit"
rm -rf "$APP.new/.git"
chown -R root:root "$APP.new" && chmod -R go-w "$APP.new"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"; rm -rf "$APP.old"

echo "== directories"
install -d -o autodev -g autodev -m 0750 "$INSTANCE" "$WORK"
install -d -o autodev -g autodev -m 0700 /home/autodev/.claude /home/autodev/.cache /home/autodev/.npm

echo "== config and .env templates (never overwritten; no secrets)"
[ -f "$INSTANCE/autodev.config.yaml" ] || install -o autodev -g autodev -m 0640 "$HERE/droplet.config.yaml" "$INSTANCE/autodev.config.yaml"
[ -f "$INSTANCE/.env" ] || install -o autodev -g autodev -m 0600 "$HERE/env.template" "$INSTANCE/.env"

echo "== systemd unit (installed, NOT enabled, NOT started)"
install -o root -g root -m 0644 "$HERE/autodev.service" /etc/systemd/system/autodev.service
systemctl daemon-reload
systemctl disable autodev >/dev/null 2>&1 || true
systemd-analyze verify /etc/systemd/system/autodev.service
echo "enabled=$(systemctl is-enabled autodev 2>/dev/null || true) active=$(systemctl is-active autodev 2>/dev/null || true)"

echo "== config schema check (no credentials needed)"
su - autodev -c "cd $INSTANCE && node --input-type=module -e \"
import { loadConfig } from '$APP/src/config.ts';
const c = loadConfig('$INSTANCE/autodev.config.yaml');
const open = JSON.stringify(c).match(/OWNER\\/REPO|\\\"TEAM\\\"/g) || [];
console.log('config valid; workspaceDir=' + c.workspaceDir + '; placeholders remaining=' + open.length);
\""
echo "PREPARE_DONE"
