'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { 
  TURIN_CENTER_LNG_LAT, 
  TURIN_DEFAULT_ZOOM, 
  TURIN_BOUNDS_MAPLIBRE, 
  NOISE_RADIUS_METERS, 
  OPENFREEMAP_STYLES,
  OpenFreeMapStyleKey,
  getNoiseLevel,
  getSmoothNoiseColor 
} from '@/lib/constants';

export interface StationMapItem {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  current_intensity: number;
  last_reading_time: number | null;
  radius_meters: number;
}

interface NoiseMapProps {
  stations: StationMapItem[];
  selectedStationId?: string | null;
}

export type HeatmapMode = 'combined' | 'gradient' | 'circles';

// Genera un poligono circolare geodetico con raggio esatto di 15m
function createGeoJSONCircle(
  centerLng: number, 
  centerLat: number, 
  radiusInMeters: number = NOISE_RADIUS_METERS, 
  numPoints: number = 36
): number[][] {
  const coords: number[][] = [];
  const latRad = (centerLat * Math.PI) / 180;
  
  const metersToDegreesLat = 1 / 111132;
  const metersToDegreesLng = 1 / (111412.84 * Math.cos(latRad));

  const dLat = radiusInMeters * metersToDegreesLat;
  const dLng = radiusInMeters * metersToDegreesLng;

  for (let i = 0; i <= numPoints; i++) {
    const theta = (i / numPoints) * (2 * Math.PI);
    const lng = centerLng + dLng * Math.cos(theta);
    const lat = centerLat + dLat * Math.sin(theta);
    coords.push([lng, lat]);
  }
  return coords;
}

// Costruttore HTML per il popup informativo con supporto JIT live
function buildStationPopupHTML(
  station: { id?: string; name?: string } | Record<string, any>,
  intensity: number,
  lastReadingTime: number | null
): string {
  const rounded = Math.round(intensity);
  const smoothColor = getSmoothNoiseColor(intensity);
  const noise = getNoiseLevel(rounded);
  const dateStr = lastReadingTime
    ? new Date(Number(lastReadingTime)).toLocaleTimeString('it-IT')
    : 'In attesa di dati';
  const intensityPercent = Math.min(100, Math.max(5, ((intensity - 30) / (105 - 30)) * 100));

  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; min-width: 220px; padding: 4px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; gap: 8px;">
        <h4 style="margin: 0; font-size: 14px; font-weight: 700; color: #0f172a; max-width: 155px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${station.name}
        </h4>
        <span style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: #16a34a; font-weight: 600; background: #dcfce7; padding: 2px 7px; border-radius: 10px; white-space: nowrap;">
          <span style="width: 5px; height: 5px; border-radius: 50%; background-color: #22c55e; display: inline-block;"></span>
          JIT Live
        </span>
      </div>
      <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
        ID Sensore: <code>${station.id}</code>
      </div>

      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px;">
        <span style="font-size: 12px; color: #475569;">Intensità sonora:</span>
        <span id="jit-popup-db-${station.id}" style="font-size: 20px; font-weight: 800; color: ${smoothColor}; transition: color 0.3s ease;">
          ${rounded} dB
        </span>
      </div>

      <!-- Barra di intensità live dinamica -->
      <div style="width: 100%; height: 5px; background-color: #e2e8f0; border-radius: 3px; overflow: hidden; margin-bottom: 8px;">
        <div id="jit-popup-bar-${station.id}" style="height: 100%; width: ${intensityPercent}%; background-color: ${smoothColor}; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s ease;"></div>
      </div>

      <div style="font-size: 12px; margin-bottom: 6px; display: flex; justify-content: space-between;">
        <span style="color: #64748b;">Stato acustico:</span>
        <b id="jit-popup-label-${station.id}" style="color: ${smoothColor}; transition: color 0.3s ease;">${noise.label}</b>
      </div>
      <div style="font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 6px; line-height: 1.4;">
        Raggio copertura: <b>${NOISE_RADIUS_METERS} m</b><br/>
        Ultimo pacchetto: <b id="jit-popup-time-${station.id}">${dateStr}</b>
      </div>
    </div>
  `;
}

// Aggiorna all'istante il DOM del popup aperto senza doverlo ricreare (zero sfarfallio)
function updatePopupDOMIfOpen(stationId: string, intensity: number, lastReadingTime: number | null) {
  const dbEl = document.getElementById(`jit-popup-db-${stationId}`);
  const labelEl = document.getElementById(`jit-popup-label-${stationId}`);
  const barEl = document.getElementById(`jit-popup-bar-${stationId}`);
  const timeEl = document.getElementById(`jit-popup-time-${stationId}`);

  if (dbEl && labelEl && barEl) {
    const rounded = Math.round(intensity);
    const smoothColor = getSmoothNoiseColor(intensity);
    const noise = getNoiseLevel(rounded);
    const intensityPercent = Math.min(100, Math.max(5, ((intensity - 30) / (105 - 30)) * 100));

    dbEl.textContent = `${rounded} dB`;
    dbEl.style.color = smoothColor;

    labelEl.textContent = noise.label;
    labelEl.style.color = smoothColor;

    barEl.style.width = `${intensityPercent}%`;
    barEl.style.backgroundColor = smoothColor;

    if (timeEl && lastReadingTime) {
      timeEl.textContent = new Date(Number(lastReadingTime)).toLocaleTimeString('it-IT');
    }
  }
}

export default function NoiseMap({ stations, selectedStationId }: NoiseMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const activePopupRef = useRef<maplibregl.Popup | null>(null);
  const activePopupStationIdRef = useRef<string | null>(null);
  const stationStatesRef = useRef<Map<string, {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    currentIntensity: number;
    targetIntensity: number;
    last_reading_time: number | null;
    radius_meters: number;
  }>>(new Map());
  const animFrameIdRef = useRef<number | null>(null);
  const [currentStyle, setCurrentStyle] = useState<OpenFreeMapStyleKey>('positron');
  const [visualMode, setVisualMode] = useState<HeatmapMode>('combined');
  const [glowSize, setGlowSize] = useState<number>(45); // Raggio visivo dell'aura sfumata in pixel
  const [isMapLoaded, setIsMapLoaded] = useState<boolean>(false);

  // 1. Inizializzazione della mappa MapLibre GL con OpenFreeMap
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (typeof window !== 'undefined' && maplibregl.setWorkerUrl) {
      maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OPENFREEMAP_STYLES[currentStyle],
      center: TURIN_CENTER_LNG_LAT,
      zoom: TURIN_DEFAULT_ZOOM,
      minZoom: 11.5,
      maxZoom: 19,
      maxBounds: TURIN_BOUNDS_MAPLIBRE, // Ritaglio rigoroso su Torino
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; OpenStreetMap',
      }),
      'bottom-right'
    );

    map.on('load', () => {
      // -------------------------------------------------------------
      // SORGENTE 1: Punti acustici (per Heatmap WebGL e Aureole Sfumate)
      // -------------------------------------------------------------
      map.addSource('noise-stations-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // LAYER 1: VERA SFUMATURA TERMICA WEBGL (HEATMAP)
      // Fonde insieme le emissioni creando un gradiente continuo per le zone calde e fredde
      map.addLayer({
        id: 'noise-webgl-heatmap',
        type: 'heatmap',
        source: 'noise-stations-points',
        maxzoom: 19,
        paint: {
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'current_intensity'],
            20, 0.05,
            40, 0.2,
            65, 0.45,
            80, 0.85,  // Accelera la presenza di rosso a partire dagli 80 dB
            95, 1.3,   // Esplosione visiva per livelli critici
            110, 1.8,
          ],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, 1.4,
            14, 2.4,
            17, 3.8,
          ],
          // SCALA CROMATICA ACCENTUATA SUI ROSSI E VIOLA
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.10, 'rgba(255, 255, 255, 0.60)', // Bianco (< 40 dB)
            0.28, 'rgba(34, 197, 94, 0.80)',   // Verde (40-65 dB)
            0.50, 'rgba(234, 179, 8, 0.88)',   // Giallo (66-80 dB)
            0.70, 'rgba(255, 23, 68, 0.96)',   // Rosso Fuoco Vivo (> 80 dB)
            0.92, 'rgba(213, 0, 249, 1.0)',    // Viola Elettrico (> 95 dB)
          ],
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, 28,
            13, 55,
            15, 95,
            17, 150,
          ],
          'heatmap-opacity': 0.88,
        },
      });

      // LAYER 2: ALONE RADIALE AMBIENTALE (Con raggio maggiorato per zone rosse)
      map.addLayer({
        id: 'noise-ambient-halo',
        type: 'circle',
        source: 'noise-stations-points',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['get', 'current_intensity'],
            30, 25,
            60, 35,
            80, 55, // Espansione dell'alone per livelli elevati
            100, 85,
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': [
            'case',
            ['>=', ['get', 'current_intensity'], 80],
            0.55, // Più evidente per zone rosse e viola
            0.30,
          ],
          'circle-blur': 0.88,
        },
      });

      // LAYER 2B: BAGLIORE TERMICO AD ALTA INTENSITÀ PER ZONE CALDE (ROSSO / VIOLA)
      map.addLayer({
        id: 'noise-hotzone-radiance',
        type: 'circle',
        source: 'noise-stations-points',
        filter: ['>=', ['get', 'current_intensity'], 80],
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, 30,
            14, 60,
            17, 110,
          ],
          'circle-color': [
            'case',
            ['>=', ['get', 'current_intensity'], 95],
            'rgba(213, 0, 249, 0.65)', // Viola fluorescente
            'rgba(255, 23, 68, 0.60)',  // Rosso vivo
          ],
          'circle-blur': 0.75,
        },
      });

      // -------------------------------------------------------------
      // SORGENTE 2: Poligoni circolare calibrati a 15 Metri Reali
      // -------------------------------------------------------------
      map.addSource('noise-stations-circles-15m', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // LAYER 3: Riempimento 15m (con opacità maggiore per zone rosse)
      map.addLayer({
        id: 'noise-15m-fill',
        type: 'fill',
        source: 'noise-stations-circles-15m',
        paint: {
          'fill-color': ['get', 'fillColor'],
          'fill-opacity': [
            'case',
            ['>=', ['get', 'current_intensity'], 80],
            0.75, // Zona rossa/viola marcata e solida
            0.45,
          ],
        },
      });

      // LAYER 4: Bordo 15m (più spesso e marcato per zone calde)
      map.addLayer({
        id: 'noise-15m-stroke',
        type: 'line',
        source: 'noise-stations-circles-15m',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': [
            'case',
            ['>=', ['get', 'current_intensity'], 80],
            3.0, // Bordo spesso per allarme rosso
            1.8,
          ],
          'line-dasharray': [2, 1.5],
        },
      });

      // LAYER 4B: ANELLO DI SEGNALAZIONE ALLARME PER ZONE ROSSE E VIOLA
      map.addLayer({
        id: 'noise-hotzone-warning-ring',
        type: 'circle',
        source: 'noise-stations-points',
        filter: ['>=', ['get', 'current_intensity'], 80],
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, 10,
            14, 15,
            17, 22,
          ],
          'circle-color': 'rgba(255, 23, 68, 0)',
          'circle-stroke-width': 2.8,
          'circle-stroke-color': [
            'case',
            ['>=', ['get', 'current_intensity'], 95],
            '#d500f9',
            '#ff1744',
          ],
          'circle-stroke-opacity': 0.95,
        },
      });

      // LAYER 5: Pin centrale a cuore pulsante per individuazione immediata
      map.addLayer({
        id: 'noise-center-pin',
        type: 'circle',
        source: 'noise-stations-points',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, 5,
            14, 7,
            17, 10,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 1,
        },
      });

      // Click sui pin o cerchi per visualizzare il popup dettagliato con supporto JIT live
      const handleStationClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return;
        const props = e.features[0].properties;
        const geom = e.features[0].geometry;
        if (!props) return;

        let coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (geom.type === 'Point') {
          coords = geom.coordinates as [number, number];
        }

        if (activePopupRef.current) {
          activePopupRef.current.remove();
        }

        activePopupStationIdRef.current = props.id;

        const currentIntensity = Number(props.current_intensity);
        const popup = new maplibregl.Popup({ offset: 14, closeButton: true })
          .setLngLat(coords)
          .setHTML(buildStationPopupHTML(props, currentIntensity, props.last_reading_time))
          .addTo(map);

        popup.on('close', () => {
          if (activePopupStationIdRef.current === props.id) {
            activePopupStationIdRef.current = null;
          }
          activePopupRef.current = null;
        });

        activePopupRef.current = popup;
      };

      map.on('click', 'noise-center-pin', handleStationClick);
      map.on('click', 'noise-15m-fill', handleStationClick);

      map.on('mouseenter', 'noise-center-pin', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'noise-center-pin', () => { map.getCanvas().style.cursor = ''; });
      map.on('mouseenter', 'noise-15m-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'noise-15m-fill', () => { map.getCanvas().style.cursor = ''; });

      mapRef.current = map;
      setIsMapLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [currentStyle]);

  // 2. Loop di interpolazione continua e graduale (Damped LERP)
  // Elimina qualsiasi scatto brusco o lampeggio: i decibel, le aureole e i colori
  // transitano in modo progressivo e naturale
  const renderSmoothedGeoJSON = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const pointsSource = map.getSource('noise-stations-points') as maplibregl.GeoJSONSource | undefined;
    const circlesSource = map.getSource('noise-stations-circles-15m') as maplibregl.GeoJSONSource | undefined;
    if (!pointsSource || !circlesSource) return;

    const pointFeatures = Array.from(stationStatesRef.current.values()).map((st) => {
      const rounded = Math.round(st.currentIntensity);
      const smoothColor = getSmoothNoiseColor(st.currentIntensity);
      const noise = getNoiseLevel(rounded);

      return {
        type: 'Feature' as const,
        properties: {
          id: st.id,
          name: st.name,
          current_intensity: Number(st.currentIntensity.toFixed(1)),
          last_reading_time: st.last_reading_time,
          color: smoothColor,
          fillColor: smoothColor,
          label: noise.label,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [st.longitude, st.latitude],
        },
      };
    });

    const circleFeatures = Array.from(stationStatesRef.current.values()).map((st) => {
      const rounded = Math.round(st.currentIntensity);
      const smoothColor = getSmoothNoiseColor(st.currentIntensity);
      const noise = getNoiseLevel(rounded);
      const ring = createGeoJSONCircle(st.longitude, st.latitude, st.radius_meters || NOISE_RADIUS_METERS, 36);

      return {
        type: 'Feature' as const,
        properties: {
          id: st.id,
          name: st.name,
          current_intensity: Number(st.currentIntensity.toFixed(1)),
          last_reading_time: st.last_reading_time,
          color: smoothColor,
          fillColor: smoothColor,
          label: noise.label,
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [ring],
        },
      };
    });

    pointsSource.setData({
      type: 'FeatureCollection',
      features: pointFeatures,
    });

    circlesSource.setData({
      type: 'FeatureCollection',
      features: circleFeatures,
    });
  }, []);

  const tickAnimation = useCallback(() => {
    let hasMotion = false;

    stationStatesRef.current.forEach((st) => {
      const delta = st.targetIntensity - st.currentIntensity;
      if (Math.abs(delta) > 0.08) {
        // Passo LERP del 8%: transizione progressiva ed elegante nell'arco di ~350ms
        st.currentIntensity += delta * 0.08;
        hasMotion = true;
      } else {
        st.currentIntensity = st.targetIntensity;
      }
    });

    renderSmoothedGeoJSON();

    // Aggiornamento Just-in-Time live del popup aperto
    if (activePopupStationIdRef.current) {
      const activeSt = stationStatesRef.current.get(activePopupStationIdRef.current);
      if (activeSt) {
        updatePopupDOMIfOpen(activeSt.id, activeSt.currentIntensity, activeSt.last_reading_time);
      }
    }

    if (hasMotion) {
      animFrameIdRef.current = requestAnimationFrame(tickAnimation);
    } else {
      animFrameIdRef.current = null;
    }
  }, [renderSmoothedGeoJSON]);

  useEffect(() => {
    if (!isMapLoaded) return;

    // Sincronizza i target con le nuove letture ricevute dallo stream Just-in-Time
    const activeIds = new Set(stations.map((s) => s.id));
    for (const id of stationStatesRef.current.keys()) {
      if (!activeIds.has(id)) {
        stationStatesRef.current.delete(id);
      }
    }

    stations.forEach((st) => {
      const existing = stationStatesRef.current.get(st.id);
      if (!existing) {
        stationStatesRef.current.set(st.id, {
          id: st.id,
          name: st.name,
          latitude: st.latitude,
          longitude: st.longitude,
          currentIntensity: st.current_intensity,
          targetIntensity: st.current_intensity,
          last_reading_time: st.last_reading_time,
          radius_meters: st.radius_meters || NOISE_RADIUS_METERS,
        });
      } else {
        existing.targetIntensity = st.current_intensity;
        existing.name = st.name;
        existing.latitude = st.latitude;
        existing.longitude = st.longitude;
        existing.last_reading_time = st.last_reading_time;
        existing.radius_meters = st.radius_meters || NOISE_RADIUS_METERS;
      }
    });

    if (!animFrameIdRef.current) {
      animFrameIdRef.current = requestAnimationFrame(tickAnimation);
    }

    // Assicura l'aggiornamento JIT del popup se aperto
    if (activePopupStationIdRef.current) {
      const activeSt = stationStatesRef.current.get(activePopupStationIdRef.current);
      if (activeSt) {
        updatePopupDOMIfOpen(activeSt.id, activeSt.currentIntensity, activeSt.last_reading_time);
      }
    }
  }, [stations, isMapLoaded, tickAnimation]);

  useEffect(() => {
    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, []);

  // 3. Gestione della modalità visiva (Sfumature Heatmap / Aureole / Mista)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;

    const showHeatmap = visualMode === 'combined' || visualMode === 'gradient';
    const showCircles = visualMode === 'combined' || visualMode === 'circles';

    if (map.getLayer('noise-webgl-heatmap')) {
      map.setLayoutProperty('noise-webgl-heatmap', 'visibility', showHeatmap ? 'visible' : 'none');
    }
    if (map.getLayer('noise-ambient-halo')) {
      map.setLayoutProperty('noise-ambient-halo', 'visibility', showHeatmap ? 'visible' : 'none');
    }
    if (map.getLayer('noise-hotzone-radiance')) {
      map.setLayoutProperty('noise-hotzone-radiance', 'visibility', showHeatmap ? 'visible' : 'none');
    }
    if (map.getLayer('noise-hotzone-warning-ring')) {
      map.setLayoutProperty('noise-hotzone-warning-ring', 'visibility', showCircles ? 'visible' : 'none');
    }
    if (map.getLayer('noise-15m-fill')) {
      map.setLayoutProperty('noise-15m-fill', 'visibility', showCircles ? 'visible' : 'none');
    }
    if (map.getLayer('noise-15m-stroke')) {
      map.setLayoutProperty('noise-15m-stroke', 'visibility', showCircles ? 'visible' : 'none');
    }
  }, [visualMode, isMapLoaded]);

  // 4. Pan / FlyTo alla stazione selezionata
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded || !selectedStationId) return;

    const station = stations.find((s) => s.id === selectedStationId);
    if (!station) return;

    map.flyTo({
      center: [station.longitude, station.latitude],
      zoom: 16.5,
      essential: true,
      duration: 1200,
    });

    const noise = getNoiseLevel(station.current_intensity);
    const dateStr = station.last_reading_time 
      ? new Date(station.last_reading_time).toLocaleTimeString('it-IT')
      : 'In attesa di dati';

    if (activePopupRef.current) {
      activePopupRef.current.remove();
    }

    activePopupStationIdRef.current = station.id;

    const popup = new maplibregl.Popup({ offset: 14, closeButton: true })
      .setLngLat([station.longitude, station.latitude])
      .setHTML(buildStationPopupHTML(station, station.current_intensity, station.last_reading_time))
      .addTo(map);

    popup.on('close', () => {
      if (activePopupStationIdRef.current === station.id) {
        activePopupStationIdRef.current = null;
      }
      activePopupRef.current = null;
    });

    activePopupRef.current = popup;
  }, [selectedStationId, stations, isMapLoaded]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Contenitore Mappa */}
      <div 
        ref={mapContainerRef} 
        style={{ width: '100%', height: '100%', zIndex: 1 }} 
      />

      {/* BARRA CONTROLLI MAPPA IN ALTO A SINISTRA: STILE + SFUMATURE */}
      <div style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        backgroundColor: 'rgba(255, 255, 255, 0.94)',
        backdropFilter: 'blur(6px)',
        borderRadius: '8px',
        padding: '6px 10px',
        boxShadow: '0 3px 12px rgba(0,0,0,0.15)',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontSize: '11px',
        color: '#334155',
        flexWrap: 'wrap',
      }}>
        {/* SELEZIONE MODALITA' SFUMATURA */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ fontWeight: 600, color: '#0f172a' }}>Effetto Visivo:</span>
          <div style={{ display: 'flex', gap: '3px', backgroundColor: '#f1f5f9', padding: '2px', borderRadius: '5px' }}>
            <button
              onClick={() => setVisualMode('combined')}
              style={{
                padding: '3px 8px',
                backgroundColor: visualMode === 'combined' ? '#2563eb' : 'transparent',
                color: visualMode === 'combined' ? '#ffffff' : '#475569',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: visualMode === 'combined' ? 600 : 400,
              }}
              title="Mostra sia la sfumatura termica che i cerchi a 15 metri"
            >
              Mista (Heatmap + 15m)
            </button>
            <button
              onClick={() => setVisualMode('gradient')}
              style={{
                padding: '3px 8px',
                backgroundColor: visualMode === 'gradient' ? '#2563eb' : 'transparent',
                color: visualMode === 'gradient' ? '#ffffff' : '#475569',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: visualMode === 'gradient' ? 600 : 400,
              }}
              title="Sfumatura termica continua per zone calde e fredde"
            >
              Sfumature Termiche
            </button>
            <button
              onClick={() => setVisualMode('circles')}
              style={{
                padding: '3px 8px',
                backgroundColor: visualMode === 'circles' ? '#2563eb' : 'transparent',
                color: visualMode === 'circles' ? '#ffffff' : '#475569',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: visualMode === 'circles' ? 600 : 400,
              }}
              title="Solo cerchi calibrati a 15 metri"
            >
              Raggio Discreto 15m
            </button>
          </div>
        </div>

        {/* SELEZIONE TEMA MAPPA */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', borderLeft: '1px solid #cbd5e1', paddingLeft: '10px' }}>
          <span style={{ fontWeight: 600 }}>Stile Mappa:</span>
          <button
            onClick={() => setCurrentStyle('positron')}
            style={{
              padding: '2px 7px',
              backgroundColor: currentStyle === 'positron' ? '#0f172a' : '#e2e8f0',
              color: currentStyle === 'positron' ? '#ffffff' : '#334155',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Positron (Chiaro)
          </button>
          <button
            onClick={() => setCurrentStyle('liberty')}
            style={{
              padding: '2px 7px',
              backgroundColor: currentStyle === 'liberty' ? '#0f172a' : '#e2e8f0',
              color: currentStyle === 'liberty' ? '#ffffff' : '#334155',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Liberty
          </button>
        </div>
      </div>

      {/* BADGE COMUNE DI TORINO (MAXBOUNDS) */}
      <div style={{
        position: 'absolute',
        bottom: '24px',
        right: '24px',
        backgroundColor: 'rgba(15, 23, 42, 0.88)',
        color: '#f8fafc',
        borderRadius: '6px',
        padding: '5px 12px',
        fontSize: '11px',
        zIndex: 10,
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#22c55e', display: 'inline-block' }} />
        <span>Ritaglio: <strong>Comune di Torino</strong> (MaxBounds Attivi)</span>
      </div>
    </div>
  );
}
