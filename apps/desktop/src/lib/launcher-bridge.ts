import type { OllamaInfo } from './ollama-info';

export interface LauncherStatusResult {
  output: string;
  exitCode: number | null;
  error: string | null;
}

export interface KnowledgeBaseRoot {
  path: string;
  did?: string;
  siteName?: string;
  config?: string;
  portBlock?: number;
  lastUsed?: string;
  lastStarted?: string;
}

export interface KnowledgeBasesResult {
  stateFile: string;
  roots: KnowledgeBaseRoot[];
  error: string | null;
}

export interface McpProcessStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  pid: number | null;
  startedAt: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
  error: string | null;
}

export interface LauncherBridge {
  onStatusRequested(listener: () => void): () => void;
  status(): Promise<LauncherStatusResult>;
  roots(): Promise<KnowledgeBasesResult>;
  about(): Promise<LauncherStatusResult>;
  gitPath(): Promise<string | null>;
  opPath(): Promise<string | null>;
  ollamaInfo(): Promise<OllamaInfo>;
  mcpStatus(): Promise<McpProcessStatus>;
  startMcp(): Promise<McpProcessStatus>;
  stopMcp(): Promise<McpProcessStatus>;
}
