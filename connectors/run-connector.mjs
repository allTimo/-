#!/usr/bin/env node
/**
 * One-shot MCP client for the ru-marketplace-mcp connectors ("call and release").
 *
 * Spawns the MCP server over stdio, does the JSON-RPC handshake, calls EXACTLY
 * ONE tool, prints the answer as JSON on stdout and exits, killing the child.
 * Nothing is mounted in the DSH profile, so no tool schema ever sits in the model
 * context: the Agent 1 engine calls this wrapper per run.
 *
 * Usage:
 *   node run-connector.mjs --tool cian_search --args-file args.json
 *   node run-connector.mjs --list-tools
 *
 * Env: RU_CONNECTOR_DIR (repo checkout), RU_CONNECTOR_UV (uv.exe), RU_CONNECTOR_PYTHON.
 * Exit: 0 ok, 2 reserved, 3 transport/usage error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes('--' + name);

const repoDir = opt('repo', process.env.RU_CONNECTOR_DIR || join(here, 'ru-marketplace-mcp'));
const uvExe = opt('uv', process.env.RU_CONNECTOR_UV || join(here, 'bin', 'uv.exe'));
const server = opt('server', 'marketplace-mcp');
const tool = opt('tool', null);
const timeoutSec = Number(opt('timeout', '180'));
const listTools = flag('list-tools');
const argsFile = opt('args-file', null);
const outPath = opt('out', null);

function emit(code, payload) {
    const line = JSON.stringify(payload);
    if (outPath) {
        try { writeFileSync(outPath, line + '\n', 'utf8'); }
        catch (error) { process.stderr.write('run-connector: cannot write --out ' + outPath + ': ' + error.message + '\n'); }
    }
    process.stdout.write(line + '\n');
    try { child.stdin.end(); } catch { /* closed */ }
    try { child.kill(); } catch { /* gone */ }
    process.exit(code);
}
function fail(code, message) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
    process.stderr.write('run-connector: ' + message + '\n');
    process.exit(code);
}

if (!existsSync(repoDir)) fail(3, 'repo checkout not found: ' + repoDir);
if (!existsSync(uvExe)) fail(3, 'uv.exe not found: ' + uvExe);
if (!tool && !listTools) fail(3, 'usage: --tool <name> [--args-file f] | --list-tools');

let args = {};
const rawArgs = argsFile ? (existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : null) : opt('args', null);
if (argsFile && rawArgs === null) fail(3, 'args file not found: ' + argsFile);
if (rawArgs) {
    try { args = JSON.parse(rawArgs); }
    catch (error) { fail(3, 'invalid args JSON: ' + error.message); }
}

const env = Object.assign({}, process.env);
if (!env.UV_PYTHON && process.env.RU_CONNECTOR_PYTHON) env.UV_PYTHON = process.env.RU_CONNECTOR_PYTHON;
env.UV_NO_PROGRESS = '1';

const child = spawn(uvExe, ['run', '--frozen', '--directory', repoDir, server], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });

let buffer = '';
let nextId = 1;
const pending = new Map();
let stderrTail = '';
child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
child.on('error', (error) => fail(3, 'failed to spawn uv: ' + error.message));
child.on('exit', (code, signal) => {
    for (const [, entry] of pending) entry.reject(new Error('server exited (code ' + code + ', signal ' + signal + ')'));
    pending.clear();
});
function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error('rpc error ' + JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
    }
}
child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
    }
});
function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout after ' + Math.round(timeoutMs / 1000) + 's on ' + method)); }, timeoutMs);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}
function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const wantNewbuilding = opt('newbuilding', null);
const scanPages = Math.min(Math.max(Number(opt('pages', '1')), 1), 5);

const totalTimeout = timeoutSec * 1000;
try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'marketing-agents-run-connector', version: '1.0.0' } }, Math.min(totalTimeout, 60000));
    notify('notifications/initialized', {});
    if (listTools) {
        const listed = await request('tools/list', {}, Math.min(totalTimeout, 60000));
        emit(0, { ok: true, server, tools: (listed.tools || []).map((t) => ({ name: t.name, description: (t.description || '').slice(0, 120) })) });
    }
    const started = Date.now();
    let result = await request('tools/call', { name: tool, arguments: args }, totalTimeout);
    // LOCAL PATCH (see connectors/PATCHES.md): Cian's search API silently ignores
    // a new-building filter, so a ЖК-scoped search is done by scanning the requested
    // pages and keeping only rows whose newbuilding_name matches.
    if (wantNewbuilding) {
        const needle = wantNewbuilding.toLowerCase();
        const matched = [];
        const perPage = [];
        let scanned = 0;
        for (let page = 1; page <= scanPages; page++) {
            const pageArgs = Object.assign({}, args, { page });
            const pageResult = page === 1 ? result : await request('tools/call', { name: tool, arguments: pageArgs }, totalTimeout);
            let pagePayload = null;
            for (const block of (Array.isArray(pageResult.content) ? pageResult.content : [])) {
                if (block && typeof block.text === 'string') { try { pagePayload = JSON.parse(block.text); break; } catch { /* next */ } }
            }
            const items = pagePayload && Array.isArray(pagePayload.items) ? pagePayload.items : [];
            scanned += items.length;
            perPage.push(items.length);
            for (const item of items) {
                const haystack = ((item.newbuilding_name || '') + ' ' + (item.title || '') + ' ' + (item.address || '')).toLowerCase();
                if (haystack.includes(needle)) matched.push(item);
            }
            if (items.length < 28) break;
        }
        emit(0, {
            ok: true,
            tool,
            server,
            mode: 'newbuilding-filter (client side: Cian ignores a server-side filter)',
            filter: { newbuilding: wantNewbuilding, pages_scanned: perPage.length },
            scanned,
            matched: matched.length,
            per_page_items: perPage,
            items: matched,
        });
    }

    let payload = null;
    const texts = [];
    for (const block of (Array.isArray(result.content) ? result.content : [])) {
        if (!block || typeof block.text !== 'string') continue;
        texts.push(block.text);
        if (payload === null) { try { payload = JSON.parse(block.text); } catch { /* leave as text */ } }
    }
    if (payload === null && result.structuredContent) payload = result.structuredContent;
    emit(0, {
        ok: !result.isError,
        tool,
        server,
        elapsed_ms: Date.now() - started,
        is_error: Boolean(result.isError),
        payload,
        text: payload === null && texts.length ? texts.join('\n') : undefined,
        result,
    });
}
catch (error) {
    emit(3, { ok: false, tool, server, error: error.message, server_stderr_tail: stderrTail.slice(-1500) });
}
