"use client";

import React, { useState } from 'react';
import Link from 'next/link';
import { CookiePreferences } from '@/components/CookiePreferences';

export function Footer() {
  const [showCookiePreferences, setShowCookiePreferences] = useState(false);

  return (
    <>
      <footer className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-auto font-sans">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
            <div className="text-sm text-gray-500">
              © {new Date().getFullYear()} Semiont. All rights reserved.
            </div>
            
            <div className="flex space-x-6 text-sm">
              <Link 
                href="/privacy" 
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                Privacy Policy
              </Link>
              <button
                onClick={() => setShowCookiePreferences(true)}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cookie Preferences
              </button>
              <Link 
                href="/terms" 
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                Terms of Service
              </Link>
              <a 
                href="/api/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                API Docs
              </a>
              <a 
                href="https://github.com/The-AI-Alliance/semiont"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                Source Code
              </a>
            </div>
          </div>
        </div>
      </footer>

      <CookiePreferences 
        isOpen={showCookiePreferences}
        onClose={() => setShowCookiePreferences(false)}
      />
    </>
  );
}

export default Footer;