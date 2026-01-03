"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Footer } from "@/components/Footer";
import { SemiontBranding } from "@/components/SemiontBranding";
import { buttonStyles } from "@semiont/react-ui";

export default function Home() {
  const { data: session, status } = useSession();
  const t = useTranslations('Home');

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 w-full max-w-5xl items-center justify-between font-sans text-sm">
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
                  size="xl"
                  animated={true}
                  className="mb-8"
                />
                <p className="text-xl text-gray-600 dark:text-gray-300 font-sans max-w-4xl mx-auto px-4">
                  {t('description')}
                </p>
              </section>

              {/* Action Buttons */}
              <div className="flex gap-4 justify-center items-center flex-wrap">
                {session?.backendToken ? (
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
                    <button
                      onClick={() => signIn(undefined, { callbackUrl: '/know' })}
                      className={buttonStyles.primary.base}
                      type="button"
                    >
                      {t('signIn')}
                    </button>
                  </>
                )}</div>
            </div>
          )}
        </div>
      </main>
      
      <Footer />
    </div>
  );
}