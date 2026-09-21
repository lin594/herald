# Notification Policy

The single rule behind everything below: **notify state changes that matter,
never raw activity.** Every notification in this table is the one-time edge of
a state transition or a bounded summary — never a stream of "still working".

All timings are `HERALD_*`-configurable (`src/monitor/config.ts`); defaults shown.
Tests drive these with injected clocks, never real waits.

## Per-session states

| Trigger | Transition | Notification | Level | Dedup / rate |
|---|---|---|---|---|
| Hook / emit first seen | → STARTED | none (silence = "it began") | — | — |
| Any observed activity | → ACTIVE | none | — | — |
| `emit started/milestone/completed/waiting/blocked/failed` | records message, may move state | `started` · `milestone` · `completed` … | milestone/completed: passive·active per kind | fingerprint (kind+body); identical repeat suppressed; `./herald test`/force bypasses |
| `emit waiting` / PermissionRequest | → WAITING_USER | "Need Input" / "Permission" | **timeSensitive** | fingerprint; cleared when activity resumes |
| Idle ≥ `HERALD_QUIET_SECONDS` (10 min) | ACTIVE → QUIET | none | — | — |
| QUIET ≥ `HERALD_STALL_SECONDS` (25 min) with host available and zero signals | QUIET → UNKNOWN | "Possible Stall" — once per episode, and only while a turn is unaccounted for: a transcript whose last record is `end_turn`, or a user interrupt, retires the session **silently** | timeSensitive | fingerprint; cleared on resume/re-baseline |
| Activity returns after QUIET | QUIET → ACTIVE | "Resumed" | **passive** (low priority) | once per episode; silent when the episode never reached the quiet window, e.g. right after a re-baseline |
| Long turn (`Stop` ≥ `AGENT_NOTIFY_*_COMPLETION_MIN_SECONDS`, 120 s) | → WAITING_USER | upstream "turn finished" wording — **a turn, not the task** | per upstream | upstream cooldown policy |
| Working session, first heartbeat at `HERALD_HEARTBEAT_FIRST_SECONDS` (15 min), then every `HERALD_HEARTBEAT_NORMAL_SECONDS` (30 min), only if content changed and the last turn did not end cleanly | — | "Running" summary (elapsed, last activity, files, ±lines, stage, artifacts) | passive | ≤ `HERALD_HEARTBEAT_MAX_PER_HOUR` (3) per session per rolling hour; skipped when host unreachable |
| `FAILED` event × N identical | stays FAILED | once | active | fingerprint; a resume/activity edge between failures clears it → a genuine second failure notifies again |

## Silence is not evidence

A monitor can only see writes, and a session that stopped being written to looks
identical whether it finished, was interrupted, or hung. So a stall claim needs
more than a clock: the last **message** record of the transcript is read (tail
only, `transcriptTurnEvidence`) and the verdict decides.

- Last record is an assistant `end_turn`, or a user interrupt
  (`[Request interrupted by user…]`): the turn is closed. The session is retired
  to `UNKNOWN` quietly — no "Possible Stall", no "Running" heartbeat.
- Last record is a prompt, a `tool_result`, or an assistant `tool_use`: an
  answer was owed and never came, which is what a stall looks like. The clock
  keeps the floor under it.
- No transcript at all (a cooperative `emit` agent) or a format the reader does
  not understand: treated as no evidence, so the behaviour is exactly the
  clock-based one. Missing evidence must never silence a real alert.

The transcript is only ever *read*: the monitor never writes, moves or deletes
agent session files.

## Host-level states (orthogonal to session states)

| Trigger | Transition | Notification | Dedup / rate |
|---|---|---|---|
| Host Bridge heartbeat gap > `HERALD_HOST_HEARTBEAT_TIMEOUT_SECONDS` (180 s) while a session is working | HOST_AVAILABLE → HOST_UNREACHABLE | "Host Signal Lost" (sleep or network) — **not** an agent failure | once (`host_lost` fingerprint) |
| Heartbeats resume | HOST_UNREACHABLE → HOST_AVAILABLE | none. Recovery re-baselines every working session's clocks to now and status→QUIET: a 12 h sleep can never surface as "stalled 12 h", and no notifications replay | clears stall/resume fingerprints |

## How a push reads

Both pipelines produce the same shape, so a glance is enough once you have seen
one push. Text lives in `src/core/notification-text.ts` — nothing formats a
title or a duration inline.

- **Title**: `Agent · Project · State` (`Codex · herald · Need Input`). The agent
  segment comes from `agentLabel`, the project from `HERALD_WORKSPACES[].project`
  or `HERALD_PROJECT_MAP` (explicit names win) and otherwise the cwd — a nested
  checkout resolves to the deepest configured root — and the state from
  `stateLabel`. An opaque directory or session id is rendered
  `session 1a2b3c4d` / `会话 1a2b3c4d`, never as a bare hash.
- **Body**: the action first, then one quantitative context line —
  `running 1h 12m · 44 files changed +1208 −15` /
  `已跑 1 小时 12 分 · 44 文件改动 +1208 −15` — plus `Stage:` and `Artifacts:`
  when the monitor knows them.
- **Nothing to add, nothing said**: clocks under a minute and zero-change
  diffstats are dropped, so a prompt two seconds old does not push `running 0 min`.
- **Language**: `AGENT_NOTIFY_LANGUAGE` (`en` default) drives state labels,
  durations and context lines for both pipelines.

## Content safety (every push, both pipelines)

Monitor-originated pushes go through `MonitorNotifier`; hook-derived
formatted pushes through `src/server/app.ts`. Both apply the same
`safeTitle`/`safeBody` helpers, so no push path can bypass them:

1. Secret redaction **before** Bark: `password/token/secret/api_key/Authorization/Bearer/AWS_SECRET/BARK_DEVICE_KEY/private-key headers/sk-…/ghp_…` → `[REDACTED]`.
2. Bodies that are ≥3 `[REDACTED]` markers are suppressed wholesale.
3. Body capped at `HERALD_MAX_BODY_CHARS` (default 1200); title at 120.
4. Prompts, source code, logs and paper text are never sent as bodies — only the
   short cooperative `emit` messages and state summaries above.
5. Provider failure never remembers the fingerprint: the next tick may retry.

Bark `group` is the agent display name — `Codex`, `Qoder`, or the emit
`agent_type` (`HERALD_EMIT_AGENT`) — so one session's pushes always land in the
same group. Host-level pushes (`host_lost`) are not agent-scoped and group under
`Herald`.

## Restart safety

Fingerprints, heartbeat counters and session state live in
`/data/monitor.sqlite3` (named volume). After `docker restart` the monitor
reconciles from stored timestamps — historical notifications are never replayed.

Implementation: `src/core/notification-text.ts` (shared wording),
`src/monitor/statemachine.ts` (decisions), `src/monitor/scheduler.ts`
(tick + host transitions), `src/monitor/notifier.ts` (dedup/limit/redact/send),
`src/monitor/hub.ts` (event ingestion, `digestFor`),
`src/server/app.ts` (formatter path, which appends the monitor digest).
