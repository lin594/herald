# Agent Integration

Two channels, both landing on the same server — never talk to Bark directly.

1. **Passive (hooks)** — automatic, already wired for Codex and Qoder by `./herald install-host`.
2. **Cooperative (`emit`)** — the agent tells the monitor what stage it is at.
   Highest-signal channel; any agent or worker can use it with one HTTP call.

## Codex (verified on 0.153.4, macOS)

`./herald install-host` does everything: writes `~/.config/agent-notify/{host,codex}.json`,
merges the adapter into `~/.codex/hooks.json` (`Stop`, `UserPromptSubmit`,
`PermissionRequest`), and installs the Host Bridge LaunchAgent.

One-time manual step: Codex skips untrusted hooks until you approve them once
in the TUI (`/hooks`). Until then no hook events arrive — the monitor still
works via emit + observations.

Legacy note: the old top-level `notify = [...]` in `config.toml` still works
as a fallback; hooks are preferred and both can coexist (server-side dedup).

## Qoder (IDE and CLI, same hook contract)

`./herald install-host` writes `~/.config/agent-notify/qoder.json` and merges the
adapter into the `hooks` key of `~/.qoder/settings.json`, leaving every other
setting untouched (backed up first, idempotent). `./herald uninstall-host --all`
removes exactly those entries again.

Unlike Codex there is **no trust prompt**, but also **no hot reload**: restart
Qoder once after installing. Hook payloads arrive as JSON on stdin; the adapter
(`examples/qoder/qoder-agent-notify.mjs`) forwards them as `{"agent":"qoder","raw":…}`.

To wire it by hand instead of using the installer:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [{ "type": "command",
        "command": "node /path/to/herald/examples/qoder/qoder-agent-notify.mjs",
        "timeout": 5 }] }
    ]
  }
}
```

Project-level `.qoder/settings.json` and `.qoder/settings.local.json` override
the user file, so a repo can opt in or out independently.

| Qoder hook event | session state | phone |
|---|---|---|
| `UserPromptSubmit` | ACTIVE, turn clock starts | — |
| `PermissionRequest` | WAITING_USER | timeSensitive |
| `Notification` (`permission_prompt` only) | WAITING_USER | timeSensitive |
| `Stop` | long turn → WAITING_USER ("Ready to review"); short turn suppressed by the shared completion gate | active |
| `StopFailure` | FAILED | timeSensitive |

Hook pushes are formatted by the upstream pipeline, which sets its own delivery
level; the monitor's tier policy (`HERALD_MIN_SEVERITY`) governs the state it
observes itself and every `emit` push below.

Qoder's `Stop` is a *turn* boundary, so it never marks the task done — use
`emit completed` for that. `SessionEnd` (clear/logout/resume) is not forwarded
either: it says the UI closed, not that the work finished. Same for tool-level
events (`PreToolUse`, `PostToolUse`, `SubagentStart`, `PreCompact`,
`FileChanged`, …): activity, not state.

The desktop app lives for hours, so `ps` says nothing about whether a session is
working. The Host Bridge instead watches `~/.qoder/projects/<slug>/<uuid>.jsonl`
mtimes and reports the uuid as an observed session; the container mirrors that
with `HERALD_HOST_QODER_PROJECTS_DIR` + `HERALD_QODER_DIR` (read-only). Without the
mount, hook events alone still drive every state above.

## Cooperative emit (any agent: Codex, Qoder, Claude Code, CI workers)

```bash
curl -sS http://127.0.0.1:8787/events \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"agent":"emit","raw":{
        "type":"waiting",
        "message":"Choose schema A or B for the migration",
        "project":"my-repo", "session_id":"job-42", "hostname":"mac" }}'
```

Or from a shell inside the container: `./herald emit <type> "<message>"`
(env: `HERALD_EMIT_PROJECT`, `HERALD_EMIT_SESSION`, `HERALD_EMIT_AGENT`, `HERALD_EMIT_CWD`).

| type | meaning | session state | strength |
|---|---|---|---|
| `started` | long task genuinely began | STARTED | `debug` — not delivered at the default floor |
| `milestone` | phase done, artifact produced | ACTIVE | `notice` |
| `waiting` | needs a human decision now | WAITING_USER | `critical` |
| `blocked` | stuck on external thing, needs attention | BLOCKED | `critical` |
| `failed` | task cannot continue | FAILED | `critical` |
| `completed` | task finished, result ready | COMPLETED | `notice` |

Strength is the policy layer's, not the agent's: `HERALD_MIN_SEVERITY` raises the
floor and `HERALD_SEVERITY_MAP=completed=debug` re-tunes a kind, so a team can
quiet `milestone` without anyone editing the emitter. See
[notification-policy.md](notification-policy.md#notification-strength).

Rules for agents:
- Emit at **state changes**, not progress ticks. Identical repeats are
  fingerprint-deduped server-side anyway.
- `message` ≤ a sentence: it is redacted + capped at 1200 chars, but send
  summaries, never logs/prompts/source.
- Mark a `milestone` right after writing an artifact and name the file in the
  message; the workspace observer also picks artifacts up automatically.

## Suggested instructions block for an agent's AGENTS.md / system prompt

```
You are monitored by Herald. Report ONLY state changes via:
  POST http://127.0.0.1:8787/events  (Bearer token in $AGENT_NOTIFY_TOKEN value)
  body {"agent":"emit","raw":{"type":"…","message":"…","project":"<repo>","session_id":"<task id>"}}
Use started/milestone/waiting/blocked/failed/completed. Never notify for
routine progress. When you need user input, emit "waiting" BEFORE stopping.
"Task done" = emit completed; a finished turn is NOT completion.
```

## Turning it off briefly

Upstream mute switches (`/agent-notify` session/timed/persistent mute) still
apply to hook-origin notifications. Monitor-side silence, from gentlest to
bluntest: raise `HERALD_MIN_SEVERITY` (`notice` keeps completions, stalls and
everything that needs a human; `critical` keeps only waiting/blocked/failed),
retune one kind with `HERALD_SEVERITY_MAP`, emit nothing, or
`HERALD_ENABLED=false` + restart for total monitor quiet.
