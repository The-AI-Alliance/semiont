'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/PageLayout';
import { buttonStyles } from '@/lib/button-styles';
import Link from 'next/link';
import { signIn } from 'next-auth/react';

export default function AboutPage() {
  const t = useTranslations('About');

  return (
    <PageLayout showAuthLinks={false}>
      <div className="max-w-4xl mx-auto px-4 py-12 space-y-12">
        {/* Header */}
        <div className="text-center space-y-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            {t('pageTitle')}
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300 max-w-3xl mx-auto">
            {t('tagline')}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4 justify-center items-center flex-wrap">
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
        </div>

        {/* Mission Section */}
        <section className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            {t('missionTitle')}
          </h2>
          <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
            {t('mission')}
          </p>
        </section>

        {/* Features Section */}
        <section className="space-y-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white text-center">
            {t('coreFeaturesTitle')}
          </h2>

          {/* Semantic Content */}
          <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-8">
            <div className="flex items-start gap-4">
              <span className="text-3xl">📊</span>
              <div className="flex-1">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  {t('semanticContentTitle')}
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  {t('semanticContentSubtitle')}
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  {t('semanticContent').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  {t('planned')}
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
                  {t('collaborationTitle')}
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  {t('collaborationSubtitle')}
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  {t('collaboration').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  {t('planned')}
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
                  {t('rbacTitle')}
                </h3>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  {t('rbacSubtitle')}
                </p>
                <div className="text-gray-600 dark:text-gray-300 space-y-3">
                  {t('rbac').split('\n\n').map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <span className="inline-block mt-4 text-sm font-medium text-amber-600 dark:text-amber-400 px-3 py-1 rounded-full bg-amber-100/20 dark:bg-amber-900/20">
                  {t('planned')}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Open Source Section */}
        <section className="bg-gradient-to-r from-cyan-500/10 to-blue-500/10 dark:from-cyan-600/10 dark:to-blue-600/10 rounded-lg p-8 border border-cyan-400/30 dark:border-cyan-500/30">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            {t('openSourceTitle')}
          </h2>
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            {t('openSource')}
          </p>
          <div className="flex gap-4">
            <a
              href="https://github.com/The-AI-Alliance/semiont"
              target="_blank"
              rel="noopener noreferrer"
              className={buttonStyles.primary.base}
            >
              {t('viewOnGitHub')}
            </a>
          </div>
        </section>

        {/* Future Vision */}
        <section className="text-center space-y-4">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            {t('futureVisionTitle')}
          </h2>
          <p className="text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            {t('futureVision')}
          </p>
        </section>
      </div>
    </PageLayout>
  );
}