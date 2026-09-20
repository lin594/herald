# Implementation Summary

Fork of `LetTTGACO/agent-notify` extended into **Codex Bark Monitor (CBM)**:
a long-lived local monitor for hours-long AI-agent tasks that pushes only
state changes that matter to iPhone via Bark. Deliberately NOT a rewrite —
upstream notify/format/cooldown machinery is kept and reused.

286 tests pass (`pnpm test`), typecheck clean, live stack verified in
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
- Quiet (10 min) → stall (25 min) edge once; resume edge once, passive level.
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
- Codex hooks (UserPromptSubmit/Stop/PermissionRequest/StopFailure/SessionEnd)
  update state only; **Stop is treated as a turn, never task completion**.
- Secret redaction + suppression + body/title caps applied to every monitor
  send before Bark (integration test I).
- Container-side read-only: transcript growth (nested YYYY/MM/DD layout),
  workspace mtime walk, `git status/diff --shortstat` strictly read-only,
  artifact globs. Live-verified: session showed changedFiles/±lines/artifact
  from a real mount.
- Host Bridge (LaunchAgent, 30 s): heartbeat + facts-only observations;
  resident daemons filtered; live `processes:0` when idle, `HOST_AVAILABLE`
  in `/status`.

**Tooling**
- `./cbm` wrapper (up/down/logs/test/doctor/emit/status/sessions/install-host/
  uninstall-host), `pnpm test`/`typecheck` clean, mock-Bark end-to-end smoke:
  emit → phone payload with correct title/level/group.

## BEST_EFFORT (implemented, needs real-world tuning)

- **Hook E2E on the user's machine**: requires the one-time Codex TUI `/hooks`
  trust (verified schema/merge only; cannot be automated).
- **Process detection heuristics**: basename allow-list + resident markers —
  new agent distributions may need a marker added (troubleshooting §"stuck ACTIVE").
- **Session↔workspace matching**: via project name / `CBM_PROJECT_MAP`;
  multi-session-per-repo attribution is coarse by design.
- **Transcript growth channel** works only when `CBM_TRANSCRIPT_DIR` +
  sessions mount are configured (off by default).
- **Subagent/rapid-loop debouncing**: relies on upstream cooldown policy rather
  than a CBM-specific mechanism.
- Qoder / Claude Code / generic workers: contract documented + emit-capable;
  no dedicated installer beyond the Codex path.

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
| Host bridge | `host/{cbm-host.mjs,install-host.mjs,uninstall-host.mjs}`, `deploy/host/*.plist.template` |
| Deploy | `deploy/docker/{docker-compose.yml,docker-compose.override.example.yml,Dockerfile}`, `.env.example`, `cbm` |
| Tests | `tests/monitor/*` (43 with integration), `tests/host/*`, `tests/integration/stack.test.ts` (A/B/C/D/E/G/H/I), upstream suites untouched & green |
| Docs | `docs/{environment-findings,upstream-gap-analysis,architecture,agent-integration,notification-policy,troubleshooting}.md` |
