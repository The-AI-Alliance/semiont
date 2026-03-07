import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResizeHandle } from '../ResizeHandle';

describe('ResizeHandle', () => {
  const defaultProps = {
    onResize: vi.fn(),
    minWidth: 200,
    maxWidth: 800,
  };

  describe('rendering', () => {
    it('renders with role="separator" and aria-orientation="vertical"', () => {
      render(<ResizeHandle {...defaultProps} />);

      const handle = screen.getByRole('separator');
      expect(handle).toBeInTheDocument();
      expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('uses custom ariaLabel', () => {
      render(<ResizeHandle {...defaultProps} ariaLabel="Resize sidebar" />);

      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('aria-label', 'Resize sidebar');
    });

    it('uses default ariaLabel when not specified', () => {
      render(<ResizeHandle {...defaultProps} />);

      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('aria-label', 'Resize panel');
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
      const { container } = render(
        <div style={{ width: '400px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="left" />
        </div>
      );

      // Mock offsetWidth on the parent div
      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 400 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });

      expect(onResize).toHaveBeenCalledWith(410); // 400 + 10
    });

    it('calls onResize on ArrowRight (narrower) for left position', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '400px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="left" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 400 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      expect(onResize).toHaveBeenCalledWith(390); // 400 - 10
    });
  });

  describe('keyboard resize with right position', () => {
    it('calls onResize on ArrowRight (wider) for right position', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '400px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="right" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 400 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });

      expect(onResize).toHaveBeenCalledWith(410); // 400 + 10
    });

    it('calls onResize on ArrowLeft (narrower) for right position', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '400px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="right" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 400 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });

      expect(onResize).toHaveBeenCalledWith(390); // 400 - 10
    });
  });

  describe('constraints', () => {
    it('respects minWidth constraint on keyboard resize', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '210px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="left" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 210 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' }); // narrower for left position

      expect(onResize).toHaveBeenCalledWith(200); // clamped to minWidth
    });

    it('respects maxWidth constraint on keyboard resize', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '795px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="left" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 795 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // wider for left position

      expect(onResize).toHaveBeenCalledWith(800); // clamped to maxWidth
    });
  });

  describe('shift key step', () => {
    it('Shift+Arrow uses 50px step instead of 10px', () => {
      const onResize = vi.fn();
      const { container } = render(
        <div style={{ width: '400px' }}>
          <ResizeHandle onResize={onResize} minWidth={200} maxWidth={800} position="left" />
        </div>
      );

      Object.defineProperty(container.firstChild, 'offsetWidth', { value: 400 });

      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });

      expect(onResize).toHaveBeenCalledWith(450); // 400 + 50
    });
  });
});
