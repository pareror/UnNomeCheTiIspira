import { NextResponse } from 'next/server';
import { getStationsLive } from '@/lib/db';
import { NOISE_RADIUS_METERS } from '@/lib/constants';
import { applySecurityHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stations = getStationsLive();

    const responseData = {
      timestamp: Date.now(),
      fixed_radius_meters: NOISE_RADIUS_METERS,
      count: stations.length,
      stations: stations.map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
        current_intensity: s.current_intensity ?? 0,
        last_reading_time: s.last_reading_time,
        radius_meters: NOISE_RADIUS_METERS, // fornito come valore di sistema al client
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
