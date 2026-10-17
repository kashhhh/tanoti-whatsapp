# GitHub Actions and VPS deployment

Every push and pull request installs dependencies, generates the Prisma client,
runs the existing tests, and builds with Node.js 22. Successful pushes to `main`
also deploy the triggering commit to the existing VPS checkout. Other branches
do not deploy. Production deployments are serialized and are not cancelled
halfway through when another commit is pushed.

## GitHub configuration

Create a GitHub environment named `production`. Add these secrets to that
environment (or to the repository's Actions secrets):

| Secret | Value |
| --- | --- |
| `VPS_HOST` | VPS public IP or hostname |
| `VPS_USER` | `aakash` |
| `VPS_SSH_KEY` | Private key for a dedicated SSH deployment key |
| `VPS_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for the VPS |

Add the deployment key's public key to `aakash`'s `~/.ssh/authorized_keys` on the
VPS. Keep the private key in GitHub Secrets, not in this repository. Obtain the
known-hosts entry from a trusted connection and verify its fingerprint against
the VPS before saving it. For a nonstandard SSH port, set the repository variable
`VPS_PORT`; the known-hosts entry must use `[hostname]:port`.

The VPS already needs its own GitHub access for `git fetch origin main`.
The workflow's SSH key authenticates to the VPS, not from the VPS to GitHub.
The production Shopify and WhatsApp credentials stay in the VPS `.env` file.
The build-check job uses placeholder credentials and sends no live messages.

## One-time VPS setup

The script targets `/var/www/app/tanoti-whatsapp/tanoti-whatsapp` and the systemd
service `tanoti-whatsapp`. It expects the SSH user to be `aakash`. Adjust the
script if these change. Node.js 22, npm, Git, and `flock` must be available.

Earlier permissions errors showed that root owns parts of this checkout. From
the app directory, grant the deploy user ownership of the checkout's generated
and source directories while preserving the existing `.env` and database
ownership:

```bash
cd /var/www/app/tanoti-whatsapp/tanoti-whatsapp
sudo chown aakash:tanoti-whatsapp .
sudo chown -R aakash:tanoti-whatsapp .git .github app tests node_modules build
```

Run that after `.github` exists on the VPS. Ensure `aakash`, when running with
group `tanoti-whatsapp`, can read `.env` and write the production SQLite database
and its parent directory for migrations. Do not print `.env` or put it in Git.

Use `sudo visudo -f /etc/sudoers.d/tanoti-whatsapp-deploy` to allow the workflow's
noninteractive commands:

```sudoers
aakash ALL=(aakash:tanoti-whatsapp) NOPASSWD: /usr/bin/bash
aakash ALL=(root) NOPASSWD: /usr/bin/systemctl restart tanoti-whatsapp, /usr/bin/systemctl is-active --quiet tanoti-whatsapp
```

Confirm the executable paths on your VPS with `command -v bash systemctl` and
adjust the rules and script if needed. The Bash rule only permits running as
`aakash` with the application's group; it does not grant a root shell.

Keep the VPS checkout on `main` with no tracked local edits. The script stops
on uncommitted changes or diverged history and never resets or deletes them.
Back up the production database before introducing database migrations.

## Activation and verification

Commit and push `.github` to `main`. Open the repository's Actions tab and inspect
the **Build and test** workflow. Successful deployment reports the exact commit
and checks that the systemd service is active. This is a service-state check,
not a full HTTP health check. Live requests can be inspected with:

```bash
sudo journalctl -u tanoti-whatsapp -f
```

This uses the existing checkout and builds in place. It does not provide atomic
releases or automatic rollback; a failed build can leave the checkout or build
directory partially updated even though the restart is skipped. Production
database migrations are not rolled back automatically.
