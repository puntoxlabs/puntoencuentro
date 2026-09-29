---
trigger: always_on
description: Reglas críticas de seguridad de entorno, protección de producción y manejo de credenciales.
---

# Seguridad de Entornos y Credenciales

## 1. Topología de Entornos
- **Staging (`wougfhfwqgmxhgvjqoua`):** Destino obligatorio para desarrollo remoto, pruebas funcionales, migraciones y QA. Subdominio: `staging.puntoencuentro.com.ar`.
- **Producción (`aurbicjwftjhwryhyjiq`):** Base de datos y entorno real (`puntoencuentro.com.ar`). **Prohibida cualquier operación remota o migración** sin instrucción explícita.
- **Local:** `localhost:5173`. Pruebas unitarias ejecutan en motor PGlite en memoria sin dependencia de red.

## 2. Manejo de Secretos y API Keys
- **Frontend / Cliente:** Utilizar `VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`).
- **Tooling Administrativo QA:** Utilizar `SUPABASE_STAGING_SECRET_KEY` (`sb_secret_...`) leída desde el entorno o `.env.local` (ignorado por Git).
- **Credenciales Legacy:** La clave `service_role` legacy de Staging está desactivada y considerada comprometida. No reintroducirla ni referenciarla en código versionado.
- **Cero fugas:** Nunca imprimir tokens, JWTs ni variables de entorno sensibles en terminales, mensajes o informes.

## 3. Guards de Ejecución
- Todo script con efectos secundarios en Supabase debe invocar `assertStagingEnvironment()` antes de cualquier operación.
- Si falta una variable requerida, el sistema debe fallar cerrado (`fail-closed`) abortando de inmediato.
