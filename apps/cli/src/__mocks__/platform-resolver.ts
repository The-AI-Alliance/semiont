import { vi } from 'vitest';

// Mock implementation that returns test data without filesystem access
export const findProjectRoot = vi.fn(() => process.cwd());

export const getAvailableEnvironments = vi.fn(() => ['local', 'test', 'staging', 'production']);

export const isValidEnvironment = vi.fn((env: string) => 
  ['local', 'test', 'staging', 'production', 'remote'].includes(env)
);

export const loadEnvironmentConfig = vi.fn((environment: string) => ({
  deployment: {
    default: environment === 'local' ? 'process' : 'aws'
  },
  services: {
    frontend: {
      deployment: { type: environment === 'local' ? 'process' : 'container' },
      port: 3000
    },
    backend: {
      deployment: { type: environment === 'local' ? 'process' : 'container' },
      port: 3001
    },
    database: {
      deployment: { type: 'external' },
      host: 'localhost',
      port: 5432
    }
  },
  aws: environment !== 'local' ? {
    profile: 'test-profile',
    region: 'us-east-1'
  } : undefined
}));

export const resolveServiceDeployments = vi.fn((services: string[], environment: string) => {
  // Filter services based on what was requested
  const allServices = [
    {
      name: 'frontend',
      platform: environment === 'local' ? 'posix' : 'container',
      config: { port: 3000 }
    },
    {
      name: 'backend', 
      platform: environment === 'local' ? 'posix' : 'container',
      config: { port: 3001 }
    },
    {
      name: 'database',
      platform: 'external',
      config: { host: 'localhost', port: 5432 }
    }
  ];
  
  if (services.includes('all')) {
    return allServices;
  }
  
  return allServices.filter(s => services.includes(s.name));
});

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public environment?: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}