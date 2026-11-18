import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Home, {
  isHomeV3PreviewAllowed,
  isHomeV3dPreviewAllowed,
  isLocalDevAuthFixtureAllowed,
  resolveEffectiveHomeVariant,
  STAGING_DEFAULT_HOME_VARIANT,
} from '../src/screens/Home';
import { HomeDualPathHeroPreview } from '../src/components/home/index';
import { HomeOpenEncounters, INSPIRATIONAL_IDEAS } from '../src/components/home/openEncounters/HomeOpenEncounters';
import { OPEN_ENCOUNTERS_DEMO } from '../src/components/home/openEncounters/demoData';
import { AuthContext } from '../src/contexts/AuthContext';
import { NotificationsProvider } from '../src/contexts/NotificationsContext';
import i18n from '../src/i18n/i18n';

const visitorAuthValue = {
  user: null,
  session: null,
  loading: false,
  isTransferClaimPending: false,
  transferClaimStatus: 'idle' as const,
  transferClaimError: null,
  retryTransferClaim: async () => false,
  isAuthenticated: false,
  isAnonymousUser: false,
  isPermanentUser: false,
  signInWithGoogle: async () => ({ ok: true as const, alreadyLoggedIn: false }),
  signInWithGoogleForCoordination: async () => ({ ok: true as const, alreadyLoggedIn: false }),
  signInWithGoogleForDiscovery: async () => ({ ok: true as const, alreadyLoggedIn: false }),
  checkAnonymousUpgradeState: async () => null,
  createTransferTicket: async () => ({ ok: false, error: 'not_applicable' }),
  signOut: async () => {},
};

const permanentAuthValue = {
  ...visitorAuthValue,
  user: { id: 'qa-empty-user', email: 'ana@ejemplo.local', is_anonymous: false } as unknown as React.ComponentProps<typeof AuthContext.Provider>['value']['user'],
  isAuthenticated: true,
  isPermanentUser: true,
};

describe('Home V3-D — Aislamiento, Guards y Simplificación Contextual', () => {
  test('1. isHomeV3dPreviewAllowed habilita desarrollo local y Staging autorizado, y bloquea Producción u orígenes no autorizados', () => {
    assert.equal(STAGING_DEFAULT_HOME_VARIANT, 'v3c', 'El default de Staging debe seguir siendo v3c');

    assert.equal(
      isHomeV3dPreviewAllowed({
        appEnv: 'development',
        hostname: 'localhost',
        origin: 'http://localhost:5173',
      }),
      true
    );
    assert.equal(
      isHomeV3dPreviewAllowed({
        appEnv: 'staging',
        hostname: 'staging.puntoencuentro.com.ar',
        origin: 'https://staging.puntoencuentro.com.ar',
      }),
      true
    );
    assert.equal(
      isHomeV3dPreviewAllowed({
        appEnv: 'staging',
        hostname: 'preview-no-autorizado.vercel.app',
        origin: 'https://preview-no-autorizado.vercel.app',
      }),
      false,
      'Debe rechazar orígenes arbitrarios incluso con appEnv=staging'
    );
    assert.equal(
      isHomeV3dPreviewAllowed({
        appEnv: 'production',
        hostname: 'puntoencuentro.com.ar',
        origin: 'https://puntoencuentro.com.ar',
      }),
      false
    );
    assert.equal(
      isHomeV3dPreviewAllowed({
        appEnv: 'production',
        hostname: 'staging.puntoencuentro.com.ar',
        origin: 'https://staging.puntoencuentro.com.ar',
      }),
      false,
      'En appEnv=production debe bloquearse siempre'
    );
    assert.equal(
      isLocalDevAuthFixtureAllowed({
        appEnv: 'staging',
        protocol: 'https:',
        hostname: 'staging.puntoencuentro.com.ar',
        origin: 'https://staging.puntoencuentro.com.ar',
      }),
      false,
      'previewAuth=permanent debe permanecer prohibido en Staging'
    );
  });

  test('2. Matriz de variantes: local dev, Staging autorizado (default v3c, /preview/home-v3d -> v3d) y Producción (v2 bloqueando v3d)', () => {
    // Desarrollo local: default v2, V3-D explícita -> v3d
    assert.equal(
      resolveEffectiveHomeVariant({
        appEnv: 'development',
        origin: 'http://localhost:5173',
        hostname: 'localhost',
      }),
      'v2'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        propHomeVariant: 'v3d',
        appEnv: 'development',
        origin: 'http://localhost:5173',
        hostname: 'localhost',
      }),
      'v3d'
    );

    // Staging autorizado: "/" permanece v3c; prop y query v3d habilitan v3d; v3c/v2/v1 preservados
    assert.equal(
      resolveEffectiveHomeVariant({
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v3c',
      'Staging sin selección explícita debe seguir mostrando V3-C'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        propHomeVariant: 'v3d',
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v3d'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        queryHomePreview: 'v3d',
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v3d'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        queryHomeVariant: 'v3d',
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v3d'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        propHomeVariant: 'v2',
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v2'
    );
    assert.equal(
      resolveEffectiveHomeVariant({
        queryHomeVariant: 'v1',
        appEnv: 'staging',
        origin: 'https://staging.puntoencuentro.com.ar',
        hostname: 'staging.puntoencuentro.com.ar',
      }),
      'v1'
    );

    // Origen no autorizado no habilita v3d ni v3c
    assert.equal(
      resolveEffectiveHomeVariant({
        propHomeVariant: 'v3d',
        queryHomePreview: 'v3d',
        appEnv: 'staging',
        origin: 'https://preview-no-autorizado.vercel.app',
        hostname: 'preview-no-autorizado.vercel.app',
      }),
      'v2'
    );

    // Producción: "/" = v2 y cualquier intento de v3d por prop/query se ignora
    assert.equal(
      resolveEffectiveHomeVariant({
        propHomeVariant: 'v3d',
        queryHomePreview: 'v3d',
        queryHomeVariant: 'v3d',
        appEnv: 'production',
        origin: 'https://puntoencuentro.com.ar',
        hostname: 'puntoencuentro.com.ar',
      }),
      'v2',
      'Producción debe ignorar v3d en prop o query y conservar v2'
    );
  });

  test('3. App.tsx registra /preview/home-v3d bajo isHomeV3dPreviewAllowed() y dentro de AccessGate', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    assert.ok(appSource.includes('isHomeV3dPreviewAllowed()'));
    assert.ok(appSource.includes('{v3dPreviewAllowed && ('));
    assert.ok(appSource.includes('/preview/home-v3d'));
    assert.ok(appSource.includes('<AccessGate>'));
    assert.equal(isHomeV3PreviewAllowed({
      appEnv: 'staging',
      origin: 'https://staging.puntoencuentro.com.ar',
      hostname: 'staging.puntoencuentro.com.ar',
    }), true);
  });

  test('4. HomeDualPathHeroPreview aísla clases v3d sin alterar v3c', () => {
    const htmlV3d = renderToString(
      React.createElement(HomeDualPathHeroPreview, {
        variant: 'v3d',
        onCreateInvitationClick: () => {},
        onIntentSubmit: () => {},
      })
    );
    assert.ok(htmlV3d.includes('home-dual-hero--v3d'));
    assert.ok(htmlV3d.includes('home-v3d-grid'));
    assert.ok(!htmlV3d.includes('home-dual-hero--v3c'));

    const htmlV3c = renderToString(
      React.createElement(HomeDualPathHeroPreview, {
        variant: 'v3c',
        onCreateInvitationClick: () => {},
        onIntentSubmit: () => {},
      })
    );
    assert.ok(htmlV3c.includes('home-dual-hero--v3c'));
    assert.ok(!htmlV3c.includes('home-dual-hero--v3d'));
  });

  test('5. Discovery V3-D simplifica Estados A y B preservando callbacks e ideas, y conserva Estado C completo', () => {
    const htmlStateA = renderToString(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          variantV3D: true,
          compactV3C: true,
          noZonesConfigured: true,
          isLoading: false,
          encounters: [],
        })
      )
    );
    assert.ok(htmlStateA.includes('pe-discovery-section--v3d'));
    assert.ok(!htmlStateA.includes('data-testid="discovery-filter-btn"'), 'Estado A no debe mostrar filtro sin encuentros');
    assert.ok(!htmlStateA.includes('data-testid="discovery-avisame-btn"'), 'Estado A no debe duplicar Avisame en cabecera');
    assert.ok(htmlStateA.includes('Configurar zonas'));
    assert.ok(htmlStateA.includes('Abrir un encuentro'));
    assert.ok(htmlStateA.includes('Avisame si aparece uno'));
    for (const idea of INSPIRATIONAL_IDEAS) {
      assert.ok(htmlStateA.includes(`inspirational-card-${idea.id}`));
    }

    const htmlStateB = renderToString(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          variantV3D: true,
          compactV3C: true,
          noZonesConfigured: false,
          selectedLocalityIds: ['puerto-mogotes'],
          isLoading: false,
          encounters: [],
        })
      )
    );
    assert.ok(!htmlStateB.includes('data-testid="discovery-filter-btn"'), 'Estado B no debe mostrar filtro sin encuentros');
    assert.ok(htmlStateB.includes('Avisame si aparece uno'));
    assert.ok(htmlStateB.includes('Cambiar o sumar zonas'));

    const htmlStateC = renderToString(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(HomeOpenEncounters, {
          isV2Variant: true,
          variantV3D: true,
          compactV3C: true,
          noZonesConfigured: false,
          selectedLocalityIds: ['centro', 'guemes'],
          isLoading: false,
          encounters: OPEN_ENCOUNTERS_DEMO,
        })
      )
    );
    assert.ok(htmlStateC.includes('data-testid="discovery-filter-btn"'), 'Estado C debe mostrar filtro');
    assert.ok(htmlStateC.includes('data-testid="discovery-avisame-btn"'), 'Estado C debe mostrar Avisame');
    assert.ok(htmlStateC.includes('data-testid="discovery-see-in-list-btn"'), 'Estado C debe mostrar Ver en lista');
  });

  test('6. Home V3-D en Mi espacio oculta toolbar secundaria cuando hay 0 encuentros y conserva las 3 pestañas', () => {
    const htmlAuthEmpty = renderToString(
      React.createElement(
        AuthContext.Provider,
        { value: permanentAuthValue },
        React.createElement(
          I18nextProvider,
          { i18n },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/preview/home-v3d'] },
            React.createElement(
              NotificationsProvider,
              null,
              React.createElement(Home, { homeVariant: 'v3d', forcedVariant: 'gsap', appEnv: 'development' })
            )
          )
        )
      )
    );
    assert.ok(htmlAuthEmpty.includes('home-v3d-variant'));
    assert.ok(!htmlAuthEmpty.includes('home-v3c-variant'));
    assert.ok(htmlAuthEmpty.includes('Mis encuentros'));
    assert.ok(htmlAuthEmpty.includes('Mis ganas'));
    assert.ok(htmlAuthEmpty.includes('Mis solicitudes'));
    assert.ok(htmlAuthEmpty.includes('v3d-discovery-scroll-cue'), 'V3-D debe incluir indicador discreto Explorá encuentros');
    assert.ok(!htmlAuthEmpty.includes('pe-toolbar-container'), 'Con 0 encuentros debe simplificar toolbar secundaria');

    const v3dCss = readFileSync(resolve(process.cwd(), 'src/components/home/HomeV3d.css'), 'utf8');
    assert.ok(v3dCss.includes('.home-gsap-mobile-frag'), 'V3-D oculta fragmentos fotográficos móviles');
    const mobile639Block = v3dCss.match(/@media \(max-width:\s*639px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const mobile767Block = v3dCss.match(/@media \(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.ok(mobile639Block.includes('.home-gsap-mobile-frag'), 'V3-D móvil oculta fotos laterales');
    assert.ok(!mobile639Block.includes('.home-gsap-tag') && !mobile767Block.includes('display: none'), 'V3-D móvil no debe ocultar etiquetas GSAP');
    assert.ok(v3dCss.includes('.home-v3d-discovery-cue'));
    assert.ok(v3dCss.includes('#D2F3EC'));
  });
});
