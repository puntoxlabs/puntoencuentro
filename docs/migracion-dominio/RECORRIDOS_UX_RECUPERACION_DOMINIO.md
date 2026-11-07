# Diseño de Experiencia de Usuario: Recorridos de Recuperación entre Dominios (Mini-Sprint 2A — Entregable 5)

**Estado del documento:** Especificación funcional y de estados UX (sin implementación de UI final, conforme a las restricciones del Mini-Sprint 2A).  
**Base técnica:** [`MIGRACION_IDENTIDAD_DISENO.md`](./MIGRACION_IDENTIDAD_DISENO.md) (protocolo criptográfico y RPCs) y [`ARQUITECTURA_DOMINIOS.md`](./ARQUITECTURA_DOMINIOS.md) (PWA y Web Push).

---

## 1. Principios de Comunicación para Personas sin Conocimientos Técnicos

1. **Cero jerga técnica:** Nunca usar palabras como *«sesión anónima»*, *«token»*, *«origen»*, *«localStorage»*, *«OAuth»*, *«hash»* o *«migración de identidad»*. Hablar siempre de **«tus encuentros»**, **«tus invitaciones»**, **«nuestra nueva dirección»** y **«llave temporal de traslado»**.
2. **Transparencia sin alarma:** Dejar claro desde el primer segundo que ningún encuentro se borró ni cambió de fecha; solo cambia la dirección web.
3. **Elección libre (sin obligar a Google):** Quien usa la app sin cuenta puede pasar al nuevo sitio **sin registrarse** en un toque; vincular Google se ofrece como beneficio opcional de respaldo permanente (ej. si cambia de celular), nunca como peaje obligatorio.
4. **Cero pérdida por cerrar o dudar:** Cerrar la pantalla o arrepentirse a mitad del paso deja todo exactamente como estaba en el sitio actual.

---

## 2. Arquitectura de Pantallas y Estados (Sin UI Final)

### 2.1 Puntos de entrada durante la ventana de transición
1. **Banner contextual en el dominio anterior (`Dominio A`):** Visible cuando el origen actual pertenece a `LEGACY_APP_ORIGINS` (y el feature flag del puente está activo). Adapta su texto y botón primario según la cohorte real detectada en cliente + `get_anonymous_upgrade_state()`.
2. **Pantalla emisora en el dominio anterior (`/auth/domain-bridge`):** Exenta de redirecciones automáticas (`LEGACY_REDIRECT_EXEMPT_PATHS`). Concentra el resumen de lo que se va a trasladar, las opciones de traslado y el fallback manual de copia de llave.
3. **Pantalla receptora en el dominio nuevo (`/migrate-receive`):** Recibe el traslado automático entre pestañas o permite pegar la llave temporal si el usuario vino desde otro navegador o aplicación. Accesible también desde un enlace discreto en `Home` del nuevo sitio: *«¿Tenías encuentros sin cuenta en el sitio anterior? Traelos acá»*.

### 2.2 Máquina de Estados de Pantalla

| Ubicación | Estado | Condición de Entrada | Mensaje Principal al Usuario | Acción Primaria / Secundaria |
| :--- | :--- | :--- | :--- | :--- |
| `Dominio A` | `detecting_inventory` | Montaje de `/auth/domain-bridge` | *«Revisando tus encuentros guardados en este dispositivo…»* | Indicador de carga breve (< 1 s). |
| `Dominio A` | `google_ready` | `user && !user.is_anonymous` | *«Tus encuentros ya están respaldados en tu cuenta de Google.»* | **Primaria:** «Ir a `<NuevaMarca>` e ingresar con Google» · **Secundaria:** «Seguir acá por ahora». |
| `Dominio A` | `empty_clean` | Sin recursos en servidor ni invitaciones locales y `already_migrated = false` | *«Nos mudamos a `<NuevoDominio>`. Podés empezar directamente allá.»* | **Primaria:** «Abrir `<NuevaMarca>`». |
| `Dominio A` | `ready_to_migrate` | Anónimo con recursos o invitado con participaciones locales | *«Encontramos tus encuentros en este navegador. Llevátelos al nuevo sitio en un paso.»* (Muestra conteo simple: ej. *«2 encuentros organizados · 1 invitación respondida»*). | **Primaria:** «Llevar mis encuentros ahora (sin crear cuenta)» · **Secundaria:** «Guardar con Google para no perderlos nunca». |
| `Dominio A` | `awaiting_handshake` | Se abrió `Dominio B` y se negocia traslado automático vinculado al destinatario (TTL 5 min) | *«Conectando con el nuevo sitio… No cierres esta ventana todavía.»* | Si en 2,5 s no hay respuesta automática, pasa solo a `manual_code_fallback`. |
| `Dominio A` | `manual_code_fallback` | `window.opener == null` o timeout de 2,5 s (emite llave manual TTL 3 min) | *«Copiá esta llave temporal (vence en 3 minutos) y pegala solo en el nuevo sitio. No la compartas por chat.»* | **Primaria:** «Copiar llave y abrir nuevo sitio» · **Secundaria:** «Cancelar llave». |
| `Dominio A` | `already_migrated` | `PE_BRIDGE_COMPLETED` recibido o `already_migrated = true` en servidor (escrituras bloqueadas) | *«¡Listo! Tus encuentros ya están en `<NuevoDominio>`. Este navegador anterior quedó cerrado para crear encuentros nuevos.»* | **Primaria (única):** «Ir a mis encuentros en `<NuevaMarca>`». |
| `Dominio B` | `receiving_auto` | Envió `PE_BRIDGE_READY` con su `uid_B` y recibió `PE_BRIDGE_CODE` válido | *«Trayendo tus encuentros a `<NuevaMarca>`…»* | Automático (ejecuta canje atado a `uid_B`). |
| `Dominio B` | `awaiting_manual_code` | Abierto directamente sin `postMessage` | *«Pegá la llave temporal que copiaste en el sitio anterior.»* | Campo protegido (`type="password"`) + **Primaria:** «Recuperar mis encuentros» · **Alternativa:** «Entrar con Google». |
| `Dominio B` | `completed` | RPC de canje (o confirmación idempotente) retorna `ok: true` | *«¡Tus encuentros ya están acá! No perdiste participantes, respuestas ni mensajes.»* | **Primaria:** «Ver mis encuentros» (`navigate('/')`). |
| `Dominio A / B` | `error_recoverable` | Error de red, llave vencida o llave ya usada | Mensaje específico en lenguaje llano (ver §4). | Reintentar confirmación o generar nueva llave en 1 toque. |

---

## 3. Los 6 Recorridos Obligatorios Paso a Paso

### Recorrido 1 — Usuario con cuenta Google (`is_anonymous = false`)
1. **En `Dominio A`:** Ve un aviso superior tranquilo: *«Cambiamos de dirección a `<NuevoDominio>`. Como usás tu cuenta de Google, todos tus encuentros, contactos y plantillas ya están guardados.»*
2. **Acción:** Pulsa **«Abrir `<NuevaMarca>`»** (si tenía PWA instalada con avisos push en `Dominio A`, el paso sugiere reactivar avisos en el nuevo sitio y desactiva el endpoint viejo tras confirmar para evitar avisos dobles).
3. **En `Dominio B`:** Pulsa **«Continuar con Google»**.
4. **Confirmación:** Ingresa a `Home` con el mismo `auth.uid()`, viendo exactamente sus encuentros organizados, participaciones, contactos frecuentes, listas, plantillas y notificaciones, sin duplicados.

### Recorrido 2 — Organizador anónimo con encuentros activos
1. **En `Dominio A`:** Ve el aviso destacado: *«Tenés encuentros activos guardados solo en este navegador. Trasladalos a nuestra nueva dirección para seguir administrándolos.»* Pulsa **«Trasladar mis encuentros»**.
2. **En `/auth/domain-bridge` (`Dominio A`):** Ve el resumen claro (ej. *«Asado del sábado y 1 encuentro más, con sus invitados y mensajes»*) y elige entre:
   - **Camino 2A (Sin registrarse — Primario):** Pulsa **«Llevar mis encuentros ahora (sin crear cuenta)»**.
     - `Dominio A` sincroniza eventuales zonas/invitaciones locales, abre `Dominio B/migrate-receive` (que inicializa su sesión limpia sin registro `uid_B`), emite la llave temporal de 5 minutos asociada exclusivamente a `uid_B` y transfiere atómicamente la titularidad (`host_id`), contacto WhatsApp, mensajes, destacados y diseños personalizados, congelando luego la sesión anterior en `Dominio A`.
   - **Camino 2B (Con respaldo Google — Opcional):** Pulsa **«Guardar con Google y pasar al nuevo sitio»**.
     - Completa el login con Google en `Dominio A` (reutilizando `claim_anonymous_transfer`), y al terminar salta a `Dominio B`.
3. **Confirmación en `Dominio B`:** Pantalla breve de éxito *«¡Listo! Tus encuentros ya están en `<NuevaMarca>`»* y acceso inmediato al panel de organizador (`/meet/:id`) con todos los invitados, estados y mensajes intactos.

### Recorrido 3 — Invitado sin registro con participaciones guardadas localmente
1. **Detección en `Dominio A`:** Aunque nunca haya creado un encuentro (`user === null`), el colector unificado detecta invitaciones respondidas en `participated_tokens`, `puntoencuentro_guest_token_by_public_*` y `puntoencuentro_coordination_guest_token_by_public_*`.
2. **Mensaje:** *«Tenés invitaciones guardadas en este navegador. Llevátelas al nuevo sitio para seguir viendo la fecha, el lugar y los avisos del organizador.»*
3. **Ejecución transparente al pulsar «Llevar mis invitaciones»:**
   - En segundo plano en `Dominio A`: si `user === null`, crea silenciosamente una sesión técnica (`ensureHostSession()`), vincula todos sus tokens locales (`vincular_tokens_participante_lote_seguro`) y ejecuta el traslado asociado hacia `Dominio B`.
   - En `Dominio B`: transfiere las filas de `public.participantes` (y sus votos en `participante_disponibilidades` + autoría en `mensajes_encuentro` + eventuales controversias) a la sesión de `Dominio B`.
4. **Confirmación en `Dominio B`:** En `Home` → pestaña **«Participo»**, el invitado ve inmediatamente todas sus invitaciones fijas y de coordinación (gracias a la lectura de `get_encuentros_participados_seguro()` para sesiones anónimas y permanentes), sin necesidad de buscar otra vez los links en WhatsApp.

### Recorrido 4 — Usuario anónimo que cancela o interrumpe la migración
1. **Caso A — Cierra la pantalla antes de generar llave:** No ocurrió ningún cambio en base de datos. Sigue viendo y administrando sus encuentros en `Dominio A`.
2. **Caso B — Generó la llave o se abrió `Dominio B`, pero cierra la pestaña / toca «Cancelar traslado» antes de canjear:**
   - En `Dominio A`: si pulsa «Cancelar traslado», se ejecuta `revoke_my_pending_transfer_ticket()` y aparece el mensaje tranquilizador: *«Cancelamos el traslado. Tus encuentros siguen intactos en este navegador y podés pasarlos cuando quieras.»*
   - Si simplemente cerró la pestaña sin tocar nada, la llave vence sola a los **5 minutos** (o **3 minutos** si estaba en modo manual) y `Dominio A` conserva el 100% de sus encuentros y permisos (`signOut()` jamás se ejecuta en `Dominio A`).

### Recorrido 5 — Usuario que perdió acceso al dominio antiguo (o cambió/borró su navegador antes de migrar)
Cuando un usuario llega directamente a `Dominio B` y pulsa *«¿Tenías encuentros en el sitio anterior?»* pero perdió definitivamente el navegador donde usaba `Dominio A` (o `Dominio A` ya fue retirado definitivamente):

Pantalla honesta guiada por **3 situaciones concretas** (declarando con claridad el límite real de seguridad):
1. **«Antes entraba con Google»:** Botón directo **«Continuar con Google»** → recupera el 100% al instante.
2. **«Era invitado en un encuentro»:** Explicación simple: *«Abrí de nuevo el link de invitación que te pasaron por WhatsApp: funciona automáticamente en nuestra nueva dirección y volverá a guardarse acá.»*
3. **«Organicé un encuentro sin cuenta y perdí definitivamente aquel navegador / teléfono»:** Advertencia expresa y transparente: **al no haberse vinculado una cuenta, ni el sistema ni el equipo de soporte pueden reasignar la administración del encuentro desde otro dispositivo distinto, por lo que no será posible recuperar el panel de organizador de ese encuentro.** Se ofrecen de inmediato las salidas reales:
   - Si los invitados ya recibieron su link (`/join/:token` o `/invite/:token`), **siguen viendo la invitación normalmente** (el encuentro no se borró para ellos).
   - Si el usuario todavía conserva otro dispositivo o navegador donde tenía abierto el sitio anterior mientras dure la convivencia (ver `PLAN_CAMBIO_DOMINIO.md`), pasos simples para abrirlo allí y traerlo.
   - Botón directo para crear un nuevo encuentro o contactar a soporte (`VITE_PUBLIC_SUPPORT_EMAIL`) únicamente para bajas justificadas de moderación.

### Recorrido 6 — Usuario que vuelve a migrar desde `Dominio B` hacia `Dominio C` (y bloqueo post-migración en `Dominio A`)
1. **Migración repetida `Dominio B → Dominio C`:**
   - **Si en `A → B` eligió Google:** En `Dominio C` solo pulsa «Continuar con Google».
   - **Si en `A → B` eligió seguir sin cuenta (`Anónimo B`):** Su sesión `uid_B` es activa y titular de todos los encuentros traídos desde `A` más los creados en `B`. Al abrirse `B → C`, repite el **Recorrido 2** (`uid_B → uid_C`). Los enlaces viejos de `A` y `B` saltan directo a `C` sin cadenas (`resolveLegacyDomainRedirect`).
2. **Comportamiento al reabrir `Dominio A` después de completar la transferencia:**
   - La sesión `Anónimo A` queda congelada permanentemente para escrituras (`already_migrated = true` / `'anonymous_session_already_migrated'`), **sin cerrar la sesión local** para evitar que un clic accidental genere otra cuenta anónima huérfana en el sitio viejo.
   - `Dominio A` muestra únicamente el estado `already_migrated` (*«Tus encuentros ya están en nuestra nueva dirección»*) y cualquier intento de crear un encuentro o sumar invitaciones en `Dominio A` redirige directamente a realizarlo en `Dominio B`.

---

## 4. Matriz de Mensajes y Recuperación ante Errores

| Código Técnico RPC / Red | Qué ocurrió realmente | Mensaje al Usuario (Lenguaje Claro) | Acción de Recuperación Ofrecida |
| :--- | :--- | :--- | :--- |
| Error de red / timeout HTTP durante el canje | La petición se cortó; puede haberse completado o no en servidor. | *«Se cortó la conexión un segundo mientras verificábamos el traslado.»* | 1° Ejecuta automáticamente `confirmar_migracion_dominio_completada_seguro(token)`. Si ya se completó, pasa directo a éxito (`completed`). Si no, muestra botón **«Reintentar ahora»**. |
| `ticket_expired` | Venció el plazo de la llave (5 min en automático o 3 min en llave manual). | *«Esta llave temporal venció por seguridad. Tus encuentros siguen a salvo en la pestaña anterior.»* | Botón **«Generar una llave nueva»** en 1 toque. |
| `ticket_target_mismatch` | Se intentó usar una llave automática en otra ventana/sesión distinta a la destinataria. | *«Esta llave estaba vinculada a otra pestaña. Generá una llave nueva para completar el traslado acá.»* | Ofrece reabrir el traslado desde la pestaña anterior o usar modo manual (3 min). |
| `ticket_already_used` | El código ya fue canjeado (ej. doble clic o pestaña duplicada). | *«Esta llave ya fue utilizada. Si acabás de usarla acá, tus encuentros ya deberían aparecer en el inicio.»* | Primero consulta `confirmar_migracion_dominio_completada_seguro`: si fue esta misma sesión, redirige a éxito; si fue otra, ofrece **«Ir al inicio»**. |
| `ticket_revoked` | El usuario canceló la llave o superó intentos fallidos de validación. | *«Esta llave fue cancelada por seguridad. Podés generar una nueva desde el sitio anterior.»* | Botón **«Volver a intentar»**. |
| `anonymous_session_already_migrated` | Intentó crear un encuentro o emitir otra llave desde la sesión ya migrada en `Dominio A`. | *«Tus encuentros de este navegador ya pasaron al nuevo sitio. Continuá directamente allá para no dejar nada atrás.»* | Botón único **«Abrir `<NuevaMarca>`»**. |
| `transfer_ticket_already_pending` | Ya había pedido una llave vigente en `Dominio A` y recargó la página. | *«Tenías un traslado en curso. ¿Querés generar una llave nueva?»* | Ejecuta `revoke_my_pending_transfer_ticket()` + `create_domain_migration_ticket_seguro()` en un solo clic. |
| `invalid_token_format` / `ticket_not_found` | Pegó el texto incompleto en el modo manual. | *«No pudimos reconocer esa llave. Revisá haberla copiado completa desde el botón "Copiar llave".»* | Mantiene el campo listo para volver a pegar sin recargar la página. |
| `rate_limit_exceeded` | Más de 5 intentos en 15 minutos. | *«Hiciste varios intentos seguidos. Esperá unos minutos antes de volver a probar; tus encuentros siguen seguros.»* | Deshabilita envío temporalmente e informa espera (~15 min). |
| `no_transferable_resources` | Pulsó trasladar en una sesión vacía. | *«No encontramos encuentros pendientes de trasladar en este navegador.»* | Botón directo **«Abrir el nuevo sitio»**. |
