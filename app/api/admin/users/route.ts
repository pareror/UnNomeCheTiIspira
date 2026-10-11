import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAdminUser } from '@/lib/auth-server';
import { listAdminUsers, createAdminUser, deactivateAdminUser, getAdminUserByUsername } from '@/lib/db';
import { hashPassword } from '@/lib/crypto-auth';

export async function GET() {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  // Solo l'amministratore principale (superadmin) ha accesso alla gestione utenze
  if (admin.role !== 'superadmin') {
    return NextResponse.json(
      { error: 'Accesso negato: solo l\'amministratore principale può visualizzare o gestire le utenze.' },
      { status: 403 }
    );
  }

  const users = listAdminUsers();
  return NextResponse.json({ success: true, users });
}

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  // Regola RBAC: solo il superadmin può generare nuove utenze
  if (admin.role !== 'superadmin') {
    return NextResponse.json(
      { error: 'Operazione non consentita: le utenze secondarie non possono generare altre utenze.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { username, password } = body;

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return NextResponse.json(
        { error: 'Username non valido (almeno 3 caratteri richiesti).' },
        { status: 400 }
      );
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return NextResponse.json(
        { error: 'Password troppo debole (almeno 6 caratteri richiesti).' },
        { status: 400 }
      );
    }

    const cleanUsername = username.trim().toLowerCase();
    const existing = getAdminUserByUsername(cleanUsername);
    if (existing) {
      return NextResponse.json(
        { error: `L'utenza "${cleanUsername}" esiste già.` },
        { status: 409 }
      );
    }

    const { hash, salt } = hashPassword(password);
    const newUser = createAdminUser(cleanUsername, hash, salt, 'operator', admin.username);

    return NextResponse.json({
      success: true,
      user: newUser,
      message: `Utenza operatore "${cleanUsername}" creata con successo.`,
    });
  } catch (err: any) {
    console.error('[API /admin/users POST] Errore:', err);
    return NextResponse.json(
      { error: 'Errore interno durante la creazione dell\'utenza.' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await getCurrentAdminUser();
  if (!admin) {
    return NextResponse.json({ error: 'Accesso non autorizzato. Effettua il login.' }, { status: 401 });
  }

  // Regola RBAC essenziale: le utenze create non possono revocare le altre utenze né il superadmin
  if (admin.role !== 'superadmin') {
    return NextResponse.json(
      { error: 'Operazione non consentita: solo l\'amministratore principale può revocare le utenze.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { user_id } = body;

    if (!user_id || typeof user_id !== 'number') {
      return NextResponse.json({ error: 'ID utente non valido.' }, { status: 400 });
    }

    const result = deactivateAdminUser(user_id, { id: admin.id, role: admin.role });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Impossibile revocare l\'utenza.' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Utenza operatore revocata con successo.',
    });
  } catch (err: any) {
    console.error('[API /admin/users DELETE] Errore:', err);
    return NextResponse.json(
      { error: 'Errore interno durante la revoca dell\'utenza.' },
      { status: 500 }
    );
  }
}
