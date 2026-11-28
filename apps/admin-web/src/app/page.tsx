import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function HomePage() {
  const session = await getSession();

  if (!session) {
    redirect('/login');
  }

  if (session.account.isPlatformAdmin) {
    redirect('/platform');
  }

  if (session.tenant) {
    redirect(`/t/${session.tenant}`);
  }

  redirect('/login');
}
