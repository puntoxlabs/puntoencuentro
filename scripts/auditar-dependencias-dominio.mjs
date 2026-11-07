#!/usr/bin/env node
/*
 * Auditoría de solo lectura: referencias a dominio y nombre anterior.
 * Ejecutar desde la raíz del repositorio:
 *   node scripts/auditar-dependencias-dominio.mjs --dominio puntoencuentro.com.ar --marca PuntoEncuentro
 * No abre .env con secretos ni envía datos a servicios externos.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (key, fallback) => {
  const i = args.indexOf(key);
  return i !== -1 ? args[i + 1] : fallback;
};
const domain = arg('--dominio', 'puntoencuentro.com.ar');
const brand = arg('--marca', 'PuntoEncuentro');
if (!domain || !brand || domain.startsWith('--') || brand.startsWith('--')) {
  console.error('Uso: --dominio DOMINIO_ANTIGUO --marca MARCA_ANTIGUA');
  process.exit(2);
}
const patterns = [domain, brand].map(s => s.toLocaleLowerCase('en-US'));
const roots = ['src', 'api', 'public', 'supabase', 'scripts'];
const rootFiles = ['index.html', 'vercel.json', '.env.example', 'README.md'];
const extensions = new Set(['.ts','.tsx','.js','.jsx','.mjs','.json','.html','.md','.sql','.toml','.yml','.yaml','.webmanifest','.svg','.txt']);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vercel', 'coverage', '.cache']);
const ignoreNames = new Set(['.env', '.env.local', '.env.production', '.env.staging', '.env.development']);
let scanned = 0;
let references = 0;
const matches = [];
function visit(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (ignoredDirectories.has(path.basename(p))) return;
    for (const filename of fs.readdirSync(p)) visit(path.join(p, filename));
    return;
  }
  const basename = path.basename(p);
  if (ignoreNames.has(basename) || (!extensions.has(path.extname(p)) && basename !== '.env.example')) return;
  if (st.size > 1024 * 1024) return; // evita enormes ficheros generados
  scanned += 1;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!patterns.some(token => line.toLocaleLowerCase('en-US').includes(token))) return;
    references += 1;
    matches.push({file:p, line:index+1, snippet:line.trim().replace(/\s+/g,' ').slice(0,180)});
  });
}
roots.forEach(visit);
rootFiles.forEach(visit);
console.log(`Auditoría de dependencias de dominio/marca\nDominio: ${domain}\nMarca: ${brand}\nArchivos escaneados: ${scanned}\nLíneas coincidentes: ${references}\n`);
for (const entry of matches) console.log(`${entry.file}:${entry.line}: ${entry.snippet}`);
if (!matches.length) console.log('Sin coincidencias en las rutas analizadas. Esto no garantiza ausencia de dominios en servicios externos o paneles.');
