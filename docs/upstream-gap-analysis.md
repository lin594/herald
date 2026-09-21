# Upstream Gap Analysis

Base: `LetTTGACO/agent-notify` @ e86631d (2026-09-04). TypeScript + Hono + Zod, pnpm, vitest, Node http server, JSONL event log.
Read verdicts below come from reading `src/server/*`, `src/formatters/codex.ts`, `src/providers/*`, `src/cli/index.ts`, `examples/codex/codex-agent-notify.mjs`, plus real-machine hook probes (see `environment-findings.md`).

## Capability table

| Capability | Upstream status | Action | Notes |
| --- | --- | --- | --- |
| Bark sender | exists, POST JSON, `timeSensitive`/`active` level mapping | **MODIFY** | No timeout, no retry (spec requires 5s timeout + bounded backoff; failure must not crash server — currently isolated already via try/catch). Add group per agent (already `group:"Codex"` in formatter). |
| ntfy sender | exists | **KEEP** | Unused here but harmless. |
| Docker deployment | exists (`deploy/docker/*`) | **MODIFIED** (done) | Added `127.0.0.1:` port prefix, `name:` to avoid project collision, optional `NPM_REGISTRY` build-arg for this network. |
| Token auth | exists (`name:token` pairs, Bearer) | **KEEP** | Satisfies §51 without OAuth/JWT. |
| Codex hook adapter | exists; expects `hook_event_name/session_id/cwd/last_assistant_message/tool_input` | **KEEP** | Real payloads from Codex 0.153.4 match exactly — no compat layer needed. `PermissionRequest` forwarding default false → **MODIFY**: we want it; enable via adapter config. |
| Formatters (codex/claude/opencode) | exists, zh/en, project prefix from cwd | **KEEP** | Title style (`[Project] Need approval`) close to target; state-machine notifications are additive, not replacing. |
| Project identification | cwd basename | **MODIFY** | Add explicit `projects` mapping table (spec §20) in monitor config. |
| Session long-task threshold | CodexSessionPolicy: memory Map, start on UserPromptSubmit, gate Stop by ≥120s | **MODIFY** | Semantics correct (Stop = turn complete, not task complete) but volatile: restart loses turn-start state → Stop after restart is silently suppressed (`missing_start`). Persist in SQLite. |
| Cooldown/dedup | CooldownPolicy: in-memory, only permission/question kinds, window refresh | **MODIFY** | Needs (a) persistence across restart, (b) content-fingerprint dedup for FAILED-like repeats (FAILED×N → 1, FAILED→ACTIVE→FAILED → 2nd allowed). |
| Mute switches (`/agent-notify on/off/…`) | exists per-agent in adapters | **KEEP** | |
| JSONL event log + redaction | exists (`logging/jsonl.ts`, `redact.ts`), body ≤80 chars | **KEEP** | Satisfies log-safety; raw payloads default off. |
| Durable state store | none (memory Maps; JSONL append-only log is audit, not state) | **ADD** | SQLite via node:sqlite (Node 22.5+/24 built-in — runtime is node:20 alpine in Docker → **MODIFY** Dockerfile runtime to node:24-alpine; host Node is 24.11). No ORM. |
| HTTP API surface | `GET /health`, `POST /events` only | **ADD** | `/status`, `/sessions`, `/observations`, `/host-heartbeat`, plus `GET /events` (debug). |
| State machine (8 states + host state) | absent (only turn gating) | **ADD** | `src/monitor/state-machine.ts` — pure, clock-injectable (spec §63). |
| Cooperative emit events | absent (only hook-shaped agent events; test CLI posts a fake opencode event) | **ADD** | extend `incomingEvent` enum with `emit` agent type: `{type: started|milestone|waiting|blocked|failed|completed|heartbeat…}`; CLI `agent-notify emit <type> "<msg>"`. |
| Heartbeat (adaptive 15/30/10/25) | absent | **ADD** | scheduler in server process, env-configurable seconds for tests. |
| Quiet / stall / resume | absent | **ADD** | multi-factor activity: hooks + transcript growth + host observations + fs/git watcher results. |
| Host process/session observation | absent | **ADD** | thin host bridge (`host/cbm-host.mjs`) POSTs `/observations` (facts only) + `/host-heartbeat` (30s). |
| Sleep/wake awareness | absent | **ADD** | bridge detects heartbeat gaps; monitor maps gap>threshold to HOST_UNREACHABLE, never agent stall; no notification replay on resume. |
| Workspace / Git / artifact watcher | absent | **ADD** | in-container, read-only bind mounts only, 30–60s cadence, `git` via read-only subcommands (`status --porcelain`, `diff --shortstat`) with cache; artifact glob patterns. |
| Subagent / rapid-event suppression | cooldown partially covers | **MODIFY** | debounce + parent-session rollup per claude-code-notify-watch ideas. |
| Notification policy table | scattered in policies/formatters | **MODIFY** | consolidate into `src/monitor/policy.ts` decision table; state machine + cooldown feed it. |
| CLI (`test`, `doctor`) | exists, minimal | **MODIFY** | extend doctor checks (orbstack, compose, hooks probe, bridge, mounts); add `emit`, `install-host`, `uninstall-host`, `up/down/status/sessions/logs` wrappers. |
| Health endpoint | exists; compose healthcheck wired | **KEEP** | extend payload with db/scheduler status (degraded without restart loop). |
| Qoder support | none upstream (Codex/Claude Code/OpenCode only) | **ADD** (done) | Qoder's hook contract is the same JSON-on-stdin family, so the addition is a `qoder` agent enum value + formatter + adapter, not a new pipeline. Qoder's `UserPromptSubmit`/`Stop` pair has identical turn semantics to Codex → **MODIFY** `CodexSessionPolicy` to gate both on the shared completion threshold instead of adding a fifth policy. |

## Explicit DROP list

None of upstream functionality is dropped. New layers are additive under `src/monitor/`; `/events` pipeline keeps existing behavior so upstream tests stay green (fork contract, spec §46).

## Stack verdict

Keep TypeScript/pnpm/Hono. No technical obstacle found: node:sqlite covers durability after bumping the Docker runtime image to node:24-alpine (single-line change, also matches host Node 24).
