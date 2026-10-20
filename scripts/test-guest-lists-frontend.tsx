import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n/i18n';
import { AuthContext } from '@/contexts/AuthContext';
import {
  combineGuestSelections,
  filterGuestListsByQuery,
  isValidContactEmail,
  normalizeContactEmail,
  normalizeGuestEmailList,
  parseEmailInputBatch,
  sortGuestLists,
} from '@/services/userContactsService';
import { useContactsStore } from '@/store/contactsStore';
import { getPendingGuestsFor, useRepeatEncounterStore } from '@/store/repeatEncounterStore';
import { applyReusablePayload, sendConfirmedInvitations } from '@/lib/repeatEncounter';
import { ContactsSheet } from '@/components/contacts/ContactsSheet';
import { PendingGuestsReview } from '@/components/reuse/PendingGuestsReview';
import type { GuestList, GuestListSuggestion, UserContact } from '@/types/userContacts';

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

await test('1. Helpers de listas: validación de correo, normalización, parseo en lote, ordenamiento y combinación', () => {
  // Validación de correos
  assert(isValidContactEmail('valido@ejemplo.com') === true, 'valido@ejemplo.com debe ser válido');
  assert(isValidContactEmail('invalido.sin.arroba.com') === false, 'sin arroba debe ser inválido');
  assert(isValidContactEmail('con espacios@mail.com') === false, 'con espacios debe ser inválido');
  assert(isValidContactEmail('sin-punto@dominio') === false, 'sin punto en dominio debe ser inválido');

  // Normalización y deduplicación
  const norm = normalizeGuestEmailList([
    '  Ana@CORREO.com ',
    'beto@mail.com',
    'ANA@correo.com',
    '',
    null,
    '  ',
    'carlos@mail.com',
  ]);
  assert(
    norm.join(',') === 'ana@correo.com,beto@mail.com,carlos@mail.com',
    'normalizeGuestEmailList debe recortar, pasar a minúsculas y deduplicar en orden'
  );

  // Parseo en lote con separadores mixtos (comas, punto y coma, espacios, saltos de línea)
  const parsed = parseEmailInputBatch('  lucas@club.com, maria@empresa.com; err-email \n pedro@colegio.com ');
  assert(
    parsed.valid.join(',') === 'lucas@club.com,maria@empresa.com,pedro@colegio.com',
    'parseEmailInputBatch debe separar y normalizar correos válidos'
  );
  assert(
    parsed.invalid.join(',') === 'err-email',
    'parseEmailInputBatch debe reportar correos con sintaxis inválida'
  );

  // Ordenamiento alfabético por nombre
  const sampleLists: GuestList[] = [
    { id: '1', nombre: 'Zumba', destinatarios_emails: ['z@mail.com'], destinatarios_count: 1 },
    { id: '2', nombre: 'Amigos Fútbol', destinatarios_emails: ['f@mail.com'], destinatarios_count: 1 },
    { id: '3', nombre: 'Compañeros Trabajo', destinatarios_emails: ['c@mail.com'], destinatarios_count: 1 },
  ];
  const sorted = sortGuestLists(sampleLists);
  assert(
    sorted.map((l) => l.nombre).join(',') === 'Amigos Fútbol,Compañeros Trabajo,Zumba',
    'sortGuestLists debe ordenar alfabéticamente por nombre en español'
  );

  // Filtrado por consulta (por nombre o por correo de integrantes)
  const byName = filterGuestListsByQuery(sampleLists, 'fútbol');
  assert(byName.length === 1 && byName[0].id === '2', 'Filtrado por nombre de lista');

  const byEmail = filterGuestListsByQuery(sampleLists, 'c@MAIL.com');
  assert(byEmail.length === 1 && byEmail[0].id === '3', 'Filtrado por correo de integrante');

  // Combinación de listas y correos individuales sin duplicados
  const combined = combineGuestSelections(
    ['ana@mail.com', 'beto@mail.com'],
    sampleLists[1], // f@mail.com
    ['BETO@mail.com', 'carlos@mail.com']
  );
  assert(
    combined.join(',') === 'ana@mail.com,beto@mail.com,f@mail.com,carlos@mail.com',
    'combineGuestSelections debe unificar múltiples listas y correos normalizando y deduplicando'
  );
});

await test('2. Store de listas: selección, combinación, exclusión de ya invitados e independencia de contactos', () => {
  const store = useContactsStore.getState();
  store.reset();

  const sampleLists: GuestList[] = [
    {
      id: 'l1',
      nombre: 'Familia',
      destinatarios_emails: ['mama@familia.com', 'papa@familia.com', 'hermano@familia.com'],
      destinatarios_count: 3,
    },
    {
      id: 'l2',
      nombre: 'Fútbol',
      destinatarios_emails: ['hermano@familia.com', 'arquero@futbol.com', 'delantero@futbol.com'],
      destinatarios_count: 3,
    },
  ];

  store.setListsData('user-perm-1', {
    listas: sampleLists,
    sugerencias_listas: [],
    ya_invitados_encuentro: ['papa@familia.com'],
  });

  // Seleccionar la lista "Familia" -> papa ya está invitado, así que se seleccionan mama y hermano
  useContactsStore.getState().selectList(sampleLists[0]);
  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'mama@familia.com,hermano@familia.com',
    'selectList no debe incorporar a personas ya invitadas al encuentro'
  );

  // Seleccionar la lista "Fútbol" -> se combinan hermano (ya estaba), arquero y delantero sin duplicar hermano
  useContactsStore.getState().selectList(sampleLists[1]);
  assert(
    useContactsStore.getState().selectedEmails.join(',') ===
      'mama@familia.com,hermano@familia.com,arquero@futbol.com,delantero@futbol.com',
    'Combinar varias listas debe generar la unión deduplicada en la selección'
  );

  // Deseleccionar una lista completa
  useContactsStore.getState().unselectList(sampleLists[0]);
  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'arquero@futbol.com,delantero@futbol.com',
    'unselectList debe quitar los destinatarios de esa lista de la selección'
  );

  // INDEPENDENCIA CONTACTOS VS LISTAS:
  // Crear un contacto y luego eliminarlo no altera las listas guardadas
  useContactsStore.getState().upsertContact({
    id: 'c1',
    nombre: 'Hermano',
    email: 'hermano@familia.com',
    es_favorito: false,
  });
  useContactsStore.getState().removeContact('c1');
  const listsAfter = useContactsStore.getState().lists;
  assert(
    listsAfter[0].destinatarios_emails.includes('hermano@familia.com'),
    'Eliminar un contacto de la agenda jamás altera los destinatarios guardados en una lista'
  );

  // Limpieza de listas y selecciones al cambiar de usuario o cerrar sesión
  useContactsStore.getState().ensureSession('user-perm-2');
  assert(
    useContactsStore.getState().lists.length === 0 &&
      useContactsStore.getState().selectedEmails.length === 0 &&
      useContactsStore.getState().ownerUserId === 'user-perm-2',
    'ensureSession debe limpiar las listas y selecciones al cambiar de usuario'
  );

  useContactsStore.getState().reset();
  assert(useContactsStore.getState().ownerUserId === null, 'reset limpia completamente el store');
});

await test('3. Revisión previa, envíos parciales, reintentos seguros y adición de correo en revisión', async () => {
  const store = useContactsStore.getState();
  store.reset();
  store.setListsData('user-perm-1', {
    listas: [
      {
        id: 'l1',
        nombre: 'Grupo Test',
        destinatarios_emails: ['dest1@mail.com', 'dest2@mail.com', 'dest3@mail.com'],
        destinatarios_count: 3,
      },
    ],
    sugerencias_listas: [],
    ya_invitados_encuentro: [],
  });

  store.selectEmails(['dest1@mail.com', 'dest2@mail.com', 'dest3@mail.com']);

  const sentCalls: string[] = [];
  // Simulación: dest1 ok, dest2 falla por rate limit -> se detiene
  const res1 = await sendConfirmedInvitations(
    'enc-200',
    useContactsStore.getState().selectedEmails,
    async (_id, email) => {
      sentCalls.push(email);
      if (email === 'dest1@mail.com') return { ok: true };
      return { ok: false, error: 'rate_limit_exceeded' };
    },
    (doneEmail) => useContactsStore.getState().unselectEmail(doneEmail)
  );

  assert(res1.stoppedEarly === true, 'Se detiene inmediatamente ante rate_limit_exceeded');
  assert(
    useContactsStore.getState().selectedEmails.join(',') === 'dest2@mail.com,dest3@mail.com',
    'Los destinatarios aún no enviados (dest2 y dest3) se conservan intactos en la selección'
  );

  // Reintento: solo se envían los pendientes sin duplicar dest1
  const res2 = await sendConfirmedInvitations(
    'enc-200',
    useContactsStore.getState().selectedEmails,
    async (_id, email) => {
      sentCalls.push(email);
      return { ok: true };
    },
    (doneEmail) => useContactsStore.getState().unselectEmail(doneEmail)
  );

  assert(res2.sent.length === 2, 'El reintento procesa los 2 restantes');
  assert(useContactsStore.getState().selectedEmails.length === 0, 'La selección queda vacía tras finalizar');
  assert(
    sentCalls.filter((e) => e === 'dest1@mail.com').length === 1,
    'dest1@mail.com no fue reenviado ni duplicado en el reintento'
  );
});

await test('4. Integración con Favoritos/Repetir: combinar listas con invitados recuperados y guardar como lista', () => {
  useRepeatEncounterStore.getState().reset();
  useContactsStore.getState().reset();

  const { token } = applyReusablePayload(
    {
      origen: 'plantilla',
      id: 'tpl-fav-1',
      nombre: 'Asado Mensual',
      date_mode: 'fixed',
      config: {
        titulo: 'Asado Mensual',
        modalidad: 'presencial',
        lugar_texto: 'Club',
        tipo_invitacion: 'link_general',
      },
      invitados_count: 1,
      invitados: ['recuperado@mail.com'],
    },
    { ownerUserId: 'user-perm-1', includeGuests: true }
  );

  useRepeatEncounterStore.getState().bindEncuentro('enc-nuevo-55', token);

  // Agregar destinatarios de una lista a la revisión pendiente del nuevo encuentro
  useRepeatEncounterStore
    .getState()
    .addGuestsForEncuentro('enc-nuevo-55', 'user-perm-1', [
      'NUEVO.LISTA@mail.com',
      'recuperado@mail.com',
      'segundo.lista@mail.com',
    ]);

  const pending = getPendingGuestsFor(
    useRepeatEncounterStore.getState(),
    'enc-nuevo-55',
    'user-perm-1'
  );
  assert(
    pending.join(',') === 'recuperado@mail.com,nuevo.lista@mail.com,segundo.lista@mail.com',
    'La revisión combina invitados recuperados del encuentro repetido + lista de invitados sin duplicados'
  );

  // Guardar ese conjunto combinado como una nueva lista reutilizable
  const combinedListEmails = combineGuestSelections(pending);
  assert(combinedListEmails.length === 3, 'El conjunto combinado está normalizado y listo para guardarse como lista');
});

await test('5. Renderizado SSR de ContactsSheet en pestaña Mis listas, sugerencias de historial y PendingGuestsReview', () => {
  const sampleLists: GuestList[] = [
    {
      id: 'l1',
      nombre: 'Compañeros de Pádel',
      destinatarios_emails: ['padel1@mail.com', 'padel2@mail.com'],
      destinatarios_count: 2,
    },
  ];

  const sampleSuggestions: GuestListSuggestion[] = [
    {
      emails: ['historico1@mail.com', 'historico2@mail.com', 'historico3@mail.com'],
      destinatarios_count: 3,
      veces_usado: 2,
      ultima_invitacion_at: '2026-10-18T10:00:00Z',
      nombre_sugerido: 'Fútbol Semanal',
    },
  ];

  // Usuario anónimo -> no renderiza nada
  const anonHtml = renderToStaticMarkup(
    <AuthContext.Provider value={anonAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        initialTab="lists"
        initialLists={sampleLists}
        initialListSuggestions={sampleSuggestions}
      />
    </AuthContext.Provider>
  );
  assert(anonHtml === '', 'ContactsSheet no debe renderizarse para usuarios anónimos');

  // Usuario permanente en pestaña Mis listas
  useContactsStore.getState().reset();
  useContactsStore.getState().setListsData('user-perm-1', {
    listas: sampleLists,
    sugerencias_listas: sampleSuggestions,
    ya_invitados_encuentro: [],
  });

  const listsHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        encuentroId="enc-test-1"
        initialTab="lists"
        initialLists={sampleLists}
        initialListSuggestions={sampleSuggestions}
      />
    </AuthContext.Provider>
  );

  assert(listsHtml.includes('Compañeros de Pádel'), 'Debe renderizar el nombre de la lista guardada');
  assert(listsHtml.includes('2 destinatario(s)'), 'Debe mostrar la cantidad de destinatarios');
  assert(
    listsHtml.includes('Conjuntos sugeridos de encuentros anteriores'),
    'Debe mostrar la sección de sugerencias de grupos implícitos'
  );
  assert(
    listsHtml.includes('Fútbol Semanal') && listsHtml.includes('Reutilizado 2 veces'),
    'Debe destacar la sugerencia con su título sugerido y badge de reutilización'
  );
  assert(
    listsHtml.includes('Guardar como lista'),
    'Debe mostrar el botón Guardar como lista en las sugerencias del historial'
  );

  // Formulario de creación de lista abierto con sugerencia o borrador
  const formHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <ContactsSheet
        isOpen={true}
        onClose={() => {}}
        initialTab="lists"
        initialListFormOpen={true}
        initialDraftListName="Amigos de la Vida"
        initialDraftListEmails={['amigo1@mail.com', 'amigo2@mail.com']}
      />
    </AuthContext.Provider>
  );
  assert(formHtml.includes('Crear lista'), 'Debe renderizar el título del formulario de lista');
  assert(formHtml.includes('Amigos de la Vida'), 'Debe precompletar el nombre de la lista');
  assert(formHtml.includes('amigo1@mail.com') && formHtml.includes('amigo2@mail.com'), 'Debe mostrar los destinatarios precompletados en chips');

  // PendingGuestsReview con botones para agregar desde lista y guardar como lista
  const pendingHtml = renderToStaticMarkup(
    <AuthContext.Provider value={permanentAuthValue}>
      <PendingGuestsReview
        encuentroId="enc-nuevo-55"
        onOpenContacts={() => {}}
        onOpenLists={() => {}}
        onSaveAsList={() => {}}
      />
    </AuthContext.Provider>
  );
  assert(
    pendingHtml.includes('Agregar desde una lista'),
    'PendingGuestsReview debe incluir el botón para agregar desde una lista'
  );
  assert(
    pendingHtml.includes('Guardar como lista'),
    'PendingGuestsReview debe incluir el botón para guardar los invitados recuperados como lista'
  );
});

if (failed > 0) {
  console.error(`\n❌ Listas reutilizables de invitados V1 Frontend tests failed: ${failed} failed, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} Listas reutilizables de invitados V1 Frontend tests passed!`);
}
