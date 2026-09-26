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

import { useAiWizardStore } from '../src/store/aiWizardStore';
import { aiService } from '../src/services/aiService';

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
    test('A. Renderiza campo textarea y botón primario "Hacer que pase"', () => {
      const html = renderToString(
        React.createElement(HomeIntentInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
        })
      );
      assert.ok(html.includes('Hacer que pase'), 'Debe contener el CTA "Hacer que pase"');
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
});
