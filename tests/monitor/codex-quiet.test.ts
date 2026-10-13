import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { parseMonitorConfig } from "../../src/monitor/config.js";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { MonitorNotifier } from "../../src/monitor/notifier.js";
import { MonitorScheduler } from "../../src/monitor/scheduler.js";
import { MonitorHub } from "../../src/monitor/hub.js";
import { evaluateSessionTick } from "../../src/monitor/statemachine.js";
import { classifyTranscriptTail, latestCodexProgress } from "../../src/monitor/observers.js";
import type { NotificationPayload } from "../../src/providers/types.js";

const T0 = 1_700_000_000_000;
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });
function fixture(env: NodeJS.ProcessEnv = {}, threshold = 120) {
  const config = parseMonitorConfig({ HERALD_DB_PATH: ":memory:", ...env });
  const db = openDatabase(":memory:");
  closes.push(() => db.close());
  const store = new MonitorStore(db);
  const sent: NotificationPayload[] = [];
  const provider = { name: "mock", send: vi.fn(async (p: NotificationPayload) => { sent.push(p); return { ok: true }; }) };
  const notifier = new MonitorNotifier(store, provider, config);
  const scheduler = new MonitorScheduler(store, notifier, config);
  const hub = new MonitorHub({ store, notifier, scheduler, config, tokens: [{ name: "mac", value: "token" }], completionMinSeconds: threshold });
  const hook = (name: string, at: number, extra: Record<string, unknown> = {}) => hub.handleIncoming({ agent: "codex", raw: { hook_event_name: name, session_id: "thread", cwd: "/work/herald", ...extra } }, "mac", at);
  return { config, db, store, sent, provider, notifier, scheduler, hub, hook };
}

describe("Codex quiet Bark policy", () => {
  it("records 100 approve-for-me requests without claiming a human is needed, even at zero grace", async () => {
    const f = fixture({ HERALD_WAITING_GRACE_SECONDS: "0" });
    await f.hook("UserPromptSubmit", T0);
    for (let i = 1; i <= 100; i++) await f.hook("PermissionRequest", T0 + i, { tool_name: "Bash" });
    await f.scheduler.run(T0 + 90_000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
    expect(f.store.recentEvents(200)).toHaveLength(101);
  });

  it("does not replay legacy or disabled approval timers after an upgrade", async () => {
    for (const waitingKind of [null, "approval"] as const) {
      const f = fixture();
      await f.hook("UserPromptSubmit", T0);
      f.store.updateSession("mac:thread", { status: "WAITING_USER", waitingSinceMs: T0, waitingOn: "Bash", waitingKind });
      await f.scheduler.run(T0 + 120_000);
      expect(f.sent).toHaveLength(0);
      expect(f.store.getSession("mac:thread")).toMatchObject({ status: "UNKNOWN", waitingSinceMs: null, waitingOn: null });
    }
  });

  it("a resolved manual approval stays quiet; duplicate request hooks do not rearm it", async () => {
    const f = fixture({ HERALD_CODEX_APPROVAL_ALERTS: "true" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PermissionRequest", T0 + 1000, { tool_name: "Bash", tool_use_id: "call" });
    await f.hook("PermissionRequest", T0 + 2000, { tool_name: "Bash", tool_use_id: "call" });
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBe(T0 + 1000);
    await f.hook("PostToolUse", T0 + 3000, { tool_name: "Bash", tool_use_id: "call" });
    await f.scheduler.run(T0 + 70_000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
  });

  it("a blocking question alerts once and unrelated progress cannot answer it", async () => {
    const f = fixture({ AGENT_NOTIFY_LANGUAGE: "zh" });
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PreToolUse", T0 + 1000, { tool_name: "request_user_input", tool_use_id: "question", tool_input: { questions: [{ question: "选择哪个部署环境？" }] } });
    await f.hook("PostToolUse", T0 + 2000, { tool_name: "Bash", tool_use_id: "parallel" });
    f.scheduler.recordObservation({ sessionId: "thread", atMs: T0 + 62_000, processCount: 1 });
    await f.scheduler.run(T0 + 62_000);
    await f.scheduler.run(T0 + 80_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].title).toContain("等你输入");
    expect(f.sent[0].body).toBe("选择哪个部署环境？");
    expect(f.sent[0].level).toBe("timeSensitive");
    await f.hook("PostToolUse", T0 + 90_000, { tool_use_id: "question" });
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
  });

  it("nonblocking questions and routine milestones do not page the user", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await f.hook("PreToolUse", T0 + 1000, { tool_name: "request_user_input_async" });
    await f.hub.handleIncoming({ agent: "emit", raw: { type: "milestone", message: "one file saved", session_id: "thread", agent_type: "codex" } }, "mac", T0 + 2000);
    await f.notifier.notify("mac:thread", { kind: "resumed", title: "Resumed", body: "more activity" }, T0 + 3000);
    expect(f.sent).toHaveLength(0);
    expect(f.store.getSession("mac:thread")?.status).toBe("ACTIVE");
  });

  it("completion uses ordinary delivery, concise text and turn dedup, including concurrent Stops", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    await Promise.all([f.hook("Stop", T0 + 121_000, { turn_id: "turn1", last_assistant_message: "Summary ".repeat(100) }), f.hook("Stop", T0 + 121_001, { turn_id: "turn1", last_assistant_message: "different formatting" })]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].level).toBe("active");
    expect(f.sent[0].body.length).toBeLessThan(220);
    expect(f.store.getSession("mac:thread")?.lastTurnMs).toBe(121_000);
    await f.hook("UserPromptSubmit", T0 + 200_000);
    await f.hook("Stop", T0 + 321_000, { turn_id: "turn2", last_assistant_message: "Summary" });
    expect(f.sent).toHaveLength(2);
  });

  it("short, disabled and stop-hook continuation turns stay quiet", async () => {
    for (const threshold of [120, 0]) {
      const f = fixture({}, threshold);
      await f.hook("UserPromptSubmit", T0);
      await f.hook("Stop", T0 + 300_000, { stop_hook_active: true });
      expect(f.store.getSession("mac:thread")?.turnStartedMs).toBe(T0);
      await f.hook("Stop", T0 + 10_000);
      expect(f.sent).toHaveLength(0);
    }
  });

  it("interrupt and session close clear waits without calling the task completed", async () => {
    for (const event of ["Interrupt", "SessionEnd"]) {
      const f = fixture();
      await f.hook("UserPromptSubmit", T0);
      await f.hook("PreToolUse", T0 + 1000, { tool_name: "request_user_input", tool_use_id: "question" });
      await f.hook(event, T0 + 2000);
      await f.scheduler.run(T0 + 1900_000);
      expect(f.sent).toHaveLength(0);
      expect(f.store.getSession("mac:thread")?.waitingSinceMs).toBeNull();
      expect(f.store.getSession("mac:thread")?.status).toBe("UNKNOWN");
    }
  });

  it("first digest is due at 30 minutes, is passive, and unchanged work is not repeated", async () => {
    const f = fixture();
    await f.hook("UserPromptSubmit", T0);
    f.store.updateSession("mac:thread", { lastMessage: "测试已经通过，正在检查部署配置。", lastActivityMs: T0 + 1700_000 });
    await f.scheduler.run(T0 + 1799_000);
    expect(f.sent).toHaveLength(0);
    await f.scheduler.run(T0 + 1800_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).toContain("测试已经通过");
    expect(f.sent[0].level).toBe("passive");
    const record = f.store.getSession("mac:thread")!;
    const result = evaluateSessionTick({ session: { ...record, lastActivityMs: record.lastHeartbeatMs! }, hostAvailable: true, processActive: false, transcriptActive: false, turnInFlight: true }, { ...f.config, stallSeconds: 10_000 }, T0 + 3600_000);
    expect(result.notifications.filter((n) => n.kind === "heartbeat")).toHaveLength(0);
  });

  it("HTTP ingestion cannot bypass the severity floor", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const f = fixture({ HERALD_MIN_SEVERITY: "critical" });
    const app = createApp({ tokens: [{ name: "mac", value: "token" }], provider: f.provider, logPath: "./data/quiet-test.jsonl", logRaw: false, language: "en", claudeCompletionMinSeconds: 120, codexCompletionMinSeconds: 120, opencodeCompletionMinSeconds: 120, cooldownSeconds: 60, monitor: f.hub });
    const post = (name: string) => app.request("/events", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", raw: { hook_event_name: name, session_id: "thread" } }) });
    expect((await post("UserPromptSubmit")).status).toBe(200);
    vi.setSystemTime(T0 + 130_000);
    const stop = await post("Stop");
    expect(await stop.json()).toEqual({ ok: true, notified: false });
    expect(f.sent).toHaveLength(0);
  });
});

describe("public Codex progress", () => {
  const record = (payload: unknown, type = "response_item") => JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type, payload });
  it("reads desktop phase and CLI channel, excluding prompts, reasoning and tool outputs", () => {
    for (const fields of [{ phase: "commentary" }, { channel: "commentary" }]) {
      const progress = record({ type: "message", role: "assistant", ...fields, content: [{ type: "output_text", text: "Tests passed; checking the deployment." }] });
      const noise = [record({ type: "message", role: "user", content: [{ type: "text", text: "private prompt" }] }), record({ type: "reasoning", text: "private reasoning" }), record({ type: "function_call_output", output: "private stdout" })];
      expect(latestCodexProgress([progress, ...noise])?.message).toBe("Tests passed; checking the deployment.");
    }
  });
  it("does not reuse an old update after a new turn or completion, and recognizes interruption", () => {
    const progress = record({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "old update" }] });
    for (const kind of ["task_started", "task_complete", "turn_aborted"]) {
      const lines = [progress, record({ type: kind }, "event_msg")];
      expect(latestCodexProgress(lines)).toBeNull();
    }
    expect(classifyTranscriptTail([record({ type: "task_started" }, "event_msg"), record({ type: "turn_aborted" }, "event_msg")])).toBe("idle");
  });
});
