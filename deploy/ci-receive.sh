#!/usr/bin/env bash
# Forced command for the dedicated GitHub Actions key; no shell, forwarding, or arbitrary command execution.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9]+)$ ]]; then
  sha=${BASH_REMATCH[1]}
  sequence=${BASH_REMATCH[2]}
else
  echo 'Expected: deploy SHA RUN_NUMBER' >&2; exit 2
fi
install -d -m 0700 /opt/autodev/incoming
stage=$(mktemp -d /opt/autodev/incoming/release.XXXXXXXX)
# Only CI can supply archives. Reject devices, traversal and escaping links before extracting as root.
python3 -c 'import sys, tarfile
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    archive.extractall(sys.argv[1], filter="data")' "$stage"
unit="autodev-deploy-${sha:0:12}-$(date +%s)"
# The transaction survives a lost SSH connection or canceled CI runner.
set +e
systemd-run --quiet --wait --collect --unit="$unit" --property=Type=exec \
  /opt/autodev/deploy/ci-deploy.sh "$sha" "$sequence" "$stage"
result=$?
journalctl --no-pager -u "$unit" -n 100
exit "$result"
