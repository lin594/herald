import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/monitor/db.js";
import { MonitorStore, fingerprintOf } from "../../src/monitor/store.js";
import { CooldownPolicy } from "../../src/server/cooldown-policy.js";
import { CodexSessionPolicy } from "../../src/server/codex-session-policy.js";
import type { FormattedAgentEvent } from "../../src/core/formatted-event.js";
import type { IncomingAgentEvent } from "../../src/core/incoming-event.js";

const T0 = 1_700_000_000_000;
const dir = mkdtempSync(join(tmpdir(), "cbm-db-"));
const dbPath = join(dir, "monitor.sqlite3");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function permissionEvent(sessionId: string): FormattedAgentEvent {
  return {
    agent: "codex",
    kind: "permission_required",
    sourceEvent: "PermissionRequest",
    sessionId,
    notification: { title: "T", body: "B", urgency: "time_sensitive" },
  } as unknown as FormattedAgentEvent;
}

describe("monitor persistence across restarts", () => {
  it("survives session, dedup and host state through close/reopen", () => {
    const db = openDatabase(dbPath);
    const store = new MonitorStore(db);
    store.upsertSession({ key: "macbook:s1", sessionId: "s1", agentType: "codex", nowMs: T0, project: "P" });
    store.updateSession("macbook:s1", { status: "FAILED", lastActivityMs: T0 + 5 });
    store.rememberFingerprint("macbook:s1", "failed", fingerprintOf("macbook:s1", "failed", "boom"), T0);
    store.recordHostHeartbeat({ hostname: "mbp", nowMs: T0, bridgeVersion: "0.1" });
    db.close();

    const db2 = openDatabase(dbPath);
    const store2 = new MonitorStore(db2);
    expect(store2.getSession("macbook:s1")?.status).toBe("FAILED");
    expect(
      store2.isDuplicateFingerprint("macbook:s1", "failed", fingerprintOf("macbook:s1", "failed", "boom")),
    ).toBe(true);
    const hosts = store2.listHosts();
    expect(hosts.find((h) => h.hostname === "mbp")?.status).toBe("HOST_AVAILABLE");
    db2.close();
  });

  it("cooldown policy keeps suppressing after a restart", () => {
    const cooldownDbPath = join(dir, "cooldown.sqlite3");
    const db = openDatabase(cooldownDbPath);
    let now = T0;
    const first = new CooldownPolicy({
      cooldownSeconds: 60,
      nowMs: () => now,
      persist: new MonitorStore(db).cooldownStore(),
    });
    expect(first.apply(permissionEvent("s1"), "macbook").action).toBe("continue");
    now = T0 + 10_000;
    expect(first.apply(permissionEvent("s1"), "macbook")).toMatchObject({ reason: "cooldown" });
    db.close();

    // Restart: new process, same database file, fresh policy instance.
    const db2 = openDatabase(cooldownDbPath);
    const second = new CooldownPolicy({
      cooldownSeconds: 60,
      nowMs: () => now,
      persist: new MonitorStore(db2).cooldownStore(),
    });
    expect(second.apply(permissionEvent("s1"), "macbook")).toMatchObject({ reason: "cooldown" });
    now = T0 + 70_000;
    expect(second.apply(permissionEvent("s1"), "macbook").action).toBe("continue");
    db2.close();
  });

  it("turn state lets a Stop after restart exceed the completion threshold", () => {
    const db = openDatabase(dbPath);
    const store = new MonitorStore(db);
    let now = T0;
    const policyA = new CodexSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => now,
      persist: store.turnStore(),
    });
    const prompt = {
      agent: "codex",
      raw: { hook_event_name: "UserPromptSubmit", session_id: "s77", cwd: "/x" },
    } as unknown as IncomingAgentEvent;
    expect(policyA.apply(prompt, "macbook")).toMatchObject({ reason: "state_recorded" });
    db.close();

    // Restart: new process, same database file.
    const db2 = openDatabase(dbPath);
    const store2 = new MonitorStore(db2);
    const policyB = new CodexSessionPolicy({
      completionMinSeconds: 120,
      nowMs: () => now,
      persist: store2.turnStore(),
    });
    now = T0 + 300_000;
    const stop = {
      agent: "codex",
      raw: { hook_event_name: "Stop", session_id: "s77", cwd: "/x" },
    } as unknown as IncomingAgentEvent;
    expect(policyB.apply(stop, "macbook").action).toBe("continue");
    // turn state deleted after Stop: another Stop suppresses as missing_start
    expect(policyB.apply(stop, "macbook")).toMatchObject({ reason: "missing_start" });
    db2.close();
  });
});
