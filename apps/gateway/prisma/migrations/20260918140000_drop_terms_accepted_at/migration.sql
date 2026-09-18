-- DropColumn: the terms gate is withdrawn. Accepting terms was never a legal
-- requirement for this deployment, so the timestamp recorded a consent nobody
-- needed and gated a page that carried nothing else.
ALTER TABLE "users" DROP COLUMN "termsAcceptedAt";
