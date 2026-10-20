import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Panel de Información y Mensajes — Pruebas Frontend & UI', () => {
  const panelTsx = fs.readFileSync(
    path.resolve(rootDir, 'src/components/messages/EncounterMessagesPanel.tsx'),
    'utf8'
  );
  const panelCss = fs.readFileSync(
    path.resolve(rootDir, 'src/components/messages/EncounterMessagesPanel.css'),
    'utf8'
  );
  const esJson = JSON.parse(
    fs.readFileSync(path.resolve(rootDir, 'src/i18n/locales/es.json'), 'utf8')
  );
  const enJson = JSON.parse(
    fs.readFileSync(path.resolve(rootDir, 'src/i18n/locales/en.json'), 'utf8')
  );

  test('1. Traducciones completas en español e inglés', () => {
    assert.ok(esJson.encounter_messages, 'es.json debe tener namespace encounter_messages');
    assert.ok(enJson.encounter_messages, 'en.json debe tener namespace encounter_messages');

    const expectedKeys = [
      'title',
      'highlighted_title',
      'highlighted_badge',
      'host_badge',
      'reply_btn',
      'edit_btn',
      'delete_btn',
      'pin_btn',
      'unpin_btn',
      'save_btn',
      'cancel_btn',
      'send_btn',
      'replying_to',
      'edited_indicator',
      'deleted_message',
      'empty_state',
      'writing_window_closed',
      'guest_pending_prompt',
      'rate_limit_error',
      'max_highlights_error',
      'delete_confirm',
      'edit_expired_error',
      'cannot_edit_highlighted',
      'placeholder',
      'history_retention_expired',
      'history_purged',
      'meeting_cancelled',
      'unauthorized_access',
    ];

    for (const key of expectedKeys) {
      assert.ok(esJson.encounter_messages[key], `Falta key ${key} en es.json`);
      assert.ok(enJson.encounter_messages[key], `Falta key ${key} en en.json`);
    }
  });

  test('2. Limite de 500 caracteres verificado en textarea y contador visual', () => {
    assert.ok(panelTsx.includes('maxLength={500}'), 'Textarea debe tener maxLength={500}');
    assert.ok(panelTsx.includes('nuevoMensaje.length}/500'), 'Debe renderizar contador {length}/500');
    assert.ok(panelTsx.includes('pe-msg-char-counter--limit'), 'Debe incluir clase CSS cuando se acerca al límite');
  });

  test('3. Smart Polling cada 20 segundos con control de visibilidad de pestaña', () => {
    assert.ok(panelTsx.includes('20000'), 'Polling interval debe ser 20000 ms (20 segundos)');
    assert.ok(panelTsx.includes("document.visibilityState !== 'visible'"), 'No debe consultar si la pestaña está oculta');
    assert.ok(panelTsx.includes("visibilitychange"), 'Debe escuchar evento visibilitychange');
    assert.ok(panelTsx.includes("document.removeEventListener('visibilitychange'"), 'Debe limpiar listener de visibilitychange');
    assert.ok(panelTsx.includes("clearInterval(pollTimerRef.current)"), 'Debe limpiar timer al desmontar');
  });

  test('4. Respuestas anidadas a un solo nivel con píldora de contexto', () => {
    assert.ok(panelTsx.includes('pe-msg-replying-pill'), 'Debe incluir píldora de respuesta activa');
    assert.ok(panelTsx.includes('replyMap'), 'Debe mapear respuestas hijas');
    assert.ok(panelTsx.includes('pe-msg-item--reply'), 'Debe aplicar estilo identado de respuesta');
    assert.ok(panelCss.includes('.pe-msg-item--reply'), 'CSS debe definir identación para respuestas');
  });

  test('5. Estados de interfaz: Vacío, Restringido, Pendiente y Cargando', () => {
    assert.ok(panelTsx.includes('pe-msg-empty'), 'Debe contener estado vacío');
    assert.ok(panelTsx.includes('writingWindowClosed'), 'Debe contemplar estado de ventana de escritura cerrada');
    assert.ok(panelTsx.includes('guest_pending_prompt'), 'Debe mostrar prompt para invitados pendientes');
    assert.ok(panelTsx.includes('pe-msg-spinner'), 'Debe mostrar spinner mientras publica o carga');
  });

  test('6. Acciones contextuales para autor y organizador', () => {
    assert.ok(panelTsx.includes('msg.puede_editar'), 'Debe validar puede_editar para autor');
    assert.ok(panelTsx.includes('msg.puede_eliminar'), 'Debe validar puede_eliminar');
    assert.ok(panelTsx.includes('handleToggleDestacado'), 'Debe permitir al organizador destacar');
  });

  test('7. Integración en pantallas del proyecto', () => {
    const detailHostTsx = fs.readFileSync(path.resolve(rootDir, 'src/screens/DetailHost.tsx'), 'utf8');
    const inviteGuestTsx = fs.readFileSync(path.resolve(rootDir, 'src/screens/InviteGuest.tsx'), 'utf8');
    const coordHostTsx = fs.readFileSync(path.resolve(rootDir, 'src/screens/DetailHostCoordination.tsx'), 'utf8');
    const coordGuestTsx = fs.readFileSync(path.resolve(rootDir, 'src/screens/InviteCoordination/index.tsx'), 'utf8');
    const openEncounterSheetTsx = fs.readFileSync(
      path.resolve(rootDir, 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );

    assert.ok(detailHostTsx.includes('<EncounterMessagesPanel'), 'DetailHost debe integrar EncounterMessagesPanel');
    assert.ok(inviteGuestTsx.includes('<EncounterMessagesPanel'), 'InviteGuest debe integrar EncounterMessagesPanel');
    assert.ok(coordHostTsx.includes('<EncounterMessagesPanel'), 'DetailHostCoordination debe integrar EncounterMessagesPanel');
    assert.ok(coordGuestTsx.includes('<EncounterMessagesPanel'), 'InviteCoordination debe integrar EncounterMessagesPanel');
    assert.ok(openEncounterSheetTsx.includes('<EncounterMessagesPanel'), 'HomeOpenEncounterDetailSheet debe integrar EncounterMessagesPanel');
  });

  test('8. Estados diferenciados de retención y ciclo de vida (vencido, purgado, cancelado, no autorizado)', () => {
    assert.ok(panelTsx.includes('history_retention_expired'), 'Debe distinguir error de retención expirada');
    assert.ok(panelTsx.includes('history_purged'), 'Debe distinguir error de historial purgado');
    assert.ok(panelTsx.includes('meeting_cancelled'), 'Debe distinguir error de encuentro cancelado');
    assert.ok(panelTsx.includes('unauthorized'), 'Debe distinguir error de acceso no autorizado');
    assert.ok(panelTsx.includes('pe-msg-banner--info'), 'Debe usar banner informativo para historial expirado/purgado');
  });
});
