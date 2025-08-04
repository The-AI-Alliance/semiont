// API Request and Response Type Definitions
// Import types from validation schemas to ensure consistency
export type { GoogleAuthRequest, HelloParams } from '../validation/schemas';

export interface AuthResponse {
  success: boolean;
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    domain: string;
    isAdmin: boolean;
  };
  token: string;
  isNewUser: boolean;
}

export interface UserResponse {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  domain: string;
  provider: string;
  isAdmin: boolean;
  isActive: boolean;
  termsAcceptedAt: string | null;
  lastLogin: string | null;
  createdAt: string;
}

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, any>;
}

export interface HelloResponse {
  message: string;
  timestamp: string;
  platform: string;
}

export interface StatusResponse {
  status: 'operational' | 'degraded' | 'offline';
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
}

export interface HealthResponse {
  status: 'operational' | 'degraded' | 'offline';
  message: string;
  version: string;
  timestamp: string;
  database: 'connected' | 'disconnected' | 'unknown';
  environment: string;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

// Legacy health check response
export interface LegacyHealthResponse {
  status: 'ok' | 'error';
  message: string;
}