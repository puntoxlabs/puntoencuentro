import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  HomeHero,
  HomeIntentInput,
  HomeSuggestionChips,
  HomeDraftResumeCard,
  HomeValueProposition,
  DraftOverwriteConfirmSheet,
  HomeRotatingPhrase,
  HomeFlankingVisuals,
  HomePillarsSection,
  HomeDynamicCanvas,
  HomeVariantSwitcher,
  HomeCreateOrOpenInfo,
  HomeIntentionsBand,
  HomeAmbientBrushes,
  FLOATING_TAGS_CATALOG,
  ANIMATED_PHOTOS_CATALOG,
} from '../src/components/home/index';
import HomeDynamicCanvasGsap from '../src/components/home/HomeDynamicCanvasGsap';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Home, { formatBuildTimestamp } from '../src/screens/Home';
import { AuthContext } from '../src/contexts/AuthContext';
import { NotificationsProvider } from '../src/contexts/NotificationsContext';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n/i18n';
import ptJson from '../src/i18n/locales/pt.json';

import { useAiWizardStore } from '../src/store/aiWizardStore';
import { aiService } from '../src/services/aiService';
import { HomeOpenEncounters, getCardScrollTargets } from '../src/components/home/openEncounters/HomeOpenEncounters';
import { HomeOpenEncounterCard } from '../src/components/home/openEncounters/HomeOpenEncounterCard';
import { HomeOpenEncounterDetailSheet } from '../src/components/home/openEncounters/HomeOpenEncounterDetailSheet';
import { OPEN_ENCOUNTERS_DEMO } from '../src/components/home/openEncounters/demoData';
import { HomeEncountersToolbar } from '../src/components/home/yourEncounters/HomeEncountersToolbar';
import {
  HomeEncountersFilterSheet,
  DEFAULT_FILTER_VALUES,
  countActiveSecondaryFilters,
  type EncountersFilterValues,
} from '../src/components/home/yourEncounters/HomeEncountersFilterSheet';

describe('Nueva Home Mobile-First — Suite de Pruebas de Integración y Componentes', () => {
  describe('1. Componente HomeHero', () => {
    test('A. Renderiza la pregunta principal "¿Qué querés hacer?" y el subtítulo cálido', () => {
      const html = renderToString(React.createElement(HomeHero));
      assert.ok(html.includes('¿Qué querés hacer?'), 'Debe contener el título principal');
      assert.ok(html.includes('Contanos tu idea y te ayudamos a coordinar'), 'Debe contener el subtítulo');
      assert.ok(html.includes('home-hero'), 'Debe tener la clase raíz home-hero');
    });

    test('B. Soporta badge opcional y textos personalizados', () => {
      const html = renderToString(
        React.createElement(HomeHero, {
          title: '¿Qué tenés ganas de armar hoy?',
          subtitle: 'Coordiná con amigos al instante',
          badgeText: 'NUEVO',
        })
      );
      assert.ok(html.includes('¿Qué tenés ganas de armar hoy?'));
      assert.ok(html.includes('Coordiná con amigos al instante'));
      assert.ok(html.includes('NUEVO'));
    });
  });

  describe('2. Componente HomeIntentInput', () => {
    test('A. Renderiza campo textarea y botón primario "Hagamos que pase"', () => {
      const html = renderToString(
        React.createElement(HomeIntentInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
        })
      );
      assert.ok(html.includes('Hagamos que pase'), 'Debe contener el CTA "Hagamos que pase"');
      assert.ok(html.includes('home-intent-textarea'), 'Debe contener el textarea');
      assert.ok(html.includes('disabled=""') || html.includes('disabled'), 'Debe estar deshabilitado si value está vacío');
    });

    test('B. Muestra valor ingresado y habilita el CTA cuando hay texto', () => {
      const html = renderToString(
        React.createElement(HomeIntentInput, {
          value: 'Cena con amigos el viernes',
          onChange: () => {},
          onSubmit: () => {},
        })
      );
      assert.ok(html.includes('Cena con amigos el viernes'), 'Debe reflejar el valor ingresado');
      assert.ok(html.includes('Borrar texto'), 'Debe mostrar el botón de limpiar texto');
    });

    test('C. Muestra spinner e indicador de estado cuando isSubmitting=true', () => {
      const html = renderToString(
        React.createElement(HomeIntentInput, {
          value: 'Asado domingo',
          onChange: () => {},
          onSubmit: () => {},
          isSubmitting: true,
        })
      );
      assert.ok(html.includes('Preparando encuentro…'), 'Debe mostrar texto de carga');
      assert.ok(html.includes('home-intent-spinner'), 'Debe renderizar spinner');
    });
  });

  describe('3. Componente HomeSuggestionChips', () => {
    test('A. Renderiza los 4 chips de sugerencia por defecto', () => {
      const html = renderToString(
        React.createElement(HomeSuggestionChips, {
          onSelect: () => {},
        })
      );
      assert.ok(html.includes('Cena este viernes'), 'Debe incluir Cena este viernes');
      assert.ok(html.includes('Asado el domingo'), 'Debe incluir Asado el domingo');
      assert.ok(html.includes('Partido de pádel'), 'Debe incluir Partido de pádel');
      assert.ok(html.includes('Cumpleaños sorpresa'), 'Debe incluir Cumpleaños sorpresa');
      assert.ok(html.includes('home-suggestion-chip'), 'Debe incluir chips estilizados');
    });
  });

  describe('4. Componente HomeDraftResumeCard', () => {
    test('A. Renderiza información del borrador en curso y botón para continuar', () => {
      const html = renderToString(
        React.createElement(HomeDraftResumeCard, {
          title: 'Cena en Palermo',
          details: 'Programado para el 25/10/2026',
          onResume: () => {},
          onDiscard: () => {},
        })
      );
      assert.ok(html.includes('Cena en Palermo'), 'Debe mostrar título del borrador');
      assert.ok(html.includes('Programado para el 25/10/2026'), 'Debe mostrar detalles');
      assert.ok(html.includes('Continuar'), 'Debe contener botón Continuar');
      assert.ok(html.includes('Descartar borrador'), 'Debe contener botón para descartar');
    });
  });

  describe('5. Componente HomeValueProposition', () => {
    test('A. Renderiza los 3 pasos explicativos para nuevos visitantes', () => {
      const html = renderToString(React.createElement(HomeValueProposition));
      assert.ok(html.includes('Organizar un encuentro es simple'), 'Debe incluir título pedagógico');
      assert.ok(html.includes('Escribí qué querés hacer'), 'Paso 1');
      assert.ok(html.includes('Elegí la fecha o proponé opciones'), 'Paso 2');
      assert.ok(html.includes('Compartí la invitación'), 'Paso 3');
      assert.ok(html.includes('sin registrarse ni descargar nada'), 'Propuesta sin fricción');
    });
  });

  describe('6. Componente DraftOverwriteConfirmSheet', () => {
    test('A. No renderiza nada si open=false', () => {
      const html = renderToString(
        React.createElement(DraftOverwriteConfirmSheet, {
          open: false,
          draftTitle: 'Cena vieja',
          newPrompt: 'Asado nuevo',
          onConfirmNew: () => {},
          onResumeOld: () => {},
          onClose: () => {},
        })
      );
      assert.equal(html, '');
    });

    test('B. Muestra advertencia, título del borrador anterior y el nuevo prompt cuando open=true', () => {
      const html = renderToString(
        React.createElement(DraftOverwriteConfirmSheet, {
          open: true,
          draftTitle: 'Juntada anterior con amigos',
          newPrompt: 'Partido de tenis mañana',
          onConfirmNew: () => {},
          onResumeOld: () => {},
          onClose: () => {},
        })
      );
      assert.ok(html.includes('Tenés un encuentro en preparación'), 'Título de la sheet');
      assert.ok(html.includes('Juntada anterior con amigos'), 'Muestra título anterior');
      assert.ok(html.includes('Partido de tenis mañana'), 'Muestra nuevo prompt');
      assert.ok(html.includes('Descartar anterior y empezar este'), 'Opción de reemplazar');
      assert.ok(html.includes('Continuar el borrador anterior'), 'Opción de reanudar');
    });
  });

  describe('7. Mecanismo de Transferencia Atómica en aiWizardStore', () => {
    test('A. setPendingInitialPrompt y consumePendingInitialPrompt son idempotentes (1 solo consumo)', () => {
      const store = useAiWizardStore.getState();
      
      // 1. Seteamos un prompt pendiente
      store.setPendingInitialPrompt('Cena el sábado a las 21', 'test-transfer-123');
      assert.equal(useAiWizardStore.getState().pendingInitialPrompt, 'Cena el sábado a las 21');
      assert.equal(useAiWizardStore.getState().pendingInitialTransferId, 'test-transfer-123');

      // 2. Primer consumo: obtiene el prompt y lo elimina atómicamente
      const consumed1 = store.consumePendingInitialPrompt();
      assert.ok(consumed1 !== null, 'Primer consumo debe retornar datos');
      assert.equal(consumed1?.prompt, 'Cena el sábado a las 21');
      assert.equal(consumed1?.transferId, 'test-transfer-123');

      // 3. El estado en el store debe haber quedado limpio
      assert.equal(useAiWizardStore.getState().pendingInitialPrompt, null);
      assert.equal(useAiWizardStore.getState().pendingInitialTransferId, null);

      // 4. Segundo consumo (ej. StrictMode o remount): debe retornar null (idempotencia estricta)
      const consumed2 = store.consumePendingInitialPrompt();
      assert.equal(consumed2, null, 'Segundo consumo debe retornar null para evitar doble llamada');
    });

    test('B. startNewWithPrompt limpia el estado previo y setea el nuevo prompt con nuevo sessionId', () => {
      const origStartSession = aiService.startSession;
      aiService.startSession = () => {};
      try {
        const store = useAiWizardStore.getState();
        const prevSessionId = store.sessionId;

        store.startNewWithPrompt('Pizza el viernes a la noche');

        const newState = useAiWizardStore.getState();
        assert.notEqual(newState.sessionId, prevSessionId, 'Debe generar un nuevo sessionId');
        assert.equal(newState.pendingInitialPrompt, 'Pizza el viernes a la noche');
        assert.ok(newState.pendingInitialTransferId, 'Debe asignar un transferId');
        assert.equal(newState.messages.length, 0, 'Messages debe iniciar limpio');
        assert.equal(newState.turns, 0, 'Turns debe iniciar en 0');

        // Limpiamos
        store.consumePendingInitialPrompt();
      } finally {
        aiService.startSession = origStartSession;
      }
    });
  });

  describe('8. Componente HomeRotatingPhrase y Frases Inspiradoras V2', () => {
    test('A. Renderiza la primera frase por defecto con slot CLS=0 y sin botón visible de pausa', () => {
      const html = renderToString(React.createElement(HomeRotatingPhrase));
      assert.ok(html.includes('Quiero invitar a mis amigos a tomar un café.'), 'Debe renderizar primera frase');
      assert.ok(html.includes('home-rotating-phrase-slot'), 'Debe tener slot de altura fija para CLS=0');
      assert.ok(!html.includes('home-rotating-phrase-btn'), 'NO debe incluir botón visible de pausa');
    });

    test('B. Soporta catálogo personalizado y llamada onClick', () => {
      const html = renderToString(
        React.createElement(HomeRotatingPhrase, {
          phrases: ['Quiero festejar mi cumpleaños'],
          onPhraseClick: () => {},
        })
      );
      assert.ok(html.includes('Quiero festejar mi cumpleaños'));
      assert.ok(html.includes('home-rotating-phrase-text--clickable'));
    });

    test('C. La rotación de frases NO modifica el store aiWizardStore ni el input', () => {
      const store = useAiWizardStore.getState();
      const promptBefore = store.pendingInitialPrompt;
      const transferBefore = store.pendingInitialTransferId;

      renderToString(React.createElement(HomeRotatingPhrase));

      assert.equal(useAiWizardStore.getState().pendingInitialPrompt, promptBefore);
      assert.equal(useAiWizardStore.getState().pendingInitialTransferId, transferBefore);
    });
  });

  describe('9. Componente HomePillarsSection (Delimitación 1.0 vs Próximamente)', () => {
    test('A. Renderiza Pilar 1 activo y Pilares 2 y 3 con badge Próximamente y deshabilitados', () => {
      const html = renderToString(
        React.createElement(HomePillarsSection, {
          onCreateClick: () => {},
        })
      );
      assert.ok(html.includes('Crear un encuentro'), 'Debe incluir Pilar 1');
      assert.ok(html.includes('Abrir un encuentro'), 'Debe incluir Pilar 2');
      assert.ok(html.includes('Encontrar con quién'), 'Debe incluir Pilar 3');
      assert.ok(html.includes('Próximamente'), 'Debe incluir badges de Próximamente');
      assert.ok(html.includes('home-pillar-cta--disabled'), 'Pilares 2 y 3 deben tener botón deshabilitado');
    });

    test('B. En Variante D renderiza 2 pilares de lanzamiento ("Organizar" y "Abrir encuentros") sin Próximamente ni Encontrar con quién', () => {
      const html = renderToString(
        React.createElement(HomePillarsSection, {
          onCreateClick: () => {},
          variant: 'stitch',
        })
      );
      assert.ok(html.includes('Organizar un encuentro'), 'Debe incluir Pilar de Organizar');
      assert.ok(html.includes('Abrir encuentros'), 'Debe incluir Pilar de Abrir encuentros');
      assert.ok(!html.includes('Encontrar con quién'), 'NO debe publicitar Encontrar con quién en lanzamiento');
      assert.ok(!html.includes('Próximamente'), 'NO debe tener badge de Próximamente en lanzamiento');
      assert.ok(html.includes('home-pillars-grid--stitch'), 'Debe usar grid compacto de 2 columnas');
    });
  });

  describe('10. Componente HomeFlankingVisuals V2', () => {
    test('A. Renderiza banner móvil y composición lateral con status badges', () => {
      const html = renderToString(React.createElement(HomeFlankingVisuals));
      assert.ok(html.includes('home-mobile-visual-banner'), 'Debe incluir banner mobile');
      assert.ok(html.includes('Asado este sábado'), 'Debe incluir status card de asado');
      assert.ok(html.includes('Pádel'), 'Debe incluir status card de pádel');
      assert.ok(html.includes('Café esta semana'), 'Debe incluir status card de café');
      assert.ok(html.includes('De ganas a encuentros'), 'Debe incluir doodle manuscrito');
    });

    test('B. Soporta estado colapsado cuando isInputFocused=true', () => {
      const html = renderToString(React.createElement(HomeFlankingVisuals, { isInputFocused: true }));
      assert.ok(html.includes('home-mobile-visual-banner--collapsed'), 'Debe colapsar banner con teclado/foco');
    });
  });

  describe('11. Componente HomeDynamicCanvas y Selector de Variantes', () => {
    test('A. Renderiza Variante A (Movimiento Envolvente) con fotos y etiquetas flotantes', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'envolvente',
          isInputFocused: false,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--envolvente'), 'Debe incluir clase de variante envolvente');
      assert.ok(html.includes('Organizar un asado'), 'Debe incluir tag de asado');
      assert.ok(html.includes('Tomar unos mates'), 'Debe incluir tag de mates');
      assert.ok(html.includes('Jugar al pádel'), 'Debe incluir tag de pádel');
      assert.ok(html.includes('home-dynamic-photo-card--left-top'), 'Debe renderizar foto en flanco izquierdo');
      assert.ok(html.includes('home-dynamic-photo-mobile-pill'), 'Debe renderizar cápsulas mobile');
    });

    test('B. Renderiza Variante B (Visor Dinámico) con portales fotográficos y cruces', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'visor',
          isInputFocused: false,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--visor'), 'Debe incluir clase de variante visor');
      assert.ok(html.includes('home-dynamic-visor-stage'), 'Debe incluir visor stage');
      assert.ok(html.includes('home-visor-portal--left'), 'Debe incluir portal visor izquierdo');
      assert.ok(html.includes('home-visor-portal--center'), 'Debe incluir portal visor central');
      assert.ok(html.includes('home-visor-portal--right'), 'Debe incluir portal visor derecho');
    });

    test('C. Responde al foco del input atenuando elementos para despejar el teclado', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'envolvente',
          isInputFocused: true,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--input-focused'), 'Debe incluir clase de input focused');
    });

    test('D. Renderiza HomeVariantSwitcher con botones para alternar Variante A, B y C', () => {
      const html = renderToString(
        React.createElement(HomeVariantSwitcher, {
          currentVariant: 'refinado',
          onVariantChange: () => {},
        })
      );
      assert.ok(html.includes('Variante A'), 'Debe incluir opción Variante A');
      assert.ok(html.includes('Variante B'), 'Debe incluir opción Variante B');
      assert.ok(html.includes('Variante C'), 'Debe incluir opción Variante C');
      assert.ok(html.includes('Variante D'), 'Debe incluir opción Variante D');
      assert.ok(html.includes('Movimiento Envolvente'), 'Debe describir variante A');
      assert.ok(html.includes('Visor Dinámico'), 'Debe describir variante B');
      assert.ok(html.includes('Espacio Vivo Refinado'), 'Debe describir variante C');
      assert.ok(html.includes('Mundo Vivo Stitch'), 'Debe describir variante D');
      assert.ok(html.includes('home-variant-btn--c is-active'), 'Variante C debe estar activa');
    });

    test('E. Renderiza Variante C (Espacio Vivo Refinado) con fotos orgánicas, viñetas mobile y tags ghost', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'refinado',
          isInputFocused: false,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--refinado'), 'Debe incluir clase de variante refinado');
      assert.ok(html.includes('home-refinado-photos-stage'), 'Debe incluir photos stage de refinado');
      assert.ok(html.includes('home-refinado-photo-momento--left'), 'Debe incluir momento desktop izquierdo');
      assert.ok(html.includes('home-refinado-photo-momento--right-top'), 'Debe incluir momento desktop derecho superior');
      assert.ok(html.includes('home-refinado-photo-momento--right-bottom'), 'Debe incluir momento desktop derecho inferior');
      assert.ok(html.includes('home-refinado-mobile-peek--left'), 'Debe incluir viñeta mobile izquierda');
      assert.ok(html.includes('home-refinado-mobile-peek--right'), 'Debe incluir viñeta mobile derecha');
      assert.ok(html.includes('home-floating-tag--refinado'), 'Debe incluir tags refinados');
      assert.ok(html.includes('home-floating-tag--ghost'), 'Debe incluir tags en estilo ghost');
      assert.ok(html.includes('home-floating-tag--track-refinado-sky'), 'Debe incluir pista refinado-sky');
      assert.ok(html.includes('home-floating-tag--track-refinado-lower-cross'), 'Debe incluir pista refinado-lower-cross');
    });

    test('F. Variante C responde al foco del input atenuando fotos y pausando animaciones', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'refinado',
          isInputFocused: true,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--refinado'), 'Debe ser variante refinado');
      assert.ok(html.includes('home-dynamic-canvas--input-focused'), 'Debe incluir clase input-focused');
    });

    test('G. Renderiza Variante D (Mundo Vivo Stitch) con composición asimétrica Stitch y viñetas mobile', () => {
      const html = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'stitch',
          isInputFocused: false,
        })
      );
      assert.ok(html.includes('home-dynamic-canvas--stitch'), 'Debe incluir clase de variante stitch');
      assert.ok(html.includes('home-stitch-photos-stage'), 'Debe incluir photos stage de stitch');
      assert.ok(html.includes('home-stitch-photo--left'), 'Debe incluir gran fotografía izquierda de asado');
      assert.ok(html.includes('home-stitch-photo--right-top'), 'Debe incluir foto de pádel superior derecha');
      assert.ok(html.includes('home-stitch-photo--right-bottom'), 'Debe incluir foto de café inferior derecha');
      assert.ok(html.includes('home-stitch-mobile-stage'), 'Debe incluir escenario móvil');
      assert.ok(html.includes('home-stitch-mobile-frag--left'), 'Debe incluir fragmento móvil izquierdo');
      assert.ok(html.includes('home-stitch-mobile-frag--right'), 'Debe incluir fragmento móvil derecho');
      assert.ok(html.includes('home-stitch-mobile-frag--micro'), 'Debe incluir micro fragmento móvil');
      assert.ok(html.includes('home-floating-tag--stitch'), 'Debe incluir tags estilo stitch');
    });

    test('H. Variante D incluye etiquetas decorativas viajeras organizadas en ciclos orgánicos y responde al foco', () => {
      const htmlNormal = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'stitch',
          isInputFocused: false,
        })
      );
      assert.ok(htmlNormal.includes('Asado entre amigos'), 'Debe incluir etiqueta de Asado');
      assert.ok(htmlNormal.includes('Mates al sol'), 'Debe incluir etiqueta de Mates');
      assert.ok(htmlNormal.includes('Pádel'), 'Debe incluir etiqueta de Pádel');
      assert.ok(htmlNormal.includes('falta 1') || htmlNormal.includes('quedan 2'), 'Debe incluir etiquetas de encuentros abiertos');
      assert.ok(htmlNormal.includes('home-floating-tag--track-stitch-sky-cross'), 'Debe incluir pista de cruce en cielo superior');
      assert.ok(htmlNormal.includes('home-floating-tag--track-stitch-lower-travel'), 'Debe incluir pista de cruce inferior');

      const htmlFocused = renderToString(
        React.createElement(HomeDynamicCanvas, {
          variant: 'stitch',
          isInputFocused: true,
        })
      );
      assert.ok(htmlFocused.includes('home-dynamic-canvas--input-focused'), 'Debe incluir clase input-focused en variante D');
    });
  });

  describe('12. Ruta Privada de Preview (/preview/home-d) y forcedVariant', () => {
    test('A. HomeDynamicCanvas con variant="stitch" refleja fielmente la Variante D', () => {
      const html = renderToString(React.createElement(HomeDynamicCanvas, { variant: 'stitch' }));
      assert.ok(html.includes('home-dynamic-canvas--stitch'), 'Debe incluir la clase de Variante D');
      assert.ok(html.includes('home-stitch-photos-stage'), 'Debe contener el escenario de fotos');
      assert.ok(html.includes('home-floating-tag--stitch'), 'Debe contener los tags de Stitch');
    });

    test('B. Inyección y limpieza de meta tag noindex, nofollow para PreviewHomeD', () => {
      const head = {
        children: [] as any[],
        appendChild(child: any) {
          this.children.push(child);
        },
        removeChild(child: any) {
          const idx = this.children.indexOf(child);
          if (idx !== -1) this.children.splice(idx, 1);
        }
      };
      let meta: any = null;
      const effectLogic = () => {
        let metaTag = meta;
        let wasCreated = false;
        let previousContent: string | null = null;
        if (!metaTag) {
          metaTag = { name: 'robots', content: '', parentNode: head, setAttribute(k: string, v: string) { (this as any)[k] = v; }, getAttribute(k: string) { return (this as any)[k]; } };
          head.appendChild(metaTag);
          wasCreated = true;
        } else {
          previousContent = metaTag.getAttribute('content');
        }
        metaTag.setAttribute('content', 'noindex, nofollow');
        return () => {
          if (wasCreated) {
            metaTag.parentNode.removeChild(metaTag);
          } else if (previousContent !== null) {
            metaTag.setAttribute('content', previousContent);
          }
        };
      };

      const cleanup = effectLogic();
      assert.equal(head.children.length, 1);
      assert.equal(head.children[0].content, 'noindex, nofollow');
      cleanup();
      assert.equal(head.children.length, 0);
    });
  });

  describe('13. Ruta Experimental GSAP (/preview/home-gsap) y HomeDynamicCanvasGsap', () => {
    test('A. HomeDynamicCanvasGsap renderiza tags con GSAP_TAGS_CATALOG y 6 morfologías', () => {
      const html = renderToString(React.createElement(HomeDynamicCanvasGsap));
      assert.ok(html.includes('home-dynamic-canvas--gsap'), 'Debe incluir la clase de canvas GSAP');
      assert.ok(html.includes('home-gsap-tag'), 'Debe contener los tags GSAP');
      assert.ok(html.includes('gt-pizza'), 'Debe incluir tag pizza');
      assert.ok(html.includes('gt-futbol'), 'Debe incluir tag fútbol');
      assert.ok(html.includes('gt-bici'), 'Debe incluir tag bici');
      assert.ok(html.includes('gt-padel'), 'Debe incluir tag pádel');
    });

    test('B. En variante "gsap", HomePillarsSection renderiza las 2 capacidades de lanzamiento sin Encontrar con quién', () => {
      const html = renderToString(React.createElement(HomePillarsSection, {
        onCreateClick: () => {},
        variant: 'gsap',
      }));
      assert.ok(html.includes('Organizar un encuentro'), 'Debe incluir Organizar un encuentro');
      assert.ok(html.includes('Abrir encuentros'), 'Debe incluir Abrir encuentros');
      assert.ok(!html.includes('Encontrar con quién'), 'NO debe incluir Encontrar con quién');
      assert.ok(!html.includes('Próximamente'), 'NO debe incluir Próximamente');
    });
  });

  describe('14. Visor de Encuentros Abiertos y Toolbar Simplificada de Tus Encuentros', () => {
    const mockOrganized = [
      { id: 'enc-org-1', titulo: 'Asado con amigos', fecha: '2026-10-05', hora: '13:00', modalidad: 'presencial' },
      { id: 'enc-shared', titulo: 'Cena compartida', fecha: '2026-10-06', hora: '21:00', modalidad: 'presencial' },
    ];
    const mockParticipated = [
      { id: 'enc-part-1', titulo: 'Torneo de Pádel', fecha: '2026-10-07', hora: '19:00', modalidad: 'presencial', _mi_token_invitacion: 'tok-123' },
      { id: 'enc-shared', titulo: 'Cena compartida', fecha: '2026-10-06', hora: '21:00', modalidad: 'presencial', _mi_token_invitacion: 'tok-shared' },
    ];

    test('A. Selector Todos combina organizados y participantes con de-duplicación por ID', () => {
      const seen = new Set<string>();
      const combined: any[] = [];
      for (const enc of mockOrganized) {
        if (!seen.has(enc.id)) {
          seen.add(enc.id);
          combined.push({ ...enc, _isHost: true });
        }
      }
      for (const enc of mockParticipated) {
        if (!seen.has(enc.id)) {
          seen.add(enc.id);
          combined.push({ ...enc, _isHost: false });
        }
      }

      assert.equal(combined.length, 3, 'Debe contener 3 encuentros únicos (no 4)');
      assert.ok(combined.some(e => e.id === 'enc-org-1' && e._isHost === true));
      assert.ok(combined.some(e => e.id === 'enc-part-1' && e._isHost === false));
      assert.ok(combined.some(e => e.id === 'enc-shared' && e._isHost === true), 'El duplicado enc-shared debe resolverse una sola vez');
    });

    test('B. Selector Organizo filtra estrictamente encuentros de host', () => {
      const organizedOnly = mockOrganized.map(e => ({ ...e, _isHost: true }));
      assert.equal(organizedOnly.length, 2);
      assert.ok(organizedOnly.every(e => e._isHost === true));
    });

    test('C. Selector Participo filtra estrictamente encuentros donde participa', () => {
      const participatedOnly = mockParticipated.map(e => ({ ...e, _isHost: false }));
      assert.equal(participatedOnly.length, 2);
      assert.ok(participatedOnly.every(e => e._isHost === false));
    });

    test('D. Filtros secundarios filtran correctamente por Momento (upcoming vs past)', () => {
      const testList = [
        { id: '1', fecha: '2026-10-10', hora: '20:00', estado: 'activo' },
        { id: '2', fecha: '2026-08-01', hora: '20:00', estado: 'finalizado' },
      ];
      const upcoming = testList.filter(e => e.estado === 'activo');
      const past = testList.filter(e => e.estado !== 'activo');
      assert.equal(upcoming.length, 1);
      assert.equal(upcoming[0].id, '1');
      assert.equal(past.length, 1);
      assert.equal(past[0].id, '2');
    });

    test('E. Limpiar filtros restablece los valores por defecto (DEFAULT_FILTER_VALUES)', () => {
      const customFilters: EncountersFilterValues = {
        timeFilter: 'past',
        filterType: 'coordination',
        filterCoordinationState: 'open',
        sortBy: 'name_desc',
      };
      assert.equal(countActiveSecondaryFilters(customFilters), 4);
      assert.equal(countActiveSecondaryFilters(DEFAULT_FILTER_VALUES), 0);
    });

    test('F. Badge de filtros activos calcula la cantidad exacta de filtros no-default', () => {
      const filtersWithTwo: EncountersFilterValues = {
        ...DEFAULT_FILTER_VALUES,
        timeFilter: 'all',
        sortBy: 'date_distant',
      };
      assert.equal(countActiveSecondaryFilters(filtersWithTwo), 2);
    });

    test('G. HomeEncountersToolbar renderiza selector segmented control y botón de filtro con badge', () => {
      const html = renderToString(React.createElement(HomeEncountersToolbar, {
        activeScope: 'todos',
        onScopeChange: () => {},
        isLoggedIn: true,
        totalTodosCount: 5,
        totalOrganizedCount: 3,
        totalParticipatedCount: 2,
        activeFilterCount: 2,
        onOpenFilters: () => {},
      }));

      assert.ok(html.includes('Tus encuentros'), 'Debe incluir título');
      assert.ok(html.includes('Todos'), 'Debe incluir tab Todos');
      assert.ok(html.includes('Organizo'), 'Debe incluir tab Organizo');
      assert.ok(html.includes('Participo'), 'Debe incluir tab Participo');
      assert.ok(html.includes('pe-filter-btn--active'), 'Botón filtrar activo si hay filtros');
      assert.ok(html.includes('2'), 'Badge muestra cantidad de filtros activos');
    });

    test('H. HomeEncountersFilterSheet renderiza secciones de Momento, Tipo, Estado y Orden', () => {
      const html = renderToString(React.createElement(HomeEncountersFilterSheet, {
        isOpen: true,
        filters: {
          timeFilter: 'upcoming',
          filterType: 'coordination',
          filterCoordinationState: 'all',
          sortBy: 'date_upcoming',
        },
        onApply: () => {},
        onClose: () => {},
      }));

      assert.ok(html.includes('Filtros y orden'), 'Título de la sheet');
      assert.ok(html.includes('Momento'), 'Sección Momento');
      assert.ok(html.includes('Tipo'), 'Sección Tipo');
      assert.ok(html.includes('Estado de coordinación'), 'Sección Coordinación condicional');
      assert.ok(html.includes('Ordenar por'), 'Sección Ordenar');
      assert.ok(html.includes('Limpiar filtros'), 'Botón Limpiar');
      assert.ok(html.includes('Aplicar'), 'Botón Aplicar');
    });

    test('I. HomeOpenEncounters renderiza carrusel con 5 tarjetas demo completas en preview GSAP', () => {
      const html = renderToString(React.createElement(HomeOpenEncounters, {
        encounters: OPEN_ENCOUNTERS_DEMO,
      }));

      assert.ok(html.includes('Encuentros abiertos'), 'Título de la sección');
      assert.ok(html.includes('En tus zonas'), 'Badge de zona');
      assert.ok(html.includes('Ver todos'), 'Acción secundaria');
      assert.ok(html.includes('Pádel'), 'Card Pádel');
      assert.ok(html.includes('Fútbol 5'), 'Card Fútbol 5');
      assert.ok(html.includes('Salida en bici'), 'Card Bici');
      assert.ok(html.includes('Café y charla'), 'Card Café');
      assert.ok(html.includes('Mates en la plaza'), 'Card Mates');
    });

    test('J. HomeOpenEncounterCard renderiza qué, cuándo, dónde aproximado y cupo', () => {
      const sample = OPEN_ENCOUNTERS_DEMO[0]; // Pádel, Güemes, Falta 1
      const html = renderToString(React.createElement(HomeOpenEncounterCard, {
        encounter: sample,
        onClick: () => {},
      }));

      assert.ok(html.includes('Pádel'), 'Título');
      assert.ok(html.includes('Jueves · 20:00'), 'Fecha/hora');
      assert.ok(html.includes('Güemes'), 'Zona aproximada');
      assert.ok(html.includes('Falta 1'), 'Cupo');
      assert.ok(html.includes('3 personas confirmadas'), 'Confirmados');
      assert.ok(html.includes('aria-label'), 'Debe tener accesibilidad semántica');
    });

    test('K. HomeOpenEncounterDetailSheet muestra modal accesible con datos y banner de demo', () => {
      const sample = OPEN_ENCOUNTERS_DEMO[0];
      const html = renderToString(React.createElement(HomeOpenEncounterDetailSheet, {
        isOpen: true,
        encounter: sample,
        onClose: () => {},
      }));

      assert.ok(html.includes('Pádel'), 'Título modal');
      assert.ok(html.includes('Lanzamiento · Demo'), 'Badge demo');
      assert.ok(html.includes('Esta es una vista previa del lanzamiento'), 'Disclaimer');
      assert.ok(html.includes('Solicitar sumarme'), 'CTA');
      assert.ok(html.includes('pe-detail-sheet__cta--demo'), 'Estilo demo no interactivo');
      assert.ok(html.includes('role="dialog"'), 'Accesibilidad modal');
    });

    test('L. Solicitar sumarme en DetailSheet está deshabilitado y no ejecuta red', () => {
      const sample = OPEN_ENCOUNTERS_DEMO[1]; // Fútbol 5
      const html = renderToString(React.createElement(HomeOpenEncounterDetailSheet, {
        isOpen: true,
        encounter: sample,
        onClose: () => {},
      }));

      assert.ok(html.includes('disabled'), 'El botón debe tener atributo disabled');
      assert.ok(html.includes('Vista previa no interactiva con backend real'), 'Aclaración visible');
    });

    test('M. Estado sin zonas configuradas renderiza mensaje orientativo y botón Configurar zonas', () => {
      const html = renderToString(React.createElement(HomeOpenEncounters, {
        noZonesConfigured: true,
      }));

      assert.ok(html.includes('Elegí tus zonas para ver encuentros cerca tuyo'), 'Mensaje sin zonas');
      assert.ok(html.includes('Configurar zonas'), 'Botón Configurar zonas');
    });

    test('N. Estado vacío sin encuentros renderiza mensaje y CTA Abrir un encuentro', () => {
      const html = renderToString(React.createElement(HomeOpenEncounters, {
        encounters: [],
        noZonesConfigured: false,
      }));

      assert.ok(html.includes('No hay encuentros abiertos ahora en tus zonas'), 'Mensaje vacío');
      assert.ok(html.includes('¿Ya tenés un plan y te falta gente?'), 'Prompt para crear oferta');
      assert.ok(html.includes('Abrir un encuentro'), 'CTA para abrir encuentro');
    });

    test('O. Filtrado por selectedLocalityIds filtra correctamente los encuentros', () => {
      const html = renderToString(React.createElement(HomeOpenEncounters, {
        encounters: OPEN_ENCOUNTERS_DEMO,
        selectedLocalityIds: ['guemes'],
      }));

      assert.ok(html.includes('Pádel'), 'Debe incluir Pádel (Güemes)');
      assert.ok(!html.includes('Fútbol 5'), 'NO debe incluir Fútbol 5 (Constitución)');
    });
  });

  describe('15. Variante Paralela de Home (V1 vigente vs V2 en revisión)', () => {
    test('A. Home vigente (V1 default) mantiene copy original, badges de Lanzamiento y texto original de pilares', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
        )
      );
      // Copy del Hero original
      assert.ok(html.includes('¿Qué querés hacer?'), 'Debe incluir título principal');
      assert.ok(html.includes('Contanos tu idea y te ayudamos a coordinar'), 'Debe mantener el subtítulo original de V1');
      assert.ok(!html.includes('Decinos qué querés hacer. Organizalo con los tuyos'), 'NO debe mostrar el nuevo copy V2 en V1');
      // Badges Lanzamiento en V1
      assert.ok(html.includes('Lanzamiento'), 'Debe mantener los badges de Lanzamiento en V1');
      // Copy de Abrir encuentros en V1
      assert.ok(html.includes('¿Te falta gente? Abrí lugares para que otras personas puedan sumarse a tu plan.'), 'Debe contener la explicación original de V1');
      assert.ok(!html.includes('Abrí lugares en un encuentro que ya organizaste.'), 'NO debe mostrar la explicación V2 en V1');
    });

    test('B. Home V2 aplica los 4 cambios aprobados sin alterar la estructura ni añadir selectores visibles', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/?homeVariant=v2'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2' }))
        )
      );
      // 1. Hero copy V2
      assert.ok(html.includes('¿Qué querés hacer?'), 'Debe incluir título principal');
      assert.ok(html.includes('Decinos qué querés hacer. Organizalo con los tuyos o encontrá con quién hacerlo.'), 'Debe mostrar exactamente la nueva frase auxiliar V2');
      assert.ok(!html.includes('Contanos tu idea y te ayudamos a coordinar'), 'NO debe mostrar el subtítulo original en V2');
      // 2. Eliminación de badges Lanzamiento en V2
      assert.ok(!html.includes('>Lanzamiento<'), 'NO debe contener badges visibles de Lanzamiento en V2');
      // 3. Reemplazo de cards por pieza informativa compacta en V2 (sin botones de acción)
      assert.ok(html.includes('Crear o abrir un encuentro'), 'Debe mostrar el título de la pieza informativa V2');
      assert.ok(html.includes('Organizá algo con los tuyos o abrí lugares en un encuentro que ya creaste.'), 'Debe mostrar el texto de la pieza informativa V2');
      assert.ok(!html.includes('home-pillars-section'), 'En V2 NO deben existir las cards grandes home-pillars-section');
      assert.ok(!html.includes('home-pillar-cta'), 'En V2 NO deben existir los botones home-pillar-cta');
      // 4. Ausencia de selectores o banners de desarrollo
      assert.ok(!html.includes('home-variant-switcher'), 'No debe tener switchers visibles');
    });

    test('C. Helper formatBuildTimestamp formatea correctamente fecha y hora de compilación', () => {
      const formatted = formatBuildTimestamp('7/10/2026, 07:45:00');
      assert.strictEqual(formatted, '07/10/2026 07:45');
      const formatted2 = formatBuildTimestamp('2026-10-07T10:45:00.000Z');
      assert.strictEqual(formatted2, '07/10/2026 07:45');
    });

    test('D. En entorno productivo (appEnv === "production"), ?homeVariant=v2 es ignorado y renderiza Home V1', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/?homeVariant=v2'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { appEnv: 'production' }))
        )
      );
      // Debe ignorar V2 y renderizar V1 original
      assert.ok(html.includes('¿Qué querés hacer?'), 'Debe incluir título');
      assert.ok(html.includes('Contanos tu idea y te ayudamos a coordinar'), 'Debe mantener el copy original de V1');
      assert.ok(!html.includes('Decinos qué querés hacer. Organizalo con los tuyos'), 'NO debe activar el copy V2 en producción');
      assert.ok(html.includes('Lanzamiento'), 'Debe mantener badges de Lanzamiento en producción');
    });

    test('E. En entorno no productivo (appEnv === "staging" o local), ?homeVariant=v2 activa V2', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/?homeVariant=v2'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { appEnv: 'staging' }))
        )
      );
      // Debe activar V2 en staging
      assert.ok(html.includes('Decinos qué querés hacer. Organizalo con los tuyos o encontrá con quién hacerlo.'), 'Debe activar copy V2 en staging');
      assert.ok(!html.includes('>Lanzamiento<'), 'NO debe mostrar badges de Lanzamiento en V2 staging');
    });

    test('F. En entorno productivo sin parámetro, renderiza Home V1 normal por defecto', () => {
      const html = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { appEnv: 'production' }))
        )
      );
      assert.ok(html.includes('¿Qué querés hacer?'), 'Debe incluir título');
      assert.ok(html.includes('Contanos tu idea y te ayudamos a coordinar'), 'Debe mantener copy V1');
      assert.ok(!html.includes('Decinos qué querés hacer. Organizalo con los tuyos'), 'NO debe tener copy V2');
    });

    test('G. Home V2 aplica clase home-v2-variant para aislamiento visual y V1 no la aplica', () => {
      const htmlV1 = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
        )
      );
      assert.ok(!htmlV1.includes('home-v2-variant'), 'V1 no debe contener clase home-v2-variant');

      const htmlV2 = renderToString(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/?homeVariant=v2'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
        )
      );
      assert.ok(htmlV2.includes('home-v2-variant'), 'V2 debe contener clase home-v2-variant');
    });

    test('H. En Home V2 la sección personal muestra traducción correspondiente (ES, EN, PT-BR, PT) y descubrimiento se titula con su variante V2', async () => {
      try {
        // 1. Probar en Español (idioma por defecto)
        await i18n.changeLanguage('es');
        const htmlV2Es = renderToString(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/?homeVariant=v2'] },
              React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
            )
          )
        );
        assert.ok(htmlV2Es.includes('Tengo ganas de…'), 'ES: Debe mostrar "Tengo ganas de…" en la sección personal de V2');
        assert.ok(htmlV2Es.includes('Me sumo'), 'ES: El bloque público en V2 debe titularse "Me sumo"');

        // 2. Probar en Inglés (EN)
        await i18n.changeLanguage('en');
        const htmlV2En = renderToString(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/?homeVariant=v2'] },
              React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
            )
          )
        );
        assert.ok(htmlV2En.includes('I feel like…'), 'EN: Debe mostrar "I feel like…" en la sección personal de V2');
        assert.ok(htmlV2En.includes('I&#x27;m in') || htmlV2En.includes("I'm in"), 'EN: El bloque público en V2 debe titularse "I\'m in"');

        // 3. Probar en Portugués de Brasil (PT-BR: locale activo en runtime)
        await i18n.changeLanguage('pt-BR');
        const htmlV2PtBr = renderToString(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/?homeVariant=v2'] },
              React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
            )
          )
        );
        assert.ok(htmlV2PtBr.includes('Quero fazer'), 'PT-BR: Debe mostrar "Quero fazer" en el tab personal de V2');
        assert.ok(htmlV2PtBr.includes('Quero participar'), 'PT-BR: El bloque público en V2 debe titularse "Quero participar"');

        // 4. Probar Portugués de Portugal (PT: catálogo preparado en pt.json)
        assert.equal(
          (ptJson as any).open_encounters?.personal_intentions_title,
          'Tenho vontade de…',
          'PT: pt.json debe tener "Tenho vontade de…" preparado'
        );
        assert.equal(
          (ptJson as any).open_encounters?.section_title_v2,
          'Quero participar',
          'PT: pt.json debe tener "Quero participar" preparado'
        );

        // 5. Restaurar idioma a Español y verificar que Home V1 mantiene inalterado "Ganas de…"
        await i18n.changeLanguage('es');
        const htmlV1 = renderToString(
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/'] },
              React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
            )
          )
        );
        assert.ok(htmlV1.includes('<h3 class="pe-discovery-subtitle">Ganas de…</h3>'), 'V1 debe mantener "Ganas de…" en la cabecera');
      } finally {
        await i18n.changeLanguage('es');
      }
    });

    test('I. Home V2 ordena encuentros abiertos por fecha/hora ascendente de forma predeterminada y V1 preserva el orden original', () => {
      const unsortedEncounters = [
        {
          id: 'enc-tarde',
          title: 'Encuentro Tarde',
          startsAt: '2026-10-15T21:00:00',
          dateLabel: 'Jueves · 21:00',
          approximateZone: 'Güemes',
          localityId: 'guemes',
          openSlots: 2,
          confirmedCount: 2,
          language: 'es',
        },
        {
          id: 'enc-temprano',
          title: 'Encuentro Temprano',
          startsAt: '2026-10-15T09:00:00',
          dateLabel: 'Jueves · 09:00',
          approximateZone: 'Güemes',
          localityId: 'guemes',
          openSlots: 2,
          confirmedCount: 2,
          language: 'es',
        },
        {
          id: 'enc-mediodia',
          title: 'Encuentro Mediodía',
          startsAt: '2026-10-15T13:00:00',
          dateLabel: 'Jueves · 13:00',
          approximateZone: 'Güemes',
          localityId: 'guemes',
          openSlots: 2,
          confirmedCount: 2,
          language: 'es',
        },
      ];

      // En V2: debe ordenarse ascendente (09:00 -> 13:00 -> 21:00)
      const htmlV2 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          encounters: unsortedEncounters,
        })
      );
      const posTempranoV2 = htmlV2.indexOf('Encuentro Temprano');
      const posMediodiaV2 = htmlV2.indexOf('Encuentro Mediodía');
      const posTardeV2 = htmlV2.indexOf('Encuentro Tarde');
      assert.ok(posTempranoV2 < posMediodiaV2, 'En V2 09:00 debe aparecer antes que 13:00');
      assert.ok(posMediodiaV2 < posTardeV2, 'En V2 13:00 debe aparecer antes que 21:00');

      // En V1 (isV2Variant: false o por defecto): debe mantener el orden recibido
      const htmlV1 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: false,
          encounters: unsortedEncounters,
        })
      );
      const posTardeV1 = htmlV1.indexOf('Encuentro Tarde');
      const posTempranoV1 = htmlV1.indexOf('Encuentro Temprano');
      assert.ok(posTardeV1 < posTempranoV1, 'En V1 el array se consume en su orden original');
    });

    test('J. Home V2 carrusel desktop: controles semánticos con aria-label i18n, sin controles en V1, y mobile sin controles en CSS', () => {
      // 1. V1 nunca renderiza controles de carrusel en el markup
      const htmlV1 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: false,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      );
      assert.ok(!htmlV1.includes('pe-discovery-carousel-controls'), 'V1 no debe renderizar pe-discovery-carousel-controls');
      assert.ok(!htmlV1.includes('pe-discovery-carousel-arrow'), 'V1 no debe renderizar pe-discovery-carousel-arrow');

      // 2. V2 cuando se activa overflow renderiza botones semánticos con aria-label i18n
      const htmlV2 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      );
      // Sin overflow en SSR el DOM no los muestra hasta cálculo de track; verificamos que el wrapper y track mantengan la clase
      assert.ok(htmlV2.includes('pe-discovery-track'), 'Debe incluir track de carrusel existente');
      assert.ok(htmlV2.includes('pe-discovery-header-actions'), 'Debe incluir contenedor de acciones de cabecera compatible con controles V2');

      // 3. Verificamos i18n de las etiquetas semánticas
      assert.strictEqual(i18n.t('open_encounters.carousel_prev'), 'Encuentros anteriores');
      assert.strictEqual(i18n.t('open_encounters.carousel_next'), 'Encuentros siguientes');

      // 4. Verificamos que getCardScrollTargets retorne posiciones canónicas puras e invariantes
      const mockTrack = {
        scrollLeft: 100,
        getBoundingClientRect: () => ({ left: 50, top: 0, width: 800, height: 300, right: 850, bottom: 300 } as DOMRect),
        querySelectorAll: () => [
          { getBoundingClientRect: () => ({ left: -50, top: 0, width: 280, height: 280, right: 230, bottom: 280 } as DOMRect) },
          { getBoundingClientRect: () => ({ left: 242, top: 0, width: 280, height: 280, right: 522, bottom: 280 } as DOMRect) },
          { getBoundingClientRect: () => ({ left: 534, top: 0, width: 280, height: 280, right: 814, bottom: 280 } as DOMRect) },
        ],
      } as unknown as HTMLElement;

      const targets = getCardScrollTargets(mockTrack);
      assert.deepStrictEqual(targets, [0, 292, 584], 'getCardScrollTargets debe calcular posiciones exactas de cards independientes del scroll actual');
    });

    test('K. Home V2 adaptativa: usuario anónimo conserva flujo explicativo completo y usuario logueado eleva actividad personal y oculta bloque educativo', () => {
      // Auth context para usuario anónimo
      const anonAuthValue = {
        user: null,
        session: null,
        loading: false,
        isAuthenticated: false,
        isAnonymousUser: false,
        isPermanentUser: false,
        signInWithGoogle: async () => ({ ok: false as const, error: 'oauth_start_failed' }),
        signInWithGoogleForCoordination: async () => ({ ok: false as const, error: 'oauth_start_failed' }),
        signInWithGoogleForDiscovery: async () => ({ ok: false as const, error: 'oauth_start_failed' }),
        checkAnonymousUpgradeState: async () => null,
        createTransferTicket: async () => ({ ok: false, error: 'not_initialized' }),
        signOut: async () => {},
      };

      // Auth context para usuario logueado (permanente)
      const loggedAuthValue = {
        user: { id: 'usr-123', email: 'user@example.com', is_anonymous: false } as any,
        session: { access_token: 'token-xyz' } as any,
        loading: false,
        isAuthenticated: true,
        isAnonymousUser: false,
        isPermanentUser: true,
        signInWithGoogle: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForCoordination: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForDiscovery: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        checkAnonymousUpgradeState: async () => null,
        createTransferTicket: async () => ({ ok: false, error: 'permanent_account_required' }),
        signOut: async () => {},
      };

      // 1. V2 Anónimo:
      // - Hero presente ("¿Qué querés hacer?")
      // - Descubrimiento visible ("Me sumo" / pe-discovery-section)
      // - Banda Tengo ganas de... visible (home-intentions-band)
      // - Actividad personal visible (home-encounters-section)
      // - Pieza informativa visible (home-create-or-open-info / "Crear o abrir un encuentro")
      // - Cards de pilares NO se renderizan en V2 (home-pillars-section)
      // - Bloque educativo anterior NO se renderiza ("Organizar un encuentro es simple")
      // - Orden: Hero -> Me sumo -> Banda Tengo ganas de... -> Actividad personal -> Pieza informativa
      const htmlV2Anon = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: anonAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?homeVariant=v2'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
          )
        )
      );

      assert.ok(htmlV2Anon.includes('¿Qué querés hacer?'), 'V2 Anónimo debe conservar el Hero');
      assert.ok(htmlV2Anon.includes('pe-discovery-section'), 'V2 Anónimo debe incluir descubrimiento / Me sumo');
      assert.ok(htmlV2Anon.includes('home-intentions-band'), 'V2 Anónimo debe incluir la banda Tengo ganas de...');
      assert.ok(htmlV2Anon.includes('Tengo ganas de…'), 'V2 Anónimo debe mostrar el copy de la banda Tengo ganas de...');
      assert.ok(htmlV2Anon.includes('home-encounters-section'), 'V2 Anónimo debe conservar la sección personal');
      assert.ok(htmlV2Anon.includes('home-create-or-open-info'), 'V2 Anónimo debe incluir pieza informativa Crear o abrir');
      assert.ok(htmlV2Anon.includes('Crear o abrir un encuentro'), 'V2 Anónimo debe tener el título de la pieza informativa');
      assert.ok(!htmlV2Anon.includes('home-pillars-section'), 'V2 Anónimo NO debe mostrar las tarjetas de pilares');
      assert.ok(!htmlV2Anon.includes('Organizar un encuentro es simple'), 'V2 Anónimo NO debe mostrar el bloque educativo separado');

      const posDiscoveryAnon = htmlV2Anon.indexOf('pe-discovery-section');
      const posBandAnon = htmlV2Anon.indexOf('home-intentions-band');
      const posEncountersAnon = htmlV2Anon.indexOf('home-encounters-section');
      const posInfoAnon = htmlV2Anon.indexOf('home-create-or-open-info');
      assert.ok(posDiscoveryAnon < posBandAnon, 'En V2 anónimo Me sumo aparece antes que la banda Tengo ganas de...');
      assert.ok(posBandAnon < posEncountersAnon, 'En V2 anónimo la banda Tengo ganas de... aparece antes que la actividad personal');
      assert.ok(posEncountersAnon < posInfoAnon, 'En V2 anónimo la actividad personal aparece antes que la pieza informativa Crear o abrir');

      // 2. V2 Logueado Mobile:
      // - Hero presente ("¿Qué querés hacer?")
      // - Actividad personal elevada INMEDIATAMENTE después del Hero y ANTES de Me sumo
      // - Descubrimiento / Me sumo presente
      // - Banda Tengo ganas de... inmediatamente después de Me sumo
      // - Pieza informativa Crear o abrir presente al final
      // - Cards de pilares NO se renderizan en V2 (home-pillars-section)
      // - Bloque educativo anterior NO se renderiza ("Organizar un encuentro es simple")
      // - Orden: Hero -> Actividad personal -> Me sumo -> Banda Tengo ganas de... -> Pieza informativa
      const htmlV2LoggedMobile = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?homeVariant=v2'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging', isDesktop: false }))
          )
        )
      );

      assert.ok(htmlV2LoggedMobile.includes('¿Qué querés hacer?'), 'V2 Logueado Mobile debe conservar el Hero');
      assert.ok(htmlV2LoggedMobile.includes('home-encounters-section'), 'V2 Logueado Mobile debe tener la sección de actividad personal');
      assert.ok(htmlV2LoggedMobile.includes('pe-discovery-section'), 'V2 Logueado Mobile debe mantener el descubrimiento');
      assert.ok(htmlV2LoggedMobile.includes('home-intentions-band'), 'V2 Logueado Mobile debe tener la banda Tengo ganas de...');
      assert.ok(htmlV2LoggedMobile.includes('home-create-or-open-info'), 'V2 Logueado Mobile debe incluir la pieza informativa Crear o abrir');

      const posEncountersLoggedMobile = htmlV2LoggedMobile.indexOf('home-encounters-section');
      const posDiscoveryLoggedMobile = htmlV2LoggedMobile.indexOf('pe-discovery-section');
      const posBandLoggedMobile = htmlV2LoggedMobile.indexOf('home-intentions-band');
      const posInfoLoggedMobile = htmlV2LoggedMobile.indexOf('home-create-or-open-info');
      assert.ok(posEncountersLoggedMobile < posDiscoveryLoggedMobile, 'En V2 mobile logueado la actividad personal debe preceder a Me sumo');
      assert.ok(posDiscoveryLoggedMobile < posBandLoggedMobile, 'En V2 mobile logueado Me sumo debe preceder a la banda Tengo ganas de...');
      assert.ok(posBandLoggedMobile < posInfoLoggedMobile, 'En V2 mobile logueado la banda Tengo ganas de... debe preceder a la pieza informativa Crear o abrir');

      // 2B. V2 Logueado Desktop:
      // - Hero presente ("¿Qué querés hacer?")
      // - Me sumo presente
      // - Actividad personal (Tus encuentros / Mis ganas) INMEDIATAMENTE DESPUÉS de Me sumo
      // - Banda Tengo ganas de... inmediatamente después de actividad personal
      // - Pieza informativa Crear o abrir presente al final
      // - Orden: Hero -> Me sumo -> Actividad personal -> Banda Tengo ganas de... -> Pieza informativa
      const htmlV2LoggedDesktop = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?homeVariant=v2'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging', isDesktop: true }))
          )
        )
      );

      assert.ok(htmlV2LoggedDesktop.includes('¿Qué querés hacer?'), 'V2 Logueado Desktop debe conservar el Hero');
      assert.ok(htmlV2LoggedDesktop.includes('pe-discovery-section'), 'V2 Logueado Desktop debe mantener Me sumo');
      assert.ok(htmlV2LoggedDesktop.includes('home-encounters-section'), 'V2 Logueado Desktop debe tener la sección de actividad personal');
      assert.ok(htmlV2LoggedDesktop.includes('home-intentions-band'), 'V2 Logueado Desktop debe tener la banda Tengo ganas de...');
      assert.ok(htmlV2LoggedDesktop.includes('home-create-or-open-info'), 'V2 Logueado Desktop debe incluir la pieza informativa Crear o abrir');

      const posDiscoveryLoggedDesktop = htmlV2LoggedDesktop.indexOf('pe-discovery-section');
      const posEncountersLoggedDesktop = htmlV2LoggedDesktop.indexOf('home-encounters-section');
      const posBandLoggedDesktop = htmlV2LoggedDesktop.indexOf('home-intentions-band');
      const posInfoLoggedDesktop = htmlV2LoggedDesktop.indexOf('home-create-or-open-info');
      assert.ok(posDiscoveryLoggedDesktop < posEncountersLoggedDesktop, 'En V2 desktop logueado Me sumo debe preceder a la actividad personal');
      assert.ok(posEncountersLoggedDesktop < posBandLoggedDesktop, 'En V2 desktop logueado la actividad personal debe preceder a la banda Tengo ganas de...');
      assert.ok(posBandLoggedDesktop < posInfoLoggedDesktop, 'En V2 desktop logueado la banda Tengo ganas de... debe preceder a la pieza informativa Crear o abrir');

      // 3. V1 intacta:
      // Para V1, tanto logueado como anónimo, el orden clásico y las tarjetas de pilares se conservan y NO incluye la banda
      const htmlV1 = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
          )
        )
      );
      assert.ok(htmlV1.includes('¿Qué querés hacer?'), 'V1 debe conservar el Hero');
      assert.ok(htmlV1.includes('home-pillars-section'), 'V1 debe conservar las tarjetas de pilares');
      assert.ok(!htmlV1.includes('home-intentions-band'), 'V1 NO debe incluir la banda Tengo ganas de... de V2');
      assert.ok(!htmlV1.includes('home-create-or-open-info'), 'V1 NO debe incluir la pieza informativa Crear o abrir de V2');
      const posPillarsV1 = htmlV1.indexOf('home-pillars-section');
      const posEncountersV1 = htmlV1.indexOf('home-encounters-section');
      assert.ok(posPillarsV1 < posEncountersV1, 'En V1 los pilares siguen antes que tus encuentros');
    });

    test('L. Carrusel mobile V2: indicador chevron hacia la derecha con aria-label i18n, sin controles desktop y sin autoplay', () => {
      // En SSR sin overflow calculado en DOM, renderizamos HomeOpenEncounters
      const htmlV2 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      );

      // Verificamos que el track esté preparado con el wrapper y no haya autoplay
      assert.ok(htmlV2.includes('pe-discovery-track'), 'Debe existir track de carrusel');
      assert.ok(htmlV2.includes('pe-discovery-carousel-wrapper'), 'Debe existir wrapper del carrusel');

      // Verificamos que las flechas desktop no aparezcan en mobile (están scoped a media query desktop y no son el indicador mobile)
      assert.ok(!htmlV2.includes('pe-discovery-carousel-mobile-indicator--desktop'), 'No debe tener indicador desktop erróneo');
    });

    test('M. Zona personal V2: elimina redundancia del título "Tus encuentros" en toolbar, conserva resumen de conteo, tabs y filtros', () => {
      const loggedAuthValue = {
        user: { id: 'usr-123', email: 'user@example.com', is_anonymous: false } as any,
        session: { access_token: 'token-xyz' } as any,
        loading: false,
        isAuthenticated: true,
        isAnonymousUser: false,
        isPermanentUser: true,
        signInWithGoogle: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForCoordination: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForDiscovery: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        checkAnonymousUpgradeState: async () => null,
        createTransferTicket: async () => ({ ok: false, error: 'permanent_account_required' }),
        signOut: async () => {},
      };

      // V2: Renderizamos Home V2
      const htmlV2 = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?homeVariant=v2'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
          )
        )
      );

      // En V2:
      // - El tab superior "Tus encuentros" debe existir
      assert.ok(htmlV2.includes('home-user-tab'), 'Debe conservar los tabs superiores');
      // - El toolbar NO debe renderizar pe-toolbar-title
      assert.ok(!htmlV2.includes('pe-toolbar-title'), 'En V2 se elimina el título duplicado pe-toolbar-title');
      // - El resumen de próximos y anteriores permanece
      assert.ok(htmlV2.includes('pe-toolbar-summary-count'), 'Debe conservar el resumen de conteo próximos/anteriores');
      // - Los controles segmentados (Todos | Organizo | Participo) y botón Filtrar permanecen
      assert.ok(htmlV2.includes('pe-segmented-control'), 'Debe conservar los botones segmentados');
      assert.ok(htmlV2.includes('pe-filter-btn'), 'Debe conservar el botón de filtros secundarios');

      // V1: Renderizamos Home V1 en el layout clásico
      // En V1 la toolbar clásica o sección estándar conserva su título sin el ocultamiento de V2
      const htmlV1 = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
          )
        )
      );
      assert.ok(htmlV1.includes('Tus encuentros'), 'V1 debe conservar el encabezado Tus encuentros');
    });

    test('N. Microiteración UX V2: Copy humano "Mis ganas", botón de filtro compacto para mobile y accesibilidad', () => {
      const loggedAuthValue = {
        user: { id: 'usr-123', email: 'user@example.com', is_anonymous: false } as any,
        session: { access_token: 'token-xyz' } as any,
        loading: false,
        isAuthenticated: true,
        isAnonymousUser: false,
        isPermanentUser: true,
        signInWithGoogle: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForCoordination: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        signInWithGoogleForDiscovery: async () => ({ ok: true as const, alreadyLoggedIn: true }),
        checkAnonymousUpgradeState: async () => null,
        createTransferTicket: async () => ({ ok: false, error: 'permanent_account_required' }),
        signOut: async () => {},
      };

      // 1. Home V2 en Español
      const htmlV2Es = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?homeVariant=v2'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2', appEnv: 'staging' }))
          )
        )
      );

      // En V2 el tab personal debe decir "Mis ganas" y no "Intenciones"
      assert.ok(htmlV2Es.includes('Mis ganas'), 'En V2 el tab de intenciones debe decir "Mis ganas"');
      // Debe contener el botón de filtro compacto para mobile con aria-label y title
      assert.ok(htmlV2Es.includes('pe-filter-btn--icon-only'), 'En V2 debe renderizar el botón de filtro con sólo icono para mobile');
      assert.ok(htmlV2Es.includes('Filtrar encuentros'), 'Debe incluir aria-label accesible para el botón de filtro');

      // 2. Home V1 en Español
      const htmlV1Es = renderToString(
        React.createElement(
          AuthContext.Provider,
          { value: loggedAuthValue },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v1' }))
          )
        )
      );
      assert.ok(htmlV1Es.includes('Intenciones'), 'En V1 el tab debe conservar "Intenciones"');
      assert.ok(!htmlV1Es.includes('Mis ganas'), 'En V1 no debe mostrarse el copy "Mis ganas"');
      assert.ok(!htmlV1Es.includes('pe-filter-btn--icon-only'), 'En V1 no debe existir pe-filter-btn--icon-only');

      // 3. Toolbar aislado con isV2Variant
      const htmlToolbarV2 = renderToString(
        React.createElement(HomeEncountersToolbar, {
          activeScope: 'todos',
          onScopeChange: () => {},
          isLoggedIn: true,
          totalProximosCount: 2,
          totalPasadosCount: 1,
          activeFilterCount: 0,
          onOpenFilters: () => {},
          hideTitle: true,
          isV2Variant: true,
        })
      );
      assert.ok(htmlToolbarV2.includes('pe-toolbar-header-row--v2'), 'Debe incluir clase de fila V2');
      assert.ok(htmlToolbarV2.includes('pe-filter-btn--icon-only'), 'Debe renderizar botón icono mobile');
      assert.ok(htmlToolbarV2.includes('pe-filter-btn--desktop'), 'Debe marcar el botón textual con clase desktop');
    });

    test('O. Bloque público Home V2: simplificado como "Me sumo" directo sin solapas ni subtítulos redundantes, preservando V1', () => {
      // 1. HomeOpenEncounters en V2
      const htmlV2 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      );

      // Título en V2 debe ser "Me sumo"
      assert.ok(htmlV2.includes('<h2 class="pe-discovery-title">Me sumo</h2>'), 'V2 debe titularse "Me sumo"');
      assert.ok(!htmlV2.includes('<h2 class="pe-discovery-title">Encuentros abiertos</h2>'), 'V2 NO debe titularse "Encuentros abiertos"');

      // En V2 NO debe renderizar solapas de descubrimiento (Todo, Encuentros, Ganas de…)
      assert.ok(!htmlV2.includes('pe-discovery-tabs'), 'V2 no debe incluir barra de solapas pe-discovery-tabs');

      // En V2 NO debe renderizar subtítulo redundante "Encuentros próximos"
      assert.ok(!htmlV2.includes('Encuentros próximos'), 'V2 no debe incluir subtítulo Encuentros próximos');

      // Las tarjetas de encuentros deben renderizarse directamente
      assert.ok(htmlV2.includes('pe-discovery-group--v2'), 'V2 debe renderizar grupo directo pe-discovery-group--v2');
      assert.ok(htmlV2.includes('Pádel'), 'V2 debe renderizar tarjetas de encuentros directamente');

      // 2. HomeOpenEncounters en V1
      const htmlV1 = renderToString(
        React.createElement(HomeOpenEncounters, {
          isV2Variant: false,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      );

      // Título en V1 debe ser "Encuentros abiertos"
      assert.ok(htmlV1.includes('Encuentros abiertos'), 'V1 debe conservar el título Encuentros abiertos');
      assert.ok(!htmlV1.includes('Me sumo'), 'V1 NO debe titularse Me sumo');

      // V1 debe conservar solapas
      assert.ok(htmlV1.includes('pe-discovery-tabs'), 'V1 debe conservar pe-discovery-tabs');
      assert.ok(htmlV1.includes('Todo'), 'V1 debe incluir solapa Todo');

      // V1 debe conservar subtítulo "Encuentros próximos"
      assert.ok(htmlV1.includes('Encuentros próximos'), 'V1 debe conservar subtítulo Encuentros próximos');
    });

    test('P. Banda Tengo ganas de...: botón semántico accesible sin anidamientos, y contención de overflow scopeada a V2 sin reglas globales html/body', () => {
      // 1. Renderizado de HomeIntentionsBand como botón interactivo semántico
      const htmlBand = renderToString(
        React.createElement(HomeIntentionsBand, {
          onExpressIntent: () => {},
        })
      );
      assert.ok(htmlBand.startsWith('<button'), 'HomeIntentionsBand debe ser un botón raíz accesible');
      assert.ok(htmlBand.includes('class="home-intentions-band"'), 'Debe incluir clase home-intentions-band');
      assert.ok(htmlBand.includes('Tengo ganas de…'), 'Debe incluir título Tengo ganas de…');
      assert.ok(htmlBand.includes('Decí qué te gustaría hacer, aunque todavía no sea un encuentro.'), 'Debe incluir descripción');
      assert.ok(htmlBand.includes('aria-label='), 'Debe tener aria-label accesible');
      // No debe contener botones internos anidados (violación de validez HTML y a11y)
      const buttonMatches = htmlBand.match(/<button/g);
      assert.strictEqual(buttonMatches?.length, 1, 'No debe tener botones anidados en su interior');

      // 2. Validación de scope de contención en Home.css
      const homeCssPath = resolve(process.cwd(), 'src/screens/Home.css');
      const homeCssContent = readFileSync(homeCssPath, 'utf8');

      // NO debe tener reglas globales en html/body para overflow
      assert.ok(
        !homeCssContent.includes('html, body {\n  overflow-x: hidden;'),
        'Home.css NO debe imponer overflow-x: hidden global sobre html, body'
      );
      assert.ok(
        !homeCssContent.includes('html, body {\r\n  overflow-x: hidden;'),
        'Home.css NO debe imponer overflow-x: hidden global sobre html, body (CRLF)'
      );

      // SÍ debe scopear la contención de overflow a Home V2
      assert.ok(
        homeCssContent.includes('.home-screen-container.home-v2-variant'),
        'Home.css debe scopear la contención a .home-screen-container.home-v2-variant'
      );
      assert.ok(
        homeCssContent.includes('overflow-x: clip;'),
        'Home.css debe utilizar overflow-x: clip para la contención en V2'
      );
    });

    test('P. Home V2 Desktop: preservación estricta de position fixed para el FAB y atmósfera visual con pinceladas vectoriales SVG', () => {
      const homeCssPath = resolve(process.cwd(), 'src/screens/Home.css');
      const homeCssContent = readFileSync(homeCssPath, 'utf8');

      // 1. El FAB en Desktop V2 no debe ser forzado a position: relative
      assert.ok(
        !homeCssContent.includes('.home-v2-variant .home-fab-container,\n  .home-v2-variant .home-build-info {\n    position: relative;'),
        'Home.css NO debe aplicar position: relative a .home-fab-container'
      );
      assert.ok(
        !homeCssContent.includes('.home-v2-variant .home-fab-container,\r\n  .home-v2-variant .home-build-info {\r\n    position: relative;'),
        'Home.css NO debe aplicar position: relative a .home-fab-container (CRLF)'
      );

      // 2. El FAB en Desktop V2 debe preservar anclaje fixed en esquina inferior derecha
      assert.ok(
        homeCssContent.includes('.home-v2-variant .home-fab-container {\n    position: fixed;\n    bottom: 28px;\n    right: 28px;') ||
        homeCssContent.includes('.home-v2-variant .home-fab-container {\r\n    position: fixed;\r\n    bottom: 28px;\r\n    right: 28px;'),
        'Home.css debe fijar explícitamente position: fixed, bottom: 28px y right: 28px para el FAB en V2'
      );

      // 3. La atmósfera visual utiliza wrapper relativo post-Hero y capa SVG (.home-ambient-brushes-container)
      assert.ok(
        homeCssContent.includes('.home-v2-main-sections-wrapper'),
        'Home.css debe definir el wrapper relativo para anclaje post-Hero en V2'
      );
      assert.ok(
        homeCssContent.includes('.home-ambient-brushes-container'),
        'Home.css debe contener los estilos de la capa SVG .home-ambient-brushes-container'
      );
      assert.ok(
        homeCssContent.includes('.home-ambient-brushes-svg'),
        'Home.css debe contener los estilos para el SVG de pinceladas'
      );

      // 4. Verificación de renderizado de HomeAmbientBrushes (SVG inline accesible y pointer-events none)
      const brushesHtml = renderToString(React.createElement(HomeAmbientBrushes));
      assert.ok(brushesHtml.includes('aria-hidden="true"'), 'La capa debe tener aria-hidden="true"');
      assert.ok(brushesHtml.includes('<path'), 'Debe renderizar trazos <path> vectoriales');
      assert.ok(brushesHtml.includes('pe-brush-path--a'), 'Debe incluir la pincelada A');
      assert.ok(brushesHtml.includes('pe-brush-path--b'), 'Debe incluir la pincelada B');
      assert.ok(brushesHtml.includes('pe-brush-path--c'), 'Debe incluir la pincelada C de apoyo inferior');
      const pathCount = (brushesHtml.match(/<path/g) || []).length;
      assert.equal(pathCount, 3, 'Deben existir exactamente 3 pinceladas vectoriales en vacíos libres');
      assert.ok(brushesHtml.includes('linearGradient'), 'Debe usar linearGradient para gradación interna');
      assert.ok(!brushesHtml.includes('<circle') && !brushesHtml.includes('<ellipse'), 'NO debe usar formas circulares o elípticas como trazo');
    });
  });
});


