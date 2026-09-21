// Shared hook-config merging for install-host / uninstall-host.
//
// Both Codex (`~/.codex/hooks.json`) and Qoder (`hooks` inside
// `~/.qoder/settings.json`) use the same shape: an object whose values are
// arrays of `{ matcher?, hooks: [{ type, command, … }] }` entries. Qoder's file
// also carries unrelated user settings, so nothing here may drop a key it was
// not asked to touch.

export const HOOK_MARKER = "agent-notify.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string | null} text file contents, or null when the file is absent
 * @returns {{ doc: { hooks: Record<string, unknown[]> }, damaged: boolean }}
 *   `damaged` means the existing file was unusable, so the caller must keep a
 *   backup before writing the fresh doc.
 */
export function parseHooksDoc(text) {
  if (text === null) return { doc: { hooks: {} }, damaged: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { doc: { hooks: {} }, damaged: true };
  }
  if (!isRecord(parsed) || (parsed.hooks !== undefined && !isRecord(parsed.hooks))) {
    return { doc: { hooks: {} }, damaged: true };
  }
  return {
    doc: parsed.hooks === undefined ? { ...parsed, hooks: {} } : parsed,
    damaged: false,
  };
}

/** Register `command` for each event. Idempotent; true when it added something. */
export function ensureHooks(doc, events, command, entryExtra = {}, marker = HOOK_MARKER) {
  if (!isRecord(doc.hooks)) doc.hooks = {};
  let changed = false;
  for (const event of events) {
    const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    const already = list.some((entry) =>
      (entry?.hooks ?? []).some((h) => (h?.command ?? "").includes(marker)),
    );
    if (!already) {
      list.push({ hooks: [{ type: "command", command, ...entryExtra }] });
      changed = true;
    }
    doc.hooks[event] = list;
  }
  return changed;
}

/**
 * Drop only our own entries; other hooks and all sibling keys survive. Event
 * keys that we emptied are removed as well, so uninstall restores the file.
 */
export function stripHooks(doc, marker = HOOK_MARKER) {
  if (!isRecord(doc.hooks)) return false;
  let changed = false;
  for (const [event, list] of Object.entries(doc.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((entry) => ({
        ...entry,
        hooks: (entry?.hooks ?? []).filter((h) => !(h?.command ?? "").includes(marker)),
      }))
      .filter((entry) => (entry.hooks ?? []).length > 0);
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length === 0 && list.length > 0) delete doc.hooks[event];
    else doc.hooks[event] = kept;
  }
  if (changed && Object.keys(doc.hooks).length === 0) delete doc.hooks;
  return changed;
}
