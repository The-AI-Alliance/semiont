"use client";

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  getCookieConsent,
  setCookieConsent,
  shouldShowBanner,
  COOKIE_CATEGORIES,
  CookieConsent,
  isCCPAApplicable,
  isGDPRApplicable,
  type CookieCategory
} from '@/lib/cookies';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';

interface CookieBannerProps {
  className?: string;
}

export function CookieBanner({ className = '' }: CookieBannerProps) {
  const t = useTranslations('CookieBanner');
  const [isVisible, setIsVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [region, setRegion] = useState<'GDPR' | 'CCPA' | 'GENERAL'>('GENERAL');
  const [consent, setConsent] = useState<Partial<CookieConsent>>({
    necessary: true,
    analytics: false,
    marketing: false,
    preferences: false
  });

  useEffect(() => {
    const checkVisibility = async () => {
      if (shouldShowBanner()) {
        setIsVisible(true);

        try {
          // Determine applicable regulation
          const [isGDPR, isCCPA] = await Promise.all([
            isGDPRApplicable(),
            isCCPAApplicable()
          ]);

          if (isGDPR) {
            setRegion('GDPR');
          } else if (isCCPA) {
            setRegion('CCPA');
          } else {
            setRegion('GENERAL');
          }
        } catch (error) {
          // If region detection fails, default to GENERAL
          console.error('Failed to detect region:', error);
          setRegion('GENERAL');
        }
      }
    };

    checkVisibility();
  }, []);

  const handleAcceptAll = async () => {
    setIsLoading(true);

    try {
      const fullConsent = {
        necessary: true,
        analytics: true,
        marketing: true,
        preferences: true
      };

      await Promise.resolve(setCookieConsent(fullConsent));
      setIsVisible(false);
    } catch (error) {
      console.error('Failed to save cookie consent:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRejectAll = async () => {
    setIsLoading(true);

    try {
      const minimalConsent = {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false
      };

      await Promise.resolve(setCookieConsent(minimalConsent));
      setIsVisible(false);
    } catch (error) {
      console.error('Failed to save cookie consent:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSavePreferences = async () => {
    setIsLoading(true);

    try {
      await Promise.resolve(setCookieConsent(consent));
      setIsVisible(false);
    } catch (error) {
      console.error('Failed to save cookie consent:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCategoryToggle = (categoryId: keyof Omit<CookieConsent, 'timestamp' | 'version'>) => {
    if (categoryId === 'necessary') return; // Can't toggle necessary cookies

    setConsent(prev => ({
      ...prev,
      [categoryId]: !prev[categoryId]
    }));
  };

  const getBannerText = () => {
    switch (region) {
      case 'GDPR':
        return {
          title: t('gdprTitle'),
          description: t('gdprDescription'),
          learnMore: t('gdprLearnMore')
        };
      case 'CCPA':
        return {
          title: t('ccpaTitle'),
          description: t('ccpaDescription'),
          learnMore: t('ccpaLearnMore')
        };
      default:
        return {
          title: t('generalTitle'),
          description: t('generalDescription'),
          learnMore: t('generalLearnMore')
        };
    }
  };

  if (!isVisible) return null;

  const bannerText = getBannerText();

  return (
    <div
      className={className}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        backgroundColor: 'var(--semiont-bg-primary)',
        borderTop: '1px solid var(--semiont-border-primary)',
        boxShadow: 'var(--semiont-shadow-lg)',
      }}
    >
      <div style={{ maxWidth: '80rem', margin: '0 auto', padding: '1rem 1.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Main banner content */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '300px' }}>
              <h3 style={{
                fontSize: '1.125rem',
                fontWeight: 600,
                color: 'var(--semiont-text-primary)',
                marginBottom: '0.5rem',
              }}>
                {bannerText.title}
              </h3>
              <p style={{
                fontSize: 'var(--semiont-text-sm, 0.875rem)',
                color: 'var(--semiont-text-secondary)',
                marginBottom: '0.25rem',
              }}>
                {bannerText.description}
              </p>
              <p style={{
                fontSize: 'var(--semiont-text-xs, 0.75rem)',
                color: 'var(--semiont-text-tertiary)',
              }}>
                {bannerText.learnMore}
              </p>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setShowDetails(!showDetails)}
                className="semiont-button--secondary"
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
              >
                {t('customize')}
                {showDetails ? (
                  <ChevronUpIcon style={{ width: '1rem', height: '1rem' }} />
                ) : (
                  <ChevronDownIcon style={{ width: '1rem', height: '1rem' }} />
                )}
              </button>

              {region !== 'GDPR' && (
                <button
                  type="button"
                  onClick={handleRejectAll}
                  disabled={isLoading}
                  className="semiont-button--secondary"
                >
                  {isLoading ? t('saving') : t('rejectAll')}
                </button>
              )}

              <button
                type="button"
                onClick={handleAcceptAll}
                disabled={isLoading}
                className="semiont-button--primary"
              >
                {isLoading ? t('saving') : t('acceptAll')}
              </button>
            </div>
          </div>

          {/* Detailed preferences */}
          {showDetails && (
            <div style={{
              borderTop: '1px solid var(--semiont-border-primary)',
              paddingTop: '1rem',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <h4 style={{
                  fontSize: '1rem',
                  fontWeight: 500,
                  color: 'var(--semiont-text-primary)',
                }}>
                  {t('cookiePreferences')}
                </h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {COOKIE_CATEGORIES.map((category: CookieCategory) => (
                    <div key={category.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', height: '1.25rem' }}>
                        <input
                          id={`cookie-${category.id}`}
                          type="checkbox"
                          checked={consent[category.id] || false}
                          onChange={() => handleCategoryToggle(category.id)}
                          disabled={category.required || isLoading}
                          style={{ accentColor: 'var(--semiont-color-primary-600, #2563eb)' }}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <label
                          htmlFor={`cookie-${category.id}`}
                          style={{
                            fontSize: 'var(--semiont-text-sm, 0.875rem)',
                            fontWeight: 500,
                            color: 'var(--semiont-text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          {category.name}
                          {category.required && (
                            <span style={{
                              fontSize: 'var(--semiont-text-xs, 0.75rem)',
                              color: 'var(--semiont-text-tertiary)',
                              marginLeft: '0.25rem',
                            }}>
                              {t('required')}
                            </span>
                          )}
                        </label>
                        <p style={{
                          fontSize: 'var(--semiont-text-xs, 0.75rem)',
                          color: 'var(--semiont-text-secondary)',
                          marginTop: '0.25rem',
                        }}>
                          {category.description}
                        </p>
                        <details style={{ marginTop: '0.25rem' }}>
                          <summary style={{
                            fontSize: 'var(--semiont-text-xs, 0.75rem)',
                            color: 'var(--semiont-color-primary-600, #2563eb)',
                            cursor: 'pointer',
                          }}>
                            {t('viewCookies')}
                          </summary>
                          <div style={{
                            marginTop: '0.25rem',
                            fontSize: 'var(--semiont-text-xs, 0.75rem)',
                            color: 'var(--semiont-text-tertiary)',
                          }}>
                            {category.cookies.join(', ')}
                          </div>
                        </details>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '0.75rem',
                  paddingTop: '1rem',
                }}>
                  <button
                    type="button"
                    onClick={() => setShowDetails(false)}
                    className="semiont-button--secondary"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleSavePreferences}
                    disabled={isLoading}
                    className="semiont-button--primary"
                  >
                    {isLoading ? t('saving') : t('savePreferences')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CookieBanner;
