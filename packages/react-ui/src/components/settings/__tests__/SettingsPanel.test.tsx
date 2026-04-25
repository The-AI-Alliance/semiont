import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { SettingsPanel } from '../SettingsPanel';

// Mock LiveRegion
vi.mock('../../LiveRegion', () => ({
  useLanguageChangeAnnouncements: vi.fn(() => ({
    announceLanguageChanging: vi.fn(),
    announceLanguageChanged: vi.fn(),
  })),
}));

// Mock LOCALES (lives in @semiont/core)
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    LOCALES: [
      { code: 'en', nativeName: 'English' },
      { code: 'de', nativeName: 'Deutsch' },
      { code: 'fr', nativeName: 'Français' },
    ],
  };
});

describe('SettingsPanel', () => {
  const defaultProps = {
    showLineNumbers: true,
    theme: 'light' as const,
    locale: 'en',
    hoverDelayMs: 150,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings title', () => {
    renderWithProviders(<SettingsPanel {...defaultProps} />);
    expect(screen.getByText('Settings.title')).toBeInTheDocument();
  });

  describe('line numbers toggle', () => {
    it('renders line numbers toggle', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} />);
      expect(screen.getByText('Settings.lineNumbers')).toBeInTheDocument();
    });

    it('shows toggle as checked when line numbers enabled', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} showLineNumbers={true} />);
      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('shows toggle as unchecked when line numbers disabled', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} showLineNumbers={false} />);
      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('emits settings:line-numbers-toggled on toggle click', () => {
      const handler = vi.fn();
      const { shellBus } = renderWithProviders(
        <SettingsPanel {...defaultProps} />,
        { returnShellBus: true }
      );

      const sub = shellBus!.get('settings:line-numbers-toggled').subscribe(handler);
      fireEvent.click(screen.getByRole('switch'));
      expect(handler).toHaveBeenCalled();
      sub.unsubscribe();
    });
  });

  describe('theme selection', () => {
    it('renders theme buttons', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} />);
      expect(screen.getByText(/Settings.themeLight/)).toBeInTheDocument();
      expect(screen.getByText(/Settings.themeDark/)).toBeInTheDocument();
      expect(screen.getByText(/Settings.themeSystem/)).toBeInTheDocument();
    });

    it('marks active theme as pressed', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} theme="dark" />);
      const darkButton = screen.getByText(/Settings.themeDark/);
      expect(darkButton).toHaveAttribute('aria-pressed', 'true');

      const lightButton = screen.getByText(/Settings.themeLight/);
      expect(lightButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('emits settings:theme-changed on theme button click', () => {
      const handler = vi.fn();
      const { shellBus } = renderWithProviders(
        <SettingsPanel {...defaultProps} />,
        { returnShellBus: true }
      );

      const sub = shellBus!.get('settings:theme-changed').subscribe(handler);
      fireEvent.click(screen.getByText(/Settings.themeDark/));
      expect(handler).toHaveBeenCalledWith({ theme: 'dark' });
      sub.unsubscribe();
    });
  });

  describe('language selection', () => {
    it('renders language select with options', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} />);
      const select = screen.getByLabelText('Settings.language');
      expect(select).toBeInTheDocument();

      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('Deutsch')).toBeInTheDocument();
      expect(screen.getByText('Français')).toBeInTheDocument();
    });

    it('shows current locale as selected', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} locale="de" />);
      const select = screen.getByLabelText('Settings.language') as HTMLSelectElement;
      expect(select.value).toBe('de');
    });

    it('emits settings:locale-changed on language change', () => {
      const handler = vi.fn();
      const { shellBus } = renderWithProviders(
        <SettingsPanel {...defaultProps} />,
        { returnShellBus: true }
      );

      const sub = shellBus!.get('settings:locale-changed').subscribe(handler);
      fireEvent.change(screen.getByLabelText('Settings.language'), {
        target: { value: 'fr' },
      });
      expect(handler).toHaveBeenCalledWith({ locale: 'fr' });
      sub.unsubscribe();
    });

    it('disables select when locale change is pending', () => {
      renderWithProviders(
        <SettingsPanel {...defaultProps} isPendingLocaleChange={true} />
      );
      const select = screen.getByLabelText('Settings.language');
      expect(select).toBeDisabled();
      expect(select).toHaveAttribute('aria-busy', 'true');
    });

    it('shows loading message when locale change is pending', () => {
      renderWithProviders(
        <SettingsPanel {...defaultProps} isPendingLocaleChange={true} />
      );
      expect(screen.getByText('Settings.languageChanging')).toBeInTheDocument();
    });
  });

  describe('hover delay slider', () => {
    it('renders hover delay slider', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} />);
      const slider = screen.getByLabelText('Settings.hoverDelay');
      expect(slider).toBeInTheDocument();
      expect(slider).toHaveAttribute('type', 'range');
      expect(slider).toHaveAttribute('min', '0');
      expect(slider).toHaveAttribute('max', '500');
    });

    it('shows current hover delay value', () => {
      renderWithProviders(<SettingsPanel {...defaultProps} hoverDelayMs={200} />);
      const slider = screen.getByLabelText('Settings.hoverDelay') as HTMLInputElement;
      expect(slider.value).toBe('200');
    });

    it('emits settings:hover-delay-changed on slider change', () => {
      const handler = vi.fn();
      const { shellBus } = renderWithProviders(
        <SettingsPanel {...defaultProps} />,
        { returnShellBus: true }
      );

      const sub = shellBus!.get('settings:hover-delay-changed').subscribe(handler);
      fireEvent.change(screen.getByLabelText('Settings.hoverDelay'), {
        target: { value: '300' },
      });
      expect(handler).toHaveBeenCalledWith({ hoverDelayMs: 300 });
      sub.unsubscribe();
    });
  });
});
