"use client";

import React, { useContext } from "react";
import { useAuth } from "@/hooks/useAuth";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Footer, SemiontBranding, buttonStyles } from "@semiont/react-ui";
import { CookiePreferences } from "@/components/CookiePreferences";
import { KeyboardShortcutsContext } from "@/contexts/KeyboardShortcutsContext";
import { Link as RoutingLink, routes } from "@/lib/routing";

export default function Home() {
  const { isAuthenticated, isLoading } = useAuth();
  const status = isLoading ? 'loading' : isAuthenticated ? 'authenticated' : 'unauthenticated';
  const t = useTranslations('Home');
  const tFooter = useTranslations('Footer');
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 max-w-5xl text-sm">
          {status === "loading" ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
            </div>
          ) : (
            <div className="text-center space-y-8">
              {/* Hero Branding Section */}
              <section aria-labelledby="hero-heading" className="py-8">
                <h1 id="hero-heading" className="sr-only">Semiont - AI-Powered Research Platform</h1>
                <SemiontBranding
                  t={t}
                  size="xl"
                  animated={true}
                  className="mb-8"
                />
                <p className="text-xl text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                  {t('description')}
                </p>
              </section>

              {/* Action Buttons */}
              <div className="flex gap-4 justify-center items-center flex-wrap">
                {isAuthenticated ? (
                  // Authenticated users see different actions
                  <>
                    <Link
                      href="/know"
                      className={buttonStyles.primary.base}
                    >
                      {t('continueToKnowledgeBase')}
                    </Link>
                    <Link
                      href="/about"
                      className={buttonStyles.secondary.base}
                    >
                      {t('learnMore')}
                    </Link>
                  </>
                ) : (
                  // Non-authenticated users see sign in/up options
                  <>
                    <Link
                      href="/about"
                      className={buttonStyles.secondary.base}
                    >
                      {t('learnMore')}
                    </Link>
                    <Link
                      href="/auth/signup"
                      className={buttonStyles.primary.base}
                    >
                      {t('signUp')}
                    </Link>
                    <Link
                      href="/auth/signin?callbackUrl=/know"
                      className={buttonStyles.primary.base}
                    >
                      {t('signIn')}
                    </Link>
                  </>
                )}</div>
            </div>
          )}
        </div>
      </main>

      <Footer
        Link={RoutingLink}
        routes={routes}
        t={tFooter}
        CookiePreferences={CookiePreferences}
        {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      />
    </div>
  );
}