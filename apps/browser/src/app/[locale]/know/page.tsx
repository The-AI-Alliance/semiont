import { useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { useSemiont, useObservable } from '@semiont/react-ui';

/**
 * The /know landing route: resume where the user left off in the ACTIVE
 * knowledge base, or send them to discover.
 *
 * "Where was I" is per-KB state, read from `lastViewedResource$` — a
 * projection of the active, connected KB. A global record would redirect
 * into the PREVIOUSLY active KB's resource after a switch: an id the new
 * gateway has never heard of, so a guaranteed 404.
 * See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md
 */
export default function KnowledgePage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Sidebar.${k}`, p as any) as string;
  const router = useRouter();
  const semiont = useSemiont();

  const session = useObservable(semiont.activeSession$) ?? null;
  const activating = useObservable(semiont.sessionActivating$) ?? false;
  const lastViewed = useObservable(semiont.lastViewedResource$) ?? null;

  // The projection only carries an answer once a session exists, so a
  // redirect decided during activation would send every cold load to
  // discover no matter where the user actually was. Wait for a session, or
  // for activation to conclude without one (nothing connected → discover).
  const resolved = session !== null || !activating;

  const redirected = useRef(false);
  useEffect(() => {
    if (!resolved || redirected.current) return;
    redirected.current = true;
    router.replace(
      lastViewed ? `/know/resource/${encodeURIComponent(lastViewed)}` : '/know/discover',
    );
  }, [resolved, lastViewed, router]);

  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">{t(resolved ? 'redirecting' : 'loading')}</p>
    </div>
  );
}
