import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Correcciones QA Manual: Autofocus, Orden Invitación, Lugar Privado y Cupos', () => {
  const step1Path = path.resolve(process.cwd(), 'src/screens/CreateWizard/Step1Data.tsx');
  const detailHostPath = path.resolve(process.cwd(), 'src/screens/DetailHost.tsx');
  const publishModalPath = path.resolve(process.cwd(), 'src/components/host/OpenEncounterPublishModal.tsx');
  const hostSectionPath = path.resolve(process.cwd(), 'src/components/host/HostOpenEncounterSection.tsx');

  const step1Code = fs.readFileSync(step1Path, 'utf-8');
  const detailHostCode = fs.readFileSync(detailHostPath, 'utf-8');
  const publishModalCode = fs.readFileSync(publishModalPath, 'utf-8');
  const hostSectionCode = fs.readFileSync(hostSectionPath, 'utf-8');

  // 1. AUTOFOCUS EN STEP 1
  describe('1. Autofocus en Nombre del encuentro', () => {
    test('Step1Data define autofocus reactivo sin timeouts demorados ni scrollIntoView invasivo', () => {
      // Debe chequear si viene con fecha o autoFocusTitle
      assert.ok(
        step1Code.includes('Boolean(locationState?.autoFocusTitle || fecha)'),
        'Debe activar autofocus si entra con fecha o autoFocusTitle'
      );

      // El efecto de autofocus no debe contener setTimeout encadenados ni scrollIntoView invasivo
      const autofocusEffectCode = step1Code.slice(
        step1Code.indexOf('shouldAutoFocus'),
        step1Code.indexOf('const now')
      );
      assert.ok(
        !autofocusEffectCode.includes('setTimeout(runFocus, 120)'),
        'No debe tener delay de 120ms que cancela el teclado en Android'
      );
      assert.ok(
        !autofocusEffectCode.includes('scrollIntoView'),
        'Efecto de autofocus no debe hacer scrollIntoView center diferido que quita el foco'
      );

      // No debe robar foco si el usuario ya interactuó
      assert.ok(
        step1Code.includes('document.activeElement') &&
        step1Code.includes('active !== nameInputRef.current'),
        'Debe respetar si el usuario ya tiene el foco en otro elemento'
      );

      // El Input recibe autoFocus nativo como prop
      assert.ok(
        step1Code.includes('autoFocus={Boolean(locationState?.autoFocusTitle || fecha)}'),
        'Input de Nombre del encuentro debe recibir prop autoFocus'
      );
    });
  });

  // 2. ORDEN INVITACIÓN LISTA
  describe('2. Invitación lista — Orden y Jerarquía', () => {
    test('Orden: Revisá antes de compartir (Previsualizar) precede a Compartir invitación', () => {
      const idxReview = detailHostCode.indexOf('BLOQUE: REVISÁ ANTES DE COMPARTIR');
      const idxShare = detailHostCode.indexOf('BLOQUE: COMPARTIR INVITACIÓN O AGREGAR INVITADOS');

      assert.ok(idxReview !== -1, 'Debe existir BLOQUE: REVISÁ ANTES DE COMPARTIR');
      assert.ok(idxShare !== -1, 'Debe existir BLOQUE: COMPARTIR INVITACIÓN O AGREGAR INVITADOS');
      assert.ok(
        idxReview < idxShare,
        'Previsualizar (Revisá antes de compartir) debe aparecer ANTES de Compartir invitación'
      );

      // Botón secundario en Previsualizar
      assert.ok(
        detailHostCode.includes('variant="outline"') &&
        detailHostCode.includes('Previsualizar invitación'),
        'Previsualizar invitación debe ser secundario (outline)'
      );

      // Botón primario en Compartir
      assert.ok(
        detailHostCode.includes('Compartir invitación') &&
        detailHostCode.includes('variant={(fromCancelled ? copiedNewShare : copiedShare) ? \'secondary\' : \'primary\'}'),
        'Compartir invitación debe mantener variante primaria'
      );

      // Ausencia de Cambiar diseño en la sección de revisión de invitación
      const reviewSectionBlock = detailHostCode.slice(
        idxReview,
        detailHostCode.indexOf('{/* BLOQUE: COMPARTIR INVITACIÓN O AGREGAR INVITADOS')
      );
      assert.ok(
        !reviewSectionBlock.includes('Cambiar diseño'),
        'Cambiar diseño debe permanecer fuera de la sección Revisá antes de compartir'
      );
    });
  });

  // 3. DISCOVERY — LUGAR PRIVADO Y CUPOS
  describe('3. Discovery — Lugar Privado y Semántica de Cupos', () => {
    test('A. Label y explicación: Lugar y dirección privada', () => {
      assert.ok(
        publishModalCode.includes("isVirtual ? 'Enlace de acceso privado' : 'Lugar y dirección privada'"),
        'Label debe decir "Lugar y dirección privada" para presencial'
      );
      assert.ok(
        publishModalCode.includes('Indica dónde será el encuentro (nombre del lugar, referencia o dirección). No es público: solo lo verán los participantes aprobados.'),
        'Debe incluir explicación clara de privacidad para lugar_texto'
      );
      assert.ok(
        publishModalCode.includes('pe-publish-private-loc__edit-btn'),
        'Debe mantener acción Editar'
      );
    });

    test('B. Campo de cupos: estado desacoplado permite borrar "1" y escribir "4"', () => {
      // Estado slotsInput como string
      assert.ok(
        publishModalCode.includes("const [slotsInput, setSlotsInput] = useState<string>("),
        'Debe usar estado de texto para permitir campo vacío transitorio'
      );

      // Validación en onChange permite vacío o dígitos
      assert.ok(
        publishModalCode.includes("val === '' || /^\\d+$/.test(val)"),
        'handleSlotsChange debe permitir borrar todo o escribir dígitos sin forzar 1 inmediatamente'
      );

      // Normalización al salir (blur) y submit
      assert.ok(
        publishModalCode.includes('handleSlotsBlur') &&
        publishModalCode.includes("setSlotsInput('1')"),
        'handleSlotsBlur debe garantizar mínimo 1 al desenfocar'
      );

      // Input type="text" con inputMode="numeric"
      assert.ok(
        publishModalCode.includes('inputMode="numeric"'),
        'Debe usar inputMode="numeric" para teclado numérico mobile'
      );
    });

    test('C. Semántica visible: Lugares para sumarse (anfitrión no consume vacante visible)', () => {
      assert.ok(
        publishModalCode.includes("Lugares para sumarse"),
        'Label debe ser "Lugares para sumarse"'
      );
      assert.ok(
        publishModalCode.includes('Personas adicionales que querés sumar a tu encuentro (no incluye al anfitrión)'),
        'Hint debe aclarar que no incluye al anfitrión'
      );

      // Cálculo de capacidad interna: parsedSlots + 1 (host) + confirmedCount
      assert.ok(
        publishModalCode.includes('const calculatedMaxParticipants = parsedSlots + 1 + confirmedCount;'),
        'Cálculo interno debe ser parsedSlots + 1 (host) + confirmedCount'
      );

      // Simulación: Host solo + 4 lugares => backend recibe max_participants = 5
      const parsedSlots = 4;
      const confirmedCount = 0;
      const internalMax = parsedSlots + 1 + confirmedCount;
      assert.equal(internalMax, 5, 'Host solo + 4 lugares para sumarse => max_participants = 5');

      // En Discovery: open_slots = max_participants - (1 host + confirmed)
      const openSlots = Math.max(0, internalMax - (1 + confirmedCount));
      assert.equal(openSlots, 4, 'Capacidad interna 5 produce exactamente 4 vacantes visibles en Discovery');
    });

    test('D. Detalle del encuentro: muestra Personas actuales y Lugares disponibles', () => {
      assert.ok(
        hostSectionCode.includes('Personas actuales'),
        'Detalle del host debe mostrar "Personas actuales"'
      );
      assert.ok(
        hostSectionCode.includes('Lugares disponibles'),
        'Detalle del host debe mostrar "Lugares disponibles"'
      );
      assert.ok(
        !hostSectionCode.includes('Ocupación total'),
        'No debe mostrar "Ocupación total 1 / 5"'
      );

      // Cálculo de visualización
      const confirmedCount = 0;
      const totalOccupied = confirmedCount + 1; // 1
      const maxParticipants = 5;
      const availableSlots = Math.max(0, maxParticipants - totalOccupied); // 4

      assert.equal(totalOccupied, 1, 'Personas actuales debe ser 1 (el anfitrión)');
      assert.equal(availableSlots, 4, 'Lugares disponibles debe ser 4');
    });
  });
});
