#!/usr/bin/env node
// Install the Host Bridge + Codex hook adapter + LaunchAgent on macOS.
// User-level only: no sudo, no root LaunchAgents, backups before every edit.
// Idempotent: re-running only adds what is missing.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ensureHooks, parseHooksDoc } from "./hooks-merge.mjs";

const LABEL = "com.lin594.herald-host";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverUrl = (arg("server-url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const tokenName = arg("token-name", null);

function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.herald-backup-${stamp}`);
  return `${path}.herald-backup-${stamp}`;
}

function writeJsonWithBackup(path, value, { overwrite }) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (!overwrite) {
      console.log(`SKIP existing ${path} (pass --force to replace, a backup is kept)`);
      return false;
    }
    console.log(`backup -> ${backup(path)}`);
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`wrote ${path}`);
  return true;
}

function readRepoToken() {
  const envPath = join(REPO, ".env");
  if (!existsSync(envPath)) {
    console.error(`install-host: ${envPath} not found — run from the repo after creating .env`);
    process.exit(1);
  }
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("AGENT_NOTIFY_TOKENS="));
  if (!line) {
    console.error("install-host: AGENT_NOTIFY_TOKENS missing in .env");
    process.exit(1);
  }
  const entries = line.slice("AGENT_NOTIFY_TOKENS=".length).split(",");
  const chosen = tokenName
    ? entries.find((e) => e.trim().startsWith(`${tokenName}:`))
    : entries[0];
  if (!chosen) {
    console.error(`install-host: token name "${tokenName}" not found in AGENT_NOTIFY_TOKENS`);
    process.exit(1);
  }
  const idx = chosen.indexOf(":");
  return { name: chosen.slice(0, idx).trim(), value: chosen.slice(idx + 1).trim() };
}

// ── 1. bridge + adapter configs ────────────────────────────────────────────

const token = readRepoToken();
const configDir = join(homedir(), ".config", "agent-notify");
const force = process.argv.includes("--force");

writeJsonWithBackup(
  join(configDir, "host.json"),
  {
    serverUrl,
    token: token.value,
    codexSessionsDir: "~/.codex/sessions",
    qoderProjectsDir: "~/.qoder/projects",
    intervalSeconds: 30,
    debugLogPath: join(configDir, "logs", "host-bridge.log"),
  },
  { overwrite: force },
);

writeJsonWithBackup(
  join(configDir, "codex.json"),
  {
    serverUrl,
    token: token.value,
    timeoutMs: 2000,
    notifyPermissionRequests: true,
    debugLogPath: join(configDir, "logs", "codex-hook.log"),
  },
  { overwrite: force },
);

writeJsonWithBackup(
  join(configDir, "qoder.json"),
  {
    serverUrl,
    token: token.value,
    timeoutMs: 2000,
    notifyPermissionRequests: true,
    debugLogPath: join(configDir, "logs", "qoder-hook.log"),
  },
  { overwrite: force },
);
console.log(`using token name "${token.name}" (value not printed)`);

// ── 2. Hook registrations ──────────────────────────────────────────────────
// Codex: ~/.codex/hooks.json. Qoder: a "hooks" key inside
// ~/.qoder/settings.json, which also holds unrelated user settings, so the
// merge must preserve every other top-level key.

function readHooksDoc(path) {
  const { doc, damaged } = parseHooksDoc(
    existsSync(path) ? readFileSync(path, "utf8") : null,
  );
  if (damaged) {
    console.log(
      `warning: ${path} is not a usable hooks object; rewriting it (original gets backed up)`,
    );
  }
  return doc;
}

function writeHooksDoc(path, hooksDoc, events) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) console.log(`backup -> ${backup(path)}`);
  writeFileSync(path, JSON.stringify(hooksDoc, null, 2) + "\n", "utf8");
  console.log(`updated ${path} (added herald adapter to ${events.join("/")})`);
}

const codexEvents = ["UserPromptSubmit", "PermissionRequest", "Stop"];
const codexPath = join(homedir(), ".codex", "hooks.json");
const codexHooks = readHooksDoc(codexPath);
if (
  ensureHooks(
    codexHooks,
    codexEvents,
    `node ${join(REPO, "examples", "codex", "codex-agent-notify.mjs")}`,
  )
) {
  writeHooksDoc(codexPath, codexHooks, codexEvents);
} else {
  console.log(`SKIP hooks: adapter already registered in ${codexPath}`);
}

// Qoder's Stop hook is blocking, so cap the adapter's wall-clock budget.
const qoderEvents = [
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
];
const qoderPath = join(homedir(), ".qoder", "settings.json");
const qoderSettings = readHooksDoc(qoderPath);
if (
  ensureHooks(
    qoderSettings,
    qoderEvents,
    `node ${join(REPO, "examples", "qoder", "qoder-agent-notify.mjs")}`,
    { timeout: 5 },
  )
) {
  writeHooksDoc(qoderPath, qoderSettings, qoderEvents);
} else {
  console.log(`SKIP hooks: adapter already registered in ${qoderPath}`);
}

// ── 3. LaunchAgent ─────────────────────────────────────────────────────────

const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = join(configDir, "logs");
mkdirSync(logDir, { recursive: true });
const template = readFileSync(
  join(REPO, "deploy", "host", `${LABEL}.plist.template`),
  "utf8",
);
const plist = template
  .replaceAll("__NODE_PATH__", process.execPath)
  .replaceAll("__BRIDGE_PATH__", join(REPO, "host", "herald-host.mjs"))
  .replaceAll("__LOG_DIR__", logDir);
if (existsSync(plistPath) && readFileSync(plistPath, "utf8") === plist) {
  console.log(`SKIP LaunchAgent (unchanged): ${plistPath}`);
} else {
  if (existsSync(plistPath)) console.log(`backup -> ${backup(plistPath)}`);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, "utf8");
  console.log(`wrote ${plistPath}`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], {
      stdio: "ignore",
    });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
  console.log("LaunchAgent loaded (runs at login, keeps alive)");
}

console.log(`
Next steps:
  1. ./herald up                       (start the container stack)
  2. Open a codex TUI once and REVIEW-AND-TRUST the new hooks —
     Codex skips untrusted hooks; this is a one-time interactive step.
  3. Restart Qoder — it has no hook trust prompt and no config hot-reload.
     Also mount its transcripts in the container (see .env.example:
     HERALD_HOST_QODER_PROJECTS_DIR + HERALD_QODER_DIR), then ./herald up again.
  4. ./herald test && ./herald emit milestone "herald install check"
  Bridge log: ${join(logDir, "host-bridge.log")}`);
