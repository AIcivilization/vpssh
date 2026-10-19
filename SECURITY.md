# Security · 安全

vpssh runs with root access to your servers, so security reports matter a lot to us.
vpssh 能以 root 管你的服务器，安全问题我们会优先处理。

## Reporting a vulnerability · 报告漏洞

**Please do not open a public issue.** Report it privately through GitHub:
**请不要公开发 issue。** 请经 GitHub 私下报告：

→ [Report a vulnerability · 私下报告](https://github.com/AIcivilization/vpssh/security/advisories/new)

Please include what you found, how to reproduce it, the vpssh version (`sudo vpssh status`), and how it could be exploited.
We will reply within a few days, fix it in a new release, and credit you in the release notes unless you would rather not be named.

请写清楚：发现了什么、怎么复现、vpssh 版本（`sudo vpssh status` 能看到）、可能被怎么利用。
我们会在几天内回复，修好后发新版，并在发布说明里致谢（不想署名可以说一声）。

## Supported versions · 支持的版本

Only the latest release gets fixes. Upgrade with `sudo vpssh upgrade`, or Check for updates in the web page.
只修最新的发布版。升级：`sudo vpssh upgrade`，或网页里「检查更新」。

## What is in scope · 范围

- The sign-in gateway (password, two-step verification, sessions), the setup wizard and the web upgrade / backup / restore / uninstall requests
  登录网关（密码、两步验证、会话）、初始设置向导，以及网页发起的升级、备份、恢复、卸载
- Key isolation (`vpssh-keyd`), the approval tiers for AI actions, and the install and uninstall scripts
  钥匙隔离（`vpssh-keyd`）、AI 操作的分级确认、安装与卸载脚本
- The desktop app (certificate pinning, SSH host keys) and the Android app (certificate pinning)
  桌面版（证书钉扎、SSH 主机指纹）和安卓 App（证书钉扎）

Problems in DeepSeek Harness itself or in third-party plugins should go to those projects.
DeepSeek Harness 本身或第三方插件的问题请报给对应项目。
