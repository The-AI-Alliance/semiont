import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  sanitizeImageURL,
  useSessionExpiry,
  formatTime,
  useSemiont,
  useObservable,
  createSessionStateUnit,
  useSessionStateUnit,
} from '@semiont/react-ui';
import type { SemiontSession } from '@semiont/sdk';
import { useRouter } from '@/i18n/routing';

// Fallback avatar when image fails to load or is invalid
const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

export function UserPanel() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`UserPanel.${k}`, p as any) as string;
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);
  const user = useObservable(session?.user$) ?? null;
  const activeKnowledgeBase = session?.kb ?? null;
  const displayName = user?.name ?? user?.email?.split('@')[0] ?? 'User';
  const avatarUrl = user?.image ?? null;
  const userDomain = user?.domain || user?.email?.split('@')[1];
  const isAdmin = user?.isAdmin ?? false;
  const isModerator = user?.isModerator ?? false;
  const [imageError, setImageError] = useState(false);
  const { timeRemaining } = useSessionExpiry();
  const sessionTimeFormatted = formatTime(timeRemaining) ?? 'Unknown';

  // Sanitize and validate the profile image URL
  const profileImageUrl = (() => {
    if (!avatarUrl || imageError) {
      return FALLBACK_AVATAR;
    }

    const sanitized = sanitizeImageURL(avatarUrl);
    if (!sanitized) {
      console.warn('Invalid profile image URL detected, using fallback');
      return FALLBACK_AVATAR;
    }

    return sanitized;
  })();

  return (
    <div className="semiont-user-panel">
      <h3 className="semiont-user-panel__title">
        {t('account')}
      </h3>

      {activeKnowledgeBase && (
        <div style={{ padding: '0 0.75rem 0.5rem', fontSize: '0.8rem', color: 'var(--semiont-color-neutral-400)' }}>
          {activeKnowledgeBase.label}
        </div>
      )}

      <div className="space-y-4">
        {/* User Profile */}
        <div className="flex items-center gap-3">
          <img
            src={profileImageUrl}
            alt={t('profileAlt', { name: displayName || t('user') })}
            width={48}
            height={48}
            className="w-12 h-12 rounded-full object-cover"
            onError={() => setImageError(true)}
          />
          <div className="flex-1 min-w-0">
            <div className="semiont-panel-text">
              {displayName || t('user')}
            </div>
            {userDomain && (
              <div className="semiont-panel-text-secondary">
                @{userDomain}
              </div>
            )}
          </div>
        </div>

        {/* Session Info */}
        <div>
          <label className="semiont-panel-label">
            {t('session')}
          </label>
          <div className="semiont-session-box">
            <div className="semiont-panel-hint">
              {t('expiresIn', { time: sessionTimeFormatted })}
            </div>
          </div>
        </div>

        {/* Privileges */}
        {(isAdmin || isModerator) && (
          <div>
            <label className="semiont-panel-label">
              {t('privileges')}
            </label>
            <div className="space-y-1">
              {isAdmin && (
                <div className="semiont-privilege-badge semiont-privilege-badge--admin">
                  <span className="semiont-privilege-text">
                    {t('administrator')}
                  </span>
                </div>
              )}
              {isModerator && (
                <div className="semiont-privilege-badge semiont-privilege-badge--moderator">
                  <span className="semiont-privilege-text">
                    {t('moderator')}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sign Out — only meaningful with a live session to sign out OF.
            Keyed on the session so the state unit is rebuilt against the
            replacement rather than holding the client it captured at mount. */}
        {session && (
          <SignOutButton
            key={session.id}
            session={session}
            label={t('signOut')}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Owns the session state unit, so it is only ever constructed where a session
 * is guaranteed. `UserPanel` itself renders inside `ToolbarPanels`, which the
 * unauthenticated knowledge layout also mounts — there, `activeSession$` is
 * null and `createSessionStateUnit(session?.client)` would capture `undefined`
 * and blow up on click.
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 */
function SignOutButton({ session, label }: { session: SemiontSession; label: string }) {
  const semiont = useSemiont();
  const router = useRouter();
  const sessionStateUnit = useSessionStateUnit(session ?? undefined, createSessionStateUnit);

  const handleSignOut = async () => {
    await sessionStateUnit?.logout();
    if (session.kb) {
      await semiont.signOut(session.kb.id);
    }
    router.push('/');
  };

  return (
    <div className="semiont-panel-divider">
      <button onClick={handleSignOut} className="semiont-signout-button">
        {label}
      </button>
    </div>
  );
}
