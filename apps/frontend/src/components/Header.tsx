import React from 'react';
import Link from 'next/link';
import { UserMenu } from './UserMenu';

interface HeaderProps {
  showBranding?: boolean;
}

export function Header({ showBranding = true }: HeaderProps) {
  return (
    <div className="flex justify-between items-center w-full mb-8">
      {showBranding ? (
        <Link href="/" className="hover:opacity-80 transition-opacity">
          <h1 className="text-4xl font-bold font-orbitron text-sky-blue">
            SEMIONT
          </h1>
        </Link>
      ) : (
        <div></div>
      )}
      
      {/* Authentication Status */}
      <div className="text-right relative">
        <UserMenu />
      </div>
    </div>
  );
}