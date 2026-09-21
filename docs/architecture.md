# Architecture

Codex Bark Monitor (CBM) is a fork of [agent-notify](https://github.com/LetTTGACO/agent-notify)
extended with a durable execution monitor. The upstream notify pipeline is
kept intact; everything CBM adds sits behind it and is failure-isolated.

```
             macOS host (outside Docker)                       Docker (OrbStack)
 ┌─────────────────────────────────────────────┐   ┌───────────────────────────────────────────┐
 │  Codex CLI                                  │   │            agent-notify container          │
 │   ├─ hooks.json ──> codex-agent-notify.mjs ─┼──▶│  POST /events (Bearer token)               │
 │   └─ transcripts ~/.codex/sessions/…        │   │    │                                        │
 │                                             │   │    ▼                                        │
 │  cbm-host (LaunchAgent, 30 s tick)          │   │  MonitorHub ── state ──▶ SQLite (/data)     │
 │   ├─ ps + transcript scan (facts only)  ────┼──▶│    │              /data/monitor.sqlite3     │
 │   └─ sleep-gap detection                ────┼──▶│    ▼                                        │
 │                                             │   │  MonitorScheduler (15 s tick, pure state    │
 │  iPhone ◀───────────────────────────────────┼───┼── machine + adaptive heartbeat)             │
 │                                             │   │    │                                        │
 │  watch :ro mounts                           │   │    ▼                                        │
 │   ~/.codex/sessions → /host/.codex/…  ◀─────┼───┼── workspace/git observers (:ro, read-only)  │
 │   <repo>            → /work/<repo>     ◀────┼──▶│    │                                        │
 └─────────────────────────────────────────────┘   │    ▼  redact → dedup → rate-limit           │
                                                   │  MonitorNotifier ──▶ Bark (HTTPS POST)      │
        127.0.0.1:8787 loopback-published          │  upstream formatters/providers (unchanged)  │
        host bridge ──▶ CLI: ./cbm …  ────────────▶└───────────────────────────────────────────┘
```

## Components

| Piece | Where | Responsibility |
|---|---|---|
| Upstream pipeline | `src/server`, `src/core`, `src/formatters`, `src/providers` | Receive hook events, format per-agent notifications, cooldown/session policies, Bark/ntfy delivery. Unchanged semantics; CBM touches it at three points: policy persistence, hub early-handling, and the shared content-safety helpers on every provider send. |
| MonitorHub | `src/monitor/hub.ts` | Ingests every event into the durable model: hook state, cooperative `emit`, host heartbeats, observations. Never blocks the notify path — failures are logged and swallowed. |
| MonitorScheduler | `src/monitor/scheduler.ts` | Owns time: 15 s tick, per-session `evaluateSessionTick` (pure), host up/down transitions, wake re-baseline, workspace/transcript sweeps. |
| State machine | `src/monitor/statemachine.ts` | UNKNOWN/STARTED/ACTIVE/QUIET/WAITING_USER/BLOCKED/FAILED/COMPLETED + HOST_AVAILABLE/HOST_UNREACHABLE (separate axis: host loss is never agent failure). |
| MonitorNotifier | `src/monitor/notifier.ts` | The single exit for monitor-originated notifications: redact → cap → fingerprint dedup → heartbeat rate limit → provider. The upstream formatted path applies the same `safeTitle`/`safeBody` (`src/monitor/redact.ts`) before its own `provider.send`. |
| Store | `src/monitor/store.ts`, `db.ts` | SQLite (`node:sqlite`) on named volume: sessions, events, notifications (restart-safe suppression), host heartbeats, fingerprint table. Also backs upstream cooldown/turn policies via injected `persist`. |
| Observers | `src/monitor/observers.ts` | Container-side, strictly read-only: transcript growth (Codex `sessions/YYYY/MM/DD` and Qoder `projects/<slug>/<id>.jsonl`), workspace mtime walk, `git status/diff --shortstat` (never add/commit/reset), artifact glob match. |
| Host Bridge | `host/cbm-host.mjs` | Thin macOS facts collector (LaunchAgent): process presence, active rollout/session UUIDs (Codex `sessions/` and Qoder `projects/<slug>/`), sleep-gap. No policy, no notification decisions. The Qoder desktop binary is a resident marker — only its transcripts and its CLI process count as work. |

## Data flow invariants

- **One path to the phone for monitor logic**: everything the monitor decides
  goes through `MonitorNotifier`; agents never POST Bark directly. Agents
  report cooperatively via `emit` (`./cbm emit …` or HTTP).
- **Facts vs judgment**: the host bridge and observers only produce facts
  (counts, mtimes, gaps). All interpretation lives in the state machine, which
  is pure and clock-injected.
- **Loopback-only API**: compose publishes `127.0.0.1:8787:8787` only; tokens
  gate every mutating route (`/status` is the unauthenticated local overview).
- **Read-only exposure**: host mounts are explicit and `:ro` — never `~` or
  `/Users` wholesale. git is only ever invoked with read subcommands.
- **Failure isolation**: DB down → events still notify (upstream path);
  one workspace scan error → other workspaces keep working; provider down →
  fingerprint not remembered so the next tick retries.

## Extension points

- New agent: adapter POSTs `{agent, raw}` to `/events`; hub keys sessions by
  `token:session_id`. Agent types are additive (`src/core/incoming-event.ts`).
  Qoder is the worked example: one formatter, one adapter, one enum value, and
  the existing `CodexSessionPolicy` (same turn/task semantics) — no new route,
  store, or scheduler path.
- New provider: implement `NotificationProvider`; both pipelines use it.
- Claude Code/CI workers: the cooperative `emit` contract needs no CBM-side code
  at all — a single `curl` is a complete integration.
