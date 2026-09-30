# Playbook Operativo de Moderación — Soft Launch (P0)

Este documento define el procedimiento operativo seguro y auditable para la revisión y resolución manual de reportes de moderación en **PuntoEncuentro** durante el Soft Launch.

---

## 1. Alcance y Principios
- **Operación manual:** Durante el Soft Launch no existe backoffice web automatizado; la moderación se realiza desde el **Table Editor / SQL Editor de Supabase** con credenciales administrativas por personal autorizado.
- **Minimización de datos:** El operador debe acceder únicamente al contexto indispensable para evaluar el reporte.
- **Aislamiento y privacidad:** Ni el reportante ni el reportado reciben notificaciones sobre el curso administrativo de la denuncia ni conocen la identidad cruzada.
- **Sin automatización punitiva:** Ningún estado de moderación dispara suspensiones, bloqueos o sanciones automáticas en esta fase.

---

## 2. Cola de Reportes Pendientes (Revisión)
Para visualizar los reportes pendientes ordenados por antigüedad, ejecutar en el SQL Editor (o filtrar por `estado = 'pending'` en Table Editor):

```sql
SELECT
  id,
  created_at,
  contexto,
  motivo,
  detalle,
  estado,
  solicitud_id,
  encuentro_id
FROM public.reportes_encuentro
WHERE estado = 'pending'
ORDER BY created_at ASC;
```

---

## 3. Semántica de Estados en P0

| Estado | Significado Operativo | Metadatos Requeridos |
| :--- | :--- | :--- |
| **`pending`** | Reporte ingresado, todavía no examinado por ningún operador. | `reviewed_at = NULL`, `reviewed_by = NULL`, `resolved_at = NULL`, `resolved_by = NULL` |
| **`reviewed`** | El reporte está bajo evaluación por un operador. No existe resolución definitiva todavía. | `reviewed_at IS NOT NULL`, `reviewed_by IS NOT NULL`, `resolved_at = NULL`, `resolved_by = NULL` |
| **`dismissed`** | Reporte desestimado (duplicado, falta de mérito, desacuerdo ordinario o sin acción necesaria). | `reviewed_at`, `reviewed_by`, `resolved_at`, `resolved_by` todos completados |
| **`actioned`** | Reporte resuelto habiéndose tomado alguna acción operativa (contacto preventivo, preservación o escalamiento). | `reviewed_at`, `reviewed_by`, `resolved_at`, `resolved_by` todos completados |

> [!IMPORTANT]
> **Qué significa `actioned` en P0:** Indica exclusivamente que el equipo intervino operativamente el caso y dejó constancia interna. **NO significa** baneo automático, strike punitivo ni afirmación de culpabilidad judicial.

---

## 4. Flujo de Trabajo Recomendado

### Flujo Estándar (Casos que requieren seguimiento):
1. **Tomar reporte:**
   Cambiar `estado = 'reviewed'`, completando `reviewed_at = now()` y `reviewed_by = <UUID_DEL_OPERADOR>`.
2. **Examinar contexto mínimo:**
   Revisar el detalle, motivo y encuentro asociado.
3. **Cerrar resolución:**
   Cambiar a `estado = 'dismissed'` o `estado = 'actioned'`, completando `resolved_at = now()`, `resolved_by = <UUID_DEL_OPERADOR>` y agregando una nota interna en `resolution_note`.

### Transición Directa (Casos claros o de bajo volumen):
Es válido pasar directamente de `pending` a `dismissed` o `actioned` completando simultáneamente:
- `reviewed_at = now()`
- `reviewed_by = <UUID_DEL_OPERADOR>`
- `resolved_at = now()`
- `resolved_by = <UUID_DEL_OPERADOR>`
- `resolution_note = '<nota justificativa>'`

---

## 5. Datos que el Operador DEBE y NO DEBE Consultar

### Contexto Mínimo Suficiente:
- **Encuentro:** Título, fecha, hora, modalidad, zona pública aproximada (`open_public_zone`).
- **Solicitud:** Nombre público del solicitante, mensaje enviado, estado de la solicitud.
- **Reporte:** Contexto (`pre_solicitud` o `post_encuentro`), motivo y detalle escrito por el reportante.

### Datos Protegidos (NO consultar salvo causa mayor justificada):
- **NO consultar:** Tokens de invitación personales (`token_invitacion`).
- **NO consultar:** Enlaces privados de reunión virtual (`link_virtual`).
- **NO consultar:** Emails personales, teléfonos o credenciales de autenticación.
- **NO consultar:** Direcciones exactas domiciliarias.

---

## 6. Identidad del Operador (`reviewed_by` / `resolved_by`)
- Debe usarse el `UUID` real de la cuenta de `auth.users` del operador que realiza la acción en Supabase.
- **PROHIBIDO:** Usar UUIDs inventados, placeholders (`00000000-...`), o los UUIDs del reportante (`reporter_id`) o reportado (`reported_id`).
- La foreign key `ON DELETE RESTRICT` asegura que la trazabilidad de quién moderó no pueda destruirse.

---

## 7. Diferencia entre Bloqueo y Reporte
- **Bloqueo (T3):** Acción unilateral y privada de los usuarios para no verse ni enviarse solicitudes. Es silencioso y no pasa por moderación.
- **Reporte (T2 / T4):** Denuncia formal enviada al equipo de moderación por incidentes de seguridad, spam o conducta inapropiada. Bloquear a alguien no envía un reporte, y reportar no bloquea automáticamente.

---

## 8. Criterios de Resolución

### Criterios para `dismissed`:
- Reportes duplicados entre los mismos usuarios sobre el mismo hecho.
- Diferencias de opinión o cancelaciones de asistencia normales que no configuran conducta inapropiada.
- Detalle vacío o inverosímil que no permite determinar ningún riesgo.

### Criterios para `actioned`:
- Se contactó internamente por canales autorizados a una de las partes para solicitar aclaraciones.
- Se documentó un incidente grave para seguimiento administrativo.
- Se escaló el caso a los fundadores o equipo legal.

---

## 9. Escalamiento de Seguridad (`motivo = 'safety_concern'`)
- Los reportes con `motivo = 'safety_concern'` tienen **prioridad alta de revisión**.
- Si un reporte describe una situación de riesgo físico inminente o delito, requiere **evaluación humana inmediata** fuera de los sistemas de la plataforma.
- No asumir acciones judiciales automáticas en la base de datos; seguir el protocolo legal de emergencia de PuntoEncuentro.
