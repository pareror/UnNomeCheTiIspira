import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminUser } from '@/lib/auth-server';
import { listBotAuthKeys, createBotAuthKey, revokeBotAuthKey, getSubscriberStats } from '@/lib/db';

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
    const { business_name } = body;

    if (!business_name || typeof business_name !== 'string' || business_name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Nome attività mancante o non valido.' },
        { status: 400 }
      );
    }

    const newKey = createBotAuthKey(business_name.trim(), admin.username);

    return NextResponse.json({
      success: true,
      key: newKey,
      message: `Chiave monouso generata con successo per ${business_name.trim()}.`,
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
