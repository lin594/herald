export interface HooksDoc {
  hooks: Record<string, unknown[]>;
  [key: string]: unknown;
}

export declare const HOOK_MARKER: string;

export declare function parseHooksDoc(text: string | null): {
  doc: HooksDoc;
  /** The existing file was unusable; keep a backup before overwriting it. */
  damaged: boolean;
};

export declare function ensureHooks(
  doc: HooksDoc,
  events: string[],
  command: string,
  entryExtra?: Record<string, unknown>,
  marker?: string,
): boolean;

export declare function stripHooks(doc: HooksDoc, marker?: string): boolean;
