import type { FilesystemServiceConfig, GraphServiceConfig, InferenceServiceConfig } from '@semiont/core';

/** Narrow config type — only the fields make-meaning actually reads */
export interface MakeMeaningConfig {
  services: {
    filesystem?: FilesystemServiceConfig;
    graph?: GraphServiceConfig;
    inference?: InferenceServiceConfig;
  };
  _metadata?: {
    projectRoot: string;
  };
}
