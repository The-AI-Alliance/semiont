'use client';

import React from 'react';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';

export default function TermsOfService() {
  return (
    <PageLayout className="bg-gray-50">
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              Terms of Service
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Please read these terms carefully before using Semiont
            </p>
          </div>

          <div className="prose dark:prose-invert max-w-none">
            <h2 className="font-sans">Acceptable Use Policy</h2>
            
            <p>
              By using Semiont, you agree to use our platform responsibly and in accordance with these terms. 
              We are committed to maintaining a safe, respectful, and productive environment for all users.
            </p>

            <h3 className="font-sans">Prohibited Content</h3>
            <p>You may not upload, share, or create content that includes:</p>
            <ul>
              <li><strong>Illegal Content:</strong> Any content that violates local, state, national, or international laws</li>
              <li><strong>Harmful to Minors:</strong> Content depicting, encouraging, or promoting harm to children or minors</li>
              <li><strong>Adult Content:</strong> Pornographic, sexually explicit, or adult content of any kind</li>
              <li><strong>Violence and Abuse:</strong> Content depicting, promoting, or encouraging violence, abuse, harassment, or harm to individuals or groups</li>
              <li><strong>Hate Speech:</strong> Content that promotes hatred, discrimination, or violence based on race, ethnicity, religion, gender, sexual orientation, disability, or other protected characteristics</li>
              <li><strong>Misinformation:</strong> Deliberately false or misleading information, especially content that could cause harm</li>
              <li><strong>Privacy Violations:</strong> Personal information of others without consent, including doxxing or sharing private communications</li>
              <li><strong>Intellectual Property Violations:</strong> Copyrighted material, trademarks, or other intellectual property without proper authorization</li>
              <li><strong>Malicious Content:</strong> Malware, viruses, phishing attempts, or other security threats</li>
              <li><strong>Spam and Manipulation:</strong> Unsolicited bulk content, manipulation of platform features, or automated abuse</li>
            </ul>

            <h3 className="font-sans">AI Alliance Code of Conduct</h3>
            <p>
              Semiont is committed to the principles outlined in the{' '}
              <a 
                href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                AI Alliance Code of Conduct
              </a>
              . This includes:
            </p>
            <ul>
              <li>Promoting responsible AI development and deployment</li>
              <li>Ensuring transparency and accountability in AI systems</li>
              <li>Respecting privacy, security, and human rights</li>
              <li>Fostering inclusive and diverse participation in AI advancement</li>
              <li>Encouraging ethical considerations in all AI-related activities</li>
            </ul>

            <h3 className="font-sans">User Responsibilities</h3>
            <p>As a user of Semiont, you agree to:</p>
            <ul>
              <li>Use the platform only for lawful and constructive purposes</li>
              <li>Respect the rights and dignity of other users</li>
              <li>Report any violations of these terms that you encounter</li>
              <li>Keep your account secure and not share access credentials</li>
              <li>Provide accurate information during registration and use</li>
              <li>Comply with all applicable laws and regulations</li>
            </ul>

            <h3 className="font-sans">Content Moderation</h3>
            <p>
              We reserve the right to review, moderate, and remove content that violates these terms. 
              We may also suspend or terminate accounts that repeatedly violate our policies. 
              Content moderation decisions will be made in accordance with these terms and applicable law.
            </p>

            <h3 className="font-sans">Privacy and Data Protection</h3>
            <p>
              Your privacy is important to us. Please review our{' '}
              <Link href="/privacy" className="text-blue-600 dark:text-blue-400 hover:underline">
                Privacy Policy
              </Link>
              {' '}to understand how we collect, use, and protect your information.
            </p>

            <h3 className="font-sans">Intellectual Property</h3>
            <p>
              Users retain ownership of their original content while granting Semiont necessary rights to provide our services. 
              All platform technology, including AI models and algorithms, remain the property of Semiont and its licensors.
            </p>

            <h3 className="font-sans">Limitation of Liability</h3>
            <p>
              Semiont is provided "as is" without warranties. We strive to provide reliable service but cannot guarantee 
              uninterrupted access or error-free operation. Users are responsible for their own content and activities on the platform.
            </p>

            <h3 className="font-sans">Changes to Terms</h3>
            <p>
              We may update these terms periodically. Users will be notified of significant changes, and continued use 
              of the platform constitutes acceptance of updated terms.
            </p>

            <h3 className="font-sans">Contact</h3>
            <p>
              If you have questions about these terms or need to report violations, please contact our support team 
              through the platform or at the contact information provided in our Privacy Policy.
            </p>

            <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Last updated: {new Date().toLocaleDateString()}
              </p>
            </div>
          </div>

        </div>
      </div>
    </PageLayout>
  );
}