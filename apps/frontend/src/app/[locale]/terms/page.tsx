'use client';

import React from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { PageLayout } from '@/components/PageLayout';

export default function TermsOfService() {
  const t = useTranslations('Terms');
  const locale = useLocale();

  return (
    <PageLayout className="bg-gray-50">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              {t('pageTitle')}
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {t('pageSubtitle')}
            </p>
          </div>

          <div className="prose dark:prose-invert max-w-none">
            <h2 className="font-sans">{t('aupTitle')}</h2>

            <p>
              {t('aupIntro')}
            </p>

            <h3 className="font-sans">{t('prohibitedTitle')}</h3>
            <p>{t('prohibitedIntro')}</p>
            <ul>
              <li>{t('prohibitedIllegal')}</li>
              <li>{t('prohibitedMinors')}</li>
              <li>{t('prohibitedAdult')}</li>
              <li>{t('prohibitedViolence')}</li>
              <li>{t('prohibitedHate')}</li>
              <li>{t('prohibitedMisinfo')}</li>
              <li>{t('prohibitedPrivacy')}</li>
              <li>{t('prohibitedIP')}</li>
              <li>{t('prohibitedMalicious')}</li>
              <li>{t('prohibitedSpam')}</li>
            </ul>

            <h3 className="font-sans">{t('aiAllianceTitle')}</h3>
            <p>
              {t('aiAllianceIntro')}{' '}
              <a
                href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('aiAllianceLink')}
              </a>
              {t('aiAllianceIncludes')}
            </p>
            <ul>
              <li>{t('aiAlliance1')}</li>
              <li>{t('aiAlliance2')}</li>
              <li>{t('aiAlliance3')}</li>
              <li>{t('aiAlliance4')}</li>
              <li>{t('aiAlliance5')}</li>
            </ul>

            <h3 className="font-sans">{t('responsibilitiesTitle')}</h3>
            <p>{t('responsibilitiesIntro')}</p>
            <ul>
              <li>{t('responsibility1')}</li>
              <li>{t('responsibility2')}</li>
              <li>{t('responsibility3')}</li>
              <li>{t('responsibility4')}</li>
              <li>{t('responsibility5')}</li>
              <li>{t('responsibility6')}</li>
            </ul>

            <h3 className="font-sans">{t('moderationTitle')}</h3>
            <p>
              {t('moderationText')}
            </p>

            <h3 className="font-sans">{t('privacyTitle')}</h3>
            <p>
              {t('privacyText')}{' '}
              <Link href={`/${locale}/privacy`} className="text-blue-600 dark:text-blue-400 hover:underline">
                {t('privacyLink')}
              </Link>
              {' '}{t('privacyEnd')}
            </p>

            <h3 className="font-sans">{t('ipTitle')}</h3>
            <p>
              {t('ipText')}
            </p>

            <h3 className="font-sans">{t('liabilityTitle')}</h3>
            <p>
              {t('liabilityText')}
            </p>

            <h3 className="font-sans">{t('changesTitle')}</h3>
            <p>
              {t('changesText')}
            </p>

            <h3 className="font-sans">{t('contactTitle')}</h3>
            <p>
              {t('contactText')}
            </p>

            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('lastUpdated', { date: new Date().toLocaleDateString() })}
              </p>
            </div>
          </div>

        </div>
      </div>
    </PageLayout>
  );
}