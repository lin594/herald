#!/usr/bin/env node
// Remove the Host Bridge LaunchAgent. With --all also remove the adapter
// hook entries written by install-host. Config files and backups are kept.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseHooksDoc, stripHooks } from "./hooks-merge.mjs";

const LABEL = "com.lin594.herald-host";
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
  copyFileSync(plistPath, `${plistPath}.herald-removed`);
  rmSync(plistPath);
  console.log(`removed ${plistPath} (kept ${plistPath}.herald-removed)`);
}

if (process.argv.includes("--all")) {
  // Marker matches the codex and qoder adapters alike. settings.json keeps its
  // unrelated top-level keys because only the "hooks" entries are touched.
  for (const hooksPath of [
    join(homedir(), ".codex", "hooks.json"),
    join(homedir(), ".qoder", "settings.json"),
  ]) {
    if (!existsSync(hooksPath)) continue;
    const text = readFileSync(hooksPath, "utf8");
    const { doc, damaged } = parseHooksDoc(text);
    if (damaged) {
      console.log(`${hooksPath} has an unexpected shape; left untouched`);
      continue;
    }
    if (stripHooks(doc)) {
      copyFileSync(hooksPath, `${hooksPath}.herald-backup-uninstall`);
      writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
      console.log(`removed herald adapter entries from ${hooksPath}`);
    } else {
      console.log(`no herald adapter entries found in ${hooksPath}`);
    }
  }
  console.log("config files under ~/.config/agent-notify were kept");
}
