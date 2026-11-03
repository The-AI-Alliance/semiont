export interface LauncherStatusResult {
  output: string;
  exitCode: number | null;
  error: string | null;
}

export interface LauncherBridge {
  onStatusRequested(listener: () => void): () => void;
  status(): Promise<LauncherStatusResult>;
}
