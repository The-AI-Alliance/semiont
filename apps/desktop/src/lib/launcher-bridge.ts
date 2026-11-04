import type { OllamaInfo } from './ollama-info';

export interface LauncherStatusResult {
  output: string;
  exitCode: number | null;
  error: string | null;
}

export interface LauncherBridge {
  onStatusRequested(listener: () => void): () => void;
  status(): Promise<LauncherStatusResult>;
  about(): Promise<LauncherStatusResult>;
  gitPath(): Promise<string | null>;
  ollamaInfo(): Promise<OllamaInfo>;
}
