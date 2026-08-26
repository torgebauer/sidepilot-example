import { auth } from '@lib/stores';
import { PUBLIC_SIDEPILOT_URL } from '@constants/configs';

export async function checkSidepilotAccess(): Promise<boolean> {
  try {
    const token = await auth.getToken();
    if (!token || typeof token !== 'string') return false;
    const res = await fetch(`${PUBLIC_SIDEPILOT_URL}/access/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { allowed?: unknown };
    return body?.allowed === true;
  } catch {
    return false;
  }
}
