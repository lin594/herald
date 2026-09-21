import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const adapter = await import("../../examples/qoder/qoder-agent-notify.mjs");

const config = {
  serverUrl: "http://127.0.0.1:8787",
  token: "tok",
  timeoutMs: 2000,
  notifyPermissionRequests: true,
};

describe("Qoder adapter", () => {
  it("forwards state-change events and drops tool-level noise", () => {
    for (const event of [
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "StopFailure",
    ]) {
      expect(adapter.shouldForwardQoderEvent({ hook_event_name: event })).toBe(
        true,
      );
    }
    for (const event of ["SessionStart", "PostToolUse", "PreCompact", "FileChanged"]) {
      expect(adapter.shouldForwardQoderEvent({ hook_event_name: event })).toBe(
        false,
      );
    }
    expect(adapter.shouldForwardQoderEvent({})).toBe(false);
  });

  it("forwards only approval notifications", () => {
    expect(
      adapter.shouldForwardQoderEvent({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      }),
    ).toBe(true);
    expect(
      adapter.shouldForwardQoderEvent({
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
      }),
    ).toBe(false);
  });

  it("honours the permission mute switch", () => {
    expect(
      adapter.shouldForwardQoderEvent(
        { hook_event_name: "PermissionRequest" },
        { notifyPermissionRequests: false },
      ),
    ).toBe(false);
    expect(
      adapter.shouldForwardQoderEvent(
        { hook_event_name: "Stop" },
        { notifyPermissionRequests: false },
      ),
    ).toBe(true);
  });

  it("validates config", () => {
    expect(adapter.parseQoderConfig({ serverUrl: "http://x", token: "t" })).toMatchObject(
      { timeoutMs: 2000, notifyPermissionRequests: true },
    );
    expect(() => adapter.parseQoderConfig({ token: "t" })).toThrow(/serverUrl/);
    expect(() => adapter.parseQoderConfig({ serverUrl: "http://x" })).toThrow(/token/);
    expect(() =>
      adapter.parseQoderConfig({ serverUrl: "http://x", token: "t", timeoutMs: -1 }),
    ).toThrow(/timeoutMs/);
  });

  it("reads config from <home>/.config/agent-notify/qoder.json", () => {
    const home = join(tmpdir(), `herald-qoder-home-${Date.now()}`);
    mkdirSync(join(home, ".config", "agent-notify"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-notify", "qoder.json"),
      JSON.stringify({ serverUrl: "http://server", token: "abc", timeoutMs: 500 }),
    );

    expect(adapter.readQoderConfig(home)).toMatchObject({
      serverUrl: "http://server",
      timeoutMs: 500,
    });
  });

  it("posts the raw payload as agent=qoder with a bearer token", async () => {
    const raw = {
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      cwd: "/work/repo",
      tool_name: "Bash",
      tool_input: { command: "rm -rf dist" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(adapter.handleQoderEvent(config, raw, { fetchImpl })).resolves.toEqual({
      forwarded: true,
      sent: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8787/events");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ agent: "qoder", raw });
  });

  it("never throws when the server is unreachable, and skips filtered events", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(
      adapter.handleQoderEvent(config, { hook_event_name: "Stop" }, { fetchImpl: failing }),
    ).resolves.toEqual({ forwarded: true, sent: false });

    const silent = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      adapter.handleQoderEvent(
        config,
        { hook_event_name: "PostToolUse", tool_name: "Bash" },
        { fetchImpl: silent },
      ),
    ).resolves.toEqual({ forwarded: false, sent: false });
    expect(silent).not.toHaveBeenCalled();
  });
});
