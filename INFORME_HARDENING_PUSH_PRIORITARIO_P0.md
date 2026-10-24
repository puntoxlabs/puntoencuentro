# PuntoEncuentro — Informe Técnico Mini-sprint P0
**Blindaje de Notificaciones Críticas, Prioridad Web Push e Integridad de Eventos de Dominio**

---

## 1. Resumen Ejecutivo

### 1.1. Contexto de Ejecución
- **Repositorio:** `puntoxlabs/puntoencuentro`
- **Rama:** `staging`
- **HEAD base:** `1b46b9d`
- **Supabase Staging:** `wougfhfwqgmxhgvjqoua`
- **Entorno Productivo (`aurbicjwftjhwryhyjiq`):** Estrictamente excluido e intacto.
- **Alcance ejecutado:** Mini-sprint P0 autorizado tras la evaluación de `INFORME_AUDITORIA_NOTIFICACIONES_PRIORITARIAS.md`.

### 1.2. Objetivos Satisfechos
1. **Fase A (Reemplazo visual destructivo):** Se eliminó el riesgo de que notificaciones generales reemplacen visualmente alertas críticas en el panel del sistema operativo.
2. **Fase B (Prioridad de entrega):** Se implementó clasificación conservadora server-side de urgencia HTTP (`urgency: "high"` para eventos críticos, `"normal"` para informativos y desconocidos).
3. **Fase C (Integridad del worker de eventos):** Se incorporó el handler no-op para `encounter.participant.withdrawn.v1` en `domain-events-worker`, desplegando la Edge Function actualizada en Staging y documentando el estado de la cola sin alterar eventos históricos.

---

## 2. Contratos Modificados y Arquitectura

### 2.1. Base de Datos: `claim_web_push_deliveries_seguro`
- **Migración aditiva:** `supabase/migrations/20261023183000_harden_web_push_claim_and_priority_v1.sql`
- **Firma conservada:** `public.claim_web_push_deliveries_seguro(p_batch_size INT DEFAULT 10, p_worker_id TEXT DEFAULT 'web-push-worker') RETURNS JSONB`
- **Modificación realizada:**
  - Proyección en la consulta SKIP LOCKED de `i.notification_type` y evaluación de metadata confiable `i.payload`.
  - Cálculo server-side estricto de `v_is_critical` y `v_urgency`:
    ```sql
    v_is_critical := COALESCE(
        v_claimed_rows.notification_type IN (
            'encounter_cancelled_for_participant',
            'open_encounter_request_cancelled_by_host'
        )
        OR (
            v_claimed_rows.notification_type = 'encounter_schedule_changed'
            AND COALESCE((v_claimed_rows.payload->>'is_applicant')::boolean, false) = false
        )
        OR (COALESCE(v_claimed_rows.payload->>'priority', '') = 'critical'),
        false
    );

    IF v_is_critical THEN
        v_urgency := 'high';
    ELSE
        v_urgency := 'normal';
    END IF;
    ```
  - Proyección al lote retornado: `'notification_type'`, `'is_critical'`, `'urgency'`.
  - **Invariantes preservadas:** `SECURITY DEFINER`, `SET search_path = ''`, permisos restringidos a `service_role`, cerrojo `FOR UPDATE OF d SKIP LOCKED`, verificación de dispositivo compartido, cancelación de notificaciones leídas in-app o expiradas.

### 2.2. Edge Function: `web-push-worker`
- **Archivo:** `supabase/functions/web-push-worker/index.ts`
- **Versión desplegada en Staging:** Versión 2 (actualizada exitosamente).
- **Lógica de entrega implementada:**
  1. **Evaluación conservadora:**
     ```typescript
     const isCritical =
       delivery.is_critical === true ||
       delivery.urgency === "high" ||
       delivery.notification_type === "encounter_cancelled_for_participant" ||
       delivery.notification_type === "open_encounter_request_cancelled_by_host";
     const effectiveUrgency: "high" | "normal" = isCritical ? "high" : "normal";
     ```
  2. **Payload neutral hacia el Service Worker:**
     - Crítico: `{ title: "PuntoEncuentro", body: "Tenés una nueva notificación", urgency: "high" }` (sin `tag`).
     - Normal: `{ title: "PuntoEncuentro", body: "Tenés una nueva notificación", tag: "pe-notification", urgency: "normal" }`.
  3. **Opciones Web Push:**
     ```typescript
     await webpush.sendNotification(pushSubscription, payload, {
       TTL: ttl,
       urgency: effectiveUrgency,
     });
     ```

### 2.3. Service Worker: `public/sw.js`
- **Archivo:** `public/sw.js`
- **Lógica de presentación implementada:**
  ```javascript
  const isCritical = data.urgency === 'high' || data.is_critical === true;
  const tag = isCritical ? undefined : (data.tag || 'pe-notification');

  const notificationOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {},
  };

  if (tag) {
    notificationOptions.tag = tag;
    notificationOptions.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(title, notificationOptions));
  ```
- **Por qué evita el reemplazo destructivo:**
  - Las alertas críticas se emiten con `tag: undefined` y sin `renotify`, generando entradas independientes que el navegador acumula visualmente en el panel del SO.
  - Las alertas no críticas utilizan `tag: 'pe-notification'` con `renotify: true`, colapsándose en su propio slot para evitar spam visual.
  - Un aviso informativo posterior actualiza su propio slot `pe-notification` y **jamás elimina ni sobrescribe** un aviso crítico anterior que no posea dicho tag.

### 2.4. Edge Function: `domain-events-worker`
- **Archivo:** `supabase/functions/domain-events-worker/index.ts`
- **Versión desplegada en Staging:** Versión 7 (actualizada exitosamente).
- **Handler incorporado:**
  ```typescript
  "encounter.participant.withdrawn.v1": async (_event, _adminClient) => {
    // La RPC reconfirmar_asistencia_seguro ya inserta directamente en
    // public.inbox_notifications de forma atómica. No duplicar Inbox ni Push.
    // Marcado exitoso para Transactional Outbox audit/replay.
  },
  ```

---

## 3. Estado Real de la Cola de Eventos de Dominio

### 3.1. Auditoría de Fallas Históricas en Staging (`domain_events_outbox`)
Antes de iniciar este sprint, la cola remota registraba:
- `encounter.join_request.reminder.v1`: **23 fallidos históricos** (ocurridos entre el 13/10 y 14/10 cuando la Edge Function remota no tenía el handler).
- `encounter.join_request.approved.v1`: **7 fallidos históricos** (ocurridos entre el 17/10 y 18/10).
- `encounter.participant.withdrawn.v1`: **2 fallidos históricos** (ocurridos el 18/10).
- Total de eventos con status `failed`: **32 filas históricas**.

### 3.2. Criterio de No-Reprocesamiento y Preservación
- Conforme a los requisitos estrictos de la Fase C, **no se ejecutó ningún reprocesamiento masivo** de estos 32 eventos históricos.
- Motivo de seguridad: Las funciones transaccionales de negocio (`procesar_recordatorio_solicitudes_pendientes`, `aprobar_solicitud_encuentro_abierto`, `reconfirmar_asistencia_seguro`) ya habían insertado directamente las filas en `inbox_notifications` en el momento de ocurrencia. Reprocesar históricamente estos eventos de dominio podría haber duplicado notificaciones o causado efectos secundarios indeseados.
- **Resultado post-despliegue:** La Edge Function `domain-events-worker` v7 en Staging procesará cualquier nuevo evento de retiro, recordatorio o aprobación con status `processed`, extinguiendo la generación de fallas `Unsupported event_type`. La cola conserva las 32 fallas históricas documentadas como evidencia de auditoría sin considerarse "falsamente saneada".

---

## 4. Evidencias de Seguridad y Verificación

### 4.1. Resumen de Compuertas de Calidad (Regression Gates)

| Compuerta | Comando Ejecutado | Resultado | Detalle |
| :--- | :--- | :--- | :--- |
| **Suite Focalizada P0** | `npx --workspaces=false tsx --test scripts/test-web-push-priority-and-integrity-p0.ts` | **PASS (7/7)** | Validaciones A a I completas (coexistencia, no reemplazo, urgencias high/normal, neutralidad payload, catálogo handlers). |
| **Suite Base Web Push** | `npx --workspaces=false tsx --test scripts/test-web-push-delivery.ts` | **PASS (34/34)** | Regresión cero en encolado, claim SKIP LOCKED, atomicidad, mitigación dispositivo compartido y sanitización. |
| **TypeScript estricto** | `npx --workspaces=false tsc -b` | **PASS (0 errores)** | Integridad estricta de tipos en todo el árbol del proyecto. |
| **Build de producción** | `npm --workspaces=false run build` | **PASS (código 0)** | Empaquetado de producción Vite/Rollup completado en 796ms. |
| **Migración Staging** | `npx --workspaces=false supabase db push` | **PASS** | `20261023183000_harden_web_push_claim_and_priority_v1.sql` aplicada en `wougfhfwqgmxhgvjqoua`. |
| **Deploy Functions** | `supabase functions deploy` | **PASS** | `web-push-worker` (v2) y `domain-events-worker` (v7) desplegadas activas. |
| **Verificación Remota** | Invocación RPC de prueba sobre Staging | **PASS** | `claim_web_push_deliveries_seguro` responde `{ ok: true, count: 0, deliveries: [] }`. |

### 4.2. Evidencias de Privacidad y Controles Adversariales
1. **Neutralidad de Payload:** Se verificó por tests automatizados que el string JSON despachado al servicio push no contiene `target_id`, `encounter_id`, `notification_id`, `user_id` ni `deep_link`. El título y cuerpo son invariablemente `"PuntoEncuentro"` y `"Tenés una nueva notificación"`.
2. **Navegación Neutral:** Al clickear una notificación Web Push, el Service Worker ejecuta `event.notification.close()` y navega a `/?notifications=1`, requiriendo sesión activa y pasando por los filtros RLS del backend.
3. **Aislamiento Multicuenta:** Se mantiene el pre-dispatch guard `verificar_delivery_activo_seguro`, impidiendo el despacho si el dispositivo fue reasignado mientras la entrega esperaba en outbox.
4. **Conservadurismo de Urgencia:** Cualquier tipo de notificación no crítico o desconocido recibe `urgency: "normal"`. Se prohíbe que el navegador o cliente eleve su propia prioridad.

---

## 5. Limitaciones Técnicas y Riesgos Remanentes

1. **Restricciones del Sistema Operativo:** `urgency: "high"` optimiza el despacho en la red de FCM/Mozilla y evita retardos por Doze mode, pero no garantiza que Android encienda la pantalla, ejecute sonidos personalizados o burle el modo "No Molestar" (DND), cuyas configuraciones dependen exclusivamente del usuario y de las categorías del navegador.
2. **Acumulación de Avisos Críticos:** Al omitir el `tag` en avisos críticos para evitar su reemplazo, si un usuario sufre múltiples cancelaciones o cambios sucesivos sin abrir la aplicación, cada uno generará una entrada separada en la bandeja del sistema operativo. Esto se considera el comportamiento correcto y deseable para evitar pérdida de comunicaciones críticas.
3. **Alcance Excluido:** Conforme a los límites del Mini-sprint P0, no se implementaron recordatorios de 24h/2h, acuse de recibo `acknowledged_at` ni canales alternativos de email/WhatsApp, los cuales permanecen agendados para los sprints P1 y P2.

---

## 6. Anexo de Cierre Técnico P0: Cambios de Logística y Robustez SQL

### 6.1. Prioridad de Modificaciones de Logística (`encounter_logistics_changed`)
- **Migración aditiva:** `supabase/migrations/20261023193000_harden_logistics_priority_and_claim_safety_v2.sql` aplicada en Supabase Staging (`wougfhfwqgmxhgvjqoua`).
- **Comportamiento en `actualizar_encuentro_seguro`:**
  - Cuando el anfitrión modifica la dirección física (`lugar_texto`) o el enlace virtual (`link_virtual`), se genera `encounter_logistics_changed` exclusivamente para participantes con estado `confirmado` o `asistio`.
  - Se añade `priority: 'critical'` en el payload server-side.
  - El cuerpo de la notificación Inbox permanece genérico y seguro: no expone la dirección física ni el link virtual, protegiendo las reglas de autorización y privacidad hasta que el participante ingresa a la aplicación.
  - Actualizaciones generales del encuentro (cambio de título, descripción pública, modalidad, etc.) **no** elevan la prioridad de forma indiscriminada.
  - Para solicitantes pendientes ante cambio de fecha/horario, se preserva `is_applicant: true` para que permanezcan en urgencia `normal`.

### 6.2. Robustecimiento de la Clasificación SQL en `claim_web_push_deliveries_seguro`
- **Problema corregido:** Se eliminó la dependencia del cast frágil `(payload->>'is_applicant')::boolean`, el cual arrojaba excepciones `invalid input syntax for type boolean` ante metadata inesperada o strings arbitrarios, abortando la transacción y bloqueando todo el lote de entregas pendientes.
- **Implementación resiliente:**
  ```sql
  v_is_critical := COALESCE(
      v_claimed_rows.notification_type IN (
          'encounter_cancelled_for_participant',
          'open_encounter_request_cancelled_by_host'
      )
      OR (
          v_claimed_rows.notification_type IN ('encounter_schedule_changed', 'encounter_logistics_changed')
          AND (
              COALESCE(v_claimed_rows.payload->>'is_applicant', '') NOT IN ('true', 't', '1', 'yes')
          )
      )
      OR (COALESCE(v_claimed_rows.payload->>'priority', '') = 'critical'),
      false
  );
  ```
- **Matriz de Casos Verificada por Suite Automatizada (10/10 PASS):**
  1. **Campo ausente (`NULL`):** No arroja error. Confirmados reciben `urgency: high`.
  2. **Booleano verdadero (`true` o `"true"`):** Solicitantes pendientes reciben `urgency: normal`.
  3. **Booleano falso (`false` o `"false"`):** Participantes confirmados reciben `urgency: high`.
  4. **Valor inesperado (string arbitrario, numérico u objeto anidado):** Se procesa de forma segura sin excepciones; no bloquea el procesamiento del lote.
  5. **Notificación desconocida:** Fail-safe conservador con `urgency: normal`.

### 6.3. Evidencias de Validación Posterior al Despliegue

| Requisito | Comportamiento Comprobado | Estado |
| :--- | :--- | :--- |
| **A. Cancelación** | Despacha `is_critical: true` y `urgency: high`. | **Verificado** |
| **B. Cambio fecha/hora confirmado** | Despacha `is_critical: true` y `urgency: high`. | **Verificado** |
| **C. Cambio logística confirmado** | Despacha `is_critical: true` y `urgency: high`. | **Verificado** |
| **D. Coincidencia informativa** | Despacha `is_critical: false` y `urgency: normal`. | **Verificado** |
| **E. Tipo desconocido** | Despacha `is_critical: false` y `urgency: normal`. | **Verificado** |
| **F. Sin reemplazo por tag idéntico** | Aviso crítico sin `tag` coexiste en panel; posterior con `pe-notification` no lo sobrescribe. | **Verificado** |
| **G. Neutralidad y navegación** | Payload invariante `{ title: "PuntoEncuentro", body: "Tenés una nueva notificación" }` y click a `/?notifications=1`. | **Verificado** |
| **H. Consistencia Staging** | Migración `20261023193000` aplicada en DB Staging (`wougfhfwqgmxhgvjqoua`). Funciones `web-push-worker` (v2) y `domain-events-worker` (v7) activas. | **Verificado** |
| **I. Eventos de dominio post-deploy** | Catálogo completo de 16 handlers activos. Las 32 fallas históricas de dominio no fueron tocadas ni reprocesadas. | **Verificado (Catálogo)** / **Pendiente (Tráfico orgánico)** |

### 6.4. Estado de Validación Física Android
- Conforme a los criterios de rigor y seguridad, la validación visual de recepción y coexistencia de notificaciones en dispositivo físico Android se mantiene **estrictamente pendiente para prueba manual de QA**, sin declararla aprobada por medios automatizados.

---

## 7. Corrección de Regresión UX Crítica Post-P0 y Verificación Live SW

### 7.1. Diagnóstico de la Regresión UX
Tras la migración `20261023193000_harden_logistics_priority_and_claim_safety_v2.sql`, los eventos `encounter_logistics_changed` dirigidos a participantes confirmados se emitieron correctamente con `priority: 'critical'`. Sin embargo, `src/components/notifications/CriticalCancellationModal.tsx` contenía una evaluación binaria ternaria:
```typescript
const isScheduleChange = notification.notification_type === 'encounter_schedule_changed';
const title = isScheduleChange ? 'Cambio de fecha u horario' : 'Encuentro cancelado';
```
Esto provocaba que cualquier cambio de logística (ubicación o enlace virtual) o cualquier otra notificación crítica no leída se presentara ante el usuario con el título alarmante **«Encuentro cancelado»**, e incluso renderizaba el recuadro de motivo de cancelación si el payload contenía una propiedad `reason`.

### 7.2. Corrección e Invariantes UX
Se refactorizó `CriticalCancellationModal.tsx` diferenciando explícitamente los tipos de notificación:
1. **Cancelación real (`isCancellation`):** `encounter_cancelled_for_participant` o `open_encounter_request_cancelled_by_host`. Título: «Encuentro cancelado» (`critical_modal.cancellation_title`). El bloque de motivo (`cancellation_reason`) se restringe estrictamente a `isCancellation && reason`.
2. **Reprogramación (`isScheduleChange`):** `encounter_schedule_changed`. Título: «Cambio de fecha u horario» (`critical_modal.schedule_title`).
3. **Modificación de logística (`isLogisticsChange`):** `encounter_logistics_changed`. Título: «Cambio de ubicación o acceso» (`critical_modal.logistics_title`).
4. **Otro aviso crítico reconocido (`isOtherCritical`):** Título neutral seguro «Aviso importante» (`critical_modal.generic_critical_title`).
5. **Avisos informativos / leídos:** No abren el modal (render vacío).
6. **Internacionalización completa:** Se incorporó el bloque de claves `critical_modal` en las 4 traducciones soportadas (`es.json`, `en.json`, `pt.json`, `pt-BR.json`).
7. **Acciones y sesión:** Se conservó la invocación a `marcarLeida(notification.id)` mediante el botón «Entendido», la navegación a los detalles del encuentro y la tolerancia a fallos de red.

### 7.3. Verificación de `public/sw.js` Servido en Vivo en Staging
Se ejecutó verificación HTTP real contra el endpoint público de Staging:
- **URL consultada:** `https://staging.puntoencuentro.com.ar/sw.js`
- **Autenticación Vercel Protection:** Bypass token vía header `x-vercel-protection-bypass`.
- **Respuesta:** HTTP 200 `application/javascript; charset=utf-8`.
- **Validación de contenido servido:**
  - `const isCritical = data.urgency === 'high' || data.is_critical === true;` → **PRESENTE**
  - `const tag = isCritical ? undefined : (data.tag || 'pe-notification');` → **PRESENTE**
- **Conclusión:** La versión con prevención de reemplazo visual y diferenciación de prioridad está efectivamente desplegada y servida en Staging.

### 7.4. Pruebas Automatizadas Anti-regresión
Se desarrolló y ejecutó la suite `scripts/test-critical-cancellation-modal-ux.tsx` (7/7 PASS):
- ✔ Caso 1: Cancelación real → «Encuentro cancelado» + motivo informado.
- ✔ Caso 2: Reprogramación de fecha/horario → «Cambio de fecha u horario» (NUNCA «Encuentro cancelado»).
- ✔ Caso 3: Modificación de logística → «Cambio de ubicación o acceso» (NUNCA «Encuentro cancelado»).
- ✔ Caso 4: Otro aviso crítico genérico → «Aviso importante» (NUNCA «Encuentro cancelado»).
- ✔ Caso 5: Aviso informativo → No abre modal (render vacío).
- ✔ Caso 6: Notificación leída (`isRead: true`) → No abre modal.
- ✔ Caso 7: Acción «Entendido» → Registra lectura mediante `marcarLeida`.

### 7.5. Estado de Pruebas Físicas
Se ratifica que la coexistencia visual de notificaciones críticas e informativas en dispositivo físico Android **permanece formalmente pendiente para validación manual de QA**, diferenciándola de la correcta apertura y diferenciación del modal crítico in-app.

---

## 8. Resultados de la Validación Física en Dispositivo Android (Staging)

### 8.1. Parámetros de la Corrida
- **Fecha y hora local:** 23 de octubre de 2026, 23:07 – 23:20 ART
- **Entorno:** Staging (`wougfhfwqgmxhgvjqoua` / `staging.puntoencuentro.com.ar`)
- **Encuentro de QA:** `8f488fce-4355-4052-b9ba-8d6bd8bd2255` (*QA Web Push Multiplataforma*)
- **Anfitrión A:** `cff4f76f-4e42-4954-ae81-4aafe0346e74` (`qa-push-guide-evaluator@puntoencuentro.test`)
- **Participante B:** `ae9716ae-8bae-485e-96d0-6d8d8269f0f9` (Leandro Vega)
- **Dispositivo de prueba:** Teléfono Android físico real con Chrome/PWA sobre Staging.

### 8.2. Matriz de Resultados Comprobados

| Dimensión Evaluada | Evidencia Técnica y Registro Empírico | Estado |
| :--- | :--- | :--- |
| **1. Entrega técnica por el proveedor (FCM)** | **Prueba A (Crítica):** FCM HTTP 201 Created a las `02:07:36Z` (`attempt_count: 1`, outbox `dc4ed90f-6940-4ef5-a37b-899abfc18308`).<br>**Prueba B (Informativa):** FCM HTTP 201 Created a las `02:08:46Z` (`attempt_count: 1`, outbox `dbfcde08-962d-4b27-ac66-5bec3bd9ca58`). | **COMPROBADO** |
| **2. Recepción física en Android** | El participante confirmó la recepción física en el teléfono Android en pantalla bloqueada tras el despacho del evento crítico. | **COMPROBADO** |
| **3. Coexistencia visual en panel nativo de Android** | Tras el despacho de B (`23:08:46`), a las `23:10` se observó una única tarjeta de notificación de PuntoEncuentro. Las capturas del teléfono no prueban por sí solas la coexistencia simultánea de dos tarjetas en el centro de notificaciones del SO (posible sustitución por Service Worker cliente residente sin refrescar o agrupamiento nativo compacto). | **PENDIENTE** |
| **4. Apertura y título correcto del modal crítico** | **Captura física Android (`23:16`):** Al ingresar a PuntoEncuentro, el modal crítico se despliega con el título exacto **«Cambio de ubicación o acceso»** (NUNCA «Encuentro cancelado»), sin cuadro de motivo de cancelación, con el título del encuentro *"QA Web Push Multiplataforma"* y texto explicativo neutral. Ambas notificaciones aparecen registradas en el Inbox in-app. | **COMPROBADO** |
| **5. Registro de lectura mediante «Entendido»** | Al presionar «Entendido», la base de datos de Staging registró formalmente la lectura: `inbox_notifications.read_at = '2026-10-24T02:16:42.378334+00:00'` para la notificación `4a23a123-2162-4280-a9ee-4e188ba64143`. El modal se cerró definitivamente sin reapariciones y el aviso en la bandeja pasó a estado leído (sin indicador azul), mientras que el aviso informativo posterior permaneció pendiente con su indicador azul activo. | **COMPROBADO** |

### 8.3. Dictamen Final del Mini-sprint P0
- **Blindaje UX de Notificaciones Críticas In-App:** **APROBADO Y VALIDADO EN DISPOSITIVO FÍSICO REAL**.
- **Backend, Migraciones SQL, RPCs y Edge Functions Staging:** **APROBADO Y OPERATIVO**.
- **Coexistencia visual en panel nativo de Android:** **PENDIENTE DE HOMOLOGACIÓN FÍSICA ESPECÍFICA**.

---

**Estado:** MINI-SPRINT P0 CERRADO — BLINDAJE CRÍTICO VALIDADO FÍSICAMENTE; COEXISTENCIA EN PANEL NATIVO PENDIENTE DE HOMOLOGACIÓN.
