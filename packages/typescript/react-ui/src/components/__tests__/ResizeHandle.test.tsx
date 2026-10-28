import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResizeHandle } from '../ResizeHandle';

describe('ResizeHandle', () => {
  const defaultProps = {
    onResize: vi.fn(),
    width: 400,
    minWidth: 200,
    maxWidth: 800,
    ariaLabel: 'Resize sidebar',
  };

  describe('rendering', () => {
    it('renders with role="separator" and aria-orientation="vertical"', () => {
      render(<ResizeHandle {...defaultProps} />);

      const handle = screen.getByRole('separator');
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('is named by ariaLabel', () => {
      render(<ResizeHandle {...defaultProps} />);

      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('aria-label', 'Resize sidebar');
    });

    it('carries the width as its value, between minWidth and maxWidth', () => {
      render(<ResizeHandle {...defaultProps} width={320} />);

      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('aria-valuenow', '320');
      expect(handle).toHaveAttribute('aria-valuemin', '200');
      expect(handle).toHaveAttribute('aria-valuemax', '800');
    });

    it('has tabIndex 0 for keyboard focus', () => {
      render(<ResizeHandle {...defaultProps} />);

      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('tabindex', '0');
    });
  });

  describe('keyboard resize with left position', () => {
    it('calls onResize on ArrowLeft (wider) for left position', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="left" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });

      expect(onResize).toHaveBeenCalledWith(410); // 400 + 10
    });

    it('calls onResize on ArrowRight (narrower) for left position', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="left" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });

      expect(onResize).toHaveBeenCalledWith(390); // 400 - 10
    });
  });

  describe('keyboard resize with right position', () => {
    it('calls onResize on ArrowRight (wider) for right position', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="right" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });

      expect(onResize).toHaveBeenCalledWith(410); // 400 + 10
    });

    it('calls onResize on ArrowLeft (narrower) for right position', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="right" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });

      expect(onResize).toHaveBeenCalledWith(390); // 400 - 10
    });
  });

  describe('constraints', () => {
    it('respects minWidth constraint on keyboard resize', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} width={210} position="left" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' }); // narrower for left position

      expect(onResize).toHaveBeenCalledWith(200); // clamped to minWidth
    });

    it('respects maxWidth constraint on keyboard resize', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} width={795} position="left" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }); // wider for left position

      expect(onResize).toHaveBeenCalledWith(800); // clamped to maxWidth
    });
  });

  describe('shift key step', () => {
    it('Shift+Arrow uses 50px step instead of 10px', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="left" />);

      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft', shiftKey: true });

      expect(onResize).toHaveBeenCalledWith(450); // 400 + 50
    });
  });

  describe('mouse drag', () => {
    it('resizes from the width it was given when the drag began', () => {
      const onResize = vi.fn();
      render(<ResizeHandle {...defaultProps} onResize={onResize} position="right" />);

      fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 130 });

      expect(onResize).toHaveBeenCalledWith(430); // 400 + 30
    });
  });
});
