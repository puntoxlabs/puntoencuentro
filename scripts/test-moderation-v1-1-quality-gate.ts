import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  evaluatePublicContentGate,
  evaluatePrivateAntiAbuseGate,
  detectSupportedLanguage,
  checkDuplicateContent,
  normalizeUnicode,
  collapseArtificialSpaces,
  replaceHomoglyphs,
} from '../src/lib/moderation/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Moderación v1.1: Calidad Pública + Anti-Spam Gate & Piso Antiabuso Privado', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const normalUser = '22222222-2222-2222-2222-222222222222';
  const adminUser = '33333333-3333-3333-3333-333333333333';

  const setAuthContext = async (userId: string | null, isAnon: boolean = false, role: string = 'authenticated') => {
    await db.query(`SELECT set_config('request.jwt.claim.role', '${role}', false);`);
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}, "role": "${role}"}', false);`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles y Mock Auth
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
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
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(current_setting('request.jwt.claim.role', true), 'authenticated');
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${normalUser}', 'normal@test.com'),
        ('${adminUser}', 'admin@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas base del dominio
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT NOT NULL,
        zona TEXT NOT NULL,
        pais TEXT NOT NULL DEFAULT 'AR',
        orden INT NOT NULL DEFAULT 1,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('guemes', 'Güemes / Playa Grande', 'Mar del Plata', 'Costa Atlántica', true),
        ('centro', 'Centro / La Perla', 'Mar del Plata', 'Costa Atlántica', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        host_id UUID NOT NULL REFERENCES auth.users(id),
        public_token UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT DEFAULT 'blue',
        tema_invitacion TEXT DEFAULT 'sports',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        reemplaza_a UUID,
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_description TEXT,
        max_participants INT,
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        duration_minutes INT DEFAULT 120,
        post_event_active_minutes INT DEFAULT 45,
        mostrar_respuestas_a_invitados BOOLEAN DEFAULT false,
        visibilidad_respuestas TEXT DEFAULT 'hidden',
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        max_seats_per_request INT DEFAULT 1,
        min_seats_per_request INT DEFAULT 1,
        moderation_status TEXT NOT NULL DEFAULT 'draft',
        moderation_reason TEXT,
        moderated_at TIMESTAMPTZ,
        moderation_decision_source TEXT,
        moderation_categories TEXT[],
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        token UUID DEFAULT gen_random_uuid(),
        seat_count INT NOT NULL DEFAULT 1,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.encuentro_opciones_fecha (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        hora_inicio TIME NOT NULL,
        orden INT NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS public.coordinacion_fase (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        estado TEXT NOT NULL DEFAULT 'voting',
        deadline TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMPTZ,
        dedup_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id),
        encuentro_id UUID REFERENCES public.encuentros(id),
        estado TEXT NOT NULL DEFAULT 'activa'
      );

      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(p_id UUID, p_enc UUID)
      RETURNS VOID AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INT NOT NULL,
        window_seconds INT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL,
        identifier TEXT NOT NULL,
        window_epoch BIGINT NOT NULL,
        count INT NOT NULL DEFAULT 1,
        PRIMARY KEY (action, identifier, window_epoch)
      );

      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL DEFAULT 'moderator',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        created_by UUID
      );

      INSERT INTO public.moderation_authorized_users (user_id, role, active) VALUES
        ('${adminUser}', 'admin', true)
      ON CONFLICT DO NOTHING;
    `);

    // 2. Cargar migraciones de Moderación v1, roles y circuito
    const m1Path = path.resolve(__dirname, '../supabase/migrations/20261009160000_public_content_moderation_v1.sql');
    await db.exec(fs.readFileSync(m1Path, 'utf8'));

    const mSepPath = path.resolve(__dirname, '../supabase/migrations/20261009210000_separate_moderation_roles.sql');
    await db.exec(fs.readFileSync(mSepPath, 'utf8'));

    const mCircPath = path.resolve(__dirname, '../supabase/migrations/20261014200000_human_moderation_operational_circuit.sql');
    await db.exec(fs.readFileSync(mCircPath, 'utf8'));

    // 3. Cargar la nueva migración aditiva de Moderación v1.1
    const mV11Path = path.resolve(__dirname, '../supabase/migrations/20261015150000_moderation_v1_1_quality_and_anti_spam.sql');
    await db.exec(fs.readFileSync(mV11Path, 'utf8'));
  });

  // ----------------------------------------------------------------------------
  // TESTS DE CONTENIDO PÚBLICO (TypeScript Gate)
  // ----------------------------------------------------------------------------

  test('Publicación pública normal en Español → ALLOW', () => {
    const res = evaluatePublicContentGate(
      'Tarde de juegos de mesa y mate',
      'Nos juntamos en la plaza a jugar Catan y tomar unos mates tranquilos. Traigan reposeras.'
    );
    assert.equal(res.decision, 'allow');
    assert.equal(res.reason_code, 'clean_social_meetup');
  });

  test('Publicación pública normal en Inglés → ALLOW', () => {
    const res = evaluatePublicContentGate(
      'Coffee & Board Games Meetup',
      'Join us this Saturday for coffee, conversation and board games in the park. Everyone is welcome to bring their favorite games.'
    );
    assert.equal(res.decision, 'allow');
    assert.equal(res.reason_code, 'clean_social_meetup');
  });

  test('Publicación pública normal en Portugués → ALLOW', () => {
    const res = evaluatePublicContentGate(
      'Roda de conversa e jogos de tabuleiro',
      'Vamos nos encontrar no parque para conversar, jogar e fazer novas amizades. Tragam jogos e lanches para compartilhar.'
    );
    assert.equal(res.decision, 'allow');
    assert.equal(res.reason_code, 'clean_social_meetup');
  });

  test('Texto corto legítimo o nombres propios no producen falsos positivos → ALLOW', () => {
    const res1 = evaluatePublicContentGate('After Office Tech & Beers', 'Charla sobre Rust y Go');
    assert.equal(res1.decision, 'allow');

    const res2 = evaluatePublicContentGate('Running 5K Costanera', 'Entrenamiento matutino suave');
    assert.equal(res2.decision, 'allow');
  });

  test('Idioma no soportado (Francés largo) → REVIEW (no BLOCK)', () => {
    const res = evaluatePublicContentGate(
      'Rencontre amicale autour du cafe',
      'Nous allons nous retrouver dans le centre pour parler, faire des jeux ensemble et boire un cafe avec tous les amis.'
    );
    assert.equal(res.decision, 'review');
    assert.equal(res.reason_code, 'unsupported_language');
    assert.ok(res.categories.includes('language'));
  });

  test('Idioma no soportado (Alemán largo) → REVIEW (no BLOCK)', () => {
    const res = evaluatePublicContentGate(
      'Gemutliches Treffen im Park',
      'Wir treffen uns heute Abend im Park mit Freunden. Wir machen Spiele zusammen und trinken Bier auf der Wiese.'
    );
    assert.equal(res.decision, 'review');
    assert.equal(res.reason_code, 'unsupported_language');
  });

  test('Basura / Gibberish evidente → BLOCK', () => {
    const res1 = evaluatePublicContentGate('asdfghjkl zxcvbnm', 'qwerqwerqwer qwerqwer');
    assert.equal(res1.decision, 'block');
    assert.equal(res1.reason_code, 'gibberish');

    const res2 = evaluatePublicContentGate('Juntada bcdfghjklmn', 'aaaaaaa bbbbbbbb ccccccc');
    assert.equal(res2.decision, 'block');
    assert.equal(res2.reason_code, 'gibberish');

    const res3 = evaluatePublicContentGate('Juntada', 'fiesta fiesta fiesta fiesta fiesta fiesta');
    assert.equal(res3.decision, 'block');
    assert.equal(res3.reason_code, 'gibberish');
  });

  test('Exceso de símbolos y puntuación abusiva → BLOCK', () => {
    const res1 = evaluatePublicContentGate('FIESTA FIESTA !!!!!!!', 'Vengan todos $$$$$$$');
    assert.equal(res1.decision, 'block');
    assert.equal(res1.reason_code, 'excessive_symbols');

    const res2 = evaluatePublicContentGate('Juntada en la plaza', '***+++***~~~!!!###$$$%%%');
    assert.equal(res2.decision, 'block');
    assert.equal(res2.reason_code, 'excessive_symbols');
  });

  test('Múltiples URLs masivas → BLOCK (commercial_spam)', () => {
    const res = evaluatePublicContentGate(
      'Gran evento social',
      'Mirá las fotos en https://fotos1.com y comprá entradas en https://entradas2.com'
    );
    assert.equal(res.decision, 'block');
    assert.equal(res.reason_code, 'commercial_spam');
  });

  test('URL única común → REVIEW (contains_link)', () => {
    const res = evaluatePublicContentGate(
      'Club de lectura y debate',
      'Vamos a comentar el libro que está disponible en https://wikipedia.org'
    );
    assert.equal(res.decision, 'review');
    assert.equal(res.reason_code, 'contains_link');
  });

  test('Contacto externo claro (wa.me / WhatsApp / Teléfono) → REVIEW', () => {
    const res1 = evaluatePublicContentGate('Juntada el finde', 'Escribime a https://wa.me/5491112345678');
    assert.equal(res1.decision, 'review');
    assert.equal(res1.reason_code, 'external_contact');

    const res2 = evaluatePublicContentGate('Picnic en el lago', 'Hablame al wsp 11-2345-6789 para coordinar');
    assert.equal(res2.decision, 'review');
    assert.equal(res2.reason_code, 'external_contact');

    const res3 = evaluatePublicContentGate('Salida al cine', 'Cualquier cosa escriban a organizador@gmail.com');
    assert.equal(res3.decision, 'review');
    assert.equal(res3.reason_code, 'external_contact');
  });

  test('Contacto ofuscado (espacios entre dígitos, arroba escrita) → REVIEW', () => {
    const res1 = evaluatePublicContentGate(
      'Paseo fotográfico',
      'Llamame al 1 1 5 6 7 8 9 0 1 2 para sumarte al grupo'
    );
    assert.equal(res1.decision, 'review');
    assert.equal(res1.reason_code, 'obfuscated_contact');

    const res2 = evaluatePublicContentGate(
      'Clase de cocina',
      'Mandame un mail a juan arroba hotmail punto com'
    );
    assert.equal(res2.decision, 'review');
    assert.equal(res2.reason_code, 'obfuscated_contact');
  });

  test('Publicidad comercial masiva / Captación laboral fraudulenta → BLOCK', () => {
    const res1 = evaluatePublicContentGate(
      'Oportunidad de ingresos',
      'Trabaja desde casa y gana dinero fácil con nuestro sistema de inversión de bajo riesgo'
    );
    assert.equal(res1.decision, 'block');
    assert.equal(res1.reason_code, 'commercial_spam');

    const res2 = evaluatePublicContentGate(
      'Inversiones Crypto',
      'Inversión en cripto asegurada con ganancias garantizadas en dólares mensuales'
    );
    assert.equal(res2.decision, 'block');
    assert.equal(res2.reason_code, 'possible_scam');
  });

  test('Phishing / Credencial / Robo de cuentas → BLOCK', () => {
    const res = evaluatePublicContentGate(
      'Verificación requerida',
      'Ingresá tu contraseña y verificá tu cuenta bancaria para participar'
    );
    assert.equal(res.decision, 'block');
    assert.equal(res.reason_code, 'possible_scam');
  });

  test('Contenido casi vacío (baja sustancia) → REVIEW (low_information_content)', () => {
    const res = evaluatePublicContentGate('Salida el viernes', 'hola');
    assert.equal(res.decision, 'review');
    assert.equal(res.reason_code, 'low_information_content');
    assert.equal(res.user_friendly_message, 'Necesitamos un título y una descripción que expliquen claramente de qué se trata el encuentro.');
  });

  test('Duplicados del mismo usuario en ventana 24h → BLOCK / REVIEW', () => {
    const history = [
      {
        id: 'enc-prev-1',
        title: 'Torneo de Truco en Güemes',
        description: 'Vengan a jugar al truco con parejas armadas o individuales.',
        created_at: new Date().toISOString(),
      },
    ];

    // Publicación idéntica
    const resExact = evaluatePublicContentGate(
      'Torneo de Truco en Güemes',
      'Vengan a jugar al truco con parejas armadas o individuales.',
      history
    );
    assert.equal(resExact.decision, 'block');
    assert.equal(resExact.reason_code, 'duplicate_content');

    // Publicación diferente del mismo usuario → ALLOW
    const resDiff = evaluatePublicContentGate(
      'Pádel en Los Naranjos',
      'Buscamos 2 personas para armar un partido de 6ta categoría.',
      history
    );
    assert.equal(resDiff.decision, 'allow');
    assert.equal(resDiff.reason_code, 'clean_social_meetup');
  });

  // ----------------------------------------------------------------------------
  // TESTS DE CONTENIDO PRIVADO (Piso Mínimo Antiabuso)
  // ----------------------------------------------------------------------------

  test('Contenido privado raro o informal → PERMITIDO', () => {
    const res1 = evaluatePrivateAntiAbuseGate('juntada xyz 1234 asdf', 'escabio y pizza en lo de cacho');
    assert.equal(res1.allowed, true);
    assert.equal(res1.reason, 'clean');
  });

  test('Contenido privado en otro idioma (Francés / Alemán / etc.) → PERMITIDO', () => {
    const resFrench = evaluatePrivateAntiAbuseGate('Reunion equipe Paris', 'Discussion autour du projet avec les collegues');
    assert.equal(resFrench.allowed, true);

    const resGerman = evaluatePrivateAntiAbuseGate('Projektbesprechung intern', 'Treffen wir uns online um 18 Uhr');
    assert.equal(resGerman.allowed, true);
  });

  test('Contenido privado comercial legítimo → PERMITIDO', () => {
    const res = evaluatePrivateAntiAbuseGate(
      'Presentación Comercial Q3 Clientes VIP',
      'Revisión de balance, métricas de ventas y propuesta de renovación para el directorio.'
    );
    assert.equal(res.allowed, true);
  });

  test('Phishing / Robo de credenciales en contenido privado → BLOQUEADO', () => {
    const res1 = evaluatePrivateAntiAbuseGate(
      'Actualización Banco Galicia',
      'Ingresá tu contraseña y token de seguridad para confirmar tu identidad'
    );
    assert.equal(res1.allowed, false);
    assert.equal(res1.reason, 'credential_theft');

    const res2 = evaluatePrivateAntiAbuseGate(
      'Premio $1.000.000',
      'Ganaste un sorteo reclamalo aquí con tu clave bancaria'
    );
    assert.equal(res2.allowed, false);
  });

  test('Payload malicioso / Script XSS en contenido privado → BLOQUEADO', () => {
    const res = evaluatePrivateAntiAbuseGate(
      'Invitación privada',
      'Vengan a mi fiesta <script>alert(document.cookie)</script>'
    );
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'malicious_payload');
  });

  // ----------------------------------------------------------------------------
  // TESTS DE BASE DE DATOS / SQL / RPCs
  // ----------------------------------------------------------------------------

  test('SQL evaluar_contenido_publico_determinista bloquea basura masiva y amenazas', async () => {
    const resGib = await db.query<{ decision: string; reason: string }>(`
      SELECT decision, reason FROM public.evaluar_contenido_publico_determinista('asdfasdfasdf', 'aaaaaaa bbbbbbb');
    `);
    assert.equal(resGib.rows[0].decision, 'block');
    assert.equal(resGib.rows[0].reason, 'gibberish');

    const resThreat = await db.query<{ decision: string; reason: string }>(`
      SELECT decision, reason FROM public.evaluar_contenido_publico_determinista('Venganza', 'te voy a matar amenaza de muerte');
    `);
    assert.equal(resThreat.rows[0].decision, 'block');
    assert.equal(resThreat.rows[0].reason, 'violence_threat');
  });

  test('SQL abrir_encuentro_seguro respeta estricto aislamiento de privacidad (cero datos privados a moderación)', async () => {
    await setAuthContext(hostUser);
    const encIdRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, modalidad, lugar_texto, host_id, estado, is_open
      ) VALUES (
        'Reunión Privada con Secreto', 'presencial', 'Güemes 1234 timbre 2A contraseña secreta 9999', '${hostUser}', 'activo', false
      ) RETURNING id;
    `);
    const encId = encIdRes.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Tarde de mate en la costa', 4, 'guemes', NULL, 'Mate en la costa'
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.is_open, false);
    assert.equal(r.moderation_status, 'review_pending');

    // Verificar en auditoría que lugar_texto NUNCA se guardó en metadata
    const auditRes = await db.query<{ metadata: any }>(`
      SELECT metadata FROM public.public_content_moderation_audit WHERE encuentro_id = '${encId}' ORDER BY created_at DESC LIMIT 1;
    `);
    const meta = auditRes.rows[0].metadata;
    assert.equal(meta.title, 'Mate en la costa');
    assert.equal(meta.open_description, 'Tarde de mate en la costa');
    assert.equal(meta.lugar_texto, undefined, 'lugar_texto jamás debe incorporarse a la auditoría de moderación pública');
  });

  test('SQL get_encuentro_por_public_token bloquea invitaciones con phishing', async () => {
    const encPhishing = await db.query<{ public_token: string }>(`
      INSERT INTO public.encuentros (
        titulo, descripcion, host_id, estado, tipo_invitacion
      ) VALUES (
        'Actualización bancaria urgente',
        'Ingresá tu contraseña de home banking para validar la asistencia',
        '${hostUser}', 'activo', 'link_general'
      ) RETURNING public_token;
    `);
    const token = encPhishing.rows[0].public_token;

    const res = await db.query<{ get_encuentro_por_public_token: any }>(`
      SELECT public.get_encuentro_por_public_token('${token}');
    `);
    const r = res.rows[0].get_encuentro_por_public_token;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'private_content_blocked');
    assert.equal(r.reason, 'credential_theft');
  });

  test('SQL get_encuentro_por_public_token permite contenido comercial legítimo y en otro idioma', async () => {
    const encValid = await db.query<{ public_token: string }>(`
      INSERT INTO public.encuentros (
        titulo, descripcion, host_id, estado, tipo_invitacion
      ) VALUES (
        'Reunion de Negocios Q3 B2B',
        'Discussion en francais pour les ventes et le budget trimestriel avec les clients.',
        '${hostUser}', 'activo', 'link_general'
      ) RETURNING public_token;
    `);
    const token = encValid.rows[0].public_token;

    const res = await db.query<{ get_encuentro_por_public_token: any }>(`
      SELECT public.get_encuentro_por_public_token('${token}');
    `);
    const r = res.rows[0].get_encuentro_por_public_token;
    assert.equal(r.titulo, 'Reunion de Negocios Q3 B2B');
    assert.equal(r.descripcion, 'Discussion en francais pour les ventes et le budget trimestriel avec les clients.');
  });
});
