import { cleanOrphanQaFixtures, OrphanCleanupOptions } from './lib/environment-guard';

/**
 * Suite de Pruebas Unitarias para Verificación de Seguridad en la Limpieza de Fixtures Huérfanos.
 * 
 * Invariantes a Demostrar:
 * 1. Jamás elimina usuarios preexistentes o de QA manual sin marcadores estrictos.
 * 2. Jamás elimina encuentros sin el prefijo y metadata inequívoca.
 * 3. Ignora fixtures recientes (< minAgeMinutes).
 * 4. Ignora fixtures de la corrida actual (currentRunId).
 * 5. Respeta dryRun: true (no realiza mutaciones en base de datos).
 * 6. Si enabled: false, no realiza ninguna consulta ni borrado.
 * 7. Limita estrictamente el número de registros eliminados según maxEncounters y maxUsers.
 */

interface MockEncounter {
  id: string;
  titulo: string;
  descripcion: string;
  created_at: string;
}

interface MockUser {
  id: string;
  email: string;
  created_at: string;
  user_metadata: Record<string, any>;
}

function createMockAdminClient(initialEncounters: MockEncounter[], initialUsers: MockUser[]) {
  const encounters = [...initialEncounters];
  const users = [...initialUsers];
  const deleteCalls: { type: 'encuentro' | 'user'; id: string }[] = [];

  const mockClient = {
    from: (table: string) => {
      if (table !== 'encuentros') throw new Error(`Tabla no mockeada: ${table}`);
      return {
        select: (fields: string) => {
          let filtered = [...encounters];
          const queryObj = {
            like: (col: string, pattern: string) => {
              if (col === 'titulo') {
                const prefix = pattern.replace('%', '');
                filtered = filtered.filter(e => e.titulo.startsWith(prefix));
              }
              if (col === 'descripcion') {
                const marker = pattern.replace(/%/g, '');
                filtered = filtered.filter(e => e.descripcion.includes(marker));
              }
              return queryObj;
            },
            order: (col: string, { ascending }: { ascending: boolean }) => {
              return queryObj;
            },
            limit: (n: number) => {
              return Promise.resolve({ data: filtered.slice(0, n), error: null });
            },
          };
          return queryObj;
        },
        delete: () => ({
          eq: async (col: string, val: string) => {
            if (col === 'id') {
              deleteCalls.push({ type: 'encuentro', id: val });
              const idx = encounters.findIndex(e => e.id === val);
              if (idx !== -1) encounters.splice(idx, 1);
            }
            return { error: null };
          },
        }),
      };
    },
    auth: {
      admin: {
        listUsers: async () => {
          return { data: { users: [...users] }, error: null };
        },
        deleteUser: async (id: string) => {
          deleteCalls.push({ type: 'user', id });
          const idx = users.findIndex(u => u.id === id);
          if (idx !== -1) users.splice(idx, 1);
          return { data: null, error: null };
        },
      },
    },
    getDeleteCalls: () => deleteCalls,
    getRemainingEncounters: () => encounters,
    getRemainingUsers: () => users,
  };

  return mockClient;
}

async function runTests() {
  console.log('================================================================');
  console.log('TEST SUITE: SEGURIDAD Y PRECISIÓN DE cleanOrphanQaFixtures');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - Detalle: ${detail || 'Condición no cumplida'}`);
      failed++;
    }
  }

  const now = Date.now();
  const fortyMinutesAgo = new Date(now - 40 * 60 * 1000).toISOString();
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

  // --------------------------------------------------------------------------
  // Test 1: Usuarios y encuentros legítimos o no identificados jamás se tocan (incluso con enabled: true)
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = [
      { id: 'enc-legit-1', titulo: 'Asado con Amigos', descripcion: 'Reunión en la quinta', created_at: fortyMinutesAgo },
      { id: 'enc-qa-manual', titulo: 'QA Manual Testing', descripcion: 'Prueba manual sin tag', created_at: fortyMinutesAgo },
      { id: 'enc-similar-title', titulo: '[QA-E2E:old] Sin tag en desc', descripcion: 'Descripción genérica', created_at: fortyMinutesAgo },
    ];
    const mockUsers: MockUser[] = [
      { id: 'user-real-1', email: 'juan.perez@gmail.com', created_at: fortyMinutesAgo, user_metadata: { full_name: 'Juan Perez' } },
      { id: 'user-qa-manual', email: 'tester@puntoencuentro.test', created_at: fortyMinutesAgo, user_metadata: { full_name: 'Tester' } },
      { id: 'user-partial-match', email: 'qa-e2e-run-old@puntoencuentro.test', created_at: fortyMinutesAgo, user_metadata: {} }, // Falta is_e2e_automation_fixture
    ];

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, { enabled: true, currentRunId: 'curr_123', minAgeMinutes: 30 });

    assert(result.deletedEncounters.length === 0, 'Test 1.1: No elimina encuentros sin marcadores exactos');
    assert(result.deletedUsers.length === 0, 'Test 1.2: No elimina usuarios sin metadata estricta');
    assert(mockAdmin.getDeleteCalls().length === 0, 'Test 1.3: Cero llamadas a delete en backend');
    assert(mockAdmin.getRemainingUsers().length === 3, 'Test 1.4: Todos los usuarios legítimos preservados');
  }

  // --------------------------------------------------------------------------
  // Test 2: Fixtures huérfanos legítimos son identificados y eliminados (con enabled: true)
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = [
      {
        id: 'enc-orphan-1',
        titulo: '[QA-E2E:old_run_abc] Encuentro Abandonado',
        descripcion: '[AUTOMATED_QA_FIXTURE:old_run_abc] Encuentro de validación funcional E2E en Staging',
        created_at: fortyMinutesAgo,
      },
    ];
    const mockUsers: MockUser[] = [
      {
        id: 'user-orphan-1',
        email: 'qa-e2e-run-old_run_abc-host@puntoencuentro.test',
        created_at: fortyMinutesAgo,
        user_metadata: {
          is_e2e_automation_fixture: true,
          e2e_run_id: 'old_run_abc',
        },
      },
    ];

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, { enabled: true, currentRunId: 'curr_999', minAgeMinutes: 30 });

    assert(result.deletedEncounters.includes('enc-orphan-1'), 'Test 2.1: Identifica encuentro huérfano con marcadores válidos');
    assert(result.deletedUsers.includes('user-orphan-1'), 'Test 2.2: Identifica usuario huérfano con marcadores válidos');
    assert(mockAdmin.getRemainingEncounters().length === 0, 'Test 2.3: Encuentro huérfano eliminado físicamente');
    assert(mockAdmin.getRemainingUsers().length === 0, 'Test 2.4: Usuario huérfano eliminado físicamente');
  }

  // --------------------------------------------------------------------------
  // Test 3: Fixtures de la corrida actual (currentRunId) jamás son tocados
  // --------------------------------------------------------------------------
  {
    const activeRunId = 'active_run_xyz';
    const mockEncounters: MockEncounter[] = [
      {
        id: 'enc-active',
        titulo: `[QA-E2E:${activeRunId}] Encuentro En Curso`,
        descripcion: `[AUTOMATED_QA_FIXTURE:${activeRunId}] En ejecución`,
        created_at: fortyMinutesAgo,
      },
    ];
    const mockUsers: MockUser[] = [
      {
        id: 'user-active',
        email: `qa-e2e-run-${activeRunId}-host@puntoencuentro.test`,
        created_at: fortyMinutesAgo,
        user_metadata: {
          is_e2e_automation_fixture: true,
          e2e_run_id: activeRunId,
        },
      },
    ];

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, { enabled: true, currentRunId: activeRunId, minAgeMinutes: 30 });

    assert(result.deletedEncounters.length === 0, 'Test 3.1: Excluye encuentros de la corrida actual');
    assert(result.deletedUsers.length === 0, 'Test 3.2: Excluye usuarios de la corrida actual');
    assert(result.skippedDueToCurrentRun === 2, 'Test 3.3: Registra skippedDueToCurrentRun correctamente');
    assert(mockAdmin.getDeleteCalls().length === 0, 'Test 3.4: Ningún delete emitido para la corrida actual');
  }

  // --------------------------------------------------------------------------
  // Test 4: Fixtures recientes (< minAgeMinutes) jamás son tocados
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = [
      {
        id: 'enc-recent',
        titulo: '[QA-E2E:parallel_run] Encuentro Paralelo Reciente',
        descripcion: '[AUTOMATED_QA_FIXTURE:parallel_run] Recién creado',
        created_at: tenMinutesAgo, // 10 min < 30 min
      },
    ];
    const mockUsers: MockUser[] = [
      {
        id: 'user-recent',
        email: 'qa-e2e-run-parallel_run-host@puntoencuentro.test',
        created_at: tenMinutesAgo,
        user_metadata: {
          is_e2e_automation_fixture: true,
          e2e_run_id: 'parallel_run',
        },
      },
    ];

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, { enabled: true, currentRunId: 'other_run', minAgeMinutes: 30 });

    assert(result.deletedEncounters.length === 0, 'Test 4.1: Excluye encuentros de menos de 30 minutos');
    assert(result.deletedUsers.length === 0, 'Test 4.2: Excluye usuarios de menos de 30 minutos');
    assert(result.skippedDueToAge === 2, 'Test 4.3: Registra skippedDueToAge correctamente');
  }

  // --------------------------------------------------------------------------
  // Test 5: Modo dryRun NO efectúa llamadas delete en base de datos
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = [
      {
        id: 'enc-dry',
        titulo: '[QA-E2E:dry_run_abc] Encuentro Dry',
        descripcion: '[AUTOMATED_QA_FIXTURE:dry_run_abc] Dry test',
        created_at: fortyMinutesAgo,
      },
    ];
    const mockUsers: MockUser[] = [
      {
        id: 'user-dry',
        email: 'qa-e2e-run-dry_run_abc-host@puntoencuentro.test',
        created_at: fortyMinutesAgo,
        user_metadata: {
          is_e2e_automation_fixture: true,
          e2e_run_id: 'dry_run_abc',
        },
      },
    ];

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, {
      enabled: true,
      currentRunId: 'curr',
      minAgeMinutes: 30,
      dryRun: true,
    });

    assert(result.dryRun === true, 'Test 5.1: Modo dryRun reportado en resultado');
    assert(result.deletedEncounters.includes('enc-dry'), 'Test 5.2: Detecta encuentro candidato a eliminar');
    assert(result.deletedUsers.includes('user-dry'), 'Test 5.3: Detecta usuario candidato a eliminar');
    assert(mockAdmin.getDeleteCalls().length === 0, 'Test 5.4: dryRun NO realiza llamadas delete');
    assert(mockAdmin.getRemainingEncounters().length === 1, 'Test 5.5: Encuentro permanece intacto en DB');
    assert(mockAdmin.getRemainingUsers().length === 1, 'Test 5.6: Usuario permanece intacto en DB');
  }

  // --------------------------------------------------------------------------
  // Test 6: Deshabilitado por defecto (enabled: false o no especificado)
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = [
      {
        id: 'enc-disabled',
        titulo: '[QA-E2E:dis_123] Encuentro',
        descripcion: '[AUTOMATED_QA_FIXTURE:dis_123] Desc',
        created_at: fortyMinutesAgo,
      },
    ];
    const mockUsers: MockUser[] = [];
    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    
    // 6.1 Por defecto (sin opciones)
    const resultDefault = await cleanOrphanQaFixtures(mockAdmin);
    assert(resultDefault.scannedEncounters === 0, 'Test 6.1: Deshabilitado por defecto si no se pasa enabled: true');
    assert(mockAdmin.getDeleteCalls().length === 0, 'Test 6.2: Cero operaciones delete por defecto');

    // 6.2 Explícitamente enabled: false
    const resultFalse = await cleanOrphanQaFixtures(mockAdmin, { enabled: false });
    assert(resultFalse.scannedEncounters === 0, 'Test 6.3: No escanea encuentros cuando enabled=false');
    assert(mockAdmin.getDeleteCalls().length === 0, 'Test 6.4: Cero operaciones delete cuando enabled=false');
  }

  // --------------------------------------------------------------------------
  // Test 7: Límites estrictos de borrado por corrida (maxEncounters y maxUsers)
  // --------------------------------------------------------------------------
  {
    const mockEncounters: MockEncounter[] = Array.from({ length: 15 }, (_, i) => ({
      id: `enc-limit-${i}`,
      titulo: `[QA-E2E:batch_${i}] Batch`,
      descripcion: `[AUTOMATED_QA_FIXTURE:batch_${i}] Desc`,
      created_at: fortyMinutesAgo,
    }));
    const mockUsers: MockUser[] = Array.from({ length: 30 }, (_, i) => ({
      id: `user-limit-${i}`,
      email: `qa-e2e-run-batch_${i}-u@puntoencuentro.test`,
      created_at: fortyMinutesAgo,
      user_metadata: { is_e2e_automation_fixture: true, e2e_run_id: `batch_${i}` },
    }));

    const mockAdmin = createMockAdminClient(mockEncounters, mockUsers);
    const result = await cleanOrphanQaFixtures(mockAdmin, {
      enabled: true,
      currentRunId: 'curr',
      minAgeMinutes: 30,
      maxEncounters: 5,
      maxUsers: 8,
    });

    assert(result.deletedEncounters.length === 5, 'Test 7.1: Limita encuentros estrictamente a maxEncounters (5)');
    assert(result.deletedUsers.length === 8, 'Test 7.2: Limita usuarios estrictamente a maxUsers (8)');
    assert(mockAdmin.getRemainingEncounters().length === 10, 'Test 7.3: Encuentros excedentes preservados');
    assert(mockAdmin.getRemainingUsers().length === 22, 'Test 7.4: Usuarios excedentes preservados');
  }

  console.log('\n================================================================');
  console.log(`RESUMEN DE PRUEBAS DE SEGURIDAD: ${passed} PASS, ${failed} FAIL`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Excepción no controlada en test runner:', err);
  process.exit(1);
});
