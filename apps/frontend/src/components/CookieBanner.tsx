"use client";

import React, { useState, useEffect } from 'react';
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
      
      const result = setCookieConsent(fullConsent);
      // If setCookieConsent returns a promise, await it
      if (result && typeof result.then === 'function') {
        await result;
      }
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
      
      const result = setCookieConsent(minimalConsent);
      // If setCookieConsent returns a promise, await it
      if (result && typeof result.then === 'function') {
        await result;
      }
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
      const result = setCookieConsent(consent);
      // If setCookieConsent returns a promise, await it
      if (result && typeof result.then === 'function') {
        await result;
      }
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
          title: 'We value your privacy',
          description: 'We use cookies and similar technologies to provide, protect, and improve our services. By clicking "Accept All", you consent to our use of cookies as described in our Cookie Policy. You can change your preferences at any time.',
          learnMore: 'Learn more about our data processing in our Privacy Policy.'
        };
      case 'CCPA':
        return {
          title: 'Your Privacy Choices',
          description: 'We use cookies to personalize content and ads, provide social media features, and analyze our traffic. California residents have the right to opt out of the sale of personal information.',
          learnMore: 'See our Privacy Policy for details about your California privacy rights.'
        };
      default:
        return {
          title: 'Cookie Notice',
          description: 'We use cookies to enhance your experience, analyze site usage, and assist in our marketing efforts.',
          learnMore: 'See our Privacy Policy for more information.'
        };
    }
  };

  if (!isVisible) return null;

  const bannerText = getBannerText();

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 shadow-lg ${className}`}>
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="flex flex-col space-y-4">
          {/* Main banner content */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {bannerText.title}
              </h3>
              <p className="text-sm text-gray-600 mb-2">
                {bannerText.description}
              </p>
              <p className="text-xs text-gray-500">
                {bannerText.learnMore}
              </p>
            </div>
            
            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-3 lg:ml-6">
              <button
                type="button"
                onClick={() => setShowDetails(!showDetails)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
              >
                <span className="flex items-center">
                  Customize
                  {showDetails ? (
                    <ChevronUpIcon className="w-4 h-4 ml-1" />
                  ) : (
                    <ChevronDownIcon className="w-4 h-4 ml-1" />
                  )}
                </span>
              </button>
              
              {region !== 'GDPR' && (
                <button
                  type="button"
                  onClick={handleRejectAll}
                  disabled={isLoading}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? 'Saving...' : 'Reject All'}
                </button>
              )}
              
              <button
                type="button"
                onClick={handleAcceptAll}
                disabled={isLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
              >
                {isLoading ? 'Saving...' : 'Accept All'}
              </button>
            </div>
          </div>

          {/* Detailed preferences */}
          {showDetails && (
            <div className="border-t border-gray-200 pt-4">
              <div className="space-y-4">
                <h4 className="text-base font-medium text-gray-900">
                  Cookie Preferences
                </h4>
                
                <div className="space-y-3">
                  {COOKIE_CATEGORIES.map((category: CookieCategory) => (
                    <div key={category.id} className="flex items-start space-x-3">
                      <div className="flex items-center h-5">
                        <input
                          id={`cookie-${category.id}`}
                          type="checkbox"
                          checked={consent[category.id] || false}
                          onChange={() => handleCategoryToggle(category.id)}
                          disabled={category.required || isLoading}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <label 
                          htmlFor={`cookie-${category.id}`}
                          className="text-sm font-medium text-gray-900 cursor-pointer"
                        >
                          {category.name}
                          {category.required && (
                            <span className="text-xs text-gray-500 ml-1">(Required)</span>
                          )}
                        </label>
                        <p className="text-xs text-gray-600 mt-1">
                          {category.description}
                        </p>
                        <details className="mt-1">
                          <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-800">
                            View cookies
                          </summary>
                          <div className="mt-1 text-xs text-gray-500">
                            {category.cookies.join(', ')}
                          </div>
                        </details>
                      </div>
                    </div>
                  ))}
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowDetails(false)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSavePreferences}
                    disabled={isLoading}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                  >
                    {isLoading ? 'Saving...' : 'Save Preferences'}
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