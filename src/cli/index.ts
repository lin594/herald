#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { loadDotenv, parseConfig } from "../config/env.js";
import type { AppConfig, NamedToken } from "../config/env.js";

const EMIT_TYPES = ["started", "milestone", "waiting", "blocked", "failed", "completed"];

function serverBase(config: AppConfig): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

function authHeaders(token: NamedToken): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token.value}`,
  };
}

export function maskSecret(value: string): string {
  return value.replace(/(https?:\/\/[^/]+\/).+$/, "$1[REDACTED]");
}

export function validateDoctorConfig(env: NodeJS.ProcessEnv): {
  ok: boolean;
  messages: string[];
} {
  const messages: string[] = [];
  const provider = env.AGENT_NOTIFY_PROVIDER || "bark";
  if (!env.AGENT_NOTIFY_TOKENS) messages.push("Missing AGENT_NOTIFY_TOKENS");
  if (provider === "ntfy") {
    if (!env.NTFY_ENDPOINT) messages.push("Missing NTFY_ENDPOINT");
  } else {
    if (!env.BARK_ENDPOINT) messages.push("Missing BARK_ENDPOINT");
  }
  return { ok: messages.length === 0, messages };
}

async function postTestEvent(): Promise<void> {
  const config = parseConfig(process.env);
  const token = config.tokens[0];
  const response = await fetch(`${serverBase(config)}/events`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      agent: "opencode",
      raw: {
        id: "cli-test-event",
        type: "permission.v2.asked",
        cwd: process.cwd(),
        properties: {
          id: "cli-test-permission",
          sessionID: "cli-test-session",
          action: "bash",
          resources: ["echo agent-notify test"],
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`POST /events failed with HTTP ${response.status}`);
  }
  console.log("Test event sent through /events");
}

async function emit(args: string[]): Promise<void> {
  const type = args[0];
  if (!type || !EMIT_TYPES.includes(type)) {
    throw new Error(`emit requires one of: ${EMIT_TYPES.join(", ")}`);
  }
  const message = args.slice(1).join(" ").trim();
  const config = parseConfig(process.env);
  const token = config.tokens[0];
  const response = await fetch(`${serverBase(config)}/events`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      agent: "emit",
      raw: {
        type,
        message,
        hostname: hostname(),
        agent_type: process.env.CBM_EMIT_AGENT ?? "generic",
        ...(process.env.CBM_EMIT_PROJECT ? { project: process.env.CBM_EMIT_PROJECT } : {}),
        ...(process.env.CBM_EMIT_SESSION ? { session_id: process.env.CBM_EMIT_SESSION } : {}),
        ...(process.env.CBM_EMIT_CWD ? { cwd: process.env.CBM_EMIT_CWD } : {}),
      },
    }),
  });

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    notified?: boolean;
    error?: string;
  } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(`emit failed with HTTP ${response.status}: ${body?.error ?? "unknown error"}`);
  }
  console.log(`emit ${type}: recorded, notified=${body.notified === true}`);
}

async function getJson(path: string, withAuth: boolean): Promise<void> {
  const config = parseConfig(process.env);
  const token = config.tokens[0];
  const response = await fetch(`${serverBase(config)}${path}`, {
    headers: withAuth ? authHeaders(token) : {},
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with HTTP ${response.status}`);
  }
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function doctor(): Promise<void> {
  loadDotenv();
  const validation = validateDoctorConfig(process.env);
  for (const message of validation.messages) {
    console.log(`FAIL ${message}`);
  }
  if (!validation.ok) {
    process.exitCode = 1;
    return;
  }

  const config = parseConfig(process.env);
  const endpoint =
    config.provider === "ntfy" ? config.ntfyEndpoint : config.barkEndpoint;
  console.log(
    `OK provider=${config.provider} endpoint=${maskSecret(endpoint)}`,
  );
  await mkdir(dirname(config.logPath), { recursive: true });
  await access(dirname(config.logPath));
  console.log(`OK log directory writable: ${dirname(config.logPath)}`);

  const healthUrl = `${serverBase(config)}/health`;
  const health = await fetch(healthUrl).catch(() => null);
  if (!health?.ok) {
    console.log(`FAIL server health unavailable: ${healthUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log("OK server health reachable");

  const statusRes = await fetch(`${serverBase(config)}/status`).catch(() => null);
  if (statusRes?.ok) {
    const status = (await statusRes.json()) as { hosts?: unknown[] };
    if (Array.isArray(status.hosts) && status.hosts.length === 0) {
      console.log("WARN no host bridge heartbeat yet — run ./cbm install-host on the Mac");
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "test") {
    await postTestEvent();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "emit") {
    await emit(process.argv.slice(3));
    return;
  }
  if (command === "status") {
    await getJson("/status", false);
    return;
  }
  if (command === "sessions") {
    await getJson("/sessions", true);
    return;
  }
  console.log("Usage: agent-notify <test|doctor|emit|status|sessions>");
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
