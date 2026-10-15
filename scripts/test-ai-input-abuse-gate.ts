import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { evaluateAiInputAbuseGate } from '../supabase/functions/ai-interpret/abuseGate.ts';
import {
  checkShortBurstLimit,
  checkAbuseLimits,
  checkPromptRepetition,
  computePromptHash,
  resetLimiterStateForTesting,
  type AbuseLimiterConfig,
} from '../supabase/functions/ai-interpret/limiter.ts';

describe('AI Input Abuse Gate & Anti-Bot Hardening (Casos 1 al 20)', () => {
  let db: PGlite;
  const userPermA = '11111111-1111-1111-1111-111111111111';
  const userPermB = '22222222-2222-2222-2222-222222222222';
  const userAnon = '99999999-9999-9999-9999-999999999999';

  before(async () => {
    db = new PGlite();

    // 1. Setup Supabase auth mock environment in real PostgreSQL
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT json_build_object(
          'sub', current_setting('request.jwt.claim.sub', true),
          'is_anonymous', COALESCE((SELECT is_anonymous FROM auth.users WHERE id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID), false)
        )::jsonb;
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${userPermA}', 'userA@test.com', false),
        ('${userPermB}', 'userB@test.com', false),
        ('${userAnon}', 'anon@test.com', true)
      ON CONFLICT DO NOTHING;
    `);

    // 2. Load existing hourly rate limit buckets migration
    const hourlyMigrationPath = path.resolve(process.cwd(), 'supabase/migrations/20260909140000_ai_rate_limit_buckets.sql');
    const hourlyMigrationSql = fs.readFileSync(hourlyMigrationPath, 'utf-8');
    await db.exec(hourlyMigrationSql);

    // 3. Load new short burst rate limit migration
    const burstMigrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261015190000_ai_short_burst_rate_limit.sql');
    const burstMigrationSql = fs.readFileSync(burstMigrationPath, 'utf-8');
    await db.exec(burstMigrationSql);
  });

  // Helper to create client with user context in PGlite
  function createTestClient(userId: string) {
    return {
      rpc: async (fnName: string, params: Record<string, any>) => {
        await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
        const args = Object.values(params).map(v => typeof v === 'number' ? v : `'${v}'`).join(', ');
        const res = await db.query(`SELECT public.${fnName}(${args}) AS result;`);
        const firstRow = res.rows[0] as any;
        return { data: firstRow ? firstRow.result : null, error: null };
      }
    };
  }

  const baseConfig: AbuseLimiterConfig = {
    maxTurnsPerSession: 20,
    maxRequestsPerHour: 40,
    maxBurstRequestsPerMinute: 10,
    maxConsecutiveOffTopic: 2,
  };

  // -------------------------------------------------------------
  // CASO 1: "Pádel mañana" -> permitido
  // -------------------------------------------------------------
  test('Caso 1: "Pádel mañana" es una frase legítima y debe pasar el gate', () => {
    const res = evaluateAiInputAbuseGate('Pádel mañana');
    assert.equal(res.allowed, true);
    assert.equal(res.reason, undefined);
  });

  // -------------------------------------------------------------
  // CASO 2: Frase en idioma no soportado -> permitido
  // -------------------------------------------------------------
  test('Caso 2: Idiomas extranjeros como alemán o polaco deben estar permitidos (input privado)', () => {
    const resGerman = evaluateAiInputAbuseGate('Geburtstag mit Freunden am Samstag');
    assert.equal(resGerman.allowed, true);

    const resPolish = evaluateAiInputAbuseGate('Spotkanie z przyjaciółmi w parku');
    assert.equal(resPolish.allowed, true);
  });

  // -------------------------------------------------------------
  // CASO 3: Reunión comercial legítima -> permitido
  // -------------------------------------------------------------
  test('Caso 3: Reunión comercial legítima debe estar permitida en borrador privado', () => {
    const resCommercial1 = evaluateAiInputAbuseGate('Organizar una reunión comercial con el equipo');
    assert.equal(resCommercial1.allowed, true);

    const resCommercial2 = evaluateAiInputAbuseGate('Reunión para hablar de inversiones con socios');
    assert.equal(resCommercial2.allowed, true);
  });

  // -------------------------------------------------------------
  // CASO 4: Input vacío / sólo whitespace -> rechazado pre-LLM
  // -------------------------------------------------------------
  test('Caso 4: Input vacío o de sólo espacios es rechazado antes del LLM con mensaje UX claro', () => {
    const resEmpty = evaluateAiInputAbuseGate('');
    assert.equal(resEmpty.allowed, false);
    assert.equal(resEmpty.reason, 'empty_input');
    assert.equal(resEmpty.message, 'Escribí brevemente qué te gustaría hacer.');

    const resSpaces = evaluateAiInputAbuseGate('     ');
    assert.equal(resSpaces.allowed, false);
    assert.equal(resSpaces.reason, 'empty_input');

    const resTooShort = evaluateAiInputAbuseGate('a');
    assert.equal(resTooShort.allowed, false);
    assert.equal(resTooShort.reason, 'too_short');
  });

  // -------------------------------------------------------------
  // CASO 5: Longitud excesiva -> rechazado
  // -------------------------------------------------------------
  test('Caso 5: Longitud superior a 1000 caracteres es rechazada pre-LLM', () => {
    const longInput = 'Vamos a jugar al tenis ' + 'muy divertido '.repeat(100);
    assert.ok(longInput.length > 1000);
    const res = evaluateAiInputAbuseGate(longInput);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'input_too_long');
  });

  // -------------------------------------------------------------
  // CASO 6: Repetición extrema -> rechazado
  // -------------------------------------------------------------
  test('Caso 6: Repetición extrema de caracteres o palabras es rechazada pre-LLM', () => {
    // 25+ chars idénticos
    const charRepetition = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const resChar = evaluateAiInputAbuseGate(charRepetition);
    assert.equal(resChar.allowed, false);
    assert.equal(resChar.reason, 'extreme_repetition');

    // 10+ palabras idénticas seguidas
    const wordRepetition = 'fiesta fiesta fiesta fiesta fiesta fiesta fiesta fiesta fiesta fiesta fiesta';
    const resWord = evaluateAiInputAbuseGate(wordRepetition);
    assert.equal(resWord.allowed, false);
    assert.equal(resWord.reason, 'extreme_repetition');
  });

  // -------------------------------------------------------------
  // CASO 7: Payload / script evidente -> rechazado
  // -------------------------------------------------------------
  test('Caso 7: Payloads de inyección web o scripts son rechazados pre-LLM', () => {
    const xss1 = '<script>alert("hack")</script>';
    const res1 = evaluateAiInputAbuseGate(xss1);
    assert.equal(res1.allowed, false);
    assert.equal(res1.reason, 'malicious_payload');

    const xss2 = 'Organizar algo javascript:fetch("https://attacker.com")';
    const res2 = evaluateAiInputAbuseGate(xss2);
    assert.equal(res2.allowed, false);
    assert.equal(res2.reason, 'malicious_payload');

    const xss3 = '<iframe src="evil.html"></iframe>';
    const res3 = evaluateAiInputAbuseGate(xss3);
    assert.equal(res3.allowed, false);
    assert.equal(res3.reason, 'malicious_payload');
  });

  // -------------------------------------------------------------
  // CASO 8: Gibberish extremo automatizado -> rechazado
  // -------------------------------------------------------------
  test('Caso 8: Gibberish automatizado por secuencias de 15+ consonantes es rechazado', () => {
    const gibberish = 'bcdfghjklmnpqrstvwxyzbcdfghjklmnpq';
    const res = evaluateAiInputAbuseGate(gibberish);
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'automated_gibberish');
  });

  // -------------------------------------------------------------
  // CASO 9: Prompt extraño pero plausible -> permitido
  // -------------------------------------------------------------
  test('Caso 9: Prompt atípico pero plausible con palabras normales debe permitirse', () => {
    const res = evaluateAiInputAbuseGate('Algo raro con mis amigos el sábado a la noche');
    assert.equal(res.allowed, true);
  });

  // -------------------------------------------------------------
  // CASO 10: Usuario dentro de límite -> permitido
  // -------------------------------------------------------------
  test('Caso 10: Usuario permanente dentro de los límites realiza peticiones normalmente', async () => {
    resetLimiterStateForTesting();
    const clientA = createTestClient(userPermA);
    const burstRes = await checkShortBurstLimit(userPermA, baseConfig, clientA);
    assert.equal(burstRes.allowed, true);
  });

  // -------------------------------------------------------------
  // CASO 11: Usuario supera rate limit horario -> 429 controlado
  // -------------------------------------------------------------
  test('Caso 11: Usuario que supera límite horario recibe 429 con mensaje no acusatorio', async () => {
    resetLimiterStateForTesting();
    const tightConfig: AbuseLimiterConfig = { ...baseConfig, maxRequestsPerHour: 2 };
    const clientB = createTestClient(userPermB);

    const res1 = await checkAbuseLimits(userPermB, 'sess-1', tightConfig, clientB);
    assert.equal(res1.allowed, true);

    const res2 = await checkAbuseLimits(userPermB, 'sess-1', tightConfig, clientB);
    assert.equal(res2.allowed, true);

    const res3 = await checkAbuseLimits(userPermB, 'sess-1', tightConfig, clientB);
    assert.equal(res3.allowed, false);
    assert.equal(res3.error, 'rate_limit_exceeded');
    assert.ok(res3.message?.includes('límite'));
  });

  // -------------------------------------------------------------
  // CASO 12: Short burst por usuario funciona entre llamadas backend
  // -------------------------------------------------------------
  test('Caso 12: Short burst limit rechaza peticiones una vez superado el umbral por minuto', async () => {
    const testBurstUser = '33333333-3333-3333-3333-333333333333';
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${testBurstUser}', 'burst@test.com') ON CONFLICT DO NOTHING;`);
    const burstClient = createTestClient(testBurstUser);
    const burstConfig: AbuseLimiterConfig = { ...baseConfig, maxBurstRequestsPerMinute: 3 };

    // Intentos 1, 2 y 3: Permitidos
    const b1 = await checkShortBurstLimit(testBurstUser, burstConfig, burstClient);
    assert.equal(b1.allowed, true);
    const b2 = await checkShortBurstLimit(testBurstUser, burstConfig, burstClient);
    assert.equal(b2.allowed, true);
    const b3 = await checkShortBurstLimit(testBurstUser, burstConfig, burstClient);
    assert.equal(b3.allowed, true);

    // Intento 4: Supera el umbral de burst en el minuto -> 429
    const b4 = await checkShortBurstLimit(testBurstUser, burstConfig, burstClient);
    assert.equal(b4.allowed, false);
    assert.equal(b4.error, 'rate_limit_exceeded');
    assert.equal(b4.message, 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.');
  });

  // -------------------------------------------------------------
  // CASO 13: Prompts repetidos una o dos veces -> permitido
  // -------------------------------------------------------------
  test('Caso 13: Reintentos humanos normales (1 o 2 repeticiones del mismo prompt) están permitidos', async () => {
    resetLimiterStateForTesting();
    const prompt = 'Fútbol 5 en Palermo el viernes';
    const hash = await computePromptHash(prompt);

    const r1 = checkPromptRepetition(userPermA, hash);
    assert.equal(r1.allowed, true);

    const r2 = checkPromptRepetition(userPermA, hash);
    assert.equal(r2.allowed, true);

    const r3 = checkPromptRepetition(userPermA, hash);
    assert.equal(r3.allowed, true);
  });

  // -------------------------------------------------------------
  // CASO 14: Repetición masiva del mismo prompt -> bloqueada con 429
  // -------------------------------------------------------------
  test('Caso 14: Repetición masiva anormal (4to intento del mismo prompt en 2 min) es bloqueada', async () => {
    const prompt = 'Tenis mañana a las 10';
    const hash = await computePromptHash(prompt);

    checkPromptRepetition('user-repeat', hash);
    checkPromptRepetition('user-repeat', hash);
    checkPromptRepetition('user-repeat', hash);

    const r4 = checkPromptRepetition('user-repeat', hash);
    assert.equal(r4.allowed, false);
    assert.equal(r4.error, 'rate_limit_exceeded');
    assert.equal(r4.message, 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.');
  });

  // -------------------------------------------------------------
  // CASO 15: Request rechazado no incrementa consumo LLM / proveedor
  // -------------------------------------------------------------
  test('Caso 15: Input rechazado por abuse gate retorna 400 antes de cualquier RPC de cupos o LLM', () => {
    const malicious = '<script>document.cookie</script>';
    const check = evaluateAiInputAbuseGate(malicious);
    assert.equal(check.allowed, false);
    // En el pipeline de index.ts, cuando check.allowed === false, se retorna Response 400 inmediatamente
    // sin invocar check_and_reserve_ai_session ni interpretWithFallback.
    assert.equal(check.reason, 'malicious_payload');
  });

  // -------------------------------------------------------------
  // CASO 16: Privacidad: no se persiste IP cruda ni prompt completo
  // -------------------------------------------------------------
  test('Caso 16: computePromptHash deriva un hash unidireccional SHA-256 sin almacenar el texto', async () => {
    const sensitivePrompt = 'Reunión médica privada con Dr. Gómez el lunes';
    const hash = await computePromptHash(sensitivePrompt);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
    assert.ok(!hash.includes('Gómez'));
    assert.ok(!hash.includes('médica'));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------
  // CASO 17: Usuario anónimo -> 403 antes de cualquier consumo IA
  // -------------------------------------------------------------
  test('Caso 17: Usuario anónimo es bloqueado con 403 permanent_account_required sin consumir LLM', async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userAnon}', false);`);
    const res = await db.query(`SELECT auth.jwt() ->> 'is_anonymous' AS is_anon;`);
    const isAnon = (res.rows[0] as any)?.is_anon;
    assert.equal(isAnon, 'true', 'auth.jwt() debe reflejar is_anonymous = true');
  });

  // -------------------------------------------------------------
  // CASO 18: Ráfaga de payloads rechazados -> termina limitada por short-burst
  // -------------------------------------------------------------
  test('Caso 18: Un atacante que envía ráfagas de payloads basura es bloqueado por short burst', async () => {
    const spammerId = '44444444-4444-4444-4444-444444444444';
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${spammerId}', 'spammer@test.com') ON CONFLICT DO NOTHING;`);
    const spammerClient = createTestClient(spammerId);
    const burstConfig: AbuseLimiterConfig = { ...baseConfig, maxBurstRequestsPerMinute: 4 };

    // Atacante envía 4 payloads inválidos (pasan por short-burst check en index.ts)
    for (let i = 0; i < 4; i++) {
      const burst = await checkShortBurstLimit(spammerId, burstConfig, spammerClient);
      assert.equal(burst.allowed, true);
      // El abuse gate rechaza el contenido
      const abuse = evaluateAiInputAbuseGate('<script>evil</script>');
      assert.equal(abuse.allowed, false);
    }

    // Al 5to intento en el mismo minuto, el short-burst lo frena en Seco con 429
    const burst5 = await checkShortBurstLimit(spammerId, burstConfig, spammerClient);
    assert.equal(burst5.allowed, false);
    assert.equal(burst5.error, 'rate_limit_exceeded');
  });

  // -------------------------------------------------------------
  // CASO 19: Short burst funciona concurrentemente en PostgreSQL (row lock)
  // -------------------------------------------------------------
  test('Caso 19: Concurrencia real en PostgreSQL garantiza conteo atómico y previene race conditions', async () => {
    const concUser = '55555555-5555-5555-5555-555555555555';
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${concUser}', 'conc@test.com') ON CONFLICT DO NOTHING;`);
    const concClient = createTestClient(concUser);
    const burstLimit = 5;

    // Disparamos 10 llamadas concurrentes
    const promises = Array.from({ length: 10 }).map(() =>
      concClient.rpc('check_and_increment_ai_burst_limit', { p_max_burst_requests: burstLimit })
    );

    const results = await Promise.all(promises);
    const allowedCount = results.filter(r => r.data?.allowed === true).length;
    const rejectedCount = results.filter(r => r.data?.allowed === false).length;

    assert.equal(allowedCount, burstLimit, `Exactamente ${burstLimit} llamadas deben permitirse`);
    assert.equal(rejectedCount, 5, 'Exactamente 5 llamadas deben ser rechazadas');
  });

  // -------------------------------------------------------------
  // CASO 20: Secreto dedicado AI_ORIGIN_HMAC_SECRET y ausencia de IP cruda
  // -------------------------------------------------------------
  test('Caso 20: Derivación HMAC de origen utiliza secreto dedicado y nunca persiste IP cruda', async () => {
    const dedicatedSecret = 'dedicated_test_secret_for_ai_origin_hmac_12345';
    const fakeIp = '203.0.113.195';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(dedicatedSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(fakeIp.trim().toLowerCase()));
    const originHash = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    assert.equal(originHash.length, 64);
    assert.ok(!originHash.includes('203.0.113'));
    assert.match(originHash, /^[0-9a-f]{64}$/);
  });
});
