<div align="center">

## Herald：AI 编程代理的状态变化监控

[English](README.md) / 中文

[人类安装手册](docs/human-manual-cn.md)

[![](https://img.shields.io/github/stars/lin594/herald?labelColor\&style=flat-square\&color=ffcb47)](https://github.com/lin594/herald)
[![](https://img.shields.io/github/issues/lin594/herald?labelColor=black\&style=flat-square\&color=ff80eb)](https://github.com/lin594/herald/issues)
[![](https://img.shields.io/github/contributors/lin594/herald?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/lin594/herald/graphs/contributors)
[![](https://img.shields.io/github/last-commit/lin594/herald?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/lin594/herald/commits/main)

</div>


> **本仓库是 [lin594/herald](https://github.com/lin594/herald)（MIT）的 fork：Herald。**
> 下面保留的是上游通知管道的原始中文手册；Herald 新增的「长任务状态监控」见下一节，
> 完整说明在 [README.md](README.md)（英文）与 [docs/notification-policy.md](docs/notification-policy.md)。

## Herald 是什么

你启动一个几小时的任务就走开。两小时后你不知道它是在干活、在等你批准、还是凌晨三点悄悄挂了。
看板没用，因为你没在看板。

**Herald 盯着这次运行，只在「状态真的变了」时推一条**：等你输入、被卡住、失败、跑完、
卡住刚开始、卡住已恢复，外加一条限流的「还活着」心跳。其余时间一律安静。

```
Codex · herald · 等你输入
跑一下 sessions 表的迁移
本轮用时 12 分钟 · 任务已跑 1 小时 12 分 · 44 文件改动 +1208 −15

Codex · herald · 疑似卡住
已 25 分钟没有任何可观察动作
44 文件改动 +1208 −15
```

标题固定是 `Agent · 项目 · 状态`，正文先回答「我要做什么」，再补一行上下文：本轮用了多久、
任务一共跑了多久、改了多少。项目名取自工作区声明的 `project`，或 `HERALD_PROJECT_MAP`；
拿不到名字时显示 `会话 1a2b3c4d`，绝不把一串 hash 甩在锁屏上。英文推送见 [README.md](README.md)。

- **两条正交轴**：会话状态与宿主机可达性分开判。笔记本睡眠不会被算成 agent 失败，
  睡 12 小时也不会变成「停滞 12 小时」。
- **沉默是默认值**：通知按状态边沿触发，正文指纹去重，指纹表在 SQLite 里，重启不补发。
- **四路证据**：hook 事件（agent 主动汇报）、会话 transcript 增长、宿主机进程事实、
  工作区/git 只读观察。任何单一路信号都不足以判定「在干活」。
- **一轮 ≠ 一个任务**：`Stop` 只代表一轮结束；只有 agent 明确宣告完成任务才算完成。
- **完全本地**：容器化运行、API 只监听 `127.0.0.1`、只读挂载（绝不整盘挂 `~`）、
  推送前脱敏、无账号无遥测。

上手：`cp .env.example .env` 填好 `BARK_ENDPOINT` 与 `AGENT_NOTIFY_TOKENS` → `./herald up`
→ `./herald install-host` → `./herald test`。细节见 [docs/agent-integration.md](docs/agent-integration.md)。

AgentNotify 接收 OpenCode、Claude Code 和 Codex 的 hook 事件，在服务端格式化成简短、行动导向的通知，记录安全的事件摘要，并通过 Bark 或 ntfy 推送到你的手机或桌面。

## 它能做什么

- 接收 OpenCode、Claude Code 和 Codex 的原始 hook 事件。
- 在服务端格式化简短、行动导向的通知（权限请求、提问、错误、长任务完成）。
- 统一标题格式 `Agent · 项目 · 状态`，并在正文补一行耗时与改动量，锁屏上就能分诊。
- 让短任务保持安静，只在会话运行时间足够长时提醒你。
- 用会话级冷却压住高频「通知-处理-继续」循环，减少权限/问题提醒刷屏。
- 提供按工具独立的 `/agent-notify` 开关，支持当前会话、定时和持久静音。
- 通过 Bark（iPhone / Apple Watch）或 ntfy（跨平台）推送。

## 支持的 agent

| Agent | 接入方式 | 转发事件 |
| --- | --- | --- |
| OpenCode | plugin 示例 | permission / question / session-error / idle-completion 事件 |
| Claude Code | command hook + adapter | `UserPromptSubmit`、选定的 `Notification`、`Stop`、`StopFailure` |
| Codex | command hook + adapter | `UserPromptSubmit`、`Stop`、`PermissionRequest` |
| Qoder（IDE + CLI） | command hook + adapter | `UserPromptSubmit`、`Notification`、`Stop`、`StopFailure`、`PermissionRequest` |

Adapter 是 fail-safe 的：服务端错误不会阻塞 agent。长任务完成状态由 AgentNotify 服务端跟踪，因此 adapter 保持无状态。

## 通知方式

| 平台 / 设备 | Bark | ntfy |
| --- | --- | --- |
| iPhone / Apple Watch | ✅ 推荐 | ✅ |
| Android | ❌ | ✅ 推荐 |
| macOS 桌面 | ❌ | ✅ |
| Windows 桌面 | ❌ | ✅ |
| Linux 桌面 | ❌ | ✅ |
| Web 浏览器 | ❌ | ✅ |

## 文档

人类使用手册：

- [人类使用手册（中文）](docs/human-manual-cn.md)
- [Human Manual (English)](docs/human-manual-en.md)

给 AI 编程代理看的端到端部署手册：

- [AI 使用手册](docs/ai-operation-manual.md)

AI 辅助安装建议从本地项目目录开始。请先手动克隆本仓库并进入项目根目录：

```bash
git clone git@github.com:LetTTGACO/agent-notify.git
cd agent-notify
```

然后在该目录中启动你的 AI Agent，并把这段发给它：

```
根据这份文档帮我配置AgentNotify:
https://raw.githubusercontent.com/LetTTGACO/agent-notify/refs/heads/main/docs/ai-operation-manual.md
```

## License

[MIT](LICENSE) © LetTTGACO
