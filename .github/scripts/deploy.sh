#!/usr/bin/env bash
set -euo pipefail

app_dir=/var/www/app/tanoti-whatsapp/tanoti-whatsapp
deploy_sha=${1:?Missing deployment commit}
[[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit'; exit 1; }

cd "$app_dir"
# Protect against deployments started manually or from another workflow.
exec 9> .git/deploy.lock
flock -w 900 9

test "$(git branch --show-current)" = main || { echo 'VPS checkout must be on main'; exit 1; }
git diff --quiet && git diff --cached --quiet || {
  echo 'VPS has uncommitted changes. Commit or stash them before deployment.'
  exit 1
}
git fetch origin main
git merge-base --is-ancestor "$deploy_sha" origin/main || {
  echo 'Deployment commit is not on origin/main'; exit 1
}
if test "$(git rev-parse HEAD)" != "$deploy_sha" && git merge-base --is-ancestor "$deploy_sha" HEAD; then
  echo 'VPS already has a newer commit; skipping this older deployment.'
  exit 0
fi
git merge --ff-only "$deploy_sha"
test "$(git rev-parse HEAD)" = "$deploy_sha"

# Run with the same group that can read the existing root-owned .env.
sudo -n -u aakash -g tanoti-whatsapp -- bash -c '
  set -euo pipefail
  npm ci
  npx --no-install prisma generate
  npx --no-install prisma migrate deploy
  npm run build
'

# Only restart when installation, migrations, and the build succeed.
sudo -n /usr/bin/systemctl restart tanoti-whatsapp
sudo -n /usr/bin/systemctl is-active --quiet tanoti-whatsapp
echo "Deployed $deploy_sha"
