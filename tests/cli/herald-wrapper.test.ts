import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDirs: string[] = [];

function createFixture({ docker = true, override = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herald-wrapper-"));
  fixtureDirs.push(root);
  const bin = join(root, "bin");
  const repo = join(root, "repo with spaces");
  const log = join(root, "docker-calls");
  const envLog = join(root, "docker-env");
  mkdirSync(bin);
  mkdirSync(join(repo, "deploy", "docker"), { recursive: true });
  copyFileSync(new URL("../../herald", import.meta.url), join(repo, "herald"));
  writeFileSync(join(repo, ".env"), "AGENT_NOTIFY_TOKENS=fixture:dummy-token\n");
  writeFileSync(join(repo, "deploy", "docker", "docker-compose.yml"), "services: {}\n");
  if (override) {
    writeFileSync(join(repo, "deploy", "docker", "docker-compose.override.yml"), "services: {}\n");
  }

  // PATH contains only fixture executables. The wrapper cannot reach real Docker,
  // Node, curl, or any notification provider, even when a test is misconfigured.
  writeFileSync(join(bin, "dirname"), '#!/bin/bash\nprintf "%s\\n" "${1%/*}"\n');
  chmodSync(join(bin, "dirname"), 0o755);
  if (docker) {
    writeFileSync(join(bin, "docker"), `#!/bin/bash
printf '%s\\0' "$@" >> "$MOCK_DOCKER_LOG"
printf '\\0' >> "$MOCK_DOCKER_LOG"
printf '%s\\n' "$PWD" "\${COMPOSE_PROJECT_NAME-}" "\${DOCKER_HOST-}" "\${AGENT_NOTIFY_PROVIDER-}" > "$MOCK_DOCKER_ENV_LOG"
if [ "$1" = info ]; then
  printf '%s' "\${MOCK_INFO_OUTPUT-}"
  printf '%s' "\${MOCK_INFO_ERROR-}" >&2
  exit "\${MOCK_INFO_EXIT:-0}"
fi
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f|--env-file) shift 2 ;;
    *) break ;;
  esac
done
case "\${1:-}" in
  ps)
    printf '%s' "\${MOCK_PS_OUTPUT-}"
    printf '%s' "\${MOCK_PS_ERROR-}" >&2
    exit "\${MOCK_PS_EXIT:-0}"
    ;;
  exec)
    printf '%s' "\${MOCK_EXEC_OUTPUT-}"
    printf '%s' "\${MOCK_EXEC_ERROR-}" >&2
    exit "\${MOCK_EXEC_EXIT:-0}"
    ;;
  *) exit 0 ;;
esac
`);
    chmodSync(join(bin, "docker"), 0o755);
  }

  const composeArgs = ["compose", "-f", "deploy/docker/docker-compose.yml"];
  if (override) composeArgs.push("-f", "deploy/docker/docker-compose.override.yml");
  composeArgs.push("--env-file", ".env");

  return {
    repo,
    composeArgs,
    run(args: string[] = ["doctor"], env: Record<string, string> = {}) {
      return spawnSync("/bin/bash", [join(repo, "herald"), ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: bin,
          MOCK_DOCKER_LOG: log,
          MOCK_DOCKER_ENV_LOG: envLog,
          MOCK_PS_OUTPUT: "fixture-container-id\n",
          COMPOSE_PROJECT_NAME: "fixture-project",
          DOCKER_HOST: "unix:///fixture/docker.sock",
          AGENT_NOTIFY_PROVIDER: "fixture-provider",
          ...env,
        },
      });
    },
    calls(): string[][] {
      return existsSync(log)
        ? readFileSync(log, "utf8").split("\0\0").filter(Boolean).map((call) => call.split("\0"))
        : [];
    },
    environment(): string[] {
      return readFileSync(envLog, "utf8").trimEnd().split("\n");
    },
  };
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("herald wrapper doctor preflight", () => {
  it("reports a missing Docker CLI without trying Compose", () => {
    const fixture = createFixture({ docker: false });
    const result = fixture.run();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("FAIL Docker CLI not found");
    expect(fixture.calls()).toEqual([]);
  });

  it.each([
    "Cannot connect to the Docker daemon at secret-socket",
    "permission denied while trying to connect; secret-token",
  ])("reports inaccessible Docker without exposing its raw error (%s)", (error) => {
    const fixture = createFixture();
    const result = fixture.run(["doctor"], {
      MOCK_INFO_EXIT: "1",
      MOCK_INFO_OUTPUT: "secret-docker-info",
      MOCK_INFO_ERROR: error,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("FAIL Cannot access the Docker daemon");
    expect(result.stderr).toContain("your account can access its socket");
    expect(result.stderr).not.toContain("secret");
    expect(fixture.calls()).toEqual([["info"]]);
  });

  it("reports failed Compose inspection separately from a stopped service", () => {
    const fixture = createFixture();
    const result = fixture.run(["doctor"], {
      MOCK_PS_EXIT: "1",
      MOCK_PS_OUTPUT: "secret-partial-output",
      MOCK_PS_ERROR: "invalid environment: secret-token",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("FAIL Unable to inspect the agent-notify service with Docker Compose");
    expect(result.stderr).not.toContain("not running");
    expect(result.stderr).not.toContain("secret");
    expect(fixture.calls()).toEqual([
      ["info"],
      [...fixture.composeArgs, "ps", "--status", "running", "-q", "agent-notify"],
    ]);
  });

  it("reports a stopped service without starting, rebuilding, or executing it", () => {
    const fixture = createFixture();
    const result = fixture.run(["doctor"], { MOCK_PS_OUTPUT: "" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("FAIL The agent-notify service is not running");
    expect(result.stderr).toContain("./herald up");
    expect(fixture.calls()).toEqual([
      ["info"],
      [...fixture.composeArgs, "ps", "--status", "running", "-q", "agent-notify"],
    ]);
  });

  it.each([false, true])("preserves healthy doctor execution, env, and Compose files (override=%s)", (override) => {
    const fixture = createFixture({ override });
    const result = fixture.run(["doctor", "--fixture-option", "argument with spaces"], {
      MOCK_INFO_OUTPUT: "secret-docker-info",
      MOCK_INFO_ERROR: "secret-docker-warning",
      MOCK_PS_ERROR: "secret-compose-warning",
      MOCK_EXEC_OUTPUT: "fixture doctor report\n",
      MOCK_EXEC_ERROR: "fixture doctor warning\n",
      MOCK_EXEC_EXIT: "7",
    });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("fixture doctor report\n");
    expect(result.stderr).toBe("fixture doctor warning\n");
    expect(fixture.calls()).toEqual([
      ["info"],
      [...fixture.composeArgs, "ps", "--status", "running", "-q", "agent-notify"],
      [...fixture.composeArgs, "exec", "-T", "agent-notify", "node", "dist/cli/index.js", "doctor", "--fixture-option", "argument with spaces"],
    ]);
    expect(fixture.environment()).toEqual([
      fixture.repo,
      "fixture-project",
      "unix:///fixture/docker.sock",
      "fixture-provider",
    ]);
  });

  it.each([
    { args: ["up"], command: ["up", "-d", "--build"] },
    { args: ["down"], command: ["down"] },
    { args: ["logs"], command: ["logs", "-f", "agent-notify"] },
    { args: ["status"], command: ["exec", "-T", "agent-notify", "node", "dist/cli/index.js", "status"] },
  ])("leaves $args unchanged without a doctor preflight", ({ args, command }) => {
    const fixture = createFixture({ override: true });
    const result = fixture.run(args, { MOCK_INFO_EXIT: "1", MOCK_PS_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(fixture.calls()).toEqual([[...fixture.composeArgs, ...command]]);
  });
});
