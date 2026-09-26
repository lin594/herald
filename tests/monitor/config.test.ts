import { describe, expect, it, vi } from "vitest";
import { parseMonitorConfig } from "../../src/monitor/config.js";

describe("projectMap", () => {
  it("is seeded from workspaces, preferring the explicit project name", () => {
    const config = parseMonitorConfig({
      HERALD_WORKSPACES: JSON.stringify([
        { name: "codex-bark-monitor", path: "/work/codex-bark-monitor", project: "Herald", artifacts: [] },
        { name: "bare-repo", path: "/work/bare-repo", artifacts: [] },
      ]),
    });
    expect(config.projectMap).toEqual({
      "/work/codex-bark-monitor": "Herald",
      "codex-bark-monitor": "Herald",
      "/work/bare-repo": "bare-repo",
      "bare-repo": "bare-repo",
    });
  });

  it("lets HERALD_PROJECT_MAP override a workspace entry", () => {
    const config = parseMonitorConfig({
      HERALD_WORKSPACES: JSON.stringify([
        { name: "repo", path: "/work/repo", project: "Herald", artifacts: [] },
      ]),
      HERALD_PROJECT_MAP: "/work/repo=Renamed",
    });
    expect(config.projectMap["/work/repo"]).toBe("Renamed");
    expect(config.projectMap["repo"]).toBe("Herald");
  });

  it("stays empty without workspaces or a map", () => {
    expect(parseMonitorConfig({}).projectMap).toEqual({});
  });
});

describe("severity policy", () => {
  it("floors at info so inference-only pushes stay silent but visible", () => {
    const config = parseMonitorConfig({});
    expect(config.minSeverity).toBe("info");
    expect(config.severityMap).toEqual({});
  });

  it("reads HERALD_MIN_SEVERITY and HERALD_SEVERITY_MAP", () => {
    const config = parseMonitorConfig({
      HERALD_MIN_SEVERITY: "NOTICE",
      HERALD_SEVERITY_MAP: "possible_stall=critical,heartbeat=debug",
    });
    expect(config.minSeverity).toBe("notice");
    expect(config.severityMap).toEqual({
      possible_stall: "critical",
      heartbeat: "debug",
    });
  });

  it("ignores an unreadable severity instead of guessing one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = parseMonitorConfig({
        HERALD_MIN_SEVERITY: "urgent",
        HERALD_SEVERITY_MAP: "heartbeat=verbose;resumed=info",
      });
      expect(config.minSeverity).toBe("info");
      expect(config.severityMap).toEqual({ resumed: "info" });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
