import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { SettingsPanel } from '../SettingsPanel';

// Mock next-intl
const mockUseTranslations = vi.fn();
const mockUseLocale = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => mockUseTranslations,
  useLocale: () => mockUseLocale(),
}));

// Mock @/i18n/routing
const mockReplace = vi.fn();
const mockUsePathname = vi.fn();

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => mockUsePathname(),
}));

// Mock React useTransition
const mockStartTransition = vi.fn((callback) => callback());
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// Mock LOCALES from API client
vi.mock('@semiont/api-client', () => ({
  LOCALES: [
    { code: 'en', nativeName: 'English' },
    { code: 'es', nativeName: 'Español' },
    { code: 'fr', nativeName: 'Français' },
    { code: 'de', nativeName: 'Deutsch' },
  ],
}));

describe('SettingsPanel Component', () => {
  const defaultProps = {
    showLineNumbers: false,
    onLineNumbersToggle: vi.fn(),
    theme: 'system' as const,
    onThemeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup translation mock
    mockUseTranslations.mockImplementation((key: string, params?: any) => {
      const translations: Record<string, string> = {
        title: 'Settings',
        lineNumbers: 'Line Numbers',
        lineNumbersVisible: 'Line numbers are visible',
        lineNumbersHidden: 'Line numbers are hidden',
        theme: 'Theme',
        themeLight: 'Light',
        themeDark: 'Dark',
        themeSystem: 'System',
        themeSystemActive: 'Following system settings',
        themeModeActive: '{mode} mode active',
        language: 'Language',
        languageHint: 'Select your preferred language',
      };

      // Handle template replacement for themeModeActive
      if (key === 'themeModeActive' && params?.mode) {
        return `${params.mode} mode active`;
      }

      return translations[key] || key;
    });

    mockUseLocale.mockReturnValue('en');
    mockUsePathname.mockReturnValue('/documents/123');
  });

  describe('Rendering', () => {
    it('should render settings title', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('should render line numbers section', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText('Line Numbers')).toBeInTheDocument();
    });

    it('should render theme section', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText('Theme')).toBeInTheDocument();
    });

    it('should render language section', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText('Language')).toBeInTheDocument();
    });

    it('should render all three theme buttons', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText(/Light/)).toBeInTheDocument();
      expect(screen.getByText(/Dark/)).toBeInTheDocument();
      expect(screen.getByText(/System/)).toBeInTheDocument();
    });
  });

  describe('Line Numbers Toggle', () => {
    it('should show toggle switch in off state when line numbers are hidden', () => {
      render(<SettingsPanel {...defaultProps} showLineNumbers={false} />);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(toggle).toHaveClass('bg-gray-400');
    });

    it('should show toggle switch in on state when line numbers are visible', () => {
      render(<SettingsPanel {...defaultProps} showLineNumbers={true} />);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).toHaveClass('bg-blue-600');
    });

    it('should call onLineNumbersToggle when toggle clicked', async () => {
      const onToggle = vi.fn();
      render(<SettingsPanel {...defaultProps} onLineNumbersToggle={onToggle} />);

      const toggle = screen.getByRole('switch');
      await userEvent.click(toggle);

      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('should show correct status text when line numbers are visible', () => {
      render(<SettingsPanel {...defaultProps} showLineNumbers={true} />);

      expect(screen.getByText('Line numbers are visible')).toBeInTheDocument();
    });

    it('should show correct status text when line numbers are hidden', () => {
      render(<SettingsPanel {...defaultProps} showLineNumbers={false} />);

      expect(screen.getByText('Line numbers are hidden')).toBeInTheDocument();
    });

    it('should have proper accessibility attributes', () => {
      render(<SettingsPanel {...defaultProps} />);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('type', 'button');
      expect(toggle).toHaveAttribute('aria-checked');
    });
  });

  describe('Theme Selection', () => {
    it('should highlight light theme button when light is active', () => {
      render(<SettingsPanel {...defaultProps} theme="light" />);

      const lightButton = screen.getByRole('button', { name: /☀️.*Light/ });
      expect(lightButton).toHaveClass('bg-blue-600', 'text-white');
    });

    it('should highlight dark theme button when dark is active', () => {
      render(<SettingsPanel {...defaultProps} theme="dark" />);

      const darkButton = screen.getByRole('button', { name: /🌙.*Dark/ });
      expect(darkButton).toHaveClass('bg-blue-600', 'text-white');
    });

    it('should highlight system theme button when system is active', () => {
      render(<SettingsPanel {...defaultProps} theme="system" />);

      const systemButton = screen.getByRole('button', { name: /💻.*System/ });
      expect(systemButton).toHaveClass('bg-blue-600', 'text-white');
    });

    it('should call onThemeChange with "light" when light button clicked', async () => {
      const onThemeChange = vi.fn();
      render(<SettingsPanel {...defaultProps} onThemeChange={onThemeChange} />);

      const lightButton = screen.getByText(/☀️.*Light/);
      await userEvent.click(lightButton);

      expect(onThemeChange).toHaveBeenCalledWith('light');
    });

    it('should call onThemeChange with "dark" when dark button clicked', async () => {
      const onThemeChange = vi.fn();
      render(<SettingsPanel {...defaultProps} onThemeChange={onThemeChange} />);

      const darkButton = screen.getByText(/🌙.*Dark/);
      await userEvent.click(darkButton);

      expect(onThemeChange).toHaveBeenCalledWith('dark');
    });

    it('should call onThemeChange with "system" when system button clicked', async () => {
      const onThemeChange = vi.fn();
      render(<SettingsPanel {...defaultProps} onThemeChange={onThemeChange} />);

      const systemButton = screen.getByText(/💻.*System/);
      await userEvent.click(systemButton);

      expect(onThemeChange).toHaveBeenCalledWith('system');
    });

    it('should show "Following system settings" message when system theme is active', () => {
      render(<SettingsPanel {...defaultProps} theme="system" />);

      expect(screen.getByText('Following system settings')).toBeInTheDocument();
    });

    it('should show mode-specific message when light theme is active', () => {
      render(<SettingsPanel {...defaultProps} theme="light" />);

      expect(screen.getByText('Light mode active')).toBeInTheDocument();
    });

    it('should show mode-specific message when dark theme is active', () => {
      render(<SettingsPanel {...defaultProps} theme="dark" />);

      expect(screen.getByText('Dark mode active')).toBeInTheDocument();
    });

    it('should have emoji icons in theme buttons', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText(/☀️/)).toBeInTheDocument();
      expect(screen.getByText(/🌙/)).toBeInTheDocument();
      expect(screen.getByText(/💻/)).toBeInTheDocument();
    });
  });

  describe('Language Selection', () => {
    it('should render language dropdown with current locale selected', () => {
      mockUseLocale.mockReturnValue('en');
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByLabelText('Language') as HTMLSelectElement;
      expect(select.value).toBe('en');
    });

    it('should render all available languages as options', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByRole('option', { name: 'English' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Español' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Français' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();
    });

    it('should call router.replace when language is changed', async () => {
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByLabelText('Language');
      await userEvent.selectOptions(select, 'es');

      expect(mockReplace).toHaveBeenCalledWith('/documents/123', { locale: 'es' });
    });

    it('should use transition when changing language', async () => {
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByLabelText('Language');
      await userEvent.selectOptions(select, 'fr');

      expect(mockStartTransition).toHaveBeenCalled();
    });

    it('should not change language if pathname is undefined', async () => {
      mockUsePathname.mockReturnValue(undefined);
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByLabelText('Language');
      await userEvent.selectOptions(select, 'de');

      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('should show language hint text', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByText('Select your preferred language')).toBeInTheDocument();
    });

    it('should have proper select element ID', () => {
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByRole('combobox');
      expect(select).toHaveAttribute('id', 'language-select');
    });
  });

  describe('Dynamic Updates', () => {
    it('should update toggle state when showLineNumbers prop changes', () => {
      const { rerender } = render(<SettingsPanel {...defaultProps} showLineNumbers={false} />);

      let toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      rerender(<SettingsPanel {...defaultProps} showLineNumbers={true} />);

      toggle = screen.getByRole('switch');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('should update theme button highlighting when theme prop changes', () => {
      const { rerender } = render(<SettingsPanel {...defaultProps} theme="light" />);

      let lightButton = screen.getByRole('button', { name: /☀️.*Light/ });
      expect(lightButton).toHaveClass('bg-blue-600');

      rerender(<SettingsPanel {...defaultProps} theme="dark" />);

      lightButton = screen.getByRole('button', { name: /☀️.*Light/ });
      expect(lightButton).not.toHaveClass('bg-blue-600');

      const darkButton = screen.getByRole('button', { name: /🌙.*Dark/ });
      expect(darkButton).toHaveClass('bg-blue-600');
    });

    it('should update language dropdown when locale changes', () => {
      mockUseLocale.mockReturnValue('en');
      const { rerender } = render(<SettingsPanel {...defaultProps} />);

      let select = screen.getByLabelText('Language') as HTMLSelectElement;
      expect(select.value).toBe('en');

      mockUseLocale.mockReturnValue('es');
      rerender(<SettingsPanel {...defaultProps} />);

      select = screen.getByLabelText('Language') as HTMLSelectElement;
      expect(select.value).toBe('es');
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper heading styles', () => {
      render(<SettingsPanel {...defaultProps} />);

      const heading = screen.getByText('Settings');
      expect(heading).toHaveClass('text-sm', 'font-semibold', 'mb-3');
    });

    it('should support dark mode for heading', () => {
      render(<SettingsPanel {...defaultProps} />);

      const heading = screen.getByText('Settings');
      expect(heading).toHaveClass('dark:text-white');
    });

    it('should have proper spacing between sections', () => {
      const { container } = render(<SettingsPanel {...defaultProps} />);

      const sectionsContainer = container.querySelector('.space-y-4');
      expect(sectionsContainer).toBeInTheDocument();
    });

    it('should style inactive theme buttons with gray background', () => {
      render(<SettingsPanel {...defaultProps} theme="light" />);

      const darkButton = screen.getByText(/Dark/).closest('button');
      expect(darkButton).toHaveClass('bg-gray-200', 'dark:bg-gray-700');
    });

    it('should have focus styles on toggle switch', () => {
      render(<SettingsPanel {...defaultProps} />);

      const toggle = screen.getByRole('switch');
      expect(toggle).toHaveClass('focus:outline-none', 'focus:ring-2', 'focus:ring-blue-500');
    });
  });

  describe('Accessibility', () => {
    it('should have proper label for language select', () => {
      render(<SettingsPanel {...defaultProps} />);

      const label = screen.getByText('Language');
      expect(label).toHaveAttribute('for', 'language-select');
    });

    it('should use semantic HTML for sections', () => {
      render(<SettingsPanel {...defaultProps} />);

      const heading = screen.getByText('Settings');
      expect(heading.tagName).toBe('H3');
    });

    it('should have label wrapped around toggle', () => {
      render(<SettingsPanel {...defaultProps} />);

      const toggle = screen.getByRole('switch');
      const label = toggle.closest('label');
      expect(label).toBeInTheDocument();
    });

    it('should have proper ARIA role for toggle', () => {
      render(<SettingsPanel {...defaultProps} />);

      expect(screen.getByRole('switch')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid toggle clicks', async () => {
      const onToggle = vi.fn();
      render(<SettingsPanel {...defaultProps} onLineNumbersToggle={onToggle} />);

      const toggle = screen.getByRole('switch');

      for (let i = 0; i < 5; i++) {
        await userEvent.click(toggle);
      }

      expect(onToggle).toHaveBeenCalledTimes(5);
    });

    it('should handle rapid theme changes', async () => {
      const onThemeChange = vi.fn();
      render(<SettingsPanel {...defaultProps} onThemeChange={onThemeChange} />);

      await userEvent.click(screen.getByText(/Light/));
      await userEvent.click(screen.getByText(/Dark/));
      await userEvent.click(screen.getByText(/System/));

      expect(onThemeChange).toHaveBeenCalledTimes(3);
      expect(onThemeChange).toHaveBeenNthCalledWith(1, 'light');
      expect(onThemeChange).toHaveBeenNthCalledWith(2, 'dark');
      expect(onThemeChange).toHaveBeenNthCalledWith(3, 'system');
    });

    it('should handle missing pathname gracefully', async () => {
      mockUsePathname.mockReturnValue(null);
      render(<SettingsPanel {...defaultProps} />);

      const select = screen.getByLabelText('Language');

      expect(() => userEvent.selectOptions(select, 'es')).not.toThrow();
    });

    it('should handle empty locale', () => {
      mockUseLocale.mockReturnValue('');
      const { container } = render(<SettingsPanel {...defaultProps} />);

      expect(container.firstChild).toBeInTheDocument();
    });
  });
});
