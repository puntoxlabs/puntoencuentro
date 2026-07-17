
## Pruebas Humanas Pendientes

Las siguientes pruebas no pueden ser automatizadas o certificadas 100% mediante scripts, por lo que requerirán revisión humana honesta antes de habilitar el feature flag productivo:

- [ ] Validar flujos en mobile (distintos anchos de pantalla) para asegurar que los nuevos botones de disponibilidad no desborden la tarjeta.
- [ ] Con la pestaña Network, verificar que con el flag apagado NO se realizan consultas adicionales al cargar la app normal, validando aislamiento real.
- [ ] Verificar comportamientos de concurrencia: realizar 'doble click' muy rápido en 'Guardar Cambios' para validar visualmente que el estado disabled actua inmediatamente.
- [ ] Enviar respuestas exitosamente y hacer refresh (F5), validando que las opciones preferidas y demás se pinten tal cual (persistencia en backend confirmada, pero validar binding en UI).
- [ ] Validar colores y disabled en estados closed/deadline visualmente, confirmando que la lectura es cómoda.
- [ ] Confirmar de principio a fin el flujo 'fixed' habitual (invitaciones individuales tradicionales) para certificar regresión cero.

