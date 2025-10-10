import { z } from 'zod';

/**
 * Auth Response - returned by login endpoints
 */
export const AuthResponseSchema = z.object({
  success: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    isAdmin: z.boolean(),
  }),
  token: z.string(),
  isNewUser: z.boolean(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/**
 * User Response - returned by /api/users/me
 */
export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  termsAcceptedAt: z.string().nullable(),
  lastLogin: z.string().nullable(),
  created: z.string(),
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
