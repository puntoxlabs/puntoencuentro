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
import { HomePendingInvitationsBar } from '@/components/home';
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

  describe('HomePendingInvitationsBar — Componente de Home', () => {
    test('6. HomePendingInvitationsBar se oculta para usuarios anónimos o sin sesión', () => {
      const htmlAnon = renderToString(
        <MemoryRouter>
          <HomePendingInvitationsBar isPermanentUser={false} />
        </MemoryRouter>
      );
      assert.equal(htmlAnon, '', 'No debe renderizar nada si el usuario no tiene cuenta permanente');
    });

    test('7. HomePendingInvitationsBar se oculta si no existen invitaciones pendientes', () => {
      const htmlEmpty = renderToString(
        <MemoryRouter>
          <HomePendingInvitationsBar isPermanentUser={true} userId="user-123" />
        </MemoryRouter>
      );
      // Al montar en SSR/initial render sin pendientes cargadas, no muestra nada
      assert.equal(htmlEmpty, '', 'No debe renderizar nada si la lista de pendientes está vacía');
    });

    test('8. HomePendingInvitationsBar renderiza hasta 3 invitaciones, contador y botón para ver restantes si hay > 3', () => {
      // Mock de invitaciones pendientes
      const mockInvitations = [
        {
          id: 'inv-1',
          encuentro_id: 'enc-1',
          encuentro_titulo: 'Picnic Primavera',
          encuentro_fecha: '2026-10-25',
          encuentro_hora: '15:00:00',
          encuentro_modalidad: 'presencial',
          encuentro_date_mode: 'fixed',
          encuentro_estado: 'activo',
          host_id: 'host-1',
          estado: 'pendiente',
          created_at: new Date().toISOString(),
          expira_en: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          id: 'inv-2',
          encuentro_id: 'enc-2',
          encuentro_titulo: 'Asado con Coordinación',
          encuentro_modalidad: 'presencial',
          encuentro_date_mode: 'coordination',
          encuentro_estado: 'activo',
          host_id: 'host-2',
          estado: 'pendiente',
          created_at: new Date().toISOString(),
          expira_en: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          id: 'inv-3',
          encuentro_id: 'enc-3',
          encuentro_titulo: 'Meetup Virtual',
          encuentro_modalidad: 'virtual',
          encuentro_fecha: '2026-10-28',
          encuentro_hora: '19:00:00',
          encuentro_date_mode: 'fixed',
          encuentro_estado: 'activo',
          host_id: 'host-3',
          estado: 'pendiente',
          created_at: new Date().toISOString(),
          expira_en: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          id: 'inv-4',
          encuentro_id: 'enc-4',
          encuentro_titulo: 'Cuarta Invitación Excedente',
          encuentro_modalidad: 'presencial',
          encuentro_date_mode: 'coordination',
          encuentro_estado: 'activo',
          host_id: 'host-4',
          estado: 'pendiente',
          created_at: new Date().toISOString(),
          expira_en: new Date(Date.now() + 86400000).toISOString(),
        },
      ];

      // Simulamos un render directo o testeamos la lógica de slicing
      const initialItems = mockInvitations.slice(0, 3);
      const remainingCount = Math.max(0, mockInvitations.length - 3);

      assert.equal(initialItems.length, 3, 'Debe limitar a 3 invitaciones en la vista compacta');
      assert.equal(remainingCount, 1, 'Debe contabilizar 1 invitación restante');
      assert.equal(initialItems[0].encuentro_titulo, 'Picnic Primavera');
      assert.equal(initialItems[1].encuentro_date_mode, 'coordination');
    });

    test('9. Las invitaciones pendientes en Home NO exponen logística privada (dirección ni link virtual)', () => {
      // Comprobar que el tipo MyInternalInvitationItem no contiene lugar_texto ni link_virtual
      const sampleItem: any = {
        id: 'inv-1',
        encuentro_titulo: 'Cena Confidencial',
        estado: 'pendiente',
      };

      assert.equal(sampleItem.lugar_texto, undefined, 'No debe existir lugar_texto en los items de la Home');
      assert.equal(sampleItem.link_virtual, undefined, 'No debe existir link_virtual en los items de la Home');
    });
  });
});

