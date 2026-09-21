import { describe, expect, it } from "vitest";
import {
  prefixTitleWithProject,
  projectNameFromCwd,
  resolveProjectName,
} from "../../src/formatters/project-title.js";

describe("project title helpers", () => {
  it("derives the project name from a Unix cwd", () => {
    expect(projectNameFromCwd("/Users/1874w/@1874/agent-notify")).toBe(
      "agent-notify",
    );
  });

  it("derives the project name from a cwd with trailing separators", () => {
    expect(projectNameFromCwd("/Users/1874w/@1874/agent-notify///")).toBe(
      "agent-notify",
    );
  });

  it("derives the project name from a Windows-style cwd", () => {
    expect(projectNameFromCwd("C:\\Users\\1874w\\agent-notify")).toBe(
      "agent-notify",
    );
  });

  it("returns undefined for unusable cwd values", () => {
    expect(projectNameFromCwd("/")).toBeUndefined();
    expect(projectNameFromCwd("C:\\")).toBeUndefined();
    expect(projectNameFromCwd("D:/")).toBeUndefined();
    expect(projectNameFromCwd("   ")).toBeUndefined();
    expect(projectNameFromCwd(undefined)).toBeUndefined();
    expect(projectNameFromCwd({ cwd: "/Users/1874w/project" })).toBeUndefined();
  });

  it("prefixes a title when a project name can be derived", () => {
    expect(
      prefixTitleWithProject("需要批准", "/Users/1874w/@1874/agent-notify"),
    ).toBe("agent-notify · 需要批准");
  });

  it("keeps the state alone when no project name can be derived", () => {
    expect(prefixTitleWithProject("需要批准", "/")).toBe("需要批准");
  });

  it("normalizes whitespace in the project name", () => {
    expect(prefixTitleWithProject("Question", "/tmp/my\nproject")).toBe(
      "my project · Question",
    );
  });
});

describe("project map resolution", () => {
  const projectMap = {
    "/work/repo-a": "Repo A",
    "b537d940d7d3c66f5e1ad0ca": "Remote Session",
  };

  it("maps an exact path or a directory-name key", () => {
    expect(resolveProjectName("/work/repo-a/", projectMap)).toBe("Repo A");
    expect(
      resolveProjectName("/sessions/b537d940d7d3c66f5e1ad0ca", projectMap),
    ).toBe("Remote Session");
  });

  it("resolves a nested checkout to the deepest configured root", () => {
    expect(resolveProjectName("/work/repo-a/packages/server/src", projectMap)).toBe(
      "Repo A",
    );
    expect(resolveProjectName("/work/repo-b/x", projectMap)).toBeUndefined();
  });

  it("prefers the mapped name over the directory segment", () => {
    expect(
      prefixTitleWithProject("Need Input", "/work/repo-a/packages/server", {
        agent: "Codex",
        projectMap,
      }),
    ).toBe("Codex · Repo A · Need Input");
  });

  it("labels the session when neither the map nor the cwd names a project", () => {
    expect(
      prefixTitleWithProject("等你输入", undefined, {
        agent: "Qoder",
        projectMap,
        sessionId: "b537d940d7d3c66f5e1ad0ca",
        language: "zh",
      }),
    ).toBe("Qoder · 会话 b537d940 · 等你输入");
  });
});
