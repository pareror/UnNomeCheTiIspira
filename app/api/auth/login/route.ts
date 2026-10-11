import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAdminUserByUsername, updateAdminLastLogin } from '@/lib/db';
import { verifyPassword, createSessionToken } from '@/lib/crypto-auth';
import { ADMIN_COOKIE_NAME } from '@/lib/auth-server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password } = body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Credenziali non valide. Inserisci username e password.' },
        { status: 400 }
      );
    }

    const user = getAdminUserByUsername(username.trim());
    if (!user || !user.is_active) {
      return NextResponse.json(
        { success: false, error: 'Credenziali non corrette o account disattivato.' },
        { status: 401 }
      );
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: 'Credenziali non corrette o account disattivato.' },
        { status: 401 }
      );
    }

    // Aggiorna timestamp ultimo login
    updateAdminLastLogin(user.id);

    // Genera token di sessione firmato HMAC SHA-256
    const token = createSessionToken({
      id: user.id,
      username: user.username,
      role: user.role,
    });

    const cookieStore = await cookies();
    cookieStore.set({
      name: ADMIN_COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 60 * 60, // 8 ore
    });

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err: any) {
    console.error('[API /auth/login] Errore:', err);
    return NextResponse.json(
      { success: false, error: 'Errore interno del server durante il login.' },
      { status: 500 }
    );
  }
}
