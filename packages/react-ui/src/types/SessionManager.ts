/**
 * Session management interface for handling authentication state and session expiry
 * Apps implement this interface and pass it to SessionProvider
 */

export interface SessionState {
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean;
  /** When the session expires (null if not authenticated) */
  expiresAt: Date | null;
  /** Time in milliseconds until session expires (null if not authenticated) */
  timeUntilExpiry: number | null;
  /** Whether the session is expiring soon (< 5 minutes) */
  isExpiringSoon: boolean;
}

export interface SessionManager extends SessionState {
  // SessionManager is just SessionState for now
  // Future expansion could include methods like refreshSession, logout, etc.
}
