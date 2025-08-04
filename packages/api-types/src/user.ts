/**
 * User management and profile related types
 */

// Full user response interface (includes all user fields)
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

// User profile update request interface
export interface UserUpdateRequest {
  name?: string | null;
  image?: string | null;
}

// User list query parameters
export interface UserListQuery {
  page?: number;
  limit?: number;
  search?: string;
  isAdmin?: boolean;
  isActive?: boolean;
  domain?: string;
  provider?: string;
}

// User list response interface
export interface UserListResponse {
  users: UserResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// User creation request (for admin use)
export interface UserCreateRequest {
  email: string;
  name?: string | null;
  domain: string;
  provider: string;
  isAdmin?: boolean;
  isActive?: boolean;
}