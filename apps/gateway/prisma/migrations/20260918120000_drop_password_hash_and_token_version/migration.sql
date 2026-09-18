-- DropColumn: password authentication is gone. People sign in at the trusted
-- issuer, which holds the credential; the gateway only verifies its tokens
-- (EXTERNAL-IDENTITY).
ALTER TABLE "users" DROP COLUMN "passwordHash";

-- DropColumn: the per-user revocation epoch went with the gateway-minted
-- session it existed to revoke. Access tokens are the issuer's and short-lived,
-- and a sign-out revokes the refresh token at the issuer (RFC 7009).
ALTER TABLE "users" DROP COLUMN "tokenVersion";
