# Pruebas Manuales (Bloque 2C.1)

1. Funcionalidad
- Confirmado que la unión discriminada de resultados (ok/error) se aplica correctamente en TypeScript para las funciones de escritura.
- Confirmado que el checkbox "opción preferida" permanece deshabilitado (disabled) si no se ha respondido previamente con 'available' o 'maybe'.

2. Safe Area y Visuals
- Se trasladó el padding-bottom a la clase `coordination-guest-footer` sumando su propio padding base más `env(safe-area-inset-bottom)`.
- El requerimiento original respecto a `tema_invitacion` e `invitation_template` para identidad visual queda **EXPLÍCITAMENTE PENDIENTE** y diferido para no acoplar lógicas complejas ni duplicar lógicas de configuración de la pantalla fixed. Queda registrado como fuera del alcance actual pero requerido en el futuro.

3. Validaciones
- Se aplican isFinite, isInteger, min(15), max(1440) al duration_minutes.
- token_invitacion se espera correcto para UUID y la base de datos lo validará si corresponde.
- Se agregó mapeo explícito de rpc_error en el UI para mostrar "Ocurrió un error en el servidor. Por favor, intentá nuevamente" y evitar decir que la invitación no es válida cuando el link sí era válido pero falló internamente.
