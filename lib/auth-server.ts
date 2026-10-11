import { cookies } from 'next/headers';
import { verifySessionToken } from './crypto-auth';
import { getAdminUserById, AdminUser } from './db';

export const ADMIN_COOKIE_NAME = 'admin_session';

/**
 * Recupera l'utente amministratore o operatore attualmente autenticato dai cookie HTTP-Only.
 * Verifica la firma crittografica HMAC e controlla che l'account sia ancora attivo sul DB.
 */
export async function getCurrentAdminUser(): Promise<AdminUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
    if (!token) return null;

    const payload = verifySessionToken(token);
    if (!payload) return null;

    const user = getAdminUserById(payload.id);
    if (!user || !user.is_active) return null;

    return user;
  } catch (err) {
    console.error('[auth-server] Errore verifica sessione:', err);
    return null;
  }
}
