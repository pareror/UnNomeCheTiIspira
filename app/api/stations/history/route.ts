import { NextRequest, NextResponse } from 'next/server';
import { getStationHistory, getAllStations } from '@/lib/db';
import { verifyAdminApiKey, applySecurityHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Protezione endpoint storico: riservato al backend/amministratore
  if (!verifyAdminApiKey(request)) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Accesso negato allo storico dati: autenticazione amministratore richiesta' },
        { status: 403 }
      )
    );
  }

  const { searchParams } = new URL(request.url);
  const stationId = searchParams.get('station_id');
  const limit = Math.min(Number(searchParams.get('limit')) || 100, 1000);

  if (!stationId) {
    const all = getAllStations();
    return applySecurityHeaders(
      NextResponse.json({
        message: 'Specificare ?station_id=<id> per visualizzare lo storico della stazione',
        available_stations: all.map(s => s.id),
      })
    );
  }

  try {
    const history = getStationHistory(stationId, limit);
    return applySecurityHeaders(
      NextResponse.json({
        station_id: stationId,
        count: history.length,
        history,
      })
    );
  } catch (error: any) {
    return applySecurityHeaders(
      NextResponse.json({ error: error.message }, { status: 500 })
    );
  }
}
