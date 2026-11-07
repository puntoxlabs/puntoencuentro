# Matriz de Pruebas Adversariales y Plan de Implementación del Mini-Sprint 2B (Entregables 6 y 7)

**Estado del documento:** Plan ejecutable propuesto para aprobación tras el cierre del Mini-Sprint 2A. **No iniciado.**  
**Referencias directas:** Contratos SQL/RPC en [`MIGRACION_IDENTIDAD_DISENO.md`](./MIGRACION_IDENTIDAD_DISENO.md) (§5) y estados UX en [`RECORRIDOS_UX_RECUPERACION_DOMINIO.md`](./RECORRIDOS_UX_RECUPERACION_DOMINIO.md).

---

## 1. Matriz de Pruebas Adversariales y de Integridad (Entregable 6)

Cada caso deberá automatizarse en motor PGlite local (cero red) y, para los casos marcados `[Staging/Cross-Origin]`, verificarse además contra dos orígenes reales y Supabase Staging (`wougfhfwqgmxhgvjqoua`).

| ID | Categoría | Escenario / Ataque Simulado | Resultado Esperado Obligatorio |
| :--- | :--- | :--- | :--- |
| **ADV-01** | Concurrencia (`FOR UPDATE`) | Dos sesiones distintas (`uid_B1`, `uid_B2`) ejecutan `claim_domain_migration_ticket_seguro(code)` simultáneamente (`Promise.all`). `[Staging/Cross-Origin]` | Exactamente **1** retorna `ok: true` y recibe el 100% de los recursos; la otra retorna `ok: false, error: 'ticket_already_used'`. Cero recursos divididos. |
| **ADV-02** | Emisión concurrente | Dos pestañas de la misma sesión `Anónimo A` invocan `create_domain_migration_ticket_seguro` al unísono. | Serializadas por `pg_advisory_xact_lock` + `idx_anonymous_transfer_single_pending`: 1 crea ticket y la otra recibe `'transfer_ticket_already_pending'`. |
| **ADV-03** | Fuerza bruta / Rate-limit | Un usuario en `Dominio B` envía 6 códigos hexadecimales válidos pero inexistentes en menos de 15 minutos. | Los primeros 5 devuelven `'ticket_not_found'`; el 6° devuelve `'rate_limit_exceeded'` (fail-closed) incluso si en el 6° intento probara un código real. |
| **ADV-04** | Expiración estricta (TTL) | Emitir ticket `cross_origin_bridge` (TTL 5 min), avanzar reloj / esperar expiración e intentar canjear. | Retorna `'ticket_expired'`, el ticket pasa a `status = 'expired'` y 0 filas de negocio cambian de dueño. |
| **ADV-05** | Revocación previa al canje | Emitir ticket en `Dominio A`, ejecutar `revoke_my_pending_transfer_ticket()` y luego enviar ese código desde `Dominio B`. | Retorna `'ticket_revoked'` y `Anónimo A` conserva el 100% de sus recursos. |
| **ADV-06** | Escalada sobre cuenta permanente | Un usuario con cuenta Google (`is_anonymous = false`) intenta emitir ticket o un atacante intenta reclamar un ticket cuyo `source` ya hizo upgrade a permanente. | Emisión rechazada con `'anonymous_user_required'`; canje rechazado con `'source_no_longer_anonymous'`. |
| **ADV-07** | Aislamiento `flow_mode` | Emitir ticket con `flow_mode = 'oauth_upgrade'` e intentar canjearlo desde una sesión anónima (`is_anonymous = true`) usando `claim_domain_migration_ticket_seguro`. | Rechazado con `'permanent_account_required'`; al 3° fallo el ticket pasa automáticamente a `status = 'revoked'`. |
| **ADV-08** | Suplantación `postMessage` | `[Staging/Cross-Origin]` Página en origen no autorizado (`http://localhost:5999` o subdominio engañoso) envía `PE_BRIDGE_READY` a `Dominio A` o `PE_BRIDGE_CODE` a `Dominio B` (o con `bridge_nonce` inválido). | Mensaje descartado silenciosamente; `Dominio A` jamás entrega el secreto y `Dominio B` jamás invoca la RPC. |
| **ADV-09** | Open Redirect & URL Leak | Pasar `?next=https://evil.com` o `//evil.com` a `/migrate-receive` o `/auth/domain-bridge`; inspeccionar URLs, `history` y `app_usage_events`. | Redirección cae de forma segura a `'/'`; ningún token ni código de 64 chars aparece jamás en `location.search`, `location.hash` ni tablas de telemetría. |
| **ADV-10** | Cascada `mensajes_encuentro` | `Anónimo A` y `Target B` participan en el mismo encuentro externo; `Anónimo A` publicó mensajes (`autor_participante_id = part_A`) y destacó uno (como co-actor/host en otro). Al fusionar hacia `part_B`, se borra `part_A`. | Cero mensajes eliminados: conservan `autor_participante_id = part_B` (no `NULL`), `autor_user_id = uid_B`, `destacado_por = uid_B` y `es_mio = true` en `listar_mensajes_encuentro_seguro`. |
| **ADV-11** | Conflicto doble en `participante_disponibilidades` | En un encuentro de coordinación externo, **ambos** (`Anónimo A` y `Target B`) votaron boletas distintas con distinta opción `es_preferida = true` (y una opción extra solo en la boleta más antigua). | Gana íntegramente la boleta con mayor `MAX(updated_at)` (incluida su única preferida), se rellena la opción faltante con `es_preferida = false` y se respetan `idx_unica_preferida_por_participante` y `check_preferida_no_unavailable`. |
| **ADV-12** | Colisión `solicitudes_encuentro_abierto` + Waitlist | `Source` y `Target` poseen solicitudes en el mismo encuentro abierto (`waitlist_confirmed` vs `rejected`, `waitlist_offered` con plazo vigente vs `pending`, y dos `waitlist_waiting` con distinto orden FIFO). | Prevalece el estado superior de la jerarquía de 9 niveles (o `created_at ASC` en `waitlist_waiting`), preservando `waitlist_expires_at` / `host_approval_expires_at`, `mensaje` y `idx_solicitudes_activas_unicas`. |
| **ADV-13** | Cobertura completa y cero pérdidas en recursos auxiliares | `Anónimo A` tiene encuentro con `encuentros_contacto_whatsapp`, 3 `custom_invitation_templates` activos (`Target` tiene 2 = 5), `coverage_requests` duplicada, `inbox_notifications` duplicada (1 no leída vs 1 leída) y `asistencia_controversias` (`absence_reported` sobre `part_A`). | Transferencia atómica sin error `23505`: WhatsApp pasa a `uid_B`, los 5 templates quedan activos, la notificación resultante queda **no leída** (`read_at IS NULL`) y la controversia se re-vincula a `part_B` / `uid_B` sin perderse por `ON DELETE CASCADE`. |
| **ADV-14** | Rescate de invitado sin sesión (`user === null`) | `[Staging/Cross-Origin]` Invitado sin sesión con los 4 tipos de tokens locales (`participated_tokens`, `puntoencuentro_guest_token_by_public_*`, `puntoencuentro_coordination_guest_token_by_public_*` e invitación individual de coordinación) traslada a `Anónimo B`. | `Dominio A` materializa sesión anónima, vincula el lote con `vincular_tokens_participante_lote_seguro`, transfiere a `Anónimo B` y `Home` en `Dominio B` lista los 4 encuentros en «Participo». |
| **ADV-15** | Caída de red post-commit e idempotencia | El canje hace `COMMIT` en PostgreSQL pero el cliente simula pérdida de respuesta HTTP y llama a `confirmar_migracion_dominio_completada_seguro(code)`. | Retorna `{ ok: true, already_completed: true }` para `uid_B` (incluso siendo anónimo en `cross_origin_bridge` / `cross_origin_manual`), mientras que cualquier `uid_C` tercero recibe `'transfer_not_confirmed'`. |
| **ADV-16** | Cadena completa `A → B → C` | `Anónimo A` migra a `Anónimo B`, crea un encuentro nuevo en `B`, y luego migra `Anónimo B → Anónimo C` (y finalmente a Google). | `uid_C` (y luego Google) conserva los encuentros creados en `A` y en `B`; ningún `rate_limit_buckets` histórico de `uid_A` o `uid_B` fue reseteado. |
| **ADV-17** | Congelamiento de escrituras post-migración en `Dominio A` | Tras completar el canje `A → B`, la sesión `Anónimo A` intenta ejecutar `crear_encuentro_seguro`, `vincular_usuario_participante_seguro`, `vincular_tokens_participante_lote_seguro`, `submit_coverage_request`, `INSERT` en `usuario_localidades` / `custom_invitation_templates` o emitir otro ticket. | **100% rechazado** con `'anonymous_session_already_migrated'` (o bloqueo RLS equivalente). Cero recursos nuevos o abandonados bajo `uid_A`. |
| **ADV-18** | Operaciones concurrentes durante el canje | `[Staging/Cross-Origin]` `Promise.all` entre una escritura activa en `Dominio A` (`crear_encuentro_seguro` por `uid_A`) y el canje en `Dominio B` (`claim_domain_migration_ticket_seguro` hacia `uid_B`). | Serialización limpia por `pg_advisory_xact_lock('pe_identity_mutation:' || ...)`: o bien el nuevo encuentro entra íntegro en la transferencia hacia `uid_B`, o bien es rechazado con `'anonymous_session_already_migrated'`. Jamás queda un encuentro huérfano en `uid_A` ni falla una post-condición. |
| **ADV-19** | Asociación estricta al destinatario (`intended_target_user_id`) | Emitir ticket `cross_origin_bridge` vinculado a `intended_target_user_id = uid_B`; otra sesión `uid_Evil` intercepta el secreto e intenta canjearlo antes que `uid_B`. | Rechazado con `'ticket_target_mismatch'` sin transferir nada; si `uid_B` canjea antes del 3° fallo ajeno obtiene éxito (`>= 3` fallos revocan el ticket por defensa activa). |
| **ADV-20** | TTL reducido de fallback manual (`cross_origin_manual`) | Emitir ticket `cross_origin_manual` (`intended_target_user_id IS NULL`) y probar canje a los `181` segundos (3m 01s), e intentar emitir `cross_origin_bridge` con `intended_target_user_id = NULL`. | El manual expira exactamente a los 3 minutos (`'ticket_expired'`); `cross_origin_bridge` sin destinatario es rechazado con `'intended_target_required'` (y constraint `check_bridge_requires_intended_target`). |

### 1.1 Criterios Formales de Aceptación para Cerrar el Mini-Sprint 2B
1. 100% de los casos `ADV-01` a `ADV-20` en verde en suite automatizada local (PGlite) + suite existente `scripts/test-domain-migration-readiness.ts` sin regresiones.
2. `npx tsc -b` y `npm run build` limpios sin errores ni warnings de tipos.
3. Cero exposición de JWTs, `refresh_token` o códigos de 64 caracteres en query strings, fragmentos `#`, encabezados `Referer`, consola de producción o tablas de telemetría.
4. Congelamiento total verificado de sesiones anónimas retiradas (`is_retired_anonymous_source = true`) y asociación obligatoria `intended_target_user_id` en el flujo automático `cross_origin_bridge`.
5. Feature flags del puente **desactivados por defecto** (`false`), garantizando impacto visual y funcional **cero** en Producción.
6. Validación real contra Supabase Staging (`wougfhfwqgmxhgvjqoua`) entre dos orígenes distintos, seguida de limpieza verificada con conteo `0` de residuos en tablas de negocio, tickets, rate-limit de prueba y telemetría.

---

## 2. Plan de Implementación del Mini-Sprint 2B (Entregable 7)

### Tarea 2B.1 — Migración SQL Aditiva y Análisis de Reversibilidad
- **Archivo a crear (solo en 2B):** `supabase/migrations/<timestamp>_domain_identity_bridge_v1.sql`.
- **Contenido:**
  1. Extender `public.anonymous_transfer_tickets` con `flow_mode` (`'oauth_upgrade' | 'cross_origin_bridge' | 'cross_origin_manual'`), `intended_target_user_id UUID NULL`, `failed_claim_attempts INT NOT NULL DEFAULT 0`, `check_bridge_requires_intended_target` e índice `idx_anonymous_transfer_source_completed`.
  2. Crear helper `public.is_retired_anonymous_source(UUID)` y políticas en `public.rate_limit_policies`: `'create_migration_ticket'`, `'claim_migration_ticket'`, `'link_guest_tokens_batch'`.
- **Análisis de reversibilidad y rollback SQL:**
  - Todas las columnas nuevas poseen valores por defecto compatibles con las RPCs existentes (`flow_mode = 'oauth_upgrade'`, `intended_target_user_id = NULL`, `failed_claim_attempts = 0`).
  - **Rollback operativo inmediato (< 1 min, sin migración destructiva):** Desactivar `VITE_ENABLE_DOMAIN_MIGRATION_BRIDGE=false` y/o revocar ejecución sobre `create_domain_migration_ticket_seguro` y `claim_domain_migration_ticket_seguro`. Ningún dato ya transferido se pierde porque pertenece legítimamente al `auth.uid()` destino.

### Tarea 2B.2 — RPCs `SECURITY DEFINER`, Motor Unificado, Congelamiento Post-Migración y Locks
1. Crear `public._transfer_anonymous_resources_internal(UUID, UUID)` con serialización ordenada `pe_identity_mutation` (`LEAST` → `GREATEST`), las reglas deterministas de resolución de conflictos sin pérdida de [`MIGRACION_IDENTIDAD_DISENO.md`](./MIGRACION_IDENTIDAD_DISENO.md) §2.3, post-condiciones `A..L` y `REVOKE ALL FROM PUBLIC, anon, authenticated`.
2. Incorporar el lock `pe_identity_mutation` + guardia `is_retired_anonymous_source(auth.uid())` (`'anonymous_session_already_migrated'`) en las superficies de escritura alcanzables por anónimos (`crear_encuentro_seguro`, `vincular_usuario_participante_seguro`, `vincular_tokens_participante_lote_seguro`, `submit_coverage_request`, `iniciar_sesion_creacion_qa`, `enviar_feedback_usuario`, políticas RLS `INSERT`/`UPDATE` de `usuario_localidades` y `custom_invitation_templates` + `storage.objects`).
3. Actualizar `public.get_anonymous_upgrade_state()` y `public.claim_anonymous_transfer(TEXT)` delegando en el motor unificado.
4. Crear `public.vincular_tokens_participante_lote_seguro(TEXT[])`, `public.create_domain_migration_ticket_seguro(TEXT, UUID)`, `public.claim_domain_migration_ticket_seguro(TEXT)` y `public.confirmar_migracion_dominio_completada_seguro(TEXT)` con `SET search_path = ''` y `GRANT EXECUTE TO authenticated` exclusivamente.

### Tarea 2B.3 — Paridad de Inventario Local, Servicios Frontend y Rutas del Puente
1. **Cerrar las 4 brechas de participaciones detectadas en 2A:**
   - En `src/lib/participatedTokens.ts`: ampliar `getAllParticipatedTokens()` (o añadir `collectAllLocalInvitationTokens()`) para recolectar de forma deduplicada: `participated_tokens`, todas las claves con prefijo `puntoencuentro_guest_token_by_public_` y `puntoencuentro_coordination_guest_token_by_public_`, mapas heredados `encuentros_general` / `encuentros_coordination_general` y `sessionStorage['pending_participant_invitation_token']`.
   - En `src/screens/JoinCoordination/index.tsx` e `src/screens/InviteCoordination/index.tsx`: registrar `saveParticipatedToken(token)` y `linkParticipantTokenToCurrentUser(token)` al igual que ya hace `InviteGuest.tsx`.
   - En `src/screens/Home.tsx` (línea 1130): invocar `encuentrosService.getEncuentrosParticipados(user.id)` para **toda** sesión autenticada (`if (user?.id)` en lugar de `if (!user.is_anonymous)`), deduplicando por `encuentro.id` con los tokens locales.
   - En `src/services/encuentrosService.ts`: eliminar el método muerto `linkAnonymousEncuentros` (`transferir_encuentros_anonimos_seguro`).
2. **Servicio del puente (`src/services/domainMigrationBridgeService.ts`):**
   - Pre-sincronización previa a emitir llave: sincronizar `puntoencuentro_zones_v1` si aplica, materializar sesión anónima si `user === null && localTokens.length > 0` y llamar `vincular_tokens_participante_lote_seguro`.
   - Handshake `postMessage` con asociación al destinatario (`PE_BRIDGE_READY` entrega `uid_B` + `bridge_nonce` de 128 bits → `Dominio A` emite ticket `cross_origin_bridge` atado a `uid_B`), validación estricta de orígenes (`PUBLIC_APP_ORIGIN` y `LEGACY_APP_ORIGINS` desde `src/config/domainConfig.ts`), fallback manual `cross_origin_manual` (TTL 3 min) tras 2.500 ms sin `opener`, bloqueo de escrituras locales cuando `already_migrated = true` (**sin** ejecutar `signOut()` en `Dominio A`) y confirmación idempotente ante corte de red.
3. **Rutas y listas blancas:**
   - Rutas `/auth/domain-bridge` (emisora) y `/migrate-receive` (receptora) protegidas tras el feature flag.
   - Añadir `/auth/domain-bridge` y `/migrate-receive` en `STATIC_ALLOWED_POST_AUTH_ROUTES` (`src/hooks/usePostAuthRedirect.ts`) y en normalización de rutas de `src/services/appUsageTelemetry.ts` / `feedbackService.ts` (garantizando cero captura de parámetros).
   - Configurar cabeceras `X-Frame-Options: DENY` y `Content-Security-Policy: frame-ancestors 'none'` para `/auth/domain-bridge` y `/migrate-receive` en `vercel.json`.

### Tarea 2B.4 — Feature Flags Desactivados por Defecto
- En `src/config/domainConfig.ts` / `src/config/features.ts`:
  - `ENABLE_DOMAIN_MIGRATION_BRIDGE`: leído de `VITE_ENABLE_DOMAIN_MIGRATION_BRIDGE === 'true'`, **por defecto `false`**.
  - Mientras esté en `false`: no se muestra ningún banner de mudanza y las rutas del puente redirigen limpiamente a `'/'` (salvo en los entornos de prueba donde se active explícitamente la variable).
  - `ENABLE_LEGACY_DOMAIN_REDIRECT` permanece en **`false`**.

### Tarea 2B.5 — Suite Automatizada Local (PGlite)
- Crear `scripts/test-domain-identity-bridge.ts` ejecutando sobre PGlite en memoria todas las migraciones reales hasta la nueva migración de 2B y probando de punta a punta `ADV-01` a `ADV-20` (incluyendo concurrencia durante el canje, congelamiento de sesión retirada, asociación al destinatario, límites de intentos, cascadas de mensajes/disponibilidades/controversias, waitlist y cadena `uid_A → uid_B → uid_C`).

### Tarea 2B.6 — Pruebas Reales Cross-Origin SIN Necesitar el Nuevo Dominio Definitivo
Para validar el aislamiento real del navegador (`localStorage` separado, `window.open`, `postMessage`, `event.origin` y fallback manual) **hoy mismo, antes de que exista el nuevo nombre o dominio**:
1. **Ensayo Cross-Origin Local Dual:**
   - Instancia Origen A ("dominio histórico"): `http://localhost:5173` con `VITE_APP_URL=http://localhost:5173` y destino configurado hacia `http://127.0.0.1:5174`.
   - Instancia Origen B ("dominio nuevo"): `http://127.0.0.1:5174` con `VITE_APP_URL=http://127.0.0.1:5174` y `LEGACY_APP_ORIGINS=http://localhost:5173`.
   - Para todos los navegadores modernos, `http://localhost:5173` y `http://127.0.0.1:5174` son **orígenes y sitios completamente distintos (*cross-site*)**, reproduciendo al 100% el aislamiento real entre dos dominios productivos.
2. **Ensayo Cross-Origin HTTPS en Preview/Staging (cuando se autorice despliegue a `staging`):**
   - Origen A: URL de Vercel Preview (`https://puntoencuentro-git-staging-*.vercel.app`) ↔ Origen B: `https://staging.puntoencuentro.com.ar` (ambos ya permitidos en `validateOriginForEnvironment` para `preview`/`staging`).

### Tarea 2B.7 — QA contra Supabase Staging y Limpieza Total (Incluyendo Telemetría)
1. Aplicar la migración aditiva **exclusivamente en Supabase Staging (`wougfhfwqgmxhgvjqoua`)** siguiendo el skill `staging-supabase-change`.
2. Ejecutar `scripts/qa-staging-domain-bridge.ts` invocando obligatoriamente `assertStagingEnvironment()` en la primera línea (fail-closed si el ref no es `wougfhfwqgmxhgvjqoua`).
3. Todos los datos de prueba usarán prefijo identificable `[QA-2B-BRIDGE-<runId>]`.
4. **Bloque `finally` obligatorio de limpieza y verificación en cero:**
   - Borrar filas creadas por `runId` / usuarios efímeros de prueba en:
     - Negocio: `asistencia_controversias`, `mensajes_encuentro`, `participante_disponibilidades`, `solicitudes_encuentro_abierto`, `encuentros_contacto_whatsapp`, `participantes`, `encuentros`, `custom_invitation_templates`, `usuario_localidades`, `coverage_requests`, `inbox_notifications`, `notification_delivery_outbox`, `user_feedback`.
     - Infraestructura del puente y cuotas: `anonymous_transfer_tickets`, `rate_limit_buckets`.
     - Telemetría y observabilidad: `creation_sessions`, `ai_creation_sessions`, `app_usage_events` (filtrando por ventana/sesión de prueba si se tocó UI) y `domain_events_outbox`.
   - Eliminar los usuarios efímeros creados en `auth.users` mediante `adminClient.auth.admin.deleteUser(uid)` y **verificar con consultas `COUNT(*) = 0`** que no quedó ningún rastro en Staging.
