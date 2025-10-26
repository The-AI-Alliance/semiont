import React from 'react';
import type { Metadata } from "next";
import { Inter, Orbitron } from "next/font/google";
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import "../globals.css";
import "@/styles/animations.css";
import { Providers } from "../providers";
import { NEXT_PUBLIC_SITE_NAME } from "@/lib/env";
import { CookieBanner } from "@/components/CookieBanner";
import { SessionExpiryBanner } from "@/components/SessionExpiryBanner";
import { SessionExpiredModal } from "@/components/modals/SessionExpiredModal";
import { PermissionDeniedModal } from "@/components/modals/PermissionDeniedModal";
import { SkipLinks } from "@/components/SkipLinks";
import { routing } from "@/i18n/routing";

const inter = Inter({ subsets: ["latin"] });
const orbitron = Orbitron({
  subsets: ["latin"],
  variable: '--font-orbitron',
});

export const metadata: Metadata = {
  title: `${NEXT_PUBLIC_SITE_NAME} - AI-Powered Research Environment`,
  description: "A modern AI-powered research environment for collaborative knowledge work and analysis",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  // Await params before accessing properties
  const { locale } = await params;

  // Validate locale
  if (!routing.locales.includes(locale as any)) {
    notFound();
  }

  // Load messages for the locale
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={`${inter.className} ${orbitron.variable}`} suppressHydrationWarning>
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <SkipLinks />
            <SessionExpiryBanner />
            <SessionExpiredModal />
            <PermissionDeniedModal />
            {children}
            <CookieBanner />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
