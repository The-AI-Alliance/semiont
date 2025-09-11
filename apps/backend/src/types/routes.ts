// API Route Type Registry
// This provides a complete type-safe registry of all API routes

import {
  GoogleAuthRequest,
  AuthResponse,
  UserResponse,
  ErrorResponse,
  StatusResponse,
  HealthResponse,
  LogoutResponse
} from './api';


// Complete API route registry
export interface APIRoutes {
  '/api/status': {
    GET: {
      response: StatusResponse;
    };
  };
  
  // Authentication endpoints
  '/api/auth/google': {
    POST: {
      body: GoogleAuthRequest;
      response: AuthResponse | ErrorResponse;
    };
  };
  
  '/api/auth/me': {
    GET: {
      headers: {
        Authorization: `Bearer ${string}`;
      };
      response: UserResponse | ErrorResponse;
    };
  };
  
  '/api/auth/logout': {
    POST: {
      headers: {
        Authorization: `Bearer ${string}`;
      };
      response: LogoutResponse | ErrorResponse;
    };
  };
  
  '/api/auth/accept-terms': {
    POST: {
      headers: {
        Authorization: `Bearer ${string}`;
      };
      response: { success: boolean; message: string; termsAcceptedAt?: string } | ErrorResponse;
    };
  };
  
  // Health check endpoints
  '/api/health': {
    GET: {
      response: HealthResponse;
    };
  };
  
}

// Helper types for extracting route information
export type Routes = keyof APIRoutes;
export type Methods<R extends Routes> = keyof APIRoutes[R];

// Extract request types
export type RequestBody<
  R extends Routes,
  M extends Methods<R>
> = APIRoutes[R][M] extends { body: infer B } ? B : never;

export type RequestParams<
  R extends Routes,
  M extends Methods<R>
> = APIRoutes[R][M] extends { params: infer P } ? P : never;

export type RequestHeaders<
  R extends Routes,
  M extends Methods<R>
> = APIRoutes[R][M] extends { headers: infer H } ? H : never;

// Extract response type
export type ResponseType<
  R extends Routes,
  M extends Methods<R>
> = APIRoutes[R][M] extends { response: infer Res } ? Res : never;

// Type-safe route helper
export const route = <R extends Routes>(route: R): R => route;