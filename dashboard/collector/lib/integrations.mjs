// Вкладка «Интеграции API»: что РЕАЛЬНО подключено к профилю DSH и что можно
// подключить. Секреты не читаются: только факт «ключ есть / ключа нет».
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { REGISTRY_DIR, CONFIG_DIR } from './paths.mjs';

const FULL_CATALOG_FILE = path.join(CONFIG_DIR, 'integrations-full.yaml');

const STATUS_LABEL = {
  connected: 'подключено',
  available: 'можно подключить',
  partnership: 'требует партнёрства',
  'no-api': 'нет открытого API',
};
const DIRECTION_LABEL = { read: 'читаем', write: 'пишем', both: 'оба' };
import { keyPresent } from './profile.mjs';

const CATALOG_FILE = path.join(REGISTRY_DIR, 'integrations-catalog.yaml');

function asArray(v) { return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]); }

export function loadCatalog(warnings) {
  const list = [];
  if (!fs.existsSync(CATALOG_FILE)) {
    warnings.push('registry/integrations-catalog.yaml не найден — блок «Можно подключить» будет пустым');
    return { integrations: list, file: CATALOG_FILE, exists: false, updated: null };
  }
  let doc;
  try { doc = parseYaml(fs.readFileSync(CATALOG_FILE, 'utf8')); }
  catch (e) {
    warnings.push('registry/integrations-catalog.yaml: ошибка разбора — ' + e.message);
    return { integrations: list, file: CATALOG_FILE, exists: true, updated: null };
  }
  for (const raw of asArray(doc.integrations)) {
    if (!raw || typeof raw !== 'object' || raw.id === undefined) continue;
    list.push({
      id: String(raw.id),
      name: raw.name !== undefined && raw.name !== null ? String(raw.name) : String(raw.id),
      kind: raw.kind !== undefined && raw.kind !== null ? String(raw.kind) : 'other',
      purpose: raw.purpose !== undefined && raw.purpose !== null ? String(raw.purpose) : null,
      statusHint: raw.status_hint !== undefined && raw.status_hint !== null ? String(raw.status_hint) : null,
      keyEnv: raw.key_env !== undefined && raw.key_env !== null ? String(raw.key_env) : null,
      package: raw.package !== undefined && raw.package !== null ? String(raw.package) : null,
      where: raw.where !== undefined && raw.where !== null ? String(raw.where) : null,
    });
  }
  return { integrations: list, file: CATALOG_FILE, exists: true, updated: doc.updated !== undefined ? String(doc.updated) : null };
}

export function loadFullCatalog(warnings) {
  if (!fs.existsSync(FULL_CATALOG_FILE)) {
    warnings.push('dashboard/config/integrations-full.yaml не найден — расширенный каталог интеграций будет пустым');
    return { groups: [], file: FULL_CATALOG_FILE, exists: false };
  }
  let doc = null;
  try { doc = parseYaml(fs.readFileSync(FULL_CATALOG_FILE, 'utf8')); }
  catch (e) { warnings.push('integrations-full.yaml: ошибка разбора — ' + e.message); return { groups: [], file: FULL_CATALOG_FILE, exists: true }; }
  const groups = asArray(doc.groups).filter(function (g) { return g && Array.isArray(g.items); }).map(function (g) {
    return {
      id: String(g.id),
      title: g.title !== undefined ? String(g.title) : String(g.id),
      items: g.items.filter(function (i) { return i && i.id; }).map(function (i) {
        return {
          id: String(i.id),
          name: i.name !== undefined ? String(i.name) : String(i.id),
          what: i.what !== undefined ? String(i.what) : null,
          direction: i.direction !== undefined ? String(i.direction) : 'both',
          method: i.method !== undefined ? String(i.method) : null,
          where: i.where !== undefined ? String(i.where) : null,
          declaredStatus: i.status !== undefined ? String(i.status) : 'available',
          package: i.package !== undefined && i.package !== null ? String(i.package) : null,
          keyEnv: i.key_env !== undefined && i.key_env !== null ? String(i.key_env) : null,
        };
      }),
    };
  });
  return { groups: groups, file: FULL_CATALOG_FILE, exists: true };
}

const STATE_LABEL = {
  connected: 'подключено',
  disabled: 'установлено, выключено из загрузки',
  broken: 'установлено, но не загружается',
  'needs-key': 'нужен ключ',
  'not-installed': 'не установлено',
};

export function buildIntegrationsDoc(ctx) {
  const profile = ctx.profile;
  const catalog = ctx.catalog;
  const warnings = [];

  const items = catalog.integrations.map(function (entry) {
    const pkg = entry.package;
    const p = pkg ? profile.packages[pkg] : null;
    const key = keyPresent(entry.keyEnv, profile.credentials.names);

    let state;
    if (p && p.installed) {
      if (p.inBundles && (p.ok || p.carrier)) state = 'connected';
      else if (!p.inBundles) state = 'disabled';
      else state = 'broken';
    } else if (!pkg) {
      // Пакета нет (например, внешний API) — судим по ключу.
      state = key.needed ? (key.present ? 'connected' : 'needs-key') : 'connected';
    } else {
      state = key.needed && !key.present ? 'needs-key' : 'not-installed';
    }
    // Ключ нужен, но его нет — это важнее состояния загрузки для «требует внимания».
    const needsAttention = (key.needed && !key.present) || state === 'disabled' || state === 'broken';

    let mismatch = null;
    if (entry.statusHint === 'connected' && state !== 'connected') mismatch = 'в каталоге отмечено как подключённое, по факту — ' + STATE_LABEL[state];
    if (entry.statusHint === 'disabled' && state === 'connected') mismatch = 'в каталоге отмечено как выключенное, по факту загружается';
    if (mismatch) warnings.push('integration ' + entry.id + ': ' + mismatch);

    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      purpose: entry.purpose,
      statusHint: entry.statusHint,
      package: pkg,
      where: entry.where,
      needsKey: key.needed,
      keyPresent: key.needed ? key.present : null,
      keyVia: key.via,
      keyEnv: entry.keyEnv,
      installed: p ? !!p.installed : false,
      inBundles: p ? !!p.inBundles : false,
      entryOk: p ? !!(p.ok || p.carrier) : false,
      carrier: p ? !!p.carrier : false,
      version: p && p.version ? p.version : null,
      declaredVersion: p && p.declaredVersion ? p.declaredVersion : null,
      patchOk: p ? !!p.hasPatch : false,
      entryReason: p && p.reason ? p.reason : null,
      state: state,
      stateLabel: STATE_LABEL[state],
      needsAttention: needsAttention,
      mismatch: mismatch,
    };
  });

  const connected = items.filter(function (i) { return i.state === 'connected'; });
  const attention = items.filter(function (i) { return i.needsAttention; });
  const available = items.filter(function (i) { return i.state === 'not-installed' || i.state === 'needs-key'; });

  // --- расширенный каталог: статус подтверждаем ФАКТАМИ профиля ---
  const full = ctx.fullCatalog || { groups: [] };
  let catalogCounts = { total: 0, connected: 0, available: 0, partnership: 0, noApi: 0 };
  const catalogGroups = (full.groups || []).map(function (g) {
    const items = g.items.map(function (i) {
      // «подключено» ставим только если пакет реально стоит и он в списке загрузки
      const p = i.package ? profile.packages[i.package] : null;
      let status = i.declaredStatus;
      let factNote = null;
      if (p) {
        if (p.installed && p.inBundles) { status = 'connected'; factNote = 'пакет установлен и в списке загрузки'; }
        else if (p.installed && !p.inBundles) { status = 'available'; factNote = 'пакет установлен, но выключен из загрузки'; }
      }
      const key = keyPresent(i.keyEnv, profile.credentials.names);
      catalogCounts.total++;
      if (status === 'connected') catalogCounts.connected++;
      else if (status === 'available') catalogCounts.available++;
      else if (status === 'partnership') catalogCounts.partnership++;
      else if (status === 'no-api') catalogCounts.noApi++;
      return {
        id: i.id, name: i.name, what: i.what,
        direction: i.direction, directionLabel: DIRECTION_LABEL[i.direction] || i.direction,
        method: i.method, where: i.where,
        status: status, statusLabel: STATUS_LABEL[status] || status,
        declaredStatus: i.declaredStatus,
        package: i.package, keyEnv: i.keyEnv,
        needsKey: key.needed, keyPresent: key.needed ? key.present : null,
        factNote: factNote,
        group: g.title, groupId: g.id,
      };
    });
    return { id: g.id, title: g.title, items: items, total: items.length };
  });

  const profilePackages = Object.keys(profile.packages).map(function (n) {
    const p = profile.packages[n];
    return {
      name: n,
      version: p.version || null,
      declaredVersion: p.declaredVersion || null,
      installed: !!p.installed,
      inBundles: !!p.inBundles,
      ok: !!(p.ok || p.carrier),
      carrier: !!p.carrier,
      hasPatch: !!p.hasPatch,
      reason: p.reason || null,
      inbox: n.indexOf('@deepseek-ai/') === 0,
    };
  }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });

  return {
    profile: {
      dir: profile.dir,
      manifestPath: profile.manifestPath,
      exists: profile.exists,
      bundlesCount: profile.bundles.length,
      communityBundlesCount: profile.communityBundles.length,
      dependenciesCount: Object.keys(profile.dependencies).length,
      credentialsExists: !!profile.credentials.exists,
      credentialsKeyNames: profile.credentials.names.length,
    },
    catalogFile: catalog.file,
    catalogUpdated: catalog.updated,
    summary: {
      total: items.length,
      connected: connected.length,
      attention: attention.length,
      available: available.length,
      installedDisabled: items.filter(function (i) { return i.state === 'disabled'; }).length,
      keysMissing: items.filter(function (i) { return i.needsKey && !i.keyPresent; }).map(function (i) { return i.id; }),
    },
    integrations: items,
    connected: connected,
    attention: attention,
    available: available,
    profilePackages: profilePackages,
    catalog: { groups: catalogGroups, counts: catalogCounts, file: full.file, exists: full.exists },
    warnings: warnings,
  };
}
