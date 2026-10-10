import { NextRequest, NextResponse } from 'next/server';
import { getStationsLive } from '@/lib/db';
import { NOISE_RADIUS_METERS } from '@/lib/constants';
import { applySecurityHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filterParam = searchParams.get('filter'); // 'live_only' | 'all' | 'dummy_only'
    const showDummyParam = searchParams.get('show_dummy');

    let mode: 'all' | 'live_only' | 'dummy_only' = 'all';
    if (filterParam === 'live_only' || showDummyParam === 'false') {
      mode = 'live_only';
    } else if (filterParam === 'dummy_only') {
      mode = 'dummy_only';
    }

    const stations = getStationsLive(mode);

    const responseData = {
      timestamp: Date.now(),
      filter_mode: mode,
      fixed_radius_meters: NOISE_RADIUS_METERS,
      count: stations.length,
      stations: stations.map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
        is_dummy: Boolean(s.is_dummy),
        current_intensity: s.current_intensity ?? 0,
        last_reading_time: s.last_reading_time,
        radius_meters: NOISE_RADIUS_METERS,
      })),
    };

    return applySecurityHeaders(NextResponse.json(responseData));
  } catch (error: any) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Impossibile recuperare lo stato delle stazioni', details: error.message },
        { status: 500 }
      )
    );
  }
}
