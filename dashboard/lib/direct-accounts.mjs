// Хранилище кабинетов Яндекс.Директа для панели (Агент 2).
//
// ЕДИНСТВЕННОЕ место, где живут OAuth-токены, — файл
// `00-admin/config/direct-accounts.local.json` (каталог исключён правилом `*.local`
// в marketing-agents/.gitignore, поэтому секреты в репозиторий не попадают).
// Наружу, в ответы API панели, токен уходит ТОЛЬКО маской из последних 4 символов;
// полный токен не печатается ни в консоль панели, ни в журналы.
//
// Формат файла (version 1):
//   {"version":1,"updated":"<ISO>","oauth":{"client_id":"..."},
//    "accounts":[{"id":"direct-1","token":"...","login":"...","sandbox":false,
//                 "connected_at":"<ISO>","last_check":"<ISO>|null",
//                 "status":"ok|invalid|unchecked","campaigns":null}]}
//
// Модуль занимается лишь чтением/записью и маскированием. Живая проверка доступа
// к API v5 выполняется в serve.mjs (дочерний процесс skills.direct_api) — запись
// попадает в файл ровно тогда, когда вызывающий код передал уже проверенный кабинет.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR } from '../collector/lib/paths.mjs';

export const ACCOUNTS_FILE = path.join(PROJECT_DIR, '00-admin', 'config', 'direct-accounts.local.json');
export const OAUTH_AUTHORIZE_BASE = 'https://oauth.yandex.ru/authorize?response_type=token';
export const OAUTH_REDIRECT_URI = 'https://oauth.yandex.ru/verification_code';

export const STATUS_OK = 'ok';
export const STATUS_INVALID = 'invalid';
export const STATUS_UNCHECKED = 'unchecked';

// Сколько последних символов секрета видно в маске (и требование контракта API).
const VISIBLE_TAIL = 4;
const ELLIPSIS = '\u2026';

// Маска секрета: «…f3a2». Пустая строка -> пустая строка (нет данных — так и пишем,
// выдумывать «…0000» запрещено). Секрет короче 4 символов виден целиком.
export function maskSecret(value) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s) return '';
  return ELLIPSIS + (s.length > VISIBLE_TAIL ? s.slice(-VISIBLE_TAIL) : s);
}

export const maskToken = maskSecret;
export const maskClientId = maskSecret;

export function emptyStore() {
  return { version: 1, updated: null, oauth: { client_id: '' }, accounts: [] };
}

function normalizeStatus(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return [STATUS_OK, STATUS_INVALID, STATUS_UNCHECKED].indexOf(s) >= 0 ? s : STATUS_UNCHECKED;
}

function normalizeAccount(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(a.id === undefined || a.id === null ? '' : a.id),
    token: typeof a.token === 'string' ? a.token : '',
    login: typeof a.login === 'string' ? a.login : '',
    sandbox: a.sandbox === true,
    connected_at: a.connected_at ? String(a.connected_at) : null,
    last_check: a.last_check ? String(a.last_check) : null,
    status: normalizeStatus(a.status),
    campaigns: typeof a.campaigns === 'number' ? a.campaigns : null,
  };
}

// Чтение файла. Файла нет — пустое хранилище (первая запись создаст файл).
// Файл повреждён — бросаем понятную ошибку: молча терять токены нельзя.
export function readStore() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return emptyStore();
  const text = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
  if (text.trim() === '') return emptyStore();
  let doc = null;
  try { doc = JSON.parse(text); } catch (e) {
    throw new Error('файл кабинетов повреждён (не JSON): ' + ACCOUNTS_FILE);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('файл кабинетов не является объектом JSON: ' + ACCOUNTS_FILE);
  }
  const oauth = doc.oauth && typeof doc.oauth === 'object' ? doc.oauth : {};
  return {
    version: 1,
    updated: doc.updated ? String(doc.updated) : null,
    oauth: { client_id: typeof oauth.client_id === 'string' ? oauth.client_id : '' },
    accounts: (Array.isArray(doc.accounts) ? doc.accounts : []).map(normalizeAccount).filter(function (a) { return a.id !== ''; }),
  };
}

// Атомарная запись: временный файл рядом + rename. Права 0600 (на Windows
// chmod может не сработать — это не ошибка, файл и так вне репозитория).
export function writeStore(store) {
  const src = store && typeof store === 'object' ? store : {};
  const srcOauth = src.oauth && typeof src.oauth === 'object' ? src.oauth : {};
  const next = {
    version: 1,
    updated: new Date().toISOString(),
    oauth: { client_id: String(srcOauth.client_id || '') },
    accounts: (Array.isArray(src.accounts) ? src.accounts : []).map(normalizeAccount),
  };
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600); } catch (e) { /* Windows: права не критичны, файл вне репозитория */ }
  return next;
}

// OAuth-настройки для UI: client_id и адреса для получения токена.
// client_id — публичный идентификатор приложения (он всегда виден в ссылке авторизации),
// поэтому отдаётся полностью; маска — только для компактного показа. Секретов здесь нет.
export function publicOauth(store) {
  const src = store && store.oauth ? store.oauth : {};
  const clientId = String(src.client_id || '');
  return {
    clientIdSet: clientId !== '',
    clientId: clientId === '' ? null : clientId,
    clientIdMask: clientId === '' ? '' : maskSecret(clientId),
    authorizeBase: OAUTH_AUTHORIZE_BASE,
    redirectUri: OAUTH_REDIRECT_URI,
  };
}

// Публичное представление кабинета: токен заменён маской, остальное как в файле.
export function publicAccount(account) {
  const a = normalizeAccount(account);
  return {
    id: a.id,
    login: a.login,
    status: a.status,
    connected_at: a.connected_at,
    last_check: a.last_check,
    campaigns: a.campaigns,
    masked: a.token ? maskSecret(a.token) : '',
    sandbox: a.sandbox,
  };
}

export function findAccount(store, id) {
  const list = store && Array.isArray(store.accounts) ? store.accounts : [];
  const want = String(id === undefined || id === null ? '' : id);
  return list.filter(function (a) { return String(a.id) === want; })[0] || null;
}

// Идемпотентность привязки: тот же кабинет узнаём по логину (регистр не важен).
export function findAccountByLogin(store, login) {
  const want = String(login || '').trim().toLowerCase();
  if (!want) return null;
  const list = store && Array.isArray(store.accounts) ? store.accounts : [];
  return list.filter(function (a) { return String(a.login || '').trim().toLowerCase() === want; })[0] || null;
}

export function nextAccountId(store) {
  const list = store && Array.isArray(store.accounts) ? store.accounts : [];
  let max = 0;
  list.forEach(function (a) {
    const m = /^direct-(\d+)$/.exec(String(a.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'direct-' + String(max + 1);
}

// Сохранить client_id приложения, не затирая кабинеты.
export function saveClientId(clientId) {
  const store = readStore();
  store.oauth.client_id = String(clientId || '').trim();
  return writeStore(store);
}

// Кабинет уже ПРОВЕРЕН живым запросом к API — здесь только запись.
// Повторная привязка того же логина обновляет запись (id сохраняется), дублей нет.
export function upsertVerifiedAccount(input) {
  const f = input && typeof input === 'object' ? input : {};
  const token = String(f.token || '');
  const login = String(f.login || '').trim();
  const store = readStore();
  const now = new Date().toISOString();

  let account = login ? findAccountByLogin(store, login) : null;
  // Логин не задан (свой аккаунт): тот же токен узнаём по маске — она не секрет.
  if (!account && !login && token) {
    const mask = maskSecret(token);
    account = store.accounts.filter(function (a) { return maskSecret(a.token) === mask; })[0] || null;
  }

  if (account) {
    account.token = token;
    if (login) account.login = login;
    account.sandbox = f.sandbox === true;
    account.status = STATUS_OK;
    account.campaigns = typeof f.campaigns === 'number' ? f.campaigns : null;
    account.last_check = f.lastCheck ? String(f.lastCheck) : now;
  } else {
    account = {
      id: nextAccountId(store),
      token: token,
      login: login,
      sandbox: f.sandbox === true,
      connected_at: now,
      last_check: f.lastCheck ? String(f.lastCheck) : now,
      status: STATUS_OK,
      campaigns: typeof f.campaigns === 'number' ? f.campaigns : null,
    };
    store.accounts.push(account);
  }
  const saved = writeStore(store);
  return { store: saved, account: findAccount(saved, account.id) || account };
}

// Результат перепроверки: обновляем last_check/status/campaigns.
// Неудачная проверка — status 'invalid' и campaigns null (нет данных — не ноль).
export function updateAccountCheck(id, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const store = readStore();
  const account = findAccount(store, id);
  if (!account) return null;
  account.last_check = p.lastCheck ? String(p.lastCheck) : new Date().toISOString();
  account.status = normalizeStatus(p.status !== undefined ? p.status : account.status);
  account.campaigns = typeof p.campaigns === 'number' ? p.campaigns : null;
  writeStore(store);
  return account;
}

export function deleteAccount(id) {
  const store = readStore();
  const want = String(id === undefined || id === null ? '' : id);
  const rest = store.accounts.filter(function (a) { return String(a.id) !== want; });
  if (rest.length === store.accounts.length) return false;
  store.accounts = rest;
  writeStore(store);
  return true;
}
