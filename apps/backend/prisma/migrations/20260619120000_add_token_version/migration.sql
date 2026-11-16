-- AlterTable: per-user token revocation epoch (SDK-AUTH-CORS Phase 2).
-- Bumped on logout to invalidate every outstanding token for the user.
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
