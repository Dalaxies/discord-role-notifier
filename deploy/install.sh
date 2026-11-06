#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Installs the Discord role notifier on Oracle Linux 9 / RHEL-compatible hosts
# and registers it as a systemd service.
#
# Usage (from the project directory):
#   sudo bash deploy/install.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Anything this script creates is root-only by default. The .env backup below
# contains the bot token, and root's usual umask of 022 would make it readable
# by every account on the box for the duration of the install.
umask 077

APP_DIR=/opt/discord-role-notifier
SERVICE_NAME=discord-role-notifier
SERVICE_USER=discordbot
NODE_MAJOR=24

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Dashboard-managed files live in templates/ and data/. By default they are
# carried across an upgrade, so editing the welcome message in the browser is
# not undone by the next `git pull` + install. --reset opts back in to taking
# the repository versions.
RESET_STATE=0
for arg in "$@"; do
  case "${arg}" in
    --reset|--reset-state) RESET_STATE=1 ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: sudo bash deploy/install.sh [--reset]" >&2
      exit 1
      ;;
  esac
done

echo "==> Checking Node.js"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "    Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  dnf install -y nodejs
fi
echo "    Node $(node --version), npm $(npm --version)"

echo "==> Creating service user ${SERVICE_USER}"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /sbin/nologin "${SERVICE_USER}"
fi

if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
  echo "==> Copying application to ${APP_DIR}"
  mkdir -p "${APP_DIR}"

  # Keep an existing .env across upgrades. It is also excluded from the delete
  # below and from the tar, so this copy is belt-and-braces: if anything goes
  # wrong mid-install, the original is still in /tmp.
  if [[ -f "${APP_DIR}/.env" ]]; then
    cp -p "${APP_DIR}/.env" /tmp/discord-role-notifier.env.bak
    echo "    Keeping the existing ${APP_DIR}/.env"
  else
    echo "    No existing .env found; one will be created from .env.example"
  fi

  # Snapshot the dashboard-managed trees before the delete below. Restoring
  # them after the tar extract keeps local edits while still adding any new
  # files that the repository introduced.
  STATE_BACKUP=""
  if [[ ${RESET_STATE} -eq 0 && ( -d "${APP_DIR}/templates" || -d "${APP_DIR}/data" ) ]]; then
    STATE_BACKUP=$(mktemp -d /tmp/discord-role-notifier-state.XXXXXX)
    for item in templates data; do
      [[ -d "${APP_DIR}/${item}" ]] && cp -a "${APP_DIR}/${item}" "${STATE_BACKUP}/"
    done
    echo "    Preserving the existing templates/ and data/"
  fi

  find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
  tar -C "${SOURCE_DIR}" \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=.env \
    --exclude=bot.tgz \
    -cf - . | tar -C "${APP_DIR}" -xf -

  # Copy the snapshot back over the fresh tree. Files added by the repository
  # are untouched; files the dashboard changed keep the local version.
  if [[ -n "${STATE_BACKUP}" ]]; then
    for item in templates data; do
      if [[ -d "${STATE_BACKUP}/${item}" ]]; then
        mkdir -p "${APP_DIR}/${item}"
        cp -a "${STATE_BACKUP}/${item}/." "${APP_DIR}/${item}/"
      fi
    done
    rm -rf "${STATE_BACKUP}"
    echo "    Restored the local templates/ and data/"
  fi

  if [[ -f /tmp/discord-role-notifier.env.bak ]]; then
    mv /tmp/discord-role-notifier.env.bak "${APP_DIR}/.env"
    echo "    Restored ${APP_DIR}/.env"
  fi
fi

echo "==> Installing production dependencies"
cd "${APP_DIR}"
npm install --omit=dev --no-audit --no-fund

# Runtime state for the dashboard (ReadWritePaths in the unit needs it to exist).
mkdir -p "${APP_DIR}/data"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo
  echo "!! ${APP_DIR}/.env was created from .env.example."
  echo "!! Add DISCORD_TOKEN, then run: sudo systemctl restart ${SERVICE_NAME}"
  echo "!! LOG_CHANNEL_ID already defaults to 1499140628817379459; change it in .env or the dashboard."
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"
chmod 700 "${APP_DIR}"

echo "==> Installing systemd unit"
install -m 644 "${APP_DIR}/deploy/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"

# Nightly backup of .env, templates/ and data/. The script runs as root (it has
# to read the mode-600 .env), so it is installed root-owned outside the app
# directory: the bot's user must not be able to change what root executes.
echo "==> Installing nightly backup timer"
install -d -m 700 -o root -g root /var/backups/discord-role-notifier
install -m 755 -o root -g root "${APP_DIR}/deploy/backup.sh" /usr/local/sbin/${SERVICE_NAME}-backup
install -m 644 "${APP_DIR}/deploy/${SERVICE_NAME}-backup.service" "/etc/systemd/system/${SERVICE_NAME}-backup.service"
install -m 644 "${APP_DIR}/deploy/${SERVICE_NAME}-backup.timer" "/etc/systemd/system/${SERVICE_NAME}-backup.timer"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}-backup.timer" >/dev/null

if grep -Eq '^DISCORD_TOKEN=.+' "${APP_DIR}/.env"; then
  echo "==> Enabling and starting ${SERVICE_NAME}"
  systemctl enable "${SERVICE_NAME}" >/dev/null
  systemctl restart "${SERVICE_NAME}"
  sleep 2
  systemctl --no-pager --lines=0 status "${SERVICE_NAME}" || true
else
  echo
  echo "==> Set DISCORD_TOKEN in ${APP_DIR}/.env, then run:"
  echo "    sudo systemctl enable --now ${SERVICE_NAME}"
fi

echo
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo "  sudo systemctl list-timers ${SERVICE_NAME}-backup"
echo "  sudo systemctl start ${SERVICE_NAME}-backup   # back up right now"
echo "  sudo bash deploy/install.sh --reset           # replace templates/ and data/ with the repo versions"
