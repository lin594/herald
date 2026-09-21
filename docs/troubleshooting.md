# Troubleshooting

Start with `./herald doctor` — it checks config, provider, log dir, health, and
whether a Host Bridge has ever checked in. Then the container logs:
`./herald logs`.

## No notifications at all

1. `./herald test` — sends a forced test through the full pipeline (bypasses dedup).
   Works → downstream policy is silencing you, not connectivity.
2. `BARK_ENDPOINT` in `.env` must be your real device key URL
   (`https://api.day.app/<key>`); restart with `./herald up` after editing.
3. Provider failure is never dedup-remembered: fix the key and the next real
   event will send. Heartbeats/stalls resume on their own.

## Codex hooks are silent

- **One-time trust**: open `codex` in a TUI, run `/hooks`, trust them. Until
  trusted, Codex skips all hooks (by design, verified on 0.153.4).
- `~/.codex/hooks.json` should contain the adapter command under
  `Stop`/`UserPromptSubmit`/`PermissionRequest`; re-run `./herald install-host`
  (idempotent — it merges, never clobbers, and backs up unexpected shapes).
- Adapter errors are fail-open: they never block Codex, so check
  `~/.config/agent-notify/logs/` and `AGENT_NOTIFY_DEBUG`.
- Legacy `notify = [...]` in `~/.codex/config.toml` must be a TOP-LEVEL key
  (not inside a table) or Codex ignores it.

## Qoder hooks are silent

- Qoder has **no hook trust step** but also no hot reload: fully restart the
  IDE (or start a new CLI session) after `./herald install-host`.
- The adapter lives under the `hooks` key of `~/.qoder/settings.json`, next to
  unrelated settings — check those entries survived, and that a project-level
  `.qoder/settings.json` is not overriding the user file for that repo.
- Only `UserPromptSubmit`, `PermissionRequest`, `Notification`
  (`permission_prompt`), `Stop` and `StopFailure` are registered. Tool events are
  dropped by design, so "no notification for each command" is not a bug.
- Adapter failures are fail-open like Codex: see
  `~/.config/agent-notify/logs/qoder-hook.log`.
- No `processes`/activity for a Qoder session in `/sessions` means the
  `~/.qoder/projects` mount or `HERALD_QODER_DIR` is unset — the desktop app is
  intentionally not counted as a working process.

## Host shows unreachable / "Host Signal Lost"

- Bridge runs as LaunchAgent: `launchctl print gui/$(id -u)/com.lin594.herald-host`
  (`state = running`); log: `~/.config/agent-notify/logs/host-bridge.log`.
- Restart it: `launchctl kickstart -k gui/$(id -u)/com.lin594.herald-host`.
- It POSTs to `http://127.0.0.1:8787`; if the container is down, ticks fail
  silently and recover when it returns.
- After a real sleep/wake the monitor re-baselines all clocks — you should see
  no flood and no "stalled for hours". If you do, the bridge log's
  `sleepGapSeconds` is the smoking gun.

## Sessions look stuck ACTIVE forever

Usually over-matching processes: only interactive agent invocations count;
resident daemons (`codex app-server`, `Codex Framework Helper`, updaters) are
filtered (`RESIDENT_MARKERS` in `host/herald-host.mjs`). Add a marker if a new
daemon family appears, and confirm via `host-bridge.log` `"processes":N` when
nothing should run (should be 0).

## No workspace/git stats on sessions

- Workspace mounts live in `deploy/docker/docker-compose.override.yml`
  (template: `docker-compose.override.example.yml`). The `./herald` wrapper merges
  it; plain `docker compose -f …` does NOT.
- `HERALD_WORKSPACES[].path` must equal the container path of the `:ro` mount.
- Session ↔ workspace matching: `project` name or workspace path — set
  `HERALD_EMIT_PROJECT`/`HERALD_PROJECT_MAP` so they agree.
- First observation after (re)start is a baseline sweep (reports no delta);
  changes show up from the second sweep (~30 s).

## "Stall" fired but the agent was fine

Stall requires zero signals: no emit, no process, no transcript growth, no
file change, host up. Likely the transcripts aren't mounted
(`HERALD_TRANSCRIPT_DIR` + `HERALD_HOST_CODEX_SESSIONS_DIR`) or the session's
`session_id` differs between channels (hooks use Codex UUIDs; emit uses yours —
keep one per task).

## Container won't start

- `ERR_MODULE_NOT_FOUND 'sqlite'` — build-time esbuild rewrites `node:sqlite`;
  `src/monitor/db.ts` loads it via `createRequire`. Rebuild: `./herald up`.
- npm flakiness: `NPM_REGISTRY=https://registry.npmmirror.com ./herald up`.
- Port busy: something already on 127.0.0.1:8787 (`lsof -nPti :8787`).

## Data & reset

Everything monitor-side is one SQLite file + event log on the named volume:
`docker compose -f deploy/docker/docker-compose.yml --env-file .env down -v`
wipes it (fresh dedup state). `deploy/docker/docker-compose.override.yml` and
`.env` are machine-local; `./herald uninstall-host` cleanly removes the LaunchAgent
(`--all` also strips the adapter entries from hooks.json, with backups).
