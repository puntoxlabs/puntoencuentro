import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n/i18n';
import { useWizardStore } from '@/store/wizardStore';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { useRepeatEncounterStore, getPendingGuestsFor } from '@/store/repeatEncounterStore';
import {
  applyReusablePayload,
  sendConfirmedInvitations,
  canApplyPayload,
  defaultFavoriteName,
  hasDraftInProgress,
} from '@/lib/repeatEncounter';
import type { EncounterTemplateConfig, ReusablePayload } from '@/types/encounterTemplates';
import { ReuseModeChoice } from '@/components/reuse/ReuseModeChoice';
import { ReuseLinkCandidateHint } from '@/components/reuse/ReuseLinkCandidateHint';
import { ReuseWizardNotice } from '@/components/reuse/ReuseWizardNotice';

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

function makeFixedPayload(
  overrides: Partial<EncounterTemplateConfig> = {},
  invitados: string[] = []
): ReusablePayload {
  return {
    date_mode: 'fixed',
    config: {
      date_mode: 'fixed',
      titulo: 'Asado de los jueves',
      descripcion: 'Traer bebida',
      modalidad: 'presencial',
      lugar_texto: 'Club Social',
      link_virtual: null,
      hora: '21:00',
      duration_minutes: null,
      tipo_invitacion: 'link_general',
      tema: 'amber',
      tema_invitacion: 'friends',
      invitation_template: 'friends_night',
      mostrar_respuestas_a_invitados: true,
      visibilidad_respuestas_invitados: 'summary',
      ...overrides,
    },
    invitados_count: invitados.length,
    invitados,
  };
}

function makeCoordPayload(
  overrides: Partial<EncounterTemplateConfig> = {},
  invitados: string[] = []
): ReusablePayload {
  return {
    date_mode: 'coordination',
    config: {
      date_mode: 'coordination',
      titulo: 'Planning semanal',
      descripcion: 'Revisión de objetivos',
      modalidad: 'virtual',
      lugar_texto: null,
      link_virtual: 'https://meet.google.com/abc-defg-hij',
      hora: null,
      duration_minutes: 45,
      tipo_invitacion: 'individual',
      tema: 'blue',
      tema_invitacion: 'formal',
      invitation_template: 'formal_minimal',
      mostrar_respuestas_a_invitados: true,
      visibilidad_respuestas_invitados: 'detail',
      ...overrides,
    },
    invitados_count: invitados.length,
    invitados,
  };
}

async function run() {
  console.log('\n=== Suite Frontend: Guardar favorito y Repetir encuentro V1 ===\n');

  // 1. Repetición de encuentro de fecha fija (solo plantilla)
  await test('1. applyReusablePayload (fixed, solo plantilla) precarga wizard sin fecha concreta ni encuentro_id ni cancel_reference', () => {
    useWizardStore.getState().reset();
    useWizardStore.getState().setField('encuentro_id', 'old-id-123');
    globalThis.sessionStorage.setItem('cancel_reference', JSON.stringify({ oldId: 'old-id-123' }));

    const res = applyReusablePayload(makeFixedPayload({}, ['alice@example.com']), {
      ownerUserId: 'host-uuid-1',
      includeGuests: false,
    });

    const wiz = useWizardStore.getState();
    assert(res.route === '/create', `Ruta esperada /create, recibida ${res.route}`);
    assert(wiz.titulo === 'Asado de los jueves', 'Título no copiado');
    assert(wiz.descripcion === 'Traer bebida', 'Descripción no copiada');
    assert(wiz.modalidad === 'presencial', 'Modalidad no copiada');
    assert(wiz.lugar_texto === 'Club Social', 'Lugar no copiado');
    assert(wiz.hora === '21:00', 'Hora habitual no conservada');
    assert(wiz.fecha === '', `La fecha concreta debe quedar vacía, recibido: "${wiz.fecha}"`);
    assert(wiz.encuentro_id === null, 'encuentro_id debe limpiarse para generar un encuentro nuevo');
    assert(globalThis.sessionStorage.getItem('cancel_reference') === null, 'cancel_reference debe limpiarse');
    assert(Boolean(wiz.repeat_token), 'repeat_token debe asignarse al borrador');

    const repeatState = useRepeatEncounterStore.getState();
    assert(repeatState.guestEmails.length === 0, 'includeGuests=false no debe guardar invitados');
  });

  // 2. No reutilización automática de link virtual + no persistencia en sessionStorage
  await test('2. Encuentro virtual no copia link_virtual automáticamente ni lo persiste en sessionStorage', () => {
    globalThis.sessionStorage.clear();
    const res = applyReusablePayload(
      makeFixedPayload(
        {
          modalidad: 'virtual',
          lugar_texto: null,
          link_virtual: 'https://zoom.us/j/999888777?pwd=secret',
        },
        ['Ana@Example.com', 'ana@example.com', 'bob@example.com']
      ),
      {
        ownerUserId: 'host-uuid-1',
        includeGuests: true,
      }
    );

    const wiz = useWizardStore.getState();
    assert(wiz.link_virtual === '', 'link_virtual en wizardStore debe iniciar vacío hasta confirmación');

    const repeatState = useRepeatEncounterStore.getState();
    assert(
      repeatState.linkCandidate === 'https://zoom.us/j/999888777?pwd=secret',
      'linkCandidate debe conservarse en memoria para sugerencia explícita'
    );
    assert(
      repeatState.guestEmails.length === 2 &&
        repeatState.guestEmails[0] === 'ana@example.com' &&
        repeatState.guestEmails[1] === 'bob@example.com',
      'guestEmails debe normalizarse y deduplicarse'
    );

    const rawStored = globalThis.sessionStorage.getItem('pe-repeat-encounter-context') || '';
    assert(
      !rawStored.includes('zoom.us') && !rawStored.includes('pwd=secret'),
      'El link virtual privado nunca debe persistirse en sessionStorage'
    );
    assert(res.token.length > 0, 'Debe emitir token de sesión');
  });

  // 3. Repetición de encuentro de coordinación
  await test('3. applyReusablePayload (coordination) limpia opciones y deadline previos y deja virtualLink vacío', () => {
    useCoordinationWizardStore.getState().updateDraft({
      options: [{ id: 'opt-1', date: '2025-05-01', time: '19:00' }],
      responseDeadline: '2025-04-30T18:00',
      virtualLink: 'https://old.link',
    });

    const res = applyReusablePayload(makeCoordPayload({}, ['guest1@example.com']), {
      ownerUserId: 'host-uuid-1',
      includeGuests: true,
    });

    const draft = useCoordinationWizardStore.getState().draft;
    assert(res.route === '/create/coordination', 'Debe dirigir a /create/coordination');
    assert(draft.title === 'Planning semanal', 'Título de coordinación no copiado');
    assert(draft.durationMinutes === 45, 'Duración no copiada');
    assert(draft.options.length === 0, 'Las opciones de fecha anteriores no deben copiarse');
    assert(draft.responseDeadline === null, 'El plazo anterior no debe copiarse');
    assert(draft.virtualLink === '', 'virtualLink no debe precargarse sin confirmación');
    assert(draft.repeatToken === res.token, 'repeatToken debe coincidir con token de sesión');
  });

  // 4. Aislamiento por token de sesión y por usuario propietario
  await test('4. bindEncuentro y getPendingGuestsFor exigen coincidencia de repeatToken y ownerUserId', () => {
    const res = applyReusablePayload(makeFixedPayload({}, ['invitado@example.com']), {
      ownerUserId: 'host-uuid-1',
      includeGuests: true,
    });

    // Si el usuario reinicia el wizard y crea un encuentro normal sin repeat_token:
    const boundUnrelated = useRepeatEncounterStore.getState().bindEncuentro('enc-unrelated', null);
    assert(boundUnrelated === false, 'No debe enlazar cuando repeat_token es null');
    assert(
      getPendingGuestsFor(useRepeatEncounterStore.getState(), 'enc-unrelated', 'host-uuid-1').length === 0,
      'No debe devolver invitados para un encuentro no enlazado'
    );

    // En cambio, con el token activo sí enlaza al encuentro recién creado:
    const boundValid = useRepeatEncounterStore.getState().bindEncuentro('enc-new-valid', res.token);
    assert(boundValid === true, 'Debe enlazar cuando el token coincide');

    const forOwner = getPendingGuestsFor(useRepeatEncounterStore.getState(), 'enc-new-valid', 'host-uuid-1');
    assert(forOwner.length === 1 && forOwner[0] === 'invitado@example.com', 'El propietario recibe sus invitados pendientes');

    const forOtherUser = getPendingGuestsFor(useRepeatEncounterStore.getState(), 'enc-new-valid', 'other-user-uuid');
    assert(forOtherUser.length === 0, 'Otro usuario nunca puede leer los invitados pendientes');
  });

  // 5. Envío confirmado de invitaciones reutilizando la RPC existente (sin auto-envío)
  await test('5. sendConfirmedInvitations envía solo los correos confirmados, maneja duplicados y corta ante rate limit', async () => {
    const sendCalls: string[] = [];
    const summary = await sendConfirmedInvitations(
      'enc-confirm-test',
      ['uno@example.com', 'dos@example.com', 'tres@example.com', 'cuatro@example.com'],
      async (_encId, email) => {
        sendCalls.push(email);
        if (email === 'dos@example.com') {
          return { ok: false, error: 'invitation_already_pending' };
        }
        if (email === 'tres@example.com') {
          return { ok: false, error: 'rate_limit_exceeded' };
        }
        return { ok: true, id: 'inv-1', estado: 'pendiente' };
      }
    );

    assert(sendCalls.length === 3, 'Debe detenerse tras rate_limit_exceeded sin invocar cuatro@example.com');
    assert(summary.sent.length === 1 && summary.sent[0] === 'uno@example.com', 'uno@example.com enviado');
    assert(summary.alreadyInvited.length === 1 && summary.alreadyInvited[0] === 'dos@example.com', 'dos@example.com ya invitado');
    assert(summary.stoppedEarly === true, 'Debe marcar stoppedEarly ante rate_limit_exceeded');
    assert(summary.remaining.length === 1 && summary.remaining[0] === 'cuatro@example.com', 'cuatro@example.com queda en remaining');
  });

  // 6. Hint de enlace virtual requiere acción explícita
  await test('6. ReuseLinkCandidateHint muestra el enlace candidato solo cuando el campo está vacío', () => {
    applyReusablePayload(
      makeFixedPayload({
        modalidad: 'virtual',
        link_virtual: 'https://meet.google.com/xyz-uvwx-rst',
      }),
      {
        ownerUserId: 'host-uuid-1',
        includeGuests: false,
      }
    );

    const htmlWhenEmpty = renderToStaticMarkup(
      <ReuseLinkCandidateHint currentValue="" onConfirmReuse={() => {}} />
    );
    assert(
      htmlWhenEmpty.includes('Usar este enlace') || htmlWhenEmpty.includes('Use this link'),
      'Debe mostrar el botón explícito para reutilizar el enlace cuando el input está vacío'
    );

    const htmlWhenFilled = renderToStaticMarkup(
      <ReuseLinkCandidateHint currentValue="https://meet.google.com/otro" onConfirmReuse={() => {}} />
    );
    assert(htmlWhenFilled === '', 'No debe mostrarse si el organizador ya completó un enlace');
  });

  // 7. Restricciones para sesiones anónimas vs cuentas permanentes
  await test('7. Restricciones de cuenta anónima en applyReusablePayload y ReuseModeChoice', () => {
    // Incluso si se pasa includeGuests: true, si ownerUserId es null (sin sesión permanente) no guarda correos
    applyReusablePayload(makeFixedPayload({}, ['secreto@example.com']), {
      ownerUserId: null,
      includeGuests: true,
    });
    assert(
      useRepeatEncounterStore.getState().guestEmails.length === 0,
      'Sin ownerUserId no debe retener correos de invitados'
    );

    const modeHtmlAnon = renderToStaticMarkup(
      <ReuseModeChoice
        value="template_only"
        onChange={() => {}}
        guestCount={3}
        guestsAllowed={false}
      />
    );
    assert(
      modeHtmlAnon.includes('disabled=""') || modeHtmlAnon.includes('disabled'),
      'La opción con invitados debe estar deshabilitada cuando guestsAllowed=false'
    );
  });

  // 8. Utilidades de nombre por defecto, detección de borrador y aviso en wizard
  await test('8. defaultFavoriteName, canApplyPayload, hasDraftInProgress y ReuseWizardNotice funcionan correctamente', () => {
    assert(defaultFavoriteName('  Cena mensual  ') === 'Cena mensual', 'Debe recortar espacios');
    assert(defaultFavoriteName('A'.repeat(120)).length === 80, 'Debe truncar a 80 caracteres');
    assert(canApplyPayload(makeFixedPayload()) === true, 'Payload fixed aplicable');

    useWizardStore.getState().reset();
    useCoordinationWizardStore.getState().resetDraft();
    assert(hasDraftInProgress() === false, 'Wizards limpios no deben reportar borrador en curso');
    useWizardStore.getState().setField('titulo', 'Borrador activo');
    assert(hasDraftInProgress() === true, 'Wizard con título debe reportar borrador en curso');

    const noticeHtml = renderToStaticMarkup(<ReuseWizardNotice active={true} />);
    assert(noticeHtml.includes('pe-reuse-notice'), 'ReuseWizardNotice debe renderizar el aviso cuando active=true');
    assert(renderToStaticMarkup(<ReuseWizardNotice active={false} />) === '', 'ReuseWizardNotice oculto cuando active=false');
  });

  console.log(`\nResultado Frontend: ${passed} pasaron, ${failed} fallaron.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
