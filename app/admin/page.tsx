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
  Edit2,
  Activity,
  Volume2,
  Save,
  X,
  Sliders,
} from 'lucide-react';

interface BotKeyItem {
  auth_key: string;
  business_name: string | null;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  alert_radius_meters: number;
  is_active: number;
  is_used: number;
  used_by_chat_id: string | null;
  used_at: number | null;
  created_by: string | null;
  revoked_at: number | null;
  created_at: string;
}

interface StationItem {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_dummy: number;
  created_at: string;
  readings_count: number;
  current_intensity: number | null;
  last_reading_time: number | null;
}

interface CurrentUser {
  id: number;
  username: string;
  role: 'superadmin' | 'operator';
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [activeTab, setActiveTab] = useState<'keys' | 'stations'>('keys');

  // Stato Chiavi Bot
  const [keys, setKeys] = useState<BotKeyItem[]>([]);
  const [stats, setStats] = useState<{ total: number; active: number; authenticated: number }>({
    total: 0,
    active: 0,
    authenticated: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newBusinessName, setNewBusinessName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newRadius, setNewRadius] = useState<number>(150);
  const [searchFilter, setSearchFilter] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [justGeneratedKey, setJustGeneratedKey] = useState<BotKeyItem | null>(null);

  // Stato Stazioni Acustiche
  const [stations, setStations] = useState<StationItem[]>([]);
  const [stationSearchFilter, setStationSearchFilter] = useState('');
  const [newStationId, setNewStationId] = useState('');
  const [newStationName, setNewStationName] = useState('');
  const [newStationAddress, setNewStationAddress] = useState('');
  const [newStationLat, setNewStationLat] = useState('45.0705');
  const [newStationLng, setNewStationLng] = useState('7.6868');
  const [newStationIsDummy, setNewStationIsDummy] = useState(false);
  const [isCreatingStation, setIsCreatingStation] = useState(false);
  const [isGeocodingStation, setIsGeocodingStation] = useState(false);

  // Modale Modifica Stazione
  const [editingStation, setEditingStation] = useState<StationItem | null>(null);
  const [editStationName, setEditStationName] = useState('');
  const [editStationLat, setEditStationLat] = useState('');
  const [editStationLng, setEditStationLng] = useState('');
  const [editStationIsDummy, setEditStationIsDummy] = useState(false);
  const [isSavingStationEdit, setIsSavingStationEdit] = useState(false);

  // Verifica sessione e carica chiavi + stazioni
  const loadData = async () => {
    try {
      const authRes = await fetch('/api/auth/me');
      if (!authRes.ok) {
        router.push('/admin/login');
        return;
      }
      const authData = await authRes.json();
      setCurrentUser(authData.user);

      const [keysRes, stationsRes] = await Promise.all([
        fetch('/api/admin/bot-keys'),
        fetch('/api/admin/stations'),
      ]);

      if (keysRes.ok) {
        const keysData = await keysRes.json();
        setKeys(keysData.keys || []);
        if (keysData.stats) {
          setStats(keysData.stats);
        }
      }

      if (stationsRes.ok) {
        const stationsData = await stationsRes.json();
        setStations(stationsData.stations || []);
      }
    } catch (err) {
      console.error('Errore caricamento dati admin:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTabChange = (tab: 'keys' | 'stations') => {
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      window.history.replaceState(null, '', url.toString());
    }
  };

  useEffect(() => {
    loadData();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam === 'stations' || tabParam === 'keys') {
        setActiveTab(tabParam);
      }
    }
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/admin/login');
    router.refresh();
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBusinessName.trim() || !newAddress.trim()) {
      setActionMessage({ type: 'error', text: 'Inserisci sia il nome dell\'attività sia la via/indirizzo a Torino.' });
      return;
    }

    setIsGenerating(true);
    setActionMessage(null);

    try {
      const res = await fetch('/api/admin/bot-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_name: newBusinessName.trim(),
          address: newAddress.trim(),
          alert_radius_meters: newRadius || 150,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionMessage({ type: 'error', text: data.error || 'Errore nella creazione della chiave.' });
      } else {
        setNewBusinessName('');
        setNewAddress('');
        setNewRadius(150);
        setJustGeneratedKey(data.key);
        setActionMessage({
          type: 'success',
          text: `Nuova chiave monouso generata con successo per "${data.key.business_name}" con sede in ${data.key.address || newAddress}.`,
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

  // Handlers CRUD Stazioni Acustiche
  const handleGeocodeStationAddress = async () => {
    if (!newStationAddress.trim()) {
      setActionMessage({ type: 'error', text: 'Inserisci un indirizzo o via a Torino per calcolare le coordinate.' });
      return;
    }
    setIsGeocodingStation(true);
    try {
      let query = newStationAddress.trim();
      if (!query.toLowerCase().includes('torino')) query += ', Torino, Italia';
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}&countrycodes=it`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data[0]) {
          const lat = parseFloat(data[0].lat).toFixed(5);
          const lon = parseFloat(data[0].lon).toFixed(5);
          setNewStationLat(lat);
          setNewStationLng(lon);
          setActionMessage({ type: 'success', text: `Coordinate individuate per "${newStationAddress}": Lat ${lat}° N, Lon ${lon}° E` });
          return;
        }
      }
      setActionMessage({ type: 'error', text: 'Impossibile individuare le coordinate per questo indirizzo. Inseriscile manualmente.' });
    } catch {
      setActionMessage({ type: 'error', text: 'Errore durante la geocodifica dell\'indirizzo.' });
    } finally {
      setIsGeocodingStation(false);
    }
  };

  const handleCreateStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStationName.trim()) {
      setActionMessage({ type: 'error', text: 'Inserisci il nome descrittivo della stazione acustica.' });
      return;
    }

    const latNum = parseFloat(newStationLat);
    const lngNum = parseFloat(newStationLng);
    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      setActionMessage({ type: 'error', text: 'Coordinate geografiche non valide (es: Lat 45.0705, Lon 7.6868).' });
      return;
    }

    setIsCreatingStation(true);
    setActionMessage(null);

    try {
      const res = await fetch('/api/admin/stations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newStationId.trim() || undefined,
          name: newStationName.trim(),
          address: newStationAddress.trim() || undefined,
          latitude: latNum,
          longitude: lngNum,
          is_dummy: newStationIsDummy,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionMessage({ type: 'error', text: data.error || 'Errore durante la registrazione della stazione.' });
      } else {
        setNewStationId('');
        setNewStationName('');
        setNewStationAddress('');
        setNewStationLat('45.0705');
        setNewStationLng('7.6868');
        setNewStationIsDummy(false);
        setActionMessage({
          type: 'success',
          text: `Stazione "${data.station.name}" (${data.station.id}) registrata con successo con coordinate fisse!`,
        });
        await loadData();
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore di connessione durante la creazione della stazione.' });
    } finally {
      setIsCreatingStation(false);
    }
  };

  const handleOpenEditStation = (st: StationItem) => {
    setEditingStation(st);
    setEditStationName(st.name);
    setEditStationLat(st.latitude.toString());
    setEditStationLng(st.longitude.toString());
    setEditStationIsDummy(st.is_dummy === 1);
  };

  const handleSaveStationEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStation) return;
    if (!editStationName.trim()) {
      setActionMessage({ type: 'error', text: 'Il nome della stazione è obbligatorio.' });
      return;
    }

    const latNum = parseFloat(editStationLat);
    const lngNum = parseFloat(editStationLng);
    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      setActionMessage({ type: 'error', text: 'Coordinate geografiche fisse non valide.' });
      return;
    }

    setIsSavingStationEdit(true);
    try {
      const res = await fetch('/api/admin/stations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingStation.id,
          name: editStationName.trim(),
          latitude: latNum,
          longitude: lngNum,
          is_dummy: editStationIsDummy,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionMessage({ type: 'error', text: data.error || 'Errore durante l\'aggiornamento della stazione.' });
      } else {
        setEditingStation(null);
        setActionMessage({ type: 'success', text: `Stazione "${editingStation.id}" aggiornata con successo con le nuove coordinate fisse!` });
        await loadData();
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore durante l\'aggiornamento della stazione.' });
    } finally {
      setIsSavingStationEdit(false);
    }
  };

  const handleDeleteStation = async (stationId: string, stationName: string) => {
    const ok = window.confirm(
      `Confermi l'eliminazione permanente della stazione "${stationName}" (${stationId})?\n\nQuesta operazione rimuoverà la stazione e tutti i campionamenti e violazioni associati.`
    );
    if (!ok) return;

    try {
      const res = await fetch('/api/admin/stations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stationId }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: `Stazione "${stationId}" eliminata con successo.` });
        await loadData();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Impossibile eliminare la stazione.' });
      }
    } catch {
      setActionMessage({ type: 'error', text: 'Errore di connessione durante l\'eliminazione della stazione.' });
    }
  };

  const copyToClipboard = async (text: string) => {
    let success = false;

    // 1. Prova API moderna Navigator Clipboard (funziona in secure contexts HTTPS o localhost)
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        success = true;
      } catch (clipErr) {
        console.warn('[Clipboard] navigator.clipboard.writeText fallito, uso fallback legacy:', clipErr);
      }
    }

    // 2. Fallback universale via textarea temporanea (funziona su HTTP, IP locale es. 192.168.x.x, Safari, WebView)
    if (!success && typeof document !== 'undefined') {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, text.length);
        success = document.execCommand('copy');
        document.body.removeChild(textArea);
      } catch (err) {
        console.error('[Clipboard] Fallback execCommand fallito:', err);
      }
    }

    if (success) {
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 2500);
    } else {
      // Fallback estremo se il browser blocca entrambi
      window.prompt('Copia manualmente con Ctrl+C / Cmd+C:', text);
    }
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

  const filteredStations = stations.filter((st) => {
    const q = stationSearchFilter.toLowerCase();
    return (
      st.name.toLowerCase().includes(q) ||
      st.id.toLowerCase().includes(q) ||
      st.latitude.toString().includes(q) ||
      st.longitude.toString().includes(q)
    );
  });

  const totalStations = stations.length;
  const realStationsCount = stations.filter((s) => s.is_dummy === 0).length;
  const dummyStationsCount = stations.filter((s) => s.is_dummy === 1).length;
  const totalReadingsCount = stations.reduce((acc, s) => acc + (s.readings_count || 0), 0);

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
              gap: '4px',
            }}
          >
            <button
              type="button"
              id="nav-bot-keys-tab"
              onClick={() => handleTabChange('keys')}
              style={{
                backgroundColor: activeTab === 'keys' ? '#0284c7' : 'transparent',
                color: activeTab === 'keys' ? '#ffffff' : '#94a3b8',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: activeTab === 'keys' ? 600 : 500,
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.15s ease',
              }}
            >
              <KeyRound size={15} /> Chiavi Bot ({keys.length})
            </button>
            <button
              type="button"
              id="nav-stations-tab"
              onClick={() => handleTabChange('stations')}
              style={{
                backgroundColor: activeTab === 'stations' ? '#0284c7' : 'transparent',
                color: activeTab === 'stations' ? '#ffffff' : '#94a3b8',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: activeTab === 'stations' ? 600 : 500,
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.15s ease',
              }}
            >
              <Radio size={15} /> Stazioni Acustiche ({stations.length})
            </button>
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
              <Users size={15} /> Utenze {currentUser?.role === 'superadmin' ? '🛡️' : ''}
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
      <main style={{ maxWidth: '1280px', margin: '0 auto', padding: '28px 24px 80px 24px' }}>
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

        {activeTab === 'keys' && (
          <>
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
              La sede e le coordinate geografiche sono <b>già registrate e certificate dall&apos;amministrazione</b>. L&apos;esercente non dovrà digitare alcuna via su Telegram: inserendo questa chiave monouso, il bot assocerà istantaneamente la chat alla sede pre-impostata.
            </p>

            <div
              style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '8px',
                padding: '14px 18px',
                marginBottom: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                <code
                  onClick={() => copyToClipboard(justGeneratedKey.auth_key)}
                  title="Clicca per copiare la chiave"
                  style={{ fontSize: '20px', fontWeight: 800, color: '#38bdf8', letterSpacing: '1px', cursor: 'pointer', userSelect: 'all' }}
                >
                  {justGeneratedKey.auth_key}
                </code>
                <button
                  type="button"
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
                    transition: 'background-color 0.2s ease',
                  }}
                >
                  {copiedKey === justGeneratedKey.auth_key ? <Check size={16} /> : <Copy size={16} />}
                  {copiedKey === justGeneratedKey.auth_key ? 'Copiata!' : 'Copia Chiave'}
                </button>
              </div>

              <div style={{ fontSize: '13px', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div>📍 <b>Sede Registrata:</b> {justGeneratedKey.address || 'Torino'}</div>
                {justGeneratedKey.latitude && justGeneratedKey.longitude && (
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    🌐 <b>Coordinate:</b> <code>{justGeneratedKey.latitude.toFixed(5)}° N, {justGeneratedKey.longitude.toFixed(5)}° E</code> | 📏 <b>Raggio Allerta:</b> {justGeneratedKey.alert_radius_meters || 150}m
                  </div>
                )}
              </div>
            </div>

            <div style={{ fontSize: '12px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>Istruzioni per l&apos;esercente: <i>Apri il bot @NoiseTurin_bot e digita:</i></span>
              <button
                type="button"
                onClick={() => copyToClipboard(`/login ${justGeneratedKey.auth_key}`)}
                title="Clicca per copiare il comando completo /login"
                style={{
                  background: copiedKey === `/login ${justGeneratedKey.auth_key}` ? 'rgba(34, 197, 94, 0.2)' : 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid',
                  borderColor: copiedKey === `/login ${justGeneratedKey.auth_key}` ? '#22c55e' : 'rgba(56, 189, 248, 0.3)',
                  borderRadius: '4px',
                  padding: '3px 8px',
                  color: copiedKey === `/login ${justGeneratedKey.auth_key}` ? '#4ade80' : '#38bdf8',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontFamily: 'monospace',
                }}
              >
                <span>/login {justGeneratedKey.auth_key}</span>
                {copiedKey === `/login ${justGeneratedKey.auth_key}` ? <Check size={12} /> : <Copy size={12} />}
              </button>
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

        {/* Box Generazione Nuova Chiave con Via/Sede Pre-registrata */}
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
            Inserisci la via e il numero civico dell&apos;attività commerciale: l&apos;indirizzo verrà geocodificato e salvato direttamente dall&apos;amministrazione, eliminando qualsiasi errore di digitazione su Telegram.
          </p>

          <form onSubmit={handleCreateKey} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="business-name-input" style={{ display: 'block', fontSize: '12px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
                Nome Attività / Locale
              </label>
              <input
                id="business-name-input"
                type="text"
                value={newBusinessName}
                onChange={(e) => setNewBusinessName(e.target.value)}
                placeholder="es. Bar Santa Giulia, Pasticceria Baretti..."
                disabled={isGenerating}
                required
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '11px 14px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ flex: '1 1 320px' }}>
              <label htmlFor="business-address-input" style={{ display: 'block', fontSize: '12px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
                Sede / Indirizzo a Torino (Via e Civico)
              </label>
              <input
                id="business-address-input"
                type="text"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="es. Via Santa Giulia 12, Torino oppure Via Po 14"
                disabled={isGenerating}
                required
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '11px 14px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ width: '130px' }}>
              <label htmlFor="business-radius-input" style={{ display: 'block', fontSize: '12px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
                Raggio Allerta (m)
              </label>
              <input
                id="business-radius-input"
                type="number"
                min="30"
                max="2000"
                value={newRadius}
                onChange={(e) => setNewRadius(Number(e.target.value))}
                placeholder="150"
                disabled={isGenerating}
                required
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '11px 14px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end', flex: '0 0 auto' }}>
              <button
                id="generate-key-submit-button"
                type="submit"
                disabled={isGenerating || !newBusinessName.trim() || !newAddress.trim()}
                style={{
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '11px 22px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: isGenerating ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: '0 4px 14px rgba(2, 132, 199, 0.4)',
                  opacity: isGenerating ? 0.7 : 1,
                  height: '42px',
                }}
              >
                {isGenerating ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    <span>Geocodifica & Generazione...</span>
                  </>
                ) : (
                  <>
                    <KeyRound size={16} />
                    <span>Genera Chiave Monouso</span>
                  </>
                )}
              </button>
            </div>
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
                Sede e perimetro pre-configurati dall&apos;amministrazione
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
                placeholder="Cerca attività, via o chiave..."
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
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Attività Commerciale</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Chiave Monouso</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Sede Registrata & Coordinate</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Stato</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Utenza Telegram</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Creata da</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filteredKeys.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '36px 20px', textAlign: 'center', color: '#94a3b8' }}>
                      Nessuna chiave trovata. Genera una nuova chiave sopra inserendo nome e via.
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
                        <td style={{ padding: '14px 18px', fontWeight: 600, color: '#f8fafc' }}>
                          {item.business_name || item.description || 'Attività generica'}
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <code
                              onClick={() => copyToClipboard(item.auth_key)}
                              title="Clicca per copiare la chiave"
                              style={{
                                backgroundColor: '#0f172a',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                color: isRevoked ? '#94a3b8' : '#38bdf8',
                                fontWeight: 700,
                                textDecoration: isRevoked ? 'line-through' : 'none',
                                cursor: 'pointer',
                                userSelect: 'all',
                              }}
                            >
                              {item.auth_key}
                            </code>
                            <button
                              type="button"
                              title={copiedKey === item.auth_key ? 'Copiata negli appunti!' : 'Copia Chiave'}
                              onClick={() => copyToClipboard(item.auth_key)}
                              style={{
                                background: copiedKey === item.auth_key ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.06)',
                                border: '1px solid',
                                borderColor: copiedKey === item.auth_key ? '#22c55e' : 'rgba(255, 255, 255, 0.15)',
                                borderRadius: '5px',
                                color: copiedKey === item.auth_key ? '#4ade80' : '#94a3b8',
                                cursor: 'pointer',
                                padding: '3px 8px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '11px',
                                fontWeight: 500,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              {copiedKey === item.auth_key ? <Check size={13} /> : <Copy size={13} />}
                              <span>{copiedKey === item.auth_key ? 'Copiata!' : 'Copia'}</span>
                            </button>
                          </div>
                        </td>

                        <td style={{ padding: '14px 18px', maxWidth: '300px' }}>
                          <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 500 }}>
                            {item.address || 'Torino'}
                          </div>
                          {item.latitude && item.longitude ? (
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                              <code>{item.latitude.toFixed(5)}°N, {item.longitude.toFixed(5)}°E</code> · Raggio: <b>{item.alert_radius_meters || 150}m</b>
                            </div>
                          ) : (
                            <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic' }}>
                              Raggio: {item.alert_radius_meters || 150}m
                            </div>
                          )}
                        </td>

                        <td style={{ padding: '14px 18px' }}>
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

                        <td style={{ padding: '14px 18px', color: '#cbd5e1' }}>
                          {item.used_by_chat_id ? (
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span>Chat ID: <code>{item.used_by_chat_id}</code></span>
                              {item.used_at && (
                                <span style={{ fontSize: '11px', color: '#64748b' }}>
                                  Attivata: {new Date(item.used_at).toLocaleDateString('it-IT')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: '#64748b', fontStyle: 'italic' }}>Non ancora riscattata</span>
                          )}
                        </td>

                        <td style={{ padding: '14px 18px', color: '#94a3b8' }}>
                          {item.created_by || 'admin'}
                        </td>

                        <td style={{ padding: '14px 18px', textAlign: 'right' }}>
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
      </>
    )}

    {/* ============================================================ */}
    {/* TAB STAZIONI ACUSTICHE & COORDINATE FISSE                      */}
    {/* ============================================================ */}
    {activeTab === 'stations' && (
      <div>
        {/* Stats Row Stazioni */}
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
              Stazioni Acustiche Totali
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#f8fafc', marginTop: '6px' }}>
              {totalStations}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Rete di monitoraggio Torino
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
              Stazioni Hardware Reali
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#34d399', marginTop: '6px' }}>
              {realStationsCount}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Sensori fisici (Microfono / Arduino)
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
              Stazioni Simulate / Test
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#38bdf8', marginTop: '6px' }}>
              {dummyStationsCount}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Nodi generati per test
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
              Campionamenti nel DB
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: '#ca8a04', marginTop: '6px' }}>
              {totalReadingsCount.toLocaleString('it-IT')}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Misurazioni acustiche storiche
            </div>
          </div>
        </div>

        {/* Box Registrazione Nuova Stazione */}
        <div
          style={{
            backgroundColor: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '14px',
            padding: '24px',
            marginBottom: '28px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <div
              style={{
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                padding: '8px',
                borderRadius: '8px',
              }}
            >
              <Radio size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                Registra Nuova Stazione Acustica
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#94a3b8' }}>
                Assegna coordinate geografiche fisse e un identificativo sensore per la mappa termica JIT
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateStation} style={{ marginTop: '20px' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '16px',
                marginBottom: '16px',
              }}
            >
              {/* Nome Stazione */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Nome Descrittivo Stazione *
                </label>
                <input
                  id="new-station-name-input"
                  type="text"
                  value={newStationName}
                  onChange={(e) => {
                    setNewStationName(e.target.value);
                    if (!newStationId || newStationId.startsWith('ard-')) {
                      const slug = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                      setNewStationId(slug ? `ard-${slug}` : '');
                    }
                  }}
                  placeholder="es: San Salvario (Via Baretti / Movida)"
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: '#f8fafc',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* ID Univoco */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  ID Sensore Univoco (Hardware/API) *
                </label>
                <input
                  id="new-station-id-input"
                  type="text"
                  value={newStationId}
                  onChange={(e) => setNewStationId(e.target.value)}
                  placeholder="es: ard-baretti-01"
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: '#38bdf8',
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Indirizzo con pulsante geocodifica */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Indirizzo a Torino (opzionale per calcolare le coordinate fisse)
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="new-station-address-input"
                    type="text"
                    value={newStationAddress}
                    onChange={(e) => setNewStationAddress(e.target.value)}
                    placeholder="es: Via Po 14, Torino oppure Piazza Santa Giulia 2"
                    style={{
                      flex: 1,
                      backgroundColor: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                      padding: '10px 14px',
                      color: '#f8fafc',
                      fontSize: '13px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleGeocodeStationAddress}
                    disabled={isGeocodingStation}
                    style={{
                      backgroundColor: '#334155',
                      color: '#f8fafc',
                      border: '1px solid #475569',
                      borderRadius: '8px',
                      padding: '0 16px',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: isGeocodingStation ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isGeocodingStation ? <RefreshCw size={14} className="animate-spin" /> : <MapPin size={14} />}
                    Trova Coordinate
                  </button>
                </div>
              </div>

              {/* Latitudine Fissa */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Latitudine Fissa (°N) *
                </label>
                <input
                  id="new-station-lat-input"
                  type="number"
                  step="any"
                  value={newStationLat}
                  onChange={(e) => setNewStationLat(e.target.value)}
                  placeholder="45.07050"
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: '#f8fafc',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Longitudine Fissa */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Longitudine Fissa (°E) *
                </label>
                <input
                  id="new-station-lng-input"
                  type="number"
                  step="any"
                  value={newStationLng}
                  onChange={(e) => setNewStationLng(e.target.value)}
                  placeholder="7.68680"
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: '#f8fafc',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Tipologia Stazione */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Tipologia Stazione *
                </label>
                <select
                  id="new-station-type-select"
                  value={newStationIsDummy ? 'dummy' : 'real'}
                  onChange={(e) => setNewStationIsDummy(e.target.value === 'dummy')}
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: newStationIsDummy ? '#94a3b8' : '#34d399',
                    fontSize: '13px',
                    fontWeight: 600,
                    outline: 'none',
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                  }}
                >
                  <option value="real">🟢 Hardware Reale (Microfono / Arduino)</option>
                  <option value="dummy">⚪ Simulatore / Dati Test</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button
                type="submit"
                id="create-station-btn"
                disabled={isCreatingStation}
                style={{
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '11px 24px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: isCreatingStation ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: '0 4px 14px rgba(2, 132, 199, 0.4)',
                  opacity: isCreatingStation ? 0.7 : 1,
                }}
              >
                {isCreatingStation ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    <span>Registrazione in corso...</span>
                  </>
                ) : (
                  <>
                    <PlusCircle size={16} />
                    <span>Registra Stazione con Coordinate Fisse</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Tabella Stazioni Acustiche */}
        <div
          style={{
            backgroundColor: '#1e293b',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '14px',
            overflow: 'hidden',
          }}
        >
          {/* Header Tabella Stazioni con Ricerca */}
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
                Elenco Stazioni Acustiche ({filteredStations.length})
              </h3>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0 0' }}>
                Sensori fisici e celle di monitoraggio distribuite su Torino con cerchio geodetico fisso da 15m
              </p>
            </div>

            <div style={{ position: 'relative', width: '280px' }}>
              <Search
                size={16}
                color="#64748b"
                style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                id="search-stations-input"
                type="text"
                value={stationSearchFilter}
                onChange={(e) => setStationSearchFilter(e.target.value)}
                placeholder="Cerca per nome o ID..."
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

          {/* Table Stazioni */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: 'rgba(15, 23, 42, 0.6)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Stazione & Nome</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>ID Sensore</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Coordinate Fisse (Torino)</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Tipologia</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Decibel Live</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600 }}>Campionamenti</th>
                  <th style={{ padding: '14px 18px', color: '#94a3b8', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filteredStations.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '36px 20px', textAlign: 'center', color: '#94a3b8' }}>
                      Nessuna stazione trovata con i filtri attuali.
                    </td>
                  </tr>
                ) : (
                  filteredStations.map((st) => {
                    const isReal = st.is_dummy === 0;
                    const lastTimeStr = st.last_reading_time
                      ? new Date(st.last_reading_time).toLocaleTimeString('it-IT')
                      : null;

                    return (
                      <tr
                        key={st.id}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                          transition: 'background-color 0.15s ease',
                        }}
                      >
                        <td style={{ padding: '14px 18px', fontWeight: 600, color: '#f8fafc' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Radio size={16} color={isReal ? '#34d399' : '#94a3b8'} />
                            <span>{st.name}</span>
                          </div>
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <code
                            style={{
                              backgroundColor: '#0f172a',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              color: '#38bdf8',
                              fontWeight: 700,
                            }}
                          >
                            {st.id}
                          </code>
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontFamily: 'monospace', color: '#e2e8f0', fontSize: '12px' }}>
                              {st.latitude.toFixed(5)}° N, {st.longitude.toFixed(5)}° E
                            </span>
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${st.latitude}&mlon=${st.longitude}#map=17/${st.latitude}/${st.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Visualizza su OpenStreetMap"
                              style={{ color: '#38bdf8', display: 'inline-flex', alignItems: 'center' }}
                            >
                              <ExternalLink size={13} />
                            </a>
                          </div>
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          {isReal ? (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 600,
                                backgroundColor: 'rgba(52, 211, 153, 0.15)',
                                color: '#34d399',
                                border: '1px solid rgba(52, 211, 153, 0.3)',
                              }}
                            >
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#34d399' }} />
                              Hardware Reale
                            </span>
                          ) : (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: 500,
                                backgroundColor: 'rgba(148, 163, 184, 0.1)',
                                color: '#94a3b8',
                                border: '1px solid rgba(148, 163, 184, 0.2)',
                              }}
                            >
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#94a3b8' }} />
                              Simulatore
                            </span>
                          )}
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          {st.current_intensity != null ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span
                                style={{
                                  fontWeight: 800,
                                  fontSize: '14px',
                                  color:
                                    st.current_intensity >= 80
                                      ? '#f87171'
                                      : st.current_intensity >= 65
                                      ? '#facc15'
                                      : '#4ade80',
                                }}
                              >
                                {Math.round(st.current_intensity)} dB
                              </span>
                              {lastTimeStr && (
                                <span style={{ fontSize: '11px', color: '#64748b' }}>({lastTimeStr})</span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: '#64748b', fontSize: '12px' }}>In attesa di dati</span>
                          )}
                        </td>

                        <td style={{ padding: '14px 18px', color: '#cbd5e1' }}>
                          <b>{(st.readings_count || 0).toLocaleString('it-IT')}</b>
                        </td>

                        <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            <button
                              type="button"
                              onClick={() => handleOpenEditStation(st)}
                              title="Modifica coordinate o nome"
                              style={{
                                backgroundColor: 'rgba(56, 189, 248, 0.1)',
                                border: '1px solid rgba(56, 189, 248, 0.3)',
                                color: '#38bdf8',
                                borderRadius: '6px',
                                padding: '5px 10px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <Edit2 size={13} /> Modifica
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteStation(st.id, st.name)}
                              title="Elimina stazione e letture"
                              style={{
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                color: '#f87171',
                                borderRadius: '6px',
                                padding: '5px 10px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <Trash2 size={13} /> Elimina
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )}
  </main>

  {/* Modal Modifica Stazione */}
  {editingStation && (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '20px',
      }}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '14px',
          maxWidth: '520px',
          width: '100%',
          padding: '24px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Edit2 size={18} color="#38bdf8" />
            <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#f8fafc' }}>
              Modifica Stazione Acustica
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setEditingStation(null)}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '18px' }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSaveStationEdit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>
                ID Stazione (Univoco - Non modificabile)
              </label>
              <input
                type="text"
                value={editingStation.id}
                disabled
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  color: '#64748b',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '4px' }}>
                Nome Stazione *
              </label>
              <input
                type="text"
                value={editStationName}
                onChange={(e) => setEditStationName(e.target.value)}
                required
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '4px' }}>
                  Latitudine Fissa (°N) *
                </label>
                <input
                  type="number"
                  step="any"
                  value={editStationLat}
                  onChange={(e) => setEditStationLat(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    color: '#f8fafc',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '4px' }}>
                  Longitudine Fissa (°E) *
                </label>
                <input
                  type="number"
                  step="any"
                  value={editStationLng}
                  onChange={(e) => setEditStationLng(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    backgroundColor: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    color: '#f8fafc',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '4px' }}>
                Tipologia
              </label>
              <select
                value={editStationIsDummy ? 'dummy' : 'real'}
                onChange={(e) => setEditStationIsDummy(e.target.value === 'dummy')}
                style={{
                  width: '100%',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  color: editStationIsDummy ? '#94a3b8' : '#34d399',
                  fontSize: '13px',
                  fontWeight: 600,
                  outline: 'none',
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                }}
              >
                <option value="real">🟢 Hardware Reale</option>
                <option value="dummy">⚪ Simulatore / Dati Test</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <button
              type="button"
              onClick={() => setEditingStation(null)}
              style={{
                backgroundColor: '#334155',
                color: '#f8fafc',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={isSavingStationEdit}
              style={{
                backgroundColor: '#0284c7',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isSavingStationEdit ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {isSavingStationEdit ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
              Salva Modifiche
            </button>
          </div>
        </form>
      </div>
    </div>
  )}
    </div>
  );
}
