#!/usr/bin/env bash
# Apply branch protection so the autodev bot can open PRs but never merge or bypass checks.
# Run this YOURSELF with an admin token (not the bot token):  ./scripts/protect-branch.sh owner/repo main "checks,audit"
set -euo pipefail
REPO="${1:?owner/repo}"; BRANCH="${2:-main}"; CHECKS="${3:-checks}"
CONTEXTS=$(jq -cn --arg c "$CHECKS" '$c | split(",")')
echo "Protecting $REPO@$BRANCH requiring checks: $CHECKS and 1 approving review (code owners), admins included."
read -r -p "Proceed? [y/N] " ok; [[ "$ok" == "y" ]] || exit 1
gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $CONTEXTS },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true, "require_last_push_approval": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "Done. Also enable: Settings → Code security → Secret scanning + Push protection."
