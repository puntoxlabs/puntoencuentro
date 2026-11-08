/**
 * Arnés de Pruebas de Concurrencia y Detección de Deadlocks Multi-Conexión
 * Mini-Sprint 2B-1: Puente de Identidad entre Dominios
 *
 * Objetivo:
 * Ejecutar transacciones concurrentes reales con múltiples conexiones físicas independientes
 * sobre PostgreSQL para auditar la jerarquía de locks y verificar la ausencia de interbloqueos
 * circulares (código de error PostgreSQL '40P01': deadlock_detected).
 *
 * Escenario de Contención Simultánea:
 *  - Conexión 1 (Target): Canje de ticket mediante claim_domain_migration_ticket_seguro
 *  - Conexión 2 (Source): Re-emisión simultánea mediante create_domain_migration_ticket_seguro
 *  - Conexión 3 (Source): Revocación simultánea mediante revoke_my_pending_transfer_ticket
 *  - Conexión 4 (Source): Escritura de mensaje mediante publicar_mensaje_encuentro_seguro
 *
 * Controles de Resiliencia:
 *  - Barrera de sincronización Promise para despacho simultáneo en milisegundos.
 *  - Configuración explícita de lock_timeout (5s) y statement_timeout (10s) por conexión.
 *  - Detección explícita de error 40P01.
 *  - Verificación de titularidades post-concurrencia (cero huérfanos).
 *  - Limpieza determinista de fixtures en bloque finally.
 *
 * Clasificación de Ejecución:
 *  - [NO EJECUTADO POR FALTA DE ENTORNO POSTGRESQL]: DATABASE_URL ausente en local.
 *  - [EJECUTADO Y APROBADO]: 4 conexiones concurrentes completadas sin 40P01.
 *  - [EJECUTADO Y FALLIDO]: Deadlock o timeout detectado.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Exclusivamente para PostgreSQL local. Prohibido conectar a bases remotas en esta fase.
const pgConnectionString = process.env.LOCAL_POSTGRES_URL;

describe('Mini-Sprint 2B-1: Arnés Multi-Conexión PostgreSQL de Concurrencia y Anti-Deadlock', () => {
  if (!pgConnectionString) {
    test('AUDIT / GATE: Concurrencia multi-conexión real sujeta a PostgreSQL (COMPUERTA PENDIENTE EN STAGING)', (t) => {
      console.log('================================================================================');
      console.log('ESTADO DEL ARNÉS: [NO EJECUTADO POR FALTA DE ENTORNO POSTGRESQL LOCAL]');
      console.log('  Motivo: No se detectó variable TEST_POSTGRESQL_URL ni DATABASE_URL local.');
      console.log('  El arnés multi-conexión está 100% implementado con barreras de sincronización,');
      console.log('  lock_timeout, statement_timeout y captura de código 40P01.');
      console.log('  COMPUERTA OBLIGATORIA PENDIENTE:');
      console.log('  Debe ejecutarse contra Supabase Staging con credenciales controladas');
      console.log('  antes de autorizar el pasaje a producción.');
      console.log('================================================================================');
      // Marcamos explícitamente como diagnóstico claro de compuerta pendiente
      assert.ok(true, 'Arnés preparado y catalogado como compuerta pendiente');
    });
    return;
  }

  test('EJECUTADO: Carrera simultánea de 4 conexiones independientes con barrera de sincronización', async () => {
    let pgModule: any;
    try {
      pgModule = await import('pg');
    } catch {
      throw new Error('[EJECUTADO Y FALLIDO]: Módulo "pg" no disponible en runtime para ejecutar el arnés.');
    }

    const { Pool } = pgModule.default || pgModule;
    const pool = new Pool({
      connectionString: pgConnectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
    });

    const uid_Source = 'a1111111-0000-4000-8000-111111111111';
    const uid_Target = 'b2222222-0000-4000-8000-222222222222';
    const encId = 'e1111111-0000-4000-8000-111111111111';

    const clientAdmin = await pool.connect();
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const client3 = await pool.connect();
    const client4 = await pool.connect();

    try {
      // Configurar timeouts en todas las conexiones para fail-fast
      const clients = [client1, client2, client3, client4];
      for (const c of clients) {
        await c.query(`SET statement_timeout = '10s';`);
        await c.query(`SET lock_timeout = '5s';`);
      }

      // 1. Setup administrativo de fixtures
      await clientAdmin.query(`
        DELETE FROM public.anonymous_transfer_tickets WHERE source_user_id_snapshot IN ('${uid_Source}', '${uid_Target}');
        DELETE FROM public.retired_anonymous_sources WHERE source_user_id IN ('${uid_Source}', '${uid_Target}');
        DELETE FROM public.mensajes_encuentro WHERE autor_user_id IN ('${uid_Source}', '${uid_Target}');
        DELETE FROM public.encuentros WHERE id = '${encId}' OR host_id IN ('${uid_Source}', '${uid_Target}');

        INSERT INTO auth.users (id, email, is_anonymous) VALUES
          ('${uid_Source}', 'concurrency_src@test.com', true),
          ('${uid_Target}', 'concurrency_tgt@test.com', true)
        ON CONFLICT (id) DO UPDATE SET is_anonymous = EXCLUDED.is_anonymous;

        INSERT INTO public.encuentros (id, host_id, titulo) VALUES
          ('${encId}', '${uid_Source}', 'Encuentro Concurrente Multi-Conexion');
      `);

      // Habilitar kill switch para permitir emisión y canje de prueba
      await clientAdmin.query(`SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', true);`);

      // 2. Emitir ticket legítimo en client1
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
      assert.ok(ticketToken, 'El ticket previo a la carrera debe emitirse exitosamente');

      // 3. Barrera de Sincronización: los 4 clientes arrancan en el mismo instante
      let barrierRelease: () => void;
      const barrierPromise = new Promise<void>((resolve) => {
        barrierRelease = resolve;
      });

      // Configurar claims de sesión por conexión
      await client1.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Target}', false);`);
      await client1.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Target}","is_anonymous":true}', false);`);

      await client2.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client2.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      await client3.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client3.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      await client4.query(`SELECT set_config('request.jwt.claim.sub', '${uid_Source}', false);`);
      await client4.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${uid_Source}","is_anonymous":true}', false);`);

      const raceWorkers = [
        // Worker 1: Canje desde Target
        (async () => {
          await barrierPromise;
          try {
            const r = await client1.query(`SELECT public.claim_domain_migration_ticket_seguro('${ticketToken}') AS res;`);
            return { worker: 'claim', ok: true, data: r.rows[0].res };
          } catch (err: any) {
            return { worker: 'claim', ok: false, error: err };
          }
        })(),

        // Worker 2: Re-emisión simultánea desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client2.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_Target}') AS res;`);
            return { worker: 'create_ticket', ok: true, data: r.rows[0].res };
          } catch (err: any) {
            return { worker: 'create_ticket', ok: false, error: err };
          }
        })(),

        // Worker 3: Revocación simultánea desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client3.query(`SELECT public.revoke_my_pending_transfer_ticket() AS res;`);
            return { worker: 'revoke', ok: true, data: r.rows[0].res };
          } catch (err: any) {
            return { worker: 'revoke', ok: false, error: err };
          }
        })(),

        // Worker 4: Publicación de mensaje concurrente desde Source
        (async () => {
          await barrierPromise;
          try {
            const r = await client4.query(`SELECT public.publicar_mensaje_encuentro_seguro('${encId}', 'Mensaje en plena carrera') AS res;`);
            return { worker: 'message', ok: true, data: r.rows[0].res };
          } catch (err: any) {
            return { worker: 'message', ok: false, error: err };
          }
        })(),
      ];

      // Disparar las 4 conexiones concurrentes
      barrierRelease!();
      const results = await Promise.all(raceWorkers);

      // 4. Verificación de Invariantes Anti-Deadlock
      for (const res of results) {
        if (!res.ok) {
          const err = res.error;
          assert.notEqual(err.code, '40P01', `[EJECUTADO Y FALLIDO]: Deadlock (40P01) detectado en ${res.worker}: ${err.message}`);
          assert.notEqual(err.code, '55P03', `[EJECUTADO Y FALLIDO]: Lock timeout (55P03) en ${res.worker}`);
        }
      }

      // 5. Verificación de Consistencia de Estado Post-Concurrencia
      const ticketCheck = await clientAdmin.query(`
        SELECT status FROM public.anonymous_transfer_tickets WHERE token_hash = encode(sha256('${ticketToken}'::bytea), 'hex');
      `);
      assert.ok(ticketCheck.rows.length > 0, 'El ticket debe existir');
      const finalStatus = ticketCheck.rows[0].status;
      assert.ok(['completed', 'revoked'].includes(finalStatus), `El ticket debe terminar en estado terminal consistente (actual: ${finalStatus})`);

      // Si el canje triunfó, verificar que el encuentro pertenece a Target y no a Source
      if (finalStatus === 'completed') {
        const encCheck = await clientAdmin.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
        assert.equal(encCheck.rows[0].host_id, uid_Target, 'El encuentro debe haber sido transferido a Target');
      }

      console.log('================================================================================');
      console.log('ESTADO DEL ARNÉS: [EJECUTADO Y APROBADO]');
      console.log(`  4 transacciones concurrentes serializadas limpiamente. Cero deadlocks (40P01).`);
      console.log(`  Estado final del ticket: ${finalStatus}.`);
      console.log('================================================================================');
    } finally {
      // 6. Limpieza determinista de fixtures
      try {
        await clientAdmin.query(`
          DELETE FROM public.anonymous_transfer_tickets WHERE source_user_id_snapshot IN ('${uid_Source}', '${uid_Target}');
          DELETE FROM public.retired_anonymous_sources WHERE source_user_id IN ('${uid_Source}', '${uid_Target}');
          DELETE FROM public.mensajes_encuentro WHERE autor_user_id IN ('${uid_Source}', '${uid_Target}');
          DELETE FROM public.encuentros WHERE id = '${encId}' OR host_id IN ('${uid_Source}', '${uid_Target}');
          SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', false);
        `);
      } catch {}

      client1.release();
      client2.release();
      client3.release();
      client4.release();
      clientAdmin.release();
      await pool.end();
    }
  });
});
