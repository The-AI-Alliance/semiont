"use client";

import React, { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { FeatureCards } from "@/components/FeatureCards";
import { StatusDisplay } from "@/components/StatusDisplay";
import { AsyncErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";
import { SemiontBranding } from "@/components/SemiontBranding";
import { UserMenu } from "@/components/UserMenu";

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
      {/* Header for unauthenticated users */}
      <header className="bg-white dark:bg-gray-900 shadow border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <SemiontBranding 
                size="sm" 
                showTagline={true} 
                animated={false}
                compactTagline={true}
                className="py-1"
              />
            </div>
            <div className="flex items-center space-x-4">
              <UserMenu />
            </div>
          </div>
        </div>
      </header>
      
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 w-full max-w-5xl items-center justify-between font-sans text-sm">
          {status === "loading" ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300">Loading...</p>
            </div>
          ) : (
            <div className="text-center space-y-12">
              {/* Hero Branding Section */}
              <section aria-labelledby="hero-heading" className="py-8">
                <h1 id="hero-heading" className="sr-only">Semiont - AI-Powered Research Platform</h1>
                <div className="mb-8">
                  <h2 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-4">Welcome to Semiont</h2>
                </div>
                <p className="text-xl text-gray-600 dark:text-gray-300 font-sans max-w-4xl mx-auto px-4">
                  The open-source, future-proof framework that enables humans and intelligent agents to co-create shared knowledge — governed by you and built to last.
                </p>
              </section>
              
              {/* Feature Cards */}
              <AsyncErrorBoundary>
                <FeatureCards />
              </AsyncErrorBoundary>
            </div>
          )}
        </div>
      </main>
      
      <Footer />
    </div>
  );
}