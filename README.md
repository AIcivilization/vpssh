<p align="center">
  <img src="app/build/icon.png" width="112" alt="vpssh">
</p>

<h1 align="center">vpssh</h1>

<p align="center">
  <b>全平台 AI 驱动的 VPS 管理及 SSH 工具</b><br>
  装在你自己的 VPS 上：说一句话，AI 替你管服务器；终端、文件、状态都在一个网页里，电脑、手机、平板随时打开。
</p>

<p align="center">
  <a href="https://github.com/AIcivilization/vpssh/releases/latest"><img src="https://img.shields.io/github/v/release/AIcivilization/vpssh?label=%E6%9C%80%E6%96%B0%E7%89%88&color=2f6fed" alt="最新版"></a>
  <a href="https://www.npmjs.com/package/vpssh"><img src="https://img.shields.io/npm/v/vpssh?label=npx%20vpssh&color=cb3837" alt="npm"></a>
  <a href="https://github.com/AIcivilization/vpssh/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/AIcivilization/vpssh/release.yml?label=%E6%9E%84%E5%BB%BA" alt="构建"></a>
  <a href="https://github.com/AIcivilization/vpssh/releases"><img src="https://img.shields.io/github/downloads/AIcivilization/vpssh/total?label=%E4%B8%8B%E8%BD%BD&color=2ea44f" alt="下载"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/vpssh?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=blue" alt="MIT"></a>
  <br>
  <img src="https://img.shields.io/badge/%E6%A1%8C%E9%9D%A2%E7%89%88-macOS%20%7C%20Windows-555" alt="桌面版 macOS | Windows">
  <img src="https://img.shields.io/badge/%E6%9C%8D%E5%8A%A1%E5%99%A8-Ubuntu%2022.04%2B%20%7C%20Debian%2012%2B-E95420" alt="服务器 Ubuntu | Debian">
  <img src="https://img.shields.io/badge/%E6%89%8B%E6%9C%BA%E3%80%81%E5%B9%B3%E6%9D%BF-%E5%8A%A0%E5%88%B0%E4%B8%BB%E5%B1%8F%E5%B9%95-8a5cf6" alt="手机、平板">
  <img src="https://img.shields.io/badge/built%20on-DeepSeek%20Harness-4D6BFE" alt="Built on DeepSeek Harness">
</p>

<p align="center">
  <a href="#下载与安装">下载与安装</a> ·
  <a href="#功能">功能</a> ·
  <a href="#用法">用法</a> ·
  <a href="#安全">安全</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/main.jpg" alt="vpssh：左边对话，右边服务器状态" width="900">
</p>

## vpssh 是什么

买了一台 VPS，接下来就是没完没了的 SSH、查命令、改配置、看日志。vpssh 把这些变成**对话**：在网页里说「装个 nginx，把 a.com 反代到 3000」「看看为什么磁盘满了」，AI 去查、去做，改动之前按风险分级请你点头。

它同时是一个完整的 **SSH 工具**：机器清单、断线能接回的网页终端、文件浏览与上传下载、服务器状态面板，一台或一群机器都能管。

vpssh 装在你自己的服务器上，没有我们的服务器，AI 用你自己填的模型 key。免费开源（MIT）。

## 特点

- **AI 动手，你来拍板**：只读的查询直接做；改动按风险分级，危险操作一定先问你。改防火墙、改 SSH 这类可能把自己关在门外的操作，还带「超时自动恢复」。
- **一个网页，所有设备**：电脑、手机、平板打开的是同一个网页，同一套机器、同一套对话。手机上打开就是服务器状态，加到主屏幕像应用一样用。
- **私钥不交给 AI**：SSH 私钥由单独的 `vpssh-keyd` 服务保管，AI 所在的进程读不到私钥，只能请它签名登录。
- **不花 token 的常用操作**：查信息、装 Docker / Nginx / fail2ban 等常见软件走现成的菜谱，先给你看计划再执行；`/vps-help` 列出全部免费命令。
- **和现有网站和平共处**：机器上已经有网站（比如 dsh-vps 用 Caddy 占着 80/443）也能装，vpssh 只给 Caddy 加一行配置，有域名时两边共用 443、按域名区分。
- **升级不怕**：一键升级前自动备份，升级失败自动回到原来的版本；卸载默认保留数据。
- **中文、英文**：界面、安装过程、命令行提示都跟随系统语言。

## 下载与安装

服务器要求：**Ubuntu 22.04+ 或 Debian 12+**，root 或能 sudo 的账号，放行 80、443 端口。三种装法任选其一：

| 版本 | 适合谁 | 下载 / 命令 |
|---|---|---|
| **桌面版 · macOS** | 不想敲命令：填表就装，装完在独立窗口里用 | [Releases](https://github.com/AIcivilization/vpssh/releases/latest) 里的 `vpssh-版本-mac-arm64.dmg`（Apple 芯片）/ `-mac-x64.dmg`（Intel） |
| **桌面版 · Windows** | 同上 | [Releases](https://github.com/AIcivilization/vpssh/releases/latest) 里的 `vpssh-版本-win-x64.exe` |
| **服务器版** | 习惯 SSH 登录服务器操作 | 一键命令，或 [Releases](https://github.com/AIcivilization/vpssh/releases/latest) 里的 `vpssh-版本-server-linux.tar.gz` 安装包 |
| **命令行** | 电脑上有 Node.js，喜欢一条命令搞定 | `npx vpssh install root@服务器IP` |

### 桌面版（推荐）

<img src="docs/screenshots/install.jpg" alt="桌面版：安装到 VPS" width="640" align="right">

1. 下载、安装，打开 vpssh。
2. 填服务器 IP、SSH 端口、用户名、密码（也可以选私钥文件）；有域名再填域名，服务器在国内就勾上「服务器在国内」。
3. 点「安装到这台 VPS」，看着进度条走完（一般 3–8 分钟，网络断了会自动重连）。
4. 窗口里自动进入初始设置：设管理员账号 → 登录 → 开始用。

之后打开桌面版直接回到上次的服务器，登录状态还在。菜单「服务器」可以切换多台、装到新的服务器、连接已装好的服务器。

- 密码只用这一次，不保存。
- 用 IP 访问时，桌面版只信任这台服务器自己的证书（安装时经 SSH 读到），不会弹「不安全」。
- 暂时没有苹果 / 微软的开发者签名：Mac 第一次打开提示无法验证时，到「系统设置 → 隐私与安全性」点「仍要打开」；Windows 提示「已保护你的电脑」时点「更多信息 → 仍要运行」。

<br clear="right">

### 服务器版

**一键命令**：SSH 登录服务器后执行（装的是最新发布版）：

```bash
curl -fsSL https://github.com/AIcivilization/vpssh/releases/latest/download/install.sh | sudo bash
```

**安装包**：想先检查内容、固定版本，或者自己上传到服务器时用。在 [Releases](https://github.com/AIcivilization/vpssh/releases/latest) 下载 `vpssh-版本-server-linux.tar.gz`（旁边的 `.sha256` 是校验值），然后：

```bash
tar -xzf vpssh-0.1.12-server-linux.tar.gz
sudo bash vpssh-0.1.12/server/install.sh
```

两种方式都可以在后面加参数（一键命令写成 `| sudo bash -s -- 参数`）：

| 参数 | 作用 |
|---|---|
| `--domain vps.example.com` | 用域名访问（先把 A 记录解析到这台服务器），自动签发 HTTPS 证书。不填就用公网 IP + 自签证书，之后可以在网页里再设 |
| `--mirror cn` | 服务器在国内：Node 和 DeepSeek Harness 从国内镜像下载 |
| `--port 端口` | 浏览器访问的端口（默认 443；443 被同机别的网站占着、又没有域名时自动换成 8443） |
| `--ip IP` | 不用域名时用这个 IP（默认自动探测公网 IP） |

装完会打印一个带一次性令牌的地址，浏览器打开它进入初始设置。防火墙（ufw、firewalld）开着的话安装时会自动放行端口；云厂商的安全组在机器外面，要在控制台里放行（装完会提示是哪个端口）。

### 命令行（npx）

电脑上有 [Node.js](https://nodejs.org) 18+ 就行，它会替你 SSH 上去装好，装完自动打开浏览器：

```bash
npx vpssh install root@服务器IP
```

私钥用 `-i ~/.ssh/id_ed25519`，SSH 端口用 `-p 2222`，上面的 `--domain`、`--mirror cn`、`--port` 也都能加。以后：`npx vpssh upgrade root@IP`、`npx vpssh uninstall root@IP`、`npx vpssh setup-url root@IP`（重取初始设置链接）。

## 功能

| | |
|---|---|
| **AI 对话管服务器** | 用大白话描述要做的事，AI 规划、执行、汇报；改动按风险分级确认，可以设成谨慎（改动都要确认）、放手（只有高危才问）或全自动 |
| **多台机器** | 机器清单、分组、备注；一个对话操作哪台由对话头部的编号方块决定；可以从 `~/.ssh/config` 导入 |
| **服务器状态** | CPU、内存、Swap、磁盘、网络、服务、防火墙、证书、计划任务、安全更新、登录记录，「需注意」的排在最前；点一下让 AI 用几句话解读 |
| **网页终端** | 断线、关页面都能接回原来的会话；手机上也能用 |
| **文件** | 浏览、拖进来上传、右键下载、双击编辑；删除进回收站，改文件前自动备份；右键「让 AI 看看这个文件」 |
| **常用操作** | 现成的菜谱：查信息、装常见软件、常见排障，先看计划再执行，不花 token |
| **手机、平板** | 打开就是持续刷新的服务器状态；扫码登录，加到主屏幕全屏使用 |
| **账号与安全** | 登录密码 + 限流；访问地址可以随时设域名、换域名、改回 IP；可以切成「只有我的设备能访问」（WireGuard） |
| **版本** | 网页里检查更新、一键升级，失败自动回滚；网页里也能卸载 |

<p align="center">
  <img src="docs/screenshots/manage.jpg" alt="VPS 管理：机器、手机扫码、账号与安全、版本" width="820">
</p>

## 用法

1. **初始设置**：设管理员账号；可选填域名和模型 API Key（DeepSeek、OpenAI、Anthropic 等都行，也可以登录后在「设置 → 模型」里填）。
2. **这台服务器自己就是 1 号机器**，装好就能管。别的机器在左栏「VPS 管理 → 添加机器」里加（填 IP、账号、密码，vpssh 会把自己的公钥装上去）。
3. **在对话里说要做什么**。只有一台机器时新对话默认就在操作它；多台时点对话头部「VPS」后面的编号方块选。
4. **终端、文件**：对话头部「VPS」后面的 `>_`。
5. **右栏「VPS 状态」**一直显示当前机器的状态；左栏还有「服务器状态」「VPS 管理」「常用操作」。
6. **免费命令**：在输入框里打 `/vps-help`。

## 升级、救援、卸载

网页里：「VPS 管理 → 版本」检查更新、一键升级；「VPS 管理」里也能卸载。在服务器上：

```bash
sudo vpssh upgrade      # 升到最新发布版：先备份，失败自动回到升级前
sudo vpssh rollback     # 回到上一次升级之前
sudo vpssh repair       # 网页打不开时：拉起服务、重写站点、放行端口
sudo vpssh status       # 看各服务和配置
sudo vpssh setup-url    # 重新取初始设置链接
sudo vpssh reset-admin  # 忘了管理员密码：重新走初始设置
sudo vpssh uninstall    # 卸载：先备份，默认保留数据（加 --delete-data 才删）
```

## 安全

- 网页有登录门：密码（scrypt）+ 限流 + 会话 Cookie。
- AI 跑在没有特权的系统用户下；它不能在 vpssh 所在的服务器上直接执行命令或读写文件，要动这台机器也是经 SSH、按风险分级确认。
- SSH 私钥由单独的 `vpssh-keyd` 保管：AI 所在的进程读不到私钥，只能请它签名。
- 可以切成「只有我的设备能访问」：`sudo vpssh vpn setup`（WireGuard）。
- 桌面版：密码不保存；SSH 主机指纹第一次连接时记下，以后对不上就拒绝；用 IP 访问时只信任这台服务器自己的根证书。

## 常见问题

<details>
<summary><b>服务器上已经有网站占着 80/443，能装吗？</b></summary>

如果占着的是 Caddy（比如 dsh-vps）：能。vpssh 和它共用 Caddy，只在它的配置末尾加一行 `import`，卸载时只去掉这一行。有域名时照样用 443（按域名区分），没有域名时用 8443。占着的是 nginx 等别的程序：目前还不能共存，安装会说明原因后退出。
</details>

<details>
<summary><b>装完浏览器打不开？</b></summary>

先确认云厂商的安全组放行了访问端口（443，或安装时提示的 8443）。还不行就在服务器上执行 `sudo vpssh repair`。
</details>

<details>
<summary><b>没有域名可以用吗？之后能加域名吗？</b></summary>

可以，用公网 IP 加自签证书（浏览器会提示不安全；桌面版不会）。之后在「VPS 管理 → 账号与安全 → 访问地址」里随时设域名、换域名或改回 IP。
</details>

<details>
<summary><b>服务器在国内，下载很慢？</b></summary>

安装时加 `--mirror cn`（桌面版勾选「服务器在国内」），Node 和 DeepSeek Harness 从国内镜像下载。
</details>

<details>
<summary><b>一次性设置链接丢了 / 忘了管理员密码？</b></summary>

链接丢了：`sudo vpssh setup-url`。忘了密码：`sudo vpssh reset-admin`，重新走初始设置（对话和机器清单都还在）。
</details>

<details>
<summary><b>AI 要花钱吗？</b></summary>

vpssh 免费。AI 用你自己的模型 key，按模型厂商的价格计费；查状态、常用操作菜谱、`/vps-*` 命令都不花 token。
</details>

## 组成

| 目录 | 作用 |
|---|---|
| `plugin/` | vpssh 的全部功能：机器、终端、文件、状态、AI 工具、品牌与布局 |
| `server/` | 安装、登录网关、钥匙保管（keyd）、自动 HTTPS、升级、救援 |
| `app/` | 桌面版（Mac、Windows）：填表经 SSH 安装，在独立窗口里使用 |
| `cli/` | `npx vpssh`：在自己电脑上用命令安装 |

AI 对话、确认、多模型、会话由 [DeepSeek Harness（DSH）](https://www.npmjs.com/package/@deepseek-ai/dsh) 提供：从 npm 原样安装，不复制、不修改它的代码，每个 vpssh 版本固定用一个测过的 DSH 版本（见 [manifest.json](manifest.json)）。

基于 DeepSeek Harness 构建。vpssh 不是 DeepSeek 官方产品，也未获其授权或背书。

## 许可证

[MIT](LICENSE)
