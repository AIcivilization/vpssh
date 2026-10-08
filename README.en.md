# vpssh

**AI-driven VPS management and SSH tool for every platform.** · [中文](README.md)

Installed on your own VPS; your computer, phone and tablet all open the same web page, with the same machines and the same conversations.

- **AI server management**: say what you want in the chat ("install nginx and reverse-proxy a.com to 3000") and the AI does it, asking you to confirm changes by risk level.
- **SSH tool**: machine list, terminals that survive disconnects, file browsing and transfer, server status at a glance.
- **Phone and iPad**: opens on the live server status, refreshed automatically; add it to the home screen and use it like an app.
- **Common tasks without tokens**: look things up and install common software (Docker, Nginx, fail2ban, ...) from ready-made recipes; you see the plan before anything runs.

The AI runs on your own model key (DeepSeek, OpenAI, Anthropic and others). There is no server of ours. Free and open source (MIT).

## Install

You need a VPS with **Ubuntu 22.04+ or Debian 12+** (root, or an account that can sudo) and ports 80 and 443 open.

**Desktop app (recommended)**: download the Mac (`.dmg`: arm64 for Apple silicon, x64 for Intel) or Windows (`.exe`) build from [Releases](https://github.com/AIcivilization/vpssh/releases/latest). Enter the server IP, SSH port, user name and password (and a domain if you have one) and click "Install on this VPS". First-time setup, sign-in and vpssh itself then open in that same window; the Server menu switches between servers. The password is used once and never saved. Over an IP address the app trusts only that server's own certificate, so there is no "not secure" warning.

> The desktop builds are not signed with an Apple / Microsoft developer certificate yet: if the Mac says it cannot verify the app the first time, click "Open Anyway" under System Settings → Privacy & Security; on Windows, choose "More info → Run anyway".

**From your own computer, by command** (needs [Node.js](https://nodejs.org) 18+ there):

```bash
npx vpssh install root@your-server-ip
```

It SSHes in for you, installs, and opens the browser on first-time setup. Your computer's ssh asks for the password or key itself; vpssh never sees them. Add `-i ~/.ssh/id_ed25519` for a key, `-p 2222` for another SSH port; `--domain`, `--mirror cn` and `--port` below work here too. Later: `npx vpssh upgrade root@IP`, `npx vpssh uninstall root@IP`.

**Or, logged in to the server over SSH** (installs the latest release):

```bash
curl -fsSL https://github.com/AIcivilization/vpssh/releases/latest/download/install.sh | sudo bash
```

- With a domain: point its A record at the machine first and add `-s -- --domain vps.example.com`; HTTPS certificates are issued automatically.
- Without a domain: the public IP and a self-signed certificate, so the browser warns (you can add a domain later in the setup wizard).
- Server in mainland China: add `-s -- --mirror cn` to download from mirrors there.
- **Another site already on this machine** (e.g. dsh-vps with Caddy on 80/443): run the same command. vpssh shares that Caddy and only adds one line to its config; without a domain it moves to port **8443** so both keep working (with a domain it shares 443, told apart by name; `https://domain:8443` works too). Or choose a port with `-s -- --port <port>`.
- If a firewall (ufw, firewalld) is on, the installer opens the ports it needs. A cloud provider's security group lives outside the machine; open the port in its console (the installer tells you which).

The installer prints an address with a one-time token. Open it, create the admin account (optional: domain, model key), sign in, and you're set. The server itself becomes machine 1 automatically.

## Using it

- **Left rail**: "Server status", "VPS Manager" (machines, phone QR, account, version, uninstall, ...), "Common tasks".
- **Conversations**: with one machine, a new conversation works on it by default; with several, pick one with the numbered squares in the conversation header.
- **Terminal and files**: the `>_` after "VPS" in the conversation header.
- **Commands**: `/vps-help` lists every command that needs no tokens.

## Upgrade, rescue, uninstall

On the server:

```bash
sudo vpssh upgrade      # to the latest release: backs up first, returns to the previous version on failure (also under VPS Manager → Version)
sudo vpssh repair       # when the page does not open: restart services, rewrite the site, open ports
sudo vpssh uninstall    # backs up first and keeps the data unless you add --delete-data
```

## Security

- The page sits behind a sign-in (password and rate limiting); the AI runs as an unprivileged user.
- SSH private keys are held by a separate `vpssh-keyd` service: the process the AI runs in cannot read them, only ask for a login to be signed.
- The AI cannot run commands or read and write files directly on the vpssh server; to work on that machine it also goes through SSH with risk-tiered confirmation.
- You can limit access to your own devices (WireGuard): `sudo vpssh vpn setup`.

## What's inside

| Directory | Role |
|---|---|
| `plugin/` | All of vpssh's features: machines, terminal, files, status, AI tools, branding and layout |
| `server/` | Install, sign-in gateway, key holder (keyd), automatic HTTPS, upgrades, rescue |
| `app/` | Desktop app (Mac, Windows): install over SSH from a form, then use vpssh in its own window |
| `cli/` | `npx vpssh`: install from your own computer by command |

AI chat, confirmations, multiple models and sessions come from [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), installed unmodified from npm; each vpssh release pins one tested DSH version (see [manifest.json](manifest.json)).

Built on DeepSeek Harness. vpssh is not an official DeepSeek product and is not endorsed or authorized by DeepSeek.

## License

MIT
