declare module "*qoder/qoder-agent-notify.mjs" {
  export interface QoderConfig {
    serverUrl: string;
    token: string;
    timeoutMs: number;
    notifyPermissionRequests: boolean;
    debugLogPath?: string;
  }
  export function parseQoderConfig(raw: Record<string, unknown>): QoderConfig;
  export function readQoderConfig(home?: string): QoderConfig;
  export function shouldForwardQoderEvent(
    raw: unknown,
    config?: Partial<QoderConfig>,
  ): boolean;
  export function sendQoderEvent(
    serverUrl: string,
    token: string,
    timeoutMs: number,
    raw: unknown,
    fetchImpl?: typeof fetch,
  ): Promise<boolean>;
  export function handleQoderEvent(
    config: QoderConfig,
    raw: unknown,
    deps?: { fetchImpl?: typeof fetch },
  ): Promise<{ forwarded: boolean; sent: boolean }>;
}
