'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import { signIn, signOut } from 'next-auth/react';
import Image from 'next/image';
import Link from 'next/link';
import { sanitizeImageURL } from '@/lib/validation';
import { useAuth } from '@/hooks/useAuth';
import { useDropdown } from '@/hooks/useUI';
import { useState } from 'react';

// Fallback avatar when image fails to load or is invalid
const FALLBACK_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiM2QjcyODAiLz4KPHBhdGggZD0iTTE2IDE2QzE4LjIwOTEgMTYgMjAgMTQuMjA5MSAyMCAxMkMyMCA5Ljc5MDg2IDE4LjIwOTEgOCAxNiA4QzEzLjc5MDkgOCAxMiA5Ljc5MDg2IDEyIDEyQzEyIDE0LjIwOTEgMTMuNzkwOSAxNiAxNiAxNloiIGZpbGw9IiNFNUU3RUIiLz4KPHBhdGggZD0iTTI0IDI1QzI0IDIxLjY4NjMgMjAuNDE4MyAxOSAxNiAxOUMxMS41ODE3IDE5IDggMjEuNjg2MyA4IDI1IiBzdHJva2U9IiNFNUU3RUIiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';

export function UserMenu() {
  const { isLoading, isAuthenticated, displayName, avatarUrl, userDomain, isAdmin } = useAuth();
  const { isOpen, toggle, close, dropdownRef } = useDropdown();
  const [imageError, setImageError] = useState(false);
  const signOutButtonRef = useRef<HTMLButtonElement>(null);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!isOpen) return;
    
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        signOutButtonRef.current?.click();
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        // Allow tab to cycle through focusable elements
        if (event.shiftKey) {
          event.preventDefault();
          close();
        }
        break;
    }
  }, [isOpen, close]);
  
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
  
  // Reset image error state when avatar changes
  useEffect(() => {
    setImageError(false);
  }, [avatarUrl]);

  if (isLoading) {
    return (
      <div className="text-gray-500 animate-pulse">
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex gap-3">
        <Link
          href="/auth/signup"
          className="text-sm text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 rounded px-3 py-2"
        >
          Sign Up
        </Link>
        <button
          onClick={() => signIn()}
          className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded px-3 py-2"
          aria-label="Sign in to your account"
          type="button"
        >
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Profile Image Button */}
      <button
        onClick={toggle}
        onKeyDown={handleKeyDown}
        className="w-8 h-8 rounded-full hover:ring-2 hover:ring-blue-500 hover:ring-offset-2 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 overflow-hidden"
        aria-label={`User menu for ${displayName || 'user'}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        id="user-menu-button"
      >
        <Image
          src={profileImageUrl}
          alt={`${displayName} profile`}
          width={32}
          height={32}
          className="w-8 h-8 rounded-full object-cover"
          priority
          onError={() => setImageError(true)}
          // Security: restrict image loading
          unoptimized={profileImageUrl === FALLBACK_AVATAR}
          // Performance optimizations
          sizes="32px"
          quality={85}
          placeholder="blur"
          blurDataURL="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAhEAACAQMDBQAAAAAAAAAAAAABAgMABAUGIWGRkqGxwf/EABUBAQEAAAAAAAAAAAAAAAAAAAMF/8QAGhEAAgIDAAAAAAAAAAAAAAAAAAECEgMRkf/aAAwDAQACEQMRAD8AltJagyeH0AthI5xdrLcNM91BF5pX2HaH9bcfaSXWGaRmknyJckliyjqTzSlT54b6bk+h0R+Wq/8AFLf8APTA2f/Z"
        />
      </button>
      
      {/* Dropdown Menu */}
      {isOpen && (
        <div 
          className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50"
          role="menu"
          aria-orientation="vertical"
          aria-labelledby="user-menu-button"
        >
          <div className="p-4">
            <div className="text-sm">
              <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                {displayName}
              </div>
              <div className="text-gray-500 dark:text-gray-400 truncate">
                {userDomain && `@${userDomain}`}
              </div>
            </div>
            <hr className="my-3 border-gray-200 dark:border-gray-600" />
            {isAdmin && (
              <>
                <Link
                  href="/admin"
                  onClick={close}
                  className="w-full text-left text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 py-2 px-2 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                  role="menuitem"
                  tabIndex={0}
                  aria-label="Access admin dashboard"
                >
                  Admin Dashboard
                </Link>
                <hr className="my-3 border-gray-200 dark:border-gray-600" />
              </>
            )}
            <button
              ref={signOutButtonRef}
              onClick={() => {
                close();
                signOut();
              }}
              onKeyDown={handleKeyDown}
              className="w-full text-left text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 py-2 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded"
              role="menuitem"
              tabIndex={0}
              aria-label="Sign out of your account"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}