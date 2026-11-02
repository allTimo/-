// Что РЕАЛЬНО подключено к профилю DSH — определяется по фактам, а не по каталогу.
//
//  1. package.json профиля: dsh.profile.bundles + dependencies;
//  2. пакет лежит в node_modules профиля и у него есть загружаемая точка входа
//     (main / exports / index.js) или он «пакет-носитель» с dsh.bundle.patch;
//  3. наличие КЛЮЧА — только факт «есть/нет»: переменная окружения или ИМЯ записи
//     в ~/.dsh/.credentials.yaml. ЗНАЧЕНИЯ СЕКРЕТОВ НИКОГДА НЕ ЧИТАЮТСЯ И НЕ ВЫВОДЯТСЯ.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { DSH_HOME } from './paths.mjs';

const PROFILE_DIR = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim() !== ''
  ? process.env.DSH_PROFILE_DIR
  : path.join(DSH_HOME, 'profiles', 'desktop');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

function resolvePackageDir(profileDir, name) {
  const dir = path.join(profileDir, 'node_modules', name);
  return fs.existsSync(dir) ? dir : null;
}

function packageEntry(dir) {
  const manifest = readJsonSafe(path.join(dir, 'package.json'));
  if (!manifest) return { ok: false, reason: 'нет package.json', version: null, hasPatch: false, patchPath: null, carrier: false };
  const candidates = [];
  if (typeof manifest.main === 'string') candidates.push(manifest.main);
  if (typeof manifest.module === 'string') candidates.push(manifest.module);
  const exp = manifest.exports;
  if (typeof exp === 'string') candidates.push(exp);
  else if (exp && typeof exp === 'object') {
    const dot = exp['.'];
    if (typeof dot === 'string') candidates.push(dot);
    else if (dot && typeof dot === 'object') {
      for (const k of ['import', 'require', 'default', 'node']) if (typeof dot[k] === 'string') candidates.push(dot[k]);
    }
  }
  candidates.push('index.js', 'lib/index.js', 'dist/index.js');
  let entry = null;
  for (const c of candidates) {
    const abs = path.join(dir, c);
    if (fs.existsSync(abs)) { entry = c; break; }
  }
  const patchRel = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch ? String(manifest.dsh.bundle.patch) : null;
  const patchPath = patchRel ? path.join(dir, patchRel) : null;
  const hasPatch = patchPath ? fs.existsSync(patchPath) : false;
  return {
    ok: entry !== null,
    entry: entry,
    reason: entry === null ? 'не найдена точка входа' : null,
    version: manifest.version !== undefined ? String(manifest.version) : null,
    hasPatch: hasPatch,
    patchPath: patchPath,
    // «пакет-носитель»: своей точки входа нет, но он подключает другие пакеты патчем
    carrier: entry === null && (hasPatch || manifest.dsh !== undefined),
    name: manifest.name !== undefined ? String(manifest.name) : null,
  };
}

// Только ИМЕНА записей. Значения не читаем ни при каких условиях.
export function loadCredentialKeyNames() {
  const file = path.join(DSH_HOME, '.credentials.yaml');
  if (!fs.existsSync(file)) return { exists: false, path: file, names: [] };
  let doc;
  try { doc = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { exists: true, path: file, names: [], error: 'не разобран: ' + e.message }; }
  const names = [];
  (function walk(node, depth) {
    if (depth > 4 || !node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      names.push(key);
      const value = node[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, depth + 1);
    }
  })(doc, 0);
  return { exists: true, path: file, names: names };
}

export function keyPresent(keyEnv, credNames) {
  const list = Array.isArray(keyEnv) ? keyEnv : (keyEnv ? [keyEnv] : []);
  if (list.length === 0) return { needed: false, present: false, via: null, names: [] };
  const lower = credNames.map(function (n) { return String(n).toLowerCase(); });
  for (const k of list) {
    const name = String(k);
    if (process.env[name] !== undefined && process.env[name] !== '') return { needed: true, present: true, via: 'env', names: list };
  }
  for (const k of list) {
    const name = String(k).toLowerCase();
    if (lower.indexOf(name) >= 0) return { needed: true, present: true, via: 'credentials', names: list };
    // ключи вида ZVENOAI_API_KEY часто лежат как zvenoai / apiKey
    const stem = name.replace(/_api_key$|_token$|_key$/, '');
    if (stem && lower.indexOf(stem) >= 0) return { needed: true, present: true, via: 'credentials', names: list };
  }
  return { needed: true, present: false, via: null, names: list };
}

export function loadProfile() {
  const warnings = [];
  const manifestPath = path.join(PROFILE_DIR, 'package.json');
  const out = {
    dir: PROFILE_DIR,
    manifestPath: manifestPath,
    exists: fs.existsSync(manifestPath),
    bundles: [],
    communityBundles: [],
    dependencies: {},
    packages: {},
    credentials: { exists: false, names: [], path: null },
    warnings: warnings,
  };
  if (!out.exists) {
    warnings.push('Профиль DSH не найден: ' + manifestPath + ' — блок «Подключено» будет пустым');
    out.credentials = loadCredentialKeyNames();
    return out;
  }
  const manifest = readJsonSafe(manifestPath);
  if (!manifest) {
    warnings.push('package.json профиля не разобрался: ' + manifestPath);
    out.credentials = loadCredentialKeyNames();
    return out;
  }
  out.bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles.map(String) : [];
  out.dependencies = (manifest.dependencies && typeof manifest.dependencies === 'object') ? manifest.dependencies : {};
  out.communityBundles = out.bundles.filter(function (n) { return n.indexOf('@deepseek-ai/') !== 0; });
  out.credentials = loadCredentialKeyNames();

  const names = {};
  for (const n of out.bundles) names[n] = true;
  for (const n of Object.keys(out.dependencies)) names[n] = true;
  for (const n of Object.keys(names)) {
    const inBundles = out.bundles.indexOf(n) >= 0;
    const inDeps = Object.prototype.hasOwnProperty.call(out.dependencies, n);
    // Встроенные бандлы DeepSeek приходят вместе с приложением, их нет в node_modules профиля.
    if (n.indexOf('@deepseek-ai/') === 0) {
      out.packages[n] = { name: n, installed: true, inBundles: inBundles, inDependencies: inDeps, harness: true, ok: true, carrier: false, version: null, declaredVersion: inDeps ? String(out.dependencies[n]) : null, hasPatch: false, patchPath: null, reason: null };
      continue;
    }
    const dir = resolvePackageDir(PROFILE_DIR, n);
    if (!dir) {
      out.packages[n] = { name: n, installed: false, inBundles: inBundles, inDependencies: inDeps, declaredVersion: inDeps ? String(out.dependencies[n]) : null, ok: false, reason: 'нет в node_modules' };
      continue;
    }
    const info = packageEntry(dir);
    out.packages[n] = Object.assign({
      name: n,
      installed: true,
      inBundles: inBundles,
      inDependencies: inDeps,
      declaredVersion: inDeps ? String(out.dependencies[n]) : null,
      dir: dir,
    }, info);
  }
  const missing = out.bundles.filter(function (n) {
    if (n.indexOf('@deepseek-ai/') === 0) return false;
    return !out.packages[n] || !out.packages[n].installed;
  });
  if (missing.length > 0) warnings.push('В бандлах профиля указаны пакеты, которых нет в node_modules: ' + missing.join(', '));
  const broken = out.communityBundles.filter(function (n) { const p = out.packages[n]; return p && p.installed && !p.ok && !p.carrier; });
  if (broken.length > 0) warnings.push('У пакетов нет загружаемой точки входа: ' + broken.join(', '));
  return out;
}
