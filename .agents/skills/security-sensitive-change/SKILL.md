---
name: security-sensitive-change
description: Flujo estructurado para implementar cambios críticos de seguridad (Auth, RLS, RPCs SECURITY DEFINER, identidad, Transfer Tickets, cuotas, tokens y secretos). Usar al modificar autenticación, permisos o lógica de protección de recursos.
---

# Procedimiento para Cambios Sensibles de Seguridad

Este protocolo previene vulnerabilidades de elevación de privilegios, suplantación de identidad (ID tampering), fugas de datos y condiciones de carrera en operaciones críticas.

## 1. Identificación de Invariantes de Seguridad
Antes de escribir código, definir expresamente:
1. **Identidad requerida:** ¿La acción admite usuario anónimo o exige cuenta permanente (`is_anonymous = false`)?
2. **Propiedad de recursos:** ¿El recurso pertenece a `auth.uid()`? Comprobar ownership en PostgreSQL, nunca en el cliente.
3. **Principio Fail-Closed:** Ante parámetros nulos, tablas inaccesibles o excepciones no controladas, denegar el acceso por defecto.

## 2. Pautas de Implementación Segura
- **RPCs:** Toda función `SECURITY DEFINER` debe incluir `SET search_path = ''` y calificar tablas como `public.<tabla>` y funciones internas con `pg_catalog.`.
- **Permisos de Ejecución:** Aplicar `REVOKE ALL` por defecto y conceder `GRANT EXECUTE` solo al rol legítimo. Funciones de liquidación interna deben reservarse a `service_role`.
- **Manejo de Errores:** No revelar UUIDs internos de otros usuarios ni detalles técnicos de base de datos en respuestas de error dirigidas a la interfaz.
- **Secretos:** Nunca almacenar credenciales, API keys secretas ni tokens en archivos rastreados por Git. Leer exclusivamente desde variables de entorno no versionadas (`.env.local`).

## 3. Pruebas Adversariales Obligatorias
Diseñar y ejecutar pruebas específicas que desafíen la implementación:
1. **Llamada anónima o no autenticada:** Verificar rechazo con código 401 / `authentication_required`.
2. **Suplantación de identidad (ID Tampering):** Enviar payload con ID de otro usuario; comprobar que PostgreSQL ignora el parámetro del cliente y valida contra `auth.uid()`.
3. **Concurrencia / Doble Canje:** Simular dos peticiones paralelas que compitan por el mismo cupo o recurso (ej. ticket o última cuota); verificar que el bloqueo serialice y solo una prospere.
4. **Reversión y Limpieza:** Comprobar que funciones auxiliares temporales de testing (ej. helpers `qa_%`) se creen dinámicamente y se eliminen al finalizar la prueba.

## 4. Auditoría Pre-Commit
Ejecutar una búsqueda en el diff antes de stagear para confirmar que no se hayan introducido literales de secretos:
```bash
git diff --staged | grep -i "service_role" || echo "Limpio"
```
