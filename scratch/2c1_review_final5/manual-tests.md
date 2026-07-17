# Pruebas Manuales (Bloque 2C.1)

1. Funcionalidad
- Confirmado que la unión discriminada de resultados (ok/error) se aplica correctamente en TypeScript para las funciones de escritura.
- Confirmado que el checkbox "opción preferida" permanece deshabilitado (disabled) si no se ha respondido previamente con 'available' o 'maybe'.

2. Safe Area y Visuals
- Se trasladó el padding-bottom a la clase `coordination-guest-footer` sumando su propio padding base más `env(safe-area-inset-bottom)`.
- El requerimiento original respecto a `tema_invitacion` e `invitation_template` para identidad visual queda **EXPLÍCITAMENTE PENDIENTE** y diferido al Bloque 2C.2. El Bloque 2C.1 se considerará únicamente núcleo funcional de respuesta y edición de disponibilidad.

3. Validaciones
- Se aplican isFinite, isInteger, min(15), max(1440) al duration_minutes explícitamente en el parser.
- token_invitacion se valida con regex robusto.
- Se agregó mapeo explícito de rpc_error en el UI para mostrar "Ocurrió un error en el servidor. Por favor, intentá nuevamente".
- Las lecturas, escrituras, inputs de respuestas y fechas son validados con helpers puros de JS en `encuentrosService.ts` antes de ser devueltos en las funciones asíncronas RPC.
