import crypto from 'crypto';

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'torino-noise-ultra-secure-admin-secret-session-key-2026';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 ore di sessione attiva

export interface AdminUserPayload {
  id: number;
  username: string;
  role: 'superadmin' | 'operator';
}

/**
 * Genera l'hash crittografico di una password con salt casuale tramite Scrypt (NIST / OWASP standard).
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Verifica una password contro l'hash memorizzato in tempo costante (timing attack resistant).
 */
export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  try {
    const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Crea un token di sessione autenticato tramite HMAC SHA-256.
 */
export function createSessionToken(user: AdminUserPayload): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      username: user.username,
      role: user.role,
      exp: Date.now() + SESSION_TTL_MS,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Verifica un token di sessione e ne estrae il payload utente se valido e non scaduto.
 */
export function verifySessionToken(token: string): AdminUserPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  try {
    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) {
      return null; // Scaduto
    }

    return {
      id: data.id,
      username: data.username,
      role: data.role,
    };
  } catch {
    return null;
  }
}

/**
 * Genera una nuova chiave API monouso per Telegram leggibile e ad alta entropia.
 * Formato: TN-XXXX-XXXX-XXXX
 */
export function generateBotApiKey(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Esclusi caratteri ambigui (0, 1, I, O)
  const bytes = crypto.randomBytes(12);
  let res = 'TN-';
  for (let i = 0; i < 12; i++) {
    res += chars[bytes[i] % chars.length];
    if (i === 3 || i === 7) res += '-';
  }
  return res;
}
