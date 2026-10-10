import { NextRequest, NextResponse } from 'next/server';
import { handleTelegramUpdate } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

// Endpoint ricevuto da Telegram (setWebhook). Gestisce i comandi /start, /stop, /status.
export async function POST(request: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const providedSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (providedSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Firma webhook non valida' }, { status: 401 });
    }
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: 'Update non valido' }, { status: 400 });
  }

  try {
    await handleTelegramUpdate(update);
  } catch (error: any) {
    // Telegram ritenta sugli errori 5xx: logghiamo e rispondiamo comunque 200 per non generare loop.
    console.error('[telegram-webhook] Errore nella gestione dell\'update:', error?.message || error);
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    endpoint: 'POST /api/telegram/webhook',
    usage: 'Registra questo URL con setWebhook. Comandi: /start <slug>, /status, /stop',
  });
}
