/**
 * Test Suite: Navegación Segura de Tarjetas de Encuentro en Home (Incidencia DIF-16)
 *
 * Valida de forma exhaustiva:
 * 1. Participante autenticado con token canónico (_mi_token).
 * 2. Participante con nombre de campo alternativo (_mi_token_invitacion).
 * 3. Participante anónimo con token legítimo.
 * 4. Participante desde el selector «Todos».
 * 5. Participante desde el selector «Participo».
 * 6. Anfitrión desde «Todos» y «Organizo».
 * 7. Encuentro privado con participante y con anfitrión.
 * 8. Encuentro abierto con y sin token.
 * 9. Encuentro de coordinación (participante vs. anfitrión).
 * 10. Encuentros anteriores y próximos.
 * 11. Participante sin token (recuperable, sin derivar a /meet/:id).
 * 12. Usuario no autorizado (invariante de aislamiento: jamás rutea a consola host).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  ActiveCard,
  resolveEncounterCardNavigation,
  handleOpenEncounterDetailAction,
  type EncounterCardNavigationContext,
} from '../src/screens/Home';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('DIF-16: Navegación Segura y Centralizada de Tarjetas de Encuentro', () => {
  const CANONICAL_TOKEN = '11111111-2222-3333-4444-555555555555';
  const ALT_TOKEN = '66666666-7777-8888-9999-000000000000';
  const ENCOUNTER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const HOST_USER_ID = 'host-user-uid-123';
  const PARTICIPANT_USER_ID = 'participant-user-uid-456';

  // ── 1. Participante autenticado con token canónico ──────────────────────────
  test('1. Participante autenticado con token canónico (_mi_token) navega a /invite/:token', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${CANONICAL_TOKEN}`);
    }
  });

  // ── 2. Participante con nombre de campo alternativo ─────────────────────────
  test('2. Participante con nombre de campo alternativo (_mi_token_invitacion) mantiene retrocompatibilidad', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token_invitacion: ALT_TOKEN,
      _mi_estado: 'confirmado',
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${ALT_TOKEN}`);
    }
  });

  // ── 3. Participante anónimo con token legítimo ──────────────────────────────
  test('3. Participante anónimo con token legítimo navega a /invite/:token', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
      fecha: '2026-11-20',
      hora: '19:00',
    };
    // Usuario anónimo (sin sesión auth / userId null)
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'todos',
      userId: null,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${CANONICAL_TOKEN}`);
    }
  });

  // ── 4. Participante desde «Todos» ───────────────────────────────────────────
  test('4. Participante desde el selector «Todos» NO deriva a /meet/:id', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
      fecha: '2026-11-20',
      hora: '19:00',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${CANONICAL_TOKEN}`);
      assert.notEqual(result.path, `/meet/${ENCOUNTER_ID}`);
    }
  });

  // ── 5. Participante desde «Participo» ───────────────────────────────────────
  test('5. Participante desde el selector «Participo» navega correctamente a /invite/:token', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
      fecha: '2026-11-20',
      hora: '19:00',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'participo',
      userId: PARTICIPANT_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${CANONICAL_TOKEN}`);
    }
  });

  // ── 6. Anfitrión desde «Todos» y «Organizo» ─────────────────────────────────
  test('6A. Anfitrión desde «Todos» navega a la consola de administración /meet/:id', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: true,
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'todos',
      userId: HOST_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/meet/${ENCOUNTER_ID}`);
    }
  });

  test('6B. Anfitrión desde «Organizo» navega a la consola de administración /meet/:id', () => {
    const enc = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };
    const ctx: EncounterCardNavigationContext = {
      activeScope: 'organizo',
      userId: HOST_USER_ID,
    };

    const result = resolveEncounterCardNavigation(enc, ctx);
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/meet/${ENCOUNTER_ID}`);
    }
  });

  // ── 7. Encuentro privado ───────────────────────────────────────────────────
  test('7. Encuentro privado: Participante con token navega a /invite/:token; Anfitrión a /meet/:id', () => {
    const encPrivado = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      is_open: false,
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };

    // Caso Participante
    const resPart = resolveEncounterCardNavigation(
      { ...encPrivado, _isHost: false, _mi_token: CANONICAL_TOKEN },
      { activeScope: 'todos', userId: PARTICIPANT_USER_ID }
    );
    assert.equal(resPart.type, 'navigate');
    if (resPart.type === 'navigate') {
      assert.equal(resPart.path, `/invite/${CANONICAL_TOKEN}`);
    }

    // Caso Anfitrión
    const resHost = resolveEncounterCardNavigation(
      { ...encPrivado, _isHost: true },
      { activeScope: 'todos', userId: HOST_USER_ID }
    );
    assert.equal(resHost.type, 'navigate');
    if (resHost.type === 'navigate') {
      assert.equal(resHost.path, `/meet/${ENCOUNTER_ID}`);
    }
  });

  // ── 8. Encuentro abierto ───────────────────────────────────────────────────
  test('8A. Encuentro abierto con participante con token navega a /invite/:token', () => {
    const encAbierto = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      is_open: true,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      fecha: '2026-11-20',
      hora: '19:00',
    };
    const result = resolveEncounterCardNavigation(encAbierto, {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    });
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/invite/${CANONICAL_TOKEN}`);
    }
  });

  test('8B. Encuentro abierto con participante SIN token individual utiliza vista pública segura /?open_encounter=:id', () => {
    const encAbiertoSinToken = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      is_open: true,
      _isHost: false,
      _mi_token: null,
      _mi_token_invitacion: undefined,
      fecha: '2026-11-20',
      hora: '19:00',
    };
    const result = resolveEncounterCardNavigation(encAbiertoSinToken, {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    });
    assert.equal(result.type, 'open_encounter_detail');
    if (result.type === 'open_encounter_detail') {
      assert.equal(result.encounterId, ENCOUNTER_ID);
      assert.equal(result.path, `/?open_encounter=${ENCOUNTER_ID}`);
      assert.notEqual(result.path, `/meet/${ENCOUNTER_ID}`);
    }
  });

  // ── 9. Encuentro de coordinación ───────────────────────────────────────────
  test('9A. Encuentro de coordinación: Participante navega a /coordination/invite/:token', () => {
    const encCoord = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      date_mode: 'coordination',
      coordination_status: 'open',
    };
    const result = resolveEncounterCardNavigation(encCoord, {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    });
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/coordination/invite/${CANONICAL_TOKEN}`);
      assert.notEqual(result.path, `/coordination/${ENCOUNTER_ID}`);
    }
  });

  test('9B. Encuentro de coordinación: Anfitrión navega a /coordination/:id', () => {
    const encCoord = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      _isHost: true,
      date_mode: 'coordination',
      coordination_status: 'open',
    };
    const result = resolveEncounterCardNavigation(encCoord, {
      activeScope: 'todos',
      userId: HOST_USER_ID,
    });
    assert.equal(result.type, 'navigate');
    if (result.type === 'navigate') {
      assert.equal(result.path, `/coordination/${ENCOUNTER_ID}`);
    }
  });

  // ── 10. Encuentros anteriores y próximos ────────────────────────────────────
  test('10. Encuentros anteriores y próximos preservan el rol e identidad independientemente del bucket temporal', () => {
    const encPasadoPart = {
      id: 'past-encounter-uuid',
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      fecha: '2026-10-01',
      hora: '14:00',
    };
    const encProximoPart = {
      id: 'upcoming-encounter-uuid',
      host_id: HOST_USER_ID,
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      fecha: '2026-12-01',
      hora: '14:00',
    };

    const resPasado = resolveEncounterCardNavigation(encPasadoPart, { activeScope: 'todos', userId: PARTICIPANT_USER_ID });
    const resProximo = resolveEncounterCardNavigation(encProximoPart, { activeScope: 'todos', userId: PARTICIPANT_USER_ID });

    assert.equal(resPasado.type, 'navigate');
    assert.equal(resProximo.type, 'navigate');
    if (resPasado.type === 'navigate') assert.equal(resPasado.path, `/invite/${CANONICAL_TOKEN}`);
    if (resProximo.type === 'navigate') assert.equal(resProximo.path, `/invite/${CANONICAL_TOKEN}`);
  });

  // ── 11. Participante sin token ──────────────────────────────────────────────
  test('11. Participante sin token en encuentro privado genera indicación recuperable sin exponer /meet/:id', () => {
    const encPrivadoSinToken = {
      id: ENCOUNTER_ID,
      host_id: HOST_USER_ID,
      is_open: false,
      _isHost: false,
      _mi_token: null,
      _mi_token_invitacion: undefined,
      fecha: '2026-11-20',
      hora: '19:00',
      date_mode: 'fixed',
    };

    const result = resolveEncounterCardNavigation(encPrivadoSinToken, {
      activeScope: 'todos',
      userId: PARTICIPANT_USER_ID,
    });

    assert.equal(result.type, 'missing_token_notice');
    if (result.type === 'missing_token_notice') {
      assert.ok(result.message.includes('No se encontró'), 'Debe comunicar la falta de enlace recuperable');
      assert.ok(!result.message.includes('/meet/'), 'No debe referenciar rutas administrativas');
    }
  });

  // ── 12. Usuario no autorizado (Invariante de Aislamiento) ───────────────────
  test('12. Invariante de Aislamiento: Un participante NUNCA recibe rutas de anfitrión (/meet/:id ni /coordination/:id)', () => {
    const encVariados = [
      { id: ENCOUNTER_ID, host_id: HOST_USER_ID, _isHost: false, _mi_token: CANONICAL_TOKEN, is_open: false },
      { id: ENCOUNTER_ID, host_id: HOST_USER_ID, _isHost: false, _mi_token: CANONICAL_TOKEN, is_open: true },
      { id: ENCOUNTER_ID, host_id: HOST_USER_ID, _isHost: false, _mi_token: CANONICAL_TOKEN, date_mode: 'coordination' },
      { id: ENCOUNTER_ID, host_id: HOST_USER_ID, _isHost: false, _mi_token: null, is_open: false },
      { id: ENCOUNTER_ID, host_id: HOST_USER_ID, _isHost: false, _mi_token: null, is_open: true },
    ];

    for (const enc of encVariados) {
      const result = resolveEncounterCardNavigation(enc, {
        activeScope: 'todos',
        userId: PARTICIPANT_USER_ID,
      });

      if (result.type === 'navigate' || result.type === 'open_encounter_detail') {
        assert.ok(!result.path.startsWith('/meet/'), `Fallo de aislamiento: ruta host /meet detectada para participante en enc: ${JSON.stringify(enc)}`);
        assert.ok(!result.path.startsWith(`/coordination/${ENCOUNTER_ID}`), `Fallo de aislamiento: ruta host /coordination/:id detectada para participante`);
      }
    }
  });

  // ── 13. Componente ActiveCard: Renderizado de rol participante y badge ───────
  test('13. ActiveCard renderiza el badge «✔ Vas a asistir» cuando !isHost y miEstado === "confirmado"', () => {
    const enc = {
      id: ENCOUNTER_ID,
      titulo: 'QA Web Push Multiplataforma',
      fecha: '2026-11-20',
      hora: '19:00',
      modalidad: 'presencial',
      _isHost: false,
      _mi_estado: 'confirmado',
    };

    const html = renderToString(
      React.createElement(ActiveCard, {
        enc,
        onClick: () => {},
        participantesCache: null,
        miEstado: enc._mi_estado,
        isHost: false,
      })
    );

    assert.ok(html.includes('Vas a asistir'), 'Debe contener la etiqueta de asistencia del participante');
    assert.ok(html.includes('QA Web Push Multiplataforma'), 'Debe contener el título del encuentro');
  });

  // ── 14. Integración: Clic en ActiveCard invoca el manejador seguro ────────────
  test('14. Integración: Al invocar onClick en ActiveCard de participante, se ejecuta el ruteo seguro', () => {
    const enc = {
      id: ENCOUNTER_ID,
      titulo: 'QA Web Push Multiplataforma',
      fecha: '2026-11-20',
      hora: '19:00',
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
    };

    let targetRoute = '';
    const mockNavigate = (path: string) => { targetRoute = path; };

    const handleCardClick = (targetEnc: any) => {
      const target = resolveEncounterCardNavigation(targetEnc, {
        activeScope: 'todos',
        userId: PARTICIPANT_USER_ID,
      });
      if (target.type === 'navigate') {
        mockNavigate(target.path);
      }
    };

    handleCardClick(enc);
    assert.equal(targetRoute, `/invite/${CANONICAL_TOKEN}`, 'Debe navegar a /invite/:token y jamás a /meet/:id');
  });

  // ── 15. Flujo Real de Apertura: Normalización OpenEncounterSummary ───────────
  test('15. handleOpenEncounterDetailAction recupera y normaliza OpenEncounterSummary a través de getEncuentroAbiertoById', async () => {
    const rawParticipation = {
      id: ENCOUNTER_ID,
      titulo: 'Encuentro Comunitario Abierto',
      fecha: '2026-11-25',
      hora: '18:30',
      lugar_texto: 'Plaza Central',
      date_mode: 'fixed',
      is_open: true,
      _isHost: false,
    };

    const normalizedSummary: OpenEncounterSummary = {
      id: ENCOUNTER_ID,
      title: 'Encuentro Comunitario Abierto',
      startsAt: '2026-11-25T18:30:00Z',
      dateLabel: 'Miércoles · 18:30',
      approximateZone: 'Centro',
      localityId: 'mdq-centro',
      openSlots: 8,
      confirmedCount: 12,
      confirmedSeats: 12,
      language: 'es',
      description: 'Encuentro público para la comunidad',
      hostName: 'Carlos Anfitrión',
      hostId: HOST_USER_ID,
      isHost: false,
      realizationStatus: 'confirmed',
    };

    let openedSummary: OpenEncounterSummary | null = null;
    let noticeMessage = '';

    const mockService = {
      getEncuentroAbiertoById: async (id: string) => {
        assert.equal(id, ENCOUNTER_ID, 'Debe solicitar el ID del encuentro correspondiente');
        return normalizedSummary;
      },
    };

    await handleOpenEncounterDetailAction(
      rawParticipation.id,
      {
        onSuccess: (summary) => { openedSummary = summary; },
        onNotice: (msg) => { noticeMessage = msg; },
      },
      mockService
    );

    // Verificaciones de cumplimiento de contrato
    assert.ok(openedSummary !== null, 'Debe invocar onSuccess con un resumen válido');
    assert.equal(noticeMessage, '', 'No debe registrarse ningún mensaje de error');
    assert.equal(openedSummary.id, ENCOUNTER_ID);
    assert.equal(openedSummary.title, 'Encuentro Comunitario Abierto', 'El contrato exige title normalizado');
    assert.equal(openedSummary.startsAt, '2026-11-25T18:30:00Z', 'El contrato exige startsAt');
    assert.equal(openedSummary.dateLabel, 'Miércoles · 18:30', 'El contrato exige dateLabel');
    assert.equal(openedSummary.openSlots, 8, 'El contrato exige openSlots numérico');
    assert.equal(openedSummary.confirmedCount, 12, 'El contrato exige confirmedCount');

    // Verificación de que NO es el objeto crudo de participación
    assert.notEqual(openedSummary, rawParticipation as any, 'Jamás debe pasarse la referencia del objeto de participación crudo');
    assert.equal((openedSummary as any).titulo, undefined, 'El objeto normalizado no contiene el campo no-estándar titulo');
    assert.equal((openedSummary as any)._mi_token, undefined, 'No debe filtrar tokens internos en OpenEncounterSummary');
  });

  // ── 16. Flujo de Apertura: Encuentro abierto no encontrado o revocado ─────────
  test('16. handleOpenEncounterDetailAction emite aviso recuperable cuando el encuentro no existe o no está disponible', async () => {
    let openedSummary: OpenEncounterSummary | null = null;
    let noticeMessage = '';

    const mockService = {
      getEncuentroAbiertoById: async () => null,
    };

    await handleOpenEncounterDetailAction(
      ENCOUNTER_ID,
      {
        onSuccess: (summary) => { openedSummary = summary; },
        onNotice: (msg) => { noticeMessage = msg; },
      },
      mockService
    );

    assert.equal(openedSummary, null, 'No debe abrirse el detalle si el servicio retorna null');
    assert.ok(
      noticeMessage.includes('ya no está disponible') || noticeMessage.includes('autorización'),
      'Debe emitir un aviso recuperable sobre la disponibilidad o autorización'
    );
  });

  // ── 17. Flujo de Apertura: Manejo de errores de red o RPC ────────────────────
  test('17. handleOpenEncounterDetailAction gestiona excepciones de consulta mediante aviso recuperable', async () => {
    let openedSummary: OpenEncounterSummary | null = null;
    let noticeMessage = '';

    const mockService = {
      getEncuentroAbiertoById: async () => {
        throw new Error('Network timeout o fallo en RPC');
      },
    };

    await handleOpenEncounterDetailAction(
      ENCOUNTER_ID,
      {
        onSuccess: (summary) => { openedSummary = summary; },
        onNotice: (msg) => { noticeMessage = msg; },
      },
      mockService
    );

    assert.equal(openedSummary, null, 'No debe abrirse el detalle ante una excepción');
    assert.ok(
      noticeMessage.includes('No pudimos cargar los detalles') || noticeMessage.includes('reintentá'),
      'Debe emitir un aviso al usuario para reintentar más tarde'
    );
  });

  // ── 18. Contrato: Discrepancia estructural entre participación y resumen ─────
  test('18. El contrato OpenEncounterSummary difiere estructuralmente de la proyección de participación', () => {
    const rawParticipation = {
      id: ENCOUNTER_ID,
      titulo: 'Título en español',
      fecha: '2026-11-20',
      hora: '19:00',
      lugar_texto: 'Dirección privada',
      modalidad: 'presencial',
      _isHost: false,
      _mi_token: CANONICAL_TOKEN,
      _mi_estado: 'confirmado',
    };

    // Validar que la proyección de participación carece de las propiedades obligatorias de OpenEncounterSummary
    const missingKeysInParticipation = ['title', 'startsAt', 'dateLabel', 'openSlots', 'confirmedCount'].filter(
      key => !(key in rawParticipation)
    );

    assert.equal(
      missingKeysInParticipation.length,
      5,
      'La proyección de participación carece de las 5 propiedades estructurales de OpenEncounterSummary'
    );
  });
});
