# Agent Integration

Two channels, both landing on the same server — never talk to Bark directly.

1. **Passive (hooks)** — automatic, already wired for Codex by `./cbm install-host`.
2. **Cooperative (`emit`)** — the agent tells the monitor what stage it is at.
   Highest-signal channel; any agent or worker can use it with one HTTP call.

## Codex (verified on 0.153.4, macOS)

`./cbm install-host` does everything: writes `~/.config/agent-notify/{host,codex}.json`,
merges the adapter into `~/.codex/hooks.json` (`Stop`, `UserPromptSubmit`,
`PermissionRequest`), and installs the Host Bridge LaunchAgent.

One-time manual step: Codex skips untrusted hooks until you approve them once
in the TUI (`/hooks`). Until then no hook events arrive — the monitor still
works via emit + observations.

Legacy note: the old top-level `notify = [...]` in `config.toml` still works
as a fallback; hooks are preferred and both can coexist (server-side dedup).

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

Or from a shell inside the container: `./cbm emit <type> "<message>"`
(env: `CBM_EMIT_PROJECT`, `CBM_EMIT_SESSION`, `CBM_EMIT_AGENT`, `CBM_EMIT_CWD`).

| type | meaning | session state | phone level |
|---|---|---|---|
| `started` | long task genuinely began | STARTED | passive |
| `milestone` | phase done, artifact produced | ACTIVE | active |
| `waiting` | needs a human decision now | WAITING_USER | timeSensitive |
| `blocked` | stuck on external thing, needs attention | BLOCKED | timeSensitive |
| `failed` | task cannot continue | FAILED | timeSensitive |
| `completed` | task finished, result ready | COMPLETED | active |

Rules for agents:
- Emit at **state changes**, not progress ticks. Identical repeats are
  fingerprint-deduped server-side anyway.
- `message` ≤ a sentence: it is redacted + capped at 1200 chars, but send
  summaries, never logs/prompts/source.
- Mark a `milestone` right after writing an artifact and name the file in the
  message; the workspace observer also picks artifacts up automatically.

## Suggested instructions block for an agent's AGENTS.md / system prompt

```
You are monitored by Codex Bark Monitor. Report ONLY state changes via:
  POST http://127.0.0.1:8787/events  (Bearer token in $AGENT_NOTIFY_TOKEN value)
  body {"agent":"emit","raw":{"type":"…","message":"…","project":"<repo>","session_id":"<task id>"}}
Use started/milestone/waiting/blocked/failed/completed. Never notify for
routine progress. When you need user input, emit "waiting" BEFORE stopping.
"Task done" = emit completed; a finished turn is NOT completion.
```

## Turning it off briefly

Upstream mute switches (`/agent-notify` session/timed/persistent mute) still
apply to hook-origin notifications. Monitor-side silence: emit nothing, or
`CBM_ENABLED=false` + restart for total monitor quiet.
