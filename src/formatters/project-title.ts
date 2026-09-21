import type { NotificationLanguage } from "../core/language.js";
import {
  composeTitle,
  readableProject,
} from "../core/notification-text.js";

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

export function projectNameFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string") return undefined;

  const normalized = stripTrailingSeparators(oneLine(cwd).replace(/\\/g, "/"));
  if (!normalized || normalized === "/") return undefined;
  if (/^[A-Za-z]:$/.test(normalized)) return undefined;

  const parts = normalized.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last) return undefined;

  const projectName = oneLine(last);
  return projectName || undefined;
}

export interface TitleContext {
  /** Agent display name, shown first so pushes from different tools are separable. */
  agent?: string;
  /** `path=Name` or `dirname=Name` overrides, shared with the monitor. */
  projectMap?: Record<string, string>;
  language?: NotificationLanguage;
  /** Used as the labelled fallback when no project can be derived. */
  sessionId?: string;
}

function normalizePath(value: string): string {
  return stripTrailingSeparators(oneLine(value).replace(/\\/g, "/"));
}

/**
 * Map a working directory onto a configured project name. Entries may key on
 * the full path or on the directory name, so a hash-named workspace can be
 * given a real name without retyping paths. A nested checkout resolves to the
 * deepest configured root that contains it.
 */
export function resolveProjectName(
  cwd: unknown,
  projectMap: Record<string, string> | undefined,
): string | undefined {
  if (typeof cwd !== "string" || !projectMap) return undefined;
  const path = normalizePath(cwd);
  if (!path) return undefined;
  const exact = projectMap[path] ?? projectMap[projectNameFromCwd(path) ?? ""];
  if (exact) return exact;
  let best: { root: string; name: string } | undefined;
  for (const [root, name] of Object.entries(projectMap)) {
    const key = normalizePath(root);
    if (key.length < 2) continue;
    if (path.startsWith(`${key}/`) && (!best || key.length > best.root.length)) {
      best = { root: key, name };
    }
  }
  return best?.name;
}

/**
 * `Agent · Project · State`. An opaque directory name (a session id, a
 * generated checkout) is never shown bare: it becomes `session 1a2b3c4d`, so
 * the reader can tell an unnamed workspace from a broken notification.
 */
export function prefixTitleWithProject(
  title: string,
  cwd: unknown,
  context: TitleContext = {},
): string {
  const language = context.language ?? "en";
  const raw =
    resolveProjectName(cwd, context.projectMap) ?? projectNameFromCwd(cwd);
  const project =
    readableProject(raw, language) ??
    readableProject(context.sessionId, language);
  return composeTitle([context.agent, project, title]);
}
