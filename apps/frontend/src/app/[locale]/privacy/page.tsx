'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/PageLayout';

export default function PrivacyPolicyPage() {
  const t = useTranslations('Privacy');

  return (
    <PageLayout className="bg-gray-50">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">{t('pageTitle')}</h1>

          <div className="prose prose-lg max-w-none space-y-6">
            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('introTitle')}</h2>
              {t('intro').split('\n\n').map((para, i) => (
                <p key={i} className="text-gray-700 dark:text-gray-300 leading-relaxed">
                  {para}
                </p>
              ))}
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('infoCollectTitle')}</h2>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">{t('personalInfoTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                {t('personalInfo').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2 mt-4">{t('autoCollectTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                {t('autoCollect').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('howWeUseTitle')}</h2>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                {t('howWeUse').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('cookiePolicyTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-4">
                {t('cookiePolicyIntro')}
              </p>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">{t('cookieCategoriesTitle')}</h3>

              <div className="space-y-4">
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('necessaryCookiesTitle')}</h4>
                  {t('necessaryCookies').split('\n\n').map((para, i) => (
                    <p key={i} className={i === 0 ? "text-sm text-gray-600 mt-1" : "text-xs text-gray-500 mt-1"}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('analyticsCookiesTitle')}</h4>
                  {t('analyticsCookies').split('\n\n').map((para, i) => (
                    <p key={i} className={i === 0 ? "text-sm text-gray-600 mt-1" : "text-xs text-gray-500 mt-1"}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('marketingCookiesTitle')}</h4>
                  {t('marketingCookies').split('\n\n').map((para, i) => (
                    <p key={i} className={i === 0 ? "text-sm text-gray-600 mt-1" : "text-xs text-gray-500 mt-1"}>
                      {para}
                    </p>
                  ))}
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('preferenceCookiesTitle')}</h4>
                  {t('preferenceCookies').split('\n\n').map((para, i) => (
                    <p key={i} className={i === 0 ? "text-sm text-gray-600 mt-1" : "text-xs text-gray-500 mt-1"}>
                      {para}
                    </p>
                  ))}
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('yourRightsTitle')}</h2>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">{t('gdprRightsTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                {t('gdprRights').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2 mt-4">{t('ccpaRightsTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                {t('ccpaRights').split('\n').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('dataSecurityTitle')}</h2>
              {t('dataSecurity').split('\n\n').map((block, i) => {
                if (i === 0) {
                  return (
                    <p key={i} className="text-gray-700 dark:text-gray-300 leading-relaxed">
                      {block}
                    </p>
                  );
                }
                return (
                  <ul key={i} className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1 mt-2">
                    {block.split('\n').map((item, j) => (
                      <li key={j}>{item}</li>
                    ))}
                  </ul>
                );
              })}
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('dataRetentionTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('dataRetention')}
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('internationalTransfersTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('internationalTransfers')}
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('contactTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('contactIntro')}
              </p>
              <div className="bg-gray-50 rounded-lg p-4 mt-4">
                <p className="text-gray-700 dark:text-gray-300">
                  <strong>{t('contactEmail')}</strong> privacy@semiont.com<br />
                  <strong>{t('contactAddress')}</strong> [Your Company Address]
                </p>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('updatesTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('updates')}
              </p>
              <p className="text-gray-600 text-sm mt-4">
                <strong>{t('lastUpdated', { date: new Date().toLocaleDateString() })}</strong>
              </p>
            </section>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}