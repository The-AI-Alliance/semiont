import React from 'react';
import Link from 'next/link';
import { UserMenu } from './UserMenu';

export function Header() {
  return (
    <div className="flex justify-between items-center w-full mb-8">
      <Link href="/" className="hover:opacity-80 transition-opacity">
        <h1 className="text-4xl font-bold font-orbitron text-sky-blue">
          SEMIONT
        </h1>
      </Link>
      
      {/* Authentication Status */}
      <div className="text-right relative">
        <UserMenu />
      </div>
    </div>
  );
}