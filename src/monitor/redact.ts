const SECRET_PATTERNS: RegExp[] = [
  /password\s*[=:]\s*\S+/gi,
  /token\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
  /api[_-]?key\s*[=:]\s*\S+/gi,
  /Authorization\s*:\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /AWS_SECRET\w*\s*[=:]\s*\S+/gi,
  /BARK_DEVICE_KEY\s*[=:]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
];

export function redactText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function limitBody(value: string, maxChars: number): string {
  const text = value.replace(/\r/g, "").trim();
  if (text.length <= maxChars) return text;
  // A truncated blob that still contains a REDACTED marker near the cut is
  // fine; we never send more than maxChars of the original.
  return `${text.slice(0, maxChars - 1).trimEnd()}\u2026`;
}

export function looksLikeSecretDump(value: string): boolean {
  const matches = value.match(/\[REDACTED\]/g)?.length ?? 0;
  return matches >= 3;
}

/** A body that redaction turned into a wall of markers is not worth sending. */
export const SUPPRESSED_BODY = "(content suppressed: looks like secret material)";

/**
 * Redact then cap. Every string that leaves for a push channel goes through
 * here: a Bark notification shows up on a locked phone and is archived by the
 * provider, so neither a secret nor an unbounded dump may survive this step.
 */
export function safeBody(value: string, maxChars: number): string {
  const redacted = redactText(value);
  return looksLikeSecretDump(redacted)
    ? SUPPRESSED_BODY
    : limitBody(redacted, maxChars);
}

export function safeTitle(value: string): string {
  return limitBody(redactText(value), 120);
}
