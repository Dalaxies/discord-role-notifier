# Deploying the bot on Oracle Cloud Always Free

This walks through everything from a blank OCI account to a bot that survives reboots: network, VM, firewall, Node.js, systemd, logs, updates and free-tier caveats.

**Result:** one small Oracle Linux VM running the bot as an unprivileged systemd service. It makes only *outbound* connections to Discord — no inbound ports, no domain, no TLS certificate, no web server.

**Time:** ~30 minutes, most of it waiting for the account/instance.

---

## 0. Checklist before you start

- [ ] Discord application created, bot token copied
- [ ] **Server Members Intent** enabled
- [ ] Bot invited to server `1499114258007588914` with View Channels, Send Messages, Embed Links, View Audit Log
- [ ] `GUILD_ID`, `ROLE_ID` noted, and `DELIVERY` chosen (`dm` or `channel`)
- [ ] Project runs locally (`npm run doctor` passes)

If not, do [README steps 1–5](README.md#1-create-the-discord-application) first. Debugging the bot locally is much faster than debugging it through SSH.

---

## 1. Create the OCI account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Use a real email and a payment card for identity verification. Always Free resources are not charged; the card is for verification.
3. **Choose your home region carefully.** Always Free resources only exist in your home region, and the home region cannot be changed later. Pick the region closest to you (lowest SSH latency) — for example `Germany Central (Frankfurt)`, `UK South (London)`, `US East (Ashburn)` or `Australia East (Sydney)`.
4. Wait for the "your account is ready" email, then sign in to the OCI Console.

> Tip: you can create a compartment (Identity → Compartments) named `discord-bot` to keep things tidy, but the root compartment is fine for a single VM objective. This guide assumes the default/root compartment; substitute yours if you make one.

---

## 2. What "Always Free" gives you

| Resource | Always Free allowance | What this bot uses |
| --- | --- | --- |
| AMD compute | 2 × `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB RAM) | 0 or 1 |
| Arm compute | 4 OCPUs / 24 GB RAM total (`VM.Standard.A1.Flex`) | 1 OCPU / 6 GB |
| Block storage | 200 GB total | 50 GB boot volume |
| Outbound transfer | 10 TB / month | a few MB |
| VCNs | 2 (free-tier tenancies) | 1 |

Either shape runs this bot comfortably. The **Arm A1** instance is recommended because it is much faster for the same price ($0) and has plenty of RAM for future features. The `E2.1.Micro` is a fine fallback when A1 capacity is unavailable.

> **Important:** Always Free resources must be created in your **home region**. Also, Oracle may reclaim Always Free instances that stay idle — see [section 10](#10-always-free-gotchas).

---

## 3. Create the network (VCN)

1. Console menu → **Networking → Virtual Cloud Networks**.
2. **Create VCN**.
3. Name: `discord-vcn`.
4. Select **Create VCN with Internet Connectivity** (the wizard).
5. VCN CIDR: `10.0.0.0/16`; public subnet CIDR: `10.0.0.0/24`.
6. Leave the defaults for internet gateway, route table and security list, then **Create**.

This gives you a public subnet with an internet gateway and a route to the internet. The default security list allows SSH (22) and ICMP from anywhere. The bot needs **no additional ingress rules** — you do not expose any port.

**Recommended:** after the instance exists, tighten the SSH rule: Security List → Ingress Rules → edit the `0.0.0.0/0` rule for TCP 22 and replace the source with your public IP (`x.x.x.x/32`). If your ISP uses a dynamic IP, leave it open but use key-only SSH (the default) and keep the OS patched.

---

## 4. Create the VM

1. Console menu → **Compute → Instances → Create instance**.
2. **Name:** `discord-bot`.
3. **Placement:** leave the default availability domain (or see the capacity note below).
4. **Image:** **Oracle Linux 9**.
   - For `VM.Standard.A1.Flex`, pick the **aarch64** image.
   - For `VM.Standard.E2.1.Micro`, pick the **x86_64** image.
   - Use the "Always Free eligible" filter to be safe.
5. **Shape:**
   - Click **Change shape** → **Ampere** → `VM.Standard.A1.Flex`.
   - OCPUs: `2`, Memory: `12 GB`.
   - That is the whole Always Free A1 allowance (1,500 OCPU-hours and 9,000 GB-hours per month), so it must be the **only** A1 instance in the tenancy. Anything smaller is also fine; 1 OCPU / 6 GB is the leaner choice and leaves room for a second instance.
   - Fallback: **AMD** → `VM.Standard.E2.1.Micro` (1/8 OCPU, 1 GB). Expect a full `dnf update` to be painful there — add 2 GB of swap first.
6. **Boot volume:** check **Specify a custom boot volume size** and set **50 GB**. Leave the rest at defaults. (Default is ~47 GB; 50 GB is a round number and fits the 200 GB allowance.)
7. **SSH keys:** choose **Generate a key pair for me** and download the private key, *or* paste an existing public key (recommended if you already use `~/.ssh`).
8. **Networking:** accept the VCN/subnet from step 3. **Assign a public IPv4 address: Yes**.
9. **Create** and wait until the instance state is **RUNNING**.

Copy the **Public IP address** from the instance details page.

### If you get "Out of host capacity"

This is the most common Always Free stumbling block. A1 capacity varies by availability domain and region.

- Try the other availability domains in the same region.
- Try again later; capacity frees up.
- As a reliable fallback, create a `VM.Standard.E2.1.Micro` instead — it is always free and more than enough for this bot.

### SSH key on Windows

Windows 10/11 ships OpenSSH (`ssh.exe`), so PuTTY is not needed.

If you chose **Generate a key pair for me**, OCI downloads a file named like `ssh-key-2026-11-03.key`. That is an unencrypted OpenSSH private key; OCI keeps only the public half and cannot give it to you again. Treat it as the only copy.

1. Move it out of `Downloads` and give it a short name:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
   Move-Item "$env:USERPROFILE\Downloads\ssh-key-*.key" "$env:USERPROFILE\.ssh\oci_discord_bot"
   ```

2. Restrict it to your account. Windows OpenSSH refuses a key other accounts can read:

   ```powershell
   icacls "$env:USERPROFILE\.ssh\oci_discord_bot" /inheritance:r /grant:r "$(whoami):(R)"
   ```

3. Confirm it belongs to this instance. The output must match the public key shown under **Instance details → SSH keys**:

   ```powershell
   ssh-keygen -y -f "$env:USERPROFILE\.ssh\oci_discord_bot"
   ```

4. Connect:

   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\oci_discord_bot" opc@<PUBLIC_IP>
   ```

Notes:

- The private key has no passphrase, so you will not be asked for one. If you are, you are pointing at the wrong file.
- If the file begins with `PuTTY-User-Key-File`, it is PuTTY format: either use PuTTY with that file, or convert it — `puttygen key.ppk -O private-openssh -o oci_discord_bot`.
- A key downloaded from **My Profile → API Keys** is *not* an SSH key; that one is for the OCI CLI (`~/.oci/oci_api_key.pem`).

To make your own key instead:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\oci_discord_bot" -C "oci-discord-bot"
Get-Content "$env:USERPROFILE\.ssh\oci_discord_bot.pub"
```

Paste the printed public key into the instance creation form. Keep the private key private.

---

## 5. Connect and prepare the server

```powershell
ssh -i "$env:USERPROFILE\.ssh\oci_discord_bot" opc@<PUBLIC_IP>
```

- Default user on Oracle Linux images is `opc` (it has passwordless `sudo`).
- Type `yes` the first time to accept the host key.

Once connected:

```bash
# Patch the OS
sudo dnf update -y

# Use UTC in logs (optional but convenient)
sudo timedatectl set-timezone UTC

# Confirm the host clock is synchronised
timedatectl status

# Confirm outbound HTTPS works (Discord API)
curl -sI https://discord.com | head -n 1
```

### Firewall: do nothing (on purpose)

Oracle Linux 9 enables `firewalld`. Its default configuration already allows SSH, which is all you need:

```bash
sudo firewall-cmd --list-all
```

The bot only makes **outbound** connections to Discord on TCP 443. Do **not** open ports 80, 3000, 8080 or anything else. There is no web server and nothing to expose.

> If you later see a firewall tutorial telling you to run `firewall-cmd --add-port=...`, ignore it for this bot.

---

## 6. Clone the project

The source lives at <https://github.com/Dalaxies/discord-role-notifier>, so the server pulls it directly. Nothing is copied from your PC.

```bash
sudo dnf install -y git
git clone https://github.com/Dalaxies/discord-role-notifier.git ~/discord-role-notifier
cd ~/discord-role-notifier
ls
```

You should see `src`, `deploy`, `package.json`, `.env.example`, etc. The repository is public, so there is no key to add and no credential prompt.

**Keep the clone in your home directory.** The installer copies it to `/opt/discord-role-notifier` as a runtime tree owned by the `discordbot` service user, and that split is deliberate:

- `git pull` runs as `opc` with no `sudo` and no ownership complaints.
- `/opt` stays a clean runtime tree: the copy excludes `.git`, `node_modules` and `.env`.

> Do not clone straight into `/opt/discord-role-notifier`. The installer `chown`s that directory to `discordbot`, after which git refuses to operate on it ("detected dubious ownership"), and the fix is an explicit `safe.directory` exception that is easy to forget on the next rebuild.

---

## 7. Configure and install

Run the installer from the clone:

```bash
cd ~/discord-role-notifier
sudo bash deploy/install.sh
```

It creates `/opt/discord-role-notifier`, copies the app in, and — on a first run — writes a `.env` from `.env.example`. It will stop short of starting the bot because there is no token yet. Fill the file in:

```bash
sudo nano /opt/discord-role-notifier/.env
```

Set at least:

```dotenv
DISCORD_TOKEN=your-token-here
DELIVERY=dm
```

`DELIVERY=dm` is the default: the bot sends a direct message to the member. For channel delivery use `DELIVERY=channel` and set `CHANNEL_ID`; `DELIVERY=both` does both.

With `DELIVERY=dm`, the message is already `templates/welcome.md` — no configuration needed. A details embed follows it by default; to send the text on its own, add:

```dotenv
EMBED_ENABLED=false
```

To use a different file (or any file with `DELIVERY=channel`), also set `MESSAGE_TEMPLATE_FILE=path/to/message.md`.

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`, and start it:

```bash
sudo systemctl enable --now discord-role-notifier
```

From then on, every `deploy/install.sh` run restarts the service automatically because the token is present.

The installer:

1. Installs Node.js 24 LTS from NodeSource if needed (works on both x86_64 and aarch64).
2. Creates a system user `discordbot` (no login shell).
3. Copies the app to `/opt/discord-role-notifier` when run from another directory.
4. Installs production dependencies (`npm install --omit=dev`).
5. Locks down `.env` (`chmod 600`, owned by `discordbot`).
6. Installs and enables `discord-role-notifier.service` with systemd hardening (read-only system paths, private `/tmp`, no new privileges) and write access limited to `templates/` and `data/` for the dashboard.
7. Installs a nightly backup timer that archives `.env`, `templates/` and `data/` to `/var/backups/discord-role-notifier` (kept 7 days).
8. Starts the service if a token is present.

Watch it start:

```bash
sudo journalctl -u discord-role-notifier -f
```

Expected output:

```
... INFO  Logged in as Role Notifier#1234 (123456789012345678)
... INFO  Watching server "Your Server" (1499114258007588914) for role 1555015410112270458
... INFO  Role "Verified" resolved.
... INFO  Notifications will be sent as direct messages to the member.
... INFO  Members must share this server and allow "Direct messages from server members".
```

Press `Ctrl+C` to stop following logs — the service keeps running.

Check the service:

```bash
sudo systemctl status discord-role-notifier
```

You want `active (running)` and `enabled`.

### Optional: web dashboard

The bot can serve a small dashboard for picking the welcome role, editing the welcome message and watching the log live. It is off by default and only listens on `127.0.0.1`.

1. In the Developer Portal → your application → **OAuth2**:
   - copy the **Client Secret**
   - add redirect `http://localhost:3000/auth/callback`
2. Edit `.env` on the server:

   ```dotenv
   WEB_ENABLED=true
   DISCORD_CLIENT_SECRET=your-client-secret
   DISCORD_CLIENT_ID=1567382948024422531
   OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
   ```

3. Restart and open a tunnel from your machine:

   ```bash
   sudo systemctl restart discord-role-notifier
   ```

   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\oci_discord_bot" -L 3000:localhost:3000 opc@<public-ip>
   ```

   Then browse to `http://localhost:3000` and sign in with Discord. Only the server owner or members with **Manage Server** get in.

Because the tunnel ends on the server's loopback interface, you do **not** need an OCI ingress rule, a public port, or a TLS certificate. The systemd unit grants write access only to `templates/` and `data/`, which is all the dashboard needs.

> Sessions live in memory, so restarting the service signs everyone out. The bot token is never sent to the browser.

#### Publishing the dashboard over HTTPS

The tunnel needs an SSH client every time, which rules out a phone. To make the dashboard reachable from anywhere, put Caddy in front of it: Caddy gets a free Let's Encrypt certificate and proxies to the bot, which keeps listening on `127.0.0.1`.

**You need a hostname.** Discord rejects a plain-HTTP redirect URI for anything other than `localhost`, so TLS is not optional. If you do not own a domain, `sslip.io` maps any IP to a name for free: `140.238.1.2` becomes `140-238-1-2.sslip.io` (or `140.238.1.2.sslip.io`). The name is derived from the address, so it changes only if the instance's public IP does — which makes a **reserved** public IP worth attaching.

Verify the name resolves before touching the server:

```bash
getent hosts 140-238-1-2.sslip.io
```

If that prints nothing, stop here: certificate issuance cannot succeed.

**1. Allow the ports in OCI.** Console → **Networking → Virtual Cloud Networks** → your VCN → the public subnet → **Security Lists** → default list → **Add Ingress Rules**. Fill the form like this:

| Field | Value |
| --- | --- |
| Stateless | unchecked (stateful) |
| Source Type | `CIDR` |
| Source CIDR Block | `0.0.0.0/0` |
| IP Protocol | `TCP` |
| Source Port Range | `All` (leave the default) |
| Destination Port Range | `80,443` |
| Description | `Caddy: ACME + HTTPS dashboard` |

One rule covers both ports; the console accepts a comma-separated list. If your form rejects it, add two rules instead, one per port.

- **Stateless stays off.** A stateless rule permits traffic in one direction only, so the server's replies would be dropped unless you also add a mirror-image egress rule. Stateful (the default) tracks the connection and lets responses back automatically.
- **Source Port Range is the field people get wrong.** Clients connect from a random ephemeral port, so restricting it to 80/443 here blocks every connection. Only the *destination* port is fixed; source must be `All`.
- If a **Network Security Group** is attached to the instance's VNIC, the rule belongs on the NSG instead — and traffic must be allowed by both the security list and the NSG.

Port 80 is only used for the ACME challenge and the redirect to HTTPS; Caddy never serves content over it.

**2. Point the bot at its public URL.** In `/opt/discord-role-notifier/.env`:

```dotenv
WEB_ENABLED=true
WEB_HOST=127.0.0.1
OAUTH_REDIRECT_URI=https://140-238-1-2.sslip.io/auth/callback
WEB_COOKIE_SECURE=true
```

Keep `WEB_HOST=127.0.0.1`. Caddy is on the same box, so the bot never needs to accept a connection from the network — only Caddy does.

Add the same redirect URI in **Developer Portal → your app → OAuth2 → Redirects** and restart:

```bash
sudo systemctl restart discord-role-notifier
```

**3. Install Caddy:**

```bash
cd ~/discord-role-notifier
sudo bash deploy/setup-caddy.sh 140-238-1-2.sslip.io
```

The script installs Caddy, writes a `Caddyfile` that proxies to `127.0.0.1:3000`, opens 80/443 in `firewalld`, handles SELinux, and starts the unit. Pass a bare IP and it derives the `sslip.io` name for you.

**4. Check it:**

```bash
curl -sI https://140-238-1-2.sslip.io | head -n 1     # HTTP/2 200
sudo journalctl -u caddy -n 30 --no-pager             # certificate issued
```

First issuance takes a few seconds; if it fails, the journal names the reason (usually DNS, or port 80 blocked).

**What this exposes.** Ports 80 and 443 answer from the whole internet, but everything behind them still requires a Discord login with **Manage Server** on your guild. The bot adds the pieces that matter for a public listener:

- `/auth/login` and `/auth/callback` are rate limited to 20 requests per minute per client address (using `X-Forwarded-For`, but only when the request arrives from the local proxy, so it cannot be spoofed)
- `Strict-Transport-Security` is sent when the request came over HTTPS
- the bot refuses to bind to a non-loopback `WEB_HOST` at all if `DISCORD_CLIENT_SECRET` is empty

`WEB_ADMIN_IDS` *adds* users to the `Manage Server` check (useful for a co-admin without the permission); it cannot restrict access to fewer people. Keeping the guild's admin list short is the practical control.

To undo it: `sudo systemctl disable --now caddy`, delete the two ingress rules, and set `OAUTH_REDIRECT_URI` back to `http://localhost:3000/auth/callback`. The SSH tunnel keeps working the whole time, so you can never lock yourself out.

---

## 8. Test end to end

Run the preflight from the server:

```bash
cd /opt/discord-role-notifier
sudo npm run doctor
```

Then send a real test notification. For DM delivery this DMs the **server owner** by default; add `--user <ID>` to test someone else. For channel delivery it posts in the channel:

```bash
sudo npm run doctor -- --send-test
sudo npm run doctor -- --send-test --user 123456789012345678
```

Finally, in Discord:

1. Give the watched role to a test member.
2. Confirm the member receives the DM (or the channel post arrives, depending on `DELIVERY`).
3. Remove the role, then give it again — it should fire again.
4. Try assigning it from a different moderator account and confirm "Assigned by" is correct.

> If nothing arrives, `sudo journalctl -u discord-role-notifier -n 100 --no-pager` usually names the exact problem (wrong IDs, missing permission, missing intent, or — for DMs — the member's privacy setting).

---

## 9. Reboot safety, backups and log hygiene

```bash
# Confirm the service starts on boot
sudo systemctl is-enabled discord-role-notifier

# Reboot and verify it comes back by itself
sudo reboot
```

Reconnect after ~30 seconds and check:

```bash
sudo systemctl status discord-role-notifier
```

### Cap journald disk usage

The bot logs very little, but capping journald keeps a small boot volume tidy:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=200M
EOF
sudo systemctl restart systemd-journald
```

Useful commands:

```bash
sudo journalctl -u discord-role-notifier -f              # follow
sudo journalctl -u discord-role-notifier --since today   # today
sudo journalctl -u discord-role-notifier -n 200 --no-pager
sudo systemctl restart discord-role-notifier
```

### Nightly state backup

Only three things on the server are not reproducible from this guide: `.env`, `templates/` and `data/`. `install.sh` installs a systemd timer that archives exactly those every night.

```bash
sudo systemctl list-timers discord-role-notifier-backup   # when it runs next
sudo systemctl start discord-role-notifier-backup         # run it now
sudo journalctl -u discord-role-notifier-backup -n 20 --no-pager

sudo ls -lh /var/backups/discord-role-notifier
```

Archives are named `discord-role-notifier-<UTC timestamp>.tar.gz`, mode `600` in a mode `700` directory, and are pruned after 7 days. They contain the bot token, so treat them as secrets.

Tune it by overriding the service environment, or just run the script directly:

```bash
sudo APP_DIR=/opt/discord-role-notifier BACKUP_DIR=/mnt/backups KEEP_DAYS=30 \
  /usr/local/sbin/discord-role-notifier-backup
```

**A backup on the boot volume does not survive a reclaimed instance.** For that case, also copy archives off the box. The cheapest option is an Object Storage pre-authenticated request (PAR):

1. Console → **Storage → Buckets** → create a private bucket (Always Free includes 20 GB).
2. In the bucket, **Create Pre-Authenticated Request** → object write, allow uploads.
3. On the server, store the URL root (no object name) as root-only:

   ```bash
   sudo install -d -m 700 /etc/discord-role-notifier
   sudo tee /etc/discord-role-notifier/backup.env >/dev/null <<'EOF'
   OCI_PAR_URL=https://objectstorage.<region>.oraclecloud.com/p/.../n/<ns>/b/<bucket>/o/
   EOF
   sudo chmod 600 /etc/discord-role-notifier/backup.env
   ```

4. `sudo systemctl start discord-role-notifier-backup` and confirm it logs `uploaded to Object Storage`.

The script refuses to read that file if it is writable by anyone other than root, and a failed upload marks the unit failed (`exit 2`) while keeping the local archive. PARs expire — when this one does, uploads start failing and the journal says so.

### Restoring

```bash
# 1. See what you have
sudo ls -lh /var/backups/discord-role-notifier
sudo tar -tzf /var/backups/discord-role-notifier/discord-role-notifier-<stamp>.tar.gz

# 2. Stop the bot so nothing rewrites files mid-restore
sudo systemctl stop discord-role-notifier

# 3. Extract over the app directory (keeps permissions/ownership from the archive)
sudo tar -xzf /var/backups/discord-role-notifier/discord-role-notifier-<stamp>.tar.gz \
  -C /opt/discord-role-notifier

# 4. Fix ownership and start it again
sudo chown -R discordbot:discordbot /opt/discord-role-notifier
sudo chmod 600 /opt/discord-role-notifier/.env
sudo systemctl start discord-role-notifier
sudo systemctl status discord-role-notifier --no-pager
```

If the instance itself is gone, create a new one (sections 3–5), clone the project (section 6), run the installer (section 7), and only then restore the archive and restart:

```bash
sudo tar -xzf discord-role-notifier-<stamp>.tar.gz -C /opt/discord-role-notifier
sudo chown -R discordbot:discordbot /opt/discord-role-notifier
sudo systemctl restart discord-role-notifier
```

Restore *after* the installer, not before: when `install.sh` runs from outside `/opt/discord-role-notifier` it re-extracts the project and would overwrite `templates/` and `data/` with the repo copies.

---

## 10. Always Free gotchas

### Billing guardrails on Pay As You Go

Upgrading removes idle reclamation, but **OCI has no hard spending cap**. A budget only emails you; it does not stop anything. The one mechanism that actually prevents charges is a compartment quota, because it blocks the resource from being created at all.

Put the bot in its own compartment (**Governance & Administration → Tenancy Management → Compartments**), create the instance there, then add a quota policy (**Limits, Quotas and Usage → Quotas → Create Quota Policy**):

```hcl
set compute-core quota standard-a1-core-count to 2 in compartment discord-bot
set compute-memory quota standard-a1-memory-count to 12 in compartment discord-bot
set block-storage quota total-storage-gb to 200 in compartment discord-bot
set block-storage quota backup-count to 5 in compartment discord-bot
```

That caps the only two things this deployment can bill: the A1 shape size and block storage. Everything else is either free or unused.

> The **Always Free** badge disappears from the instance list after you upgrade. That is cosmetic — the allowance still applies to the first 2 OCPU / 12 GB of A1 usage per month. Confirm with Cost Analysis, not the badge.

> Compute quotas are availability-domain scoped, so a plain statement is evaluated per AD. If you want a single tenancy-wide ceiling, pin it: `... to 2 in compartment discord-bot where request.ad = '<ad-name>'`.

Then add a budget for early warning (**Billing & Cost Management → Budgets**): amount `$1`, alert at 1% of actual spend and 100% of forecast, sent to your email.

| Resource | Free allowance | This bot uses |
| --- | --- | --- |
| A1 compute | 1,500 OCPU-hours + 9,000 GB-hours per month | 2 OCPU × 744 h = 1,488; 12 GB × 744 h = 8,928 |
| Block storage | 200 GB total (boot + block) | 50 GB boot volume |
| Volume backups | 5 | none (backups are local files) |
| Outbound data | 10 TB per month | a few MB |
| Object Storage | 20 GB | backup archives, ~1 MB each |

Two habits that matter: Always Free applies **only in the home region**, and when you terminate an instance, leave **Preserve boot volume** unchecked — otherwise the orphaned volume keeps counting against the 200 GB allowance.

### Idle instance reclamation

Oracle's Always Free terms allow reclaiming compute instances that are **idle**, defined as all three over a 7-day window:

- CPU utilization at the 95th percentile below 20%
- network utilization below 20%
- memory utilization below 20% (A1 shapes only)

A Discord bot is idle by that definition. Mitigations, in order of practicality:

1. **Upgrade the account to Pay As You Go.** Always Free resources stay free after upgrading, and Oracle does not apply the idle-reclamation policy to paid accounts. You only pay for usage *above* the Always Free limits. Set a budget alert (Billing & Cost Management → Budgets) so there are no surprises, and keep the instance shape within the free allowance.
2. **Check the tenancy type first.** The policy is written for *Always Free* (self-serve) tenancies. A sponsored, corporate or employee tenancy has no `Upgrade` link and no payment method; the reclamation pipeline keys off the free-tier tenancy flag, not the "Always Free-eligible" shape label. If yours is sponsored, this rule most likely does not apply — but that is not documented publicly, so confirm with whoever administers the tenancy rather than relying on it.
3. **Accept the risk and stay reproducible.** The installer sets up a nightly backup of `.env`, `templates/` and `data/` (see [Nightly state backup](#nightly-state-backup)), and uploading it to Object Storage means a reclaimed instance is a 15-minute redeploy instead of a rebuild. Keep the code in Git and the token in a password manager as well.

> Running a CPU burner around the clock is not a good mitigation: to move the 95th-percentile CPU metric above 20% you would need many hours of sustained load per week, and it is contrary to the spirit of the free tier.

### Arm capacity

If A1 is unavailable in your home region, use `VM.Standard.E2.1.Micro`. The bot uses ~100 MB of RAM, so 1 GB is plenty.

### Keep an eye on limits

- 200 GB total block storage (boot volumes + backups).
- 10 TB/month outbound (the bot uses a few MB).
- 2 VCNs on a free-tier tenancy.

Billing → **Cost Analysis** should stay at $0 if you stay within the allowances.

---

## 11. Updating the bot

Commit and push from your Windows machine:

```powershell
git add -A
git commit -m "Describe the change"
git push
```

Then on the server:

```bash
cd ~/discord-role-notifier
git pull
sudo bash deploy/install.sh
```

`install.sh` copies the new tree into `/opt/discord-role-notifier`, preserves the existing `.env`, reinstalls dependencies and restarts the service (because a token is present). It also re-applies ownership and permissions and reinstalls the backup timer.

Two things to know about that copy step:

- **It reconciles rather than overwrites.** Every top-level entry except `.env` is deleted from `/opt` and re-extracted from the clone, so files you deleted from the repo disappear on the server too.
- **Dashboard edits do not survive an update.** If you changed the welcome message in the browser, that edit lives only in `/opt/.../templates/welcome.md` and is replaced by the repo version. Edit `templates/welcome.md` in the repo and push it instead — the dashboard is for quick tweaks, and every save is logged so you can copy the text back out. The same applies to `data/settings.json`.

If you change dependencies in `package.json`, `git pull` plus the installer is enough — `npm install --omit=dev` resolves them.

Useful extras:

```bash
git log --oneline -5      # what changed since the last pull
git diff HEAD@{1} --stat  # files touched by the last pull
```

### Rolling back

```bash
git log --oneline         # find the commit to return to
git checkout <commit>     # detached HEAD: fine for a rollback
sudo bash deploy/install.sh
git checkout main         # when you want to move forward again
```

Or revert properly and push, so the rollback is itself in the history:

```powershell
git revert <commit>
git push
```

---

## 12. Optional: run it in Docker instead

Only if you prefer containers. Skip this if you used `install.sh` — do not run both.

```bash
# Install Docker Engine on Oracle Linux 9
sudo dnf install -y dnf-utils
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

sudo systemctl enable --now docker
sudo usermod -aG docker opc
# log out and back in for the group change

cd /opt/discord-role-notifier
sudo docker compose -f deploy/docker-compose.yml up -d --build
sudo docker compose -f deploy/docker-compose.yml logs -f
```

Notes:

- Do **not** publish ports in the compose file; the bot only needs outbound access.
- The compose file reads `../.env` and caps container logs at 3 × 10 MB.
- The container runs as the unprivileged `node` user.
- If you use Docker, disable the systemd service: `sudo systemctl disable --now discord-role-notifier`.

---

## 13. Security checklist

- [ ] `.env` is mode `600` and owned by `discordbot` (`sudo ls -l /opt/discord-role-notifier/.env`)
- [ ] Security list SSH ingress restricted to your IP where practical
- [ ] No inbound application ports open — **or**, if you published the dashboard: only 80 and 443, Caddy in front, `WEB_HOST=127.0.0.1`, `WEB_COOKIE_SECURE=true`
- [ ] `sudo ss -ltnp | grep 3000` shows `127.0.0.1:3000`, never `0.0.0.0:3000`
- [ ] OS patched (`sudo dnf upgrade -y` monthly; reboot when the kernel updates)
- [ ] Bot permissions minimal; token never committed
- [ ] Dashboard reached through an SSH tunnel, or behind HTTPS with a login configured (never both `0.0.0.0` and an empty `DISCORD_CLIENT_SECRET`)
- [ ] Budget alert configured if you upgrade to Pay As You Go
- [ ] Token rotated immediately if it is ever exposed
- [ ] Backup timer active (`systemctl list-timers discord-role-notifier-backup`) and, if used, the Object Storage PAR is current
- [ ] Backup archives are treated as secrets (they contain `.env`)

Optional automatic security updates:

```bash
sudo dnf install -y dnf-automatic
sudo sed -i 's/^apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer
```

Kernel updates still require a reboot; schedule one during a quiet period.

---

## 14. Troubleshooting

### SSH

| Problem | Fix |
| --- | --- |
| `Permission denied (publickey)` | Wrong private key, or the instance was created with a different public key. You cannot add a key without console access; if needed, use the OCI Console's instance console connection. |
| Connection times out | Security list has no ingress rule for TCP 22 from your IP, or you are using the wrong IP. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | You rebuilt the instance at the same IP. Remove the old key: `ssh-keygen -R <IP>`. |
| Private key permissions warning (WSL/macOS) | `chmod 600 ~/.ssh/oci_discord_bot` |
| `Permissions for '…' are too open` on Windows | `icacls "$env:USERPROFILE\.ssh\oci_discord_bot" /inheritance:r /grant:r "$(whoami):(R)"` |
| `Load key …: invalid format` | Wrong file (a `.pub`, a `.ppk`, or the API key). Derive the public half with `ssh-keygen -y -f <key>` to check. |

### Installer / service

| Symptom | Fix |
| --- | --- |
| `npm: command not found` | Node install failed. Run `node -v`; re-run `curl -fsSL https://rpm.nodesource.com/setup_24.x \| sudo bash -` then `sudo dnf install -y nodejs`. |
| `status=203/EXEC` | `ExecStart` path is wrong. Check `which node` (should be `/usr/bin/node`) and edit the unit. |
| `status=1/FAILURE` with config error | `sudo journalctl -u discord-role-notifier -n 50 --no-pager` shows the exact missing setting. |
| Service keeps restarting | Usually an invalid token or missing intent. Fix `.env`, then `sudo systemctl restart discord-role-notifier`. |
| Works manually, not as a service | Environment differs: systemd does not load your shell profile. Everything must come from `.env`. |
| Permission denied reading files | `sudo chown -R discordbot:discordbot /opt/discord-role-notifier` and `sudo chmod 700 /opt/discord-role-notifier`. |

### Git and updates

| Symptom | Fix |
| --- | --- |
| `git: command not found` | `sudo dnf install -y git`. |
| `detected dubious ownership in repository` | You are running git on a tree the installer chowned to `discordbot`. Clone to `~/discord-role-notifier` and let `/opt` be a copy (section 6). If you must keep a repo in `/opt`, add `git config --global --add safe.directory /opt/discord-role-notifier`. |
| `Permission denied` on `git pull` | Same cause: the working tree belongs to `discordbot`. Pull in the home-directory clone instead. |
| Dashboard edits reverted after `git pull` | Expected — the installer re-extracts `templates/` from the repo. Commit the change in the repo, or copy the text back from the dashboard log. |
| `git pull` reports local changes it will not overwrite | The clone should never be edited on the server. `git stash` or `git checkout -- .`, then pull. |

### Public HTTPS (Caddy)

| Symptom | Fix |
| --- | --- |
| Certificate never issues | DNS must resolve to this box *before* Caddy starts. `getent hosts <name>`, and `dig +short <name>`. Fix DNS, then `sudo systemctl reload caddy`. |
| `curl https://…` times out | Ports 80/443 are not open in the OCI security list, or `firewall-cmd --list-all` lacks `http`/`https`. |
| `502 Bad Gateway` from Caddy | The bot is not listening on `127.0.0.1:3000`: check `WEB_ENABLED=true` and `systemctl status discord-role-notifier`. |
| `502` but the bot is up | SELinux blocking the proxy: `sudo ausearch -m avc -ts recent`, then `sudo setsebool -P httpd_can_network_connect on`. |
| Login loops back with `?error=state` | Cookies are not coming back. You are on `http://` or a different hostname than `OAUTH_REDIRECT_URI`, or `WEB_COOKIE_SECURE=true` while browsing plain HTTP. |
| `?error=login_failed` | The redirect URI in the Developer Portal does not match `OAUTH_REDIRECT_URI` character for character, including `https` and the trailing path. |
| Still reachable on port 3000 from outside | It should not be. `sudo ss -ltnp \| grep 3000` must show `127.0.0.1:3000`, never `0.0.0.0:3000`. |
| `429 Too many sign-in attempts` | The rate limiter, working as intended. Wait a minute. It keys on `X-Forwarded-For` from the local proxy, so each visitor gets their own budget. |

### Web dashboard

| Symptom | Fix |
| --- | --- |
| Connection refused on port 3000 | The tunnel is not open, `WEB_ENABLED` is false, or the bot failed to start the dashboard — check `journalctl`. |
| "Login is not configured" | `DISCORD_CLIENT_SECRET` is missing, or the bot was not restarted after adding it. |
| `invalid_client` / `invalid_grant` from Discord | Client secret is wrong, or `OAUTH_REDIRECT_URI` does not exactly match the portal redirect. |
| `redirect_uri` error page from Discord | Add `http://localhost:3000/auth/callback` under OAuth2 → Redirects. |
| `error=not_admin` | That account lacks **Manage Server**; use the owner account or add the ID to `WEB_ADMIN_IDS`. |
| `Permission denied` when saving | `sudo chown -R discordbot:discordbot /opt/discord-role-notifier/templates /opt/discord-role-notifier/data`. |
| Signed out after every restart | Expected: sessions are in memory only. |

### Discord behaviour

| Symptom | Fix |
| --- | --- |
| Bot online, no notification | `sudo npm run doctor` in `/opt/discord-role-notifier`. Check `DELIVERY`, role/guild IDs, and — for channel mode — the channel ID and permissions. |
| Member never receives a DM | Their Discord **Privacy & Safety → Direct messages from server members** setting is off, or they don't share the server. The log shows error `50007`; use `DELIVERY=both` if you need a channel copy. |
| `Used disallowed intents` | Enable **Server Members Intent** in the Developer Portal. |
| `Missing Access` / `Unknown Channel` | Only affects channel delivery: re-invite the bot or grant View Channel on that channel. |
| "Assigned by: Unknown" | Give the bot **View Audit Log**, or set `LOOKUP_AUDIT_LOG=false` to hide the field. |
| Two notifications | Two instances are running (local laptop + server). Stop one. |

### Capacity

| Symptom | Fix |
| --- | --- |
| `Out of host capacity` for A1 | Retry later, try another availability domain, or use `VM.Standard.E2.1.Micro`. |
| Instance reclaimed | Rebuild from this guide. Keep code in Git and `.env` in a password manager. |

---

## 15. What it costs

Within the Always Free allowances described in [section 2](#2-what-always-free-gives-you), this deployment costs **$0/month**:

- 1 × A1 OCPU + 6 GB RAM (or a free E2.1.Micro)
- 50 GB boot volume
- A few MB of egress

Check **Billing → Cost Analysis** after a day and set a budget alert. The main ways to accidentally exceed free limits are creating extra instances, extra boot volumes/backups, or leaving resources in a second region (Always Free only applies to the home region).

---

## 16. Rebuild-from-scratch summary

If you ever need to recreate it:

```text
1. VCN with internet connectivity (public subnet)
2. Oracle Linux 9, A1.Flex 2 OCPU / 12 GB, 50 GB boot, public IPv4, SSH key
3. ssh opc@IP
4. git clone https://github.com/Dalaxies/discord-role-notifier.git ~/discord-role-notifier
5. cd ~/discord-role-notifier && sudo bash deploy/install.sh
6. edit /opt/discord-role-notifier/.env (token, delivery, channel ID if needed)
7. sudo systemctl enable --now discord-role-notifier
8. sudo journalctl -u discord-role-notifier -f
```
