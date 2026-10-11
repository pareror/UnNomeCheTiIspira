import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME } from '@/lib/auth-server';

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: ADMIN_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return NextResponse.json({ success: true, message: 'Disconnesso con successo.' });
}
