#!/usr/bin/env node
// Локальный сервер лендинга: статика marketing-agents + приём заявок POST /api/lead.
//
// Зачем он нужен: лендинг должен уметь ПРИНИМАТЬ заявку, а не только показывать форму.
// Штатный приём заявок в панели делает задача T80 (dashboard-ui). До её готовности этот
// маленький сервер даёт рабочий путь «форма -> заявка сохранена -> страница спасибо»
// и позволяет проверить его фактически.
//
// Что делает:
//   GET  /*            — отдаёт файлы marketing-agents (лендинг, панель, шрифты)
//   POST /api/lead     — принимает заявку, дописывает её в landing/data/leads.ndjson
//   GET  /api/lead     — сколько заявок принято (для проверки; локально)
//
// Границы: слушает только 127.0.0.1, наружу ничего не отправляет, заявки лежат локально.
// Никаких секретов, никаких внешних сервисов.
//
// Запуск:
//   node marketing-agents/landing/tools/serve.mjs --port 8910
//   затем http://127.0.0.1:8910/landing/index.html

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '..');
const ROOT = path.resolve(LANDING, '..');            // marketing-agents
const DATA_DIR = path.join(LANDING, 'data');
const LEADS = path.join(DATA_DIR, 'leads.ndjson');

const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? def) : def; };
const PORT = Number(argOf('--port', 8910));
const HOST = argOf('--host', '127.0.0.1');
// --no-lead: выключить приём заявок (POST /api/lead отвечает 404).
// Нужен ровно для одной проверки: что форма честно сообщает о неготовом эндпоинте,
// а не рисует «спасибо» вместо отправки.
const NO_LEAD = args.includes('--no-lead');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8'
};

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function clean(v, max) { return String(v ?? '').trim().slice(0, max); }

function validateLead(raw) {
  const errors = {};
  const lead = {
    name: clean(raw.name, 120),
    contact: clean(raw.contact, 160),
    object: clean(raw.object, 200),
    competitors: clean(raw.competitors, 2000),
    comment: clean(raw.comment, 2000),
    consent: raw.consent === true,
    source: clean(raw.source, 40) || 'landing',
    page: clean(raw.page, 200)
  };
  if (lead.name.length < 2) errors.name = 'имя короче 2 символов';
  const phoneLike = digits(lead.contact).length >= 10 && digits(lead.contact).length <= 15;
  const tgLike = /^@?[A-Za-z0-9_]{5,32}$/.test(lead.contact) || /^(https?:\/\/)?(t\.me|telegram\.me)\/[A-Za-z0-9_]{5,32}\/?$/i.test(lead.contact);
  if (lead.contact === '') errors.contact = 'нет контакта';
  else if (!phoneLike && !tgLike) errors.contact = 'контакт не похож на телефон или Telegram';
  if (lead.object.length < 2) errors.object = 'не указан объект';
  if (!lead.consent) errors.consent = 'нет согласия на обработку данных';
  return { lead, errors };
}

async function appendLead(lead) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const record = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    ip: '127.0.0.1',
    ...lead
  };
  await fs.appendFile(LEADS, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

async function countLeads() {
  try {
    const text = await fs.readFile(LEADS, 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  } catch (e) {
    return 0;
  }
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/landing/index.html';
  if (rel === '/landing' || rel === '/landing/') rel = '/landing/index.html';
  const target = path.resolve(ROOT, '.' + rel);
  if (!target.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  let stat;
  try { stat = await fs.stat(target); } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404: ' + rel); return; }
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try { stat = await fs.stat(index); } catch (e) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('каталог без index.html'); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    createReadStream(index).pipe(res);
    return;
  }
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
  createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  const p = url.pathname;
  const method = req.method || 'GET';

  if (p === '/api/lead' && method === 'POST') {
    if (NO_LEAD) { sendJson(res, 404, { ok: false, code: 'NO_ENDPOINT', message: 'приём заявок выключен (--no-lead)' }); return; }
    try {
      const text = await readBody(req);
      let raw;
      try { raw = JSON.parse(text); } catch (e) { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'тело запроса не JSON' }); return; }
      const { lead, errors } = validateLead(raw);
      if (Object.keys(errors).length > 0) { sendJson(res, 422, { ok: false, code: 'VALIDATION', errors }); return; }
      const record = await appendLead(lead);
      process.stdout.write('[lead] ' + record.receivedAt + ' ' + record.name + ' / ' + record.object + ' -> ' + record.id + '\n');
      sendJson(res, 201, { ok: true, id: record.id, receivedAt: record.receivedAt, next: 'thanks.html' });
    } catch (e) {
      sendJson(res, 500, { ok: false, code: 'SERVER', message: String(e && e.message ? e.message : e) });
    }
    return;
  }

  if (p === '/api/lead' && method === 'GET') {
    sendJson(res, 200, { ok: true, count: await countLeads(), store: path.relative(ROOT, LEADS) });
    return;
  }

  if (p === '/api/health') { sendJson(res, 200, { ok: true, service: 'landing-dev-server', root: ROOT }); return; }

  if (p.startsWith('/api/')) { sendJson(res, 404, { ok: false, code: 'NO_ENDPOINT', message: 'такого эндпоинта нет: ' + p }); return; }

  if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('method not allowed'); return; }
  await serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  process.stdout.write('Лендинг: http://' + HOST + ':' + PORT + '/landing/index.html\n');
  process.stdout.write(NO_LEAD
    ? 'Приём заявок выключен (--no-lead): POST /api/lead отвечает 404.\n'
    : 'Приём заявок: POST http://' + HOST + ':' + PORT + '/api/lead -> ' + LEADS + '\n');
  process.stdout.write('Слушает только ' + HOST + '; наружу ничего не отдаётся.\n');
});
