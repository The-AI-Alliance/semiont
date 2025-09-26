// API Request and Response Type Definitions
export * from './jwt-types';
export interface StatusResponse {
  status: string;
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
  authenticatedAs?: string;
}

export interface HealthResponse {
  status: string;
  message: string;
  version: string;
  timestamp: string;
  database: 'connected' | 'disconnected' | 'unknown';
  environment: string;
}

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

export interface LogoutResponse {
  success: boolean;
  message: string;
}

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: any;
}

export interface GoogleAuthRequest {
  access_token: string;
}