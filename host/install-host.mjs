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

const LABEL = "com.lin594.cbm-host";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverUrl = (arg("server-url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const tokenName = arg("token-name", null);

function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.cbm-backup-${stamp}`);
  return `${path}.cbm-backup-${stamp}`;
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
console.log(`using token name "${token.name}" (value not printed)`);

// ── 2. Codex hooks (~/.codex/hooks.json, Claude-Code style, verified schema) ──

const HOOK_EVENTS = ["UserPromptSubmit", "PermissionRequest", "Stop"];
const adapterCommand = `node ${join(REPO, "examples", "codex", "codex-agent-notify.mjs")}`;
const hooksPath = join(homedir(), ".codex", "hooks.json");

let hooksDoc = { hooks: {} };
if (existsSync(hooksPath)) {
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
    hooksDoc = typeof parsed.hooks === "object" && parsed.hooks !== null ? parsed : { hooks: {} };
    if (!parsed.hooks) {
      // unknown shape: back up and start fresh content merged from empty
      hooksDoc = { hooks: {} };
      console.log(`backup -> ${backup(hooksPath)} (unrecognized hooks.json shape)`);
      writeFileSync(hooksPath, JSON.stringify(hooksDoc, null, 2) + "\n", "utf8");
    }
  } catch {
    console.log(`backup -> ${backup(hooksPath)} (unparseable hooks.json)`);
    hooksDoc = { hooks: {} };
  }
}

let hooksChanged = false;
for (const event of HOOK_EVENTS) {
  const list = Array.isArray(hooksDoc.hooks[event]) ? hooksDoc.hooks[event] : [];
  const already = list.some((entry) =>
    (entry.hooks ?? []).some((h) => (h.command ?? "").includes("codex-agent-notify.mjs")),
  );
  if (!already) {
    list.push({ hooks: [{ type: "command", command: adapterCommand }] });
    hooksChanged = true;
  }
  hooksDoc.hooks[event] = list;
}
if (hooksChanged) {
  mkdirSync(dirname(hooksPath), { recursive: true });
  if (existsSync(hooksPath)) console.log(`backup -> ${backup(hooksPath)}`);
  writeFileSync(hooksPath, JSON.stringify(hooksDoc, null, 2) + "\n", "utf8");
  console.log(`updated ${hooksPath} (added cbm adapter to ${HOOK_EVENTS.join("/")})`);
} else {
  console.log(`SKIP hooks: adapter already registered in ${hooksPath}`);
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
  .replaceAll("__BRIDGE_PATH__", join(REPO, "host", "cbm-host.mjs"))
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
  1. ./cbm up                       (start the container stack)
  2. Open a codex TUI once and REVIEW-AND-TRUST the new hooks —
     Codex skips untrusted hooks; this is a one-time interactive step.
  3. ./cbm test && ./cbm emit milestone "cbm install check"
  Bridge log: ${join(logDir, "host-bridge.log")}`);
