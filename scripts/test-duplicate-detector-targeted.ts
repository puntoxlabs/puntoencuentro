import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePublicContentGate,
  checkDuplicateContent,
} from '../src/lib/moderation/index.ts';

describe('Ajuste Final Detección de Duplicados (Freeze Técnico)', () => {
  // 1. Texto idéntico + día distinto razonable → NO BLOCK (ALLOW)
  test('1. Texto idéntico + día distinto razonable → NO BLOCK (ALLOW)', () => {
    const history = [
      {
        id: 'enc-1',
        title: 'Fútbol 5 en Güemes',
        description: 'Partido mixto semanal, llevar zapatillas de césped.',
        fecha: '2026-10-23', // Viernes
        hora: '19:00',
        zona: 'Güemes',
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Fútbol 5 en Güemes',
      'Partido mixto semanal, llevar zapatillas de césped.',
      history,
      { fecha: '2026-10-24', hora: '19:00', zona: 'Güemes' } // Sábado
    );

    assert.notEqual(res.decision, 'block', 'No debe bloquear con días distintos');
    assert.equal(res.decision, 'allow', 'Día distinto debe ser ALLOW');

    // Comprobar a través del Gate completo
    const gateRes = evaluatePublicContentGate(
      'Fútbol 5 en Güemes',
      'Partido mixto semanal, llevar zapatillas de césped.',
      history,
      { fecha: '2026-10-24', hora: '19:00', zona: 'Güemes' }
    );
    assert.equal(gateRes.decision, 'allow');
  });

  // 2. Texto idéntico + hora distinta razonable → NO BLOCK (ALLOW)
  test('2. Texto idéntico + hora distinta razonable → NO BLOCK (ALLOW)', () => {
    const history = [
      {
        id: 'enc-2',
        title: 'Torneo de Ajedrez Rápido',
        description: 'Torneo blitz a 5 minutos en el club.',
        fecha: '2026-10-25',
        hora: '15:00',
        zona: 'Centro',
        created_at: new Date(Date.now() - 7200000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Torneo de Ajedrez Rápido',
      'Torneo blitz a 5 minutos en el club.',
      history,
      { fecha: '2026-10-25', hora: '19:00', zona: 'Centro' }
    );

    assert.notEqual(res.decision, 'block', 'No debe bloquear con horas distintas');
    assert.equal(res.decision, 'allow', 'Hora distinta debe ser ALLOW');
  });

  // 3. Texto idéntico + zona distinta → NO BLOCK (ALLOW)
  test('3. Texto idéntico + zona distinta → NO BLOCK (ALLOW)', () => {
    const history = [
      {
        id: 'enc-3',
        title: 'Clase abierta de Yoga',
        description: 'Práctica al aire libre con colchoneta.',
        fecha: '2026-10-26',
        hora: '10:00',
        zona: 'Playa Grande',
        created_at: new Date(Date.now() - 5000000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Clase abierta de Yoga',
      'Práctica al aire libre con colchoneta.',
      history,
      { fecha: '2026-10-26', hora: '10:00', zona: 'Parque Camet' }
    );

    assert.notEqual(res.decision, 'block', 'No debe bloquear con zonas distintas');
    assert.equal(res.decision, 'allow', 'Zona distinta debe ser ALLOW');
  });

  // 4. Dos encuentros recurrentes legítimos → ALLOW o REVIEW
  test('4. Dos encuentros recurrentes legítimos → ALLOW o REVIEW', () => {
    const history = [
      {
        id: 'enc-rec-1',
        title: 'Club de Lectura y Café',
        description: 'Reunión semanal para comentar el capítulo asignado.',
        fecha: '2026-10-18',
        hora: '18:00',
        zona: 'Güemes',
        created_at: new Date(Date.now() - 86400000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Club de Lectura y Café',
      'Reunión semanal para comentar el capítulo asignado.',
      history,
      { fecha: '2026-10-25', hora: '18:00', zona: 'Güemes' }
    );

    assert.ok(res.decision === 'allow' || res.decision === 'review');
    assert.notEqual(res.decision, 'block', 'Recurrente semanal no debe ser BLOCK');
  });

  // 5. 4–5 clones prácticamente idénticos creados en pocos minutos → BLOCK
  test('5. 4–5 clones prácticamente idénticos creados en pocos minutos → BLOCK', () => {
    const now = Date.now();
    const history = [
      {
        id: 'clone-1',
        title: 'Fiesta Privada VIP',
        description: 'Vengan todos a bailar esta noche.',
        created_at: new Date(now - 5 * 60 * 1000).toISOString(),
      },
      {
        id: 'clone-2',
        title: 'Fiesta Privada VIP',
        description: 'Vengan todos a bailar esta noche.',
        created_at: new Date(now - 3 * 60 * 1000).toISOString(),
      },
      {
        id: 'clone-3',
        title: 'Fiesta Privada VIP',
        description: 'Vengan todos a bailar esta noche.',
        created_at: new Date(now - 1 * 60 * 1000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Fiesta Privada VIP',
      'Vengan todos a bailar esta noche.',
      history,
      { created_at: new Date(now).toISOString() }
    );

    assert.equal(res.decision, 'block', 'Ráfaga de clones en pocos minutos debe ser BLOCK');
    assert.ok(res.reason_code === 'duplicate_content_burst' || res.reason_code === 'duplicate_content');
  });

  // 6. Mismo texto + misma fecha/hora/zona repetido → BLOCK
  test('6. Mismo texto + misma fecha/hora/zona repetido → BLOCK', () => {
    const history = [
      {
        id: 'enc-slot-1',
        title: 'Taller de Cerámica Inicial',
        description: 'Aprende las técnicas básicas de modelado en arcilla.',
        fecha: '2026-10-30',
        hora: '17:00',
        zona: 'Centro',
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ];

    const res = checkDuplicateContent(
      'Taller de Cerámica Inicial',
      'Aprende las técnicas básicas de modelado en arcilla.',
      history,
      { fecha: '2026-10-30', hora: '17:00', zona: 'Centro' }
    );

    assert.equal(res.decision, 'block', 'Mismo slot exacto debe ser BLOCK');
    assert.equal(res.reason_code, 'duplicate_content');
  });

  // 7. Similitud >= 0.95 sin otras señales → nunca BLOCK automático
  test('7. Similitud >= 0.95 sin otras señales → nunca BLOCK automático (REVIEW)', () => {
    const history = [
      {
        id: 'enc-ambiguous',
        title: 'Tarde de Juegos de Mesa y Mate',
        description: 'Nos encontramos en la plaza a jugar al Catan.',
        created_at: new Date(Date.now() - 10000000).toISOString(),
      },
    ];

    // Texto idéntico (similitud 1.0) sin datos de fecha/hora/zona
    const res = checkDuplicateContent(
      'Tarde de Juegos de Mesa y Mate',
      'Nos encontramos en la plaza a jugar al Catan.',
      history
    );

    assert.notEqual(res.decision, 'block', 'Similitud textual sola jamás debe ser BLOCK');
    assert.equal(res.decision, 'review', 'Sin contexto estructural debe derivar a REVIEW');
    assert.equal(res.reason_code, 'duplicate_content');
  });

  // 8. Regresión de la lógica anterior de anti-spam
  test('8. Regresión de la lógica anterior de anti-spam', () => {
    // Phishing debe ser bloqueado directamente
    const resPhish = evaluatePublicContentGate(
      'Actualización de cuenta',
      'Ingresá tu contraseña y verificá tu cuenta bancaria'
    );
    assert.equal(resPhish.decision, 'block');

    // Múltiples URLs masivas deben ser bloqueadas
    const resUrls = evaluatePublicContentGate(
      'Venta de entradas',
      'Comprá en https://link1.com y mirá en https://link2.com'
    );
    assert.equal(resUrls.decision, 'block');

    // Gibberish debe ser bloqueado
    const resGibberish = evaluatePublicContentGate('asdfghjkl zxcvbnm', 'qwerqwerqwer qwerqwer');
    assert.equal(resGibberish.decision, 'block');

    // Texto corto legítimo permitido
    const resShort = evaluatePublicContentGate('After Office Tech', 'Charla sobre Rust y Go');
    assert.equal(resShort.decision, 'allow');
  });
});
