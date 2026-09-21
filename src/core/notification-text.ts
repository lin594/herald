import type { NotificationLanguage } from "./language.js";

/**
 * Session working directories are frequently opaque ids (Qoder remote-control
 * workspaces, generated checkouts). A bare `b537d940d7d3c66f5e1ad0ca` on a
 * lock screen reads as corruption, so such a label is always presented as an
 * id rather than a project name.
 */
export function isOpaqueId(value: string): boolean {
  const v = value.trim();
  return (
    /^[0-9a-f]{12,}$/i.test(v) ||
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)
  );
}

export function shortId(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "").slice(0, 8);
}

/** Project name, or an explicitly labelled id when no name is available. */
export function readableProject(
  value: string | null | undefined,
  language: NotificationLanguage,
): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  return isOpaqueId(v)
    ? language === "zh"
      ? `会话 ${shortId(v)}`
      : `session ${shortId(v)}`
    : v;
}

/** `Agent · Project · State`, with empty parts dropped. */
export function composeTitle(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" · ");
}

export function formatDuration(
  ms: number,
  language: NotificationLanguage,
): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (language === "zh") {
    if (minutes < 1) return "不到 1 分钟";
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const STATE_LABELS: Record<string, readonly [string, string]> = {
  heartbeat: ["Running", "还在跑"],
  possible_stall: ["Possible Stall", "疑似卡住"],
  resumed: ["Resumed", "已恢复活动"],
  host_lost: ["Host Signal Lost", "宿主机失联"],
  started: ["Started", "开始干活"],
  milestone: ["Milestone", "阶段进展"],
  waiting: ["Need Input", "等你输入"],
  blocked: ["Blocked", "被卡住"],
  failed: ["Failed", "出错了"],
  completed: ["Completed", "跑完了"],
};

export function stateLabel(
  key: string,
  language: NotificationLanguage,
): string {
  const labels = STATE_LABELS[key];
  if (!labels) return key;
  return language === "zh" ? labels[1] : labels[0];
}

export interface Digest {
  runningMs?: number;
  idleMs?: number;
  changedFiles?: number;
  insertions?: number;
  deletions?: number;
}

/**
 * One compact line of quantitative context. A push should answer "how long,
 * how much, is it moving" before it answers "what happened". A sub-minute
 * clock says nothing, so it is dropped rather than shown as `running 0 min`.
 */
export function digestLine(
  digest: Digest,
  language: NotificationLanguage,
): string | undefined {
  const zh = language === "zh";
  const minuteMs = 60_000;
  const parts: string[] = [];
  if (digest.runningMs != null && digest.runningMs >= minuteMs) {
    parts.push(
      zh
        ? `已跑 ${formatDuration(digest.runningMs, language)}`
        : `running ${formatDuration(digest.runningMs, language)}`,
    );
  }
  if (digest.idleMs != null && digest.idleMs >= minuteMs) {
    parts.push(
      zh
        ? `${formatDuration(digest.idleMs, language)}没动静`
        : `idle ${formatDuration(digest.idleMs, language)}`,
    );
  }
  if (digest.changedFiles) {
    const diff =
      digest.insertions || digest.deletions
        ? ` +${digest.insertions ?? 0} −${digest.deletions ?? 0}`
        : "";
    parts.push(
      zh
        ? `${digest.changedFiles} 文件改动${diff}`
        : `${digest.changedFiles} files changed${diff}`,
    );
  }
  return parts.length ? parts.join(" · ") : undefined;
}
