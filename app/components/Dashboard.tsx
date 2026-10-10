'use client';

import React, { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { StationMapItem } from './NoiseMap';
import { NOISE_RADIUS_METERS, getNoiseLevel } from '@/lib/constants';

// Caricamento dinamico del componente Mappa per evitare problemi SSR con Leaflet
const DynamicNoiseMap = dynamic(() => import('./NoiseMap'), {
  ssr: false,
  loading: () => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      backgroundColor: '#f8fafc',
      color: '#64748b',
      fontSize: '16px'
    }}>
      Caricamento mappa di Torino e nodi acustici in corso...
    </div>
  ),
});

export default function Dashboard() {
  const [stations, setStations] = useState<StationMapItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());
  const [isStreamConnected, setIsStreamConnected] = useState<boolean>(false);
  const [isSimulatingContinuous, setIsSimulatingContinuous] = useState<boolean>(false);
  const [showDummyStations, setShowDummyStations] = useState<boolean>(false);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [simMessage, setSimMessage] = useState<string>('');
  const [showArduinoSnippet, setShowArduinoSnippet] = useState<boolean>(false);

  // 1. Streaming Just-in-Time (SSE): riceve i campionamenti all'istante via push
  // Nessun loop di polling ogni secondo (0 chiamate HTTP inutili e performance massime)
  useEffect(() => {
    setIsLoading(true);
    const filterParam = showDummyStations ? 'all' : 'live_only';
    const eventSource = new EventSource(`/api/telemetry/stream?filter=${filterParam}`);

    eventSource.addEventListener('init', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setStations(payload.stations || []);
        setIsStreamConnected(true);
        setLastRefreshedAt(new Date(payload.timestamp || Date.now()));
        setIsLoading(false);
      } catch (err) {
        console.error('Errore parsing init stream:', err);
      }
    });

    eventSource.addEventListener('reading', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const incoming = payload.station;
        if (!incoming) return;

        setStations((prev) => {
          const idx = prev.findIndex((s) => s.id === incoming.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = {
              ...copy[idx],
              ...incoming,
            };
            return copy;
          } else {
            return [...prev, incoming];
          }
        });
        setLastRefreshedAt(new Date());
        setIsStreamConnected(true);
      } catch (err) {
        console.error('Errore parsing reading stream:', err);
      }
    });

    eventSource.onopen = () => {
      setIsStreamConnected(true);
    };

    eventSource.onerror = () => {
      setIsStreamConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [showDummyStations]);

  // Recupero manuale on-demand dello snapshot (opzionale)
  const fetchStationsSnapshot = useCallback(async () => {
    try {
      const url = showDummyStations ? '/api/stations?filter=all' : '/api/stations?filter=live_only';
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setStations(data.stations || []);
        setLastRefreshedAt(new Date());
      }
    } catch (err) {
      console.error('Errore snapshot manuale:', err);
    }
  }, [showDummyStations]);

  // 2. Simulatore continuo (~1 secondo per campionamento Arduino nel DB se attivato manualmente)
  useEffect(() => {
    if (!isSimulatingContinuous) return;

    const simInterval = setInterval(async () => {
      try {
        await fetch('/api/simulator', { method: 'POST' });
      } catch (e) {
        console.error('Errore simulatore:', e);
      }
    }, 1000);

    return () => clearInterval(simInterval);
  }, [isSimulatingContinuous]);

  // Trigger manuale di un singolo impulso dummy
  const triggerSingleSimulation = async () => {
    setSimMessage('Invio dati campionari Arduino in corso...');
    try {
      const res = await fetch('/api/simulator', { method: 'POST' });
      if (res.ok) {
        setSimMessage('Dati campionari acquisiti e memorizzati!');
      }
    } catch {
      setSimMessage('Errore durante la simulazione.');
    }
    setTimeout(() => setSimMessage(''), 3000);
  };

  // Statistiche rapide
  const totalStations = stations.length;
  const avgIntensity = totalStations > 0 
    ? Math.round(stations.reduce((acc, s) => acc + s.current_intensity, 0) / totalStations)
    : 0;
  const loudestStation = stations.slice().sort((a, b) => b.current_intensity - a.current_intensity)[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      
      {/* HEADER MINIMALE E FUNZIONALE */}
      <header style={{
        backgroundColor: '#0f172a',
        color: '#ffffff',
        padding: '12px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #334155',
        flexWrap: 'wrap',
        gap: '12px',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600, letterSpacing: '-0.3px' }}>
              Torino Noise Monitor • Heatmap Acustica
            </h1>
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>
              Rete sensori slave Arduino | Raggio di copertura: <strong>{NOISE_RADIUS_METERS} m</strong>
            </p>
          </div>
          <span style={{
            fontSize: '11px',
            backgroundColor: '#1e293b',
            color: '#38bdf8',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid #0284c7'
          }}>
            API Protetta (x-api-key)
          </span>
        </div>

        {/* CONTROLLI E AZIONI RAPIDE */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            backgroundColor: isStreamConnected ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            border: isStreamConnected ? '1px solid #22c55e' : '1px solid #ef4444',
            padding: '5px 12px',
            borderRadius: '20px',
            fontSize: '12px',
            color: isStreamConnected ? '#4ade80' : '#fca5a5',
            fontWeight: 600,
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isStreamConnected ? '#22c55e' : '#ef4444',
              boxShadow: isStreamConnected ? '0 0 8px #22c55e' : 'none',
              display: 'inline-block',
            }} />
            <span>{isStreamConnected ? 'Stream SSE Just-in-Time: ATTIVO' : 'Stream: Riconnessione...'}</span>
          </div>

          <button
            onClick={() => fetchStationsSnapshot()}
            style={{
              padding: '6px 12px',
              backgroundColor: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #475569',
              borderRadius: '5px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500
            }}
            title="Richiede manualmente uno snapshot di tutte le stazioni"
          >
            Aggiorna Snapshot
          </button>

          <button
            onClick={() => setShowDummyStations(!showDummyStations)}
            style={{
              padding: '6px 12px',
              backgroundColor: showDummyStations ? '#334155' : '#047857',
              color: '#ffffff',
              border: showDummyStations ? '1px solid #475569' : '1px solid #10b981',
              borderRadius: '5px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 600
            }}
            title="Oscura o mostra le stazioni pre-generate dummy"
          >
            {showDummyStations ? '⚪ Modalità: Tutte le Stazioni' : '🟢 Modalità: Solo Stazione Reale'}
          </button>

          <button
            onClick={triggerSingleSimulation}
            style={{
              padding: '6px 12px',
              backgroundColor: '#475569',
              color: '#ffffff',
              border: 'none',
              borderRadius: '5px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Genera Dati Dummy
          </button>

          <button
            onClick={() => setIsSimulatingContinuous(!isSimulatingContinuous)}
            style={{
              padding: '6px 12px',
              backgroundColor: isSimulatingContinuous ? '#dc2626' : '#16a34a',
              color: '#ffffff',
              border: 'none',
              borderRadius: '5px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            {isSimulatingContinuous ? 'Stop Slave Loop (1s)' : 'Avvia Slave Loop (1s)'}
          </button>

          <button
            onClick={() => setShowArduinoSnippet(!showArduinoSnippet)}
            style={{
              padding: '6px 10px',
              backgroundColor: '#334155',
              color: '#e2e8f0',
              border: '1px solid #475569',
              borderRadius: '5px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            {showArduinoSnippet ? 'Chiudi Guida Slave' : 'Codice Arduino'}
          </button>
        </div>
      </header>

      {/* NOTIFICA MESSAGGIO RAPIDO */}
      {simMessage && (
        <div style={{
          backgroundColor: '#0284c7',
          color: '#ffffff',
          fontSize: '12px',
          textAlign: 'center',
          padding: '4px',
          fontWeight: 500
        }}>
          {simMessage}
        </div>
      )}

      {/* AREA PRINCIPALE: MAPPA + PANNELLO LATERALE COMPATTO */}
      <div style={{ display: 'flex', flex: 1, position: 'relative', overflow: 'hidden' }}>
        
        {/* MAPPA DI TORINO A TUTTO SCHERMO */}
        <div style={{ flex: 1, height: '100%', position: 'relative' }}>
          <DynamicNoiseMap stations={stations} selectedStationId={selectedStationId} />

          {/* LEGENDA COLORI FLUTTUANTE SULLA MAPPA */}
          <div style={{
            position: 'absolute',
            bottom: '24px',
            left: '24px',
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(4px)',
            borderRadius: '8px',
            padding: '12px 16px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 1000,
            maxWidth: '280px',
            fontSize: '12px',
            color: '#1e293b'
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>
              Legenda Livello Acustico (Raggio 15m)
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#ffffff', border: '2px solid #94a3b8', display: 'inline-block' }} />
                <span><strong>Bianco:</strong> Poco o nessun rumore (&lt; 40 dB)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#22c55e', border: '1px solid #16a34a', display: 'inline-block' }} />
                <span><strong>Verde:</strong> Rumore lieve (40 - 65 dB)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#eab308', border: '1px solid #ca8a04', display: 'inline-block' }} />
                <span><strong>Giallo:</strong> Rumore medio (66 - 80 dB)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#ef4444', border: '1px solid #b91c1c', display: 'inline-block' }} />
                <span><strong>Rosso:</strong> Rumore forte (81 - 95 dB)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '16px', height: '16px', borderRadius: '50%', backgroundColor: '#a855f7', border: '1px solid #7c3aed', display: 'inline-block' }} />
                <span><strong>Viola:</strong> Rumore intenso / critico (&gt; 95 dB)</span>
              </div>
            </div>
          </div>
        </div>

        {/* PANNELLO LATERALE: STATO STAZIONI E METRICHE */}
        <aside style={{
          width: '320px',
          backgroundColor: '#f8fafc',
          borderLeft: '1px solid #e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 5
        }}>
          {/* SINTESI METRICHE */}
          <div style={{ padding: '14px', borderBottom: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
            <h2 style={{ fontSize: '13px', fontWeight: 600, color: '#475569', margin: '0 0 10px 0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Stato Monitoraggio Urbano
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ backgroundColor: '#f1f5f9', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: '#64748b' }}>Stazioni Attive</div>
                <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#0f172a' }}>{totalStations}</div>
              </div>
              <div style={{ backgroundColor: '#f1f5f9', padding: '10px', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: '#64748b' }}>Media Torino</div>
                <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#0f172a' }}>{avgIntensity} dB</div>
              </div>
            </div>

            {loudestStation && (
              <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b' }}>
                Zona più rumorosa: <strong style={{ color: '#0f172a' }}>{loudestStation.name}</strong> ({loudestStation.current_intensity} dB)
              </div>
            )}
          </div>

          {/* LISTA STAZIONI SLAVE */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '8px' }}>
              Nodi Sensore Arduino ({stations.length})
            </div>

            {isLoading ? (
              <div style={{ fontSize: '12px', color: '#94a3b8', padding: '10px 0' }}>Caricamento stazioni...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {stations.map((st) => {
                  const level = getNoiseLevel(st.current_intensity);
                  const isSelected = selectedStationId === st.id;
                  return (
                    <div
                      key={st.id}
                      onClick={() => setSelectedStationId(st.id)}
                      style={{
                        backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                        border: isSelected ? '2px solid #2563eb' : '1px solid #e2e8f0',
                        borderRadius: '6px',
                        padding: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '12px',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease-in-out'
                      }}
                    >
                      <div style={{ maxWidth: '185px' }}>
                        <div style={{ fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {st.name}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          ID: <code>{st.id}</code> • Raggio: {NOISE_RADIUS_METERS}m
                        </div>
                        <div style={{ fontSize: '10px', marginTop: '3px' }}>
                          {st.last_reading_time && (Date.now() - st.last_reading_time < 3500) ? (
                            <span style={{ color: '#16a34a', fontWeight: 600 }}>● Stream in tempo reale</span>
                          ) : (
                            <span style={{ color: '#94a3b8' }}>○ In attesa (avvia <code>npm run mic</code>)</span>
                          )}
                        </div>
                        {/* Barra di intensità graduata fluida */}
                        <div style={{ width: '100%', height: '4px', backgroundColor: '#e2e8f0', borderRadius: '2px', overflow: 'hidden', marginTop: '6px' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.min(100, Math.max(6, ((st.current_intensity - 30) / (105 - 30)) * 100))}%`,
                            backgroundColor: level.fillColor,
                            transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.5s ease',
                          }} />
                        </div>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{
                          display: 'inline-block',
                          padding: '3px 10px',
                          borderRadius: '12px',
                          backgroundColor: level.fillColor,
                          color: level.level === 'quiet' ? '#0f172a' : '#ffffff',
                          fontWeight: 'bold',
                          fontSize: '12px',
                          border: `1px solid ${level.color}`,
                          transition: 'background-color 0.5s ease, color 0.5s ease, border-color 0.5s ease',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.06)'
                        }}>
                          {st.current_intensity} dB
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* FOOTER INFO STATO */}
          <div style={{
            padding: '10px 14px',
            borderTop: '1px solid #e2e8f0',
            backgroundColor: '#ffffff',
            fontSize: '11px',
            color: '#64748b',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <span>Ultimo aggiornamento:</span>
            <span>{lastRefreshedAt.toLocaleTimeString('it-IT')}</span>
          </div>
        </aside>
      </div>

      {/* MODALE GUIDA PER CONNESSIONE ARDUINO HARDWARE */}
      {showArduinoSnippet && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: 'rgba(0,0,0,0.6)',
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            maxWidth: '700px',
            width: '100%',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)'
          }}>
            <div style={{
              padding: '14px 20px',
              backgroundColor: '#0f172a',
              color: '#ffffff',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <h3 style={{ margin: 0, fontSize: '15px' }}>Integrazione Hardware Arduino Slave</h3>
              <button 
                onClick={() => setShowArduinoSnippet(false)}
                style={{ background: 'none', border: 'none', color: '#ffffff', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '20px', overflowY: 'auto', fontSize: '13px', color: '#334155', lineHeight: '1.6' }}>
              <div style={{
                backgroundColor: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: '6px',
                padding: '12px 14px',
                marginBottom: '14px',
                color: '#1e40af'
              }}>
                <strong>Hardware Target: Arduino UNO Q (4GB RAM)</strong><br/>
                Grazie ai <strong>4GB di memoria RAM</strong> e alle capacità computazionali dell'Arduino UNO Q, il client gestisce connessioni HTTP persistenti (<strong>Keep-Alive</strong>), code di sicurezza in RAM contro disconnessioni temporanee e campionamenti RMS continui ad alta frequenza.
              </div>

              <div style={{ backgroundColor: '#f1f5f9', padding: '12px', borderRadius: '6px', marginBottom: '14px' }}>
                <strong>Endpoint Master:</strong> <code>POST http://&lt;SERVER_IP&gt;:3000/api/telemetry/reading</code><br/>
                <strong>Header Autenticazione:</strong> <code>x-api-key: arduino-torino-noise-secret-2026</code><br/>
                <strong>Formato JSON Payload:</strong>
                <pre style={{ margin: '6px 0 0 0', backgroundColor: '#e2e8f0', padding: '8px', borderRadius: '4px' }}>
{`{
  "station_id": "ard-uno-q-baretti",
  "name": "Arduino Uno Q (San Salvario)",
  "sound_intensity": 88,
  "timestamp": 1728565450000,
  "api_key": "arduino-torino-noise-secret-2026"
}`}
                </pre>
              </div>

              <h4 style={{ margin: '10px 0 6px 0', color: '#0f172a' }}>
                Opzione 1: Daemon Python per Arduino UNO Q (Consigliata):
              </h4>
              <p style={{ margin: '0 0 6px 0', fontSize: '12px', color: '#64748b' }}>
                Disponibile nel file: <code>scripts/arduino_uno_q_telemetry.py</code> con connection pooling Keep-Alive e coda in RAM:
              </p>
              <pre style={{
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                padding: '10px',
                borderRadius: '6px',
                overflowX: 'auto',
                fontSize: '11px',
                fontFamily: 'Consolas, monospace'
              }}>
{`# Esecuzione diretta su Arduino UNO Q:
python3 scripts/arduino_uno_q_telemetry.py`}
              </pre>

              <h4 style={{ margin: '14px 0 6px 0', color: '#0f172a' }}>
                Opzione 2: Sketch C++ con Keep-Alive Sockets (WiFiClient):
              </h4>
              <p style={{ margin: '0 0 6px 0', fontSize: '12px', color: '#64748b' }}>
                Disponibile nel file: <code>scripts/arduino_uno_q_telemetry.cpp</code>:
              </p>
              <pre style={{
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                padding: '10px',
                borderRadius: '6px',
                overflowX: 'auto',
                fontSize: '11px',
                fontFamily: 'Consolas, monospace'
              }}>
{`// Riutilizzo socket TCP Keep-Alive per abbattere la latenza su Uno Q:
httpClient.setReuse(true);
httpClient.addHeader("Connection", "keep-alive");
httpClient.addHeader("x-api-key", "arduino-torino-noise-secret-2026");`}
              </pre>
            </div>

            <div style={{ padding: '12px 20px', borderTop: '1px solid #e2e8f0', textAlign: 'right', backgroundColor: '#f8fafc' }}>
              <button
                onClick={() => setShowArduinoSnippet(false)}
                style={{
                  padding: '6px 14px',
                  backgroundColor: '#0f172a',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer'
                }}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
