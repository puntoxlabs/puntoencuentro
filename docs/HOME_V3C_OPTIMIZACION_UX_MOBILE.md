# Optimización UX Final Mobile-First — Home V3-C (`/preview/home-v3c`)

## 1. Diagnóstico UX inicial sobre capturas móviles reales

Al inspeccionar las capturas reales del estado base ([cc0786c](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/docs/HOME_V3C_PULIDO_FINAL.md)) en resoluciones móviles (`360×640`, `375×667`, `390×844` y `430×932`), la propuesta funcional de V3-C resultaba sólida, pero su parte superior presentaba una densidad visual y cognitiva excesiva en pantallas pequeñas:

1. **Redundancia en Camino 1 (`Organizá con tu gente`):** coexistían la badge superior `Invitación privada`, una fila de 4 pills (`🎂 Cumpleaños`, `🍽️ Asado / cena`, `⚽ Partido`, `☕ Salida`) y una descripción que repetía exactamente esos cuatro ejemplos (*«Cumpleaños, cenas, reuniones o salidas…»*).
2. **Carga textual en Camino 2 (`Tengo ganas de…`):** la tarjeta sumaba badge superior (`De una idea a un encuentro`), descripción de dos líneas, textarea, barra de dictado, botón y una nota secundaria al pie de dos líneas sobre permitir solicitudes.
3. **Competencia con elementos decorativos arriba y abajo del Hero móvil:**
   - Arriba convivían dos fragmentos fotográficos (`Asado` y `Mates`), una etiqueta animada (`🍕 Noche de pizzas`) y la cápsula en mayúsculas `PLANES · PERSONAS · ENCUENTROS REALES`.
   - Debajo del segundo CTA, las 6 sugerencias (`HomeSuggestionChips`) envolvían en **3 a 4 filas verticales** (`114px–152px`), seguidas por otra etiqueta móvil GSAP en la Zona C (`🎂 Festejar un cumple`).
4. **Consecuencia sobre el primer viewport:** en `360×640`, `375×667` y `390×844`, el Hero completo medía `763px–801px` y empujaba la sección `¿A qué me sumo?` hasta `y = 864px–902px`, ocultándola por completo bajo el primer pliegue.
5. **Falta de orientación en secciones inferiores:** las cabeceras de `¿A qué me sumo?` y `Mi espacio` dependían únicamente de sus títulos y controles sin una frase breve de contexto para visitantes primerizos.

---

## 2. Cambios aplicados en el Hero móvil de V3-C

Todas las simplificaciones visuales del Hero se acotaron exclusivamente a **Home V3-C** y, en lo estructural de densidad, al breakpoint móvil (`@media (max-width: 639px)`), preservando intacto el layout de dos columnas de Desktop (`>= 960px`) y la composición Tablet (`640px–959px`):

1. **Limpieza de ruido en Camino 1 (`< 640px`):**
   - Ocultación en móvil de `.home-v3c-card__top` (suprime en `< 640px` la badge `Invitación privada` y las 4 pills repetitivas `.home-v3c-examples`, manteniendo su renderizado completo en tablet y desktop).
   - Unificación de ejemplos dentro de la descripción breve y directa.
   - Compactación vertical de padding y tipografía de `.home-v3c-card`.
2. **Limpieza de ruido en Camino 2 (`< 640px`):**
   - Ocultación en móvil de la badge superior (`De una idea a un encuentro`) y de `.home-v3c-card__subnote` (cuya información operativa ya vive en el flujo de creación y en la nota discreta al pie de la página).
   - Recorte del párrafo introductorio a una línea en resoluciones `>= 375px` y ajuste del placeholder a un ejemplo corto (`Ej. jugar al pádel este sábado…`).
3. **Chips de sugerencia en fila horizontal única (`< 640px`):**
   - `.home-dual-hero--v3c .home-suggestions-list` pasa en `< 640px` a `flex-wrap: nowrap; overflow-x: auto; justify-content: flex-start; scrollbar-width: none;`, con chips `flex-shrink: 0; white-space: nowrap; min-height: 32px;`.
   - Reduce el bloque de chips de `114px–152px` (`3–4` filas) a **`34px` (`1` fila)** sin perder ninguna sugerencia ni su funcionalidad.
4. **Encabezado del Hero sin doble pastilla (`< 640px`):**
   - Se oculta `.home-dual-hero--v3c .home-dual-hero__eyebrow` en `< 640px`, dejando que la cornisa GSAP superior converse directamente con `¿Qué querés hacer?`.

Archivos modificados para el Hero:
- [src/components/home/HomeDualPathHeroPreview.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.tsx) (solo rama `variant === 'v3c'`)
- [src/components/home/HomeDualPathHeroPreview.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.css)
- [src/screens/Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css)

---

## 3. Decisiones tomadas sobre GSAP en móvil

- **Conservación del ADN GSAP y Desktop intacto:** no se eliminó GSAP ni se alteraron las animaciones, viñetas o tags flotantes de Desktop (`>= 1024px`) ni de Home V2 / V3-A / V3-B.
- **Contención selectiva en móvil V3-C (`< 640px`, `.home-hero-wrapper--v3c`):**
  - Se redujeron las viñetas fotográficas superiores (`width: 72px; height: 48px; top: 6px; opacity: 0.88;` CSS / `74×52` px medidos con borde) y el tamaño de los tags superiores (`font-size: 0.72rem; padding: 3px 9px;`), reduciendo el `padding-top` del wrapper de `4.35rem` (`70px`) a `3.5rem` (`56px`).
  - Se ocultó el carril inferior móvil de tags animados GSAP (`#gt-cumple`, `#gt-padel`, `#gt-mates`, `#gt-cafe`) debajo de la fila de chips y se redujo el `padding-bottom` del Hero de `2.85rem` (`46px`) a `0.5rem` (`8px`). De este modo ninguna píldora en movimiento queda flotando entre las sugerencias y el encabezado `¿A qué me sumo?`.
  - Se verificó compatibilidad con `prefers-reduced-motion: reduce`, manteniendo layout estático y `horizontalOverflow = 0`.

---

## 4. Textos finales aplicados en el Hero y en las secciones

### Hero V3-C (`HomeDualPathHeroPreview.tsx`, `variant === 'v3c'`)

| Elemento | Texto anterior (`cc0786c`) | Texto final | Alcance |
|---|---|---|---|
| Título general | `¿Qué querés hacer?` | `¿Qué querés hacer?` | V3-C (Mobile & Desktop) |
| Subtítulo general | `Organizá algo con tu gente o encontrá con quién compartir un plan.` | `Organizá algo con tu gente o encontrá con quién compartir un plan.` | V3-C (Mobile & Desktop) |
| Camino 1 — Título | `Organizá con tu gente` | `Organizá con tu gente` | V3-C (Mobile & Desktop) |
| Camino 1 — Descripción | `Cumpleaños, cenas, reuniones o salidas. Creá una invitación y compartila con quienes quieras.` | `Creá invitaciones para cumpleaños, reuniones, cenas y salidas.` | V3-C (Mobile & Desktop) |
| Camino 1 — CTA | `Crear una invitación` | `Crear una invitación` | V3-C (Mobile & Desktop) |
| Camino 1 — Garantía | `Tus invitados pueden confirmar sin registrarse.` | `Tus invitados confirman sin registrarse.` | V3-C (Mobile & Desktop) |
| Camino 2 — Título | `Tengo ganas de…` | `Tengo ganas de…` | V3-C (Mobile & Desktop) |
| Camino 2 — Descripción | `Contanos qué te gustaría hacer y te ayudamos a convertirlo en un encuentro.` | `Contanos tu idea y te ayudamos a organizarla.` | V3-C (Mobile & Desktop) |
| Camino 2 — Placeholder | `ej. jugar al pádel este sábado a las 18` | `Ej. jugar al pádel este sábado…` | V3-C (Mobile & Desktop) |
| Camino 2 — CTA | `Hagamos que pase` | `Hagamos que pase` | V3-C (Mobile & Desktop) |

### Micro-explicaciones breves de sección (exclusivo V3-C)

- Debajo de **«¿A qué me sumo?»** ([HomeOpenEncounters.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeOpenEncounters.tsx), prop `sectionSubtitle` pasada desde [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) únicamente cuando `v3Variant === 'v3c'`):
  > `Descubrí encuentros de otras personas y solicitá sumarte a los que te interesen.`
  - Se eligió «solicitá sumarte» para respetar con precisión el funcionamiento real del producto (el ingreso a un encuentro abierto requiere solicitud y aceptación del anfitrión).
  - En tablet/desktop (`>= 540px`), `.pe-discovery-heading-col` apila este texto inmediatamente debajo de `¿A qué me sumo?` mientras mantiene alineadas a la derecha las acciones de filtrado (`Solo con lugares disponibles`, `Avisame`, `Ver en lista >`).
- Debajo de **«Mi espacio»** ([Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx), renderizada únicamente cuando `v3Variant === 'v3c'` antes de las pestañas):
  > `Tus encuentros, tus ganas y tus solicitudes, todo en un lugar.`
- Estilo sobrio en [HomeOpenEncounters.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeOpenEncounters.css) y [Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css): tipografía secundaria `0.8125rem` (`font-weight: 450`), contraste accesible (`var(--color-on-surface-variant, #475569)`), sin fondos de color, sin bordes, sin iconos adicionales ni animaciones.

---

## 5. Evaluación de la funcionalidad «Mis ganas» y su descubribilidad

Tras las simplificaciones realizadas entre los mini-sprints de V3-C (`HomeIntentionsBand` ocultada en V3-C y simplificación móvil del Hero), la relación entre el Hero y `Mis ganas` queda estructurada así:

1. **Dos mecanismos complementarios pero con puntos de entrada distintos:**
   - **Camino 2 del Hero (`Tengo ganas de…` + `Hagamos que pase`):** toma el texto libre o dictado por voz e inicia el flujo asistido `/create/ai` (`startNewWithPrompt`) para transformar inmediatamente la idea en un encuentro concreto (privado o permitiendo solicitudes abiertas).
   - **Pestaña `Mis espacio → Mis ganas` (`HomeIntencionesSection` + `IntencionFormSheet`):** permite **registrar y mantener viva una intención** sin crear todavía un encuentro ni elegir fecha cerrada, para recibir avisos/coincidencias de otras personas en sus zonas (`Mis ganas`), accesible también desde el menú principal (`QuickNavMenu → Mis ganas`).
2. **Evaluación de descubribilidad actual en V3-C:**
   - **Aspecto positivo:** la nueva micro-explicación bajo `Mi espacio` (*«Tus encuentros, tus ganas y tus solicitudes, todo en un lugar.»*) y la presencia explícita de la pestaña `Mis ganas` junto a `Mis encuentros` y `Mis solicitudes` aclaran al usuario qué vive en esa sección sin duplicar tarjetas llamativas ni generar ruido visual en el primer viewport.
   - **Observación para seguimiento futuro de producto:** para un visitante nuevo que todavía no interactuó con `Mi espacio`, el uso de `Tengo ganas de…` en el Hero lleva directamente a crear el plan con el asistente, mientras que la persistencia de una intención ligera (sin crear evento aún) se descubre principalmente al explorar la pestaña `Mis ganas` en `Mi espacio`, el menú rápido o la solapa homónima en Discovery. Se decidió **no** reintroducir una banda secundaria ni enlaces extra en el Hero móvil para no deshacer la simplificación cognitiva lograda en este sprint, dejando registrado como hallazgo evaluable en pruebas de usabilidad si conviene ofrecer dentro del paso 1 de `/create/ai` una opción ligera del tipo *«Solo dejar mis ganas publicadas sin armar fecha todavía»*.

---

## 6. Comparativa antes vs. después con mediciones objetivas en los 7 viewports

Mediciones capturadas en `/preview/home-v3c` con Playwright sobre el estado base (`cc0786c`, fase `before`) vs. estado optimizado (`after`), sin errores de consola y con `horizontalOverflow = 0` en todos los viewports:

| Viewport | Altura Hero (Antes → Después) | Card 1 / Card 2 (Antes → Después) | CTA 1 Bottom (Antes → Después) | CTA 2 Bottom (Antes → Después) | Chips Altura / Filas (Antes → Después) | Discovery `top` (Antes → Después) | Badges / Pills / Tags en 1° Viewport (Antes → Después) | Bloques Medidos en 1° Viewport (Antes → Después) |
|---|---|---|---|---|---|---|---|---|
| `360×640` | `801px` → **`479px`** (`-322px`) | `179 / 248px` → **`128 / 179px`** | `387px` → **`293px`** | `631px` → **`496px`** | `152px` (4 filas) → **`34px` (1 fila)** | `902px` → **`563px`** (visible) | `8` → **`1`** | `21` → **`21`** *(entran chips + `¿A qué me sumo?`)* |
| `375×667` | `763px` → **`479px`** (`-284px`) | `179 / 248px` → **`128 / 179px`** | `387px` → **`293px`** | `631px` → **`496px`** | `114px` (3 filas) → **`34px` (1 fila)** | `864px` → **`563px`** (visible) | `8` → **`1`** | `22` → **`21`** |
| `390×844` | `763px` → **`479px`** (`-284px`) | `179 / 248px` → **`128 / 179px`** | `387px` → **`293px`** | `631px` → **`496px`** | `114px` (3 filas) → **`34px` (1 fila)** | `864px` → **`563px`** (visible) | `9` → **`1`** | `29` → **`21`** |
| `430×932` | `763px` → **`464px`** (`-299px`) | `179 / 248px` → **`113 / 179px`** | `387px` → **`278px`** | `631px` → **`481px`** | `114px` (3 filas) → **`34px` (1 fila)** | `864px` → **`548px`** (visible) | `9` → **`1`** | `30` → **`21`** |
| `768×1024` | `799px` → `799px` | `156 / 292px` → `156 / 292px` | `371px` → `371px` | `690px` → `690px` | `88px` (2 filas) → `88px` (2 filas) | `912px` → `912px` | `7` → `7` | `28` → `28` |
| `1024×768` | `628px` → `609px` (`-19px`) | `340 / 340px` → `321 / 321px` | `527px` → `508px` | `516px` → `497px` | `88px` (2 filas) → `88px` (2 filas) | `747px` → `728px` | `7` → `7` | `25` → `26` |
| `1440×900` | `628px` → `609px` (`-19px`) | `340 / 340px` → `321 / 321px` | `526px` → `507px` | `515px` → `496px` | `88px` (2 filas) → `88px` (2 filas) | `753px` → `734px` | `11` → `11` | `30` → `30` |

**Validaciones adicionales en Playwright:**
- `prefers-reduced-motion: reduce` (`390×844`): Hero `479px`, Discovery visible en primer viewport (`563px`), `horizontalOverflow: 0`, etiquetas estáticas sin solapamiento.
- Usuario permanente (`?previewAuth=permanent` en dev local `390×844` y `1440×900`): `Mi espacio` posicionado a `top: 579px` en móvil con micro-explicación visible y navegación verificada sobre la pestaña `Mis ganas`.

---

## 7. Capturas generadas en los distintos viewports

Todas las capturas y reportes JSON quedaron almacenados en el directorio de artefactos de la sesión (`C:\Users\Minar\.gemini\antigravity\brain\06e8bf7c-7ce8-403a-8f0e-e08dede8fa07\`):

- **Baseline («antes»):** `v3c_before_360x640.png`, `v3c_before_375x667.png`, `v3c_before_390x844.png`, `v3c_before_430x932.png`, `v3c_before_768x1024.png`, `v3c_before_1024x768.png`, `v3c_before_1440x900.png`.
- **Optimizado («después»):** `v3c_after_360x640.png`, `v3c_after_375x667.png`, `v3c_after_390x844.png`, `v3c_after_430x932.png`, `v3c_after_768x1024.png`, `v3c_after_1024x768.png`, `v3c_after_1440x900.png`.
- **Secciones inferiores y usuario permanente:** `v3c_after_390x844_discovery.png`, `v3c_after_390x844_miespacio.png`, `v3c_after_permanent_390x844.png`, `v3c_after_1440x900_discovery.png`, `v3c_after_1440x900_miespacio.png`, `v3c_after_permanent_1440x900.png`.
- **Reportes JSON:** `playwright-v3c-mobile-ux-before.json` y `playwright-v3c-mobile-ux-after.json`.

---

## 8. Resultados de tests, builds y validaciones

| Validación | Resultado | Detalle |
|---|---|---|
| TypeScript (`tsc -b`) | **OK (exit 0)** | 0 errores en todo el proyecto tras las ediciones finales. |
| ESLint focalizado (`HomeDualPathHeroPreview.tsx`) | **OK (exit 0)** | 0 errores y 0 advertencias. *(En `Home.tsx`, `HomeOpenEncounters.tsx` y `test-home-integration.ts` subsisten errores preexistentes `no-explicit-any`/`no-unused-vars` en líneas ajenas al sprint; no se introdujeron advertencias en el código nuevo).* |
| `scripts/test-home-integration.ts` | **OK (80/80 tests)** | 17 suites, incluyendo Suite 16 (tests C y F actualizados). |
| `scripts/test-quick-nav-menu.ts` | **OK (9/9 tests)** | Integridad del menú rápido, accesibilidad y coexistencia Home V2. |
| `scripts/test-access-gate-pre-launch.ts` | **OK (10/10 tests)** | Compuerta fail-closed pre-lanzamiento y cookies/storage. |
| Build Staging (`vite build --mode staging`) + Playwright `--phase staging` | **OK (`STAGING_PLAYWRIGHT_OK`)** | `0` referencias a fixtures locales en `dist/assets/*.js`; `/preview/home-v3c` renderiza subtítulos y bloquea `?previewAuth=permanent`. |
| Build Producción simulada (`VITE_APP_ENV=production`) + Playwright `--phase production` | **OK (`PRODUCTION_PLAYWRIGHT_OK`)** | `0` referencias a fixtures locales; `/preview/home-v3c` ignora V3/V3-C y renderiza Home V2. |

---

## 9. Confirmación de que V2, V3-A y V3-B no fueron afectadas

1. **Verificación de código:**
   - Todos los cambios del Hero en [HomeDualPathHeroPreview.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.tsx) residen únicamente en `variant === 'v3c'`.
   - Todos los selectores CSS móviles de simplificación en [HomeDualPathHeroPreview.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.css) y [Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css) están encapsulados bajo `.home-dual-hero--v3c`, `.home-hero-wrapper--v3c`, `.home-v3c-variant`, `.home-v3c-card*`.
   - Las micro-explicaciones se renderizan únicamente cuando `v3Variant === 'v3c'` (`sectionSubtitle` en [HomeOpenEncounters.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeOpenEncounters.tsx) es `undefined` para V2, V3-A y V3-B, conservando exactamente el mismo DOM previo).
2. **Verificación automatizada en navegador (Playwright) y SSR (`test-home-integration.ts`):**
   - `/`, `/preview/home-v3a` y `/preview/home-v3b` confirmaron `hasV3cWrapper = false`, `hasV3cVariant = false`, `hasDiscoverySub = false`, `hasMiEspacioSub = false`, `hasIntentionsBand = true` y `overflow = 0`.
   - El backup local `backup/home-v2-gsap-8048777` (`8048777e7362c1bb5d0ca9081683de11e135c709`) y la rama `main` permanecen intactos.

---

## 10. Publicación en Staging

- **Rama publicada:** `staging` (partiendo de `cc0786c9cf44b9a140e3e385aaff80b8aaa33629`).
- **URL de evaluación en Staging:** `https://staging.puntoencuentro.com.ar/preview/home-v3c` (`/` se mantiene con Home V2 + GSAP como predeterminada).
- **Aislamiento del commit:** se excluyeron expresamente las modificaciones locales previas no relacionadas (`AccountSheet.tsx`, `AnonymousCoordinationWarningSheet.tsx`, `InfoSheet.tsx`, el párrafo adicional de vinculación Google en el banner de sesión local de `Home.tsx` y archivos untracked preexistentes).
- El hash exacto del commit publicado, el resultado del workflow de GitHub Actions y el deploy en Vercel se informan en el resumen final de entrega inmediatamente tras completar el push.
