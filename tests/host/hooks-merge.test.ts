import { describe, expect, it } from "vitest";
import {
  ensureHooks,
  parseHooksDoc,
  stripHooks,
  type HooksDoc,
} from "../../host/hooks-merge.mjs";

interface HookEntry {
  hooks: Array<{ type?: string; command?: string; timeout?: number }>;
}

const entries = (doc: HooksDoc, event: string) =>
  doc.hooks[event] as unknown as HookEntry[];

const commands = (doc: HooksDoc, event: string) =>
  entries(doc, event).flatMap((entry) => entry.hooks.map((h) => h.command));

const QODER_CMD = "node /repo/examples/qoder/qoder-agent-notify.mjs";

describe("hooks-merge", () => {
  it("starts from an empty hooks map when the file does not exist", () => {
    const { doc, damaged } = parseHooksDoc(null);
    expect(damaged).toBe(false);
    expect(doc).toEqual({ hooks: {} });
  });

  it("keeps unrelated top-level settings and adds the missing hooks key", () => {
    const { doc, damaged } = parseHooksDoc(
      JSON.stringify({ enabledPlugins: ["qoder-canvas"], theme: "dark" }),
    );
    expect(damaged).toBe(false);
    expect(doc.enabledPlugins).toEqual(["qoder-canvas"]);
    expect(doc.theme).toBe("dark");
    expect(doc.hooks).toEqual({});
  });

  it("reports damaged input instead of trusting an unusable shape", () => {
    for (const text of ["{ not json", "[]", '"nope"', '{"hooks":[]}']) {
      const { doc, damaged } = parseHooksDoc(text);
      expect({ text, damaged, doc }).toEqual({ text, damaged: true, doc: { hooks: {} } });
    }
  });

  it("registers the command once per event and is idempotent", () => {
    const { doc } = parseHooksDoc(JSON.stringify({ enabledPlugins: [] }));
    const events = ["UserPromptSubmit", "PermissionRequest", "Stop"];

    expect(ensureHooks(doc, events, QODER_CMD, { timeout: 5 })).toBe(true);
    expect(Object.keys(doc.hooks)).toEqual(events);
    expect(entries(doc, "Stop")).toEqual([
      { hooks: [{ type: "command", command: QODER_CMD, timeout: 5 }] },
    ]);
    expect(doc.enabledPlugins).toEqual([]);

    expect(ensureHooks(doc, events, QODER_CMD, { timeout: 5 })).toBe(false);
    expect(commands(doc, "Stop")).toEqual([QODER_CMD]);
  });

  it("re-points its own stale entry at the current checkout", () => {
    const { doc } = parseHooksDoc(
      JSON.stringify({
        hooks: {
          Stop: [
            { matcher: "gpt", hooks: [{ type: "command", command: "node /keep-me.mjs" }] },
            { hooks: [{ type: "command", command: "node /old-name/agent-notify.mjs" }] },
          ],
          Notification: [{ hooks: [{ type: "command", command: "node /old-name/agent-notify.mjs" }] }],
        },
      }),
    );

    expect(ensureHooks(doc, ["Stop", "UserPromptSubmit"], QODER_CMD, { timeout: 5 })).toBe(true);
    expect(entries(doc, "Stop")).toEqual([
      { matcher: "gpt", hooks: [{ type: "command", command: "node /keep-me.mjs" }] },
      { hooks: [{ type: "command", command: QODER_CMD }] },
    ]);
    expect(entries(doc, "UserPromptSubmit")).toEqual([
      { hooks: [{ type: "command", command: QODER_CMD, timeout: 5 }] },
    ]);
    // events outside the requested set are left as they are
    expect(commands(doc, "Notification")).toEqual(["node /old-name/agent-notify.mjs"]);
  });

  it("is a no-op when the registered command already matches", () => {
    const { doc } = parseHooksDoc(
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node /elsewhere/agent-notify.mjs" }] }],
        },
      }),
    );
    expect(ensureHooks(doc, ["Stop"], "node /elsewhere/agent-notify.mjs")).toBe(false);
    expect(commands(doc, "Stop")).toEqual(["node /elsewhere/agent-notify.mjs"]);
  });

  it("preserves foreign hooks and only drops its own entries", () => {
    const { doc } = parseHooksDoc(
      JSON.stringify({
        enabledPlugins: ["sites"],
        hooks: {
          Stop: [
            { matcher: "gpt", hooks: [{ type: "command", command: "node /keep-me.mjs" }] },
            { hooks: [{ type: "command", command: QODER_CMD, timeout: 5 }] },
          ],
          Notification: [{ hooks: [{ type: "command", command: QODER_CMD }] }],
        },
      }),
    );

    expect(stripHooks(doc)).toBe(true);
    expect(doc.enabledPlugins).toEqual(["sites"]);
    expect(entries(doc, "Stop")).toEqual([
      { matcher: "gpt", hooks: [{ type: "command", command: "node /keep-me.mjs" }] },
    ]);
    expect(doc.hooks).not.toHaveProperty("Notification");
    expect(stripHooks(doc)).toBe(false);
  });

  it("install then uninstall returns the settings file to its original content", () => {
    const original = JSON.stringify({ enabledPlugins: ["qoder-canvas"] }, null, 2);
    const { doc } = parseHooksDoc(original);
    ensureHooks(doc, ["UserPromptSubmit", "Stop"], QODER_CMD, { timeout: 5 });
    stripHooks(doc);
    expect(JSON.stringify(doc, null, 2)).toBe(original);
  });

  it("leaves a doc without a hooks object alone", () => {
    const doc = { hooks: undefined } as unknown as HooksDoc;
    expect(stripHooks(doc)).toBe(false);
    expect(ensureHooks(doc, ["Stop"], QODER_CMD)).toBe(true);
    expect(commands(doc, "Stop")).toEqual([QODER_CMD]);
  });
});
