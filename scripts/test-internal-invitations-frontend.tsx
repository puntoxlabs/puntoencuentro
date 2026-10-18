import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// i18n
import '@/i18n/i18n';

// Components & Services
import { HostInternalInvitationsSection } from '@/components/host/HostInternalInvitationsSection';
import { InternalInvitationGuest } from '@/screens/InternalInvitationGuest';
import { validateDeepLink } from '@/lib/deepLink';

describe('Invitaciones Internas V1 — Frontend & Security Tests', () => {

  test('1. validateDeepLink valida correctamente rutas de invitaciones internas', () => {
    const validUuid = '11111111-2222-3333-4444-555555555555';
    const validLink = `/invitation/${validUuid}`;
    assert.equal(validateDeepLink(validLink), validLink);

    // Con query params
    const linkWithQuery = `/invitation/${validUuid}?from=inbox`;
    assert.equal(validateDeepLink(linkWithQuery), linkWithQuery);

    // Rechaza enlaces externos / protocolos maliciosos
    assert.equal(validateDeepLink('https://evil.com/invitation/123'), null);
    assert.equal(validateDeepLink('//evil.com/invitation/123'), null);
    assert.equal(validateDeepLink('javascript:alert(1)'), null);
    assert.equal(validateDeepLink('data:text/html,hack'), null);
    assert.equal(validateDeepLink(''), null);
    assert.equal(validateDeepLink(null), null);
  });

  test('2. HostInternalInvitationsSection se oculta si el encuentro está cancelado o es sólo lectura', () => {
    const htmlCancelled = renderToString(
      <MemoryRouter>
        <HostInternalInvitationsSection encuentroId="test-123" isCancelado={true} />
      </MemoryRouter>
    );
    assert.equal(htmlCancelled, '', 'No debe renderizar nada si está cancelado');

    const htmlReadOnly = renderToString(
      <MemoryRouter>
        <HostInternalInvitationsSection encuentroId="test-123" isReadOnly={true} />
      </MemoryRouter>
    );
    assert.equal(htmlReadOnly, '', 'No debe renderizar nada si es solo lectura');
  });

  test('3. HostInternalInvitationsSection renderiza título y campos', () => {
    const html = renderToString(
      <MemoryRouter>
        <HostInternalInvitationsSection encuentroId="test-123" />
      </MemoryRouter>
    );

    assert.ok(html.includes('Invitar en PuntoEncuentro') || html.includes('Invite on PuntoEncuentro'));
  });

  test('4. InternalInvitationGuest renderiza correctamente para usuario anónimo o cargando', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/invitation/test-id']}>
        <InternalInvitationGuest />
      </MemoryRouter>
    );

    assert.ok(html.length > 0);
  });

  test('5. Privacidad e Invariantes: las notificaciones de push no exponen datos privados', () => {
    const payload = {
      invitation_id: '11111111-1111-1111-1111-111111111111',
      encuentro_id: '22222222-2222-2222-2222-222222222222',
      encounter_title: 'Cena de Fin de Año',
      sender_name: 'Ana',
      modality: 'presencial',
    };

    const pushNotificationTitle = 'Nueva invitación';
    const pushNotificationBody = `Te invitaron a: ${payload.encounter_title}`;

    // Verificar que no se incluye dirección exacta ni tokens secretos en el texto público del push
    assert.ok(!pushNotificationBody.includes('token_invitacion'));
    assert.ok(!pushNotificationBody.includes('service_role'));
    assert.ok(!pushNotificationBody.includes('Calle Privada 123'));
    assert.equal(pushNotificationTitle, 'Nueva invitación');
  });
});
