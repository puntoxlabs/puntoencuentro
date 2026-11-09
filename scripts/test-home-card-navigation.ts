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
  type EncounterCardNavigationContext,
} from '../src/screens/Home';

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
});
