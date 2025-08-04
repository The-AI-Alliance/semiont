import React from 'react';
import { Metadata } from 'next';
import { CookiePreferences } from '@/components/CookiePreferences';

export const metadata: Metadata = {
  title: 'Privacy Policy - Semiont',
  description: 'Privacy policy and cookie information for Semiont AI-Powered Research Environment',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white shadow rounded-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-8">Privacy Policy</h1>
          
          <div className="prose prose-lg max-w-none space-y-6">
            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Introduction</h2>
              <p className="text-gray-700 leading-relaxed">
                Semiont is an AI-Powered Research Environment designed to facilitate collaborative knowledge work and analysis. 
                We are committed to protecting your privacy and handling your personal information transparently and securely.
              </p>
              <p className="text-gray-700 leading-relaxed">
                This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our platform.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Information We Collect</h2>
              
              <h3 className="text-xl font-medium text-gray-900 mb-2">Personal Information</h3>
              <ul className="list-disc pl-6 text-gray-700 space-y-1">
                <li>Email address and name (when you sign in with Google OAuth)</li>
                <li>User preferences and settings</li>
                <li>Research data and content you create or upload</li>
              </ul>

              <h3 className="text-xl font-medium text-gray-900 mb-2 mt-4">Automatically Collected Information</h3>
              <ul className="list-disc pl-6 text-gray-700 space-y-1">
                <li>IP address and device information</li>
                <li>Browser type and version</li>
                <li>Usage patterns and interaction data</li>
                <li>Performance and error logs</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">How We Use Your Information</h2>
              <ul className="list-disc pl-6 text-gray-700 space-y-1">
                <li>Provide and maintain our research platform services</li>
                <li>Authenticate users and manage accounts</li>
                <li>Improve platform performance and user experience</li>
                <li>Communicate important updates and security notices</li>
                <li>Comply with legal obligations</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Cookie Policy</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                We use cookies and similar technologies to enhance your experience, analyze usage, and provide personalized content.
              </p>

              <h3 className="text-xl font-medium text-gray-900 mb-2">Cookie Categories</h3>
              
              <div className="space-y-4">
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">Strictly Necessary Cookies</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    Essential for website functionality, including authentication and security features.
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Examples: next-auth.session-token, next-auth.csrf-token
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">Analytics Cookies</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    Help us understand how visitors interact with our website to improve user experience.
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Examples: _ga, _gid, lighthouse-*
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">Marketing Cookies</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    Used to track visitors across websites for relevant advertising and campaign measurement.
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Examples: _fbp, _fbc, fr
                  </p>
                </div>

                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">Preference Cookies</h4>
                  <p className="text-sm text-gray-600 mt-1">
                    Remember your choices and preferences for a personalized experience.
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Examples: theme-preference, language-preference
                  </p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Your Rights</h2>
              
              <h3 className="text-xl font-medium text-gray-900 mb-2">GDPR Rights (EU Residents)</h3>
              <ul className="list-disc pl-6 text-gray-700 space-y-1">
                <li>Right to access your personal data</li>
                <li>Right to rectification of inaccurate data</li>
                <li>Right to erasure (right to be forgotten)</li>
                <li>Right to restrict processing</li>
                <li>Right to data portability</li>
                <li>Right to object to processing</li>
                <li>Right to withdraw consent</li>
              </ul>

              <h3 className="text-xl font-medium text-gray-900 mb-2 mt-4">CCPA Rights (California Residents)</h3>
              <ul className="list-disc pl-6 text-gray-700 space-y-1">
                <li>Right to know what personal information is collected</li>
                <li>Right to delete personal information</li>
                <li>Right to opt-out of the sale of personal information</li>
                <li>Right to non-discrimination for exercising privacy rights</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Data Security</h2>
              <p className="text-gray-700 leading-relaxed">
                We implement appropriate technical and organizational measures to protect your personal information against 
                unauthorized access, alteration, disclosure, or destruction. This includes:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-1 mt-2">
                <li>Encryption of data in transit and at rest</li>
                <li>Regular security assessments and monitoring</li>
                <li>Access controls and authentication mechanisms</li>
                <li>Secure cloud infrastructure on AWS</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Data Retention</h2>
              <p className="text-gray-700 leading-relaxed">
                We retain personal information only as long as necessary to provide our services and comply with legal obligations. 
                Research data is retained according to your account settings and applicable data retention policies.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">International Transfers</h2>
              <p className="text-gray-700 leading-relaxed">
                Your information may be transferred to and processed in countries other than your country of residence. 
                We ensure appropriate safeguards are in place for such transfers in compliance with applicable privacy laws.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Contact Information</h2>
              <p className="text-gray-700 leading-relaxed">
                For questions about this Privacy Policy or to exercise your privacy rights, please contact us at:
              </p>
              <div className="bg-gray-50 rounded-lg p-4 mt-4">
                <p className="text-gray-700">
                  <strong>Email:</strong> privacy@semiont.com<br />
                  <strong>Address:</strong> [Your Company Address]
                </p>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900 mb-4">Updates to This Policy</h2>
              <p className="text-gray-700 leading-relaxed">
                We may update this Privacy Policy from time to time. We will notify you of any material changes by 
                posting the new Privacy Policy on this page and updating the effective date.
              </p>
              <p className="text-gray-600 text-sm mt-4">
                <strong>Last updated:</strong> {new Date().toLocaleDateString()}
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}