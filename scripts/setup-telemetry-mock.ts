import { supabase } from '../src/lib/supabase';

// 1. Aislamiento por Mock / Stub (Preferencia A)
// Evita de forma estanca que las peticiones lleguen a la capa de red.
const baseRpc = supabase.rpc;

// Inicializamos el contador de llamadas interceptadas
(globalThis as any).__QA_TELEMETRY_INTERCEPTED_CALLS = 0;
(globalThis as any).__QA_TELEMETRY_EXTERNAL_CALLS = 0;

supabase.rpc = async function(name: string, payload: any) {
  if (name === 'registrar_evento_creacion') {
    (globalThis as any).__QA_TELEMETRY_INTERCEPTED_CALLS++;
    return { data: null, error: null };
  }
  return baseRpc.call(this, name, payload);
} as any;

// 2. Defensa en Profundidad
// Si por alguna razón el mock es evadido (ej. otro cliente supabase, o fetch directo),
// interceptamos a nivel HTTP y forzamos un fallo.
const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = async function(url: string | Request | URL, options?: RequestInit) {
    const urlString = url.toString();
    if (urlString.includes('registrar_evento_creacion')) {
      (globalThis as any).__QA_TELEMETRY_EXTERNAL_CALLS++;
      console.error('\n❌ FATAL: Intento real de invocar registrar_evento_creacion detectado en pruebas automatizadas!');
      console.error('URL bloqueada:', urlString);
      return Promise.reject(new Error('QA_TELEMETRY_REAL_INVOCATION_BLOCKED'));
    }
    return originalFetch.apply(this, [url, options] as any);
  };
}
