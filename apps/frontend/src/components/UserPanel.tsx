'use client';

import React, { useState } from 'react';
import { signOut } from 'next-auth/react';
import Image from 'next/image';
import { sanitizeImageURL } from '@/lib/validation';
import { useAuth } from '@/hooks/useAuth';

// Fallback avatar when image fails to load or is invalid
const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

export function UserPanel() {
  const { displayName, avatarUrl, userDomain, isAdmin, isModerator } = useAuth();
  const [imageError, setImageError] = useState(false);

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
    <div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Account
      </h3>

      <div className="space-y-4">
        {/* User Profile */}
        <div className="flex items-center gap-3">
          <Image
            src={profileImageUrl}
            alt={`${displayName} profile`}
            width={48}
            height={48}
            className="w-12 h-12 rounded-full object-cover"
            onError={() => setImageError(true)}
            unoptimized={profileImageUrl === FALLBACK_AVATAR}
            sizes="48px"
            quality={85}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {displayName || 'User'}
            </div>
            {userDomain && (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                @{userDomain}
              </div>
            )}
          </div>
        </div>

        {/* Privileges */}
        {(isAdmin || isModerator) && (
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">
              Privileges
            </label>
            <div className="space-y-1">
              {isAdmin && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                  <span className="text-sm font-medium text-purple-700 dark:text-purple-300">
                    🛡️ Administrator
                  </span>
                </div>
              )}
              {isModerator && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                  <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                    ⚖️ Moderator
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sign Out Button */}
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleSignOut}
            className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
