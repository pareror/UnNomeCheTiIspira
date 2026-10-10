import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminUser } from '@/lib/auth-server';
import { listBotAuthKeys, createBotAuthKey, revokeBotAuthKey, getSubscriberStats } from '@/lib/db';
import { geocodeAddressTurin } from '@/lib/geo';

export async function GET() {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  const keys = listBotAuthKeys();
  const subscriberStats = getSubscriberStats();

  return NextResponse.json({
    success: true,
    keys,
    stats: subscriberStats,
  });
}

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { business_name, address, alert_radius_meters } = body;

    if (!business_name || typeof business_name !== 'string' || business_name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Nome attività mancante o non valido.' },
        { status: 400 }
      );
    }

    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      return NextResponse.json(
        { error: 'Indirizzo della sede torinese obbligatorio (es. Via Po 14, Piazza Santa Giulia 2...)' },
        { status: 400 }
      );
    }

    const radius = Number(alert_radius_meters) || 150;

    // Geocodifica automatica della via e civico a Torino
    const geocoded = await geocodeAddressTurin(address.trim());
    const finalAddress = geocoded?.formattedAddress || `${address.trim()}, Torino`;
    const lat = geocoded?.latitude ?? null;
    const lon = geocoded?.longitude ?? null;

    const newKey = createBotAuthKey({
      businessName: business_name.trim(),
      address: finalAddress,
      latitude: lat,
      longitude: lon,
      alertRadiusMeters: radius,
      createdBy: admin.username,
    });

    return NextResponse.json({
      success: true,
      key: newKey,
      message: `Chiave monouso generata con successo per ${business_name.trim()} con sede a ${finalAddress}.`,
    });
  } catch (err: any) {
    console.error('[API /admin/bot-keys POST] Errore:', err);
    return NextResponse.json(
      { error: 'Impossibile generare la chiave monouso.' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { auth_key } = body;

    if (!auth_key || typeof auth_key !== 'string') {
      return NextResponse.json(
        { error: 'Chiave non specificata.' },
        { status: 400 }
      );
    }

    const success = revokeBotAuthKey(auth_key.trim());
    if (!success) {
      return NextResponse.json(
        { error: 'Chiave non trovata o già revocata.' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Chiave revocata con successo. L\'utenza Telegram associata è stata disconnessa.',
    });
  } catch (err: any) {
    console.error('[API /admin/bot-keys DELETE] Errore:', err);
    return NextResponse.json(
      { error: 'Errore durante la revoca della chiave.' },
      { status: 500 }
    );
  }
}
