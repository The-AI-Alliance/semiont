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
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('introPara1')}
              </p>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('introPara2')}
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('infoCollectTitle')}</h2>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">{t('personalInfoTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                <li>{t('personalInfoItem1')}</li>
                <li>{t('personalInfoItem2')}</li>
                <li>{t('personalInfoItem3')}</li>
              </ul>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2 mt-4">{t('autoCollectTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                <li>{t('autoCollectItem1')}</li>
                <li>{t('autoCollectItem2')}</li>
                <li>{t('autoCollectItem3')}</li>
                <li>{t('autoCollectItem4')}</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('howWeUseTitle')}</h2>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                <li>{t('howWeUseItem1')}</li>
                <li>{t('howWeUseItem2')}</li>
                <li>{t('howWeUseItem3')}</li>
                <li>{t('howWeUseItem4')}</li>
                <li>{t('howWeUseItem5')}</li>
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
                  <p className="text-sm text-gray-600 mt-1">
                    {t('necessaryCookiesDesc')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('necessaryCookiesExamples')}
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('analyticsCookiesTitle')}</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    {t('analyticsCookiesDesc')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('analyticsCookiesExamples')}
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('marketingCookiesTitle')}</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    {t('marketingCookiesDesc')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('marketingCookiesExamples')}
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{t('preferenceCookiesTitle')}</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    {t('preferenceCookiesDesc')}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('preferenceCookiesExamples')}
                  </p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('yourRightsTitle')}</h2>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2">{t('gdprRightsTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                <li>{t('gdprRight1')}</li>
                <li>{t('gdprRight2')}</li>
                <li>{t('gdprRight3')}</li>
                <li>{t('gdprRight4')}</li>
                <li>{t('gdprRight5')}</li>
                <li>{t('gdprRight6')}</li>
                <li>{t('gdprRight7')}</li>
              </ul>

              <h3 className="text-xl font-medium text-gray-900 dark:text-white mb-2 mt-4">{t('ccpaRightsTitle')}</h3>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1">
                <li>{t('ccpaRight1')}</li>
                <li>{t('ccpaRight2')}</li>
                <li>{t('ccpaRight3')}</li>
                <li>{t('ccpaRight4')}</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('dataSecurityTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('dataSecurityIntro')}
              </p>
              <ul className="list-disc pl-6 text-gray-700 dark:text-gray-300 space-y-1 mt-2">
                <li>{t('dataSecurityItem1')}</li>
                <li>{t('dataSecurityItem2')}</li>
                <li>{t('dataSecurityItem3')}</li>
                <li>{t('dataSecurityItem4')}</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('dataRetentionTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('dataRetentionDesc')}
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">{t('internationalTransfersTitle')}</h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                {t('internationalTransfersDesc')}
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
                {t('updatesPara1')}
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