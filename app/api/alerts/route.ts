import { NextRequest, NextResponse } from 'next/server';
import { getRecentAlerts, getActiveBreaches } from '@/lib/db';
import { verifyAdminApiKey, applySecurityHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

// GET: storico allerte inviate + violazioni sonore attualmente in corso
export async function GET(request: NextRequest) {
  if (!verifyAdminApiKey(request)) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Accesso negato: autenticazione amministratore richiesta' },
        { status: 403 }
      )
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 500);

  try {
    const alerts = getRecentAlerts(limit);
    const activeBreaches = getActiveBreaches();
    return applySecurityHeaders(
      NextResponse.json({
        count: alerts.length,
        active_breaches: activeBreaches,
        alerts,
      })
    );
  } catch (error: any) {
    return applySecurityHeaders(NextResponse.json({ error: error.message }, { status: 500 }));
  }
}
