import React from 'react';
import type { Metadata } from "next";
import { Inter, Orbitron } from "next/font/google";
import "./globals.css";
import "@/styles/animations.css";
import { Providers } from "./providers";
import { env } from "@/lib/env";
import { CookieBanner } from "@/components/CookieBanner";
import { SessionExpiryBanner } from "@/components/SessionExpiryBanner";
import { SessionExpiredModal } from "@/components/SessionExpiredModal";
import { PermissionDeniedModal } from "@/components/PermissionDeniedModal";

const inter = Inter({ subsets: ["latin"] });
const orbitron = Orbitron({ 
  subsets: ["latin"],
  variable: '--font-orbitron',
});

export const metadata: Metadata = {
  title: `${env.NEXT_PUBLIC_SITE_NAME} - AI-Powered Research Environment`,
  description: "A modern AI-powered research environment for collaborative knowledge work and analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${orbitron.variable}`}>
        <Providers>
          <SessionExpiryBanner />
          <SessionExpiredModal />
          <PermissionDeniedModal />
          {children}
          <CookieBanner />
        </Providers>
      </body>
    </html>
  );
}