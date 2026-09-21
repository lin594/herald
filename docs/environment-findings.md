# Environment Findings

Date: 2026-09-20. All items verified on THIS machine unless marked otherwise.
Legend: **VERIFIED** = observed on this machine with a real command · **BEST_EFFORT** = partially observable or requires setup · **UNAVAILABLE** = proven not to work here.

## Host / runtime

| Item | Value | Status |
| --- | --- | --- |
| macOS | 12.7.5 Monterey, build 21H1222 | VERIFIED |
| CPU arch | x86_64 (Intel) | VERIFIED |
| OrbStack | 1.7.5 (1070500); daemon NOT auto-started — `orb start` needed | VERIFIED |
| Docker engine | 27.3.1 (via OrbStack socket `~/.orbstack/run/docker.sock`) | VERIFIED |
| Docker Compose | v2.29.7 | VERIFIED |
| Host Node | v24.11.0, pnpm 10.32.1 (corepack) | VERIFIED |
| Host Python | 3.13.0 | VERIFIED |
| VSCode | 1.138.0, extensions `openai.chatgpt` (Codex) installed | VERIFIED |
| npm registry (direct) | flaky from this network (ECONNRESET, <50KB/s); docker build needs `NPM_REGISTRY=https://registry.npmmirror.com` build-arg | VERIFIED |

## Codex CLI (0.153.4) — hook & signal inventory

| Signal | Status | Evidence / notes |
| --- | --- | --- |
| `hooks.json` at `~/.codex/hooks.json` (Claude-Code-style command hooks) | **VERIFIED (CLI)** | Real capture: UserPromptSubmit / Stop / PermissionRequest all fire with stdin JSON payloads. Hooks are **skipped until trusted** (one-time TUI review-and-trust). `--dangerously-bypass-hook-trust` exists for single-invocation testing only — never use it in production config. |
| Stop payload schema | VERIFIED | `{session_id, turn_id, transcript_path, cwd, hook_event_name:"Stop", model, permission_mode, stop_hook_active, last_assistant_message}` — matches upstream adapter expectations exactly (no key renames needed). |
| UserPromptSubmit payload | VERIFIED | same envelope + `prompt`. |
| PermissionRequest payload | VERIFIED | same envelope + `tool_name` ("Bash"), `tool_input.{command, description}`. Fires on sandbox-escalation approval under `approval_policy=on-request`. Reliable "user needed" signal. |
| Legacy `notify = [...]` in config.toml | VERIFIED (fallback) | Fires once per turn with type `agent-turn-complete`; payload arrives as **argv[1]** (NOT stdin): `{type, thread-id, turn-id, cwd, client:"codex_exec", input-messages, last-assistant-message}`. Keep only as legacy fallback; primary channel is hooks. |
| Session transcript rollout | VERIFIED | `transcript_path` points to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — growing JSONL, a good in-progress activity channel (host bridge can tail it). |
| `codex agents` (shared app-server session browse) | BEST_EFFORT | Exists in 0.153.4; interactive TUI only from what we saw; not pursued (no deep reverse-engineering per project rule). |
| VSCode Codex triggering the same hooks/notify | **UNVERIFIED** | Cannot be tested headlessly here. `~/.codex/hooks.json` is user-level and the extension shares `~/.codex` state (sessions dir confirmed populated by extension usage), so it plausibly fires — but we do not claim it. Cooperative `emit` events are the guaranteed channel for VSCode sessions. |
| Multi-session concurrency | VERIFIED (model-level) | session_id is per-thread UUID; state layers must key by it, which upstream already does. |

## Qoder (IDE + CLI) — hook & signal inventory

| Signal | Status | Evidence / notes |
| --- | --- | --- |
| Hook config location | **VERIFIED (file) + docs** | `~/.qoder/settings.json` exists on this machine (observed content: only `enabledPlugins`), and `hooks` is a top-level sibling key per docs. Project-level `.qoder/settings.json` / `.qoder/settings.local.json` merge over it (lowest→highest). |
| Hook entry shape | docs | `{"matcher"?: "…", "hooks":[{"type":"command","command":"…","timeout":30,"if"?: "…","async"?: false}]}` — same family as Codex/Claude Code, so the adapter pattern carries over unchanged. |
| Event inventory | docs | IDE/JB plugin: 12 events (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, SessionEnd, PreCompact, Notification). CLI: 23, additionally StopFailure, PermissionDenied, PostCompact, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate/Remove, Elicitation(+Result). Each entry point only runs events it supports. |
| stdin payload | docs | `{session_id, cwd, hook_event_name, transcript_path, request_set_id?, tool_name?, tool_input?, tool_response?, extra{email,repo,branch,request_time,response_time,full_diff_text}}`; per-event extras: `prompt` (UserPromptSubmit), `tool_name/tool_input/permission_suggestions` (PermissionRequest), `notification_type/message/title/details` (Notification), `stop_hook_active/last_assistant_message` (Stop), `reason` (SessionEnd). Same envelope Codex uses → no renames. |
| Trust confirmation | **VERIFIED (absent)** | No `/hooks` review step: an installed hook runs as soon as the config is loaded, unlike Codex. |
| Config reload | docs | No hot reload — the IDE/CLI must be restarted after editing `settings.json`. |
| Blocking behaviour | docs | `exit 0` continues, `exit 2` blocks (stderr feeds the agent), anything else is a non-fatal error. `Stop` is **blocking**, so the adapter must stay fast — 2 s HTTP timeout, `timeout: 5` in the hook entry, always exit 0. |
| Session transcripts | **VERIFIED** | `~/.qoder/projects/<project-slug>/<session-uuid>.jsonl` — one directory per project (slug is the cwd with separators replaced, e.g. `-Users-me-…-b537d940d7d3c66f5e1ad0ca`), flat JSONL inside. A real file of that shape was read on this machine. |
| `session_id` == transcript file stem | **VERIFIED (transcript side)** | Each record in a real session file carries a top-level `sessionId` equal to that file's stem (checked on this machine, 2026-09-21), so both bridge and container scans key on the same identifier Qoder itself uses. What is still unobserved is a live hook payload (registering hooks needs one Qoder restart); if the two ever diverge, transcript-derived activity stops matching while hook events keep working. |
| Desktop app as an activity signal | **VERIFIED** | `/Applications/Qoder.app/Contents/MacOS/Qoder` runs for hours regardless of work → classified resident in the host bridge; only a `qoder` CLI process counts as per-session activity. |

## Notification channel

| Item | Value | Status |
| --- | --- | --- |
| Bark | server+key provided by user later in `.env` (`BARK_ENDPOINT` = full URL incl. device key, upstream style) | PENDING USER — mock-server path VERIFIED in tests |

## Design consequences

1. Host bridge + container must treat **hooks as primary**, `notify` as legacy fallback.
2. The hook command runs synchronously inside Codex's turn — adapter must stay fail-safe and fast (upstream's 2s timeout + swallow-errors design is correct; KEEP).
3. Hook trust is a one-time interactive step: `install-host` must instruct the user to review-and-trust in the next `codex` TUI launch, and `doctor` must WARN when no hook has ever fired (probe file).
4. `transcript_path` gives us real "is it still working" evidence even during long silent stretches (pytest, builds) — use via host observation.
5. Qoder is a Codex-shaped integration with two differences: no one-time hook trust (so `install-host` is genuinely complete after a restart), and a **blocking** `Stop` hook — the adapter must be fast and fail-silent, and `doctor` cannot tell the user to "go trust the hooks" for Qoder.
6. The Qoder desktop app is always-running, so `ps` is useless there: session liveness for Qoder comes from transcript mtimes, and the app binary is a resident marker in the bridge.
