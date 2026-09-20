#!/usr/bin/env node
// Remove the Host Bridge LaunchAgent. With --all also remove the adapter
// hook entries written by install-host. Config files and backups are kept.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LABEL = "com.lin594.cbm-host";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

try {
  execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], {
    stdio: "ignore",
  });
  console.log("LaunchAgent unloaded");
} catch {
  console.log("LaunchAgent was not loaded");
}
if (existsSync(plistPath)) {
  copyFileSync(plistPath, `${plistPath}.cbm-removed`);
  rmSync(plistPath);
  console.log(`removed ${plistPath} (kept ${plistPath}.cbm-removed)`);
}

if (process.argv.includes("--all")) {
  const hooksPath = join(homedir(), ".codex", "hooks.json");
  if (existsSync(hooksPath)) {
    try {
      const doc = JSON.parse(readFileSync(hooksPath, "utf8"));
      let changed = false;
      for (const [event, list] of Object.entries(doc.hooks ?? {})) {
        if (!Array.isArray(list)) continue;
        const kept = list
          .map((entry) => ({
            ...entry,
            hooks: (entry.hooks ?? []).filter(
              (h) => !(h.command ?? "").includes("codex-agent-notify.mjs"),
            ),
          }))
          .filter((entry) => (entry.hooks ?? []).length > 0);
        if (kept.length !== list.length) changed = true;
        doc.hooks[event] = kept;
      }
      if (changed) {
        copyFileSync(hooksPath, `${hooksPath}.cbm-backup-uninstall`);
        writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
        console.log(`removed cbm adapter entries from ${hooksPath}`);
      } else {
        console.log("no cbm adapter entries found");
      }
    } catch {
      console.log("hooks.json unparseable; left untouched");
    }
  }
  console.log("config files under ~/.config/agent-notify were kept");
}
