import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n/i18n';
import { AuthContext } from '@/contexts/AuthContext';
import {
  defaultAliasFromEmail,
  filterContactsByQuery,
  filterSuggestionsByQuery,
  normalizeContactEmail,
  sortContacts,
} from '@/services/userContactsService';
import { useContactsStore } from '@/store/contactsStore';
import { getPendingGuestsFor, useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import { applyReusablePayload, sendConfirmedInvitations } from '@/lib/repeatEncounter';
import { ContactsSheet } from '@/components/contacts/ContactsSheet';
import { PendingGuestsReview } from '@/components/reuse/PendingGuestsReview';
import type { ContactSuggestion, UserContact } from '@/types/userContacts';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

if (typeof globalThis.sessionStorage === 'undefined') {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`❌ FAIL: ${name}`);
    console.error('   ', err?.message || err);
    failed++;
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const permanentAuthValue: any = {
  user: { id: 'user-perm-1', is_anonymous: false },
  session: {},
  loading: false,
  isAuthenticated: true,
  isAnonymousUser: false,
  isPermanentUser: true,
  signInWithGoogle: async () => ({ ok: true }),
  signInWithGoogleForCoordination: async () => ({ ok: true }),
  signInWithGoogleForDiscovery: async () => ({ ok: true }),
  checkAnonymousUpgradeState: async () => null,
  createTransferTicket: async () => ({ ok: false }),
  signOut: async () => {},
};

const anonAuthValue: any = {
  ...permanentAuthValue,
  user: { id: 'user-anon-1', is_anonymous: true },
  isAnonymousUser: true,
  isPermanentUser: false,
};

await test('1. Normalización, alias sugerido, ordenamiento por favoritos y búsqueda por nombre o correo', () => {
  assert(
    normalizeContactEmail('  Juan.Perez@Correo.COM ') === 'juan.perez@correo.com',
    'normalizeContactEmail debe recortar y pasar a minúsculas'
  );
  assert(
    defaultAliasFromEmail('maria.gomez_futbol@ejemplo.com') === 'Maria Gomez Futbol',
    'defaultAliasFromEmail debe generar un alias legible desde la parte local'
  );

  const sample: UserContact[] = [
    { id: '1', nombre: 'Zoe', email: 'zoe@mail.com', es_favorito: false },
    { id: '2', nombre: 'Carlos', email: 'carlos@mail.com', es_favorito: true },
    { id: '3', nombre: 'Ana', email: 'ana@empresa.com', es_favorito: false },
    { id: '4', nombre: 'Beto', email: 'beto@club.com', es_favorito: true },
  ];

  const sorted = sortContacts(sample);
  assert(
    sorted.map((c) => c.nombre).join(',') === 'Beto,Carlos,Ana,Zoe',
    'sortContacts debe destacar primero los favoritos y luego ordenar alfabéticamente'
  );

  const byName = filterContactsByQuery(sample, 'car');
  assert(byName.length === 1 && byName[0].email === 'carlos@mail.com', 'Búsqueda por nombre');

  const byEmail = filterContactsByQuery(sample, 'EMPRESA.com');
  assert(byEmail.length === 1 && byEmail[0].nombre === 'Ana', 'Búsqueda por correo');

  const suggestions: ContactSuggestion[] = [
    { email: 'ana@empresa.com', veces_invitado: 3, ultima_invitacion_at: '2026-10-10T10:00:00Z' },
    { email: 'nuevo.historico@mail.com', veces_invitado: 2, ultima_invitacion_at: '2026-10-11T10:00:00Z' },
    { email: 'NUEVO.HISTORICO@mail.com', veces_invitado: 1, ultima_invitacion_at: '2026-10-09T10:00:00Z' },
  ];
  const savedSet = new Set(sample.map((c) => c.email));
  const filteredSug = filterSuggestionsByQuery(suggestions, savedSet, '');
  assert(
    filteredSug.length === 1 && filteredSug[0].email === 'nuevo.historico@mail.com',
    'filterSuggestionsByQuery debe excluir contactos ya guardados y deduplicar sugerencias'
  );
});

await test('2. Selección múltiple, deduplicación, bloqueo de ya invitados y limpieza al cambiar de sesión', () => {
  const store = useContactsStore.getState();
  store.reset();

  store.setData('user-perm-1', {
    contactos: [
      { id: 'c1', nombre: 'Martín', email: 'martin@mail.com', es_favorito: true },
      { id: 'c2', nombre: 'Sofía', email: 'sofia@mail.com', es_favorito: false },
    ],
    sugerencias: [
      { email: 'frecuente@mail.com', veces_invitado: 3, ultima_invitacion_at: '2026-10-15T00:00:00Z' },
    ],
    ya_invitados_encuentro: ['sofia@mail.com'],
  });

  // Seleccionar contacto válido y sugerencia
  useContactsStore.getState().toggleSelectEmail('MARTIN@mail.com');
  useContactsStore.getState().toggleSelectEmail('frecuente@mail.com');
  // Intentar seleccionar alguien que ya está invitado en este encuentro -> ignorado
  useContactsStore.getState().toggleSelectEmail('sofia@mail.com');

  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'martin@mail.com,frecuente@mail.com',
    'Solo se seleccionan destinatarios no invitados aún en este encuentro'
  );

  // Guardar la sugerencia 'frecuente@mail.com' como contacto -> desaparece de suggestions
  useContactsStore.getState().upsertContact({
    id: 'c3',
    nombre: 'Frecuente Amigo',
    email: 'frecuente@mail.com',
    es_favorito: false,
  });
  assert(
    useContactsStore.getState().suggestions.length === 0,
    'Al guardar una sugerencia como contacto desaparece de sugerencias para evitar duplicados'
  );

  // Quitar a uno de la selección
  useContactsStore.getState().unselectEmail('martin@mail.com');
  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'frecuente@mail.com',
    'unselectEmail quita correctamente al contacto de la selección'
  );

  // Cambiar de usuario o cerrar sesión limpia inmediatamente la agenda y selección en memoria
  useContactsStore.getState().ensureSession('user-perm-2');
  assert(
    useContactsStore.getState().contacts.length === 0 &&
      useContactsStore.getState().selectedEmails.length === 0 &&
      useContactsStore.getState().ownerUserId === 'user-perm-2',
    'ensureSession debe limpiar contactos y selección al cambiar de usuario'
  );

  useContactsStore.getState().reset();
  assert(useContactsStore.getState().ownerUserId === null, 'reset limpia completamente el store');
});

await test('3. Errores parciales y rate limit conservan pendientes y evitan duplicados en reintentos', async () => {
  const store = useContactsStore.getState();
  store.reset();
  store.setData('user-perm-1', {
    contactos: [
      { id: 'c1', nombre: 'Uno', email: 'uno@mail.com', es_favorito: false },
      { id: 'c2', nombre: 'Dos', email: 'dos@mail.com', es_favorito: false },
      { id: 'c3', nombre: 'Tres', email: 'tres@mail.com', es_favorito: false },
    ],
    sugerencias: [],
    ya_invitados_encuentro: [],
  });
  store.selectEmails(['uno@mail.com', 'dos@mail.com', 'tres@mail.com']);

  const sentCalls: string[] = [];
  // Primera corrida: 'uno@mail.com' se envía OK, 'dos@mail.com' falla por rate_limit_exceeded -> se detiene
  const res1 = await sendConfirmedInvitations(
    'enc-100',
    useContactsStore.getState().selectedEmails,
    async (_id, email) => {
      sentCalls.push(email);
      if (email === 'uno@mail.com') return { ok: true };
      return { ok: false, error: 'rate_limit_exceeded' };
    },
    (doneEmail) => useContactsStore.getState().unselectEmail(doneEmail)
  );

  assert(res1.stoppedEarly === true, 'Debe detenerse ante rate_limit_exceeded');
  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'dos@mail.com,tres@mail.com',
    'Los correos aún no enviados (dos y tres) deben conservarse en la selección pendiente'
  );

  // Reintento: solo se envían los pendientes ('dos@mail.com' y 'tres@mail.com'), sin duplicar 'uno@mail.com'
  const res2 = await sendConfirmedInvitations(
    'enc-100',
    useContactsStore.getState().selectedEmails,
    async (_id, email) => {
      sentCalls.push(email);
      return { ok: true };
    },
    (doneEmail) => useContactsStore.getState().unselectEmail(doneEmail)
  );

  assert(res2.sent.length === 2, 'En el reintento se envían los 2 restantes');
  assert(
    useContactsStore.getState().selectedEmails.length === 0,
    'Tras completar el reintento la selección queda vacía'
  );
  assert(
    sentCalls.filter((e) => e === 'uno@mail.com').length === 1,
    'uno@mail.com no fue reenviado ni duplicado en el reintento'
  );
});

await test('4. Compatibilidad con Favoritos y Repetir encuentro: sumar contactos de la agenda a invitados recuperados', () => {
  useRepeatEncounterStore.getState().reset();
  useContactsStore.getState().reset();

  // Simular repetición de un encuentro con 1 invitado recuperado del encuentro original
  const { token } = applyReusablePayload(
    {
      origen: 'plantilla',
      id: 'tpl-1',
      nombre: 'Fútbol Semanal',
      date_mode: 'fixed',
      config: {
        titulo: 'Fútbol 5',
        modalidad: 'presencial',
        lugar_texto: 'Cancha Norte',
        tipo_invitacion: 'link_general',
      },
      invitados_count: 1,
      invitados: ['recuperado@mail.com'],
    },
    { ownerUserId: 'user-perm-1', includeGuests: true }
  );

  const bound = useRepeatEncounterStore.getState().bindEncuentro('enc-nuevo-99', token);
  assert(bound === true, 'Invitado recuperado queda vinculado al nuevo encuentro');

  // El organizador abre Mis contactos y suma 2 contactos (uno nuevo + uno repetido para probar deduplicación)
  useRepeatEncounterStore
    .getState()
    .addGuestsForEncuentro('enc-nuevo-99', 'user-perm-1', [
      'NUEVO.AGENDA@mail.com',
      'recuperado@mail.com',
    ]);

  const pending = getPendingGuestsFor(
    useRepeatEncounterStore.getState(),
    'enc-nuevo-99',
    'user-perm-1'
  );
  assert(
    pending.join(',') === 'recuperado@mail.com,nuevo.agenda@mail.com',
    'La revisión del encuentro repetido combina invitados recuperados + nuevos contactos sin duplicados'
  );
});

await test('5. Renderizado SSR de ContactsSheet (lista, distinción guardados vs sugerencias, revisión) y restricción anónima', () => {
  const sampleContacts: UserContact[] = [
    { id: 'c1', nombre: 'Martín Arquero', email: 'martin@club.com', es_favorito: true },
  ];
  const sampleSuggestions: ContactSuggestion[] = [
    { email: 'historico@club.com', veces_invitado: 3, ultima_invitacion_at: '2026-10-18T12:00:00Z' },
  ];

  // Usuario anónimo -> no renderiza nada
  const anonHtml = renderToStaticMarkup(
    <AuthContext.Provider value={anonAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        encuentroId="enc-1"
        initialContacts={sampleContacts}
        initialSuggestions={sampleSuggestions}
      />
    </AuthContext.Provider>
  );
  assert(anonHtml === '', 'ContactsSheet no debe renderizarse para usuarios anónimos');

  // Usuario permanente en vista de lista -> muestra contactos guardados, insignia Favorito y sección de sugerencias del historial
  useContactsStore.getState().reset();
  useContactsStore.getState().setData('user-perm-1', {
    contactos: sampleContacts,
    sugerencias: sampleSuggestions,
    ya_invitados_encuentro: [],
  });
  useContactsStore.getState().selectEmails(['martin@club.com', 'historico@club.com']);

  const listHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        encuentroId="enc-1"
        initialContacts={sampleContacts}
        initialSuggestions={sampleSuggestions}
      />
    </AuthContext.Provider>
  );
  assert(listHtml.includes('Martín Arquero'), 'Debe mostrar el nombre del contacto guardado');
  assert(listHtml.includes('Favorito'), 'Debe destacar el contacto favorito');
  assert(
    listHtml.includes('Sugerencias de invitaciones anteriores') &&
      listHtml.includes('historico@club.com') &&
      listHtml.includes('Invitado 3 veces'),
    'Debe distinguir claramente las sugerencias del historial de los contactos guardados'
  );
  assert(
    listHtml.includes('Revisar selección (2)'),
    'Debe mostrar el botón para pasar a la revisión previa al envío'
  );

  // Vista de revisión antes de enviar
  const reviewHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        encuentroId="enc-1"
        initialContacts={sampleContacts}
        initialSuggestions={sampleSuggestions}
        initialStep="review"
      />
    </AuthContext.Provider>
  );
  assert(
    reviewHtml.includes('Martín Arquero (martin@club.com)') &&
      reviewHtml.includes('historico@club.com') &&
      reviewHtml.includes('Confirmar y enviar (2)'),
    'La vista de revisión debe listar los destinatarios seleccionados y exigir confirmación expresa'
  );

  // PendingGuestsReview muestra el nombre del contacto si el correo está agendado y ofrece el botón Agregar de Mis contactos
  const pendingHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <PendingGuestsReview encuentroId="enc-nuevo-99" onOpenContacts={() => {}} />
    </AuthContext.Provider>
  );
  assert(
    pendingHtml.includes('Agregar de Mis contactos'),
    'PendingGuestsReview debe permitir abrir Mis contactos para sumar invitados al encuentro repetido'
  );
});

if (failed > 0) {
  console.error(`\n❌ Contactos frecuentes V1 Frontend tests failed: ${failed} failed, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} Contactos frecuentes V1 Frontend tests passed!`);
}
