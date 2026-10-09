import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { ReportPublicEncounterModal } from '../src/components/home/openEncounters/ReportPublicEncounterModal';
import { HostOpenEncounterSection } from '../src/components/host/HostOpenEncounterSection';

// Cargar traducciones
const esJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/es.json'), 'utf-8'));
const enJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/en.json'), 'utf-8'));
const ptJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt.json'), 'utf-8'));
const ptBrJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt-BR.json'), 'utf-8'));

describe('Moderación Pública v1: Tests de UX / UI Frontend', () => {

  describe('1. i18n — Consistencia Multilingüe de Moderación y Reporte', () => {
    const requiredKeys = [
      'report_action',
      'reported_status',
      'report_modal_title',
      'report_modal_intro',
      'report_reason_spam',
      'report_reason_inappropriate',
      'report_reason_fraud',
      'report_reason_harassment',
      'report_reason_other',
      'report_comment_label',
      'report_cancel',
      'report_submit',
      'report_success_title',
      'report_success_desc',
      'report_already_reported',
      'status_review_badge',
      'status_rejected_badge',
      'status_hidden_badge',
      'review_pending_notice',
      'rejected_notice',
      'hidden_review_notice',
      'post_edit_review_notice',
      'action_edit_publication',
    ];

    test('Todas las claves requeridas existen en es.json', () => {
      for (const k of requiredKeys) {
        assert.ok(
          esJson.open_encounters[k],
          `Falta la clave open_encounters.${k} en es.json`
        );
      }
    });

    test('Todas las claves requeridas existen en en.json', () => {
      for (const k of requiredKeys) {
        assert.ok(
          enJson.open_encounters[k],
          `Falta la clave open_encounters.${k} en en.json`
        );
      }
    });

    test('Todas las claves requeridas existen en pt.json', () => {
      for (const k of requiredKeys) {
        assert.ok(
          ptJson.open_encounters[k],
          `Falta la clave open_encounters.${k} en pt.json`
        );
      }
    });

    test('Todas las claves requeridas existen en pt-BR.json', () => {
      for (const k of requiredKeys) {
        assert.ok(
          ptBrJson.open_encounters[k],
          `Falta la clave open_encounters.${k} en pt-BR.json`
        );
      }
    });

    test('Copys no contienen terminología acusatoria ni detalles internos filtrados', () => {
      const allText = JSON.stringify(esJson.open_encounters);
      assert.ok(!allText.includes('denunciar usuario'), 'No debe decir denunciar usuario');
      assert.ok(!allText.includes('infracción'), 'No debe decir infracción');
      assert.ok(!allText.includes('violaste nuestras normas'), 'No debe acusar de violación de normas');
      assert.ok(!allText.includes('umbral'), 'No debe filtrar umbral');
      assert.ok(!allText.includes('auto_hide'), 'No debe filtrar auto_hide');
      assert.ok(!allText.includes('content_moderation_blocked'), 'No debe filtrar código interno');
    });
  });

  describe('2. ReportPublicEncounterModal — Estructura y Accesibilidad', () => {
    test('Renderiza modal accesible con dialog semántico y radio buttons', () => {
      const html = renderToString(
        React.createElement(ReportPublicEncounterModal, {
          isOpen: true,
          onClose: () => {},
          encuentroId: 'enc-test-123',
          encounterTitle: 'Cena en Güemes',
        })
      );

      assert.ok(html.includes('role="dialog"'), 'Debe tener role="dialog"');
      assert.ok(html.includes('aria-modal="true"'), 'Debe tener aria-modal="true"');
      assert.ok(html.includes('id="pe-report-public-title"'), 'Debe tener pe-report-public-title');
      assert.ok(html.includes('Cena en Güemes'), 'Debe mostrar el título del encuentro reportado');
      assert.ok(html.includes('type="radio"'), 'Debe renderizar opciones de radio');
      assert.ok(html.includes('id="report-reason-spam"'), 'Debe incluir opción spam');
      assert.ok(html.includes('id="report-reason-inappropriate_content"'), 'Debe incluir opción contenido inapropiado');
      assert.ok(html.includes('id="report-reason-fraud_scam"'), 'Debe incluir opción engaño o estafa');
      assert.ok(html.includes('id="report-reason-harassment"'), 'Debe incluir opción acoso');
      assert.ok(html.includes('id="report-reason-other"'), 'Debe incluir opción otro');
      assert.ok(html.includes('id="report-comment-input"'), 'Debe incluir textarea con id asociado a label');
    });

    test('Modal no renderiza nada si isOpen es false', () => {
      const html = renderToString(
        React.createElement(ReportPublicEncounterModal, {
          isOpen: false,
          onClose: () => {},
          encuentroId: 'enc-test-123',
        })
      );

      assert.equal(html, '', 'No debe renderizar nada si isOpen es false');
    });
  });

  describe('3. HomeOpenEncounterDetailSheet — Botón Reportar y Protección de Host', () => {
    test('Código fuente garantiza que el propio host NO ve el botón reportar', () => {
      const sheetPath = path.resolve(
        process.cwd(),
        'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'
      );
      const code = fs.readFileSync(sheetPath, 'utf-8');

      assert.ok(
        code.includes('const isHost = Boolean('),
        'Debe calcular isHost a partir de credenciales locales/identidad'
      );
      assert.ok(
        code.includes('!isDemo && !isHost'),
        'El botón reportar debe estar condicionado por !isDemo && !isHost'
      );
      assert.ok(
        code.includes('pe-detail-sheet__btn-report'),
        'Debe utilizar la clase CSS pe-detail-sheet__btn-report'
      );
    });

    test('Código fuente restaura contexto de reporte pendiente post-OAuth', () => {
      const sheetPath = path.resolve(
        process.cwd(),
        'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'
      );
      const code = fs.readFileSync(sheetPath, 'utf-8');

      assert.ok(
        code.includes('PENDING_OPEN_REPORT_KEY'),
        'Debe contemplar la clave PENDING_OPEN_REPORT_KEY'
      );
      assert.ok(
        code.includes('sessionStorage.getItem(PENDING_OPEN_REPORT_KEY)'),
        'Debe consultar el reporte pendiente al volver de login'
      );
      assert.ok(
        code.includes('setPendingReportData'),
        'Debe restaurar los datos del reporte guardado'
      );
    });
  });

  describe('4. HostOpenEncounterSection — Estados y Acciones del Anfitrión', () => {
    test('Estado review_pending muestra badge "En revisión", copy claro y acción de editar', () => {
      const encounterReview = {
        id: 'enc-review-001',
        titulo: 'Tarde de Juegos',
        is_open: false,
        moderation_status: 'review_pending',
        max_participants: 6,
        open_description: 'Vení a jugar juegos de mesa en café.',
        open_public_zone: 'Güemes',
      };

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: encounterReview,
          hostId: 'host-1',
          confirmedCount: 1,
          onRefresh: () => {},
          onParticipantAdded: () => {},
        })
      );

      assert.ok(html.includes('pe-host-open-card__badge--review'), 'Debe tener badge de revisión');
      assert.ok(html.includes('En revisión'), 'Debe decir En revisión');
      assert.ok(
        html.includes('Estamos revisando esta publicación antes de mostrarla públicamente.'),
        'Debe mostrar aviso de revisión'
      );
      assert.ok(
        html.includes('Mientras tanto, tu encuentro sigue activo y no necesitás volver a publicarlo.'),
        'Debe calmar al host indicando que sigue activo'
      );
      assert.ok(
        html.includes('Editar publicación'),
        'Debe ofrecer acción de editar'
      );
      assert.ok(
        !html.includes('Reabrir este encuentro para sumarse'),
        'NO debe ofrecer botón contradictorio de abrir en loop mientras está en revisión'
      );
    });

    test('Estado rejected muestra badge "No publicada", copy orientativo y acción de editar', () => {
      const encounterRejected = {
        id: 'enc-rej-001',
        titulo: 'Reunión rara',
        is_open: false,
        moderation_status: 'rejected',
        max_participants: 6,
        open_description: 'Texto bloqueado',
        open_public_zone: 'Güemes',
      };

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: encounterRejected,
          hostId: 'host-1',
          confirmedCount: 1,
          onRefresh: () => {},
          onParticipantAdded: () => {},
        })
      );

      assert.ok(html.includes('pe-host-open-card__badge--rejected'), 'Debe tener badge rejected');
      assert.ok(html.includes('No publicada'), 'Debe decir No publicada');
      assert.ok(
        html.includes('Esta publicación no puede mostrarse públicamente con el contenido actual. Podés editarla e intentarlo nuevamente.'),
        'Debe mostrar mensaje orientativo y no acusatorio'
      );
      assert.ok(
        html.includes('Editar publicación'),
        'Debe permitir editar para corregir'
      );
    });

    test('Estado hidden_pending_review oculta detalles de reportes y mantiene neutralidad', () => {
      const encounterHidden = {
        id: 'enc-hidden-001',
        titulo: 'Reunión reportada',
        is_open: false,
        moderation_status: 'hidden_pending_review',
        max_participants: 6,
        open_description: 'Texto pausado',
        open_public_zone: 'Güemes',
      };

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: encounterHidden,
          hostId: 'host-1',
          confirmedCount: 1,
          onRefresh: () => {},
          onParticipantAdded: () => {},
        })
      );

      assert.ok(html.includes('pe-host-open-card__badge--hidden'), 'Debe tener badge hidden');
      assert.ok(html.includes('En revisión'), 'Debe mostrar badge neutral En revisión');
      assert.ok(
        html.includes('Esta publicación está temporalmente en revisión. Mientras la revisamos, no se muestra en Me sumo.'),
        'Debe mostrar aviso neutro sin revelar reportes'
      );
      assert.ok(
        !html.includes('3 personas'),
        'NO debe revelar conteo de reportantes'
      );
      assert.ok(
        !html.includes('tras reportes de la comunidad'),
        'NO debe acusar ni alarmar con reportes'
      );
    });

    test('Estado approved / abierto muestra badge activo y acciones de editar y dejar de mostrar', () => {
      const encounterOpen = {
        id: 'enc-open-001',
        titulo: 'Picnic en la Plaza',
        is_open: true,
        moderation_status: 'approved',
        max_participants: 6,
        open_description: 'Picnic al sol',
        open_public_zone: 'Plaza Mitre',
      };

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: encounterOpen,
          hostId: 'host-1',
          confirmedCount: 2,
          onRefresh: () => {},
          onParticipantAdded: () => {},
        })
      );

      assert.ok(html.includes('pe-host-open-card__badge--active'), 'Debe tener badge activo');
      assert.ok(html.includes('Abierto para sumarse'), 'Debe decir Abierto para sumarse');
      assert.ok(html.includes('Editar publicación'), 'Debe incluir botón de editar');
      assert.ok(html.includes('Dejar de mostrar'), 'Debe incluir botón de cerrar discovery');
    });
  });

  describe('5. LoginRequiredSheet — Integración report_encounter', () => {
    test('LoginRequiredSheet define título y beneficios específicos para report_encounter', () => {
      const sheetPath = path.resolve(
        process.cwd(),
        'src/components/auth/LoginRequiredSheet.tsx'
      );
      const code = fs.readFileSync(sheetPath, 'utf-8');

      assert.ok(
        code.includes("'report_encounter'"),
        'Debe incluir report_encounter en el tipo de acción'
      );
      assert.ok(
        code.includes('Para reportar un encuentro necesitás una cuenta'),
        'Debe tener copy específico para report_encounter'
      );
      assert.ok(
        code.includes('Prevenir spam y reportes falsos'),
        'Debe incluir beneficio antiabuso'
      );
    });
  });
});
