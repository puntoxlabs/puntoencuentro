/**
 * Arnés de Pruebas de Concurrencia y Detección de Deadlocks Multi-Conexión (Local)
 * Mini-Sprint 2B-1: Puente de Identidad entre Dominios
 *
 * Objetivo:
 * Ejecutar transacciones concurrentes reales con múltiples conexiones físicas independientes
 * sobre un PostgreSQL local para auditar la jerarquía de locks y verificar la ausencia de
 * interbloqueos circulares (código de error PostgreSQL '40P01': deadlock_detected).
 *
 * Escenario de Contención Simultánea:
 *  - Conexión 1 (Target): Canje de ticket mediante claim_domain_migration_ticket_seguro
 *  - Conexión 2 (Source): Re-emisión concurrente mediante create_domain_migration_ticket_seguro
 *  - Conexión 3 (Source): Revocación concurrente mediante revoke_my_pending_transfer_ticket
 *  - Conexión 4 (Source): Inserción de mensaje mediante publicar_mensaje_encuentro_seguro
 *
 * Controles de Resiliencia:
 *  - Barrera de sincronización Promise para despacho simultáneo en milisegundos.
 *  - Configuración explícita de lock_timeout (5s) y statement_timeout (10s) por conexión.
 *  - Detección explícita de 40P01 (deadlock) y 55P03 (lock timeout).
 *  - Clasificación de resultados por worker: error SQL vs rechazo funcional vs éxito.
 *  - Verificación de invariantes y exclusividad de estados terminales.
 *  - Fixtures dinámicos por ejecución (UUIDs únicos) y comprobación final de residuo cero.
 *
 * Nota sobre Autenticación (set_config vs GoTrue/PostgREST):
 *  - Este arnés opera a nivel de motor de base de datos simulando variables transaccionales
 *    (request.jwt.claim.*) sobre conexiones PostgreSQL nativas. Esto permite someter al planificador
 *    y al gestor de bloqueos de PostgreSQL a concurrencia pura sin la sobrecarga de HTTP.
 *  - Las pruebas de integración en Staging (staging-qa-concurrency-bridge.ts) complementan esto
 *    utilizando el cliente Supabase sobre PostgREST con tokens JWT reales de GoTrue y roles
 *    efectivos (anon, authenticated), garantizando la validación en ambas capas.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Exclusivamente para PostgreSQL local. Prohibido conectar a bases remotas en 2B-1.
const localPgUrl = process.env.LOCAL_POSTGRES_URL;

const STAGING_REF = 'wougfhfwqgmxhgvjqoua';
const PRODUCTION_REF = 'aurbicjwftjhwryhyjiq';

/**
 * Validador estricto de aislamiento local:
 * Rechaza terminantemente cualquier host remoto o referencias a project refs
 * de Producción o Staging antes de abrir conexiones o mutar datos.
 */
function assertStrictLocalPostgresUrl(rawUrl: string): void {
  // 1. Prohibir explícitamente cualquier referencia a los proyectos de Supabase o cloud
  if (
    rawUrl.includes(STAGING_REF) ||
    rawUrl.includes(PRODUCTION_REF) ||
    rawUrl.includes('supabase.co') ||
    rawUrl.includes('pooler.supabase.com')
  ) {
    throw new Error(
      `[CRITICAL SECURITY GUARD]: LOCAL_POSTGRES_URL contiene referencias a Supabase remoto (${STAGING_REF} / ${PRODUCTION_REF}). Conexión remota prohibida.`
    );
  }

  // 2. Parsear URL y verificar hostname
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err: any) {
    throw new Error(`[CRITICAL SECURITY GUARD]: LOCAL_POSTGRES_URL no es una URL válida: ${err?.message}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowedLocalHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!allowedLocalHosts.has(hostname)) {
    throw new Error(
      `[CRITICAL SECURITY GUARD]: Host '${hostname}' en LOCAL_POSTGRES_URL no es un host local permitido (${Array.from(allowedLocalHosts).join(', ')}). Conexión a bases remotas estrictamente prohibida en 2B-1.`
    );
  }
}

describe('Mini-Sprint 2B-1: Arnés Multi-Conexión PostgreSQL de Concurrencia y Anti-Deadlock', () => {
  if (!localPgUrl) {
    test('AUDIT / DIAGNOSTICO: Concurrencia multi-conexión real sujeta a PostgreSQL local', (t) => {
      console.log('================================================================================');
      console.log('ESTADO DEL ARNÉS: [NO EJECUTADO POR FALTA DE ENTORNO POSTGRESQL LOCAL]');
      console.log('  Motivo: Variable LOCAL_POSTGRES_URL no configurada en el entorno.');
      console.log('  El arnés multi-conexión está 100% codificado con barreras de sincronización,');
      console.log('  lock_timeout, statement_timeout, captura de código 40P01 y comprobación');
      console.log('  de residuo cero.');
      console.log('  COMPUERTA OBLIGATORIA PENDIENTE:');
      console.log('  La validación física de concurrencia multi-proceso se ejecutará en la sesión');
      console.log('  controlada de Staging mediante el runner seguro staging-qa-concurrency-bridge.ts.');
      console.log('================================================================================');
      t.skip('Arnés local pendiente: requiere servidor PostgreSQL local vía LOCAL_POSTGRES_URL.');
    });
    return;
  }

  test('EJECUTADO: Carrera simultánea de 4 conexiones independientes con barrera de sincronización', async () => {
    // Validar aislamiento local antes de requerir librerías o abrir sockets
    assertStrictLocalPostgresUrl(localPgUrl);

    let pgModule: any;
    try {
      pgModule = await import('pg');
    } catch {
      throw new Error('[EJECUTADO Y FALLIDO]: Módulo "pg" no disponible en runtime para ejecutar el arnés.');
    }

    const { Pool } = pgModule.default || pgModule;
    const pool = new Pool({
      connectionString: localPgUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
    });

    // Identificadores únicos dinámicos por ejecución para garantizar aislamiento absoluto
    const uid_Source = crypto.randomUUID();
    const uid_Target = crypto.randomUUID();
    const encId = crypto.randomUUID();

    // Registro de identificadores para verificación determinista de residuo cero
    const trackedUserIds = [uid_Source, uid_Target];
    const trackedEncounterIds = [encId];
    const trackedTicketTokens: string[] = [];

    const clientAdmin = await pool.connect();
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const client3 = await pool.connect();
    const client4 = await pool.connect();

    try {
      // Configurar timeouts en todas las conexiones de prueba para fail-fast
      const workers = [client1, client2, client3, client4];
      for (const c of workers) {
        await c.query(`SET statement_timeout = '10s';`);
        await c.query(`SET lock_timeout = '5s';`);
      }

      // 1. Setup administrativo de fixtures respetando el esquema real de Supabase
      await clientAdmin.query(`
        INSERT INTO auth.users (id, email, is_anonymous, created_at, updated_at) VALUES
          ('${uid_Source}', 'harness_${uid_Source.slice(0, 8)}@test.com', true, now(), now()),
          ('${uid_Target}', 'harness_${uid_Target.slice(0, 8)}@test.com', true, now(), now())
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.encuentros (
          id, host_id, titulo, estado, fecha, hora, modalidad, tipo_invitacion, post_event_active_minutes, creado_en
        ) VALUES (
          ('${encId}'), ('${uid_Source}'), ('Encuentro Multi-Conexion Harness'), ('activo'),
          (CURRENT_DATE + interval '3 days'), ('20:00'), ('presencial'), ('link_general'), (45), (now())
        );
      `);

      // Habilitar kill switch temporalmente para la prueba
      await clientAdmin.query(`SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', true);`);

      // 2. Emitir ticket inicial en client1
      await client1.query(`
        SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);
        SELECT set_config('request.jwt.claim.role', 'authenticated', false);
        SELECT set_config('request.jwt.claim.is_anonymous', 'true', false);
        SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);
      `);
      const emisionRes = await client1.query(`
        SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_Target}') AS r;
      `);
      const ticketToken = emisionRes.rows[0].r.ticket_token;
      assert.ok(ticketToken, 'El ticket de prueba debe ser emitido');
      trackedTicketTokens.push(ticketToken);

      // 3. Preparación de claims por worker previo a la barrera
      await client1.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Target}', false);`);
      await client1.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Target}","is_anonymous":true}', false);`);

      await client2.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client2.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      await client3.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client3.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      await client4.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client4.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      // 4. Barrera de Sincronización Promise: despacho atómico en paralelo
      let releaseBarrier!: () => void;
      const barrierPromise = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const workerPromises = [
        // Worker 1: Canje simultáneo desde Target
        (async () => {
          await barrierPromise;
          try {
            const r = await client1.query(`SELECT public.claim_domain_migration_ticket_seguro('${ticketToken}') AS res;`);
            return { worker: 'claim', ok: true, data: r.rows[0].res, error: null };
          } catch (err: any) {
            return { worker: 'claim', ok: false, data: null, error: err };
          }
        })(),

        // Worker 2: Re-emisión simultánea desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client2.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_Target}') AS res;`);
            return { worker: 'create_ticket', ok: true, data: r.rows[0].res, error: null };
          } catch (err: any) {
            return { worker: 'create_ticket', ok: false, data: null, error: err };
          }
        })(),

        // Worker 3: Revocación simultánea desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client3.query(`SELECT public.revoke_my_pending_transfer_ticket() AS res;`);
            return { worker: 'revoke', ok: true, data: r.rows[0].res, error: null };
          } catch (err: any) {
            return { worker: 'revoke', ok: false, data: null, error: err };
          }
        })(),

        // Worker 4: Publicación simultánea de mensaje desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client4.query(`SELECT public.publicar_mensaje_encuentro_seguro('${encId}', 'Mensaje concurrente') AS res;`);
            return { worker: 'message', ok: true, data: r.rows[0].res, error: null };
          } catch (err: any) {
            return { worker: 'message', ok: false, data: null, error: err };
          }
        })(),
      ];

      // Disparar las 4 conexiones exactamente en el mismo instante
      releaseBarrier();
      const results = await Promise.all(workerPromises);

      // 5. Análisis y Distinción Rigurosa de Resultados por Worker
      for (const res of results) {
        if (!res.ok) {
          const err = res.error;
          assert.notEqual(err.code, '40P01', `[EJECUTADO Y FALLIDO]: Interbloqueo deadlock (40P01) en ${res.worker}: ${err.message}`);
          assert.notEqual(err.code, '55P03', `[EJECUTADO Y FALLIDO]: Lock timeout (55P03) en ${res.worker}`);
          throw new Error(`[EJECUTADO Y FALLIDO]: Error SQL inesperado en ${res.worker}: ${err.message} (${err.code})`);
        }
      }

      // 6. Verificación de Invariantes de Exclusividad y Estado Terminal
      const ticketRecord = await clientAdmin.query(`
        SELECT status, used_at, target_user_id_snapshot
        FROM public.anonymous_transfer_tickets
        WHERE token_hash = encode(sha256('${ticketToken}'::bytea), 'hex');
      `);
      assert.ok(ticketRecord.rows.length > 0, 'El ticket debe existir');
      const finalStatus = ticketRecord.rows[0].status;

      const claimRes = results.find((r) => r.worker === 'claim')!.data;
      const revokeRes = results.find((r) => r.worker === 'revoke')!.data;
      const createRes = results.find((r) => r.worker === 'create_ticket')!.data;
      const msgRes = results.find((r) => r.worker === 'message')!.data;

      if (claimRes.ok === true) {
        // PERMUTACION A: El canje ganó la carrera de concurrencia
        assert.equal(finalStatus, 'completed', 'El ticket debe haber quedado en completed');
        assert.ok(ticketRecord.rows[0].used_at, 'used_at debe estar presente tras canje exitoso');
        assert.equal(ticketRecord.rows[0].target_user_id_snapshot, uid_Target);

        // La re-emisión debe haber sido rechazada (ticket pendiente o sesión ya migrada)
        assert.equal(createRes.ok, false, 'La re-emisión concurrente no puede triunfar si el canje completó la transferencia');
        assert.ok(
          ['transfer_ticket_already_pending', 'anonymous_session_already_migrated'].includes(createRes.error),
          `Error funcional esperado en re-emisión, recibido: ${createRes.error}`
        );

        // El encuentro debe haber sido transferido a Target
        const encCheck = await clientAdmin.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
        assert.equal(encCheck.rows[0].host_id, uid_Target, 'El encuentro debe pertenecer al nuevo titular Target');

        // La revocación simultánea no debe haber revocado el ticket ya completado
        assert.ok(
          revokeRes.revoked_count === 0 || revokeRes.error === 'anonymous_session_already_migrated',
          'La revocación no debe alterar un ticket ya completado'
        );

        // Verificación del worker de mensajería frente a la transferencia
        if (msgRes.ok === true) {
          // Si el mensaje se insertó antes del canje, la transferencia debió migrar su autoría a uid_Target
          const msgCheck = await clientAdmin.query(`SELECT autor_user_id FROM public.mensajes_encuentro WHERE encuentro_id = '${encId}';`);
          if (msgCheck.rows.length > 0) {
            assert.equal(msgCheck.rows[0].autor_user_id, uid_Target, 'Si el mensaje se publicó antes del canje, su autoría debe pertenecer a Target');
          }
        } else {
          // Si el mensaje se intentó tras el canje, debió ser rechazado por retiro de identidad
          assert.equal(msgRes.error, 'anonymous_session_already_migrated', 'Mensaje posterior al canje debe fallar por identidad retirada');
        }
      } else {
        // PERMUTACION B: La revocación ganó la carrera de concurrencia
        assert.equal(revokeRes.ok, true, 'Revocación debió ser exitosa si el canje no completó');
        assert.equal(revokeRes.revoked_count, 1, 'Debió revocar exactamente 1 ticket pendiente');
        assert.equal(finalStatus, 'revoked', 'Estado terminal del ticket debe ser revoked');
        assert.equal(claimRes.error, 'ticket_revoked', 'El canje debió ser rechazado por ticket_revoked');

        // El encuentro debe seguir perteneciendo a Source
        const encCheck = await clientAdmin.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
        assert.equal(encCheck.rows[0].host_id, uid_Source, 'El encuentro debe mantenerse en el host original Source');

        // Si la re-emisión creó un nuevo ticket tras la revocación, registrar su token para limpieza
        if (createRes.ok && createRes.ticket_token) {
          trackedTicketTokens.push(createRes.ticket_token);
        }
      }

      console.log('================================================================================');
      console.log('ESTADO DEL ARNÉS: [EJECUTADO Y APROBADO]');
      console.log(`  4 transacciones concurrentes serializadas limpiamente. Cero deadlocks (40P01).`);
      console.log(`  Estado terminal del ticket: ${finalStatus}. Cero inconsistencias.`);
      console.log('================================================================================');
    } finally {
      // 7. Limpieza Determinista y Verificación de Residuo Cero
      let cleanupFailed = false;
      let cleanupError: any = null;
      try {
        await clientAdmin.query(`
          DELETE FROM public.mensajes_encuentro WHERE encuentro_id = ANY(ARRAY['${trackedEncounterIds.join("','")}']::uuid[]);
          DELETE FROM public.participantes WHERE encuentro_id = ANY(ARRAY['${trackedEncounterIds.join("','")}']::uuid[]);
          DELETE FROM public.encuentros WHERE id = ANY(ARRAY['${trackedEncounterIds.join("','")}']::uuid[]);
          DELETE FROM public.anonymous_transfer_tickets WHERE source_user_id_snapshot = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]) OR target_user_id_snapshot = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]);
          DELETE FROM public.rate_limit_buckets WHERE user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]);
          DELETE FROM public.inbox_notifications WHERE recipient_user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]);
          DELETE FROM public.notification_delivery_outbox WHERE recipient_user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]);
          DELETE FROM auth.users WHERE id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]);
          SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', false);
        `);

        // Comprobación exhaustiva de residuo cero (ningún count nulo ni asumido cero)
        const residueCheck = await clientAdmin.query(`
          SELECT
            (SELECT COUNT(*) FROM public.encuentros WHERE id = ANY(ARRAY['${trackedEncounterIds.join("','")}']::uuid[])) AS enc_count,
            (SELECT COUNT(*) FROM public.mensajes_encuentro WHERE encuentro_id = ANY(ARRAY['${trackedEncounterIds.join("','")}']::uuid[])) AS msg_count,
            (SELECT COUNT(*) FROM public.anonymous_transfer_tickets WHERE source_user_id_snapshot = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[]) OR target_user_id_snapshot = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[])) AS ticket_count,
            (SELECT COUNT(*) FROM public.rate_limit_buckets WHERE user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[])) AS rate_limit_count,
            (SELECT COUNT(*) FROM public.inbox_notifications WHERE recipient_user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[])) AS notif_count,
            (SELECT COUNT(*) FROM public.notification_delivery_outbox WHERE recipient_user_id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[])) AS outbox_count,
            (SELECT COUNT(*) FROM auth.users WHERE id = ANY(ARRAY['${trackedUserIds.join("','")}']::uuid[])) AS user_count;
        `);
        const row = residueCheck.rows[0];
        for (const [col, countVal] of Object.entries(row)) {
          if (countVal === null || countVal === undefined) {
            throw new Error(`Residuo indeterminado: ${col} retornó null/undefined (posible error SQL)`);
          }
          assert.equal(Number(countVal), 0, `Residuo en ${col} debe ser estrictamente 0, encontrado: ${countVal}`);
        }
      } catch (err: any) {
        cleanupFailed = true;
        cleanupError = err;
        const manifest = {
          timestamp: new Date().toISOString(),
          status: 'CLEANUP_FAILED',
          error: err?.message || String(err),
          trackedUserIds,
          trackedEncounterIds,
          trackedTicketTokens,
        };
        const manifestPath = path.resolve(process.cwd(), `recovery-manifest-local-harness-${Date.now()}.json`);
        try {
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          console.error(`[CRITICAL] Limpieza falló. Manifiesto de recuperación guardado en: ${manifestPath}`);
        } catch (writeErr) {
          console.error(`[CRITICAL] Fallo al escribir manifiesto de recuperación:`, writeErr);
        }
      } finally {
        client1.release();
        client2.release();
        client3.release();
        client4.release();
        clientAdmin.release();
        await pool.end();
      }

      if (cleanupFailed) {
        throw new Error(`[EJECUTADO Y FALLIDO]: La limpieza o verificación de residuo cero falló: ${cleanupError?.message}`);
      }

      client1.release();
      client2.release();
      client3.release();
      client4.release();
      clientAdmin.release();
      await pool.end();
    }
  });
});
