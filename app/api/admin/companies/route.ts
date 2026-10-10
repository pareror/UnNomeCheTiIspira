import { NextRequest, NextResponse } from 'next/server';
import { listCompanies, upsertCompany } from '@/lib/db';
import { verifyAdminApiKey, CompanyRegistrationSchema, applySecurityHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

// GET: elenco degli esercizi registrati (destinatari delle allerte)
export async function GET(request: NextRequest) {
  if (!verifyAdminApiKey(request)) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Accesso negato: autenticazione amministratore richiesta' },
        { status: 403 }
      )
    );
  }

  try {
    const companies = listCompanies().map((c) => ({
      ...c,
      telegram_linked: Boolean(c.telegram_chat_id),
      telegram_chat_id: c.telegram_chat_id ? String(c.telegram_chat_id) : null,
    }));
    return applySecurityHeaders(NextResponse.json({ count: companies.length, companies }));
  } catch (error: any) {
    return applySecurityHeaders(NextResponse.json({ error: error.message }, { status: 500 }));
  }
}

// POST: crea o aggiorna un esercizio. Il collegamento Telegram avviene con /start <slug>.
export async function POST(request: NextRequest) {
  if (!verifyAdminApiKey(request)) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Accesso negato: autenticazione amministratore richiesta' },
        { status: 403 }
      )
    );
  }

  let rawBody: any;
  try {
    rawBody = await request.json();
  } catch {
    return applySecurityHeaders(
      NextResponse.json({ error: 'Corpo JSON mancante o non valido' }, { status: 400 })
    );
  }

  const validation = CompanyRegistrationSchema.safeParse(rawBody);
  if (!validation.success) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Dati esercizio non conformi', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    );
  }

  try {
    const company = upsertCompany(validation.data);
    return applySecurityHeaders(
      NextResponse.json(
        {
          success: true,
          message:
            'Esercizio registrato. L\'esercente dovrà inviare /start ' +
            `${company.slug} al bot Telegram per collegare la propria chat.`,
          company,
        },
        { status: 201 }
      )
    );
  } catch (error: any) {
    return applySecurityHeaders(NextResponse.json({ error: error.message }, { status: 500 }));
  }
}
