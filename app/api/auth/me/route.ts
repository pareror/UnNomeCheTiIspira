import { NextResponse } from 'next/server';
import { getCurrentAdminUser } from '@/lib/auth-server';

export async function GET() {
  const user = await getCurrentAdminUser();

  if (!user) {
    return NextResponse.json(
      { authenticated: false, user: null },
      { status: 401 }
    );
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
    },
  });
}
