import { NextRequest } from 'next/server';
import { telemetryEmitter } from '@/lib/events';
import { getStationsLive } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const filter = (url.searchParams.get('filter') || 'live_only') as 'all' | 'live_only' | 'dummy_only';
  const encoder = new TextEncoder();

  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (eventName: string, data: any) => {
        if (isClosed) return;
        try {
          const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Controller might have closed
          isClosed = true;
        }
      };

      // 1. Snapshot iniziale Just-in-Time: invia lo stato attuale immediato di tutte le stazioni
      try {
        const initialStations = getStationsLive(filter);
        sendEvent('init', {
          stations: initialStations,
          timestamp: Date.now(),
          filter,
        });
      } catch (err) {
        console.error('Errore nel recupero snapshot iniziale stazioni:', err);
      }

      // 2. Ascolto real-time dei campionamenti in arrivo da Arduino o simulatore
      const onReading = (stationData: any) => {
        if (isClosed) return;
        // Se il client vuole solo le stazioni reali hardware, scarta gli eventi dummy
        if (filter === 'live_only' && stationData.is_dummy) {
          return;
        }
        sendEvent('reading', {
          station: stationData,
          timestamp: Date.now(),
        });
      };

      telemetryEmitter.on('reading', onReading);

      // 3. Heartbeat (comment ping) ogni 15s per mantenere il canale aperto ed evitare timeout TCP/Proxy
      const heartbeatInterval = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeatInterval);
          return;
        }
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          isClosed = true;
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      // 4. Pulizia automatica alla disconnessione del client browser
      request.signal.addEventListener('abort', () => {
        isClosed = true;
        telemetryEmitter.off('reading', onReading);
        clearInterval(heartbeatInterval);
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
    },
    cancel() {
      isClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
