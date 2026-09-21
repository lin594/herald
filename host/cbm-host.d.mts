export interface BridgeProcess {
  pid: number;
  command: string;
}

export interface HostConfig {
  serverUrl: string;
  token: string;
  codexSessionsDir: string;
  qoderProjectsDir: string;
  intervalSeconds: number;
  debugLogPath?: string;
}

export interface TickState {
  lastTickMs?: number | null;
}

export interface TickDeps {
  collectProcesses?: () => Promise<BridgeProcess[]>;
  scanActiveSessionIds?: (dir: string, nowMs: number) => string[];
  scanActiveQoderSessionIds?: (dir: string, nowMs: number) => string[];
  postJson?: (
    serverUrl: string,
    token: string,
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<boolean>;
}

export declare const BRIDGE_VERSION: string;
export declare function parseHostConfig(raw: unknown): HostConfig;
export declare function readHostConfig(configPath?: string): HostConfig;
export declare function parseProcessList(psOutput: string): BridgeProcess[];
export declare function scanActiveSessionIds(
  sessionsDir: string,
  nowMs: number,
  windowMs?: number,
): string[];
export declare function scanActiveQoderSessionIds(
  projectsDir: string,
  nowMs: number,
  windowMs?: number,
): string[];
export declare function detectSleepGap(
  lastTickMs: number | null | undefined,
  nowMs: number,
  intervalSeconds: number,
): number | undefined;
export declare function postJson(
  serverUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<boolean>;
export declare function tickOnce(
  config: HostConfig,
  state: TickState,
  nowMs?: number,
  deps?: TickDeps,
): Promise<{ heartbeat: boolean; observationsOk: boolean; sleepGapSeconds?: number }>;
