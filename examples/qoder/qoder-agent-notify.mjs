#!/usr/bin/env node
// Qoder hook adapter: forwards state-change events to the agent-notify server.
// Register in ~/.qoder/settings.json under "hooks" (see host/install-host.mjs).
// Required config: ~/.config/agent-notify/qoder.json.
//
// Qoder runs hooks on the agent's critical path (Stop is a blocking event), so
// this script must never block, never throw and always exit 0.

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Activity + waiting-user + turn-end signals. Everything else Qoder can emit
// (tool traces, compaction, subagents) is noise for a state-change monitor.
const NOTIFY_EVENT_NAMES = new Set([
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
]);

const DEFAULT_TIMEOUT_MS = 2000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(raw, key) {
  const value = raw?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function shouldForwardQoderEvent(raw, config = {}) {
  const hookEventName = stringField(raw, "hook_event_name");
  if (!hookEventName || !NOTIFY_EVENT_NAMES.has(hookEventName)) return false;
  // Notification also fires for idle pings and informational toasts; only an
  // approval prompt is a state change. PermissionRequest already covers the
  // interactive case, so this is gated by config like the Codex adapter.
  if (hookEventName === "Notification") {
    if (stringField(raw, "notification_type") !== "permission_prompt") {
      return false;
    }
    return config.notifyPermissionRequests !== false;
  }
  if (hookEventName === "PermissionRequest") {
    return config.notifyPermissionRequests !== false;
  }
  return true;
}

export function parseQoderConfig(raw) {
  const serverUrl = raw.serverUrl;
  const token = raw.token;
  if (typeof serverUrl !== "string" || !serverUrl.trim()) {
    throw new Error("agent-notify config requires serverUrl");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("agent-notify config requires token");
  }
  const timeoutMs = raw.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs < 0)) {
    throw new Error("agent-notify config timeoutMs must be a non-negative number");
  }
  return {
    serverUrl,
    token,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    notifyPermissionRequests: raw.notifyPermissionRequests !== false,
    debugLogPath: stringField(raw, "debugLogPath"),
  };
}

export function readQoderConfig(home = homedir()) {
  return parseQoderConfig(
    JSON.parse(readFileSync(join(home, ".config", "agent-notify", "qoder.json"), "utf8")),
  );
}

export async function sendQoderEvent(serverUrl, token, timeoutMs, raw, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${serverUrl.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agent: "qoder", raw }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function writeDebugLog(config, raw, forwarded, sent) {
  if (!config?.debugLogPath) return;
  try {
    appendFileSync(
      config.debugLogPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        forwarded,
        sent,
        hookEventName: stringField(raw, "hook_event_name") ?? "unknown",
        sessionId: stringField(raw, "session_id"),
        toolName: stringField(raw, "tool_name"),
      })}\n`,
    );
  } catch {
    // Fail-safe: debug logging must never block Qoder.
  }
}

export async function handleQoderEvent(config, raw, deps = {}) {
  if (!isRecord(raw)) return { forwarded: false, sent: false };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const forwarded = shouldForwardQoderEvent(raw, config);
  if (!forwarded) return { forwarded: false, sent: false };
  const sent = await sendQoderEvent(
    config.serverUrl,
    config.token,
    config.timeoutMs,
    raw,
    fetchImpl,
  );
  return { forwarded: true, sent };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let config;
  try {
    config = readQoderConfig();
  } catch {
    return; // not installed yet, or config broken: stay out of the agent's way
  }

  let raw;
  try {
    raw = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const result = await handleQoderEvent(config, raw);
  writeDebugLog(config, raw, result.forwarded, result.sent);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
