#!/usr/bin/env node
/**
 * Build the READ-ONLY publishing copy of the dashboard.
 *
 *   node marketing-agents/install/publish/build-publish.mjs
 *
 * Source of truth stays marketing-agents/dashboard/** (owned by the dashboard
 * task); nothing here writes back into it. The output is a static site with no
 * server API at all:
 *
 *   install/publish/site/            copied public/** (html/css/js), data/ dropped
 *   install/publish/site/data/state.json   the aggregated /api/state payload
 *   install/publish/site/data/state.js     same payload as window.__DASHBOARD_DATA__
 *   install/publish/site/index.html        copy + read-only banner + state.js script
 *
 * Why state.js and not a fetch of state.json: the dashboard's app.js reads
 * window.__DASHBOARD_DATA__ synchronously in its STANDALONE path, and that path
 * also disables BOTH write calls (agent toggle and /api/collect) inside the app
 * itself. Loading the data as a script keeps that path intact, so the published
 * copy needs no patching of app.js at all.
 *
 * The build ends with a secret gate: if a key VALUE (not a boolean flag or an
 * env-var name) is found in anything that would be published, the build fails
 * and writes publish/scan-report.json.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));            // marketing-agents/install/publish
const installDir = resolve(here, '..');                          // marketing-agents/install
const repoDir = resolve(installDir, '..');                       // marketing-agents
const publicDir = join(repoDir, 'dashboard', 'public');
const siteDir = join(here, 'site');
const toolsDir = join(installDir, 'tools');

const DATA_FILES = ['meta.json', 'agents.json', 'tasks.json', 'projects.json', 'sessions.json', 'usage.json', 'prices.json'];

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

// Same compaction the dashboard's own standalone build uses: trim long task
// descriptions and keep only the session fields the interface renders.
function compactTasks(doc) {
    const out = JSON.parse(JSON.stringify(doc));
    const trim = (t) => {
        if (typeof t.description === 'string' && t.description.length > 320) t.description = t.description.slice(0, 320) + '…';
        delete t.descriptionFirstLine;
    };
    for (const t of out.tasks || []) trim(t);
    for (const g of out.tree || []) {
        for (const c of g.categories || []) {
            for (const t of c.tasks || []) trim(t);
        }
    }
    for (const t of out.unassigned || []) delete t.descriptionFirstLine;
    return out;
}

function compactSessions(doc) {
    const pick = (s) => ({
        id: s.id, title: s.title, agentName: s.agentName, projectLabel: s.projectLabel,
        origin: s.origin, isSubagent: s.isSubagent, model: s.model, provider: s.provider,
        tokens: s.tokens, usd: s.usd, rub: s.rub, rubComplete: s.rubComplete,
        firstTime: s.firstTime, lastTime: s.lastTime,
        turns: s.turns, steps: s.steps, toolCalls: s.toolCalls, toolErrors: s.toolErrors,
        events: s.events,
    });
    return {
        standalone: true,
        note: 'Публичная копия: сессии ужаты до полей, которые показывает интерфейс.',
        count: doc.count,
        sessions: (doc.sessions || []).map(pick),
    };
}

function buildState() {
    const state = { ok: true };
    for (const name of DATA_FILES) {
        const key = name.replace(/\.json$/, '');
        const file = join(publicDir, 'data', name);
        if (!existsSync(file)) { state[key] = null; continue; }
        const doc = readJson(file);
        if (key === 'tasks') state[key] = compactTasks(doc);
        else if (key === 'sessions') state[key] = compactSessions(doc);
        else state[key] = doc;
    }
    return state;
}

const BANNER_ID = 'publishTestBanner';
function bannerHtml(builtAt) {
    return '<div id="' + BANNER_ID + '" style="position:sticky;top:0;z-index:60;padding:10px 14px;'
        + 'background:#3a2a12;color:#ffd479;border-bottom:1px solid rgba(255,212,121,.35);'
        + 'font:600 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center">'
        + 'Тестовая копия • только просмотр • данные на ' + builtAt + '</div>';
}

function pad(n) { return String(n).padStart(2, '0'); }
function stampHuman(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function buildSite(state) {
    rmSync(siteDir, { recursive: true, force: true });
    mkdirSync(siteDir, { recursive: true });
    // copy everything except the per-file data directory (state.js/state.json replace it)
    for (const entry of readdirSync(publicDir)) {
        if (entry === 'data') continue;
        cpSync(join(publicDir, entry), join(siteDir, entry), { recursive: true });
    }
    mkdirSync(join(siteDir, 'data'), { recursive: true });
    const payload = JSON.stringify(state);
    writeFileSync(join(siteDir, 'data', 'state.json'), JSON.stringify(state, null, 2) + '\n');
    writeFileSync(join(siteDir, 'data', 'state.js'),
        '/* Публичная копия: данные вшиты, сервера и API нет. */\n'
        + 'window.__DASHBOARD_STANDALONE__ = true;\n'
        + 'window.__DASHBOARD_DATA__ = ' + payload + ';\n');
    const builtAt = stampHuman(new Date());
    let html = readFileSync(join(siteDir, 'index.html'), 'utf8');
    html = html.replace('<title>Центр управления агентами</title>',
        '<title>Центр управления агентами — тестовая копия</title>\n<meta name="robots" content="noindex,nofollow,noarchive">');
    html = html.replace('<body>', '<body>\n' + bannerHtml(builtAt));
    if (!html.includes('data/state.js')) {
        html = html.replace('<script src="app.js"></script>',
            '<script src="data/state.js"></script>\n<script src="app.js"></script>');
    }
    writeFileSync(join(siteDir, 'index.html'), html);
    return { builtAt, payloadBytes: Buffer.byteLength(payload) };
}

// ---- secret gate ---------------------------------------------------------
const KEYWORDS = ['ZVENOAI', 'SERPER', 'SANDBASE', 'TOKEN', 'credentials', 'password'];
const HARD = [
    { name: 'openai-style sk- key', re: /\bsk-[A-Za-z0-9_\-]{16,}/g },
    { name: 'key assignment with value', re: /(?:API_KEY|APIKEY|SECRET|PASSWORD|AUTH_TOKEN|BOT_TOKEN|ACCESS_TOKEN)[A-Za-z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/gi },
    { name: 'bearer header', re: /Bearer\s+[A-Za-z0-9._\-]{16,}/g },
    { name: 'credentials file path', re: /(?:\.credentials\.yaml|\.credentials\.yml|credentials\.json)/gi },
    { name: 'long hex blob', re: /\b[A-Fa-f0-9]{48,}\b/g },
    { name: 'json secret field with long value', re: /"(?:apiKey|api_key|token|secret|password|authorization)"\s*:\s*"[^"]{12,}"/gi },
];

function mask(text) {
    return String(text).replace(/[A-Za-z0-9_\-\.]{12,}/g, (m) => m.slice(0, 4) + '***(' + m.length + ')');
}

function walk(dir, out) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

function scanSite() {
    const report = { scannedAt: new Date().toISOString(), site: siteDir, files: [], findings: [], blocked: false };
    for (const file of walk(siteDir, [])) {
        const rel = file.slice(siteDir.length + 1);
        const text = readFileSync(file, 'utf8');
        const keywords = {};
        for (const k of KEYWORDS) {
            const n = (text.match(new RegExp(k, 'gi')) ?? []).length;
            if (n) keywords[k] = n;
        }
        const hits = [];
        for (const rule of HARD) {
            const matches = text.match(rule.re);
            if (matches) {
                for (const match of matches.slice(0, 3)) hits.push({ rule: rule.name, sample: mask(match) });
            }
        }
        report.files.push({ file: rel, bytes: Buffer.byteLength(text), keywords });
        for (const hit of hits) report.findings.push({ file: rel, rule: hit.rule, sample: hit.sample });
    }
    report.blocked = report.findings.length > 0;
    writeFileSync(join(here, 'scan-report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}

// ---- main ----------------------------------------------------------------
if (!existsSync(publicDir)) {
    console.error('build-publish: dashboard/public not found at ' + publicDir);
    process.exit(1);
}
const state = buildState();
const built = buildSite(state);
const report = scanSite();

console.log('site:        ' + siteDir);
console.log('banner:      данные на ' + built.builtAt);
console.log('state bytes: ' + built.payloadBytes);
console.log('files:       ' + report.files.length);
for (const f of report.files) {
    const kw = Object.keys(f.keywords).length ? JSON.stringify(f.keywords) : 'none';
    console.log('  ' + f.file.padEnd(26) + String(f.bytes).padStart(8) + ' B   keywords(id-names only): ' + kw);
}
if (report.blocked) {
    console.error('SECRET GATE: FAILED — ' + report.findings.length + ' finding(s):');
    for (const f of report.findings) console.error('  ' + f.file + ' :: ' + f.rule + ' :: ' + f.sample);
    console.error('report: ' + join(here, 'scan-report.json'));
    process.exit(2);
}
console.log('SECRET GATE: OK — no key values, paths or credential fields in the published copy');
console.log('report:      ' + join(here, 'scan-report.json'));
if (existsSync(toolsDir)) console.log('tools dir:   ' + toolsDir);
