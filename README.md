# vpssh

**全平台 AI 驱动的 VPS 管理及 SSH 工具。** · [English](README.en.md)

> 开发中，还不能用。

装在你自己的 VPS 上，电脑、手机、平板打开的都是同一个网页：

- **SSH 工具**：机器清单、断线能接回的终端、文件浏览与上传下载、状态一目了然；
- **AI 管服务器**：在对话里说想要什么，AI 去做；改动前按风险分级请你确认。

AI 用你自己填的模型 key，没有我们的服务器，免费开源（MIT）。

## 组成

| 目录 | 作用 |
|---|---|
| `plugin/` | vpssh 的全部功能：机器、终端、文件、状态、AI 工具、品牌与布局 |
| `server/` | 安装、登录网关、自动 HTTPS、升级、救援命令 |

AI 对话、确认、多模型、会话由 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 提供：从 npm 原样安装，不复制、不修改它的代码，用哪个版本见 [manifest.json](manifest.json)。

基于 DeepSeek Harness 构建。vpssh 不是 DeepSeek 官方产品，也未获其授权或背书。

## 许可证

MIT
