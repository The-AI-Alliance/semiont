/**
 * The SearchModal suites' shared harness: a browser whose one session's
 * client answers `match.resources` from results the test gives, and the
 * strings the modal is given.
 *
 * The browser is ONE object for a whole file. `useSemiont` is called on every
 * render, and a browser made per render would restart the modal's search
 * pipeline on every keystroke. A suite mocks `useSemiont` to return
 * `searchBrowser`.
 */
import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { BehaviorSubject, map } from 'rxjs';
import { asStates } from '../../../__tests__/test-client';

const matched = new BehaviorSubject<unknown[] | undefined>(undefined);

/** The client's `match.resources`: every call follows the results the test gives. */
export const matchResourcesMock = vi.fn((_search: string, _filters?: { limit?: number }) => asStates(matched.asObservable().pipe(
  // Arrays get the search envelope `match.resources()` emits; `undefined`
  // passes through as the pending state.
  map((v) => (Array.isArray(v) ? { resources: v, total: v.length, offset: 0, limit: 20, matchKind: 'lexical' } : v)),
)));

export const searchBrowser = {
  activeSession$: new BehaviorSubject({ client: { match: { resources: matchResourcesMock } } }),
};

/** Answer the search under way with these resources; `undefined` is one not yet answered. */
export function setBrowseResults(resources: unknown[] | undefined): void {
  act(() => {
    matched.next(resources);
  });
}

/** No search answered and no call made: the results and the mock are the file's, not one test's. */
export function resetSearch(): void {
  matched.next(undefined);
  matchResourcesMock.mockClear();
}

export const buildResource = (id: string, name: string, content?: string) => ({
  '@context': 'https://www.w3.org/ns/anno.jsonld',
  '@id': id,
  name,
  content,
  representations: [{ mediaType: 'text/plain', isPrimary: true }],
});

export const searchTranslations = {
  title: 'Search',
  placeholder: 'Search resources, entities...',
  searching: 'Searching...',
  noResults: 'No results found for',
  startTyping: 'Start typing to search...',
  navigate: 'Navigate',
  select: 'Select',
  close: 'Close',
  enter: 'Enter',
  esc: 'ESC',
};
