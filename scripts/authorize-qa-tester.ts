/**
 * Helper Operativo: Autorización Rápida de Identidades para QA Manual (Staging)
 *
 * Uso:
 *   npx --workspaces=false tsx scripts/authorize-qa-tester.ts --email tester@puntoencuentro.test
 *   npx --workspaces=false tsx scripts/authorize-qa-tester.ts --user-id <UUID>
 *   npx --workspaces=false tsx scripts/authorize-qa-tester.ts --list
 *   npx --workspaces=false tsx scripts/authorize-qa-tester.ts --revoke <UUID>
 *
 * Entorno Obligatorio: Staging (wougfhfwqgmxhgvjqoua)
 */

import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

const serviceRoleKey = getStagingSecretKey();
const adminClient = createClient(STAGING_URL, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const value = args[1];

  console.log('==============================================================================');
  console.log('GESTIÓN DE AUTORIZACIÓN DE QA MANUAL (STAGING)');
  console.log(`Target: ${STAGING_URL} (Project: ${STAGING_PROJECT_REF})`);
  console.log('==============================================================================\n');

  if (command === '--list') {
    const { data, error } = await adminClient
      .from('qa_authorized_users')
      .select('user_id, role, created_at, created_by');

    if (error) {
      console.error('Error listando usuarios QA:', error.message);
      process.exit(1);
    }

    console.log(`Usuarios QA autorizados actualmente (${data?.length ?? 0}):`);
    for (const u of data || []) {
      console.log(` • User ID: ${u.user_id} | Rol: ${u.role} | Creado: ${u.created_at}`);
    }
    return;
  }

  if (command === '--email' && value) {
    const { data: userData, error: userError } = await adminClient.auth.admin.listUsers();
    if (userError) {
      console.error('Error consultando usuarios auth:', userError.message);
      process.exit(1);
    }

    const found = userData.users.find((u) => u.email?.toLowerCase() === value.toLowerCase());
    if (!found) {
      console.error(`No se encontró ningún usuario con el email: ${value}`);
      console.log('El tester debe registrarse primero en la aplicación o mediante admin.createUser.');
      process.exit(1);
    }

    const { error: insertError } = await adminClient
      .from('qa_authorized_users')
      .upsert({ user_id: found.id, role: 'qa' }, { onConflict: 'user_id' });

    if (insertError) {
      console.error('Error registrando en qa_authorized_users:', insertError.message);
      process.exit(1);
    }

    console.log(`✔ ÉXITO: Usuario '${value}' (ID: ${found.id}) autorizado como evaluador QA.`);
    console.log('El evaluador ya puede acceder a Discovery y crear encuentros en Staging.');
    return;
  }

  if (command === '--user-id' && value) {
    const { error: insertError } = await adminClient
      .from('qa_authorized_users')
      .upsert({ user_id: value, role: 'qa' }, { onConflict: 'user_id' });

    if (insertError) {
      console.error('Error registrando en qa_authorized_users:', insertError.message);
      process.exit(1);
    }

    console.log(`✔ ÉXITO: Identidad (ID: ${value}) autorizada como evaluador QA.`);
    console.log('La sesión anónima o permanente ya puede operar en Discovery y crear encuentros.');
    return;
  }

  if (command === '--revoke' && value) {
    const { error: deleteError } = await adminClient
      .from('qa_authorized_users')
      .delete()
      .eq('user_id', value);

    if (deleteError) {
      console.error('Error revocando permisos:', deleteError.message);
      process.exit(1);
    }

    console.log(`✔ Permisos QA revocados para la identidad: ${value}`);
    return;
  }

  console.log('Uso:');
  console.log('  npx --workspaces=false tsx scripts/authorize-qa-tester.ts --email <email>');
  console.log('  npx --workspaces=false tsx scripts/authorize-qa-tester.ts --user-id <uuid>');
  console.log('  npx --workspaces=false tsx scripts/authorize-qa-tester.ts --list');
  console.log('  npx --workspaces=false tsx scripts/authorize-qa-tester.ts --revoke <uuid>');
}

main().catch((err) => {
  console.error('[FATAL]:', err);
  process.exit(1);
});
