import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SemiontBranding, buttonStyles, useSemiont, useObservable } from '@semiont/react-ui';
import { useRouter } from '@/i18n/routing';

const AUTO_TRANSITION_MS = 5000;

export default function Home() {
  const { t: _t } = useTranslation();
  const t = (k: string) => _t(`Home.${k}`) as string;
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);

  // The splash is the FIRST-CONTACT screen, not a toll booth. Every exit goes
  // to /know — never /know/discover — because /know owns "where was I": it
  // resumes the active KB's last-viewed resource and falls back to discover.
  // Pushing discover directly bypassed that resume, so a returning reader
  // always lost their place.
  const goToWorkspace = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    router.push('/know');
  };

  // A live session skips the ceremony entirely: replace, not push, so the
  // splash never sits in history for the back button to resurrect. Arriving
  // mid-activation is covered twice over — the moment the session lands this
  // fires, and if the timer beats it, /know's gate already waits out
  // activation before resuming (its own pinned behavior).
  useEffect(() => {
    if (!session) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    router.replace('/know');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    timerRef.current = setTimeout(goToWorkspace, AUTO_TRANSITION_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main
      role="main"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: '2rem',
      }}
    >
      <SemiontBranding t={t} size="xl" animated={true} />
      <button onClick={goToWorkspace} className={buttonStyles.primary.base}>
        {t('begin')}
      </button>
    </main>
  );
}
