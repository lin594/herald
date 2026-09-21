<div align="center">

## Herald — state-change monitor for long-running AI agents

[Human Installation Manual](docs/human-manual-en.md)

[![](https://img.shields.io/github/stars/lin594/herald?labelColor\&style=flat-square\&color=ffcb47)](https://github.com/lin594/herald)
[![](https://img.shields.io/github/issues/lin594/herald?labelColor=black\&style=flat-square\&color=ff80eb)](https://github.com/lin594/herald/issues)
[![](https://img.shields.io/github/last-commit/lin594/herald?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/lin594/herald/commits/main)

Fork of [LetTTGACO/agent-notify](https://github.com/LetTTGACO/agent-notify) — see [Fork lineage](#fork-lineage).

</div>


You start a task, tell the agent to go, and walk away. Two hours later you have
no idea whether it is still working, waiting for an approval you would have
given in five seconds, or died silently at 03:00. Dashboards do not help,
because you are not looking at a dashboard.

**Herald watches the run and pushes one notification per state change that
matters** — needs input, blocked, failed, finished, a stall that started, a
stall that resolved, and a throttled "still alive" heartbeat. Everything else
stays silent.

```
Qoder · proofreader · 等你批准          Monitor · 疑似卡住
批准删除文件                            已 25 分钟没有任何可观察动作
git status --porcelain                  已跑 1 小时 12 分 · 44 文件 +1208 −15
```

- **Two independent axes.** Session state and host availability are tracked
  separately, so a sleeping laptop is never reported as a failed agent, and a
  12-hour sleep never surfaces as "stalled 12 hours".
- **Silence is the default.** Notifications are edge-triggered and deduped by
  content fingerprint, and the fingerprint table lives in SQLite, so a restart
  replays nothing.
- **Four evidence channels.** Hook events (cooperative), session transcript
  growth, host process facts, and read-only workspace/git observation. No
  single channel is trusted to say "working".
- **A turn is not a task.** `Stop` means one turn ended; Herald only calls a
  task done when the agent says so.
- **Local by construction.** Containerized, loopback-only API, explicit
  read-only mounts (never `~` wholesale), secrets redacted before they reach
  the push provider, no account and no telemetry.

Underneath it is the upstream pipeline, unmodified in behaviour: hook events in,
short action-focused notifications out, delivered by Bark (iPhone / Apple Watch)
or ntfy (everything else).

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
| Codex | command hook + adapter | `UserPromptSubmit`, `Stop`, `PermissionRequest` |
| Qoder (IDE + CLI) | command hook + adapter | `UserPromptSubmit`, `Notification`, `Stop`, `StopFailure`, `PermissionRequest` |

The adapter is fail-safe: server errors never block the agent. Long-task completion is tracked in the server, so adapters stay stateless.

## Notification providers

| Platform / Device | Bark | ntfy |
| --- | --- | --- |
| iPhone / Apple Watch | ✅ recommended | ✅ |
| Android | ❌ | ✅ recommended |
| macOS desktop | ❌ | ✅ |
| Windows desktop | ❌ | ✅ |
| Linux desktop | ❌ | ✅ |
| Web browser | ❌ | ✅ |

## Quickstart

1. `cp .env.example .env` and fill in `BARK_ENDPOINT` (or `NTFY_ENDPOINT`) plus
   `AGENT_NOTIFY_TOKENS`. Keep it `chmod 600`; it is gitignored.
2. `./herald up` — builds and starts the container stack (API on `127.0.0.1:8787`).
3. `./herald install-host` — registers the Codex and Qoder hooks and loads the
   macOS Host Bridge LaunchAgent. Trust the hooks once in the Codex TUI, and
   restart Qoder once (its hook config has no hot reload).
4. `./herald test` then `./herald doctor` — one forced push and a full health
   check of provider, hooks, bridge, mounts and database.

Agents can also report cooperatively with one call —
`./herald emit waiting "…"` (or the equivalent `{"agent":"emit", …}` POST) —
which is the only supported way for an agent to influence what you get paged
for; see [docs/agent-integration.md](docs/agent-integration.md).

## Operations

`./herald status` · `./herald sessions` · `./herald logs` · `./herald down`

Design and runbook docs: [architecture](docs/architecture.md) ·
[notification policy table](docs/notification-policy.md) ·
[agent integration](docs/agent-integration.md) ·
[troubleshooting](docs/troubleshooting.md) ·
[environment findings](docs/environment-findings.md) ·
[upstream gap analysis](docs/upstream-gap-analysis.md) ·
[implementation summary](IMPLEMENTATION_SUMMARY.md).

## Upstream manuals

The three manuals below describe the base notification pipeline (they predate
this fork and use its `agent-notify` naming):

- [人类使用手册（中文）](docs/human-manual-cn.md)
- [Human Manual (English)](docs/human-manual-en.md)
- [AI Operation Manual](docs/ai-operation-manual.md) — end-to-end deployment for AI agents

To have an AI agent set this fork up, clone it and hand it the operation manual:

```bash
git clone https://github.com/lin594/herald.git
cd herald
```

```
Follow docs/ai-operation-manual.md to set this up, but use ./herald instead of the
agent-notify CLI, and read docs/agent-integration.md for the monitor-specific parts.
```

## Fork lineage

Herald is a fork of **[LetTTGACO/agent-notify](https://github.com/LetTTGACO/agent-notify)**
by [LetTTGACO](https://github.com/LetTTGACO), MIT-licensed. Everything in
`src/server`, `src/core`, `src/formatters`, `src/providers` and `examples` is
upstream code, kept behaviour-compatible on purpose; the monitor lives in
`src/monitor` and `host/` and hooks in at three points only
([why, and what was evaluated](docs/upstream-gap-analysis.md)).

- Branch off: `main`, upstream base commit `e86631d`.
- Keep up to date:

  ```bash
  git remote add upstream https://github.com/LetTTGACO/agent-notify.git
  git fetch upstream && git merge upstream/main
  ```

- Report upstream-only bugs (hooks, formatters, providers) against the
  [upstream repository](https://github.com/LetTTGACO/agent-notify/issues);
  monitor-specific ones here.

## License

[MIT](LICENSE) © LetTTGACO (upstream) · © 2026 lin594 (Herald additions)
