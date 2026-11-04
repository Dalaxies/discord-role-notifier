#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Publishes the dashboard over HTTPS with Caddy.
#
# Caddy terminates TLS with a free Let's Encrypt certificate and proxies to the
# bot, which keeps listening on 127.0.0.1:3000. Caddy becomes the only process
# reachable from the internet.
#
# Usage:
#   sudo bash deploy/setup-caddy.sh 140.238.1.2
#   sudo bash deploy/setup-caddy.sh 140-238-1-2.sslip.io
#   sudo bash deploy/setup-caddy.sh bot.example.com
#
# A bare IPv4 address is turned into a free sslip.io name that resolves back to
# it, so no domain is needed.
#
# Two steps are still yours:
#   1. Allow TCP 80 and 443 in the OCI subnet security list (or NSG).
#   2. Set OAUTH_REDIRECT_URI=https://<host>/auth/callback in .env and add the
#      same URI in Developer Portal -> OAuth2 -> Redirects.
# ---------------------------------------------------------------------------
set -euo pipefail

PUBLIC_HOST="${1:-}"
UPSTREAM_PORT="${2:-3000}"
APP_DIR=/opt/discord-role-notifier
CADDYFILE=/etc/caddy/Caddyfile

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/setup-caddy.sh <hostname>" >&2
  exit 1
fi

if [[ -z "${PUBLIC_HOST}" ]]; then
  echo "Usage: sudo bash deploy/setup-caddy.sh <hostname> [upstream-port]" >&2
  echo "Example: sudo bash deploy/setup-caddy.sh 140.238.1.2" >&2
  exit 1
fi

if [[ "${PUBLIC_HOST}" == *"://"* || "${PUBLIC_HOST}" == */* || "${PUBLIC_HOST}" == *:* ]]; then
  echo "Pass only the hostname: no scheme, port or path (got \"${PUBLIC_HOST}\")." >&2
  exit 1
fi

# A bare IP cannot get a certificate, but sslip.io maps <ip-with-dashes>.sslip.io
# back to it, which can.
if [[ "${PUBLIC_HOST}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  PUBLIC_HOST="${PUBLIC_HOST//./-}.sslip.io"
  echo "==> Using ${PUBLIC_HOST} for that address"
fi

echo "==> Checking DNS for ${PUBLIC_HOST}"
RESOLVED="$(getent hosts "${PUBLIC_HOST}" | awk 'NR==1 {print $1}')" || true
if [[ -z "${RESOLVED}" ]]; then
  echo "!! ${PUBLIC_HOST} does not resolve yet. Certificate issuance will fail until it does." >&2
else
  echo "    resolves to ${RESOLVED}"
fi

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  dnf install -y 'dnf-command(copr)' >/dev/null 2>&1 || true
  dnf copr enable -y @caddy/caddy >/dev/null
  dnf install -y caddy
fi

echo "==> Writing ${CADDYFILE}"
install -d -m 755 /etc/caddy
cat >"${CADDYFILE}" <<EOF
# Managed by deploy/setup-caddy.sh -- re-run the script to change the hostname.
# The bot itself sets CSP, X-Frame-Options and friends; this only adds the
# transport-layer pieces it cannot know about.
${PUBLIC_HOST} {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}

	reverse_proxy 127.0.0.1:${UPSTREAM_PORT}
}
EOF

echo "==> Validating configuration"
caddy validate --adapter caddyfile --config "${CADDYFILE}" >/dev/null

echo "==> Opening 80/443 in firewalld"
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
else
  echo "    firewalld is not running, skipping"
fi

# Caddy runs in its own SELinux domain and reaches the bot over loopback.
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" == "Enforcing" ]]; then
  echo "==> Allowing the proxy to reach the bot under SELinux"
  setsebool -P httpd_can_network_connect on >/dev/null 2>&1 || true
fi

echo "==> Starting Caddy"
systemctl enable caddy >/dev/null
systemctl restart caddy

sleep 3

if ! systemctl is-active --quiet caddy; then
  echo
  echo "!! Caddy failed to start:" >&2
  systemctl --no-pager --lines=20 status caddy >&2 || true
  exit 1
fi

echo
echo "Caddy is running. Next:"
echo
echo "  1. Allow TCP 80 and 443 in the OCI security list for the subnet."
echo "  2. In ${APP_DIR}/.env set:"
echo "       OAUTH_REDIRECT_URI=https://${PUBLIC_HOST}/auth/callback"
echo "       WEB_COOKIE_SECURE=true"
echo "     then: sudo systemctl restart discord-role-notifier"
echo "  3. Add https://${PUBLIC_HOST}/auth/callback under"
echo "     Developer Portal -> your app -> OAuth2 -> Redirects."
echo "  4. Check the certificate (may take a minute the first time):"
echo "       curl -sI https://${PUBLIC_HOST} | head -n 1"
echo "       sudo journalctl -u caddy -n 30 --no-pager"
echo
