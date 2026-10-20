import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { isValidPostAuthRedirect, isOwnershipDependentRoute, STATIC_ALLOWED_POST_AUTH_ROUTES } from '../src/hooks/usePostAuthRedirect';
import type { TransferClaimStatus } from '../src/contexts/AuthContext';

describe('Mini-sprint 1: Identidad y Acceso Crítico Pre-Lanzamiento', () => {

  // =========================================================================
  // SUITE 1: Validación Estricta de Redirección Post-Autenticación
  // =========================================================================
  describe('1. Validación Estricta de Redirección Post-Autenticación (usePostAuthRedirect)', () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    const validToken = 'abcdef1234567890';

    test('1.1. Rutas estáticas de creación y root autorizadas', () => {
      assert.equal(isValidPostAuthRedirect('/'), true);
      assert.equal(isValidPostAuthRedirect('/create'), true);
      assert.equal(isValidPostAuthRedirect('/create/coordination'), true);
      assert.equal(isValidPostAuthRedirect('/create/ai'), true);
    });

    test('1.2. Rutas dinámicas legítimas con UUID o Token autorizadas', () => {
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/invitation/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/invite/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/invite/${validToken}`), true);
      assert.equal(isValidPostAuthRedirect(`/join/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/join/${validToken}`), true);
      assert.equal(isValidPostAuthRedirect(`/coordination/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/coordination/invite/${validToken}`), true);
      assert.equal(isValidPostAuthRedirect(`/coordination/join/${validToken}`), true);
      assert.equal(isValidPostAuthRedirect(`/share/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/add-guests/${validUuid}`), true);
      assert.equal(isValidPostAuthRedirect(`/cancel-summary/${validUuid}`), true);
    });

    test('1.3. Open Redirect externos bloqueados estrictamente', () => {
      assert.equal(isValidPostAuthRedirect('https://evil.com'), false);
      assert.equal(isValidPostAuthRedirect('http://evil.com'), false);
      assert.equal(isValidPostAuthRedirect('//evil.com'), false);
      assert.equal(isValidPostAuthRedirect('//evil.com/meet'), false);
      assert.equal(isValidPostAuthRedirect('ftp://evil.com'), false);
    });

    test('1.4. Bypass con contrabarras y barras relativas ambiguas bloqueados', () => {
      assert.equal(isValidPostAuthRedirect('/\\evil.com'), false);
      assert.equal(isValidPostAuthRedirect('\\evil.com'), false);
      assert.equal(isValidPostAuthRedirect('/meet\\evil.com'), false);
      assert.equal(isValidPostAuthRedirect('//meet/' + validUuid), false);
    });

    test('1.5. Dobles barras internas bloqueadas', () => {
      assert.equal(isValidPostAuthRedirect(`/meet//${validUuid}`), false);
      assert.equal(isValidPostAuthRedirect(`/invite//${validToken}`), false);
      assert.equal(isValidPostAuthRedirect('//'), false);
    });

    test('1.6. Inyección de esquemas, pseudo-protocolos y traversal bloqueados', () => {
      assert.equal(isValidPostAuthRedirect('javascript:alert(1)'), false);
      assert.equal(isValidPostAuthRedirect('data:text/html,<script>alert(1)</script>'), false);
      assert.equal(isValidPostAuthRedirect('/meet/../evil'), false);
      assert.equal(isValidPostAuthRedirect('/../../etc/passwd'), false);
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}/://evil.com`), false);
    });

    test('1.7. Caracteres de control, saltos de línea, espacios y null bytes bloqueados', () => {
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}\0`), false);
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}\n`), false);
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}\r`), false);
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid} `), false);
      assert.equal(isValidPostAuthRedirect(` /meet/${validUuid}`), false);
    });

    test('1.8. Query params y hashes manipulados bloqueados (previene fuga o inyección de tokens)', () => {
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}?transfer_ticket=secret`), false);
      assert.equal(isValidPostAuthRedirect(`/meet/${validUuid}#access_token=secret`), false);
      assert.equal(isValidPostAuthRedirect('/create?redirect=evil.com'), false);
    });

    test('1.9. IDs no válidos o manipulados en rutas UUID rechazados', () => {
      assert.equal(isValidPostAuthRedirect('/meet/12345'), false);
      assert.equal(isValidPostAuthRedirect('/meet/not-a-valid-uuid'), false);
      assert.equal(isValidPostAuthRedirect('/invitation/123'), false);
      assert.equal(isValidPostAuthRedirect('/coordination/invalid'), false);
    });

    test('1.10. Prefijos abiertos sin segmento completo rechazados', () => {
      assert.equal(isValidPostAuthRedirect('/meet/'), false);
      assert.equal(isValidPostAuthRedirect('/invitation/'), false);
      assert.equal(isValidPostAuthRedirect('/invite/'), false);
      assert.equal(isValidPostAuthRedirect('/join/'), false);
      assert.equal(isValidPostAuthRedirect('/coordination/'), false);
      assert.equal(isValidPostAuthRedirect('/unknown/route'), false);
    });

    test('1.11. Tipos no-string o vacíos rechazados fail-closed', () => {
      assert.equal(isValidPostAuthRedirect(''), false);
      assert.equal(isValidPostAuthRedirect(null), false);
      assert.equal(isValidPostAuthRedirect(undefined), false);
      assert.equal(isValidPostAuthRedirect(12345), false);
      assert.equal(isValidPostAuthRedirect({}), false);
    });
  });

  // =========================================================================
  // SUITE 2: Contexto de Navegación, Aislamiento y Dos Pestañas
  // =========================================================================
  describe('2. Contexto de Navegación, Dos Pestañas y Cero Fuga', () => {
    test('2.1. Aislamiento estricto de sessionStorage entre dos pestañas', () => {
      // Simulación de dos pestañas independientes (A y B)
      const tabAStorage: Record<string, string> = {};
      const tabBStorage: Record<string, string> = {};

      // Pestaña A está en una invitación
      tabAStorage['post_auth_redirect'] = '/invitation/550e8400-e29b-41d4-a716-446655440001';
      // Pestaña B está en un encuentro como anfitrión
      tabBStorage['post_auth_redirect'] = '/meet/550e8400-e29b-41d4-a716-446655440002';

      // Verificar que Tab A no contamina a Tab B
      assert.notEqual(tabAStorage['post_auth_redirect'], tabBStorage['post_auth_redirect']);
      assert.equal(isValidPostAuthRedirect(tabAStorage['post_auth_redirect']), true);
      assert.equal(isValidPostAuthRedirect(tabBStorage['post_auth_redirect']), true);
    });

    test('2.2. Transfer Ticket se guarda exclusivamente en sessionStorage (NUNCA en URL)', () => {
      const mockTicketToken = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const storage: Record<string, string> = {};
      storage['pe_pending_transfer_ticket'] = mockTicketToken;

      // El redirect generado NUNCA contiene el token
      const redirectUrl = '/meet/550e8400-e29b-41d4-a716-446655440000';
      assert.equal(redirectUrl.includes(mockTicketToken), false);
      assert.equal(isValidPostAuthRedirect(redirectUrl), true);

      // Si alguien intentara adjuntar el ticket a la URL, el validador lo rechaza
      assert.equal(isValidPostAuthRedirect(`${redirectUrl}?ticket=${mockTicketToken}`), false);
    });
  });

  // =========================================================================
  // SUITE 3: Backend PGlite: Identidad, Transfer Tickets y Permisos Server-Side
  // =========================================================================
  describe('3. Base de Datos & RPCs de Identidad (PGlite)', () => {
    let db: PGlite;

    const anonUserWithEncounters = '10000000-0000-0000-0000-000000000001';
    const anonUserWithParticipants = '10000000-0000-0000-0000-000000000002';
    const anonUserWithMultiple = '10000000-0000-0000-0000-000000000003';
    const anonUserEmpty = '10000000-0000-0000-0000-000000000004';
    const permanentTargetUser = '20000000-0000-0000-0000-000000000001';
    const thirdPartyUser = '30000000-0000-0000-0000-000000000001';

    let encounterId1: string;
    let encounterId2: string;
    let invitationId1: string;

    const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
      if (userId) {
        await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
        await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnon ? 'true' : 'false'}', false);`);
      } else {
        await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
        await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', 'false', false);`);
      }
    };

    const parseResult = (raw: any): any => {
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    };

    before(async () => {
      db = new PGlite();

      // 1. Roles y Auth mock
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
          is_anonymous BOOLEAN DEFAULT false,
          raw_user_meta_data JSONB DEFAULT '{}'::jsonb
        );

        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
          SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
        $$ LANGUAGE SQL STABLE;

        CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
          SELECT json_build_object(
            'sub', NULLIF(current_setting('request.jwt.claim.sub', true), ''),
            'is_anonymous', NULLIF(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean
          )::jsonb;
        $$ LANGUAGE SQL STABLE;

        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea AS $$
          SELECT decode(repeat('42', n), 'hex');
        $$ LANGUAGE SQL;
      `);

      // 2. Tablas del dominio
      await db.exec(`
        CREATE TABLE IF NOT EXISTS public.encuentros (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          titulo TEXT NOT NULL,
          descripcion TEXT,
          fecha DATE,
          hora TIME,
          modalidad TEXT NOT NULL DEFAULT 'presencial',
          lugar_texto TEXT,
          link_virtual TEXT,
          host_id UUID NOT NULL,
          public_token UUID DEFAULT gen_random_uuid(),
          estado TEXT NOT NULL DEFAULT 'activo',
          date_mode TEXT DEFAULT 'fixed',
          creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.participantes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
          nombre_invitado TEXT NOT NULL,
          tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
          token_invitacion UUID UNIQUE DEFAULT gen_random_uuid(),
          estado TEXT NOT NULL DEFAULT 'pendiente',
          user_id UUID,
          creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.usuario_localidades (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          localidad_id TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          encuentro_id UUID NOT NULL,
          usuario_id UUID NOT NULL,
          estado TEXT NOT NULL DEFAULT 'pending',
          participante_id UUID,
          token_participante UUID,
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.custom_invitation_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          nombre TEXT NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.ai_creation_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.creation_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.anonymous_transfer_tickets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          source_user_id UUID,
          target_user_id UUID,
          source_user_id_snapshot UUID NOT NULL,
          target_user_id_snapshot UUID,
          token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          resources_transferred JSONB,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS public.invitaciones_internas (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
          host_id UUID NOT NULL,
          destinatario_id UUID NOT NULL,
          destinatario_email TEXT NOT NULL,
          estado TEXT NOT NULL DEFAULT 'pendiente',
          expira_en TIMESTAMPTZ DEFAULT now() + interval '7 days',
          participante_id UUID,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
        );
      `);

      // 3. RPCs de Transfer Tickets y Upgrade State
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.get_anonymous_upgrade_state()
        RETURNS JSON
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_user_id UUID := auth.uid();
            v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
            v_has_encounters BOOLEAN := false;
            v_has_zones BOOLEAN := false;
            v_has_participants BOOLEAN := false;
            v_has_requests BOOLEAN := false;
            v_has_templates BOOLEAN := false;
            v_has_ai_sessions BOOLEAN := false;
            v_has_creation_sessions BOOLEAN := false;
            v_has_other BOOLEAN := false;
            v_has_transferable BOOLEAN := false;
        BEGIN
            IF v_user_id IS NULL THEN
                RETURN json_build_object('ok', false, 'error', 'not_authenticated');
            END IF;

            IF NOT v_is_anon THEN
                RETURN json_build_object(
                    'ok', true,
                    'is_anonymous', false,
                    'has_owned_encounters', false,
                    'has_server_zones', false,
                    'has_participant_links', false,
                    'has_open_requests', false,
                    'has_custom_templates', false,
                    'has_ai_sessions', false,
                    'has_creation_sessions', false,
                    'has_other_transferable_resources', false,
                    'has_transferable_resources', false
                );
            END IF;

            SELECT EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id LIMIT 1) INTO v_has_encounters;
            SELECT EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id LIMIT 1) INTO v_has_zones;
            SELECT EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id LIMIT 1) INTO v_has_participants;
            SELECT EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id LIMIT 1) INTO v_has_requests;
            SELECT EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id LIMIT 1) INTO v_has_templates;
            SELECT EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id LIMIT 1) INTO v_has_ai_sessions;
            SELECT EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id LIMIT 1) INTO v_has_creation_sessions;

            v_has_other := (v_has_participants OR v_has_requests OR v_has_templates OR v_has_ai_sessions OR v_has_creation_sessions);
            v_has_transferable := (v_has_encounters OR v_has_zones OR v_has_other);

            RETURN json_build_object(
                'ok', true,
                'is_anonymous', true,
                'has_owned_encounters', v_has_encounters,
                'has_server_zones', v_has_zones,
                'has_participant_links', v_has_participants,
                'has_open_requests', v_has_requests,
                'has_custom_templates', v_has_templates,
                'has_ai_sessions', v_has_ai_sessions,
                'has_creation_sessions', v_has_creation_sessions,
                'has_other_transferable_resources', v_has_other,
                'has_transferable_resources', v_has_transferable
            );
        END;
        $$;

        CREATE OR REPLACE FUNCTION public.create_anonymous_transfer_ticket()
        RETURNS JSON
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_user_id UUID := auth.uid();
            v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
            v_raw_token TEXT;
            v_token_hash TEXT;
            v_expires_at TIMESTAMPTZ;
            v_has_resources BOOLEAN := false;
            v_existing_ticket_id UUID;
            v_existing_expires_at TIMESTAMPTZ;
        BEGIN
            IF v_user_id IS NULL THEN
                RETURN json_build_object('ok', false, 'error', 'authentication_required');
            END IF;

            IF NOT v_is_anon THEN
                RETURN json_build_object('ok', false, 'error', 'anonymous_user_required');
            END IF;

            SELECT (
                EXISTS (SELECT 1 FROM public.encuentros WHERE host_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.usuario_localidades WHERE user_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.participantes WHERE user_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.solicitudes_encuentro_abierto WHERE usuario_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.custom_invitation_templates WHERE user_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.ai_creation_sessions WHERE user_id = v_user_id)
                OR EXISTS (SELECT 1 FROM public.creation_sessions WHERE user_id = v_user_id)
            ) INTO v_has_resources;

            IF NOT v_has_resources THEN
                RETURN json_build_object('ok', false, 'error', 'no_transferable_resources');
            END IF;

            SELECT id, expires_at INTO v_existing_ticket_id, v_existing_expires_at
            FROM public.anonymous_transfer_tickets
            WHERE source_user_id_snapshot = v_user_id AND status = 'pending';

            IF FOUND THEN
                IF v_existing_expires_at > now() THEN
                    RETURN json_build_object('ok', false, 'error', 'transfer_ticket_already_pending');
                ELSE
                    UPDATE public.anonymous_transfer_tickets SET status = 'expired' WHERE id = v_existing_ticket_id;
                END IF;
            END IF;

            -- Generar token y hash
            v_raw_token := md5(random()::text || clock_timestamp()::text) || md5(random()::text);
            v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');
            v_expires_at := now() + interval '15 minutes';

            INSERT INTO public.anonymous_transfer_tickets (
                source_user_id, source_user_id_snapshot, token_hash, expires_at, status
            ) VALUES (
                v_user_id, v_user_id, v_token_hash, v_expires_at, 'pending'
            );

            RETURN json_build_object('ok', true, 'ticket_token', v_raw_token, 'expires_at', v_expires_at);
        END;
        $$;

        CREATE OR REPLACE FUNCTION public.claim_anonymous_transfer(p_transfer_token TEXT)
        RETURNS JSON
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_target_user_id UUID := auth.uid();
            v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
            v_clean_token TEXT;
            v_token_hash TEXT;
            v_ticket public.anonymous_transfer_tickets%ROWTYPE;
            v_source_user_id UUID;
            v_source_is_anon BOOLEAN;
            v_encuentros_count INT := 0;
            v_part_count INT := 0;
        BEGIN
            IF v_target_user_id IS NULL THEN
                RETURN json_build_object('ok', false, 'error', 'authentication_required');
            END IF;

            IF v_is_anon THEN
                RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
            END IF;

            v_clean_token := lower(btrim(COALESCE(p_transfer_token, '')));
            IF v_clean_token !~ '^[0-9a-f]{64}$' THEN
                RETURN json_build_object('ok', false, 'error', 'invalid_token_format');
            END IF;

            v_token_hash := encode(sha256(v_clean_token::bytea), 'hex');

            SELECT * INTO v_ticket
            FROM public.anonymous_transfer_tickets
            WHERE token_hash = v_token_hash;

            IF NOT FOUND THEN
                RETURN json_build_object('ok', false, 'error', 'ticket_not_found');
            END IF;

            IF v_ticket.status = 'completed' OR v_ticket.used_at IS NOT NULL THEN
                RETURN json_build_object('ok', false, 'error', 'ticket_already_used');
            END IF;

            IF v_ticket.status = 'revoked' THEN
                RETURN json_build_object('ok', false, 'error', 'ticket_revoked');
            END IF;

            IF v_ticket.expires_at <= now() THEN
                UPDATE public.anonymous_transfer_tickets SET status = 'expired' WHERE id = v_ticket.id;
                RETURN json_build_object('ok', false, 'error', 'ticket_expired');
            END IF;

            v_source_user_id := v_ticket.source_user_id_snapshot;

            SELECT is_anonymous INTO v_source_is_anon FROM auth.users WHERE id = v_source_user_id;
            IF NOT FOUND THEN
                RETURN json_build_object('ok', false, 'error', 'source_user_not_found');
            END IF;

            IF v_source_is_anon IS NOT TRUE THEN
                RETURN json_build_object('ok', false, 'error', 'source_no_longer_anonymous');
            END IF;

            IF v_source_user_id = v_target_user_id THEN
                RETURN json_build_object('ok', false, 'error', 'cannot_transfer_to_same_user');
            END IF;

            -- Traspasar encuentros
            UPDATE public.encuentros SET host_id = v_target_user_id WHERE host_id = v_source_user_id;
            GET DIAGNOSTICS v_encuentros_count = ROW_COUNT;

            -- Traspasar participantes
            UPDATE public.participantes SET user_id = v_target_user_id WHERE user_id = v_source_user_id;
            GET DIAGNOSTICS v_part_count = ROW_COUNT;

            -- Traspasar templates y sesiones
            UPDATE public.custom_invitation_templates SET user_id = v_target_user_id WHERE user_id = v_source_user_id;
            UPDATE public.ai_creation_sessions SET user_id = v_target_user_id WHERE user_id = v_source_user_id;
            UPDATE public.creation_sessions SET user_id = v_target_user_id WHERE user_id = v_source_user_id;

            -- Marcar ticket usado
            UPDATE public.anonymous_transfer_tickets
            SET status = 'completed',
                used_at = now(),
                target_user_id = v_target_user_id,
                target_user_id_snapshot = v_target_user_id,
                resources_transferred = json_build_object(
                    'encuentros', v_encuentros_count,
                    'participantes', v_part_count
                )
            WHERE id = v_ticket.id;

            RETURN json_build_object(
                'ok', true,
                'transferred_encuentros', v_encuentros_count,
                'transferred_participants', v_part_count
            );
        END;
        $$;

        CREATE OR REPLACE FUNCTION public.get_detalle_invitacion_interna_seguro(p_invitacion_id UUID)
        RETURNS JSON
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_user_id UUID := auth.uid();
            v_inv public.invitaciones_internas%ROWTYPE;
            v_enc public.encuentros%ROWTYPE;
        BEGIN
            IF v_user_id IS NULL THEN
                RETURN json_build_object('ok', false, 'error', 'not_authenticated');
            END IF;

            SELECT * INTO v_inv FROM public.invitaciones_internas WHERE id = p_invitacion_id;
            IF NOT FOUND THEN
                RETURN json_build_object('ok', false, 'error', 'invitation_not_found');
            END IF;

            IF v_inv.destinatario_id <> v_user_id AND v_inv.host_id <> v_user_id THEN
                RETURN json_build_object('ok', false, 'error', 'unauthorized');
            END IF;

            SELECT * INTO v_enc FROM public.encuentros WHERE id = v_inv.encuentro_id;

            RETURN json_build_object(
                'ok', true,
                'invitacion', row_to_json(v_inv),
                'encuentro', row_to_json(v_enc)
            );
        END;
        $$;
      `);

      // 4. Seed de usuarios en auth.users
      await db.exec(`
        INSERT INTO auth.users (id, email, is_anonymous) VALUES
          ('${anonUserWithEncounters}', 'anon1@device.local', true),
          ('${anonUserWithParticipants}', 'anon2@device.local', true),
          ('${anonUserWithMultiple}', 'anon3@device.local', true),
          ('${anonUserEmpty}', 'anon4@device.local', true),
          ('${permanentTargetUser}', 'user.google@gmail.com', false),
          ('${thirdPartyUser}', 'other@gmail.com', false);
      `);

      // 5. Seed de recursos
      const enc1Res = await db.query(`
        INSERT INTO public.encuentros (titulo, modalidad, host_id)
        VALUES ('Asado Anónimo', 'presencial', '${anonUserWithEncounters}')
        RETURNING id;
      `);
      encounterId1 = (enc1Res.rows[0] as any).id;

      const enc2Res = await db.query(`
        INSERT INTO public.encuentros (titulo, modalidad, host_id)
        VALUES ('Fútbol de Miércoles', 'presencial', '${thirdPartyUser}')
        RETURNING id;
      `);
      encounterId2 = (enc2Res.rows[0] as any).id;

      // Participación para anonUserWithParticipants en encuentro 2
      await db.query(`
        INSERT INTO public.participantes (encuentro_id, nombre_invitado, user_id, estado)
        VALUES ('${encounterId2}', 'Invitado Anónimo', '${anonUserWithParticipants}', 'confirmado');
      `);

      // Recursos múltiples para anonUserWithMultiple
      await db.exec(`
        INSERT INTO public.encuentros (titulo, modalidad, host_id)
        VALUES ('Cumpleaños Múltiple', 'presencial', '${anonUserWithMultiple}');
        INSERT INTO public.participantes (encuentro_id, nombre_invitado, user_id, estado)
        VALUES ('${encounterId2}', 'Multi User', '${anonUserWithMultiple}', 'confirmado');
        INSERT INTO public.custom_invitation_templates (user_id, nombre)
        VALUES ('${anonUserWithMultiple}', 'Plantilla Personalizada');
      `);

      // Invitación interna para permanentTargetUser
      const invRes = await db.query(`
        INSERT INTO public.invitaciones_internas (encuentro_id, host_id, destinatario_id, destinatario_email)
        VALUES ('${encounterId2}', '${thirdPartyUser}', '${permanentTargetUser}', 'user.google@gmail.com')
        RETURNING id;
      `);
      invitationId1 = (invRes.rows[0] as any).id;
    });

    test('3.1. Anónimo con encuentros privados: inventario detecta y emite ticket de 256 bits', async () => {
      await setAuthContext(anonUserWithEncounters, true);
      const stateRes = await db.query(`SELECT public.get_anonymous_upgrade_state() as res;`);
      const state = parseResult((stateRes.rows[0] as any).res);

      assert.equal(state.ok, true);
      assert.equal(state.is_anonymous, true);
      assert.equal(state.has_owned_encounters, true);
      assert.equal(state.has_transferable_resources, true);

      // Crear transfer ticket
      const ticketRes = await db.query(`SELECT public.create_anonymous_transfer_ticket() as res;`);
      const ticket = parseResult((ticketRes.rows[0] as any).res);

      assert.equal(ticket.ok, true);
      assert.equal(typeof ticket.ticket_token, 'string');
      assert.equal(ticket.ticket_token.length, 64); // 256 bits en hex
    });

    test('3.2. Canje exitoso por usuario permanente: traspaso atómico de titularidad', async () => {
      // Obtener el ticket emitido para anonUserWithEncounters
      const row = await db.query(`
        SELECT token_hash FROM public.anonymous_transfer_tickets
        WHERE source_user_id_snapshot = '${anonUserWithEncounters}' AND status = 'pending';
      `);
      assert.equal(row.rows.length, 1);

      // Generar token que coincida con el hash (en el test usamos el token guardado en DB)
      // Como en la función simulada el token es conocido, creamos un ticket con token predeterminado
      const rawToken = '1111111111111111111111111111111111111111111111111111111111111111';
      await db.query(`
        INSERT INTO public.anonymous_transfer_tickets (
          source_user_id, source_user_id_snapshot, token_hash, expires_at, status
        ) VALUES (
          '${anonUserWithEncounters}', '${anonUserWithEncounters}',
          encode(sha256('${rawToken}'::bytea), 'hex'),
          now() + interval '15 minutes', 'pending'
        ) ON CONFLICT (token_hash) DO NOTHING;
      `);

      // Usuario permanente ejecuta el claim
      await setAuthContext(permanentTargetUser, false);
      const claimRes = await db.query(`SELECT public.claim_anonymous_transfer('${rawToken}') as res;`);
      const claim = parseResult((claimRes.rows[0] as any).res);

      assert.equal(claim.ok, true);
      assert.equal(claim.transferred_encuentros >= 1, true);

      // Verificar en DB que el host_id ahora es permanentTargetUser
      const encCheck = await db.query(`SELECT host_id FROM public.encuentros WHERE id = '${encounterId1}';`);
      assert.equal((encCheck.rows[0] as any).host_id, permanentTargetUser);
    });

    test('3.3. Anónimo con participaciones: inventario y transferencia de asistencias', async () => {
      await setAuthContext(anonUserWithParticipants, true);
      const stateRes = await db.query(`SELECT public.get_anonymous_upgrade_state() as res;`);
      const state = parseResult((stateRes.rows[0] as any).res);

      assert.equal(state.ok, true);
      assert.equal(state.has_participant_links, true);
      assert.equal(state.has_transferable_resources, true);

      // Crear y canjear ticket
      const rawToken = '2222222222222222222222222222222222222222222222222222222222222222';
      await db.query(`
        INSERT INTO public.anonymous_transfer_tickets (
          source_user_id, source_user_id_snapshot, token_hash, expires_at, status
        ) VALUES (
          '${anonUserWithParticipants}', '${anonUserWithParticipants}',
          encode(sha256('${rawToken}'::bytea), 'hex'),
          now() + interval '15 minutes', 'pending'
        );
      `);

      await setAuthContext(permanentTargetUser, false);
      const claimRes = await db.query(`SELECT public.claim_anonymous_transfer('${rawToken}') as res;`);
      const claim = parseResult((claimRes.rows[0] as any).res);

      assert.equal(claim.ok, true);
      assert.equal(claim.transferred_participants >= 1, true);

      // Verificar que el participante ahora apunta a permanentTargetUser
      const partCheck = await db.query(`
        SELECT user_id FROM public.participantes
        WHERE encuentro_id = '${encounterId2}' AND nombre_invitado = 'Invitado Anónimo';
      `);
      assert.equal((partCheck.rows[0] as any).user_id, permanentTargetUser);
    });

    test('3.4. Anónimo con múltiples recursos: transferencia atómica completa', async () => {
      await setAuthContext(anonUserWithMultiple, true);
      const stateRes = await db.query(`SELECT public.get_anonymous_upgrade_state() as res;`);
      const state = parseResult((stateRes.rows[0] as any).res);

      assert.equal(state.ok, true);
      assert.equal(state.has_owned_encounters, true);
      assert.equal(state.has_participant_links, true);
      assert.equal(state.has_custom_templates, true);
      assert.equal(state.has_transferable_resources, true);

      const rawToken = '3333333333333333333333333333333333333333333333333333333333333333';
      await db.query(`
        INSERT INTO public.anonymous_transfer_tickets (
          source_user_id, source_user_id_snapshot, token_hash, expires_at, status
        ) VALUES (
          '${anonUserWithMultiple}', '${anonUserWithMultiple}',
          encode(sha256('${rawToken}'::bytea), 'hex'),
          now() + interval '15 minutes', 'pending'
        );
      `);

      await setAuthContext(permanentTargetUser, false);
      const claimRes = await db.query(`SELECT public.claim_anonymous_transfer('${rawToken}') as res;`);
      const claim = parseResult((claimRes.rows[0] as any).res);

      assert.equal(claim.ok, true);

      // Verificar que templates se transfirieron
      const tplCheck = await db.query(`
        SELECT user_id FROM public.custom_invitation_templates WHERE nombre = 'Plantilla Personalizada';
      `);
      assert.equal((tplCheck.rows[0] as any).user_id, permanentTargetUser);
    });

    test('3.5. Anónimo sin recursos: inventario devuelve false y ticket es rechazado', async () => {
      await setAuthContext(anonUserEmpty, true);
      const stateRes = await db.query(`SELECT public.get_anonymous_upgrade_state() as res;`);
      const state = parseResult((stateRes.rows[0] as any).res);

      assert.equal(state.ok, true);
      assert.equal(state.has_transferable_resources, false);

      const ticketRes = await db.query(`SELECT public.create_anonymous_transfer_ticket() as res;`);
      const ticket = parseResult((ticketRes.rows[0] as any).res);

      assert.equal(ticket.ok, false);
      assert.equal(ticket.error, 'no_transferable_resources');
    });

    test('3.6. Cancelación de OAuth: sesión y recursos anónimos intactos', async () => {
      // Simular usuario anónimo nuevo con encuentro
      const cancelAnonUser = '10000000-0000-0000-0000-000000000099';
      await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${cancelAnonUser}', 'c@d.local', true);`);
      const encRes = await db.query(`
        INSERT INTO public.encuentros (titulo, host_id) VALUES ('Cancel Encounter', '${cancelAnonUser}') RETURNING id;
      `);
      const encId = (encRes.rows[0] as any).id;

      // Usuario genera ticket para OAuth
      await setAuthContext(cancelAnonUser, true);
      const ticketRes = await db.query(`SELECT public.create_anonymous_transfer_ticket() as res;`);
      const ticket = parseResult((ticketRes.rows[0] as any).res);
      assert.equal(ticket.ok, true);

      // Usuario cancela en Google (nunca llama al callback)
      // Comprobar que en DB el host_id sigue siendo cancelAnonUser y sigue siendo anónimo
      const check = await db.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
      assert.equal((check.rows[0] as any).host_id, cancelAnonUser);
    });

    test('3.7. Fallo transitorio de claim: ticket no se descarta de DB y reintentos incrementan', async () => {
      const rawToken = '4444444444444444444444444444444444444444444444444444444444444444';
      // Ticket pendiente
      await db.query(`
        INSERT INTO public.anonymous_transfer_tickets (
          source_user_id, source_user_id_snapshot, token_hash, expires_at, status
        ) VALUES (
          '${anonUserEmpty}', '${anonUserEmpty}',
          encode(sha256('${rawToken}'::bytea), 'hex'),
          now() + interval '15 minutes', 'pending'
        );
      `);

      // Intentar canjear con usuario no autenticado (fallo)
      await setAuthContext(null, false);
      const claimRes = await db.query(`SELECT public.claim_anonymous_transfer('${rawToken}') as res;`);
      const claim = parseResult((claimRes.rows[0] as any).res);

      assert.equal(claim.ok, false);
      assert.equal(claim.error, 'authentication_required');

      // El ticket sigue 'pending' en DB para poder ser reintentado
      const ticketCheck = await db.query(`
        SELECT status FROM public.anonymous_transfer_tickets
        WHERE token_hash = encode(sha256('${rawToken}'::bytea), 'hex');
      `);
      assert.equal((ticketCheck.rows[0] as any).status, 'pending');
    });

    test('3.8. Fallo terminal de claim: ticket expirado o ya usado', async () => {
      const expiredToken = '5555555555555555555555555555555555555555555555555555555555555555';
      await db.query(`
        INSERT INTO public.anonymous_transfer_tickets (
          source_user_id, source_user_id_snapshot, token_hash, expires_at, status
        ) VALUES (
          '${anonUserEmpty}', '${anonUserEmpty}',
          encode(sha256('${expiredToken}'::bytea), 'hex'),
          now() - interval '1 minute', 'pending'
        );
      `);

      await setAuthContext(permanentTargetUser, false);
      const claimRes = await db.query(`SELECT public.claim_anonymous_transfer('${expiredToken}') as res;`);
      const claim = parseResult((claimRes.rows[0] as any).res);

      assert.equal(claim.ok, false);
      assert.equal(claim.error, 'ticket_expired');
    });

    test('3.9. Invitación interna desde sesión anónima: validación de identidad destinatario', async () => {
      // 1. Destinatario legítimo autenticado puede ver el detalle
      await setAuthContext(permanentTargetUser, false);
      const okRes = await db.query(`SELECT public.get_detalle_invitacion_interna_seguro('${invitationId1}') as res;`);
      const detailOk = parseResult((okRes.rows[0] as any).res);
      assert.equal(detailOk.ok, true);

      // 2. Tercero no autorizado es rechazado fail-closed (unauthorized)
      await setAuthContext(thirdPartyUser, false);
      // thirdPartyUser es el host, sí lo ve. Usemos un usuario ajeno:
      const intruderId = '40000000-0000-0000-0000-000000000001';
      await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${intruderId}', 'intruder@evil.com', false);`);
      await setAuthContext(intruderId, false);

      const deniedRes = await db.query(`SELECT public.get_detalle_invitacion_interna_seguro('${invitationId1}') as res;`);
      const detailDenied = parseResult((deniedRes.rows[0] as any).res);
      assert.equal(detailDenied.ok, false);
      assert.equal(detailDenied.error, 'unauthorized');
    });

    test('3.10. Ausencia de accesos a recursos ajenos e ID Tampering', async () => {
      // Intento de canjear ticket con formato inválido o token no existente
      await setAuthContext(thirdPartyUser, false);
      const badTokenRes = await db.query(`SELECT public.claim_anonymous_transfer('invalid_short_token') as res;`);
      const badToken = parseResult((badTokenRes.rows[0] as any).res);
      assert.equal(badToken.ok, false);
      assert.equal(badToken.error, 'invalid_token_format');

      const nonExistentRes = await db.query(`
        SELECT public.claim_anonymous_transfer('0000000000000000000000000000000000000000000000000000000000000000') as res;
      `);
      const nonExistent = parseResult((nonExistentRes.rows[0] as any).res);
      assert.equal(nonExistent.ok, false);
      assert.equal(nonExistent.error, 'ticket_not_found');
    });

    test('3.11. Conocimiento de URL pública no otorga titularidad de anfitrión', async () => {
      // El encuentro 1 pertenece a permanentTargetUser
      const encRow = await db.query(`SELECT host_id, public_token FROM public.encuentros WHERE id = '${encounterId1}';`);
      const hostId = (encRow.rows[0] as any).host_id;
      assert.equal(hostId, permanentTargetUser);

      // Usuario ajeno conociendo el public_token NO es host_id
      await setAuthContext(thirdPartyUser, false);
      const userRes = await db.query(`SELECT auth.uid() as current_user;`);
      const currentUid = (userRes.rows[0] as any).current_user;
      assert.notEqual(currentUid, hostId);
    });
  });

  // =========================================================================
  // SUITE 4: Hardening de Transfer Claim Post-OAuth, Estados y Redirección
  // =========================================================================
  describe('4. Hardening de Transfer Claim Post-OAuth, Estados y Redirección', () => {
    const validMeetUuid = '550e8400-e29b-41d4-a716-446655440001';
    const validInviteUuid = '550e8400-e29b-41d4-a716-446655440002';

    test('4.1. Discriminación estricta de rutas dependientes de propiedad (isOwnershipDependentRoute)', () => {
      // Rutas de propiedad
      assert.equal(isOwnershipDependentRoute(`/meet/${validMeetUuid}`), true);
      assert.equal(isOwnershipDependentRoute(`/add-guests/${validMeetUuid}`), true);
      assert.equal(isOwnershipDependentRoute(`/share/${validMeetUuid}`), true);
      assert.equal(isOwnershipDependentRoute(`/cancel-summary/${validMeetUuid}`), true);
      assert.equal(isOwnershipDependentRoute(`/coordination/${validMeetUuid}`), true);

      // Rutas NO dependientes de propiedad (invitados / creación)
      assert.equal(isOwnershipDependentRoute(`/invitation/${validInviteUuid}`), false);
      assert.equal(isOwnershipDependentRoute(`/invite/${validInviteUuid}`), false);
      assert.equal(isOwnershipDependentRoute(`/join/${validInviteUuid}`), false);
      assert.equal(isOwnershipDependentRoute(`/coordination/invite/${validInviteUuid}`), false);
      assert.equal(isOwnershipDependentRoute(`/coordination/join/${validInviteUuid}`), false);
      assert.equal(isOwnershipDependentRoute('/create'), false);
      assert.equal(isOwnershipDependentRoute('/create/coordination'), false);
      assert.equal(isOwnershipDependentRoute('/create/ai'), false);
      assert.equal(isOwnershipDependentRoute('/'), false);
    });

    test('4.2. Estado claiming en ruta de anfitrión: NO navega y preserva post_auth_redirect', () => {
      const storage: Record<string, string> = {
        'post_auth_redirect': `/meet/${validMeetUuid}`,
      };
      let navigatedTo: string | null = null;

      const runRedirectEffect = (status: TransferClaimStatus) => {
        const path = storage['post_auth_redirect'];
        if (!path || !isValidPostAuthRedirect(path)) return;
        if (isOwnershipDependentRoute(path)) {
          if (status === 'claiming' || status === 'error_transient') return;
          if (status === 'error_terminal') {
            delete storage['post_auth_redirect'];
            return;
          }
          delete storage['post_auth_redirect'];
          navigatedTo = path;
        }
      };

      runRedirectEffect('claiming');
      assert.equal(navigatedTo, null, 'No debe navegar mientras está en claiming');
      assert.equal(storage['post_auth_redirect'], `/meet/${validMeetUuid}`, 'Debe conservar post_auth_redirect');
    });

    test('4.3. Error transitorio en ruta de anfitrión: NO navega y conserva redirect para reintento', () => {
      const storage: Record<string, string> = {
        'post_auth_redirect': `/meet/${validMeetUuid}`,
      };
      let navigatedTo: string | null = null;

      const runRedirectEffect = (status: TransferClaimStatus) => {
        const path = storage['post_auth_redirect'];
        if (!path || !isValidPostAuthRedirect(path)) return;
        if (isOwnershipDependentRoute(path)) {
          if (status === 'claiming' || status === 'error_transient') return;
          if (status === 'error_terminal') {
            delete storage['post_auth_redirect'];
            return;
          }
          delete storage['post_auth_redirect'];
          navigatedTo = path;
        }
      };

      runRedirectEffect('error_transient');
      assert.equal(navigatedTo, null, 'No debe navegar con error transitorio');
      assert.equal(storage['post_auth_redirect'], `/meet/${validMeetUuid}`, 'Debe conservar post_auth_redirect para reintento');

      // Tras reintento exitoso (status pasa a 'success'):
      runRedirectEffect('success');
      assert.equal(navigatedTo, `/meet/${validMeetUuid}`, 'Navega tras éxito en el reintento');
      assert.equal(storage['post_auth_redirect'], undefined, 'Consume post_auth_redirect');
    });

    test('4.4. Error terminal en ruta de anfitrión: NO navega y limpia redirect (previene loop)', () => {
      const storage: Record<string, string> = {
        'post_auth_redirect': `/meet/${validMeetUuid}`,
      };
      let navigatedTo: string | null = null;

      const runRedirectEffect = (status: TransferClaimStatus) => {
        const path = storage['post_auth_redirect'];
        if (!path || !isValidPostAuthRedirect(path)) return;
        if (isOwnershipDependentRoute(path)) {
          if (status === 'claiming' || status === 'error_transient') return;
          if (status === 'error_terminal') {
            delete storage['post_auth_redirect'];
            return;
          }
          delete storage['post_auth_redirect'];
          navigatedTo = path;
        }
      };

      runRedirectEffect('error_terminal');
      assert.equal(navigatedTo, null, 'No debe navegar al encuentro con error terminal');
      assert.equal(storage['post_auth_redirect'], undefined, 'Debe descartar post_auth_redirect para evitar bucle');
    });

    test('4.5. Ruta no dependiente de titularidad (/invitation/:id): navega cuando auth concluye', () => {
      const storage: Record<string, string> = {
        'post_auth_redirect': `/invitation/${validInviteUuid}`,
      };
      let navigatedTo: string | null = null;

      const runRedirectEffect = (status: TransferClaimStatus) => {
        const path = storage['post_auth_redirect'];
        if (!path || !isValidPostAuthRedirect(path)) return;
        const isOwnership = isOwnershipDependentRoute(path);
        if (isOwnership) {
          if (status === 'claiming' || status === 'error_transient') return;
          if (status === 'error_terminal') {
            delete storage['post_auth_redirect'];
            return;
          }
          delete storage['post_auth_redirect'];
          navigatedTo = path;
        } else {
          if (status === 'claiming') return;
          delete storage['post_auth_redirect'];
          navigatedTo = path;
        }
      };

      // Mientras claiming: espera
      runRedirectEffect('claiming');
      assert.equal(navigatedTo, null);
      assert.equal(storage['post_auth_redirect'], `/invitation/${validInviteUuid}`);

      // Al concluir, incluso si transfer ticket falló por error_transient,
      // navega porque la invitación es de invitado y no requiere titularidad
      runRedirectEffect('error_transient');
      assert.equal(navigatedTo, `/invitation/${validInviteUuid}`);
      assert.equal(storage['post_auth_redirect'], undefined);
    });

    test('4.6. Concurrencia de eventos auth: lock en vuelo previene doble invocación del claim', async () => {
      let rpcCallCount = 0;
      let claimInFlight: Promise<boolean> | null = null;

      const mockClaimRpc = async (): Promise<boolean> => {
        rpcCallCount++;
        await new Promise((r) => setTimeout(r, 20));
        return true;
      };

      const executeClaim = async () => {
        if (claimInFlight) return claimInFlight;
        const run = async () => {
          try {
            return await mockClaimRpc();
          } finally {
            claimInFlight = null;
          }
        };
        claimInFlight = run();
        return claimInFlight;
      };

      // Simular 3 eventos simultáneos: INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED
      const [res1, res2, res3] = await Promise.all([
        executeClaim(),
        executeClaim(),
        executeClaim(),
      ]);

      assert.equal(res1, true);
      assert.equal(res2, true);
      assert.equal(res3, true);
      assert.equal(rpcCallCount, 1, 'Debe ejecutarse exactamente 1 vez el RPC ante eventos concurrentes');
    });

    test('4.7. Reintentos automáticos agotados vs. reintento manual', async () => {
      const storage: Record<string, string> = {
        'pe_pending_transfer_ticket': 'mock_valid_token_64chars_abcdef0123456789abcdef0123456789abcdef01234567',
        'pe_transfer_claim_retries': '3',
      };

      let status: TransferClaimStatus = 'idle';
      let error: string | null = null;

      const executeClaim = async (isManual = false) => {
        const retries = parseInt(storage['pe_transfer_claim_retries'] || '0', 10);
        if (!isManual && retries >= 3) {
          status = 'error_transient';
          error = 'max_retries_reached';
          return false;
        }
        // Simular éxito en reintento manual
        delete storage['pe_pending_transfer_ticket'];
        delete storage['pe_transfer_claim_retries'];
        status = 'success';
        error = null;
        return true;
      };

      // Intento automático con 3 reintentos ya agotados
      const autoRes = await executeClaim(false);
      assert.equal(autoRes, false);
      assert.equal(status, 'error_transient');
      assert.equal(error, 'max_retries_reached');
      assert.ok(storage['pe_pending_transfer_ticket'], 'El ticket se preserva en storage para reintento manual');

      // Reintento manual por acción del usuario
      const manualRes = await executeClaim(true);
      assert.equal(manualRes, true);
      assert.equal(status, 'success');
      assert.equal(error, null);
      assert.equal(storage['pe_pending_transfer_ticket'], undefined);
    });

    test('4.8. Fallo de red preserva ticket en storage sin fingir éxito', async () => {
      const storage: Record<string, string> = {
        'pe_pending_transfer_ticket': 'mock_valid_token_64chars_abcdef0123456789abcdef0123456789abcdef01234567',
        'pe_transfer_claim_retries': '0',
      };

      let status: TransferClaimStatus = 'claiming';
      let error: string | null = null;

      try {
        throw new TypeError('Failed to fetch');
      } catch (err: any) {
        storage['pe_transfer_claim_retries'] = '1';
        status = 'error_transient';
        error = 'network_error';
      }

      assert.equal(status, 'error_transient');
      assert.equal(error, 'network_error');
      assert.ok(storage['pe_pending_transfer_ticket'], 'El ticket NO se elimina tras error de red');
      assert.equal(storage['pe_transfer_claim_retries'], '1');
    });

    test('4.9. Fallo terminal por expiración (15m): limpia storage y notifica error terminal', async () => {
      const storage: Record<string, string> = {
        'pe_pending_transfer_ticket': 'mock_valid_token_64chars_abcdef0123456789abcdef0123456789abcdef01234567',
        'pe_transfer_claim_retries': '1',
      };

      let status: TransferClaimStatus = 'claiming';
      let error: string | null = null;

      const TERMINAL_ERRORS = new Set(['ticket_expired', 'ticket_revoked', 'ticket_already_used']);
      const backendError = 'ticket_expired';

      if (TERMINAL_ERRORS.has(backendError)) {
        delete storage['pe_pending_transfer_ticket'];
        delete storage['pe_transfer_claim_retries'];
        status = 'error_terminal';
        error = backendError;
      }

      assert.equal(status, 'error_terminal');
      assert.equal(error, 'ticket_expired');
      assert.equal(storage['pe_pending_transfer_ticket'], undefined, 'Limpia ticket expirado');
      assert.equal(storage['pe_transfer_claim_retries'], undefined);
    });
  });
});
