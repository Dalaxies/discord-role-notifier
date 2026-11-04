# Discord Role Notifier

Sends a **direct message (DM)** to a member whenever they are given a specific role. Channel posting is also supported, or both at once, via `DELIVERY`.

| Setting | Value |
| --- | --- |
| Server (guild) ID | `1499114258007588914` |
| Role ID | `1555015410112270458` |
| Runtime | Node.js 20+ (24 LTS recommended) |
| Library | discord.js 14 |
| Hosting | Any small Linux VM — see [DEPLOY-OCI.md](DEPLOY-OCI.md) |

Example DM — the default `templates/welcome.md`, abridged:

> ## <:Ascend:1499180592699543582>  WELCOME TO ASCEND
> We're glad to have you as part of the guild. <:Alliance:1567391204654710834> Added roles to give you full access to guild channels.
>
> ### 🛡️ GET STARTED
> ### **1. Set Up Your Roles**
> https://discord.com/channels/1499114258007588914/1555116745793212497
> Choose your Discord roles to access relevant channels, …
>
> **Welcome to Ascend. Your journey starts here.**

That message is sent verbatim from `templates/welcome.md` and re-read on every notification, so edits take effect without a restart. A details embed (role, assigner, account age) follows it by default; set `EMBED_ENABLED=false` to send the text alone.

The message text, embed title and colour are configurable, and a preflight script (`npm run doctor`) checks the token, IDs and permissions before you deploy.

> **DM requirements:** bots can only DM users who **share a server** with them, and the member must have **"Direct messages from server members"** enabled (Discord → Privacy & Safety). If a member has DMs disabled, the bot logs a warning and cannot deliver; use `DELIVERY=both` if you want a channel copy as a safety net. Channel mentions like `<#123…>` can also fail to render as clickable links inside a DM — if that happens, use `https://discord.com/channels/<guild_id>/<channel_id>` instead.

---

## How it works

```
Discord Gateway  ──(outbound WSS 443)──►  Node.js bot  ──►  Discord REST API (send message)
```

- The bot opens an **outbound** connection to Discord. It needs **no inbound ports, no domain name and no public web server**.
- It listens for `guildMemberUpdate`, compares the member's roles before/after the event, and reacts only when the watched role was **added**.
- It then sends the notification by DM, to a channel, or both.
- Optionally it reads the server audit log to show **who** assigned the role.
- It runs as a single process. Memory use is roughly 80–150 MB.

---

## 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and click **New Application**. Name it something like `Role Notifier`.
2. Go to **Bot** in the sidebar.
3. Click **Reset Token** and copy the token. This is a password — never commit it or paste it in public.
4. Under **Privileged Gateway Intents**, enable **Server Members Intent**. The bot will not receive role-change events without it.
   - *Message Content Intent* is **not** needed.
5. Save changes.

## 2. Invite the bot to your server

Easiest: after configuring `.env`, run `npm run doctor`. It prints an invite URL containing the exact permissions the bot needs.

Or build it manually:

1. **OAuth2 → URL Generator**
2. Scopes: `bot`
3. Bot permissions:
   - View Audit Log (for the "Assigned by" field; skip if `LOOKUP_AUDIT_LOG=false`)
   - Only if you use `DELIVERY=channel` or `both`: View Channels, Send Messages, Embed Links
4. Open the generated URL, pick server `1499114258007588914`, and authorize.

The equivalent permissions integer is `85120` (a superset that also covers channel delivery):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=85120&scope=bot
```

## 3. Collect the IDs

In Discord: **User Settings → Advanced → Developer Mode** → ON. Then:

- Right-click the server → **Copy Server ID** → `GUILD_ID`
- Right-click the role → **Copy Role ID** → `ROLE_ID`
- For channel delivery only: right-click the target channel → **Copy Channel ID** → `CHANNEL_ID`

The defaults are already set for server `1499114258007588914` and role `1555015410112270458`.

---

## 4. Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Minimum required values (DM delivery is the default):

```dotenv
DISCORD_TOKEN=your-bot-token
DELIVERY=dm
```

If you want channel delivery instead, also set `CHANNEL_ID` and change `DELIVERY` to `channel` (or `both`).

`GUILD_ID` and `ROLE_ID` default to the values above but are explicit in `.env.example` so they are easy to change.

### All settings

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Required.** Bot token from the Developer Portal. |
| `GUILD_ID` | `1499114258007588914` | Server to watch. |
| `ROLE_ID` | `1555015410112270458` | Role that triggers a notification when added. |
| `DELIVERY` | `dm` | `dm`, `channel` or `both`. |
| `CHANNEL_ID` | *(empty)* | Channel for `channel`/`both`. Empty = the server's system channel. Not used for DM-only. |
| `MESSAGE_TEMPLATE` | `templates/welcome.md` for DM | Text above the embed. An explicit value here overrides the bundled file. Empty = embed only (no ping). |
| `MESSAGE_TEMPLATE_FILE` | `templates/welcome.md` for `dm`/`both`, *(unset)* for `channel` | Path to a file containing the message (relative to the project directory). Takes precedence over `MESSAGE_TEMPLATE`. Ideal for multi-line messages. |
| `EMBED_ENABLED` | `true` | Send the details embed after the text. Set `false` to send only your message. |
| `EMBED_TITLE` | `Role assigned` | Embed title. |
| `EMBED_COLOR` | `#57F287` | Embed colour, hex. |
| `MENTION_MEMBER` | `true` | Allow channel posts to ping the member. No effect on DMs. |
| `IGNORE_BOTS` | `true` | Ignore role changes on bot accounts. |
| `LOOKUP_AUDIT_LOG` | `true` | Show who assigned the role (needs View Audit Log). |
| `DRY_RUN` | `false` | Log events without sending messages. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. |

> **Note:** template precedence is `MESSAGE_TEMPLATE_FILE` → `MESSAGE_TEMPLATE` → built-in default. If `MESSAGE_TEMPLATE` is defined in `.env` (even as an empty value), it overrides the delivery-aware default, so delete or comment the line to get the default back. The template file is re-read **on every notification**, so edits take effect immediately — no restart needed.

### Multi-line messages

DM delivery already sends `templates/welcome.md` verbatim, so multi-line Markdown is the default and needs no configuration. To use a different file — or any file with `DELIVERY=channel` — point at it:

```dotenv
MESSAGE_TEMPLATE_FILE=templates/welcome.md
EMBED_ENABLED=false
```

An example is included at `templates/welcome.md`. The file preserves newlines and Markdown, supports the same placeholders, and is limited to Discord's 2000-character message limit.

The file is re-read each time a notification is sent, so you can edit it while the bot runs — the next DM uses the new text. A bad edit can't break delivery: if the file is missing, empty or over 2000 characters, the bot logs a warning and reuses the last version that loaded successfully. On the server:

```bash
sudo nano /opt/discord-role-notifier/templates/welcome.md
```

No restart required. Only changes to `.env` (or the code) still need `sudo systemctl restart discord-role-notifier`.

Quoted multi-line values also work in `.env`, but a file is easier to edit and diff.

### Template placeholders

`{user}` (mention) · `{username}` · `{displayName}` · `{server}` · `{role}` (mention) · `{roleName}` · `{memberCount}` · `{assignedBy}` · `{userId}`

Unknown placeholders are left untouched, so a typo shows up as `{typo}` in Discord rather than `undefined`.

---

## 5. Run it locally (optional but recommended)

1. Install Node.js LTS (24.x):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

   Re-open your terminal afterwards so `node` and `npm` are on `PATH`.

   > **PowerShell note:** if `npm` is "not recognized", the terminal was opened before Node was installed — close it and open a new one. If you see *"npm.ps1 cannot be loaded because running scripts is disabled"*, either use `npm.cmd` instead of `npm`, or allow local scripts once with:
   >
   > ```powershell
   > Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   > ```

2. Install dependencies and check everything:

   ```powershell
   npm install
   npm run doctor
   ```

3. Send a test message. For DM delivery this DMs the **server owner** by default; pass `--user <id>` to test someone else. For channel delivery it posts in the configured channel:

   ```powershell
   npm run doctor -- --send-test
   npm run doctor -- --send-test --user 123456789012345678
   ```

4. Start the bot:

   ```powershell
   npm start
   ```

5. In Discord, assign the role to a test member. The console should show the event and the member should receive a DM (or the channel post, depending on `DELIVERY`). Remove the role and assign it again to confirm it fires on each new assignment.

`npm run dev` restarts automatically when source files change.

### Sending the message on demand

`scripts/send-welcome.mjs` sends the configured message to specific users without waiting for a role change — useful for backfilling existing members:

```powershell
npm run send-welcome -- --dry-run 121531556564172802 133054172231761921
npm run send-welcome -- 121531556564172802 133054172231761921
```

It uses the same template (`MESSAGE_TEMPLATE_FILE` or `MESSAGE_TEMPLATE`) and reports per-ID success or failure (for example `50007` when a user does not accept server DMs). `--dry-run` only checks membership and prints the length.

---

## 6. Web dashboard (optional)

A small dashboard lets a server admin pick the welcome role, edit the welcome message and watch the bot's log live. Login uses Discord OAuth2; only the server owner or members with **Manage Server** can sign in.

```text
┌──────────────────────────────────────────────────────────┐
│  Ascend   Role notifier                 Ascend  Admin  ⎋ │
├───────────────────────────┬──────────────────────────────┤
│  Welcome role             │  Activity                    │
│  [ WoW Forever      ▾ ]   │  12:01:44 INFO  DM sent …    │
│  [ Save role ]            │  12:01:44 INFO  Role added … │
│                           │  12:02:10 WARN  50007 …      │
│  Welcome message          │                              │
│  ┌─────────────────────┐  │  [ All levels ▾ ] [ Pause ]  │
│  │ ## WELCOME TO …     │  │                              │
│  └─────────────────────┘  │                              │
│  [ Save message ]  912/2000                              │
└───────────────────────────┴──────────────────────────────┘
```

### One-time Discord setup

1. Developer Portal → your application → **OAuth2**.
2. Copy the **Client Secret**.
3. Under **Redirects**, add exactly `http://localhost:3000/auth/callback`.
4. Save changes.

### Configure

```dotenv
WEB_ENABLED=true
DISCORD_CLIENT_ID=1567382948024422531
DISCORD_CLIENT_SECRET=your-client-secret
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
```

`DISCORD_CLIENT_ID` may be left empty — it falls back to the bot's own ID. The redirect URI must match the portal entry character for character.

Restart the bot, then open <http://localhost:3000>.

### What it can do

| Panel | Behaviour |
| --- | --- |
| **Welcome role** | Lists every role in the server. Saving writes `data/settings.json` and applies to the next role assignment — no restart. |
| **Welcome message** | Edits `MESSAGE_TEMPLATE_FILE` in place. The next DM uses it (the file is re-read per send). |
| **Activity** | Live log stream over SSE, with level filter and pause. Last 500 lines are kept in memory. |

Sessions are stored in memory, so a restart signs everyone out. The bot token never reaches the browser.

### Remote access (recommended)

The dashboard binds to `127.0.0.1`, which means it is only reachable from the machine it runs on — no firewall change, no public port, no TLS certificate:

```bash
ssh -i ~/.ssh/oci_discord_bot -L 3000:localhost:3000 opc@<public-ip>
```

Then open `http://localhost:3000` on your own machine; the tunnel carries it to the server's loopback.

### Public HTTPS (optional)

To reach it from anywhere — including a phone — `deploy/setup-caddy.sh` puts Caddy in front with an automatic Let's Encrypt certificate:

```bash
sudo bash deploy/setup-caddy.sh 140.238.1.2
```

A bare IP is converted to a free `140-238-1-2.sslip.io` name, so no domain is needed. Then set `OAUTH_REDIRECT_URI=https://<host>/auth/callback` (and register the same URI in the portal), `WEB_COOKIE_SECURE=true`, and allow TCP 80/443 in the OCI security list. Keep `WEB_HOST=127.0.0.1`: only Caddy is exposed.

Discord requires HTTPS for a non-localhost redirect URI, so a certificate is a prerequisite, not a nicety. Full walkthrough in [DEPLOY-OCI.md](DEPLOY-OCI.md#publishing-the-dashboard-over-https).

### Security

- Scopes are `identify` and `guilds` only; the OAuth access token is never exposed to the page.
- The login callback uses a state value bound to an HttpOnly cookie; all changes require a per-session CSRF token and a same-origin request.
- Only the owner, members with Manage Server, or IDs in `WEB_ADMIN_IDS` can sign in.
- `/auth/login` and `/auth/callback` are rate limited per client address (20/min), so a public deployment cannot be hammered into exhausting the OAuth client.
- The bot refuses to bind to a non-loopback host at all when no client secret is configured.
- All edits are validated server-side and written to the activity log with the username.

---

## 7. Deploy to Oracle Cloud (Always Free)

Follow [DEPLOY-OCI.md](DEPLOY-OCI.md). It covers:

- creating the free-tier VM and network
- SSH from Windows
- cloning this repository on the server
- the included one-command installer (`deploy/install.sh`) that sets up Node.js, a dedicated service user, a hardened systemd service, and a nightly backup of `.env`, `templates/` and `data/`
- updating with `git pull`, logs, restoring a backup, and billing guardrails

On the server, after cloning the project:

```bash
cd ~/discord-role-notifier
sudo bash deploy/install.sh      # creates /opt/discord-role-notifier and a .env
sudo nano /opt/discord-role-notifier/.env   # token, DELIVERY, and CHANNEL_ID if needed
sudo systemctl enable --now discord-role-notifier
sudo journalctl -u discord-role-notifier -f
```

---

## Project layout

```
.
├── src/
│   ├── index.js                       # startup, gateway client, shutdown
│   ├── config.js                      # .env parsing + validation
│   ├── doctor.js                      # preflight checks
│   ├── logger.js                      # console + in-memory log buffer
│   ├── settings.js                    # dashboard-managed settings
│   ├── events/guild-member-update.js  # role-added detection + message
│   ├── web/
│   │   ├── server.js                   # dashboard HTTP server + API
│   │   └── auth.js                     # Discord OAuth2, sessions, admin check
│   └── lib/
│       ├── audit.js                    # "assigned by" lookup
│       ├── channel.js                  # channel + permission checks
│       ├── guild.js                    # guild/member resolution after READY
│       ├── message.js                  # template file loading (hot reload)
│       └── template.js                 # {placeholder} rendering
├── web/
│   ├── index.html                      # dashboard markup
│   ├── app.js                          # dashboard client logic
│   └── style.css
├── scripts/
│   └── send-welcome.mjs                 # send the message to specific users
├── templates/
│   └── welcome.md                       # multi-line welcome message
├── data/
│   └── settings.json                    # created by the dashboard (gitignored)
├── deploy/
│   ├── install.sh                     # Oracle Linux installer
│   ├── setup-caddy.sh                 # optional: publish the dashboard over HTTPS
│   ├── discord-role-notifier.service  # systemd unit
│   ├── discord-role-notifier-backup.service   # nightly backup unit
│   ├── discord-role-notifier-backup.timer     # nightly backup schedule
│   ├── backup.sh                      # archives .env, templates/, data/
│   ├── Dockerfile                     # optional container build
│   └── docker-compose.yml
├── .env.example
├── README.md
└── DEPLOY-OCI.md
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Used disallowed intents` on startup | Enable **Server Members Intent** in the Developer Portal, then restart. |
| `Invalid configuration: DISCORD_TOKEN is missing` | `.env` not found or token empty. The bot reads `.env` from the working directory. |
| Bot online, no messages | Check `DELIVERY`, `ROLE_ID` and `GUILD_ID`; for channel mode also `CHANNEL_ID`. Run `npm run doctor`. |
| Member never receives a DM | Their **Privacy & Safety → Direct messages from server members** setting is off, or they no longer share the server. The log shows Discord error `50007`; this cannot be forced. |
| DM works for some members only | That is the per-user DM privacy setting. Use `DELIVERY=both` if you need a reliable channel copy. |
| `Cannot post in #channel: missing …` | Give the bot View Channel, Send Messages, Embed Links in that channel (channel-level overrides can block it). |
| `CHANNEL_ID … was not found` | Wrong channel ID, or the bot cannot see that channel. Not used when `DELIVERY=dm`. |
| Message arrives twice | Two copies of the bot are running (e.g. local + server). Stop one. |
| Message on nickname change | Should not happen — the code compares role sets. If it does, set `LOG_LEVEL=debug` and open an issue with the log. |
| `Unknown Channel` / `Missing Access` | Bot was removed from the server or lost channel access; re-invite and check permissions. |
| Only some members trigger it | Members must be cached by the gateway. With Server Members Intent enabled this is automatic. |
| `DRY_RUN` set and nothing happens | That is expected; unset it to actually send. |
| Dashboard says "Login is not configured" | Add `DISCORD_CLIENT_SECRET` and restart. |
| Discord shows `Invalid OAuth2 redirect_uri` | The portal redirect and `OAUTH_REDIRECT_URI` must match exactly. |
| Dashboard shows `not_admin` | The account lacks **Manage Server**; use the owner or add the ID to `WEB_ADMIN_IDS`. |
| Dashboard signs out after a restart | Expected — sessions are in memory. |

### Notes and limitations

- A role added **by another bot** still triggers the notification (unless the member is a bot and `IGNORE_BOTS=true`).
- DMs require a shared server and the member's consent (the "Direct messages from server members" privacy setting). Discord does not let bots bypass this.
- In `both` mode, a failed DM does not stop the channel post; each target is attempted independently.
- "Assigned by" comes from the audit log and is best-effort: it can show `Unknown` if the bot lacks View Audit Log or the entry is older than ~20 seconds.
- The bot needs no privileged message content access, and it does not read message history.
- Discord rate limits are handled by discord.js; a single message per role assignment is far below any limit.
- Role hierarchy does not matter for *notifications*; for channel delivery the bot only needs permission to post in that channel.

---

## Security

- Treat `DISCORD_TOKEN` like a password. It is excluded via `.gitignore`; on the server `install.sh` sets `.env` to mode `600`.
- If the token leaks, click **Reset Token** in the Developer Portal and update `.env`.
- Keep the bot's permissions minimal (View Audit Log, plus channel permissions only if you use channel delivery).
- The dashboard adds no public port when left on `127.0.0.1`; reach it through an SSH tunnel. To expose it, run `deploy/setup-caddy.sh` (HTTPS via Caddy) and set `WEB_COOKIE_SECURE=true`.
- Dashboard sessions are in memory and expire after `SESSION_TTL_HOURS` (default 12). The bot token and OAuth access tokens are never stored in the browser.
- For OCI, restrict SSH ingress to your own IP address and keep the OS patched — see the deployment guide.
