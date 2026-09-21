import { describe, expect, it } from "vitest";
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
