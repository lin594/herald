# Implementation Summary

Fork of `LetTTGACO/agent-notify` extended into **Herald**:
a long-lived local monitor for hours-long AI-agent tasks that pushes only
state changes that matter to iPhone via Bark. Deliberately NOT a rewrite —
upstream notify/format/cooldown machinery is kept and reused.

381 tests pass (`pnpm test`), typecheck clean, live stack verified in
Docker/OrbStack against a mock Bark; Host Bridge live on macOS LaunchAgent.

## VERIFIED (implemented + proven by test or live run)

**Runtime & security boundary**
- Docker/OrbStack compose (node:24-alpine + git), loopback-only
  `127.0.0.1:8787`, named volume `/data/monitor.sqlite3`, non-root, no
  privileged mode, no docker.sock, explicit `:ro` host mounts only.
- Bearer-token auth on every mutating route (401 without); `/status` is the
  unauthenticated local overview. Doctor redacts the endpoint key in output.
- `node:sqlite` via `createRequire` (works around tsup/esbuild import rewrite).

**State machine & policy** (`src/monitor/`, docs/notification-policy.md)
- 8 session states + orthogonal HOST_AVAILABLE/HOST_UNREACHABLE; host loss is
  never reported as agent stall (unit + scheduler tests, injected clocks).
- Quiet (10 min) → stall (25 min) edge once; resume edge once, `info` tier.
- Notification strength (`src/monitor/severity.ts`): every push resolves to
  `debug|info|notice|critical` (operator map > per-push override > built-in
  table), which drives the Bark delivery level and an `HERALD_MIN_SEVERITY`
  floor checked before redaction, dedup or recording — a suppressed push leaves
  no fingerprint, so raising the floor later cannot swallow it.
- A stall is a claim about work in flight, so it needs evidence: the turn verdict
  is tri-state (`in flight` / `closed cleanly` / `nothing observable`). A closed
  turn retires silently; a blind clock-out still notifies but says
  "by clock alone" at `info`. Codex `task_started`/`task_complete` brackets are
  now read through the bookkeeping records that trail them, and a resumed
  thread's composite filename indexes under every id it carries — before this,
  every rollout of a resumed session was invisible to the scan. Measured on the
  operator's own `~/.codex/sessions`: 28 of 34 indexed rollouts now resolve to
  a closed turn, 0 to an open one (none resolved at all before). Live proof
  against the running container, shortened timers, mock Bark: a
  `task_complete` rollout produced **no** push, an open turn produced one
  `possible_stall` at `active`, a session with nothing to read produced the
  clock-alone wording at `passive`, `HERALD_SEVERITY_MAP=possible_stall=debug`
  silenced both stalls, and `emit started` never left the process.
- Adaptive heartbeat 15 min first / 30 min after, content-gated, ≤3/h/session
  (enforced in notifier, proven in integration test H).
- FAILED×N identical dedup by (kind+body) fingerprint; any interleaved
  progress edge re-arms → second genuine failure notifies again.
- Sleep/wake: bridge reports sleep-gap; on host return all clocks re-baseline,
  a 12 h sleep cannot surface as a stall, zero replay (scheduler test).
- Restart safety: fingerprints/counters/sessions on the volume; container
  restart replays nothing (file-backed test + live docker restart observed).

**Ingestion & observation**
- Cooperative `emit started|milestone|waiting|blocked|failed|completed` via
  `/events` (never direct Bark); per-kind dedup clears; provider failure does
  not remember the fingerprint (retry allowed).
- Codex hooks (UserPromptSubmit/Stop/PermissionRequest/StopFailure) update
  state only; **Stop is treated as a turn, never task completion**.
- Qoder (`agent:"qoder"`): same hook family, own formatter + adapter, and the
  same `CodexSessionPolicy` turn gate (identical UserPromptSubmit/Stop
  semantics). PermissionRequest and approval `Notification`s land in
  WAITING_USER with a timeSensitive push — integration test C-qoder. Live E2E
  against mock Bark on a fixture transcript mount: prompt→ACTIVE, idle→QUIET,
  stall→`notice` (delivered at Bark `active`), transcript growth→"Resumed",
  `Stop` stayed ACTIVE; all
  pushes carried group `Qoder` and titles `[Qoder] <project> · …`.
- Installer hook merge is pure and unit-tested in `host/hooks-merge.mjs`
  (`parseHooksDoc`/`ensureHooks`/`stripHooks`): unrelated top-level keys in
  `~/.qoder/settings.json` survive, re-install is idempotent, uninstall removes
  only our own entries and restores the file byte-for-byte.
- Secret redaction + suppression + body/title caps apply to **every** push
  before Bark: monitor sends and the upstream formatted sends now share
  `safeBody`/`safeTitle` (integration test I; live proof — a Qoder tool
  description containing `api_key=…` and `token: …` arrived as
  `Upload with [REDACTED] and [REDACTED]`, which leaked verbatim before this
  fix was found by the live run).
- Container-side read-only: transcript growth (Codex nested YYYY/MM/DD, Qoder
  `<project-slug>/<session-id>.jsonl`), workspace mtime walk, `git
  status/diff --shortstat` strictly read-only, artifact globs. Live-verified:
  session showed changedFiles/±lines/artifact from a real mount.
- Host Bridge (LaunchAgent, 30 s): heartbeat + facts-only observations;
  resident daemons filtered; live `processes:0` when idle, `HOST_AVAILABLE`
  in `/status`, and `sessionIds:3` from real `~/.qoder/projects` transcripts
  on the current Qoder session(s).

**Tooling**
- `./herald` wrapper (up/down/logs/test/doctor/emit/status/sessions/install-host/
  uninstall-host), `pnpm test`/`typecheck` clean, mock-Bark end-to-end smoke:
  emit → phone payload with correct title/level/group.

## BEST_EFFORT (implemented, needs real-world tuning)

- **Hook E2E on the user's machine**: requires the one-time Codex TUI `/hooks`
  trust (verified schema/merge only; cannot be automated).
- **Process detection heuristics**: basename allow-list + resident markers —
  new agent distributions may need a marker added (troubleshooting §"stuck ACTIVE").
- **Session↔workspace matching**: via project name / `HERALD_PROJECT_MAP`;
  multi-session-per-repo attribution is coarse by design.
- **Transcript growth channel** works only when `HERALD_TRANSCRIPT_DIR` (Codex) /
  `HERALD_QODER_DIR` (Qoder) + their read-only mounts are configured (off by default).
- **Subagent/rapid-loop debouncing**: relies on upstream cooldown policy rather
  than a Herald-specific mechanism.
- **Qoder hook E2E**: installer, adapter, formatter and policy are covered by
  tests; a real phone notification additionally needs one Qoder restart (no
  config hot-reload) and the `~/.qoder/projects` mount.
- Claude Code / generic workers: emit-capable through the documented contract,
  no Herald-side installer (upstream ships its own adapters).

## NOT_IMPLEMENTED (deliberate)

- Dashboard/web UI or real-time feeds (CLI polls `/status`).
- Redis/Postgres/K8s, remote/hosted deployment, multi-tenant or LAN exposure.
- Windows/Linux Host Bridge (macOS LaunchAgent only; bridge itself is portable).
- Direct-Bark fallback mode, agent-prompt auto-injection, notification replay
  after restart, model APIs / log shipping / paper-text ingestion.

## Key files

| Area | Paths |
|---|---|
| Server wiring | `src/server/index.ts`, `src/server/app.ts` |
| Monitor core | `src/monitor/{statemachine,scheduler,notifier,hub,store,db,config,observers,redact,types}.ts` |
| Host bridge | `host/{herald-host.mjs,hooks-merge.mjs,install-host.mjs,uninstall-host.mjs}`, `deploy/host/*.plist.template` |
| Agent adapters | `examples/codex/codex-agent-notify.mjs`, `examples/qoder/qoder-agent-notify.mjs`, `src/formatters/{codex,qoder}.ts` |
| Deploy | `deploy/docker/{docker-compose.yml,docker-compose.override.example.yml,Dockerfile}`, `.env.example`, `herald` |
| Tests | `tests/monitor/*`, `tests/host/*` (incl. `hooks-merge`), `tests/integration/stack.test.ts` (A/B/C/C-qoder/D/E/G/H/I), upstream suites extended in place for the qoder envelope/policy and content-safety assertions |
| Docs | `docs/{environment-findings,upstream-gap-analysis,architecture,agent-integration,notification-policy,troubleshooting}.md` |
