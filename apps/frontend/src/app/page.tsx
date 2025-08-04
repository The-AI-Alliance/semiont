"use client";

import React from "react";
import { Header } from "@/components/Header";
import { GreetingSection } from "@/components/GreetingSection";
import { FeatureCards } from "@/components/FeatureCards";
import { StatusDisplay } from "@/components/StatusDisplay";
import { AsyncErrorBoundary } from "@/components/ErrorBoundary";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen">
      <main className="flex-1 flex flex-col items-center justify-center p-24" role="main">
        <div className="z-10 w-full max-w-5xl items-center justify-between font-mono text-sm">
          <AsyncErrorBoundary>
            <Header />
          </AsyncErrorBoundary>
          
          <div className="text-center space-y-6">
            <section aria-labelledby="hero-heading">
              <h1 id="hero-heading" className="sr-only">Semiont - AI-Powered Research Platform</h1>
              <p className="text-xl text-gray-600 dark:text-gray-300">
                Make Meaning from Your Data with AI-Powered Research
              </p>
            </section>
            
            {/* Interactive Greeting - Most likely to error due to API calls */}
            <AsyncErrorBoundary>
              <GreetingSection />
            </AsyncErrorBoundary>
            
            {/* Feature Cards */}
            <AsyncErrorBoundary>
              <FeatureCards />
            </AsyncErrorBoundary>
            
            {/* Status Display - Network dependent */}
            <AsyncErrorBoundary>
              <StatusDisplay />
            </AsyncErrorBoundary>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
}