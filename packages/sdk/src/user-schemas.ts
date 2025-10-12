import { z } from '@hono/zod-openapi';

/**
 * Auth Response - returned by login endpoints
 */
export const AuthResponseSchema = z.object({
  success: z.boolean().openapi({ example: true }),
  user: z.object({
    id: z.string().openapi({ example: 'user-123' }),
    email: z.string().openapi({ example: 'user@example.com' }),
    name: z.string().nullable().openapi({ example: 'John Doe' }),
    image: z.string().nullable().openapi({ example: 'https://example.com/avatar.jpg' }),
    domain: z.string().openapi({ example: 'example.com' }),
    isAdmin: z.boolean().openapi({ example: false }),
  }),
  token: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIs...' }),
  isNewUser: z.boolean().openapi({ example: false }),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/**
 * User Response - returned by /api/users/me
 */
export const UserResponseSchema = z.object({
  id: z.string().openapi({ example: 'user-123' }),
  email: z.string().openapi({ example: 'user@example.com' }),
  name: z.string().nullable().openapi({ example: 'John Doe' }),
  image: z.string().nullable().openapi({ example: 'https://example.com/avatar.jpg' }),
  domain: z.string().openapi({ example: 'example.com' }),
  provider: z.string().openapi({ example: 'google' }),
  isAdmin: z.boolean().openapi({ example: false }),
  isActive: z.boolean().openapi({ example: true }),
  termsAcceptedAt: z.string().nullable().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  lastLogin: z.string().nullable().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  created: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

/**
 * User List Response - returned by admin list users endpoint
 */
export const UserListResponseSchema = z.object({
  success: z.boolean(),
  users: z.array(z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    provider: z.string(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    lastLogin: z.string().nullable(),
    created: z.string(),
    updatedAt: z.string(),
  })),
});

export type UserListResponse = z.infer<typeof UserListResponseSchema>;

/**
 * User Stats Response - returned by admin stats endpoint
 */
export const UserStatsResponseSchema = z.object({
  success: z.boolean(),
  stats: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
    adminUsers: z.number(),
    regularUsers: z.number(),
    domainBreakdown: z.array(z.object({
      domain: z.string(),
      count: z.number(),
    })),
    recentSignups: z.array(z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      created: z.string(),
    })),
  }),
});

export type UserStatsResponse = z.infer<typeof UserStatsResponseSchema>;

/**
 * Update User Request - request body for updating user
 */
export const UpdateUserRequestSchema = z.object({
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  name: z.string().optional(),
});

export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

/**
 * Admin User Schema
 */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  lastLogin: z.string().nullable(),
  created: z.string(),
  updatedAt: z.string(),
});

export type AdminUser = z.infer<typeof AdminUserSchema>;

/**
 * Admin Users List Response
 */
export const AdminUsersResponseSchema = z.object({
  success: z.boolean(),
  users: z.array(AdminUserSchema),
});

export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

/**
 * Admin User Stats Response
 */
export const AdminUserStatsResponseSchema = z.object({
  success: z.boolean(),
  stats: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
    adminUsers: z.number(),
    regularUsers: z.number(),
    domainBreakdown: z.array(z.object({
      domain: z.string(),
      count: z.number(),
    })),
    recentSignups: z.array(z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      created: z.string(),
    })),
  }),
});

export type AdminUserStatsResponse = z.infer<typeof AdminUserStatsResponseSchema>;

/**
 * Update User Response
 */
export const UpdateUserResponseSchema = z.object({
  success: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    provider: z.string(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    lastLogin: z.string().nullable(),
    created: z.string(),
    updatedAt: z.string(),
  }),
});

export type UpdateUserResponse = z.infer<typeof UpdateUserResponseSchema>;

/**
 * Delete User Response
 */
export const DeleteUserResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type DeleteUserResponse = z.infer<typeof DeleteUserResponseSchema>;

// ============================================================================
// OpenAPI-wrapped Schemas (for Hono routes - just call .openapi() on schemas above)
// ============================================================================

export const AuthResponseSchemaOpenAPI = AuthResponseSchema.openapi('AuthResponse');
export const UserResponseSchemaOpenAPI = UserResponseSchema.openapi('UserResponse');
export const UpdateUserResponseSchemaOpenAPI = UpdateUserResponseSchema.openapi('UpdateUserResponse');
export const DeleteUserResponseSchemaOpenAPI = DeleteUserResponseSchema.openapi('DeleteUserResponse');
