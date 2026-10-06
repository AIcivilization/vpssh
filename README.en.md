# vpssh

**AI-driven VPS management and SSH tool for every platform.** · [中文](README.md)

> Work in progress — not usable yet.

Installed on your own VPS; your computer, phone and tablet all open the same web page:

- **SSH tool**: machine list, terminals that survive disconnects, file browsing and transfer, status at a glance;
- **AI server management**: say what you want in the chat and the AI does it, asking you to confirm changes by risk level.

The AI runs on your own model key. There is no server of ours. Free and open source (MIT).

## What's inside

| Directory | Role |
|---|---|
| `plugin/` | All of vpssh's features: machines, terminal, files, status, AI tools, branding and layout |
| `server/` | Install, login gateway, automatic HTTPS, upgrades, rescue command |

AI chat, confirmations, multiple models and sessions come from [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), installed unmodified from npm; the pinned version is in [manifest.json](manifest.json).

Built on DeepSeek Harness. vpssh is not an official DeepSeek product and is not endorsed or authorized by DeepSeek.

## License

MIT
