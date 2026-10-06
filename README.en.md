# vpssh

**AI-driven VPS management and SSH tool for every platform.** · [中文](README.md)

> Work in progress — not usable yet.

Installed on your own VPS; your computer, phone and tablet all open the same web page:

- **SSH tool**: machine list, terminals that survive disconnects, file browsing and transfer, status at a glance;
- **AI server management**: say what you want in the chat and the AI does it, asking you to confirm changes by risk level.

The AI runs on your own model key. There is no server of ours. Free and open source (MIT).

## What's inside

vpssh does not copy or modify DeepSeek Harness. It combines existing parts at tested versions (see [manifest.json](manifest.json)):

| Part | Role |
|---|---|
| [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) | AI chat, confirmations, multiple models, plugin system |
| [dsh-vps](https://github.com/AIcivilization/dsh-vps) | Install, login gateway, automatic HTTPS, one-click upgrades |
| [dsh-vps-manager](https://github.com/AIcivilization/dsh-vps-manager) | Machines, terminal, files, status, AI tools |
| This repo | vpssh branding, default layout, install entry point |

Built on DeepSeek Harness. vpssh is not an official DeepSeek product and is not endorsed or authorized by DeepSeek.

## License

MIT
