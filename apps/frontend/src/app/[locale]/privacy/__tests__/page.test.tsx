import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrivacyPolicyPage from '../page';

// Mock CookiePreferences component
vi.mock('@/components/CookiePreferences', () => ({
  CookiePreferences: () => <div data-testid="cookie-preferences">Cookie Preferences Component</div>
}));

// Mock PageLayout component
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children, className }: any) => (
    <div className={`min-h-screen ${className || ''}`}>
      {children}
    </div>
  )
}));

describe('Privacy Policy Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Page Structure', () => {
    it('should render the main privacy policy container', () => {
      const { container } = render(<PrivacyPolicyPage />);
      
      // The privacy page uses a div container, not a main element
      const pageContainer = container.querySelector('.min-h-screen');
      expect(pageContainer).toBeInTheDocument();
      expect(pageContainer).toHaveClass('min-h-screen', 'bg-gray-50');
    });

    it('should render the content within a responsive container', () => {
      render(<PrivacyPolicyPage />);
      
      const contentContainer = document.querySelector('.max-w-4xl');
      expect(contentContainer).toBeInTheDocument();
      expect(contentContainer).toHaveClass('max-w-4xl', 'mx-auto', 'py-12', 'px-4', 'sm:px-6', 'lg:px-8');
    });

    it('should render content within a white card', () => {
      render(<PrivacyPolicyPage />);
      
      const card = document.querySelector('.bg-white.shadow.rounded-lg');
      expect(card).toBeInTheDocument();
      expect(card).toHaveClass('bg-white', 'shadow', 'rounded-lg', 'p-8');
    });
  });

  describe('Page Content', () => {
    it('should render the main heading', () => {
      render(<PrivacyPolicyPage />);
      
      const heading = screen.getByRole('heading', { level: 1, name: /privacy policy/i });
      expect(heading).toBeInTheDocument();
      expect(heading).toHaveClass('text-3xl', 'font-bold', 'text-gray-900', 'dark:text-white', 'mb-8');
    });

    it('should render all main sections', () => {
      render(<PrivacyPolicyPage />);
      
      // Check for all main section headings
      expect(screen.getByRole('heading', { level: 2, name: /introduction/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /information we collect/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /how we use your information/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /cookie policy/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /your rights/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /data security/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /data retention/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /international transfers/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /contact information/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: /updates to this policy/i })).toBeInTheDocument();
    });

    it('should render introduction content', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Semiont is an AI-Powered Research Environment/i)).toBeInTheDocument();
      expect(screen.getByText(/We are committed to protecting your privacy/i)).toBeInTheDocument();
      expect(screen.getByText(/This Privacy Policy explains how we collect/i)).toBeInTheDocument();
    });
  });

  describe('Information Collection Section', () => {
    it('should render personal information subsection', () => {
      render(<PrivacyPolicyPage />);
      
      const personalInfoHeading = screen.getByRole('heading', { level: 3, name: /personal information/i });
      expect(personalInfoHeading).toBeInTheDocument();
      expect(personalInfoHeading).toHaveClass('text-xl', 'font-medium', 'text-gray-900', 'mb-2');
    });

    it('should list personal information items', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Email address and name \(when you sign in with Google OAuth\)/i)).toBeInTheDocument();
      expect(screen.getByText(/User preferences and settings/i)).toBeInTheDocument();
      expect(screen.getByText(/Research data and content you create or upload/i)).toBeInTheDocument();
    });

    it('should render automatically collected information subsection', () => {
      render(<PrivacyPolicyPage />);
      
      const autoInfoHeading = screen.getByRole('heading', { level: 3, name: /automatically collected information/i });
      expect(autoInfoHeading).toBeInTheDocument();
      expect(autoInfoHeading).toHaveClass('text-xl', 'font-medium', 'text-gray-900', 'mb-2', 'mt-4');
    });

    it('should list automatically collected information items', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/IP address and device information/i)).toBeInTheDocument();
      expect(screen.getByText(/Browser type and version/i)).toBeInTheDocument();
      expect(screen.getByText(/Usage patterns and interaction data/i)).toBeInTheDocument();
      expect(screen.getByText(/Performance and error logs/i)).toBeInTheDocument();
    });
  });

  describe('Cookie Policy Section', () => {
    it('should render cookie policy introduction', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/We use cookies and similar technologies/i)).toBeInTheDocument();
    });

    it('should render cookie categories heading', () => {
      render(<PrivacyPolicyPage />);
      
      const cookieCategoriesHeading = screen.getByRole('heading', { level: 3, name: /cookie categories/i });
      expect(cookieCategoriesHeading).toBeInTheDocument();
    });

    it('should render all cookie category cards', () => {
      render(<PrivacyPolicyPage />);
      
      // Check for cookie category headings
      expect(screen.getByRole('heading', { level: 4, name: /strictly necessary cookies/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 4, name: /analytics cookies/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 4, name: /marketing cookies/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 4, name: /preference cookies/i })).toBeInTheDocument();
    });

    it('should render cookie examples', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/next-auth\.session-token, next-auth\.csrf-token/i)).toBeInTheDocument();
      expect(screen.getByText(/_ga, _gid, lighthouse-\*/i)).toBeInTheDocument();
      expect(screen.getByText(/_fbp, _fbc, fr/i)).toBeInTheDocument();
      expect(screen.getByText(/theme-preference, language-preference/i)).toBeInTheDocument();
    });

    it('should style cookie category cards correctly', () => {
      render(<PrivacyPolicyPage />);
      
      const cookieCards = document.querySelectorAll('.border.border-gray-200.rounded-lg.p-4');
      expect(cookieCards).toHaveLength(4);
      
      cookieCards.forEach(card => {
        expect(card).toHaveClass('border', 'border-gray-200', 'rounded-lg', 'p-4');
      });
    });
  });

  describe('Rights Section', () => {
    it('should render GDPR rights subsection', () => {
      render(<PrivacyPolicyPage />);
      
      const gdprHeading = screen.getByRole('heading', { level: 3, name: /GDPR Rights \(EU Residents\)/i });
      expect(gdprHeading).toBeInTheDocument();
    });

    it('should list GDPR rights', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Right to access your personal data/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to rectification of inaccurate data/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to erasure \(right to be forgotten\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to restrict processing/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to data portability/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to object to processing/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to withdraw consent/i)).toBeInTheDocument();
    });

    it('should render CCPA rights subsection', () => {
      render(<PrivacyPolicyPage />);
      
      const ccpaHeading = screen.getByRole('heading', { level: 3, name: /CCPA Rights \(California Residents\)/i });
      expect(ccpaHeading).toBeInTheDocument();
      expect(ccpaHeading).toHaveClass('text-xl', 'font-medium', 'text-gray-900', 'mb-2', 'mt-4');
    });

    it('should list CCPA rights', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Right to know what personal information is collected/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to delete personal information/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to opt-out of the sale of personal information/i)).toBeInTheDocument();
      expect(screen.getByText(/Right to non-discrimination for exercising privacy rights/i)).toBeInTheDocument();
    });
  });

  describe('Security and Compliance Sections', () => {
    it('should render data security information', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/We implement appropriate technical and organizational measures/i)).toBeInTheDocument();
      expect(screen.getByText(/Encryption of data in transit and at rest/i)).toBeInTheDocument();
      expect(screen.getByText(/Regular security assessments and monitoring/i)).toBeInTheDocument();
      expect(screen.getByText(/Access controls and authentication mechanisms/i)).toBeInTheDocument();
      expect(screen.getByText(/Secure cloud infrastructure on AWS/i)).toBeInTheDocument();
    });

    it('should render data retention information', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/We retain personal information only as long as necessary/i)).toBeInTheDocument();
      expect(screen.getByText(/Research data is retained according to your account settings/i)).toBeInTheDocument();
    });

    it('should render international transfers information', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Your information may be transferred to and processed in countries/i)).toBeInTheDocument();
      expect(screen.getByText(/We ensure appropriate safeguards are in place/i)).toBeInTheDocument();
    });
  });

  describe('Contact Information', () => {
    it('should render contact information section', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/For questions about this Privacy Policy/i)).toBeInTheDocument();
    });

    it('should render contact details in styled container', () => {
      render(<PrivacyPolicyPage />);
      
      const contactContainer = document.querySelector('.bg-gray-50.rounded-lg.p-4');
      expect(contactContainer).toBeInTheDocument();
      expect(contactContainer).toHaveClass('bg-gray-50', 'rounded-lg', 'p-4', 'mt-4');
    });

    it('should display email and address', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Email:/i)).toBeInTheDocument();
      expect(screen.getByText(/privacy@semiont\.com/i)).toBeInTheDocument();
      expect(screen.getByText(/Address:/i)).toBeInTheDocument();
      expect(screen.getByText(/\[Your Company Address\]/i)).toBeInTheDocument();
    });
  });

  describe('Updates Section', () => {
    it('should render updates to policy information', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/We may update this Privacy Policy from time to time/i)).toBeInTheDocument();
      expect(screen.getByText(/We will notify you of any material changes/i)).toBeInTheDocument();
    });

    it('should display last updated date', () => {
      render(<PrivacyPolicyPage />);
      
      expect(screen.getByText(/Last updated:/i)).toBeInTheDocument();
      
      // Check that current date is displayed
      const currentDate = new Date().toLocaleDateString();
      expect(screen.getByText(currentDate)).toBeInTheDocument();
    });

    it('should style the last updated text correctly', () => {
      render(<PrivacyPolicyPage />);
      
      const lastUpdatedElement = screen.getByText(/Last updated:/i).closest('p');
      expect(lastUpdatedElement).toHaveClass('text-gray-600', 'text-sm', 'mt-4');
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      render(<PrivacyPolicyPage />);
      
      // Check that headings follow proper hierarchy
      const h1 = screen.getByRole('heading', { level: 1 });
      const h2s = screen.getAllByRole('heading', { level: 2 });
      const h3s = screen.getAllByRole('heading', { level: 3 });
      const h4s = screen.getAllByRole('heading', { level: 4 });
      
      expect(h1).toBeInTheDocument();
      expect(h2s.length).toBeGreaterThan(0);
      expect(h3s.length).toBeGreaterThan(0);
      expect(h4s.length).toBeGreaterThanOrEqual(0); // Cookie categories may vary
    });

    it('should have semantic list structures', () => {
      render(<PrivacyPolicyPage />);
      
      const lists = screen.getAllByRole('list');
      expect(lists.length).toBeGreaterThan(0);
      
      // Check that lists have proper styling
      const styledLists = document.querySelectorAll('.list-disc.pl-6');
      expect(styledLists.length).toBeGreaterThan(0);
    });

    it('should have proper text contrast classes', () => {
      render(<PrivacyPolicyPage />);
      
      // Check main heading color with dark mode support
      const mainHeading = screen.getByRole('heading', { level: 1 });
      expect(mainHeading).toHaveClass('text-gray-900', 'dark:text-white');
      
      // Check section headings color with dark mode support
      const sectionHeadings = screen.getAllByRole('heading', { level: 2 });
      sectionHeadings.forEach(heading => {
        expect(heading).toHaveClass('text-gray-900', 'dark:text-white');
      });
    });
  });

  describe('Responsive Design', () => {
    it('should have responsive padding classes', () => {
      render(<PrivacyPolicyPage />);
      
      const responsiveContainer = document.querySelector('.px-4.sm\\:px-6.lg\\:px-8');
      expect(responsiveContainer).toBeInTheDocument();
      expect(responsiveContainer).toHaveClass('px-4', 'sm:px-6', 'lg:px-8');
    });

    it('should have responsive text sizing', () => {
      render(<PrivacyPolicyPage />);
      
      // Check prose styling
      const proseContainer = document.querySelector('.prose.prose-lg');
      expect(proseContainer).toBeInTheDocument();
      expect(proseContainer).toHaveClass('prose', 'prose-lg', 'max-w-none', 'space-y-6');
    });

    it('should have proper spacing between sections', () => {
      render(<PrivacyPolicyPage />);
      
      const sections = document.querySelectorAll('section');
      expect(sections.length).toBeGreaterThan(0);
      
      // Check that content has proper spacing
      const spaceContainer = document.querySelector('.space-y-6');
      expect(spaceContainer).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle date formatting consistently', () => {
      render(<PrivacyPolicyPage />);
      
      const dateElement = screen.getByText(/Last updated:/i).closest('p');
      expect(dateElement).toBeInTheDocument();
      
      // Should not throw error and should display some date
      const dateText = dateElement?.textContent;
      expect(dateText).toMatch(/Last updated: \d+\/\d+\/\d+/);
    });

    it('should render without errors when all content is present', () => {
      // This test ensures the component doesn't crash during rendering
      expect(() => render(<PrivacyPolicyPage />)).not.toThrow();
    });

    it('should maintain consistent styling across all sections', () => {
      render(<PrivacyPolicyPage />);
      
      // Check that all section headings have consistent styling
      const sectionHeadings = screen.getAllByRole('heading', { level: 2 });
      sectionHeadings.forEach(heading => {
        expect(heading).toHaveClass('text-2xl', 'font-semibold', 'text-gray-900', 'dark:text-white', 'mb-4');
      });
    });
  });
});