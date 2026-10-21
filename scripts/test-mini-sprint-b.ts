import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canAddToCalendar,
  escapeIcsText,
  foldIcsLine,
  generateIcsContent,
  buildGoogleCalendarUrl,
  TIMEZONE_ARGENTINA,
  DEFAULT_DURATION_MINUTES,
} from '../src/lib/calendarExport';

import {
  isValidTimeString,
  sanitizeQuietHoursPreference,
  isCriticalNotification,
  isInQuietHours,
  shouldSuppressForQuietHours,
  DEFAULT_QUIET_HOURS,
} from '../src/lib/quietHours';

import { userPreferencesService } from '../src/services/userPreferencesService';

import esTranslations from '../src/i18n/locales/es.json';
import enTranslations from '../src/i18n/locales/en.json';
import ptTranslations from '../src/i18n/locales/pt-BR.json';

// In-memory storage mock para Node
if (typeof (globalThis as any).localStorage === 'undefined') {
  const localMap = new Map<string, string>();
  const createStorageMock = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  });

  (globalThis as any).localStorage = createStorageMock(localMap);
}

test('Mini-sprint B: Exportación a Calendario (.ics & Google Calendar)', async (t) => {
  await t.test('1.1 canAddToCalendar valida fecha definitiva y descarta cancelados o coordinaciones abiertas', () => {
    // Nulo o vacío
    assert.strictEqual(canAddToCalendar(null), false);
    assert.strictEqual(canAddToCalendar({}), false);

    // Sin fecha u hora
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: null }), false);
    assert.strictEqual(canAddToCalendar({ fecha: null, hora: '20:00' }), false);

    // Cancelado -> NUNCA debe ofrecer agregar al calendario
    assert.strictEqual(
      canAddToCalendar({
        fecha: '2026-11-20',
        hora: '20:00',
        estado: 'cancelado',
      }),
      false,
      'No debe ofrecer calendario si el encuentro fue cancelado'
    );
    assert.strictEqual(
      canAddToCalendar({
        fecha: '2026-11-20',
        hora: '20:00',
        estado: 'CANCELADO',
      }),
      false
    );

    // Coordinación abierta (sin fecha definitiva resuelta) -> NO ofrecer
    assert.strictEqual(
      canAddToCalendar({
        fecha: '2026-11-20',
        hora: '20:00',
        date_mode: 'coordination',
        coordination_status: 'open',
      }),
      false,
      'No debe ofrecer calendario si la coordinación sigue abierta'
    );

    // Coordinación cerrada con fecha definitiva confirmada -> Válido
    assert.strictEqual(
      canAddToCalendar({
        fecha: '2026-11-20',
        hora: '20:00',
        date_mode: 'coordination',
        coordination_status: 'closed',
        estado: 'activo',
      }),
      true,
      'Debe permitir calendario si la coordinación ya fue cerrada con fecha definitiva'
    );

    // Encuentro fijo activo con fecha y hora -> Válido
    assert.strictEqual(
      canAddToCalendar({
        fecha: '2026-11-20',
        hora: '20:00',
        date_mode: 'fixed',
        estado: 'activo',
      }),
      true
    );
  });

  await t.test('1.2 escapeIcsText y foldIcsLine cumplen con estándar RFC 5545', () => {
    // Escapado de caracteres especiales: coma, punto y coma, barra invertida, saltos de línea
    const raw = 'Hola, mundo; esto es una prueba\\ejemplo\nsegunda línea\r\ntercera';
    const escaped = escapeIcsText(raw);
    assert.strictEqual(escaped, 'Hola\\, mundo\\; esto es una prueba\\\\ejemplo\\nsegunda línea\\ntercera');

    // Pliegue de líneas a máximo 75 caracteres con espacio en la línea siguiente
    const longLine = 'SUMMARY:' + 'A'.repeat(80);
    const folded = foldIcsLine(longLine);
    const lines = folded.split('\r\n');
    assert.ok(lines.length >= 2);
    assert.ok(lines[0].length <= 75);
    assert.ok(lines[1].startsWith(' '));
  });

  await t.test('1.3 generateIcsContent produce contenido iCalendar RFC 5545 válido con zona horaria Argentina', () => {
    const encounter = {
      id: 'enc-uuid-1234',
      titulo: 'Asado en Palermo',
      descripcion: 'Traer bebidas y ensaladas',
      fecha: '2026-11-20',
      hora: '20:30',
      durationMinutes: 180,
      modalidad: 'presencial' as const,
      lugar_texto: 'Av. Santa Fe 3200, CABA',
      estado: 'activo',
    };

    const ics = generateIcsContent(encounter);

    // Estructura general RFC 5545
    assert.ok(ics.includes('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.includes('VERSION:2.0\r\n'));
    assert.ok(ics.includes('PRODID:-//PuntoEncuentro//Calendario v1.0//ES\r\n'));
    assert.ok(ics.includes('END:VCALENDAR\r\n'));

    // Zona horaria
    assert.ok(ics.includes(`TZID:${TIMEZONE_ARGENTINA}\r\n`));
    assert.ok(ics.includes('TZOFFSETFROM:-0300\r\n'));
    assert.ok(ics.includes('TZOFFSETTO:-0300\r\n'));

    // Evento
    assert.ok(ics.includes('BEGIN:VEVENT\r\n'));
    assert.ok(ics.includes('UID:pe-enc-uuid-1234@puntoencuentro.com.ar\r\n'));
    assert.ok(ics.includes(`DTSTART;TZID=${TIMEZONE_ARGENTINA}:20261120T203000\r\n`));
    assert.ok(ics.includes(`DTEND;TZID=${TIMEZONE_ARGENTINA}:20261120T233000\r\n`));
    assert.ok(ics.includes('SUMMARY:Asado en Palermo\r\n'));
    assert.ok(ics.includes('LOCATION:Av. Santa Fe 3200\\, CABA\r\n'));
    assert.ok(ics.includes('STATUS:CONFIRMED\r\n'));
    assert.ok(ics.includes('END:VEVENT\r\n'));

    // Terminador estándar de línea RFC 5545 es CRLF
    assert.ok(!ics.includes('\n\n') || !ics.includes('\r\r'));
    assert.ok(ics.endsWith('\r\n'));
  });

  await t.test('1.4 Privacidad estricta: NO filtra tokens privados, identificadores sensibles ni links no autorizados', () => {
    const sensitiveEncounter = {
      id: 'enc-public-id',
      titulo: 'Reunión de equipo',
      fecha: '2026-11-25',
      hora: '10:00',
      modalidad: 'virtual' as const,
      link_virtual: null, // Usuario no autorizado o link aún no provisto
      estado: 'activo',
      token_invitacion: 'secret_token_123',
      service_role: 'secret_key',
    };

    const ics = generateIcsContent(sensitiveEncounter as any);

    // Debe contener ubicación genérica cuando el link no está disponible
    assert.ok(ics.includes('LOCATION:Videollamada\r\n'));

    // Cero tokens o claves
    assert.ok(!ics.includes('secret_token_123'));
    assert.ok(!ics.includes('secret_key'));
    assert.ok(!ics.includes('service_role'));
  });

  await t.test('1.5 buildGoogleCalendarUrl genera enlace web con timestamps UTC exactos', () => {
    const encounter = {
      id: 'enc-gcal-1',
      titulo: 'Clase de Yoga',
      fecha: '2026-12-05',
      hora: '15:00', // 15:00 ART = 18:00 UTC
      durationMinutes: 60,
      modalidad: 'presencial' as const,
      lugar_texto: 'Plaza Las Heras',
      estado: 'activo',
    };

    const url = buildGoogleCalendarUrl(encounter);

    assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'));
    assert.ok(url.includes('action=TEMPLATE'));
    assert.ok(url.includes('text=Clase+de+Yoga'));
    assert.ok(url.includes('dates=20261205T180000Z%2F20261205T190000Z'));
    assert.ok(url.includes('location=Plaza+Las+Heras'));
  });
});

test('Mini-sprint B: Preferencias de Avisame y Horarios Silenciosos', async (t) => {
  await t.test('2.1 isValidTimeString valida formato estricto HH:MM (00:00 a 23:59)', () => {
    assert.strictEqual(isValidTimeString('00:00'), true);
    assert.strictEqual(isValidTimeString('22:00'), true);
    assert.strictEqual(isValidTimeString('23:59'), true);
    assert.strictEqual(isValidTimeString('08:30'), true);

    // Inválidos
    assert.strictEqual(isValidTimeString('24:00'), false);
    assert.strictEqual(isValidTimeString('12:60'), false);
    assert.strictEqual(isValidTimeString('9:30'), false);
    assert.strictEqual(isValidTimeString('abc'), false);
    assert.strictEqual(isValidTimeString(null), false);
    assert.strictEqual(isValidTimeString(''), false);
  });

  await t.test('2.2 sanitizeQuietHoursPreference aplica defaults seguros ante datos corruptos', () => {
    const sanitizedNull = sanitizeQuietHoursPreference(null);
    assert.strictEqual(sanitizedNull.enabled, false);
    assert.strictEqual(sanitizedNull.startTime, '22:00');
    assert.strictEqual(sanitizedNull.endTime, '08:00');

    const sanitizedCorrupt = sanitizeQuietHoursPreference({
      enabled: true,
      startTime: 'invalido',
      endTime: '99:99',
    });
    assert.strictEqual(sanitizedCorrupt.enabled, true);
    assert.strictEqual(sanitizedCorrupt.startTime, '22:00');
    assert.strictEqual(sanitizedCorrupt.endTime, '08:00');
  });

  await t.test('2.3 isInQuietHours calcula ventanas que cruzan la medianoche y diurnas', () => {
    const overnightPref = {
      enabled: true,
      startTime: '22:00',
      endTime: '08:00',
    };

    // 23:30 ART -> Dentro de horario silencioso
    const nightDate = new Date('2026-11-20T23:30:00-03:00');
    assert.strictEqual(isInQuietHours(nightDate, overnightPref), true);

    // 03:00 ART -> Dentro de horario silencioso
    const madrugadaDate = new Date('2026-11-21T03:00:00-03:00');
    assert.strictEqual(isInQuietHours(madrugadaDate, overnightPref), true);

    // 14:00 ART -> Fuera de horario silencioso
    const tardeDate = new Date('2026-11-20T14:00:00-03:00');
    assert.strictEqual(isInQuietHours(tardeDate, overnightPref), false);

    // 08:00 ART en punto -> Fin de horario silencioso (exclusivo)
    const finDate = new Date('2026-11-21T08:00:00-03:00');
    assert.strictEqual(isInQuietHours(finDate, overnightPref), false);
  });

  await t.test('2.4 REGLA CRÍTICA: isCriticalNotification identifica cancelaciones y cambios urgentes', () => {
    // Tipos canónicos críticos de la migración 20261016150000
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'encounter_cancelled_for_participant' }),
      true
    );
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'open_encounter_request_cancelled_by_host' }),
      true
    );
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'encounter_schedule_changed' }),
      true
    );

    // Con prioridad explícita
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'match_found', payload: { priority: 'critical' } }),
      true
    );
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'custom_alert', payload: { is_critical: true } }),
      true
    );

    // No críticos
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'match_found' }),
      false
    );
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'internal_invitation' }),
      false
    );
    assert.strictEqual(
      isCriticalNotification({ notificationType: 'invitation_accepted' }),
      false
    );
  });

  await t.test('2.5 REGLA CRÍTICA: shouldSuppressForQuietHours NUNCA bloquea notificaciones críticas', () => {
    const quietPref = {
      enabled: true,
      startTime: '22:00',
      endTime: '08:00',
    };
    // Hora en plena noche
    const nightDate = new Date('2026-11-20T23:45:00-03:00');

    // Notificación crítica en plena noche -> NUNCA se suprime (debe sonar/alertar de inmediato)
    const criticalEvent = {
      notificationType: 'encounter_cancelled_for_participant',
      payload: { encounterId: '123' },
    };
    assert.strictEqual(
      shouldSuppressForQuietHours(criticalEvent, quietPref, nightDate),
      false,
      'Las cancelaciones urgentes NUNCA deben suprimirse en horarios silenciosos'
    );

    const scheduleChangeEvent = {
      notificationType: 'encounter_schedule_changed',
      payload: { encounterId: '123' },
    };
    assert.strictEqual(
      shouldSuppressForQuietHours(scheduleChangeEvent, quietPref, nightDate),
      false,
      'Los cambios de fecha/hora urgentes NUNCA deben suprimirse en horarios silenciosos'
    );

    // Notificación no crítica (ej. match de avisame) en plena noche -> SÍ se suprime
    const matchEvent = {
      notificationType: 'match_found',
      payload: { encounterId: '456' },
    };
    assert.strictEqual(
      shouldSuppressForQuietHours(matchEvent, quietPref, nightDate),
      true,
      'Los avisos no críticos deben silenciarse durante horarios silenciosos'
    );
  });

  await t.test('2.6 userPreferencesService persiste y resuelve preferencias locales y sincronizadas', async () => {
    const testUserId = 'user-test-uuid-999';

    // Inicial sin preferencias -> defaults
    const initial = userPreferencesService.getLocalQuietHours(testUserId);
    assert.strictEqual(initial.enabled, false);

    // Guardar preferencia
    const saved = await userPreferencesService.saveQuietHours(
      { enabled: true, startTime: '23:00', endTime: '07:30' },
      testUserId,
      false
    );
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(saved.data.enabled, true);
    assert.strictEqual(saved.data.startTime, '23:00');
    assert.strictEqual(saved.data.endTime, '07:30');

    // Leer nuevamente de cache local
    const retrieved = userPreferencesService.getLocalQuietHours(testUserId);
    assert.strictEqual(retrieved.enabled, true);
    assert.strictEqual(retrieved.startTime, '23:00');
    assert.strictEqual(retrieved.endTime, '07:30');

    // Fusión con user_metadata
    const resolvedAuth = userPreferencesService.resolveInitialQuietHours(
      { quiet_hours: { enabled: true, startTime: '21:00', endTime: '09:00' } },
      testUserId
    );
    assert.strictEqual(resolvedAuth.startTime, '21:00');
    assert.strictEqual(resolvedAuth.endTime, '09:00');
  });
});

test('Mini-sprint B: Consistencia de i18n (ES, EN, PT-BR)', async (t) => {
  await t.test('3.1 Claves de calendario presentes en ES, EN y PT-BR', () => {
    const requiredCalendarKeys = [
      'add_to_calendar',
      'download_ics',
      'google_calendar',
      'apple_calendar',
      'outlook',
      'event_downloaded',
      'generic_description',
      'virtual_meeting',
    ];

    for (const key of requiredCalendarKeys) {
      assert.ok(
        (esTranslations.calendar as any)[key],
        `es.json debe tener calendar.${key}`
      );
      assert.ok(
        (enTranslations.calendar as any)[key],
        `en.json debe tener calendar.${key}`
      );
      assert.ok(
        (ptTranslations.calendar as any)[key],
        `pt-BR.json debe tener calendar.${key}`
      );
    }
  });

  await t.test('3.2 Claves de horarios silenciosos en avisame presentes en ES, EN y PT-BR', () => {
    const requiredQuietKeys = [
      'quiet_hours_title',
      'quiet_hours_desc',
      'quiet_hours_enable',
      'quiet_hours_from',
      'quiet_hours_to',
      'quiet_hours_critical_notice',
      'quiet_hours_saved',
      'quiet_hours_login_hint',
    ];

    for (const key of requiredQuietKeys) {
      assert.ok(
        (esTranslations.avisame as any)[key],
        `es.json debe tener avisame.${key}`
      );
      assert.ok(
        (enTranslations.avisame as any)[key],
        `en.json debe tener avisame.${key}`
      );
      assert.ok(
        (ptTranslations.avisame as any)[key],
        `pt-BR.json debe tener avisame.${key}`
      );
    }
  });
});
