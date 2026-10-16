/**
 * Every page `lighthouserc.json` audits is a page `App` serves, in a locale it
 * serves. The audit loads the build as a single-page app, so a path no route
 * matches still loads — as the not-found page or the language picker — and
 * Lighthouse would score that page in its place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement, ReactNode } from 'react';
import { createRoutesFromElements, matchRoutes } from 'react-router';
import { isSupportedLocale } from '../i18n/config';
import App from '../App';

const lighthouse = JSON.parse(readFileSync(resolve(process.cwd(), 'lighthouserc.json'), 'utf8')) as {
  ci: { collect: { url: string[] } };
};

/** `App` is a hook-free function of its route table, so calling it yields that table. */
function routeTable() {
  const suspense = App() as ReactElement<{ children: ReactElement<{ children: ReactNode }> }>;
  return createRoutesFromElements(suspense.props.children.props.children);
}

describe('the pages Lighthouse audits', () => {
  it('names at least one page', () => {
    expect(lighthouse.ci.collect.url.length).toBeGreaterThan(0);
  });

  it.each(lighthouse.ci.collect.url)('%s is a page App serves', (url) => {
    const matches = matchRoutes(routeTable(), new URL(url).pathname);
    if (!matches) throw new Error(`no route of App matches ${url}`);
    const locale = matches[0]?.params.locale;
    if (!locale) throw new Error(`${url} names no locale`);

    expect(matches.at(-1)?.route.path).not.toBe('*');
    expect(isSupportedLocale(locale)).toBe(true);
  });
});
