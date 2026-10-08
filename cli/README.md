# vpssh

**AI-driven VPS management and SSH tool for every platform** · **全平台 AI 驱动的 VPS 管理及 SSH 工具**

This package installs [vpssh](https://github.com/AIcivilization/vpssh) on your VPS from your own computer: it SSHes in with your computer's `ssh`, runs the installer, and opens the browser on first-time setup. Your password or key stays with `ssh`; this tool never sees it.

在自己电脑上把 [vpssh](https://github.com/AIcivilization/vpssh) 装到 VPS 上：用电脑自带的 `ssh` 登录服务器、执行安装，装完自动打开浏览器进初始设置。密码、私钥由 `ssh` 自己处理，本工具不经手。

```bash
npx vpssh install root@203.0.113.10
npx vpssh install ubuntu@203.0.113.10 -i ~/.ssh/id_ed25519 --domain vps.example.com
npx vpssh upgrade root@203.0.113.10
npx vpssh uninstall root@203.0.113.10 [--delete-data]
npx vpssh setup-url root@203.0.113.10
```

| Option · 选项 | |
|---|---|
| `-p <port>` | SSH port · SSH 端口 |
| `-i <key>` | SSH private key · SSH 私钥 |
| `--domain <domain>` | Domain (A record pointing at the server) · 访问域名（A 记录已解析到服务器） |
| `--mirror cn` | Server in mainland China · 服务器在国内 |
| `--ip <IP>` / `--port <port>` | Address and port the browser uses · 浏览器访问的 IP、端口 |
| `--ref <version>` | Install a specific tag or branch · 装指定版本 |
| `--no-open` | Do not open the browser · 不自动打开浏览器 |

Server: Ubuntu 22.04+ / Debian 12+, root or sudo. Requires Node.js 18+ and `ssh` on your computer.
Prefer a window? Get the desktop app (Mac, Windows) from [Releases](https://github.com/AIcivilization/vpssh/releases/latest).

服务器：Ubuntu 22.04+ / Debian 12+，root 或能 sudo 的账号；电脑上要有 Node.js 18+ 和 `ssh`。想用窗口操作？在 [Releases](https://github.com/AIcivilization/vpssh/releases/latest) 下载桌面版（Mac、Windows）。

MIT
