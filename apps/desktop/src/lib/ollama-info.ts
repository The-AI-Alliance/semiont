export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantizationLevel: string;
  loaded: boolean;
}

export interface OllamaInfo {
  executablePath: string | null;
  endpoint: string | null;
  models: OllamaModelInfo[];
}
