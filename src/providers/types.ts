export interface NotificationPayload {
  /** Stable delivery identity; Bark uses it to replace transport retries. */
  id?: string;
  title: string;
  body: string;
  urgency: "normal" | "time_sensitive";
  /** Explicit Bark level; falls back to the urgency mapping when absent. */
  level?: "passive" | "active" | "timeSensitive";
  group?: string;
  sound?: string;
  url?: string;
  icon?: string;
}

export interface NotificationResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface NotificationProvider {
  name: string;
  send(input: NotificationPayload): Promise<NotificationResult>;
}
