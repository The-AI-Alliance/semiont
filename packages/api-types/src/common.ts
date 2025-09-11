/**
 * Common API types and utilities shared across all endpoints
 */

import { z } from 'zod';

// Common response interface for errors
export interface ErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, any>;
}

// Status types used across multiple endpoints
export type ServiceStatus = 'operational' | 'degraded' | 'offline';
export type DatabaseStatus = 'connected' | 'disconnected' | 'unknown';

// System response interfaces
export interface StatusResponse {
  status: ServiceStatus;
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
  authenticatedAs?: string; // Email of authenticated user
}

export interface HealthResponse {
  status: ServiceStatus;
  message: string;
  version: string;
  timestamp: string;
  database: DatabaseStatus;
  environment: string;
}


// Common validation schemas
export const EmailSchema = z.string().email('Invalid email format');
export const CuidSchema = z.string().cuid('Invalid ID format');

// Validation result type
export type ValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string; details?: any };