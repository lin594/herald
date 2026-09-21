<div align="center">

## AgentNotify: Personal Notification Hub for AI Coding Agents

English / [中文](README-CN.md)

[Human Installation Manual](docs/human-manual-en.md)

[![](https://img.shields.io/github/stars/LetTTGACO/agent-notify?labelColor\&style=flat-square\&color=ffcb47)](https://github.com/LetTTGACO/agent-notify)
[![](https://img.shields.io/github/issues/LetTTGACO/agent-notify?labelColor=black\&style=flat-square\&color=ff80eb)](https://github.com/LetTTGACO/agent-notify/issues)
[![](https://img.shields.io/github/contributors/LetTTGACO/agent-notify?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/LetTTGACO/agent-notify/graphs/contributors)
[![](https://img.shields.io/github/last-commit/LetTTGACO/agent-notify?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/LetTTGACO/agent-notify/commits/main)

</div>


AgentNotify receives hook events from OpenCode, Claude Code, and Codex, formats short action-focused notifications on the server, logs safe event summaries, and pushes them to your phone or desktop via Bark or ntfy.

## What it does

- Receives raw hook events from OpenCode, Claude Code, and Codex.
- Formats short, action-focused notifications server-side (permission requests, prompts, errors, long-task completion).
- Prefixes notification titles with the project name when the agent provides a working directory.
- Keeps short tasks quiet and only pings when a session has run long enough to matter.
- Tames rapid notify-handle-continue loops with a session-scoped cooldown for permission/question alerts.
- Provides per-tool `/agent-notify` switches for session, timed, and persistent muting.
- Pushes through Bark (iPhone / Apple Watch) or ntfy (cross-platform).

## Supported agents

| Agent | How it connects | Forwards |
| --- | --- | --- |
| OpenCode | plugin example | permission / question / session-error / idle-completion events |
| Claude Code | command hook + adapter | `UserPromptSubmit`, selected `Notification`, `Stop`, `StopFailure` |
| Codex | command hook + adapter | `UserPromptSubmit`, `Stop`, optional `PermissionRequest` |

The adapter is fail-safe: server errors never block the agent. Long-task completion is tracked in the AgentNotify server, so adapters stay stateless.

## Notification providers

| Platform / Device | Bark | ntfy |
| --- | --- | --- |
| iPhone / Apple Watch | ✅ recommended | ✅ |
| Android | ❌ | ✅ recommended |
| macOS desktop | ❌ | ✅ |
| Windows desktop | ❌ | ✅ |
| Linux desktop | ❌ | ✅ |
| Web browser | ❌ | ✅ |

## Codex Bark Monitor (this fork)

Everything above, plus a durable monitor for **hours-long agent tasks**: it
tracks each session through a state machine and pushes only the state changes
that matter — needs-input, blocked, failed, completed, once-per-episode
stall/resume edges, and adaptive "still running" heartbeats (15/30 min,
≤3/hour). A 12-hour laptop sleep never becomes a "stalled 12 hours" alarm.

- Runs entirely local: containerized (Docker/OrbStack), loopback-only API,
  SQLite on a named volume, secrets redacted before Bark.
- A thin macOS Host Bridge (LaunchAgent) supplies real process/transcript/sleep
  facts; workspaces are watched strictly read-only (git is never mutated).
- Hook integrations for **Codex** and **Qoder** (IDE + CLI) come from the same
  installer; both reuse the shared turn/task rules, so a finished turn is never
  mistaken for a finished task.
- Agents report cooperatively with one call:
  `{"agent":"emit","raw":{"type":"waiting","message":"…"}}` → `./cbm emit waiting "…"`
  — see [docs/agent-integration.md](docs/agent-integration.md).

Quickstart: fill `.env` (`BARK_ENDPOINT`, `AGENT_NOTIFY_TOKENS`) →
`./cbm up` → `./cbm install-host` (then trust hooks once in the Codex TUI, and
restart Qoder once — its config has no hot reload) → `./cbm test`.
Ops docs: [architecture](docs/architecture.md) ·
[policy table](docs/notification-policy.md) ·
[troubleshooting](docs/troubleshooting.md) ·
[implementation summary](IMPLEMENTATION_SUMMARY.md).

## Documentation

Human manual:

- [人类使用手册（中文）](docs/human-manual-cn.md)
- [Human Manual (English)](docs/human-manual-en.md)

End-to-end deployment manual for AI coding agents:

- [AgentNotify AI Operation Manual](docs/ai-operation-manual.md)

AI-assisted setup is recommended to start from a local project directory. First manually clone this repository and enter the project root:

```bash
git clone git@github.com:LetTTGACO/agent-notify.git
cd agent-notify
```

Then start your AI agent in that directory and send it this:

```
Follow this manual to set up and configure AgentNotify:
https://raw.githubusercontent.com/LetTTGACO/agent-notify/refs/heads/main/docs/ai-operation-manual.md
```

## License

[MIT](LICENSE) © LetTTGACO
