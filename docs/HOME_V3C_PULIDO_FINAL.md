# Informe Final de Pulido — Home V3-C Responsive (`/preview/home-v3c`)

## 1. Resumen ejecutivo

Se completó el mini-sprint final de pulido sobre **Home V3-C Responsive** (`/preview/home-v3c` en `staging`) conservando intactos el Hero dual-path, las animaciones GSAP, la identidad azul/teal, el dictado por voz y todas las funcionalidades de la Home. Los ajustes se acotaron exclusivamente a V3-C (`v3Variant === 'v3c'`), manteniendo sin cambios la Home predeterminada `/` (**V2 + GSAP**), las variantes de comparación `/preview/home-v3a` y `/preview/home-v3b`, el backup local `backup/home-v2-gsap-8048777` y Producción.

---

## 2. Problemas detectados

1. **Redundancia entre Hero y banda secundaria:** en V3-C, el Hero ya ofrece el acceso principal a `Tengo ganas de…`, por lo que la banda violeta secundaria (`HomeIntentionsBand`, *«Tengo ganas de… Decí qué te gustaría hacer, aunque todavía no sea un encuentro»*) repetía el llamado después de Discovery.
2. **Explicación inferior repetitiva y jerga de zonas/cupos:** el bloque inferior `HomeCreateOrOpenInfo` (*«Crear o abrir un encuentro»* y sus 3 pasos, incluido *«Abrí lugares en tus zonas si te falta gente»*) duplicaba lo explicado en el Hero y mantenía términos técnicos asociados a zonas geográficas.
3. **Estado vacío extenso de «Mis encuentros»:** en móvil, el bloque vacío ocupado por icono grande (`44px`), padding, descripción extensa y botón prominente creaba aire excesivo y competía visualmente con los CTAs del Hero.
4. **Riesgo de recorte de «Mi espacio» bajo el encabezado sticky:** `scrollToPersonalSection()` utilizaba `scrollIntoView({ block: 'start' })` sobre `.home-encounters-section` / `.pe-intenciones-section` (este último sin `scroll-margin-top`), mientras `#home-personal-activity-section` usaba `scroll-margin-top: calc(75px + env(safe-area-inset-top, 0px))` frente a un `.home-header` real de `~73px`, dejando margen mínimo.
5. **Visibilidad intermitente del FAB `+ Crear` al scrollear en móvil:** observar subelementos aislados generaba transiciones cuando los espacios entre tarjetas o encabezados superaban brevemente la franja de `72px`, sin reservar aire inferior consistente antes del pie en V3-C.
6. **Microcopy desktop-centric en el campo de intención:** la leyenda `Enter para enviar` debajo del textarea no resulta natural en teclados virtuales móviles.

---

## 3. Cambios implementados

### 3.1 Eliminación de banda secundaria redundante (exclusivo V3-C)
- En [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx), `HomeIntentionsBand` no se renderiza cuando `v3Variant === 'v3c'` (`isV2Variant && v3Variant !== 'v3c' && userSectionTab !== 'intenciones'`), manteniéndose intacta en V2 (`/`), V3-A y V3-B.
- **Análisis funcional por tipo de usuario:**
  - `HomeIntentionsBand` ejecutaba `handleOpenIntentionFlow`, que cambiaba a la pestaña `Mis ganas`, disparaba `intentionCreateTrigger` (abriendo `IntencionFormSheet` para guardar una intención con aviso de coincidencias) y scrolleaba hacia la sección personal.
  - **Visitante / Anónimo:** al guardar en `IntencionFormSheet`, `HomeIntencionesSection` solicita iniciar sesión con Google (`LoginRequiredSheet` con `action="create_intention"`). Desde la pestaña **Mi espacio → Mis ganas**, tanto el CTA del estado vacío (`.pe-intenciones-empty`) como el menú rápido (`QuickNavMenu` → *Mis ganas*) conservan ese mismo flujo completo, mientras que el Hero cubre la expresión libre inmediata (`Tengo ganas de…` → asistente `/create/ai`).
  - **Cuenta permanente:** accede directamente a sus intenciones guardadas, edición y creación desde **Mi espacio → Mis ganas** (y vía `QuickNavMenu` → *Mis ganas*) sin perder ninguna capacidad.

### 3.2 Simplificación del bloque inferior `HomeCreateOrOpenInfo` (exclusivo V3-C)
- En [HomeCreateOrOpenInfo.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.tsx) se incorporó la prop opcional `compactV3C?: boolean` (`false` por defecto, activada únicamente cuando `v3Variant === 'v3c'` en `Home.tsx`), estilizada en [HomeCreateOrOpenInfo.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.css).
- Se eliminó la tarjeta extensa repetitiva y se conservó únicamente en formato de nota discreta la información útil no detallada en el Hero (propuesta de múltiples fechas para votar y posibilidad de permitir solicitudes en un encuentro, contemplando encuentros presenciales o virtuales).

### 3.3 Estado vacío compacto de «Mis encuentros» (exclusivo V3-C)
- En [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) (`renderGsapContent`) y [Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css), cuando `v3Variant === 'v3c'` y `rawEncuentros.length === 0`, se aplica `.home-empty--v3c` y `.home-empty-cta--v3c`:
  - Icono reducido (`34px × 34px`, SVG de `20px`).
  - Menor padding vertical (`10px 12px 8px`), tipografía compacta legible y descripción directa sin jerga ambigua.
  - Botón secundario pill compacto `+ Crear encuentro` (`34px` de alto) que evita duplicar protagonismo con el CTA azul del Hero manteniendo acceso directo, tabs y filtros intactos.

### 3.4 Scroll programático, `scroll-margin-top` y FAB contextual `+ Crear`
- **Posicionamiento seguro bajo header sticky:**
  - `scrollToPersonalSection` en [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) pasó a apuntar de forma uniforme a `#home-personal-activity-section` (`personalActivityRef.current`) restando la altura medida de `.home-header` más `14px` de aire, evitando recortes bajo el header fijo.
  - En [Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css), `#home-personal-activity-section` y `#home-discovery-section` dentro de `.home-v3c-variant` recibieron `scroll-margin-top: calc(88px + env(safe-area-inset-top, 0px))` (conservando `75px` en V2/V3-A/V3-B).
- **Política de visibilidad del FAB `+ Crear` en V3-C (`< 768px`):**
  - El `IntersectionObserver` específico de V3-C observa `.home-dual-hero, #home-discovery-section, #home-personal-activity-section`.
  - **Se oculta** sin parpadeos mientras el usuario navega por Hero, `¿A qué me sumo?` (Discovery) y `Mi espacio` (`Mis encuentros`, `Mis ganas`, `Mis solicitudes` y sus estados vacíos), y siempre que haya un modal abierto o foco en el input móvil (teclado virtual).
  - **Reaparece** únicamente al llegar al cierre inferior de la página (bajo `.home-create-or-open-info--v3c-compact`), gracias a la reserva de espacio inferior `.home-v3c-variant { padding-bottom: calc(78px + env(safe-area-inset-bottom, 12px)); }`, evitando toda superposición con tarjetas, botones o texto.
  - En Desktop (`>= 768px`), el FAB permanece fijo en el gutter inferior derecho sin cambios.

### 3.5 Microcopy contextual del campo de intención en V3-C
- En [HomeDualPathHeroPreview.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.tsx) (exclusivo de `variant === 'v3c'`), `.home-v3c-intent-hint` reemplaza `"Enter para enviar"` por `"También podés dictarla"` cuando el navegador habilita dictado por voz (`isSpeechSupported`), `"Escribí tu idea"` en caso contrario, y `"Escuchando…"` durante la captura de audio.
- Se mantiene intacto `HomeIntentInput.tsx` (V2 y V3-A) y el envío con `Enter` en teclado físico (`handleTextareaKeyDown`).

---

## 4. Textos actualizados e inventario para evaluación futura

### Textos modificados en V3-C
| Superficie | Texto anterior | Texto nuevo (solo V3-C) |
|---|---|---|
| Hint input intención (`v3c`) | `Enter para enviar` | `También podés dictarla` (o `Escribí tu idea` si no hay API de voz / `Escuchando…` al dictar) |
| Bloque inferior (`HomeCreateOrOpenInfo`) | *Crear o abrir un encuentro* + 3 pasos (*Abrí lugares en tus zonas si te falta gente*) | *¿Todavía no definieron el día? Al crear una invitación podés proponer varias fechas para votar. Y si te falta gente, podés permitir que otras personas soliciten sumarse a tu encuentro.* |
| Estado vacío `Mis encuentros` (`v3c`) | *Creá uno nuevo para coordinar con otros o sumate a un plan abierto.* | *Cuando crees una invitación o confirmes un encuentro, aparecerá acá.* |

### Textos similares en otras pantallas (fuera de alcance — solo relevamiento)
No modificados para respetar el alcance acotado al mini-sprint V3-C:
- `src/components/home/HomeDualPathHeroPreview.tsx` (rama `v3b` preservada sin cambios: *«Idea o plan abierto»*, *«abrir lugares en tus zonas»*, *«abrí lugares»*).
- `src/components/auth/LoginRequiredSheet.tsx`: *«Seguir las ganas de hacer en tus zonas»*.
- `src/components/home/HomePillarsSection.tsx` y `src/screens/Home.tsx` (rutas V1/V2 no GSAP): *«Abrir lugares»*, *«Abrí lugares para que otras personas puedan sumarse a tu plan»*.
- `src/components/home/openEncounters/HomeOpenEncounters.tsx`: títulos/estados de filtro de zonas (*«En tus zonas»*, *«Encuentros en tus zonas»*, *«Buscando encuentros en tus zonas…»*).
- `src/components/host/HostOpenEncounterSection.tsx` y `src/components/host/OpenEncounterPublishModal.tsx` (textos de publicación de anfitrión: *«Abrí lugares para que otras personas puedan ver/descubrir tu plan y solicitar sumarse»*).
- `src/i18n/locales/es.json`: claves `create_or_open.*` y `open_encounters.publish_subtitle_*` / `open_encounters.empty_title`.

---

## 5. Componentes y archivos afectados

- [src/components/home/HomeDualPathHeroPreview.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.tsx)
- [src/components/home/HomeCreateOrOpenInfo.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.tsx)
- [src/components/home/HomeCreateOrOpenInfo.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.css)
- [src/screens/Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx)
- [src/screens/Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css)
- [scripts/test-home-integration.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-integration.ts)

*(Conservados intactos y excluidos del commit todos los cambios locales previos no relacionados: `AccountSheet.tsx`, `AnonymousCoordinationWarningSheet.tsx`, `InfoSheet.tsx`, línea de banner anónimo V1 en `Home.tsx` y archivos untracked preexistentes.)*

---

## 6. Comparación visual antes / después

| Aspecto | Antes (`c517993`) | Después (V3-C pulido) |
|---|---|---|
| Hint de intención móvil (`375×667`, `390×844`) | `Enter para enviar` | `También podés dictarla` (o `Escribí tu idea`) |
| Banda secundaria tras Discovery | Visible (`HomeIntentionsBand`) | Oculta solo en V3-C (`hasSecondaryBand: false`) |
| Bloque inferior tras `Mi espacio` | Card extensa *«Crear o abrir un encuentro»* | Nota compacta de 1 párrafo (`home-create-or-open-info--v3c-compact`) |
| Estado vacío `Mis encuentros` en móvil | Icono `44px`, copy extenso, CTA primario grande | Compacto (`195px` totales con `home-empty--v3c`), icono `34px`, pill secundario |
| Salto a `Mi espacio` desde `QuickNavMenu` | Dependía de `75px` / `scrollIntoView` sin offset unificado | `headerBottom: 73px`, `titleTop: 106px` (`33px` de aire libre) |
| FAB `+ Crear` en móvil | Visible en franjas intermedias | Oculto sobre Hero/Discovery/Mi espacio (`0` colisiones), visible únicamente al final bajo la nota compacta (`bottomInfoAboveFab: true`) |
| Capturas antes/después | `v3c_visitor_*.png` (`c517993`) | `v3c_polish_visitor_{375x667,390x844,768x1024,1024x768,1440x900}.png`, `v3c_polish_visitor_390x844_empty_miespacio.png`, `v3c_polish_visitor_390x844_bottom_fab.png`, `v3c_polish_permanent_390x844_miespacio.png`, `v3c_polish_permanent_1440x900.png` |

---

## 7. Resultado de pruebas

- `npm --workspaces=false run typecheck`: **exit 0**.
- `npx --workspaces=false eslint src/components/home/HomeDualPathHeroPreview.tsx src/components/home/HomeCreateOrOpenInfo.tsx src/App.tsx`: **exit 0**.
- `node scripts/run-tests.mjs ./scripts/test-home-integration.ts`: **80 / 80 tests aprobados** (`17` suites, `0` fallas, incluyendo Suite 16.F de regresión V3-C).
- `node scripts/run-tests.mjs ./scripts/test-quick-nav-menu.ts`: **9 / 9 tests aprobados** (`1` suite, `0` fallas).
- `node scripts/run-tests.mjs ./scripts/test-access-gate-pre-launch.ts`: **10 / 10 tests aprobados** (`5` suites, `0` fallas).
- **Playwright Dev (`vite dev`):**
  - 5 viewports (`375×667`, `390×844`, `768×1024`, `1024×768`, `1440×900`): `overflowX: 0`, columnas `1 / 1 / 1 / 2 / 2`, ambos CTAs dentro del primer viewport, dictado por voz operativo, `0` referencias prohibidas (`HomeIntentionsBand` ausente, bloque inferior compacto, `.home-empty--v3c` activo).
  - 3 perfiles verificados en V3-C: visitante, usuario anónimo simulado y usuario permanente local (`?previewAuth=permanent`).
  - Scroll continuo descendente, saltos rápidos y scroll inverso en `375×667` y `390×844`: header sticky siempre `top=0`, FAB oculto sobre secciones activas y reapareciendo debajo de la nota compacta al pie sin superposiciones.
  - Navegación desde `QuickNavMenu` a `Mis encuentros` y `Mis ganas`: título `Mi espacio` en `titleTop: 106px` debajo del header sticky (`headerBottom: 73px`).
- **Build + Playwright Staging (`VITE_APP_ENV=staging VITE_APP_URL=https://staging.puntoencuentro.com.ar`):**
  - **0** referencias a fixtures locales en `dist/assets/*.js`.
  - Regresión confirmada: `/`, `/preview/home-v3a` y `/preview/home-v3b` conservan `HomeIntentionsBand`, bloque inferior completo y estado vacío previo; `/preview/home-v3c` aplica el pulido completo; `?previewAuth=permanent` bloqueado.
- **Build + Playwright Producción simulado (`VITE_APP_ENV=production VITE_APP_URL=https://puntoencuentro.com.ar`):**
  - **0** referencias a fixtures locales en `dist/assets/*.js`.
  - `/preview/home-v3a`, `/preview/home-v3b` y `/preview/home-v3c` devuelven `Página no encontrada`; `?homePreview=v3c`, `?homeVariant=v3c` y `?previewAuth=permanent` ignorados.

---

## 8. Riesgos residuales

- **Vercel SSO delante del entorno remoto:** en Staging remoto (`https://staging.puntoencuentro.com.ar/preview/home-v3c`), el acceso externo sin sesión Vercel SSO autenticada recibe HTTP `302`; la validación visual remota sobre navegador físico iOS/Android queda supeditada a autenticación previa en Vercel SSO + `AccessGate`.
- **iOS Safari y teclado virtual físico real:** la compatibilidad de dictado nativo en teclados móviles (Gboard / Dictado iOS donde Web Speech API puede no estar expuesta y el hint muestra `"Escribí tu idea"`) y el comportamiento de viewport dinámico con teclado abierto en Safari iOS conviene validarlo manualmente en un dispositivo real.

---

## 9. Confirmación de protección de V2, V3-A y V3-B

- `/` continúa sirviendo **Home V2 + GSAP** sin modificaciones visuales ni funcionales.
- `/preview/home-v3a` y `/preview/home-v3b` mantienen sin alterar su diseño, banda secundaria, bloque inferior y microcopy.
- El backup original local `backup/home-v2-gsap-8048777` permanece intacto en `8048777e7362c1bb5d0ca9081683de11e135c709`.
- Producción (`main`) y la base de datos/permisos de Supabase permanecen sin cambios.

---

## 10. Commit base y publicación en Staging

- **Commit de referencia previo:** `c51799321055798f76faac009e4b5dc702305a35`.
- **URL de evaluación en Staging:** `https://staging.puntoencuentro.com.ar/preview/home-v3c` *(requiere Vercel SSO + `AccessGate`)*.
- El commit SHA definitivo y el estado de GitHub Actions / Vercel de esta publicación se reportan en el mensaje de cierre una vez ejecutado el `git push origin staging`.

---

## 11. Pendientes de QA manual

1. Abrir `https://staging.puntoencuentro.com.ar/preview/home-v3c` desde un celular real (iOS Safari y Android Chrome) tras autenticarse en Vercel SSO y `AccessGate`.
2. Verificar manualmente el comportamiento del teclado virtual sobre el textarea de `Tengo ganas de…`, el botón de micrófono / dictado nativo y el cambio entre `"Mis encuentros"`, `"Mis ganas"` y `"Mis solicitudes"`.
3. Confirmar en el dispositivo real la ausencia de parpadeos del FAB al hacer scroll rápido hasta el final de la página y al pulsar los accesos de `QuickNavMenu`.
4. Contrastar `/` vs `/preview/home-v3c` antes de autorizar el cambio de Home predeterminada en un paso posterior.

---

## Conclusión final

**¿Home V3-C está suficientemente pulida como para convertirse en la Home predeterminada de Staging para comenzar el QA funcional completo?**

**Sí.** Tras este mini-sprint, **Home V3-C** elimina las redundancias detectadas (`HomeIntentionsBand` secundaria y card extensa `Crear o abrir un encuentro`), reemplaza el lenguaje técnico ambiguo por indicaciones claras, compacta el estado vacío móvil de `Mis encuentros`, unifica el desplazamiento seguro bajo el header sticky (`Mi espacio`), evita colisiones/parpadeos del FAB `+ Crear` en móvil y adapta el microcopy del campo de intención tanto a teclados virtuales como a dictado por voz, superando todas las compuertas técnicas y de regresión sin afectar V2, V3-A ni V3-B. La Home predeterminada `/` **no se ha cambiado todavía** y permanece a la espera de su aprobación tras revisar la preview publicada en Staging.
