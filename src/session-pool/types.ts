import type { WebSocket } from "ws";

export type SessionSummary = {
  id: string;
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  label: string;
  secondaryLabel: string;
  firstUserPreview: string | null;
  lastUserPreview: string | null;
  model: { id: string; name: string; provider: string } | null;
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
  hasPendingUiRequest: boolean;
  lastError: string;
  lastActivityAt: number;
  childPid: number | null;
};

export type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type PendingClientResponse = {
  ws: WebSocket;
  responseCommand?: string;
  responseData?: Record<string, unknown>;
  onSuccess?: (payload: any) => void;
  onError?: (payload: any) => void;
};

export type SessionSnapshot = {
  state: any;
  messages: any[];
  commands: any[];
  liveAssistantMessage: any;
  liveTools: any[];
};

export type ClientState = {
  activeSessionId: string | null;
};

export type SessionWorkerOptions<TWorker> = {
  cwd: string;
  send: (ws: WebSocket, payload: unknown) => void;
  onActivity: () => void;
  onStateChange: () => void;
  onEnvelope: (worker: TWorker, envelope: any) => void;
  shouldAutoRestart: (worker: TWorker) => boolean;
};

export type PhoneSessionPoolOptions = {
  cwd: string;
  send: (ws: WebSocket, payload: unknown) => void;
  onActivity: () => void;
  buildStatusMeta: () => Record<string, unknown>;
};
