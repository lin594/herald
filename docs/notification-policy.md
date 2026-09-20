# Notification Policy

The single rule behind everything below: **notify state changes that matter,
never raw activity.** Every notification in this table is the one-time edge of
a state transition or a bounded summary — never a stream of "still working".

All timings are `CBM_*`-configurable (`src/monitor/config.ts`); defaults shown.
Tests drive these with injected clocks, never real waits.

## Per-session states

| Trigger | Transition | Notification | Level | Dedup / rate |
|---|---|---|---|---|
| Hook / emit first seen | → STARTED | none (silence = "it began") | — | — |
| Any observed activity | → ACTIVE | none | — | — |
| `emit started/milestone/completed/waiting/blocked/failed` | records message, may move state | `started` · `milestone` · `completed` … | milestone/completed: passive·active per kind | fingerprint (kind+body); identical repeat suppressed; `./cbm test`/force bypasses |
| `emit waiting` / PermissionRequest | → WAITING_USER | "Need Input" / "Permission" | **timeSensitive** | fingerprint; cleared when activity resumes |
| Idle ≥ `CBM_QUIET_SECONDS` (10 min) | ACTIVE → QUIET | none | — | — |
| QUIET ≥ `CBM_STALL_SECONDS` (25 min) with host available and zero signals | QUIET → UNKNOWN | "Possible Stall" — once per episode | timeSensitive | fingerprint; cleared on resume/re-baseline |
| Activity returns after QUIET | QUIET → ACTIVE | "Resumed" | **passive** (low priority) | once per episode |
| Long turn (`Stop` ≥ `AGENT_NOTIFY_*_COMPLETION_MIN_SECONDS`, 120 s) | → WAITING_USER | upstream "turn finished" wording — **a turn, not the task** | per upstream | upstream cooldown policy |
| Working session, first heartbeat at `CBM_HEARTBEAT_FIRST_SECONDS` (15 min), then every `CBM_HEARTBEAT_NORMAL_SECONDS` (30 min), only if content changed | — | "Running" summary (elapsed, last activity, files, ±lines, stage, artifacts) | passive | ≤ `CBM_HEARTBEAT_MAX_PER_HOUR` (3) per session per rolling hour; skipped when host unreachable |
| `FAILED` event × N identical | stays FAILED | once | active | fingerprint; a resume/activity edge between failures clears it → a genuine second failure notifies again |

## Host-level states (orthogonal to session states)

| Trigger | Transition | Notification | Dedup / rate |
|---|---|---|---|
| Host Bridge heartbeat gap > `CBM_HOST_HEARTBEAT_TIMEOUT_SECONDS` (180 s) while a session is working | HOST_AVAILABLE → HOST_UNREACHABLE | "Host Signal Lost" (sleep or network) — **not** an agent failure | once (`host_lost` fingerprint) |
| Heartbeats resume | HOST_UNREACHABLE → HOST_AVAILABLE | none. Recovery re-baselines every working session's clocks to now and status→QUIET: a 12 h sleep can never surface as "stalled 12 h", and no notifications replay | clears stall/resume fingerprints |

## Content safety (applied to every send, `MonitorNotifier`)

1. Secret redaction **before** Bark: `password/token/secret/api_key/Authorization/Bearer/AWS_SECRET/BARK_DEVICE_KEY/private-key headers/sk-…/ghp_…` → `[REDACTED]`.
2. Bodies that are ≥3 `[REDACTED]` markers are suppressed wholesale.
3. Body capped at `CBM_MAX_BODY_CHARS` (default 1200); title at 120.
4. Prompts, source code, logs and paper text are never sent as bodies — only the
   short cooperative `emit` messages and state summaries above.
5. Provider failure never remembers the fingerprint: the next tick may retry.

## Restart safety

Fingerprints, heartbeat counters and session state live in
`/data/monitor.sqlite3` (named volume). After `docker restart` the monitor
reconciles from stored timestamps — historical notifications are never replayed.

Implementation: `src/monitor/statemachine.ts` (decisions), `src/monitor/scheduler.ts`
(tick + host transitions), `src/monitor/notifier.ts` (dedup/limit/redact/send),
`src/monitor/hub.ts` (event ingestion).
