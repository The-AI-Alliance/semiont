"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { Header } from "@/components/Header";
import { FeatureCards } from "@/components/FeatureCards";
import { StatusDisplay } from "@/components/StatusDisplay";
import { AsyncErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";
import { AuthenticatedHome } from "@/components/AuthenticatedHome";
import { SemiontBranding } from "@/components/SemiontBranding";

export default function Home() {
  const { data: session, status } = useSession();

  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 w-full max-w-5xl items-center justify-between font-sans text-sm">
          <AsyncErrorBoundary>
            <Header showBranding={session?.backendToken ? true : false} />
          </AsyncErrorBoundary>
          
          {/* Show different content based on authentication status */}
          {status === "loading" ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300">Loading...</p>
            </div>
          ) : session?.backendToken ? (
            // Authenticated user - show document management interface
            <AsyncErrorBoundary>
              {session.user?.name ? (
                <AuthenticatedHome userName={session.user.name} />
              ) : (
                <AuthenticatedHome />
              )}
            </AsyncErrorBoundary>
          ) : (
            // Unauthenticated user - show landing page
            <div className="text-center space-y-12">
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