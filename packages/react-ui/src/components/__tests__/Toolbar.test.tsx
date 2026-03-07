import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders, resetEventBusForTesting } from '../../test-utils';
import { Toolbar } from '../Toolbar';

describe('Toolbar', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  describe('document context', () => {
    it('renders all document context buttons when not archived', () => {
      renderWithProviders(
        <Toolbar context="document" activePanel={null} />
      );

      expect(screen.getByLabelText('Toolbar.annotations')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.resourceInfo')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.history')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.collaboration')).toBeInTheDocument();
      expect(screen.getByLabelText('JSON-LD')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.userAccount')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.settings')).toBeInTheDocument();
    });

    it('hides annotations button when archived', () => {
      renderWithProviders(
        <Toolbar context="document" activePanel={null} isArchived={true} />
      );

      expect(screen.queryByLabelText('Toolbar.annotations')).not.toBeInTheDocument();
      // Other document buttons should still be present
      expect(screen.getByLabelText('Toolbar.resourceInfo')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.history')).toBeInTheDocument();
    });
  });

  describe('simple context', () => {
    it('renders only user and settings in simple context', () => {
      renderWithProviders(
        <Toolbar context="simple" activePanel={null} />
      );

      expect(screen.getByLabelText('Toolbar.userAccount')).toBeInTheDocument();
      expect(screen.getByLabelText('Toolbar.settings')).toBeInTheDocument();

      // Document-specific buttons should not be present
      expect(screen.queryByLabelText('Toolbar.annotations')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Toolbar.resourceInfo')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Toolbar.history')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Toolbar.collaboration')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('JSON-LD')).not.toBeInTheDocument();
    });
  });

  describe('active panel', () => {
    it('marks active panel button as pressed', () => {
      renderWithProviders(
        <Toolbar context="document" activePanel="info" />
      );

      const infoButton = screen.getByLabelText('Toolbar.resourceInfo');
      expect(infoButton).toHaveAttribute('aria-pressed', 'true');

      const historyButton = screen.getByLabelText('Toolbar.history');
      expect(historyButton).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('event emission', () => {
    it('emits browse:panel-toggle with panel name on click', () => {
      const handler = vi.fn();

      const { eventBus } = renderWithProviders(
        <Toolbar context="document" activePanel={null} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:panel-toggle').subscribe(handler);

      fireEvent.click(screen.getByLabelText('Toolbar.resourceInfo'));
      expect(handler).toHaveBeenCalledWith({ panel: 'info' });

      handler.mockClear();
      fireEvent.click(screen.getByLabelText('Toolbar.annotations'));
      expect(handler).toHaveBeenCalledWith({ panel: 'annotations' });

      subscription.unsubscribe();
    });
  });

  describe('accessibility', () => {
    it('buttons have aria-label and aria-pressed', () => {
      renderWithProviders(
        <Toolbar context="document" activePanel="settings" />
      );

      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button).toHaveAttribute('aria-label');
        expect(button).toHaveAttribute('aria-pressed');
      });

      const settingsButton = screen.getByLabelText('Toolbar.settings');
      expect(settingsButton).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
