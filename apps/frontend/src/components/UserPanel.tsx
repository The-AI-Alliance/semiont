'use client';

import React, { useState } from 'react';
import { signOut } from 'next-auth/react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { sanitizeImageURL, useSessionExpiry, formatTime } from '@semiont/react-ui';
import { useAuth } from '@/hooks/useAuth';

// Fallback avatar when image fails to load or is invalid
const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

export function UserPanel() {
  const t = useTranslations('UserPanel');
  const { displayName, avatarUrl, userDomain, isAdmin, isModerator } = useAuth();
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

  const handleSignOut = async () => {
    await signOut({ callbackUrl: '/' });
  };

  return (
    <div className="semiont-user-panel">
      <h3 className="semiont-user-panel__title">
        {t('account')}
      </h3>

      <div className="space-y-4">
        {/* User Profile */}
        <div className="flex items-center gap-3">
          <Image
            src={profileImageUrl}
            alt={t('profileAlt', { name: displayName || t('user') })}
            width={48}
            height={48}
            className="w-12 h-12 rounded-full object-cover"
            onError={() => setImageError(true)}
            unoptimized={profileImageUrl === FALLBACK_AVATAR}
            sizes="48px"
            quality={85}
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

        {/* Sign Out Button */}
        <div className="semiont-panel-divider">
          <button
            onClick={handleSignOut}
            className="semiont-signout-button"
          >
            {t('signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}
