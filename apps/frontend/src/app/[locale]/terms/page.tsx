'use client';

import React, { useContext } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { PageLayout } from '@semiont/react-ui';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { Link as RoutingLink, routes } from '@/lib/routing';

export default function TermsOfService() {
  const t = useTranslations('Terms');
  const tFooter = useTranslations('Footer');
  const tNav = useTranslations('Navigation');
  const tHome = useTranslations('Home');
  const locale = useLocale();
  const keyboardContext = useContext(KeyboardShortcutsContext);

  return (
    <PageLayout
      Link={RoutingLink}
      routes={routes}
      t={tFooter}
      tNav={tNav}
      tHome={tHome}
      CookiePreferences={CookiePreferences}
      {...(keyboardContext?.openKeyboardHelp && { onOpenKeyboardHelp: keyboardContext.openKeyboardHelp })}
      className="bg-gray-50"
    >
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
              {t('aup')}
            </p>

            <h3 className="font-sans">{t('prohibitedTitle')}</h3>
            <p>{t('prohibitedIntro')}</p>
            <ul>
              {t('prohibited').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
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
              {t('aiAlliance').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>

            <h3 className="font-sans">{t('responsibilitiesTitle')}</h3>
            <p>{t('responsibilitiesIntro')}</p>
            <ul>
              {t('responsibilities').split('\n').map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>

            <h3 className="font-sans">{t('moderationTitle')}</h3>
            <p>
              {t('moderation')}
            </p>

            <h3 className="font-sans">{t('privacyTitle')}</h3>
            <p>
              {t('privacy').split(t('privacyLink'))[0]}
              <Link href={`/${locale}/privacy`} className="text-blue-600 dark:text-blue-400 hover:underline">
                {t('privacyLink')}
              </Link>
              {t('privacy').split(t('privacyLink'))[1]}
            </p>

            <h3 className="font-sans">{t('ipTitle')}</h3>
            <p>
              {t('ip')}
            </p>

            <h3 className="font-sans">{t('liabilityTitle')}</h3>
            <p>
              {t('liability')}
            </p>

            <h3 className="font-sans">{t('changesTitle')}</h3>
            <p>
              {t('changes')}
            </p>

            <h3 className="font-sans">{t('contactTitle')}</h3>
            <p>
              {t('contact')}
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