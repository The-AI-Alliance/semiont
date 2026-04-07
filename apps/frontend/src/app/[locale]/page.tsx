import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SemiontBranding, buttonStyles } from '@semiont/react-ui';
import { useRouter } from '@/i18n/routing';

const AUTO_TRANSITION_MS = 5000;

export default function Home() {
  const { t: _t } = useTranslation();
  const t = (k: string) => _t(`Home.${k}`) as string;
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goToWorkspace = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    router.push('/know/discover');
  };

  useEffect(() => {
    timerRef.current = setTimeout(goToWorkspace, AUTO_TRANSITION_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
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
        {t('signIn')}
      </button>
    </main>
  );
}
