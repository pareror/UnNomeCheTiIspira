import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminUser } from '@/lib/auth-server';
import { 
  listStationsAdmin, 
  createStation, 
  updateStation, 
  deleteStation, 
  getStationById 
} from '@/lib/db';
import { geocodeAddressTurin } from '@/lib/geo';

export async function GET() {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  const stations = listStationsAdmin();
  return NextResponse.json({
    success: true,
    stations,
  });
}

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    let { id, name, latitude, longitude, address, is_dummy } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Nome della stazione obbligatorio.' }, { status: 400 });
    }

    // Se l'id non è specificato, genera uno slug sicuro
    let stationId = (id || '').trim();
    if (!stationId) {
      const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      stationId = `ard-${slug || Date.now()}`;
    }

    // Verifica se l'ID esiste già
    const existing = getStationById(stationId);
    if (existing) {
      return NextResponse.json({ error: `Una stazione con ID "${stationId}" esiste già nel database.` }, { status: 400 });
    }

    // Se mancano coordinate ma c'è un indirizzo, effettua geocodifica su Torino
    if ((latitude == null || longitude == null || isNaN(Number(latitude)) || isNaN(Number(longitude))) && address) {
      const geo = await geocodeAddressTurin(address.trim());
      if (geo) {
        latitude = geo.latitude;
        longitude = geo.longitude;
      }
    }

    const latNum = Number(latitude);
    const lngNum = Number(longitude);

    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return NextResponse.json(
        { error: 'Coordinate geografiche non valide. Inserisci latitudine (es: 45.0705) e longitudine (es: 7.6868).' },
        { status: 400 }
      );
    }

    const newStation = createStation({
      id: stationId,
      name: name.trim(),
      latitude: latNum,
      longitude: lngNum,
      is_dummy: Boolean(is_dummy),
    });

    return NextResponse.json({
      success: true,
      message: `Stazione "${newStation.name}" registrata con successo.`,
      station: newStation,
    });
  } catch (err: any) {
    console.error('[API Stations POST Error]:', err);
    return NextResponse.json({ error: err.message || 'Errore durante la creazione della stazione.' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { id, name, latitude, longitude, is_dummy } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'ID stazione obbligatorio per la modifica.' }, { status: 400 });
    }

    const existing = getStationById(id.trim());
    if (!existing) {
      return NextResponse.json({ error: 'Stazione non trovata.' }, { status: 404 });
    }

    const updates: {
      name?: string;
      latitude?: number;
      longitude?: number;
      is_dummy?: boolean;
    } = {};

    if (name !== undefined) updates.name = String(name).trim();
    if (latitude !== undefined) {
      const latNum = Number(latitude);
      if (isNaN(latNum) || latNum < -90 || latNum > 90) {
        return NextResponse.json({ error: 'Latitudine non valida.' }, { status: 400 });
      }
      updates.latitude = latNum;
    }
    if (longitude !== undefined) {
      const lngNum = Number(longitude);
      if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        return NextResponse.json({ error: 'Longitudine non valida.' }, { status: 400 });
      }
      updates.longitude = lngNum;
    }
    if (is_dummy !== undefined) updates.is_dummy = Boolean(is_dummy);

    const updated = updateStation(id.trim(), updates);

    return NextResponse.json({
      success: true,
      message: `Stazione "${id}" aggiornata con successo.`,
      station: updated,
    });
  } catch (err: any) {
    console.error('[API Stations PUT Error]:', err);
    return NextResponse.json({ error: err.message || 'Errore durante l\'aggiornamento della stazione.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  try {
    let stationId: string | null = null;
    try {
      const body = await req.json();
      stationId = body.id;
    } catch {
      const url = new URL(req.url);
      stationId = url.searchParams.get('id');
    }

    if (!stationId) {
      return NextResponse.json({ error: 'ID stazione mancante per l\'eliminazione.' }, { status: 400 });
    }

    const deleted = deleteStation(stationId.trim());
    if (!deleted) {
      return NextResponse.json({ error: 'Stazione non trovata o impossibile da eliminare.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: `Stazione "${stationId}" eliminata con successo insieme ai relativi campionamenti.`,
    });
  } catch (err: any) {
    console.error('[API Stations DELETE Error]:', err);
    return NextResponse.json({ error: err.message || 'Errore durante l\'eliminazione della stazione.' }, { status: 500 });
  }
}
