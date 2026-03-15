import { ModerationAuthWrapper } from '@/components/moderation/ModerationAuthWrapper';
import LinkedDataClient from './client';

export default function LinkedDataPage() {
  return (
    <ModerationAuthWrapper>
      <LinkedDataClient />
    </ModerationAuthWrapper>
  );
}
