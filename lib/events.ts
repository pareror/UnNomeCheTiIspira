import { EventEmitter } from 'events';

// Global singleton per garantire che l'EventEmitter rimanga attivo e condiviso
// tra i route handler e il runtime di Next.js
declare global {
  // eslint-disable-next-line no-var
  var __telemetryEmitter: EventEmitter | undefined;
}

if (!globalThis.__telemetryEmitter) {
  globalThis.__telemetryEmitter = new EventEmitter();
  globalThis.__telemetryEmitter.setMaxListeners(100);
}

export const telemetryEmitter = globalThis.__telemetryEmitter;
