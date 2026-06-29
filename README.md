# WeChat Codex Bridge

<p align="center">
  <strong>在微信里和 Codex 聊天，用微信指挥你电脑上的 Codex 干活</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
</p>

扫码绑定微信后，你的微信里会多出一个"好友"。给它发消息，消息会自动转发给你电脑上运行的 [Codex CLI](https://github.com/openai/codex)，回复实时推送回微信。支持文字、图片、文件的收发，会话上下文持续保持。

> 本项目移植自 [dizhu/wechat-claude-code](https://github.com/dizhu/wechat-claude-code)（安全加固版微信 ↔ Claude Code 桥接），把驱动层从 `claude` CLI 换成了 `codex` CLI，微信侧的多 bot / 多成员 / 安全加固全部保留。**使用前请先读下方 [⚠️ 安全须知](#-安全须知)。**

## 核心亮点

| | |
|---|---|
| **扫码即用** | 不用注册账号、不用部署服务器。微信扫码绑定，凭证全在本地。 |
| **指挥 Codex 干活** | 在微信里发需求，Codex 在你电脑上读写文件、跑命令、改代码，结果推回微信。 |
| **会话连续** | 基于 `codex exec resume` 保持上下文，多轮对话不丢记忆。`/compact` 可压缩、`/clear` 可重开。 |
| **多人 / 团队** | 一个守护进程可同时服务多名成员，每人各绑自己的 bot，会话与工作目录互相隔离。 |
| **消息不刷屏** | 默认只推 Codex 的最终回复；中间的思考、命令执行噪音自动过滤（可选开启命令进度）。 |
| **"对方正在输入中..."** | Codex 处理任务时，微信顶部显示输入状态。超过 5 分钟无响应自动安抚。 |
| **文件双向收发** | 发图片 / Word / PDF 给 Codex 分析；Codex 生成的文件也会自动推送回微信。 |

## 前置条件

- Node.js >= 18
- macOS 或 Linux
- 个人微信账号（每名成员各需一个）
- 已安装并登录的 [Codex CLI](https://github.com/openai/codex)（`codex login` 完成认证；命令行能直接跑 `codex exec` 即可）

## 快速安装

```bash
git clone https://github.com/dizhu/wechat-codex-code.git ~/Code/wechat-codex-code
cd ~/Code/wechat-codex-code && npm install
```

> `npm install` 会自动 `npm run build` 编译 TypeScript。

## 快速开始（单人）

### 1. 扫码绑定

```bash
npm run setup
```

弹出二维码，用微信扫码确认，并设置一个默认工作目录。

### 2. 启动服务

```bash
npm run daemon -- start
```

macOS 下自动注册 launchd（开机自启、崩溃自动重启）；Linux 用 systemd（无 systemd 时回退到 nohup）。启动后会打印当前服务的 bot 数量。

### 3. 开始聊天

打开微信，给你新出现的那个"好友"发条消息试试。

### 管理服务

```bash
npm run daemon -- status    # 查看运行状态
npm run daemon -- stop      # 停止服务
npm run daemon -- restart   # 重启服务（更新代码或新增成员后使用）
npm run daemon -- logs      # 查看日志
```

## 多人 / 团队使用

ilink bot 是 **1:1 设计**——每个 bot 只能绑定一个微信号。多人的正确做法是：**每名成员各扫一次码、绑定自己的独立 bot，由同一个守护进程统一服务。** 每人的会话上下文、聊天历史、工作目录完全隔离，请求并发执行、互不阻塞。

新增一名成员：

1. `npm run setup` 生成一张绑定二维码（`~/.wechat-codex-code/qrcode.png`）。
2. 把二维码发给该成员，让他**用自己的手机微信扫码确认**。bot 出现在**他的**微信里，凭证保存到宿主机 `~/.wechat-codex-code/accounts/<新id>.json`。
3. `npm run daemon -- restart` 重启，守护进程自动加载并服务新增 bot。

> 每名成员默认有独立工作目录 `<workingDirectory>/<用户短ID>`，自动创建；成员可用 `/cwd` 自行切换（非 owner 被限制在自己的工作区内）。

## 微信端命令

直接在微信聊天中发送即可：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话（保留工作目录/模型/提示词） |
| `/stop` | 停止当前任务，并清空排队消息 |
| `/model <名称>` | 切换 Codex 模型（如 `gpt-5-codex`） |
| `/prompt <内容>` | 设置系统提示词（**仅对你自己生效**，如"用中文回答"） |
| `/cwd <路径>` | 切换你自己的工作目录 |
| `/prompts [full]` | 列出 `~/.codex/prompts/` 下的自定义 prompt |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 压缩上下文，开始新的 Codex 会话 |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/undo [数量]` | 撤销最近几条对话 |
| `/send <路径>` | 把本地文件发到微信 |
| `/<prompt> [参数]` | 触发 `~/.codex/prompts/<prompt>.md` 自定义 prompt（支持 `$ARGUMENTS`、`$1`…替换） |

## 工作原理

```
成员A 微信 ─┐
成员B 微信 ─┼─→ ilink Bot API ─→ Node.js 守护进程 ─→ codex exec --json（本地，逐成员独立会话）
成员C 微信 ─┘                         （每 bot 一个轮询循环 + 独立游标）
```

守护进程为每个绑定的 bot 启动一条独立的长轮询循环，收到消息后按发送人路由到隔离的会话，spawn 本地 `codex exec`（首轮）或 `codex exec resume <thread_id>`（续接）处理，解析 `--json` 事件流，把 Codex 的 `agent_message` 实时推回微信。全程跑在你自己电脑上。

`codex` 以 `--dangerously-bypass-approvals-and-sandbox` 启动（无审批弹窗，因为微信端无法回应弹窗），工作根目录为该成员的工作目录，`--skip-git-repo-check` 允许在非 git 目录运行。

## ⚠️ 安全须知

**请务必理解：本工具让微信消息能在宿主机上以全权限执行任意命令。**

- **全权限运行**：`codex` 默认以 `--dangerously-bypass-approvals-and-sandbox` 启动，无任何确认。**能给某个 bot 发消息 ≈ 能在宿主机上执行任意命令**——读写文件、跑 shell、联网。可用 [`WCX_SANDBOX`](#沙箱配置wcx_sandbox) 把 Codex 关进沙箱来收紧权限。
- **共享机器、共享凭证**：所有成员的 Codex 都在**同一台机器、同一个系统账号**下运行。会话上下文隔离了，但**机器没有隔离**——任何成员的 Codex 都能读到这台机器上的文件、SSH key、各类 token。👉 **强烈建议把守护进程跑在一台专用的、不存放敏感凭证的机器上。**
- **凭证安全**：bot token 存在 `~/.wechat-codex-code/accounts/`（权限 `0600`）。不要把任何 bot 好友推荐给无关的人，不要外泄 accounts 目录。
- **账号封禁风险**：这是架在个人微信上的非官方桥接，多 bot、持续流量更容易触发微信风控。请留意账号状态。
- **鉴权机制**：默认只有绑定的 owner 本人能驱动各自的 bot；启动时若账号缺少绑定用户会 fail-closed 拒绝该 bot。额外授权用户需手动加入 `config.json` 的 `authorizedUsers`。

## 沙箱配置（WCX_SANDBOX）

默认 `codex` 以 `--dangerously-bypass-approvals-and-sandbox` 运行，**完全无沙箱、无审批**——这样远程编码代理才能装依赖、跑构建、联网，开箱即用。如果你更看重安全（比如把 daemon 跑在有敏感数据的机器上，或开放了 `authorizedUsers`），用 `WCX_SANDBOX` 把 Codex 关进真正的沙箱：

| 取值 | Codex 行为 |
|------|-----------|
| *（不设置，默认）* | `--dangerously-bypass-approvals-and-sandbox`：完全权限，无沙箱无审批 |
| `read-only` | 只读沙箱：可读工作区与系统，**禁止任何写入和命令副作用** |
| `workspace-write` | 可写工作区：能读系统、读写**当前工作目录**，但禁止工作区外写入与网络访问 |
| `danger-full-access` | 不限制文件系统/网络（仍走沙箱框架，效果等同关沙箱） |

设为前三者时会自动附加 `--ask-for-approval never`——微信端没有终端可交互审批，保留审批会让请求一直卡住。设了非法值会打一条告警并回退到默认的绕过模式。

> **推荐**：除非确实需要 Codex 自由联网 / 装包，否则设 `workspace-write` 把它限制在工作目录内（注意：此模式下 `npm install`、`git push`、访问外网等会被拦截，需要时再临时放开）。

**怎么设置**

直接前台运行：

```bash
WCX_SANDBOX=workspace-write node dist/main.js start
```

通过 daemon 托管（launchd / systemd）：daemon 会把当前 shell 里的 `WCX_SANDBOX` 写进服务配置，所以先 `export` 再启动；改了值后用 `restart` 让新值生效：

```bash
export WCX_SANDBOX=workspace-write
npm run daemon -- restart
```

## 数据目录

所有数据存储在 `~/.wechat-codex-code/`：

```
~/.wechat-codex-code/
├── accounts/       # 各 bot 的微信账号凭证（每 bot 一个 <accountId>.json，0600）
├── config.json     # 全局配置（工作目录、模型、系统提示词、授权用户等）
├── sessions/       # 会话数据（按 <accountId>__<用户> 分文件，每成员独立）
├── sync/           # 长轮询游标（每 bot 一个 <accountId>.json，互不覆盖）
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

> Codex 自身的会话记录存在 `~/.codex/sessions/`（由 `codex` CLI 管理，本桥接通过 `thread_id` 续接）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `WCX_DATA_DIR` | 覆盖数据目录（默认 `~/.wechat-codex-code`） |
| `WCX_SHOW_COMMANDS=1` | 把 Codex 每条 shell 命令作为进度推到微信（默认关，避免刷屏 / 限频） |
| `WCX_SANDBOX` | Codex 沙箱策略：`read-only` / `workspace-write` / `danger-full-access`（配 `--ask-for-approval never`）。**默认不设 = 绕过沙箱与审批**（完全权限，等同历史行为）。注重安全可设为 `workspace-write` 把 Codex 限制在工作区内 |
| `WCX_LOG_FULL_BODY=1` | 调试：完整打印 ilink API 请求体 |
| `OPENAI_API_KEY` / `CODEX_HOME` | 透传给 daemon（若你用 API key 方式而非 `codex login`） |

## License

[MIT](LICENSE) · 移植自 [dizhu/wechat-claude-code](https://github.com/dizhu/wechat-claude-code)
