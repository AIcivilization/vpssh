# vpssh

**全平台 AI 驱动的 VPS 管理及 SSH 工具。** · [English](README.en.md)

装在你自己的 VPS 上，电脑、手机、平板打开的都是同一个网页：同一套机器、同一套对话。

- **AI 管服务器**：在对话里说想要什么（「装个 nginx，把 a.com 反代到 3000」），AI 去做；改动前按风险分级请你确认。
- **SSH 工具**：机器清单、断线能接回的终端、文件浏览与上传下载、服务器状态一目了然。
- **手机、iPad**：打开就是服务器状态，一直显示、自动刷新；加到主屏幕像应用一样用。
- **不花 token 的常用操作**：查信息、装常见软件（Docker、Nginx、fail2ban……）走现成的菜谱，先看计划再执行。

AI 用你自己填的模型 key（DeepSeek、OpenAI、Anthropic 等都行），没有我们的服务器。免费开源（MIT）。

## 安装

要一台 **Ubuntu 22.04+ 或 Debian 12+** 的 VPS（root 权限），放行 80、443 端口。SSH 登录后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/AIcivilization/vpssh/main/server/install.sh | sudo bash
```

- 有域名：先把 A 记录解析到这台机器，加上 `-s -- --domain vps.example.com`，自动签发 HTTPS 证书。
- 没有域名：用公网 IP 加自签证书，浏览器会提示不安全（可以稍后在向导里补上域名）。
- 服务器在国内：加 `-s -- --mirror cn`，从国内镜像下载。
- **这台机器上已经有别的网站**（比如 dsh-vps 用 Caddy 占着 80/443）：照常执行上面的命令。vpssh 会和它共用 Caddy，只给 Caddy 加一行配置；没有域名时自动换到 **8443** 端口，两边同时可用（有域名则照样用 443，按域名区分）。也可以用 `-s -- --port 端口` 自己指定。
- 防火墙（ufw、firewalld）开着的话，安装时会自动放行要用的端口；云厂商的安全组在机器外面，要在控制台里放行（装完会提示是哪个端口）。

装完会打印一个带一次性令牌的地址，浏览器打开它：设置管理员账号（可选：域名、模型 key），登录就能用。这台服务器自己会自动成为 1 号机器。

## 用法

- **左栏**：「服务器状态」「VPS 管理」（机器、手机扫码、账号、版本、卸载……）「常用操作」。
- **对话**：只有一台机器时，新对话默认就在操作它；多台时点对话头部的编号方块选。
- **终端、文件**：对话头部「VPS」后面的 `>_`。
- **命令**：`/vps-help` 列出全部不花 token 的命令。

## 升级、救援、卸载

在服务器上：

```bash
sudo vpssh upgrade      # 升到最新发布版：先备份，失败自动回到升级前（网页「VPS 管理 → 版本」也能升）
sudo vpssh repair       # 网页打不开时：拉起服务、重写站点、放行端口
sudo vpssh uninstall    # 卸载：先备份，默认保留数据（加 --delete-data 才删）
```

## 安全

- 网页有登录门（密码 + 限流），AI 跑在没有特权的用户下。
- SSH 私钥由单独的 `vpssh-keyd` 保管，AI 所在的进程读不到私钥，只能请它签名登录。
- AI 不能在 vpssh 所在的服务器上直接执行命令或读写文件；要动这台机器，也是经 SSH、按风险分级确认。
- 可以切成「仅我的设备可访问」（WireGuard）：`sudo vpssh vpn setup`。

## 组成

| 目录 | 作用 |
|---|---|
| `plugin/` | vpssh 的全部功能：机器、终端、文件、状态、AI 工具、品牌与布局 |
| `server/` | 安装、登录网关、钥匙保管（keyd）、自动 HTTPS、升级、救援 |

AI 对话、确认、多模型、会话由 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 提供：从 npm 原样安装，不复制、不修改它的代码，每个 vpssh 版本固定用一个测过的 DSH 版本（见 [manifest.json](manifest.json)）。

基于 DeepSeek Harness 构建。vpssh 不是 DeepSeek 官方产品，也未获其授权或背书。

## 许可证

MIT
