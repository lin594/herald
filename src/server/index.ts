import { serve } from "@hono/node-server";
import { parseConfig } from "../config/env.js";
import { BarkProvider } from "../providers/bark.js";
import { NtfyProvider } from "../providers/ntfy.js";
import type { NotificationProvider } from "../providers/types.js";
import { createApp } from "./app.js";
import { parseMonitorConfig } from "../monitor/config.js";
import { openDatabase } from "../monitor/db.js";
import type { DatabaseSync } from "node:sqlite";
import { MonitorStore } from "../monitor/store.js";
import { MonitorNotifier } from "../monitor/notifier.js";
import { MonitorScheduler } from "../monitor/scheduler.js";
import { MonitorHub } from "../monitor/hub.js";
import { CodexSessionPolicy } from "./codex-session-policy.js";
import { CooldownPolicy } from "./cooldown-policy.js";

const config = parseConfig(process.env);
const provider: NotificationProvider =
  config.provider === "ntfy"
    ? new NtfyProvider(config.ntfyEndpoint, config.ntfyToken)
    : new BarkProvider(config.barkEndpoint);

const monitorConfig = parseMonitorConfig(process.env);
let db: DatabaseSync | undefined;
let store: MonitorStore | undefined;
let monitorHub: MonitorHub | undefined;
let monitorScheduler: MonitorScheduler | undefined;

if (monitorConfig.enabled) {
  db = openDatabase(monitorConfig.dbPath);
  store = new MonitorStore(db);
  const notifier = new MonitorNotifier(store, provider, monitorConfig);
  monitorScheduler = new MonitorScheduler(store, notifier, monitorConfig);
  monitorHub = new MonitorHub({
    store,
    notifier,
    scheduler: monitorScheduler,
    config: monitorConfig,
    tokens: config.tokens,
    completionMinSeconds: config.codexCompletionMinSeconds,
  });
  monitorScheduler.start();
}

const app = createApp({
  tokens: config.tokens,
  provider,
  logPath: config.logPath,
  logRaw: config.logRaw,
  language: config.language,
  claudeCompletionMinSeconds: config.claudeCompletionMinSeconds,
  codexCompletionMinSeconds: config.codexCompletionMinSeconds,
  codexSessionPolicy: new CodexSessionPolicy({
    completionMinSeconds: config.codexCompletionMinSeconds,
    persist: store?.turnStore(),
  }),
  opencodeCompletionMinSeconds: config.opencodeCompletionMinSeconds,
  cooldownSeconds: config.cooldownSeconds,
  cooldownPolicy: new CooldownPolicy({
    cooldownSeconds: config.cooldownSeconds,
    persist: store?.cooldownStore(),
  }),
  monitor: monitorHub,
});

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`agent-notify listening on ${config.host}:${config.port}`);
if (monitorHub) {
  console.log(`[cbm] monitor enabled (db=${monitorConfig.dbPath})`);
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cbm] ${signal}: shutting down`);
  monitorScheduler?.stop();
  server.close(() => {
    db?.close();
    process.exit(0);
  });
  setTimeout(() => {
    db?.close();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
