import React from 'react';
import Link from 'next/link';
import { UserMenu } from './UserMenu';
import { SemiontBranding } from './SemiontBranding';

interface HeaderProps {
  showBranding?: boolean;
  showAuthLinks?: boolean;
}

export function Header({ showBranding = true, showAuthLinks = true }: HeaderProps) {
  return (
    <div className="flex justify-between items-center w-full mb-8">
      {showBranding ? (
        <Link href="/" className="hover:opacity-80 transition-opacity">
          <SemiontBranding 
            size="sm" 
            showTagline={true} 
            animated={false}
            compactTagline={true}
            className="py-1"
          />
        </Link>
      ) : (
        <div></div>
      )}
      
      {/* Authentication Status */}
      <div className="text-right relative">
        <UserMenu showAuthLinks={showAuthLinks} />
      </div>
    </div>
  );
}