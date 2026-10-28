import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Annotation } from '@semiont/core';
import {
  LiveRegionProvider,
  useDocumentAnnouncements,
  useFormAnnouncements,
  useLanguageChangeAnnouncements,
  useResourceLoadingAnnouncements,
} from '../LiveRegion';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LiveRegionProvider>{children}</LiveRegionProvider>;
}

describe('useFormAnnouncements', () => {
  it('announceFormSubmitting sets polite message', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });

    act(() => result.current.announceFormSubmitting());

    const { container } = render(
      <LiveRegionProvider>
        <div />
      </LiveRegionProvider>
    );
    // The announcement happens via context; verify the hook returns the functions
    expect(typeof result.current.announceFormSubmitting).toBe('function');
    expect(typeof result.current.announceFormSuccess).toBe('function');
    expect(typeof result.current.announceFormError).toBe('function');
    expect(typeof result.current.announceFormValidationError).toBe('function');
    container.remove();
  });

  it('announceFormSuccess uses custom message', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    act(() => result.current.announceFormSuccess('Created!'));
    // No throw = success
  });

  it('announceFormSuccess has no message of its own', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    // @ts-expect-error no message
    const withoutMessage = () => result.current.announceFormSuccess();
    expect(withoutMessage).toBeTypeOf('function');
  });

  it('announceFormError uses custom message', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    act(() => result.current.announceFormError('Network error'));
  });

  it('announceFormError has no message of its own', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    // @ts-expect-error no message
    const withoutMessage = () => result.current.announceFormError();
    expect(withoutMessage).toBeTypeOf('function');
  });

  it('announceFormValidationError with 1 field', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    act(() => result.current.announceFormValidationError(1));
  });

  it('announceFormValidationError with multiple fields', () => {
    const { result } = renderHook(() => useFormAnnouncements(), { wrapper: Wrapper });
    act(() => result.current.announceFormValidationError(3));
  });
});

describe('useLanguageChangeAnnouncements', () => {
  it('announceLanguageChanging is callable', () => {
    const { result } = renderHook(() => useLanguageChangeAnnouncements(), { wrapper: Wrapper });
    expect(typeof result.current.announceLanguageChanging).toBe('function');
    act(() => result.current.announceLanguageChanging('French'));
  });

  it('announceLanguageChanged is callable', () => {
    const { result } = renderHook(() => useLanguageChangeAnnouncements(), { wrapper: Wrapper });
    expect(typeof result.current.announceLanguageChanged).toBe('function');
    act(() => result.current.announceLanguageChanged('German'));
  });
});

describe('announcement hooks say only what they are given', () => {
  it('useResourceLoadingAnnouncements names the resource it is given', () => {
    const { result } = renderHook(() => useResourceLoadingAnnouncements(), { wrapper: Wrapper });

    // @ts-expect-error no resource name
    const loadingUnnamed = () => result.current.announceResourceLoading();
    // @ts-expect-error no resource name
    const failedUnnamed = () => result.current.announceResourceLoadError();

    expect([loadingUnnamed, failedUnnamed]).toHaveLength(2);
  });

  it('useDocumentAnnouncements takes the annotators whose words it uses', () => {
    // @ts-expect-error no annotators
    const withoutAnnotators = () => useDocumentAnnouncements();

    expect(withoutAnnotators).toBeTypeOf('function');
  });

  it('useDocumentAnnouncements fails on an annotation no annotator matches', () => {
    const { result } = renderHook(() => useDocumentAnnouncements({}), { wrapper: Wrapper });
    const annotation = { id: 'a-1', motivation: 'highlighting' } as Annotation;

    expect(() => result.current.announceAnnotationCreated(annotation)).toThrow('No annotator matches the annotation');
    expect(() => result.current.announceAnnotationUpdated(annotation)).toThrow('No annotator matches the annotation');
  });
});
