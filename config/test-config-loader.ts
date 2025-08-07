/**
 * Test Configuration Loader
 * 
 * This module loads test configuration from the temporary JSON file
 * created by the test orchestration script (scripts/test.ts).
 * 
 * The configuration is passed via the SEMIONT_TEST_CONFIG_PATH environment variable.
 */

import { readFileSync } from 'fs';

export interface TestConfig {
  site: {
    name: string;
    url: string;
    apiUrl: string;
  };
  aws?: {
    region: string;
    account: string;
  };
  app?: {
    database?: {
      url: string;
    };
    // Add other app config fields as needed
  };
}

let cachedConfig: TestConfig | null = null;

/**
 * Loads test configuration from the temporary JSON file.
 * The config is cached after first load for performance.
 * 
 * @returns The test configuration object, or null if not in test context
 */
export function loadTestConfig(): TestConfig | null {
  // Return cached config if already loaded
  if (cachedConfig) {
    return cachedConfig;
  }

  // Check if we're in a test context with config available
  const configPath = process.env.SEMIONT_TEST_CONFIG_PATH;
  if (!configPath) {
    return null;
  }

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    cachedConfig = JSON.parse(configContent);
    return cachedConfig;
  } catch (error) {
    console.error(`Failed to load test config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Gets a specific configuration value by path (e.g., 'site.apiUrl').
 * 
 * @param path - Dot-separated path to the config value
 * @param defaultValue - Default value if path not found
 * @returns The configuration value or default
 */
export function getTestConfigValue<T = any>(path: string, defaultValue?: T): T | undefined {
  const config = loadTestConfig();
  if (!config) {
    return defaultValue;
  }

  const keys = path.split('.');
  let value: any = config;
  
  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return defaultValue;
    }
  }
  
  return value as T;
}

/**
 * Checks if we're running in a test context with configuration available.
 */
export function isTestContext(): boolean {
  return !!process.env.SEMIONT_TEST_CONFIG_PATH;
}