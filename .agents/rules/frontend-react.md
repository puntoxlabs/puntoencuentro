---
trigger: glob
globs:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "src/**/*.css"
description: Reglas para componentes React, servicios, Zustand stores y UI de PuntoEncuentro.
---

# Desarrollo Frontend (React / TypeScript)

## 1. Reutilización y Arquitectura
- Reutilizar componentes existentes (`@/components/ui/`), servicios (`@/services/`) y stores (`@/store/`) antes de crear nuevas abstracciones.
- Centralizar capacidades y planes en hooks dedicados (ej. `useEntitlements()`, `useAuth()`). Evitar dispersar comprobaciones como `plan === 'premium'` en componentes visuales; consultar capacidades semánticas (`canUseAiCreation`, etc.).

## 2. Tipado y Calidad de Código
- TypeScript estricto en modo comprobación completa (`tsc -b`).
- Evitar `any` no justificado; tipar DTOs, payloads de RPC y estados de UI.
- No introducir estado global superfluo si el ciclo de vida pertenece al componente o a un Context existente.

## 3. Principio Mobile-First y UX
- Diseñar y validar primero para dispositivos móviles (360px a 430px) y adaptar progresivamente a desktop.
- Preservar la experiencia existente salvo solicitud explícita del usuario.
- **Fallback amigable:** Cuando una funcionalidad guiada por IA o servicio externo no esté disponible o alcance su límite, ofrecer siempre un camino alternativo funcional (ej. creación manual en `/create`).

## 4. Internacionalización (i18n)
- Todo texto visible al usuario final debe integrarse en el catálogo de internacionalización (`src/i18n/`).
- Mantener consistencia entre los tres idiomas soportados: español (`es.json`), inglés (`en.json`) y portugués de Brasil (`pt-BR.json`).
