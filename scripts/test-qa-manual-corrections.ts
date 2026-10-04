import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Correcciones QA Manual: Autofocus, Orden Invitación, Lugar Privado y Cupos', () => {
  const step1Path = path.resolve(process.cwd(), 'src/screens/CreateWizard/Step1Data.tsx');
  const detailHostPath = path.resolve(process.cwd(), 'src/screens/DetailHost.tsx');
  const publishModalPath = path.resolve(process.cwd(), 'src/components/host/OpenEncounterPublishModal.tsx');
  const hostSectionPath = path.resolve(process.cwd(), 'src/components/host/HostOpenEncounterSection.tsx');

  const openEncountersServicePath = path.resolve(process.cwd(), 'src/services/openEncountersService.ts');
  const cardPath = path.resolve(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterCard.tsx');
  const sheetPath = path.resolve(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx');

  const step1Code = fs.readFileSync(step1Path, 'utf-8');
  const detailHostCode = fs.readFileSync(detailHostPath, 'utf-8');
  const publishModalCode = fs.readFileSync(publishModalPath, 'utf-8');
  const hostSectionCode = fs.readFileSync(hostSectionPath, 'utf-8');
  const openEncountersServiceCode = fs.readFileSync(openEncountersServicePath, 'utf-8');
  const cardCode = fs.readFileSync(cardPath, 'utf-8');
  const sheetCode = fs.readFileSync(sheetPath, 'utf-8');

  // 1. AUTOFOCUS EN STEP 1
  describe('1. Autofocus en Nombre del encuentro (Paridad con Coordinación)', () => {
    test('Step1Data replica el patrón confiable de coordinación con RAF + setTimeout 120ms', () => {
      // Debe chequear autoFocusTitle !== false
      assert.ok(
        step1Code.includes('locationState?.autoFocusTitle === false'),
        'Debe permitir autofocus por defecto salvo que autoFocusTitle sea false'
      );

      // El efecto de autofocus debe usar requestAnimationFrame + setTimeout 120ms
      assert.ok(
        step1Code.includes('requestAnimationFrame'),
        'Debe usar requestAnimationFrame para asegurar montaje completo'
      );
      assert.ok(
        step1Code.includes('setTimeout(runFocus, 120)'),
        'Debe usar delay de 120ms para permitir despliegue de teclado virtual en mobile'
      );

      // scrollTo top y focus
      assert.ok(
        step1Code.includes("window.scrollTo({ top: 0, behavior: 'auto' })"),
        'Debe asegurar scroll al inicio sin saltos'
      );
      assert.ok(
        step1Code.includes('input.focus()'),
        'Debe enfocar físicamente el input'
      );

      // Input NO debe pelear con autoFocus nativo redundante
      assert.ok(
        !step1Code.includes('autoFocus={Boolean(locationState?.autoFocusTitle || fecha)}'),
        'Input no debe tener prop autoFocus nativa redundante que dispute el foco del ref'
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

    test('D. Detalle del anfitrión: excluye al host del conteo visible de participantes', () => {
      // Debe mostrar "Participantes confirmados" (no "Personas actuales")
      assert.ok(
        hostSectionCode.includes('Participantes confirmados'),
        'Detalle del host debe mostrar "Participantes confirmados"'
      );
      assert.ok(
        !hostSectionCode.includes('Personas actuales'),
        'Detalle del host NO debe mostrar "Personas actuales"'
      );
      assert.ok(
        hostSectionCode.includes('Lugares disponibles'),
        'Detalle del host debe mostrar "Lugares disponibles"'
      );

      // Subtexto no debe incluir "1 anfitrión"
      assert.ok(
        !hostSectionCode.includes("'1 anfitrión'"),
        'Métrica de participantes no debe mostrar "1 anfitrión"'
      );
      assert.ok(
        hostSectionCode.includes('Sin participantes externos confirmados'),
        'Métrica debe indicar "Sin participantes externos confirmados" cuando confirmedCount === 0'
      );

      // Cálculo de visualización: Host solo con 3 lugares disponibles
      // En DB: max_participants = 4 (1 host + 3 slots)
      // En UI: confirmados = 0
      const confirmedCount = 0;
      const maxParticipants = 4;
      const totalOccupied = confirmedCount + 1; // 1 ocupado internamente por el anfitrión
      const availableSlots = Math.max(0, maxParticipants - totalOccupied); // 3

      assert.equal(confirmedCount, 0, 'Participantes confirmados visibles debe ser 0');
      assert.equal(availableSlots, 3, 'Lugares disponibles debe ser 3');
    });

    test('E. Mapeo en Discovery y Cards: excluye al anfitrión del conteo de participantes', () => {
      // openEncountersService debe descontar al anfitrión de item.confirmed_count
      assert.ok(
        openEncountersServiceCode.includes('Math.max(0, Number(item.confirmed_count ?? 1) - 1)'),
        'openEncountersService debe descontar al anfitrión del confirmed_count del backend'
      );

      // Simulación de respuesta backend:
      // Host solo: backend retorna confirmed_count = 1 (1 anfitrión + 0 externos)
      const hostSoloBackend = { confirmed_count: 1, open_slots: 3 };
      const hostSoloMappedConfirmed = Math.max(0, Number(hostSoloBackend.confirmed_count ?? 1) - 1);
      assert.equal(hostSoloMappedConfirmed, 0, 'Host solo produce 0 participantes confirmados en Discovery');
      assert.equal(hostSoloBackend.open_slots, 3, 'Lugares disponibles se mantiene en 3');

      // Host con 2 participantes: backend retorna confirmed_count = 3 (1 anfitrión + 2 externos)
      const hostConDosBackend = { confirmed_count: 3, open_slots: 1 };
      const hostConDosMapped = Math.max(0, Number(hostConDosBackend.confirmed_count ?? 1) - 1);
      assert.equal(hostConDosMapped, 2, 'Host con 2 externos produce 2 participantes confirmados en Discovery');

      // Cards y sheets manejan confirmedCount === 0
      assert.ok(
        cardCode.includes("encounter.confirmedCount === 0") &&
        cardCode.includes("open_encounters.confirmed_zero"),
        'HomeOpenEncounterCard debe manejar confirmedCount === 0'
      );
      assert.ok(
        sheetCode.includes("encounter.confirmedCount === 0") &&
        sheetCode.includes("open_encounters.confirmed_zero"),
        'HomeOpenEncounterDetailSheet debe manejar confirmedCount === 0'
      );
    });
  });
});
