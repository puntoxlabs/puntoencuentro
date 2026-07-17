const fs = require('fs');

let content = fs.readFileSync('src/services/encuentrosService.ts', 'utf8');

const newTypesAndHelpers = `
export type CoordinationAvailabilityValue = 'available' | 'maybe' | 'unavailable';

export interface CoordinationAvailabilityInput {
  opcion_fecha_id: string;
  respuesta: CoordinationAvailabilityValue;
  es_preferida: boolean;
}

export interface CoordinationOption {
  id: string;
  fecha: string;
  hora_inicio: string;
  orden: number;
  selected: boolean;
}

export interface CoordinationParticipantResponse {
  opcion_fecha_id: string;
  respuesta: CoordinationAvailabilityValue;
  es_preferida: boolean;
}

export type CoordinationPublicReadResult =
  | {
      ok: true;
      encuentro: {
        id: string;
        titulo: string;
        descripcion: string | null;
        estado: string;
        modalidad: string;
        lugar_texto: string | null;
        tema: string | null;
        tipo_invitacion: string;
        tema_invitacion: string;
        invitation_template: string | null;
        duration_minutes: number | null;
      };
      coordination_status: 'open' | 'closed';
      response_deadline: string | null;
      selected_option_id: string | null;
      fecha: string | null;
      hora: string | null;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationParticipantReadResult =
  | {
      ok: true;
      encuentro: {
        id: string;
        titulo: string;
        descripcion: string | null;
        estado: string;
        modalidad: string;
        lugar_texto: string | null;
        tema: string | null;
        tipo_invitacion: string;
        tema_invitacion: string;
        invitation_template: string | null;
        duration_minutes: number | null;
      };
      participante: {
        id: string;
        nombre_invitado: string;
        tipo_invitacion: string;
        estado: string;
        mensaje_respuesta: string | null;
        respondio_disponibilidad: boolean;
      };
      coordination_status: 'open' | 'closed';
      response_deadline: string | null;
      selected_option_id: string | null;
      fecha: string | null;
      hora: string | null;
      derived_status: 'open' | 'closed' | 'deadline_passed';
      opciones: CoordinationOption[];
      mis_respuestas: CoordinationAvailabilityInput[];
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationPublicWriteResult =
  | {
      ok: true;
      token_invitacion: string;
    }
  | {
      ok: false;
      error: string;
    };

export type CoordinationParticipantWriteResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRpcJson(value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCoordinationStatus(value: unknown): value is CoordinationStatus {
  return value === 'open' || value === 'closed';
}

function isCoordinationDerivedStatus(value: unknown): value is 'open' | 'closed' | 'deadline_passed' {
  return value === 'open' || value === 'closed' || value === 'deadline_passed';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const year = parseInt(value.substring(0, 4), 10);
  const month = parseInt(value.substring(5, 7), 10);
  const day = parseInt(value.substring(8, 10), 10);
  if (month < 1 || month > 12) return false;
  const dateObj = new Date(year, month - 1, day);
  return dateObj.getFullYear() === year && dateObj.getMonth() === month - 1 && dateObj.getDate() === day;
}

function isValidPostgresTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(?:\\.\\d+)?)?$/.test(value);
}

function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isValidDurationMinutes(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 15 && value <= 1440;
}

function normalizeCoordinationResponses(value: unknown, validOptionIds?: Set<string>): CoordinationAvailabilityInput[] | null {
  if (!Array.isArray(value)) return null;
  const resps: CoordinationAvailabilityInput[] = [];
  let preferredCount = 0;
  const seenResponseOptionIds = new Set<string>();
  
  for (const resp of value) {
    if (!isUnknownRecord(resp)) return null;
    if (!isNonEmptyString(resp.opcion_fecha_id)) return null;
    if (validOptionIds && !validOptionIds.has(resp.opcion_fecha_id)) return null;
    if (seenResponseOptionIds.has(resp.opcion_fecha_id)) return null;
    seenResponseOptionIds.add(resp.opcion_fecha_id);
    
    const validRes = resp.respuesta === 'available' || resp.respuesta === 'maybe' || resp.respuesta === 'unavailable';
    if (!validRes) return null;
    
    if (typeof resp.es_preferida !== 'boolean') return null;
    if (resp.respuesta === 'unavailable' && resp.es_preferida) return null;
    if (resp.es_preferida) preferredCount++;
    
    resps.push({
      opcion_fecha_id: resp.opcion_fecha_id,
      respuesta: resp.respuesta as 'available' | 'maybe' | 'unavailable',
      es_preferida: resp.es_preferida
    });
  }
  
  if (preferredCount > 1) return null;
  return resps;
}
`;

const newMethods = `,

  async getCoordinacionPublica(publicToken: string): Promise<CoordinationPublicReadResult> {
    if (!publicToken) return { ok: false, error: 'invalid_token' };

    const { data, error } = await supabase.rpc('get_coordinacion_publica_seguro', {
      p_public_token: publicToken
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const rawResult: unknown = parseRpcJson(data);
    if (!isUnknownRecord(rawResult)) return { ok: false, error: 'invalid_response_format' };

    if (rawResult.ok === false) {
      return { ok: false, error: typeof rawResult.error === 'string' ? rawResult.error : 'unknown_error' };
    }

    if (rawResult.ok !== true) return { ok: false, error: 'invalid_response_format' };

    if (!isUnknownRecord(rawResult.encuentro)) return { ok: false, error: 'invalid_response_format' };
    const enc = rawResult.encuentro;
    if (!isNonEmptyString(enc.id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.titulo)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.estado)) return { ok: false, error: 'invalid_response_format' };
    if (enc.modalidad !== 'presencial' && enc.modalidad !== 'virtual') return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.tipo_invitacion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.tema_invitacion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.descripcion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.lugar_texto)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.tema)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.invitation_template)) return { ok: false, error: 'invalid_response_format' };
    if (!isValidDurationMinutes(enc.duration_minutes)) return { ok: false, error: 'invalid_response_format' };

    if (!isCoordinationStatus(rawResult.coordination_status)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.response_deadline !== null && !isValidIsoDateTime(rawResult.response_deadline)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.selected_option_id !== null && (!isUuid(rawResult.selected_option_id) && !isNonEmptyString(rawResult.selected_option_id))) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.fecha !== null && !isValidCalendarDate(rawResult.fecha)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.hora !== null && !isValidPostgresTime(rawResult.hora)) return { ok: false, error: 'invalid_response_format' };
    if (!isCoordinationDerivedStatus(rawResult.derived_status)) return { ok: false, error: 'invalid_response_format' };

    if (!Array.isArray(rawResult.opciones) || rawResult.opciones.length < 2 || rawResult.opciones.length > 3) return { ok: false, error: 'invalid_response_format' };

    const ops: CoordinationOption[] = [];
    const seenOptionIds = new Set<string>();
    const seenOptionOrders = new Set<number>();

    for (const op of rawResult.opciones) {
      if (!isUnknownRecord(op)) return { ok: false, error: 'invalid_response_format' };
      if (!isNonEmptyString(op.id)) return { ok: false, error: 'invalid_response_format' };
      if (seenOptionIds.has(op.id as string)) return { ok: false, error: 'invalid_response_format' };
      seenOptionIds.add(op.id as string);

      if (typeof op.orden !== 'number' || !Number.isInteger(op.orden) || op.orden < 1 || op.orden > 3) return { ok: false, error: 'invalid_response_format' };
      if (seenOptionOrders.has(op.orden as number)) return { ok: false, error: 'invalid_response_format' };
      seenOptionOrders.add(op.orden as number);

      if (!isValidCalendarDate(op.fecha)) return { ok: false, error: 'invalid_response_format' };
      if (!isValidPostgresTime(op.hora_inicio)) return { ok: false, error: 'invalid_response_format' };
      if (typeof op.selected !== 'boolean') return { ok: false, error: 'invalid_response_format' };

      ops.push({
        id: op.id as string,
        fecha: op.fecha as string,
        hora_inicio: op.hora_inicio as string,
        orden: op.orden as number,
        selected: op.selected as boolean
      });
    }

    return {
      ok: true,
      encuentro: {
        id: enc.id as string,
        titulo: enc.titulo as string,
        descripcion: enc.descripcion as string | null,
        estado: enc.estado as string,
        modalidad: enc.modalidad as string,
        lugar_texto: enc.lugar_texto as string | null,
        tema: enc.tema as string | null,
        tipo_invitacion: enc.tipo_invitacion as string,
        tema_invitacion: enc.tema_invitacion as string,
        invitation_template: resolveInvitationTemplateForTheme(
          enc.tema_invitacion as InvitationTheme,
          enc.invitation_template as string | null
        ),
        duration_minutes: enc.duration_minutes as number | null
      },
      coordination_status: rawResult.coordination_status as 'open' | 'closed',
      response_deadline: rawResult.response_deadline as string | null,
      selected_option_id: rawResult.selected_option_id as string | null,
      fecha: rawResult.fecha as string | null,
      hora: rawResult.hora as string | null,
      derived_status: rawResult.derived_status as 'open' | 'closed' | 'deadline_passed',
      opciones: ops
    };
  },

  async getCoordinacionParticipante(tokenInvitacion: string): Promise<CoordinationParticipantReadResult> {
    if (!tokenInvitacion) return { ok: false, error: 'invalid_token' };

    const { data, error } = await supabase.rpc('get_coordinacion_participante_seguro', {
      p_token: tokenInvitacion
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const rawResult: unknown = parseRpcJson(data);
    if (!isUnknownRecord(rawResult)) return { ok: false, error: 'invalid_response_format' };

    if (rawResult.ok === false) {
      return { ok: false, error: typeof rawResult.error === 'string' ? rawResult.error : 'unknown_error' };
    }

    if (rawResult.ok !== true) return { ok: false, error: 'invalid_response_format' };

    if (!isUnknownRecord(rawResult.encuentro)) return { ok: false, error: 'invalid_response_format' };
    const enc = rawResult.encuentro;
    if (!isNonEmptyString(enc.id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.titulo)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.estado)) return { ok: false, error: 'invalid_response_format' };
    if (enc.modalidad !== 'presencial' && enc.modalidad !== 'virtual') return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.tipo_invitacion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(enc.tema_invitacion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.descripcion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.lugar_texto)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.tema)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(enc.invitation_template)) return { ok: false, error: 'invalid_response_format' };
    if (!isValidDurationMinutes(enc.duration_minutes)) return { ok: false, error: 'invalid_response_format' };

    if (!isUnknownRecord(rawResult.participante)) return { ok: false, error: 'invalid_response_format' };
    const part = rawResult.participante;
    if (!isNonEmptyString(part.id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.nombre_invitado)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.tipo_invitacion)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.estado)) return { ok: false, error: 'invalid_response_format' };
    if (!isNullableString(part.mensaje_respuesta)) return { ok: false, error: 'invalid_response_format' };
    if (typeof part.respondio_disponibilidad !== 'boolean') return { ok: false, error: 'invalid_response_format' };

    if (!isCoordinationStatus(rawResult.coordination_status)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.response_deadline !== null && !isValidIsoDateTime(rawResult.response_deadline)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.selected_option_id !== null && (!isUuid(rawResult.selected_option_id) && !isNonEmptyString(rawResult.selected_option_id))) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.fecha !== null && !isValidCalendarDate(rawResult.fecha)) return { ok: false, error: 'invalid_response_format' };
    if (rawResult.hora !== null && !isValidPostgresTime(rawResult.hora)) return { ok: false, error: 'invalid_response_format' };
    if (!isCoordinationDerivedStatus(rawResult.derived_status)) return { ok: false, error: 'invalid_response_format' };

    if (!Array.isArray(rawResult.opciones) || rawResult.opciones.length < 2 || rawResult.opciones.length > 3) return { ok: false, error: 'invalid_response_format' };

    const ops: CoordinationOption[] = [];
    const seenOptionIds = new Set<string>();
    const seenOptionOrders = new Set<number>();

    for (const op of rawResult.opciones) {
      if (!isUnknownRecord(op)) return { ok: false, error: 'invalid_response_format' };
      if (!isNonEmptyString(op.id)) return { ok: false, error: 'invalid_response_format' };
      if (seenOptionIds.has(op.id as string)) return { ok: false, error: 'invalid_response_format' };
      seenOptionIds.add(op.id as string);
      
      if (typeof op.orden !== 'number' || !Number.isInteger(op.orden) || op.orden < 1 || op.orden > 3) return { ok: false, error: 'invalid_response_format' };
      if (seenOptionOrders.has(op.orden as number)) return { ok: false, error: 'invalid_response_format' };
      seenOptionOrders.add(op.orden as number);
      
      if (!isValidCalendarDate(op.fecha)) return { ok: false, error: 'invalid_response_format' };
      if (!isValidPostgresTime(op.hora_inicio)) return { ok: false, error: 'invalid_response_format' };
      if (typeof op.selected !== 'boolean') return { ok: false, error: 'invalid_response_format' };
      ops.push({
        id: op.id as string,
        fecha: op.fecha as string,
        hora_inicio: op.hora_inicio as string,
        orden: op.orden as number,
        selected: op.selected as boolean
      });
    }

    const resps = normalizeCoordinationResponses(rawResult.mis_respuestas, seenOptionIds);
    if (!resps) return { ok: false, error: 'invalid_response_format' };

    return {
      ok: true,
      encuentro: {
        id: enc.id as string,
        titulo: enc.titulo as string,
        descripcion: enc.descripcion as string | null,
        estado: enc.estado as string,
        modalidad: enc.modalidad as string,
        lugar_texto: enc.lugar_texto as string | null,
        tema: enc.tema as string | null,
        tipo_invitacion: enc.tipo_invitacion as string,
        tema_invitacion: enc.tema_invitacion as string,
        invitation_template: resolveInvitationTemplateForTheme(
          enc.tema_invitacion as InvitationTheme,
          enc.invitation_template as string | null
        ),
        duration_minutes: enc.duration_minutes as number | null
      },
      participante: {
        id: part.id as string,
        nombre_invitado: part.nombre_invitado as string,
        tipo_invitacion: part.tipo_invitacion as string,
        estado: part.estado as string,
        mensaje_respuesta: part.mensaje_respuesta as string | null,
        respondio_disponibilidad: part.respondio_disponibilidad as boolean
      },
      coordination_status: rawResult.coordination_status as 'open' | 'closed',
      response_deadline: rawResult.response_deadline as string | null,
      selected_option_id: rawResult.selected_option_id as string | null,
      fecha: rawResult.fecha as string | null,
      hora: rawResult.hora as string | null,
      derived_status: rawResult.derived_status as 'open' | 'closed' | 'deadline_passed',
      opciones: ops,
      mis_respuestas: resps
    };
  },

  async crearDisponibilidadCoordinacionPublica(publicToken: string, nombre: string, respuestas: CoordinationAvailabilityInput[]): Promise<CoordinationPublicWriteResult> {
    if (!publicToken) return { ok: false, error: 'invalid_token' };
    if (!nombre || !nombre.trim()) return { ok: false, error: 'invalid_name' };

    const normResps = normalizeCoordinationResponses(respuestas);
    if (!normResps) return { ok: false, error: 'invalid_responses' };

    const { data, error } = await supabase.rpc('crear_disponibilidad_coordinacion_publica_seguro', {
      p_public_token: publicToken,
      p_nombre: nombre.trim(),
      p_respuestas: normResps
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const result: unknown = parseRpcJson(data);
    if (!isUnknownRecord(result)) return { ok: false, error: 'invalid_response_format' };

    if (result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown_error' };
    }

    if (result.ok !== true) return { ok: false, error: 'invalid_response_format' };
    
    if (!isNonEmptyString(result.encuentro_id)) return { ok: false, error: 'invalid_response_format' };
    if (!isUuid(result.token_invitacion)) return { ok: false, error: 'invalid_response_format' };
    
    if (!isUnknownRecord(result.participante)) return { ok: false, error: 'invalid_response_format' };
    const part = result.participante;
    if (!isNonEmptyString(part.id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.nombre_invitado)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(part.tipo_invitacion)) return { ok: false, error: 'invalid_response_format' };
    
    if (result.respondio_disponibilidad !== true) return { ok: false, error: 'invalid_response_format' };
    
    const retResps = normalizeCoordinationResponses(result.mis_respuestas);
    if (!retResps || retResps.length !== normResps.length) return { ok: false, error: 'invalid_response_format' };
    
    const reqIds = new Set(normResps.map(r => r.opcion_fecha_id));
    for (const r of retResps) {
      if (!reqIds.has(r.opcion_fecha_id)) return { ok: false, error: 'invalid_response_format' };
    }

    return { ok: true, token_invitacion: result.token_invitacion as string };
  },

  async guardarDisponibilidadCoordinacionParticipante(tokenInvitacion: string, respuestas: CoordinationAvailabilityInput[]): Promise<CoordinationParticipantWriteResult> {
    if (!tokenInvitacion) return { ok: false, error: 'invalid_token' };

    const normResps = normalizeCoordinationResponses(respuestas);
    if (!normResps) return { ok: false, error: 'invalid_responses' };

    const { data, error } = await supabase.rpc('guardar_disponibilidad_coordinacion_participante_seguro', {
      p_token: tokenInvitacion,
      p_respuestas: normResps
    });

    if (error) return { ok: false, error: 'rpc_error' };

    const result: unknown = parseRpcJson(data);
    if (!isUnknownRecord(result)) return { ok: false, error: 'invalid_response_format' };

    if (result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'unknown_error' };
    }

    if (result.ok !== true) return { ok: false, error: 'invalid_response_format' };
    
    if (!isNonEmptyString(result.encuentro_id)) return { ok: false, error: 'invalid_response_format' };
    if (!isNonEmptyString(result.participante_id)) return { ok: false, error: 'invalid_response_format' };
    if (result.respondio_disponibilidad !== true) return { ok: false, error: 'invalid_response_format' };

    const retResps = normalizeCoordinationResponses(result.mis_respuestas);
    if (!retResps || retResps.length !== normResps.length) return { ok: false, error: 'invalid_response_format' };
    
    const reqIds = new Set(normResps.map(r => r.opcion_fecha_id));
    for (const r of retResps) {
      if (!reqIds.has(r.opcion_fecha_id)) return { ok: false, error: 'invalid_response_format' };
    }

    return { ok: true };
  }
`;

const exportObjIdx = content.indexOf('export const encuentrosService = {');
if (exportObjIdx !== -1) {
  content = content.substring(0, exportObjIdx) + '\\n' + newTypesAndHelpers + '\\n' + content.substring(exportObjIdx);
} else {
  console.error("Could not find 'export const encuentrosService = {'");
  process.exit(1);
}

const endOfFileIdx = content.lastIndexOf('};');
if (endOfFileIdx !== -1) {
  content = content.substring(0, endOfFileIdx) + newMethods + '\\n' + content.substring(endOfFileIdx);
} else {
  console.error("Could not find '};' at the end of the file");
  process.exit(1);
}

fs.writeFileSync('src/services/encuentrosService.ts', content, 'utf8');
