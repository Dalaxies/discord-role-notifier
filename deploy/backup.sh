#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Archives the bot's mutable state so a lost or reclaimed instance can be
# rebuilt quickly. Nothing here is required for the bot to run.
#
# The archive contains secrets (.env), so it is written with mode 600 into a
# mode 700 directory.
#
# Local use (sudo, because .env is mode 600 and owned by discordbot):
#   sudo bash deploy/backup.sh
#   sudo BACKUP_DIR=/tmp/backups KEEP_DAYS=3 bash deploy/backup.sh
#
# Installed as a nightly systemd timer by deploy/install.sh. To also copy the
# archive to OCI Object Storage, create /etc/discord-role-notifier/backup.env
# containing OCI_PAR_URL=<pre-authenticated request URL>, mode 600.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/discord-role-notifier}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/discord-role-notifier}
KEEP_DAYS=${KEEP_DAYS:-7}
CONFIG_FILE=${CONFIG_FILE:-/etc/discord-role-notifier/backup.env}

umask 077

if [[ ! -d "${APP_DIR}" ]]; then
  echo "backup: ${APP_DIR} does not exist" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Only the things that are not reproducible from the project archive / .env.example.
items=()
for item in .env templates data; do
  [[ -e "${APP_DIR}/${item}" ]] && items+=("${item}")
done

if [[ ${#items[@]} -eq 0 ]]; then
  echo "backup: nothing to archive in ${APP_DIR}" >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="${BACKUP_DIR}/discord-role-notifier-${stamp}.tar.gz"

tar -czf "${archive}" -C "${APP_DIR}" "${items[@]}"
gzip -t "${archive}"
chmod 600 "${archive}"

# Prune old local archives. -mtime is in whole 24-hour periods.
pruned=$(find "${BACKUP_DIR}" -maxdepth 1 -type f \
  -name 'discord-role-notifier-*.tar.gz' -mtime +"${KEEP_DAYS}" -print -delete | wc -l)

echo "backup: ${archive} ($(du -h "${archive}" | cut -f1)), kept ${KEEP_DAYS} days, pruned ${pruned}"

# Optional off-instance copy. This is what matters if the instance itself is
# reclaimed: a backup on the same boot volume disappears with it.
if [[ -f "${CONFIG_FILE}" ]]; then
  mode=$(stat -c '%a' "${CONFIG_FILE}")
  if (( 8#${mode} & 8#022 )); then
    echo "backup: refusing to read ${CONFIG_FILE}: mode ${mode} is writable by group/other" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"

  if [[ -n "${OCI_PAR_URL:-}" ]]; then
    target="${OCI_PAR_URL%/}/$(basename "${archive}")"

    if curl -fsS --max-time 180 -X PUT --upload-file "${archive}" "${target}" >/dev/null; then
      echo "backup: uploaded to Object Storage"
    else
      echo "backup: local archive is fine, but the Object Storage upload failed" >&2
      echo "backup: check OCI_PAR_URL in ${CONFIG_FILE} and that the PAR has not expired" >&2
      exit 2
    fi
  fi
fi
