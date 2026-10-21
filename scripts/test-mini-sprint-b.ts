import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  canAddToCalendar,
  escapeIcsText,
  foldIcsLine,
  generateIcsContent,
  buildGoogleCalendarUrl,
  TIMEZONE_ARGENTINA,
  DEFAULT_DURATION_MINUTES,
  REMINDER_TRIGGERS,
  DEFAULT_REMINDER_OPTION,
  type CalendarReminderOption,
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

    // Fechas o formatos corruptos -> Rechazados de forma segura
    assert.strictEqual(canAddToCalendar({ fecha: 'invalido', hora: '20:00' }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-13-01', hora: '20:00' }), false); // Mes 13
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-32', hora: '20:00' }), false); // Día 32
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '25:00' }), false); // Hora 25
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '20:65' }), false); // Minuto 65
    assert.strictEqual(canAddToCalendar({ fecha: '1990-01-01', hora: '10:00' }), false); // Año < 2020

    // Fechas imposibles en el calendario gregoriano (evita rollover accidental de Date)
    assert.strictEqual(canAddToCalendar({ fecha: '2026-02-31', hora: '20:00' }), false, '31 de febrero debe ser rechazado');
    assert.strictEqual(canAddToCalendar({ fecha: '2026-02-29', hora: '20:00' }), false, '29 de febrero en año no bisiesto debe ser rechazado');
    assert.strictEqual(canAddToCalendar({ fecha: '2026-04-31', hora: '20:00' }), false, '31 de abril debe ser rechazado');

    // Cadenas malformadas con sufijos o formatos no canónicos (que parseInt aceptaría por error)
    assert.strictEqual(canAddToCalendar({ fecha: '2026-02-15extra', hora: '20:00' }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026/02/15', hora: '20:00' }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-2-5', hora: '20:00' }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-02-15', hora: '20:00extra' }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-02-15', hora: '8:00' }), false);

    // Validación de duraciones: positivas y razonables
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '20:00', durationMinutes: -60 }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '20:00', durationMinutes: 0 }), false);
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '20:00', durationMinutes: 1441 }), false); // > 24 horas
    assert.strictEqual(canAddToCalendar({ fecha: '2026-11-20', hora: '20:00', durationMinutes: 120 }), true);
  });

  await t.test('1.2 escapeIcsText y foldIcsLine cumplen con estándar RFC 5545 (máx 75 octetos UTF-8 sin dividir multibyte)', () => {
    // Escapado de caracteres especiales: coma, punto y coma, barra invertida, saltos de línea
    const raw = 'Hola, mundo; esto es una prueba\\ejemplo\nsegunda línea\r\ntercera';
    const escaped = escapeIcsText(raw);
    assert.strictEqual(escaped, 'Hola\\, mundo\\; esto es una prueba\\\\ejemplo\\nsegunda línea\\ntercera');

    // Pliegue RFC 5545 basado en un máximo de 75 octetos UTF-8 por línea con acentos, eñes y emojis
    const textWithAccentsAndEmojis = 'SUMMARY:¡Gran celebración de cumpleaños de Martín & Peña en Güemes! 🎂🎉🍻🍕🎈' + ' con amigos'.repeat(5);
    const folded = foldIcsLine(textWithAccentsAndEmojis);
    const lines = folded.split('\r\n');

    assert.ok(lines.length >= 2, 'Debe haber plegado en al menos 2 líneas');

    const encoder = new TextEncoder();
    for (let i = 0; i < lines.length; i++) {
      const lineBytes = encoder.encode(lines[i]).length;
      assert.ok(
        lineBytes <= 75,
        `La línea ${i} (${lines[i]}) supera los 75 octetos UTF-8: ${lineBytes} bytes`
      );
      if (i > 0) {
        assert.ok(lines[i].startsWith(' '), `La línea de continuación ${i} debe comenzar con un espacio`);
      }
    }

    // El desplegado (unfolding según RFC 5545: reemplazar CRLF + espacio) debe reconstruir exactamente el original
    const unfolded = folded.replace(/\r\n /g, '');
    assert.strictEqual(unfolded, textWithAccentsAndEmojis, 'El desplegado debe restaurar exactamente el texto original');
  });

  await t.test('1.3 generateIcsContent y cruces de medianoche con zona horaria Argentina', () => {
    // 1. Encuentro diurno estándar
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

    // 2. Encuentro nocturno que cruza la medianoche (23:30 ART con 120 min de duración -> 01:30 ART del día siguiente)
    const midnightEncounter = {
      id: 'enc-midnight-99',
      titulo: '¡Cena y Brindis de Fin de Año con Peña! 🍾✨',
      descripcion: 'Festejamos el cierre de año con amigos en Güemes.',
      fecha: '2026-12-31',
      hora: '23:30',
      durationMinutes: 120,
      modalidad: 'presencial' as const,
      lugar_texto: 'Belgrano 800, Córdoba',
      estado: 'activo',
    };

    const midnightIcs = generateIcsContent(midnightEncounter);

    // Cruce de medianoche en iCalendar ART:
    // Inicio: 2026-12-31 23:30:00
    // Fin: 2027-01-01 01:30:00
    assert.ok(midnightIcs.includes(`DTSTART;TZID=${TIMEZONE_ARGENTINA}:20261231T233000\r\n`));
    assert.ok(midnightIcs.includes(`DTEND;TZID=${TIMEZONE_ARGENTINA}:20270101T013000\r\n`));
    assert.ok(midnightIcs.includes('UID:pe-enc-midnight-99@puntoencuentro.com.ar\r\n'));

    // Todas las líneas del .ics deben tener <= 75 octetos UTF-8
    const encoder = new TextEncoder();
    const icsLines = midnightIcs.split('\r\n');
    for (const line of icsLines) {
      if (!line) continue;
      const bytes = encoder.encode(line).length;
      assert.ok(bytes <= 75, `Línea del .ics supera 75 bytes: ${bytes} bytes -> ${line}`);
    }

    // Terminador estándar de línea RFC 5545 es CRLF
    assert.ok(!midnightIcs.includes('\n\n') || !midnightIcs.includes('\r\r'));
    assert.ok(midnightIcs.endsWith('\r\n'));
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

  await t.test('1.5 buildGoogleCalendarUrl genera enlace web con timestamps UTC exactos y cruce de medianoche', () => {
    const encounter = {
      id: 'enc-gcal-1',
      titulo: 'Clase de Yoga & Meditación 🧘‍♂️',
      fecha: '2026-12-05',
      hora: '15:00', // 15:00 ART = 18:00 UTC
      durationMinutes: 60,
      modalidad: 'presencial' as const,
      lugar_texto: 'Plaza Las Heras, Palermo',
      estado: 'activo',
    };

    const url = buildGoogleCalendarUrl(encounter);

    assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'));
    assert.ok(url.includes('action=TEMPLATE'));
    assert.ok(url.includes('dates=20261205T180000Z%2F20261205T190000Z'));

    // Cruce de medianoche en Google Calendar
    const midnightEncounter = {
      id: 'enc-gcal-midnight',
      titulo: 'Fiesta de Fin de Año',
      fecha: '2026-12-31',
      hora: '23:30', // 23:30 ART + 3h = 2027-01-01 02:30 UTC
      durationMinutes: 120, // Finaliza a las 04:30 UTC
      estado: 'activo',
    };
    const midnightUrl = buildGoogleCalendarUrl(midnightEncounter);
    assert.ok(
      midnightUrl.includes('dates=20270101T023000Z%2F20270101T043000Z'),
      'Google Calendar debe calcular correctamente el cambio de día y año en UTC'
    );
  });

  await t.test('1.6 Integración en pantallas: Solo expone calendario a organizadores y participantes confirmados', () => {
    const rootDir = process.cwd();

    // DetailHost (Organizador)
    const detailHost = fs.readFileSync(path.join(rootDir, 'src/screens/DetailHost.tsx'), 'utf-8');
    assert.ok(detailHost.includes('<AddToCalendarButton'), 'DetailHost debe integrar AddToCalendarButton');
    assert.ok(detailHost.includes('!isCancelado'), 'DetailHost no debe mostrarlo si está cancelado');

    // InviteGuest (Invitado individual)
    const inviteGuest = fs.readFileSync(path.join(rootDir, 'src/screens/InviteGuest.tsx'), 'utf-8');
    assert.ok(inviteGuest.includes("<AddToCalendarButton"), 'InviteGuest debe integrar AddToCalendarButton');
    assert.ok(
      inviteGuest.includes("participante?.estado === 'confirmado'"),
      'InviteGuest debe restringir AddToCalendarButton exclusivamente a confirmados'
    );

    // JoinGeneral (Enlace general público)
    const joinGeneral = fs.readFileSync(path.join(rootDir, 'src/screens/JoinGeneral.tsx'), 'utf-8');
    assert.ok(joinGeneral.includes("<AddToCalendarButton"), 'JoinGeneral debe integrar AddToCalendarButton');
    assert.ok(
      joinGeneral.includes("participante?.estado === 'confirmado'") || joinGeneral.includes('justConfirmed'),
      'JoinGeneral debe restringir AddToCalendarButton a confirmados'
    );

    // HomeOpenEncounterDetailSheet (Encuentros abiertos de comunidad)
    const openSheet = fs.readFileSync(
      path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf-8'
    );
    assert.ok(openSheet.includes('<AddToCalendarButton'), 'HomeOpenEncounterDetailSheet debe integrar AddToCalendarButton');
    assert.ok(
      openSheet.includes('isApprovedParticipant'),
      'HomeOpenEncounterDetailSheet debe restringir AddToCalendarButton a participantes aprobados'
    );
  });

  await t.test('1.7 Recordatorios iCalendar (VALARM): Bloque válido para cada opción y ausencia con "Sin recordatorio"', () => {
    const encounter = {
      id: 'enc-alarm-test-1',
      titulo: 'Reunión de Diseño',
      fecha: '2026-11-20',
      hora: '18:00',
      durationMinutes: 60,
      estado: 'activo',
    };

    // 1. Predeterminado (30 minutos antes)
    const icsDefault = generateIcsContent(encounter);
    assert.ok(icsDefault.includes('BEGIN:VALARM\r\n'), 'Debe incluir bloque VALARM');
    assert.ok(icsDefault.includes('ACTION:DISPLAY\r\n'), 'VALARM debe tener ACTION:DISPLAY');
    assert.ok(icsDefault.includes('DESCRIPTION:Reunión de Diseño\r\n'), 'VALARM debe tener DESCRIPTION');
    assert.ok(icsDefault.includes('TRIGGER:-PT30M\r\n'), 'Default debe ser TRIGGER:-PT30M');
    assert.ok(icsDefault.includes('END:VALARM\r\n'), 'Debe cerrar bloque VALARM');

    // 2. Opción explícita: 10 minutos antes
    const ics10m = generateIcsContent(encounter, '10m');
    assert.ok(ics10m.includes('TRIGGER:-PT10M\r\n'), '10m debe generar TRIGGER:-PT10M');

    // 3. Opción explícita: 1 hora antes
    const ics1h = generateIcsContent(encounter, '1h');
    assert.ok(ics1h.includes('TRIGGER:-PT1H\r\n'), '1h debe generar TRIGGER:-PT1H');

    // 4. Opción explícita: 1 día antes
    const ics1d = generateIcsContent(encounter, '1d');
    assert.ok(ics1d.includes('TRIGGER:-P1D\r\n'), '1d debe generar TRIGGER:-P1D');

    // 5. Opción: Sin recordatorio ('none')
    const icsNone = generateIcsContent(encounter, 'none');
    assert.ok(!icsNone.includes('BEGIN:VALARM'), '"none" NUNCA debe incluir bloque VALARM');
    assert.ok(!icsNone.includes('TRIGGER:'), '"none" no debe incluir TRIGGER');

    // 6. Selector en componente AddToCalendarButton
    const rootDir = process.cwd();
    const btnSource = fs.readFileSync(path.join(rootDir, 'src/components/calendar/AddToCalendarButton.tsx'), 'utf-8');
    assert.ok(btnSource.includes('pe-calendar-reminder-select'), 'AddToCalendarButton debe renderizar el selector de recordatorio');
    assert.ok(btnSource.includes('value="30m"'), 'Debe ofrecer opción 30m');
    assert.ok(btnSource.includes('value="10m"'), 'Debe ofrecer opción 10m');
    assert.ok(btnSource.includes('value="1h"'), 'Debe ofrecer opción 1h');
    assert.ok(btnSource.includes('value="1d"'), 'Debe ofrecer opción 1d');
    assert.ok(btnSource.includes('value="none"'), 'Debe ofrecer opción none');

    // 7. Google Calendar continúa funcionando sin prometer recordatorio en la URL
    const gcalUrl = buildGoogleCalendarUrl(encounter);
    assert.ok(gcalUrl.startsWith('https://calendar.google.com/calendar/render?'));
    assert.ok(!gcalUrl.includes('reminder='), 'URL de Google Calendar no debe intentar inyectar parámetros de recordatorio no garantizados');
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

  await t.test('2.8 Sincronización entre dispositivos, aislamiento entre usuarios y manejo de fallas de sync', async () => {
    const userA = 'user-alice-111';
    const userB = 'user-bob-222';

    // 1. Inicio de sesión en navegador sin caché local:
    // El usuario tiene preferencias en user_metadata de Auth, pero localStorage está completamente vacío.
    localStorage.clear();
    assert.strictEqual(localStorage.getItem(`pe_quiet_hours_prefs:${userA}`), null);

    const hydratedFromMetadata = userPreferencesService.resolveInitialQuietHours(
      { quiet_hours: { enabled: true, startTime: '22:30', endTime: '07:00' } },
      userA
    );
    assert.strictEqual(hydratedFromMetadata.enabled, true);
    assert.strictEqual(hydratedFromMetadata.startTime, '22:30');
    assert.strictEqual(hydratedFromMetadata.endTime, '07:00');

    // Debe haber hidratado la caché local sin requerir abrir Avisame
    assert.ok(localStorage.getItem(`pe_quiet_hours_prefs:${userA}`));

    // 2. Cambio de usuario:
    // Cierra sesión User A y entra User B sin preferencias en metadata ni en caché.
    // User B NUNCA debe heredar las preferencias de User A ni de la sesión anónima.
    const userBInitial = userPreferencesService.resolveInitialQuietHours(
      {}, // Metadata sin quiet_hours
      userB
    );
    assert.strictEqual(userBInitial.enabled, false, 'User B no debe heredar quiet hours de User A');
    assert.strictEqual(userBInitial.startTime, '22:00', 'User B debe recibir default 22:00');
    assert.strictEqual(userBInitial.endTime, '08:00', 'User B debe recibir default 08:00');

    // Sesión anónima previa con preferencias no debe filtrarse a User B
    userPreferencesService.saveQuietHours({ enabled: true, startTime: '20:00' }, null, false);
    const userBAfterAnon = userPreferencesService.getLocalQuietHours(userB);
    assert.strictEqual(userBAfterAnon.enabled, false, 'User B no debe contaminarse con preferencias anónimas');

    // 3. Falla de sincronización remota:
    // Si la llamada remota falla o no es permanente, saveQuietHours retorna synced: false y persiste localmente
    const localSaveRes = await userPreferencesService.saveQuietHours(
      { enabled: true, startTime: '23:15', endTime: '06:45' },
      userB,
      false // No permanente o sin sync remota
    );
    assert.strictEqual(localSaveRes.ok, true);
    assert.strictEqual(localSaveRes.synced, false, 'No debe reportar sincronizado si no hubo sync remota exitosa');
    assert.strictEqual(localSaveRes.data.startTime, '23:15');

    // Verificación de persistencia local segura
    const userBStored = userPreferencesService.getLocalQuietHours(userB);
    assert.strictEqual(userBStored.startTime, '23:15');
  });

  await t.test('2.7 Gestión de Avisame y Web Push: Horarios Silenciosos visibles y navegación neutral /?notifications=1', () => {
    const rootDir = process.cwd();

    // AvisameSheet debe incluir QuietHoursSettings tanto en Crear aviso como en Mis avisos para gestión visible
    const avisameSheet = fs.readFileSync(path.join(rootDir, 'src/components/home/alerts/AvisameSheet.tsx'), 'utf-8');
    const createTabIdx = avisameSheet.indexOf("{activeTab === 'create' && (");
    const listTabIdx = avisameSheet.indexOf("{activeTab === 'list' && (");

    const createTabSection = avisameSheet.slice(createTabIdx, listTabIdx);
    const listTabSection = avisameSheet.slice(listTabIdx);

    assert.ok(createTabSection.includes('<QuietHoursSettings />'), 'QuietHoursSettings debe estar en Crear aviso');
    assert.ok(listTabSection.includes('<QuietHoursSettings />'), 'QuietHoursSettings debe estar en Mis avisos');
    assert.ok(!listTabSection.includes('<DevicePushSettings />'), 'DevicePushSettings NO debe estar en Mis avisos');

    // Service Worker: navegación estrictamente neutral a /?notifications=1
    const swContent = fs.readFileSync(path.join(rootDir, 'public/sw.js'), 'utf-8');
    assert.ok(
      swContent.includes('/?notifications=1'),
      'Service Worker debe mantener navegación neutral a /?notifications=1'
    );
  });
});

test('Mini-sprint B: Consistencia de i18n (ES, EN, PT-BR)', async (t) => {
  await t.test('3.1 Claves de calendario presentes en ES, EN y PT-BR', () => {
    const requiredCalendarKeys = [
      'add_to_calendar',
      'download_ics',
      'google_calendar',
      'google_calendar_sub',
      'apple_calendar',
      'outlook',
      'event_downloaded',
      'generic_description',
      'virtual_meeting',
      'reminder_label',
      'reminder_30m',
      'reminder_10m',
      'reminder_1h',
      'reminder_1d',
      'reminder_none',
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
      'quiet_hours_saved_local_only',
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

    // Verificar que el copy aclare el alcance en los 3 idiomas (avisos dentro de la app vs notificaciones del dispositivo)
    assert.match(
      esTranslations.avisame.quiet_hours_desc,
      /notificaciones del dispositivo|dentro de la app/i,
      'es.json debe clarificar el alcance en pantalla y dispositivo'
    );
    assert.match(
      enTranslations.avisame.quiet_hours_desc,
      /device notifications|in-app/i,
      'en.json debe clarificar el alcance en pantalla y dispositivo'
    );
    assert.match(
      ptTranslations.avisame.quiet_hours_desc,
      /notificações do dispositivo|dentro do aplicativo|dentro do app/i,
      'pt-BR.json debe clarificar el alcance en pantalla y dispositivo'
    );
  });
});
