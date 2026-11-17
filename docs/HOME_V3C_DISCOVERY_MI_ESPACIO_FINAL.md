# Informe Final — Home V3-C: Optimización Final de Discovery y Mi espacio

## 1. Diagnóstico inicial

Partiendo del commit de referencia `861dd6ce95e6c988683ab116ffdb830a1c92c3ed` en la rama `staging`, el Hero principal de **Home V3-C** ya cumplía los objetivos de claridad y jerarquía en primer viewport, pero el análisis sobre capturas reales en móvil detectó cuatro oportunidades puntuales en las secciones inferiores y en la fila de sugerencias:

1. **Estado vacío extenso en Discovery (`HomeInspirationalEmptyState`):** cuando no existen encuentros publicados para mostrar, el bloque alcanzaba `789px–809px` (`¿A qué me sumo?` total: `958px–978px` en `360px–390px`), apilando 4 tarjetas en 2 filas y empujando `Mi espacio` hasta `1547px–1567px`, de modo que los CTA de cierre de Discovery ni siquiera entraban junto al título en una misma pantalla móvil (`844px`).
2. **Corte visual abrupto en la fila horizontal de chips del Hero móvil:** el último chip parcialmente visible contra el borde derecho (`Salir a c…`) sugería desplazamiento pero con un recorte duro de viewport.
3. **Subtítulos de 2 líneas en móvil (`360px–390px`):** tanto *«Descubrí encuentros de otras personas y solicitá sumarte a los que te interesen.»* (`35px`) debajo de `¿A qué me sumo?` como *«Tus encuentros, tus ganas y tus solicitudes, todo en un lugar.»* (`35px`) debajo de `Mi espacio` saltaban a dos renglones y consumían aire vertical innecesario.
4. **Nota inferior extensa (`HomeCreateOrOpenInfo`):** ocupaba `93px` en `360px–390px` (4 líneas dentro de una caja con borde y fondo) repitiendo explicaciones que ya ocurren dentro de los flujos de creación y votación.

---

## 2. Cambios implementados

Todas las modificaciones se encapsularon exclusivamente para **Home V3-C** (`v3Variant === 'v3c'`), manteniendo sin alteraciones el Hero principal de V3-C (sus dos caminos, animaciones GSAP, textos y controles), así como V2 (`/`), V3-A (`/preview/home-v3a`), V3-B (`/preview/home-v3b`), `backup/home-v2-gsap-8048777` y Producción:

1. **Discovery vacío compacto en móvil V3-C (`< 768px`):**
   - [HomeInspirationalEmptyState.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeInspirationalEmptyState.tsx) y [HomeInspirationalEmptyState.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeInspirationalEmptyState.css): incorporación de `compactV3C?: boolean` (propagada desde [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) → [HomeOpenEncounters.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/openEncounters/HomeOpenEncounters.tsx) únicamente cuando `v3Variant === 'v3c'`).
   - En móvil `< 768px`, las tarjetas `index >= 2` (`pe-inspirational-card--v3c-extra`) se ocultan inicialmente dejando **2 ideas visibles en 1 fila**, junto al botón secundario discreto **`Ver más ideas`** (`aria-expanded`, `min-height: 36px`) que despliega las 4 ideas completas y cambia a **`Ver menos`**. En tablet/desktop (`>= 768px`), el toggle no se muestra porque las 4 ideas ya caben en una única fila horizontal.
   - Se mantuvieron intactas las 4 ideas (`INSPIRATIONAL_IDEAS`), todos sus callbacks `onSelectIdea`, la distinción explícita *«Ideas para organizar • No son encuentros publicados»*, la diferenciación entre zonas sin configurar (`inspirational-zone-prompt` + `Configurar zonas`) vs. zonas configuradas sin resultados, y los botones *«Abrir un encuentro»*, *«Avisame si aparece uno»* y *«Cambiar o sumar zonas»*.
2. **Sugerencias horizontales del Hero con `scroll-snap` y degradado de continuidad (`< 640px` en V3-C):**
   - [HomeDualPathHeroPreview.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeDualPathHeroPreview.css): dentro de `@media (max-width: 639px)` para `.home-dual-hero--v3c .home-suggestions-list`, se incorporó `scroll-snap-type: x proximity`, `scroll-padding-inline: 0.25rem`, `padding-right: 1.85rem`, `scroll-snap-align: start` en cada `.home-suggestion-chip` y una máscara transparente en el borde derecho (`mask-image` / `-webkit-mask-image: linear-gradient(90deg, #000 0%, #000 calc(100% - 30px), rgba(0,0,0,0.24) calc(100% - 8px), transparent 100%)`) que suaviza el borde saliente sin bloquear clics ni gestos y sin mostrar barras invasivas ni flechas. Se añadieron `:focus-visible` y `scroll-behavior: auto` bajo `@media (prefers-reduced-motion: reduce)`.
3. **Subtítulos más breves de 1 línea en V3-C:**
   - [Home.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.tsx) y [Home.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/screens/Home.css):
     - Debajo de **«¿A qué me sumo?»**: `Encontrá encuentros y solicitá sumarte.` (ocupando `1` línea / `18px` en todos los viewports).
     - Debajo de **«Mi espacio»**: `Tus encuentros, ganas y solicitudes.` (ocupando `1` línea / `17px` en todos los viewports).
4. **Simplificación de la nota informativa inferior en V3-C:**
   - [HomeCreateOrOpenInfo.tsx](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.tsx) y [HomeCreateOrOpenInfo.css](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/src/components/home/HomeCreateOrOpenInfo.css).

---

## 3. Decisión sobre estado vacío compacto

Se mantuvo el patrón de **inspiración útil con divulgación progresiva** (`2` ideas iniciales + botón `Ver más ideas` / `Ver menos`) exclusivamente para móvil V3-C (`< 768px`):
- **Por qué no eliminar ideas ni fusionarlas con encuentros reales:** las 4 ideas siguen disponibles en un toque (con sus mismos prompts prellenados al Hero y scroll/foco al textarea) y conservan el badge explícito `Ideas para organizar • No son encuentros publicados` para evitar cualquier confusión con encuentros publicados reales.
- **Resultado funcional:** en `390×844` todo el bloque vacío completo (cabecera + filtros + tarjeta inspiradora + 2 ideas + `Ver más ideas` + los 3 CTAs *Abrir un encuentro* / *Avisame* / *Cambiar zonas*) entra holgadamente dentro de un único viewport al hacer scroll a Discovery, reduciendo la altura de `¿A qué me sumo?` en **`298px`** (`958px → 660px`, `-31.1%`) sin comprimir áreas táctiles (`>= 36px`–`38px`).
- Cuando existen encuentros publicados, el componente mantiene el carrusel original sin alteraciones; cuando no hay zonas configuradas (`noZonesConfigured === true`), conserva intacto el banner contextual `Elegí tus zonas para ver encuentros cerca tuyo.` y su CTA `Configurar zonas`.

---

## 4. Decisión sobre nota inferior

Entre **Opción A (nota mínima)** y **Opción B (eliminar la nota en V3-C)** se eligió la **Opción A — Nota mínima** sin caja ni bordes decorativos:
> *«Podés coordinar fechas y sumar participantes a tus encuentros.»*

**Respaldo de la decisión y comparación visual:**
- **Por qué Opción A sobre B:** la votación de fechas múltiples y la apertura posterior a solicitudes de un encuentro creado no son obvias antes de iniciar el flujo; resumir ambas capacidades en una frase de pie sin contenedor pesado aporta claridad de producto sin competir visualmente con `Mi espacio` ni con el FAB `+ Crear`.
- **Impacto visual medido en `HomeCreateOrOpenInfo` (`compactV3C`):**
  - En `360×640` / `375×667` / `390×844`: pasó de caja con borde/fondo de **`93px`** (4 líneas) a nota ligera sin fondo ni borde de **`41px`** (`-52px`).
  - En `430×932`: pasó de **`75px`** a **`25px`** (1 línea, `-50px`).
  - En tablet (`768×1024`, `1024×768`) y desktop (`1440×900`): pasó de `59px` / `42px` a **`28px`** (1 línea discreta).
- El componente estándar para V2, V3-A y V3-B (`compactV3C = false`) permanece inalterado.

---

## 5. Comparación visual antes / después

Mediciones automatizadas con Playwright sobre `/preview/home-v3c` comparando el commit previo (`861dd6c`, fase `before`) vs. la implementación final (`after`), sin errores de consola y con `horizontalOverflow = 0px` en todos los casos:

### A. Estado Discovery Vacío (zonas configuradas — caso de mayor desplazamiento vertical)

| Viewport | `docScrollHeight` (Antes → Después) | Altura Discovery (Antes → Después) | Altura Contenedor Ideas (Antes → Después) | Ideas Iniciales (Antes → Después) | Subtítulo Discovery / Mi espacio (Líneas) | Posición `Mi espacio` `top` | Altura Nota Inferior (Antes → Después) |
|---|---|---|---|---|---|---|---|
| `360×640` | `2263px` → **`1888px`** (`-375px`) | `978px` → **`687px`** (`-291px`) | `809px` → **`536px`** | `4` → **`2`** (+ toggle) | `2 / 2` → **`1 / 1`** | `1567px` → **`1277px`** (`-290px`) | `93px` → **`41px`** |
| `375×667` | `2263px` → **`1876px`** (`-387px`) | `978px` → **`675px`** (`-303px`) | `809px` → **`524px`** | `4` → **`2`** (+ toggle) | `2 / 2` → **`1 / 1`** | `1567px` → **`1265px`** (`-302px`) | `93px` → **`41px`** |
| `390×844` | `2243px` → **`1861px`** (`-382px`) | `958px` → **`660px`** (`-298px`) | `789px` → **`509px`** | `4` → **`2`** (+ toggle) | `2 / 2` → **`1 / 1`** | `1547px` → **`1250px`** (`-297px`) | `93px` → **`41px`** |
| `430×932` | `2117px` → **`1794px`** (`-323px`) | `899px` → **`643px`** (`-256px`) | `730px` → **`492px`** | `4` → **`2`** (+ toggle) | `2 / 1` → **`1 / 1`** | `1473px` → **`1218px`** (`-255px`) | `75px` → **`25px`** |
| `768×1024` | `2123px` → **`2065px`** (`-58px`) | `631px` → **`613px`** | `492px` → `492px` | `4` → `4` | `2 / 1` → **`1 / 1`** | `1575px` → **`1557px`** | `59px` → **`28px`** |
| `1024×768` | `1890px` → **`1850px`** (`-40px`) | `581px` → `581px` | `460px` → `460px` | `4` → `4` | `1 / 1` → `1 / 1` | `1341px` → `1341px` | `59px` → **`28px`** |
| `1440×900` | `1878px` → **`1855px`** (`-23px`) | `581px` → `581px` | `460px` → `460px` | `4` → `4` | `1 / 1` → `1 / 1` | `1347px` → `1347px` | `42px` → **`28px`** |

### B. Estado Discovery con Encuentros Publicados + Fila Horizontal de Sugerencias

- En `360×640` / `375×667` / `390×844`: `docScrollHeight` bajó de `1668px` a **`1566px`** (`-102px`), dejando ver en `390×844` desde la carga inicial el Hero completo, los chips horizontales con degradado de continuidad (`chipsMask: true`, `chipsScrollSnapType: x`), `¿A qué me sumo?` con subtítulo de `1` línea, filtros y las primeras tarjetas de encuentros publicados.
- Capturas generadas en artifacts de sesión: `v3c_disc_before_*.png` vs. `v3c_disc_after_360x640_*`, `v3c_disc_after_390x844_hero.png`, `v3c_disc_after_390x844_empty.png`, `v3c_disc_after_390x844_expanded.png`, `v3c_disc_after_390x844_no_zones.png`, `v3c_disc_after_390x844_bottom.png` y `v3c_disc_after_1440x900_*`.

---

## 6. Resultados de accesibilidad

Verificado en Playwright (`verify-home-v3c-discovery-espacio.mjs`) e inspección CSS:
- **Áreas táctiles:** botón `Ver más ideas` / `Ver menos` con `min-height: 36px` (`36px` medido), botones CTA de Discovery `>= 38px`, chips horizontales cómodos (`>= 32px` con `touch-action: manipulation`).
- **Estado y semántica ARIA:** `aria-expanded` conmuta correctamente (`false` inicial → `true` al expandir → `false` al contraer); `role="region"` / `role="list"` / `role="listitem"` intactos en el estado vacío; aviso `Ideas para organizar • No son encuentros publicados` conservado.
- **Teclado y foco visible:** `.home-suggestion-chip:focus-visible` y `.pe-inspirational-toggle-btn:focus-visible` muestran contorno de `2px`; probado foco programático y por teclado en Playwright sin obstrucción por `mask-image` (no bloquea clics ni `pointer-events`).
- **Contraste y subtítulos:** subtítulos secundarios con `var(--color-on-surface-variant, #475569)` sobre fondo claro (`#FFFFFF` / `#EBF1F8`).
- **`prefers-reduced-motion: reduce`:** probado en `390×844` (`horizontalOverflow: 0`, transiciones deshabilitadas en `.pe-inspirational-card` y `.pe-inspirational-toggle-btn`, y `scroll-behavior: auto` en el carrusel horizontal).
- **Header sticky (`73px`), FAB contextual y cero colisiones:** sin solapamiento vertical ni desbordes horizontales (`scrollWidth - clientWidth === 0` en los 7 viewports y en todos los estados).

---

## 7. Resultados de regresión

| Validación | Resultado | Alcance |
|---|---|---|
| TypeScript (`tsc -b`) | **OK (exit 0)** | Proyecto completo tras las ediciones finales. |
| ESLint focalizado | **OK (exit 0)** | `HomeDualPathHeroPreview.tsx`, `HomeCreateOrOpenInfo.tsx` y `HomeInspirationalEmptyState.tsx` (con `--rule "react-refresh/only-export-components: off"` por constante preexistente `INSPIRATIONAL_IDEAS`; 0 errores ni warnings en código nuevo). |
| [test-home-integration.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-home-integration.ts) | **81/81 PASS** | Incluye nueva prueba **16.G** para estado compacto/expandido, preservación de las 4 ideas, estados con/sin zonas, scroll-snap/fade en chips, subtítulos cortos, nota mínima Opción A y no-regresión. |
| [test-quick-nav-menu.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-quick-nav-menu.ts) | **9/9 PASS** | Coexistencia con Menú, Discovery y Mi espacio. |
| [test-access-gate-pre-launch.ts](file:///c:/Users/Minar/Documents/Proyectos/PuntoEncuentro/scripts/test-access-gate-pre-launch.ts) | **10/10 PASS** | Compuerta fail-closed pre-lanzamiento. |
| Playwright 7 viewports + estados | **OK (`PLAYWRIGHT_DISC_AFTER_OK`)** | Visitante/anónimo, usuario permanente (`?previewAuth=permanent`), Discovery con encuentros vs. vacío (zonas configuradas y sin zonas), expandir/contraer ideas + callback 4ª idea + último chip horizontal, reduced motion y foco. |
| Build Staging (`vite build --mode staging`) | **OK (`STAGING_DISC_PLAYWRIGHT_OK`)** | 0 referencias a fixtures locales de auth en `dist/assets/*.js`; `/preview/home-v3c` activo y `?previewAuth=permanent` bloqueado. |
| Build Producción simulada (`VITE_APP_ENV=production`) | **OK (`PRODUCTION_DISC_PLAYWRIGHT_OK`)** | `/preview/home-v3c` ignorado y renderiza Home V2; 0 fixtures locales en bundle. |

---

## 8. Estado de V2, V3-A y V3-B

Comprobado tanto por análisis de código como por SSR (`test-home-integration.ts`) y Playwright en navegador (`390×844`):
- **`/` (Home V2 + GSAP predeterminada):** `hasCompactInspirationalClass: false`, `visibleIdeasCount: 4`, `hasToggleBtn: false`, `hasFullCreateOrOpenInfo: true`, `hasDiscoverySub: false`, `hasMiEspacioSub: false`, `overflow: 0`.
- **`/preview/home-v3a`:** sin cambios visuales ni funcionales (`visibleIdeasCount: 4`, sin subtítulos ni nota compacta V3-C, `overflow: 0`).
- **`/preview/home-v3b`:** sin cambios visuales ni funcionales (`visibleIdeasCount: 4`, sin subtítulos ni nota compacta V3-C, `overflow: 0`).
- **`backup/home-v2-gsap-8048777`:** intacto en `8048777e7362c1bb5d0ca9081683de11e135c709`.

---

## 9. Pendientes de QA manual

Las validaciones automatizadas anteriores utilizaron Vite local, builds compilados y mocks offline de Supabase sin escribir datos remotos. Quedan exclusivamente para **QA humano sobre dispositivo real y datos reales en Staging** (`https://staging.puntoencuentro.com.ar/preview/home-v3c`):

1. **Tacto real y `mask-image` sobre Safari iOS y Chrome Android:** confirmar que el deslizamiento horizontal de la fila de chips en el Hero se siente fluido al tacto físico y que el degradado del borde derecho resulta natural sobre distintos fondos GSAP.
2. **Interacción real con filtros, zonas y notificaciones en Staging:** probar el guardado real de zonas desde *Configurar zonas*, el alta real de alerta desde *Avisame si aparece uno* y las solicitudes reales para sumarse a un encuentro abierto en Staging.
3. **Flujos E2E completos desde los accesos de Home V3-C:** crear una invitación privada con votación de múltiples fechas, confirmar asistencia sin registro como invitado, probar dictado por voz nativo en celular físico y validar `Mi espacio` (pestañas *Mis encuentros*, *Mis ganas*, *Mis solicitudes*) con sesión Google real.
4. **Lectores de pantalla físicos (TalkBack / VoiceOver):** verificar locución del botón `Ver más ideas` / `Ver menos` y de las micro-explicaciones breves.

---

## 10. SHA y verificación de Staging + Evaluación de reemplazo en Staging

- **Rama publicada:** `staging` (base `861dd6ce95e6c988683ab116ffdb830a1c92c3ed`).
- **Entorno evaluable:** `https://staging.puntoencuentro.com.ar/preview/home-v3c` (mientras `/` mantiene Home V2 + GSAP hasta nueva instrucción).
- **Aislamiento:** commit acotado únicamente a los archivos de este mini-sprint; preservados sin alterar todos los cambios locales previos no relacionados (`AccountSheet.tsx`, `AnonymousCoordinationWarningSheet.tsx`, `InfoSheet.tsx`, modificación previa en `Home.tsx` y untracked preexistentes) y Producción (`main` / `aurbicjwftjhwryhyjiq`) sin tocar.
- *(El SHA exacto del commit publicado, estado de GitHub Actions y estado de Vercel se adjuntan en la respuesta final de entrega inmediatamente tras completar el push.)*

### Respuesta final: ¿Home V3-C puede convertirse en la Home predeterminada de Staging para el QA funcional completo?

**Sí — está en condiciones técnicas y de UX para pasar a ser la Home predeterminada de Staging y comenzar el QA funcional completo**, sujeto únicamente a una última inspección visual rápida del equipo sobre `https://staging.puntoencuentro.com.ar/preview/home-v3c` en celular físico:

- **Jerarquía y primer viewport resueltos:** los dos caminos principales (*Organizá con tu gente* y *Tengo ganas de…* con voz), las sugerencias con affordance horizontal limpio y la entrada a *¿A qué me sumo?* son comprensibles y accionables desde el primer pantallazo en móvil y en layout de 2 columnas en desktop.
- **Discovery y Mi espacio balanceados:** la compactación a 2 ideas iniciales + `Ver más ideas` redujo el bloque vacío en ~300px y evitó saturar el scroll, los subtítulos ocupan 1 sola línea (`~17px–18px`) y la nota inferior mínima conserva la información útil sin recargar el cierre.
- **Respaldo de seguridad:** Home V2 + GSAP queda preservada en `backup/home-v2-gsap-8048777` (y podrá seguir accesible o restaurarse de inmediato si hiciera falta antes de pensar en Producción).
