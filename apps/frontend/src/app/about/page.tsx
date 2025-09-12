'use client';

import React from 'react';
import { PageLayout } from '@/components/PageLayout';
import { buttonStyles } from '@/lib/button-styles';
import Link from 'next/link';
import { signIn } from 'next-auth/react';

export default function AboutPage() {
  return (
    <PageLayout showAuthLinks={false}>
      <div className="max-w-4xl mx-auto px-4 py-12 space-y-12">
        {/* Header */}
        <div className="text-center space-y-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            About Semiont
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300 max-w-3xl mx-auto">
            The open-source, future-proof framework that enables humans and intelligent agents to co-create shared knowledge — governed by you and built to last.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4 justify-center items-center flex-wrap">
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

        {/* Mission Section */}
        <section className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            Our Mission
          </h2>
          <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
            Semiont is building the foundation for a new era of knowledge management where human creativity 
            and artificial intelligence work together seamlessly. We believe that the future of information 
            belongs to everyone, not just a few large corporations. Our platform ensures that your knowledge 
            remains yours while enabling powerful collaborative capabilities.
          </p>
        </section>

        {/* Features Section */}
        <section className="space-y-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white text-center">
            Core Features
          </h2>

          {/* Semantic Content */}
          <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
            <div className="flex items-start gap-4">
              <span className="text-3xl">📊</span>
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  Semantic Content
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  Entity recognition, knowledge graphs, and semantic relationships
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  <p>
                    Our semantic content engine goes beyond simple text storage. It understands the meaning 
                    and relationships within your documents, automatically identifying entities like people, 
                    places, concepts, and events.
                  </p>
                  <p>
                    By building knowledge graphs from your content, Semiont creates a rich, interconnected 
                    web of information that enables powerful queries, intelligent suggestions, and deep insights 
                    that would be impossible with traditional document management systems.
                  </p>
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  Planned
                </span>
              </div>
            </div>
          </div>

          {/* Real-time Collaboration */}
          <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
            <div className="flex items-start gap-4">
              <span className="text-3xl">🤝</span>
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  Real-time Collaboration
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  Live editing, AI-assisted workflows, conflict resolution, and team coordination
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  <p>
                    Work together with your team and AI assistants in real-time. See changes as they happen, 
                    with intelligent conflict resolution that understands context and intent, not just text differences.
                  </p>
                  <p>
                    Our AI-assisted workflows help automate routine tasks, suggest improvements, and maintain 
                    consistency across your knowledge base. The platform learns from your team's patterns and 
                    preferences, becoming more helpful over time while respecting your creative control.
                  </p>
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  Planned
                </span>
              </div>
            </div>
          </div>

          {/* Advanced RBAC */}
          <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
            <div className="flex items-start gap-4">
              <span className="text-3xl">🔐</span>
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  Advanced RBAC
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  Fine-grained permissions, asset-level control, and audit trails
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  <p>
                    Take complete control over who can access, modify, and share your knowledge. Our role-based 
                    access control system provides granular permissions down to individual documents, sections, 
                    or even specific data points.
                  </p>
                  <p>
                    Every action is logged in immutable audit trails, ensuring complete transparency and compliance. 
                    Define custom roles that match your organization's structure, with dynamic permissions that 
                    can adapt based on context, time, or workflow state.
                  </p>
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  Planned
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Open Source Section */}
        <section className="bg-gradient-to-r from-cyan-500/10 to-blue-500/10 dark:from-cyan-600/10 dark:to-blue-600/10 rounded-lg p-8 border border-cyan-400/30 dark:border-cyan-500/30">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            Open Source & Community Driven
          </h2>
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            Semiont is proudly open source. We believe that the tools for managing humanity's knowledge 
            should be transparent, auditable, and owned by everyone. Join our community of developers, 
            researchers, and knowledge workers building the future together.
          </p>
          <div className="flex gap-4">
            <a 
              href="https://github.com/The-AI-Alliance/semiont"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonStyles.primary.base}
            >
              View on GitHub
            </a>
          </div>
        </section>

        {/* Future Vision */}
        <section className="text-center space-y-4">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Building the Future
          </h2>
          <p className="text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            We're just getting started. Semiont is evolving into a comprehensive platform for 
            knowledge creation, curation, and collaboration. Stay tuned as we roll out new 
            features and capabilities that will transform how you work with information.
          </p>
        </section>
      </div>
    </PageLayout>
  );
}