'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  KeyRound,
  Users,
  LogOut,
  PlusCircle,
  Copy,
  Check,
  Trash2,
  AlertTriangle,
  RefreshCw,
  Search,
  ExternalLink,
  MapPin,
  CheckCircle2,
  XCircle,
  Radio,
  Clock,
} from 'lucide-react';

interface BotKeyItem {
  auth_key: string;
  business_name: string | null;
  description: string | null;
  is_active: number;
  is_used: number;
  used_by_chat_id: string | null;
  used_at: number | null;
  created_by: string | null;
  revoked_at: number | null;
  created_at: string;
}

interface CurrentUser {
  id: number;
  username: string;
  role: 'superadmin' | 'operator';
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [keys, setKeys] = useState<BotKeyItem[]>([]);
  const [stats, setStats] = useState<{ total: number; active: number; authenticated: number }>({
    total: 0,
    active: 0,
    authenticated: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newBusinessName, setNewBusinessName] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [justGeneratedKey, setJustGeneratedKey] = useState<BotKeyItem | null>(null);

  // Verifica sessione e carica chiavi
  const loadData = async () => {
    try {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) {
        router.push('/admin/login');
        return;
      }
      const authData = await authRes.json();
      setCurrentUser(authData.user);

      const keysRes = await fetch('/api/admin/bot-keys');
      if (keysRes.ok) {
        const keysData = await keysRes.json();
        setKeys(keysData.keys || []);
        if (keysData.stats) {
          setStats(keysData.stats);
        }
      }
    } catch (err) {
      console.error('Errore caricamento dati admin:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/admin/login');
    router.refresh();
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBusinessName.trim()) return;

    setIsGenerating(true);
    setActionMessage(null);

    try {
      const res = await fetch('/api/admin/bot-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_name: newBusinessName.trim() }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionMessage({ type: 'error', text: data.error || 'Errore nella creazione della chiave.' });
      } else {
        setNewBusinessName('');
        setJustGeneratedKey(data.key);
        setActionMessage({
          type: 'success',
          text: `Nuova chiave monouso generata con successo per "${data.key.business_name}".`,
        });
        await loadData();
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: 'Errore di connessione durante la generazione.' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRevokeKey = async (authKey: string, businessName: string | null) => {
    const confirmRevoke = window.confirm(
      `Confermi la revoca permanente della chiave "${authKey}" (${businessName || 'Attività'})?\n\nL'utenza Telegram collegata verrà disconnessa immediatamente dal servizio allerte.`
    );
    if (!confirmRevoke) return;

    try {
      const res = await fetch('/api/admin/bot-keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_key: authKey }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: `Chiave "${authKey}" revocata con successo.` });
        await loadData();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Impossibile revocare la chiave.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore durante la revoca della chiave.' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const filteredKeys = keys.filter((k) => {
    const q = searchFilter.toLowerCase();
    return (
      (k.business_name && k.business_name.toLowerCase().includes(q)) ||
      k.auth_key.toLowerCase().includes(q) ||
      (k.created_by && k.created_by.toLowerCase().includes(q))
    );
  });

  const totalGenerated = keys.length;
  const availableKeys = keys.filter((k) => k.is_active === 1 && k.is_used === 0).length;
  const usedKeys = keys.filter((k) => k.is_active === 1 && k.is_used === 1).length;
  const revokedKeys = keys.filter((k) => k.is_active === 0).length;

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <RefreshCw className="animate-spin" size={24} color="#38bdf8" />
          <span style={{ fontSize: '16px', fontWeight: 500 }}>Caricamento portale amministratore...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        overflowY: 'auto',
        backgroundColor: '#0b1329',
        color: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Top Navbar */}
      <header
        style={{
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          padding: '14px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(2, 132, 199, 0.3)',
            }}
          >
            <ShieldCheck size={22} color="#ffffff" />
          </div>
          <div>
            <div style={{ fontSize: '17px', fontWeight: 700, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              Torino Noise Monitor
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  backgroundColor: 'rgba(56, 189, 248, 0.15)',
                  color: '#38bdf8',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                Pannello Amministrazione
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
              Gestione chiavi autorizzazione bot Telegram & sicurezza
            </div>
          </div>
        </div>

        {/* User Pill & Nav Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Navigation Links */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#1e293b',
              padding: '4px',
              borderRadius: '8px',
              border: '1px solid #334155',
            }}
          >
            <a
              href="/admin"
              id="nav-bot-keys-link"
              style={{
                backgroundColor: '#0284c7',
                color: '#ffffff',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <KeyRound size={15} /> Chiavi Bot
            </a>
            <a
              href="/admin/users"
              id="nav-users-management-link"
              style={{
                color: '#94a3b8',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'color 0.2s',
              }}
            >
              <Users size={15} /> Gestione Utenze {currentUser?.role === 'superadmin' ? '🛡️' : ''}
            </a>
          </div>

          <a
            href="/"
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              color: '#cbd5e1',
              padding: '8px 14px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 500,
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <MapPin size={15} /> Mappa Live
          </a>

          {/* User info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              padding: '6px 12px',
              borderRadius: '8px',
            }}
          >
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>
                {currentUser?.username}
              </div>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: currentUser?.role === 'superadmin' ? '#34d399' : '#38bdf8',
                }}
              >
                {currentUser?.role === 'superadmin' ? 'Amministratore' : 'Operatore'}
              </div>
            </div>
          </div>

          {/* Logout Button */}
          <button
            id="admin-logout-button"
            onClick={handleLogout}
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              padding: '8px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <LogOut size={16} /> Esci
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main style={{ maxWidth: '1280px', margin: '0 auto', padding: '28px 24px' }}>
        {/* Banner di notifica */}
        {actionMessage && (
          <div
            id="admin-action-banner"
            style={{
              backgroundColor: actionMessage.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              border: `1px solid ${actionMessage.type === 'success' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
              borderRadius: '10px',
              padding: '12px 18px',
              marginBottom: '24px',
              color: actionMessage.type === 'success' ? '#86efac' : '#fca5a5',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {actionMessage.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              <span>{actionMessage.text}</span>
            </div>
            <button
              onClick={() => setActionMessage(null)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '16px' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Modal/Banner Chiave appena creata */}
        {justGeneratedKey && (
          <div
            id="just-generated-key-box"
            style={{
              backgroundColor: 'rgba(2, 132, 199, 0.15)',
              border: '2px solid #0284c7',
              borderRadius: '12px',
              padding: '20px 24px',
              marginBottom: '28px',
              boxShadow: '0 8px 30px rgba(2, 132, 199, 0.25)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8', fontWeight: 700, fontSize: '15px' }}>
                <KeyRound size={20} /> CHIAVE MONOUSO GENERATA PER: &quot;{justGeneratedKey.business_name}&quot;
              </div>
              <button
                onClick={() => setJustGeneratedKey(null)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }}
              >
                Chiudi ✕
              </button>
            </div>

            <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#cbd5e1' }}>
              Fornisci questa chiave all&apos;attività commerciale. <b>La chiave può essere usata una sola volta</b>: una volta inserita nel bot Telegram, la chat verrà vincolata definitivamente e la chiave non potrà essere riutilizzata da nessun altro.
            </p>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '8px',
                padding: '12px 16px',
              }}
            >
              <code style={{ fontSize: '20px', fontWeight: 800, color: '#38bdf8', letterSpacing: '1px', flex: 1 }}>
                {justGeneratedKey.auth_key}
              </code>
              <button
                id="copy-just-generated-key"
                onClick={() => copyToClipboard(justGeneratedKey.auth_key)}
                style={{
                  backgroundColor: copiedKey === justGeneratedKey.auth_key ? '#16a34a' : '#0284c7',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {copiedKey === justGeneratedKey.auth_key ? <Check size={16} /> : <Copy size={16} />}
                {copiedKey === justGeneratedKey.auth_key ? 'Copiata!' : 'Copia Chiave'}
              </button>
            </div>

            <div style={{ marginTop: '10px', fontSize: '12px', color: '#94a3b8' }}>
              Istruzioni per l&apos;esercente: <i>Apri il bot @NoiseTurin_bot e digita: <code>/login {justGeneratedKey.auth_key}</code></i>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '16px',
            marginBottom: '28px',
          }}
        >
          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase' }}>
              Chiavi Generate Totali
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#f8fafc', marginTop: '6px' }}>
              {totalGenerated}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Registrate nel database
            </div>
          </div>

          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase' }}>
              Disponibili (Non ancora usate)
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#38bdf8', marginTop: '6px' }}>
              {availableKeys}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Pronte per l&apos;assegnazione
            </div>
          </div>

          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase' }}>
              Attive & Riscattate
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#34d399', marginTop: '6px' }}>
              {usedKeys}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Iscritti Telegram attivi: {stats.authenticated}
            </div>
          </div>

          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 500, textTransform: 'uppercase' }}>
              Chiavi Revocate
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#f87171', marginTop: '6px' }}>
              {revokedKeys}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Accesso revocato all&apos;attività
            </div>
          </div>
        </div>

        {/* Box Generazione Nuova Chiave */}
        <div
          style={{
            backgroundColor: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '14px',
            padding: '24px',
            marginBottom: '28px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <PlusCircle size={20} color="#38bdf8" />
            <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>
              Genera Nuova Chiave Monouso per Attività
            </h2>
          </div>
          <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 18px 0' }}>
            Crea una chiave univoca ad alta entropia per un esercizio commerciale o residente torinese. Ogni chiave può essere riscattata una sola volta nel bot Telegram.
          </p>

          <form onSubmit={handleCreateKey} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <input
              id="business-name-input"
              type="text"
              value={newBusinessName}
              onChange={(e) => setNewBusinessName(e.target.value)}
              placeholder="Nome Attività (es. Bar Santa Giulia, Pasticceria Baretti...)"
              disabled={isGenerating}
              required
              style={{
                flex: '1 1 340px',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '8px',
                padding: '12px 16px',
                color: '#f8fafc',
                fontSize: '14px',
                outline: 'none',
              }}
            />
            <button
              id="generate-key-submit-button"
              type="submit"
              disabled={isGenerating || !newBusinessName.trim()}
              style={{
                backgroundColor: '#0284c7',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                padding: '12px 22px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: isGenerating ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: '0 4px 14px rgba(2, 132, 199, 0.4)',
                opacity: isGenerating ? 0.7 : 1,
              }}
            >
              {isGenerating ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  <span>Generazione in corso...</span>
                </>
              ) : (
                <>
                  <KeyRound size={16} />
                  <span>Genera Chiave Monouso</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Tabella Chiavi */}
        <div
          style={{
            backgroundColor: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '14px',
            overflow: 'hidden',
          }}
        >
          {/* Header Tabella con Ricerca */}
          <div
            style={{
              padding: '18px 24px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
                Elenco Chiavi Autorizzazione Telegram ({filteredKeys.length})
              </h3>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0 0' }}>
                Monitoraggio dello stato di utilizzo e revoca immediata
              </p>
            </div>

            <div style={{ position: 'relative', width: '280px' }}>
              <Search
                size={16}
                color="#64748b"
                style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                id="search-keys-input"
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Cerca attività o chiave..."
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '8px 12px 8px 36px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: 'rgba(15, 23, 42, 0.6)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Attività Commerciale</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Chiave Monouso</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Stato</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Utenza Telegram Collegata</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Creata da</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Data Creazione</th>
                  <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filteredKeys.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '36px 20px', textAlign: 'center', color: '#94a3b8' }}>
                      Nessuna chiave trovata. Genera una nuova chiave sopra.
                    </td>
                  </tr>
                ) : (
                  filteredKeys.map((item) => {
                    const isRevoked = item.is_active === 0;
                    const isUsed = item.is_active === 1 && item.is_used === 1;
                    const isAvailable = item.is_active === 1 && item.is_used === 0;

                    return (
                      <tr
                        key={item.auth_key}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                          backgroundColor: isRevoked ? 'rgba(239, 68, 68, 0.03)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '14px 20px', fontWeight: 600, color: '#f8fafc' }}>
                          {item.business_name || item.description || 'Attività generica'}
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <code
                              style={{
                                backgroundColor: '#0f172a',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                color: isRevoked ? '#94a3b8' : '#38bdf8',
                                fontWeight: 700,
                                textDecoration: isRevoked ? 'line-through' : 'none',
                              }}
                            >
                              {item.auth_key}
                            </code>
                            <button
                              title="Copia Chiave"
                              onClick={() => copyToClipboard(item.auth_key)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: copiedKey === item.auth_key ? '#34d399' : '#64748b',
                                cursor: 'pointer',
                                padding: '2px',
                              }}
                            >
                              {copiedKey === item.auth_key ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </div>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          {isAvailable && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                                color: '#38bdf8',
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}
                            >
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#38bdf8' }} />
                              Disponibile (Monouso)
                            </span>
                          )}
                          {isUsed && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                                color: '#4ade80',
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}
                            >
                              <CheckCircle2 size={12} /> Utilizzata (Attiva)
                            </span>
                          )}
                          {isRevoked && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                                color: '#f87171',
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}
                            >
                              <XCircle size={12} /> Revocata
                            </span>
                          )}
                        </td>

                        <td style={{ padding: '14px 20px', color: '#cbd5e1' }}>
                          {item.used_by_chat_id ? (
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span>Chat ID: <code>{item.used_by_chat_id}</code></span>
                              {item.used_at && (
                                <span style={{ fontSize: '11px', color: '#64748b' }}>
                                  Attivata: {new Date(item.used_at).toLocaleDateString('it-IT')} {new Date(item.used_at).toLocaleTimeString('it-IT')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: '#64748b', fontStyle: 'italic' }}>Non ancora riscattata</span>
                          )}
                        </td>

                        <td style={{ padding: '14px 20px', color: '#94a3b8' }}>
                          {item.created_by || 'admin'}
                        </td>

                        <td style={{ padding: '14px 20px', color: '#94a3b8', fontSize: '12px' }}>
                          {item.created_at}
                        </td>

                        <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                          {!isRevoked ? (
                            <button
                              id={`revoke-btn-${item.auth_key}`}
                              onClick={() => handleRevokeKey(item.auth_key, item.business_name)}
                              style={{
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                color: '#f87171',
                                borderRadius: '6px',
                                padding: '6px 12px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <Trash2 size={13} /> Revoca
                            </button>
                          ) : (
                            <span style={{ color: '#64748b', fontSize: '12px' }}>Revocata</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
