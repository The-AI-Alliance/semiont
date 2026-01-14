/**
 * Tests for WelcomePage component
 *
 * Tests the welcome/terms acceptance page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WelcomePage } from '../components/WelcomePage';
import type { WelcomePageProps } from '../components/WelcomePage';

const createMockTranslations = () => ({
  loading: 'Loading...',
  welcomeTitle: 'Welcome!',
  thanksForAccepting: 'Thanks for accepting our terms',
  welcomeUser: 'Welcome, Test User',
  reviewTermsPrompt: 'Please review and accept our terms',
  termsSummaryTitle: 'Terms Summary',
  termsSummaryIntro: 'Here is a summary of our terms',
  acceptableUseTitle: 'Acceptable Use',
  acceptableUseResponsible: 'Use responsibly',
  acceptableUseRespect: 'Respect others',
  acceptableUseConduct: 'Follow code of conduct',
  prohibitedContentTitle: 'Prohibited Content',
  prohibitedContentIntro: 'The following is prohibited:',
  prohibitedIllegal: 'Illegal content',
  prohibitedAdult: 'Adult content',
  prohibitedHate: 'Hate speech',
  prohibitedViolence: 'Violence',
  prohibitedMisinformation: 'Misinformation',
  prohibitedPrivacy: 'Privacy violations',
  prohibitedCopyright: 'Copyright violations',
  prohibitedMalware: 'Malware',
  prohibitedSpam: 'Spam',
  conductTitle: 'Code of Conduct',
  conductDescription: 'Our community follows',
  conductLink: 'AI Alliance Code of Conduct',
  conductPromotion: ' to promote respectful collaboration',
  responsibilitiesTitle: 'Your Responsibilities',
  responsibilitiesSecure: 'Keep your account secure',
  responsibilitiesReport: 'Report violations',
  responsibilitiesAccurate: 'Provide accurate information',
  responsibilitiesComply: 'Comply with laws',
  violationsWarning: 'Violations may result in account suspension',
  readFullTerms: 'Please read our full',
  termsOfService: 'Terms of Service',
  and: 'and',
  privacyPolicy: 'Privacy Policy',
  declineAndSignOut: 'Decline and Sign Out',
  acceptAndContinue: 'Accept and Continue',
  processing: 'Processing...',
  legallyBound: 'By accepting, you agree to be legally bound',
});

const createMockProps = (overrides?: Partial<WelcomePageProps>): WelcomePageProps => ({
  status: 'form',
  isProcessing: false,
  onAccept: vi.fn(),
  onDecline: vi.fn(),
  translations: createMockTranslations(),
  PageLayout: ({ children, className }: any) => <div data-testid="page-layout" className={className}>{children}</div>,
  Link: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
  ...overrides,
});

describe('WelcomePage', () => {
  describe('Loading State', () => {
    it('renders loading message', () => {
      const props = createMockProps({ status: 'loading' });
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('renders with correct page layout', () => {
      const props = createMockProps({ status: 'loading' });
      const { container } = render(<WelcomePage {...props} />);

      const pageLayout = container.querySelector('.semiont-welcome-page__layout');
      expect(pageLayout).toBeInTheDocument();
    });

    it('renders spinner', () => {
      const props = createMockProps({ status: 'loading' });
      render(<WelcomePage {...props} />);

      const spinner = screen.getByText('Loading...').previousElementSibling;
      expect(spinner).toHaveClass('semiont-welcome-page__spinner');
    });
  });

  describe('Accepted State', () => {
    it('renders acceptance confirmation', () => {
      const props = createMockProps({ status: 'accepted' });
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Welcome!')).toBeInTheDocument();
      expect(screen.getByText('Thanks for accepting our terms')).toBeInTheDocument();
    });

    it('renders success checkmark', () => {
      const props = createMockProps({ status: 'accepted' });
      const { container } = render(<WelcomePage {...props} />);

      const checkmarkContainer = container.querySelector('.semiont-welcome-page__accepted-checkmark');
      expect(checkmarkContainer).toBeInTheDocument();
    });

    it('does not render form elements', () => {
      const props = createMockProps({ status: 'accepted' });
      render(<WelcomePage {...props} />);

      expect(screen.queryByText('Accept and Continue')).not.toBeInTheDocument();
      expect(screen.queryByText('Decline and Sign Out')).not.toBeInTheDocument();
    });
  });

  describe('Terms Form - Basic Rendering', () => {
    it('renders welcome message with user name', () => {
      const props = createMockProps({ userName: 'Test User' });
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Welcome, Test User')).toBeInTheDocument();
    });

    it('renders review prompt', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Please review and accept our terms')).toBeInTheDocument();
    });

    it('renders terms summary section', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Terms Summary')).toBeInTheDocument();
      expect(screen.getByText('Here is a summary of our terms')).toBeInTheDocument();
    });

    it('renders acceptable use section', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Acceptable Use')).toBeInTheDocument();
      expect(screen.getByText('Use responsibly')).toBeInTheDocument();
      expect(screen.getByText('Respect others')).toBeInTheDocument();
      expect(screen.getByText('Follow code of conduct')).toBeInTheDocument();
    });

    it('renders prohibited content section', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Prohibited Content')).toBeInTheDocument();
      expect(screen.getByText('Illegal content')).toBeInTheDocument();
      expect(screen.getByText('Hate speech')).toBeInTheDocument();
      expect(screen.getByText('Spam')).toBeInTheDocument();
    });

    it('renders code of conduct section with link', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Code of Conduct')).toBeInTheDocument();
      const link = screen.getByText('AI Alliance Code of Conduct');
      expect(link).toHaveAttribute('href', 'https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf');
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('renders responsibilities section', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Your Responsibilities')).toBeInTheDocument();
      expect(screen.getByText('Keep your account secure')).toBeInTheDocument();
      expect(screen.getByText('Report violations')).toBeInTheDocument();
      expect(screen.getByText('Provide accurate information')).toBeInTheDocument();
      expect(screen.getByText('Comply with laws')).toBeInTheDocument();
    });

    it('renders violations warning', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('Violations may result in account suspension')).toBeInTheDocument();
    });

    it('renders terms and privacy policy links', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      const termsLink = screen.getByText('Terms of Service');
      expect(termsLink).toHaveAttribute('href', '/terms');
      expect(termsLink).toHaveAttribute('target', '_blank');

      const privacyLink = screen.getByText('Privacy Policy');
      expect(privacyLink).toHaveAttribute('href', '/privacy');
      expect(privacyLink).toHaveAttribute('target', '_blank');
    });

    it('renders legal notice', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByText('By accepting, you agree to be legally bound')).toBeInTheDocument();
    });
  });

  describe('Button Interactions', () => {
    it('renders accept button', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByRole('button', { name: 'Accept and Continue' })).toBeInTheDocument();
    });

    it('renders decline button', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      expect(screen.getByRole('button', { name: 'Decline and Sign Out' })).toBeInTheDocument();
    });

    it('calls onAccept when accept button clicked', () => {
      const onAccept = vi.fn();
      const props = createMockProps({ onAccept });
      render(<WelcomePage {...props} />);

      const button = screen.getByRole('button', { name: 'Accept and Continue' });
      fireEvent.click(button);

      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it('calls onDecline when decline button clicked', () => {
      const onDecline = vi.fn();
      const props = createMockProps({ onDecline });
      render(<WelcomePage {...props} />);

      const button = screen.getByRole('button', { name: 'Decline and Sign Out' });
      fireEvent.click(button);

      expect(onDecline).toHaveBeenCalledTimes(1);
    });

    it('disables buttons when processing', () => {
      const props = createMockProps({ isProcessing: true });
      render(<WelcomePage {...props} />);

      const acceptButton = screen.getByRole('button', { name: 'Processing...' });
      const declineButton = screen.getByRole('button', { name: 'Decline and Sign Out' });

      expect(acceptButton).toBeDisabled();
      expect(declineButton).toBeDisabled();
    });

    it('shows processing text on accept button when processing', () => {
      const props = createMockProps({ isProcessing: true });
      render(<WelcomePage {...props} />);

      expect(screen.getByRole('button', { name: 'Processing...' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Accept and Continue' })).not.toBeInTheDocument();
    });

    it('does not call callbacks when buttons are disabled', () => {
      const onAccept = vi.fn();
      const onDecline = vi.fn();
      const props = createMockProps({ isProcessing: true, onAccept, onDecline });
      render(<WelcomePage {...props} />);

      const acceptButton = screen.getByRole('button', { name: 'Processing...' });
      const declineButton = screen.getByRole('button', { name: 'Decline and Sign Out' });

      fireEvent.click(acceptButton);
      fireEvent.click(declineButton);

      expect(onAccept).not.toHaveBeenCalled();
      expect(onDecline).not.toHaveBeenCalled();
    });
  });

  describe('Styling and Accessibility', () => {
    it('renders scrollable terms container', () => {
      const props = createMockProps();
      const { container } = render(<WelcomePage {...props} />);

      const termsContainer = container.querySelector('.semiont-welcome-page__terms-content');
      expect(termsContainer).toBeInTheDocument();
    });

    it('renders accept button with correct styling', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      const button = screen.getByRole('button', { name: 'Accept and Continue' });
      expect(button).toHaveClass('semiont-welcome-page__button semiont-welcome-page__button--primary');
    });

    it('renders decline button with correct styling', () => {
      const props = createMockProps();
      render(<WelcomePage {...props} />);

      const button = screen.getByRole('button', { name: 'Decline and Sign Out' });
      expect(button).toHaveClass('semiont-welcome-page__button semiont-welcome-page__button--secondary');
    });

    it('renders with proper dark mode classes', () => {
      const props = createMockProps();
      const { container } = render(<WelcomePage {...props} />);

      const pageLayout = container.querySelector('.semiont-welcome-page__layout');
      expect(pageLayout).toBeInTheDocument();
    });
  });
});
