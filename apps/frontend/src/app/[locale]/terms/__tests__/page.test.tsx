import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import TermsOfService from '../page';

// Mock PageLayout from react-ui to provide the home link
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    PageLayout: ({ children, className }: any) => (
      <div className="flex flex-col min-h-screen">
        <a href="/">Return to Home</a>
        <main className={`flex-1 ${className || ''}`}>
          {children}
        </main>
      </div>
    )
  };
});

describe('Terms of Service Page', () => {
  it('renders the main heading', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByText('Please read these terms carefully before using Semiont')).toBeInTheDocument();
  });

  it('includes acceptable use policy section', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Acceptable Use Policy' })).toBeInTheDocument();
    expect(screen.getByText(/maintaining a safe, respectful, and productive environment/)).toBeInTheDocument();
  });

  it('lists prohibited content types', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Prohibited Content' })).toBeInTheDocument();
    
    // Check for key prohibited content categories
    expect(screen.getByText(/Illegal Content/)).toBeInTheDocument();
    expect(screen.getByText(/Adult Content/)).toBeInTheDocument();
    expect(screen.getByText(/Violence and Abuse/)).toBeInTheDocument();
    expect(screen.getByText(/Hate Speech/)).toBeInTheDocument();
    expect(screen.getByText(/Misinformation/)).toBeInTheDocument();
    expect(screen.getByText(/Privacy Violations/)).toBeInTheDocument();
    expect(screen.getByText(/Intellectual Property Violations/)).toBeInTheDocument();
    expect(screen.getByText(/Malicious Content/)).toBeInTheDocument();
  });

  it('includes AI Alliance Code of Conduct section', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'AI Alliance Code of Conduct' })).toBeInTheDocument();
    
    const codeOfConductLink = screen.getByRole('link', { name: /AI Alliance Code of Conduct/ });
    expect(codeOfConductLink).toHaveAttribute(
      'href', 
      'https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf'
    );
    expect(codeOfConductLink).toHaveAttribute('target', '_blank');
    expect(codeOfConductLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('includes AI Alliance principles', () => {
    render(<TermsOfService />);
    
    expect(screen.getByText(/responsible AI development and deployment/)).toBeInTheDocument();
    expect(screen.getByText(/transparency and accountability/)).toBeInTheDocument();
    expect(screen.getByText(/privacy, security, and human rights/)).toBeInTheDocument();
    expect(screen.getByText(/inclusive and diverse participation/)).toBeInTheDocument();
    expect(screen.getByText(/ethical considerations/)).toBeInTheDocument();
  });

  it('outlines user responsibilities', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'User Responsibilities' })).toBeInTheDocument();
    expect(screen.getByText(/lawful and constructive purposes/)).toBeInTheDocument();
    expect(screen.getByText(/Respect the rights and dignity of other users/)).toBeInTheDocument();
    expect(screen.getByText(/Keep your account secure and not share access credentials/)).toBeInTheDocument();
  });

  it('includes content moderation policy', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Content Moderation' })).toBeInTheDocument();
    expect(screen.getByText(/review, moderate, and remove content/)).toBeInTheDocument();
    expect(screen.getByText(/suspend or terminate accounts/)).toBeInTheDocument();
  });

  it('references privacy policy', () => {
    render(<TermsOfService />);

    expect(screen.getByText('Privacy and Data Protection')).toBeInTheDocument();

    const privacyLink = screen.getByRole('link', { name: /Privacy Policy/ });
    expect(privacyLink).toHaveAttribute('href', '/en/privacy');
  });

  it('includes intellectual property section', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Intellectual Property' })).toBeInTheDocument();
    expect(screen.getByText(/Users retain ownership of their original content/)).toBeInTheDocument();
  });

  it('includes limitation of liability', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Limitation of Liability' })).toBeInTheDocument();
    expect(screen.getByText(/provided "as is" without warranties/)).toBeInTheDocument();
  });

  it('shows last updated date', () => {
    render(<TermsOfService />);
    
    const today = new Date().toLocaleDateString();
    expect(screen.getByText(`Last updated: ${today}`)).toBeInTheDocument();
  });

  it('has return to home link', () => {
    render(<TermsOfService />);
    
    const homeLink = screen.getByRole('link', { name: 'Return to Home' });
    expect(homeLink).toHaveAttribute('href', '/');
  });

  it('includes contact information section', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Contact' })).toBeInTheDocument();
    expect(screen.getByText(/report violations/)).toBeInTheDocument();
  });

  it('mentions terms update policy', () => {
    render(<TermsOfService />);
    
    expect(screen.getByRole('heading', { name: 'Changes to Terms' })).toBeInTheDocument();
    expect(screen.getByText(/update these terms periodically/)).toBeInTheDocument();
  });
});