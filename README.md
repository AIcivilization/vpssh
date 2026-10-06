# vpssh

**全平台 AI 驱动的 VPS 管理及 SSH 工具。** · [English](README.en.md)

> 开发中，还不能用。

装在你自己的 VPS 上，电脑、手机、平板打开的都是同一个网页：

- **SSH 工具**：机器清单、断线能接回的终端、文件浏览与上传下载、状态一目了然；
- **AI 管服务器**：在对话里说想要什么，AI 去做；改动前按风险分级请你确认。

AI 用你自己填的模型 key，没有我们的服务器，免费开源（MIT）。

## 组成

vpssh 不复制、不修改 DeepSeek Harness，而是把几个现成的部分按测过的版本组合起来（见 [manifest.json](manifest.json)）：

| 部分 | 作用 |
|---|---|
| [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) | AI 对话、确认、多模型、插件系统 |
| [dsh-vps](https://github.com/AIcivilization/dsh-vps) | 安装、登录网关、自动 HTTPS、一键升级 |
| [dsh-vps-manager](https://github.com/AIcivilization/dsh-vps-manager) | 机器、终端、文件、状态、AI 工具 |
| 本仓库 | vpssh 的品牌、默认布局、安装入口 |

基于 DeepSeek Harness 构建。vpssh 不是 DeepSeek 官方产品，也未获其授权或背书。

## 许可证

MIT
