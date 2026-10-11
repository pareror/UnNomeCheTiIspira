'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  ShieldAlert,
  Users,
  KeyRound,
  Radio,
  UserPlus,
  Trash2,
  Lock,
  User,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  LogOut,
  MapPin,
  Clock,
  ShieldOff,
} from 'lucide-react';

interface AdminUserItem {
  id: number;
  username: string;
  role: 'superadmin' | 'operator';
  is_active: number;
  created_by: string | null;
  created_at: string;
  last_login_at: number | null;
}

interface CurrentUser {
  id: number;
  username: string;
  role: 'superadmin' | 'operator';
}

export default function AdminUsersManagementPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = async () => {
    try {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) {
        router.push('/admin/login');
        return;
      }
      const authData = await authRes.json();
      setCurrentUser(authData.user);

      // Se superadmin, carica la lista utenze
      if (authData.user.role === 'superadmin') {
        const usersRes = await fetch('/api/admin/users');
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          setUsers(usersData.users || []);
        }
      }
    } catch (err) {
      console.error('Errore caricamento utenze:', err);
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

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newPassword) return;

    setIsCreating(true);
    setActionMessage(null);

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionMessage({ type: 'error', text: data.error || 'Errore nella creazione dell\'utenza.' });
      } else {
        setNewUsername('');
        setNewPassword('');
        setActionMessage({
          type: 'success',
          text: `Utenza operatore "${data.user.username}" creata con successo.`,
        });
        await loadData();
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore di rete durante la creazione dell\'utenza.' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeactivateUser = async (userId: number, username: string) => {
    const confirmDeactivate = window.confirm(
      `Confermi la revoca permanente dell'utenza operatore "${username}"?\n\nL'operatore non potrà più accedere al pannello di amministrazione.`
    );
    if (!confirmDeactivate) return;

    try {
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: `Utenza "${username}" revocata con successo.` });
        await loadData();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Impossibile revocare l\'utenza.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore di rete durante la revoca dell\'utenza.' });
    }
  };

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
          <span style={{ fontSize: '16px', fontWeight: 500 }}>Verifica permessi RBAC in corso...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
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
                Gestione Utenze (RBAC)
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
              Controllo accessi e privilegi operatori di sistema
            </div>
          </div>
        </div>

        {/* User Pill & Nav Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#1e293b',
              padding: '4px',
              borderRadius: '8px',
              border: '1px solid #334155',
              gap: '4px',
            }}
          >
            <a
              href="/admin?tab=keys"
              id="back-to-bot-keys-link"
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
              <KeyRound size={15} /> Chiavi Bot
            </a>
            <a
              href="/admin?tab=stations"
              id="nav-to-stations-link"
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
              <Radio size={15} /> Stazioni Acustiche
            </a>
            <a
              href="/admin/users"
              id="active-users-link"
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
              <Users size={15} /> Gestione Utenze
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
                {currentUser?.role === 'superadmin' ? 'Superadmin' : 'Operatore'}
              </div>
            </div>
          </div>

          <button
            id="users-logout-button"
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

      {/* Main Content */}
      <main style={{ maxWidth: '1280px', margin: '0 auto', padding: '28px 24px 80px 24px' }}>
        {/* Caso OPERATORE: Accesso Negato con spiegazione trasparente */}
        {currentUser?.role !== 'superadmin' ? (
          <div
            id="operator-access-denied-view"
            style={{
              backgroundColor: 'rgba(30, 41, 59, 0.8)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '16px',
              padding: '48px 32px',
              textAlign: 'center',
              maxWidth: '680px',
              margin: '40px auto',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                margin: '0 auto 20px auto',
                borderRadius: '50%',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShieldAlert size={36} color="#f87171" />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 12px 0', color: '#f87171' }}>
              Accesso Riservato all&apos;Amministratore Principale
            </h2>
            <p style={{ fontSize: '14px', lineHeight: '1.6', color: '#cbd5e1', margin: '0 0 24px 0' }}>
              Sei attualmente autenticato con il ruolo di <b>Operatore ({currentUser?.username})</b>.
              In conformità con le policy di sicurezza di Torino Noise, <b>le utenze create non possono gestire, creare né revocare altre utenze o l&apos;utenza dell&apos;amministratore</b>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
              <a
                href="/admin?tab=keys"
                style={{
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  textDecoration: 'none',
                  fontSize: '14px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <KeyRound size={16} /> Torna a Gestione Chiavi Bot
              </a>
              <a
                href="/admin?tab=stations"
                style={{
                  backgroundColor: '#334155',
                  color: '#ffffff',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  textDecoration: 'none',
                  fontSize: '14px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <Radio size={16} /> Stazioni Acustiche
              </a>
            </div>
          </div>
        ) : (
          /* Caso SUPERADMIN: Interfaccia Completa Creazione & Revoca Utenze */
          <>
            {/* Banner Messaggi */}
            {actionMessage && (
              <div
                id="users-action-banner"
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

            {/* Box Creazione Nuovo Utente Operatore */}
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
                <UserPlus size={20} color="#38bdf8" />
                <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>
                  Genera Nuova Utenza Operatore
                </h2>
              </div>
              <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 18px 0' }}>
                Gli operatori creati possono accedere al portale per generare e revocare le chiavi Telegram per i locali, ma <b>non possono in alcun caso visualizzare o revocare le altre utenze né il tuo account amministratore</b>.
              </p>

              <form onSubmit={handleCreateUser} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: '1 1 240px' }}>
                  <User size={16} color="#64748b" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    id="new-username-input"
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="Username (es. operatore_centro)"
                    disabled={isCreating}
                    required
                    style={{
                      width: '100%',
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                      padding: '11px 14px 11px 36px',
                      color: '#f8fafc',
                      fontSize: '13px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div style={{ position: 'relative', flex: '1 1 240px' }}>
                  <Lock size={16} color="#64748b" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    id="new-password-input"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Password (min. 6 caratteri)"
                    disabled={isCreating}
                    required
                    style={{
                      width: '100%',
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                      padding: '11px 14px 11px 36px',
                      color: '#f8fafc',
                      fontSize: '13px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <button
                  id="create-operator-button"
                  type="submit"
                  disabled={isCreating || !newUsername.trim() || !newPassword}
                  style={{
                    backgroundColor: '#0284c7',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '11px 20px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: isCreating ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    boxShadow: '0 4px 14px rgba(2, 132, 199, 0.4)',
                    opacity: isCreating ? 0.7 : 1,
                  }}
                >
                  {isCreating ? (
                    <>
                      <RefreshCw size={15} className="animate-spin" />
                      <span>Creazione in corso...</span>
                    </>
                  ) : (
                    <>
                      <UserPlus size={15} />
                      <span>Crea Utenza Operatore</span>
                    </>
                  )}
                </button>
              </form>
            </div>

            {/* Tabella Utenze */}
            <div
              style={{
                backgroundColor: '#1e293b',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '14px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '18px 24px',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
                    Utenze Amministrative Registrate ({users.length})
                  </h3>
                  <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0 0' }}>
                    Controllo accessi RBAC: solo il Superadmin può revocare gli operatori
                  </p>
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ backgroundColor: 'rgba(15, 23, 42, 0.6)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Username</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Ruolo</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Stato</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Creato da</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Ultimo Accesso</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600 }}>Data Creazione</th>
                      <th style={{ padding: '14px 20px', color: '#94a3b8', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const isSuperadmin = u.role === 'superadmin';
                      const isSelf = u.id === currentUser?.id;
                      const isActive = u.is_active === 1;

                      return (
                        <tr
                          key={u.id}
                          style={{
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            backgroundColor: !isActive ? 'rgba(239, 68, 68, 0.03)' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '14px 20px', fontWeight: 600, color: '#f8fafc' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>{u.username}</span>
                              {isSelf && (
                                <span
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    backgroundColor: '#0284c7',
                                    color: '#ffffff',
                                    padding: '1px 6px',
                                    borderRadius: '10px',
                                  }}
                                >
                                  Tu
                                </span>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: '14px 20px' }}>
                            {isSuperadmin ? (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  backgroundColor: 'rgba(52, 211, 153, 0.15)',
                                  color: '#34d399',
                                  padding: '3px 8px',
                                  borderRadius: '12px',
                                  fontSize: '11px',
                                  fontWeight: 700,
                                }}
                              >
                                🛡️ Superadmin
                              </span>
                            ) : (
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
                                👤 Operatore
                              </span>
                            )}
                          </td>

                          <td style={{ padding: '14px 20px' }}>
                            {isActive ? (
                              <span style={{ color: '#4ade80', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <CheckCircle2 size={13} /> Attivo
                              </span>
                            ) : (
                              <span style={{ color: '#f87171', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <ShieldOff size={13} /> Revocato
                              </span>
                            )}
                          </td>

                          <td style={{ padding: '14px 20px', color: '#94a3b8' }}>
                            {u.created_by || 'system'}
                          </td>

                          <td style={{ padding: '14px 20px', color: '#cbd5e1', fontSize: '12px' }}>
                            {u.last_login_at ? (
                              new Date(u.last_login_at).toLocaleString('it-IT')
                            ) : (
                              <span style={{ color: '#64748b', fontStyle: 'italic' }}>Mai effettuato</span>
                            )}
                          </td>

                          <td style={{ padding: '14px 20px', color: '#94a3b8', fontSize: '12px' }}>
                            {u.created_at}
                          </td>

                          <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                            {isSuperadmin ? (
                              <span
                                style={{
                                  fontSize: '11px',
                                  color: '#64748b',
                                  fontStyle: 'italic',
                                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                  padding: '4px 8px',
                                  borderRadius: '6px',
                                }}
                              >
                                Protetto (Superadmin)
                              </span>
                            ) : isSelf ? (
                              <span
                                style={{
                                  fontSize: '11px',
                                  color: '#64748b',
                                  fontStyle: 'italic',
                                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                  padding: '4px 8px',
                                  borderRadius: '6px',
                                }}
                              >
                                Sessione Attiva
                              </span>
                            ) : isActive ? (
                              <button
                                id={`revoke-user-btn-${u.id}`}
                                onClick={() => handleDeactivateUser(u.id, u.username)}
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
                                <Trash2 size={13} /> Revoca Utenza
                              </button>
                            ) : (
                              <span style={{ color: '#64748b', fontSize: '12px' }}>Revocata</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
