"use client";

import React, { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Footer } from "@/components/Footer";
import { SemiontBranding } from "@/components/SemiontBranding";
import { buttonStyles } from "@/lib/button-styles";

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();

  // Redirect authenticated users to know page
  useEffect(() => {
    if (session?.backendToken) {
      router.push('/know');
    }
  }, [session, router]);

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 w-full max-w-5xl items-center justify-between font-sans text-sm">
          {status === "loading" ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300">Loading...</p>
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
                  The open-source, future-proof framework that enables humans and intelligent agents to co-create shared knowledge — governed by you and built to last.
                </p>
              </section>
              
              {/* Action Buttons */}
              <div className="flex gap-4 justify-center items-center flex-wrap">
                <Link
                  href="/about"
                  className={buttonStyles.secondary.base}
                >
                  Learn More
                </Link>
                <Link
                  href="/auth/signup"
                  className={buttonStyles.primary.base}
                >
                  Sign Up
                </Link>
                <button
                  onClick={() => signIn()}
                  className={buttonStyles.primary.base}
                  type="button"
                >
                  Sign In
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
      
      <Footer />
    </div>
  );
}