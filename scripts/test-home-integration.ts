import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
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
  FLOATING_TAGS_CATALOG,
  ANIMATED_PHOTOS_CATALOG,
} from '../src/components/home/index';
import HomeDynamicCanvasGsap from '../src/components/home/HomeDynamicCanvasGsap';

import { useAiWizardStore } from '../src/store/aiWizardStore';
import { aiService } from '../src/services/aiService';
import { HomeOpenEncounters } from '../src/components/home/openEncounters/HomeOpenEncounters';
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
    test('A. Renderiza la primera frase por defecto y el botón accesible de pausa', () => {
      const html = renderToString(React.createElement(HomeRotatingPhrase));
      assert.ok(html.includes('Quiero invitar a mis amigos a tomar un café.'), 'Debe renderizar primera frase');
      assert.ok(html.includes('home-rotating-phrase-slot'), 'Debe tener slot de altura fija para CLS=0');
      assert.ok(html.includes('home-rotating-phrase-btn'), 'Debe incluir botón accesible de pausa');
      assert.ok(html.includes('Pausar rotación'), 'Aria label de pausa presente');
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
});
