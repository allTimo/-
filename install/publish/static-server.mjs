#!/usr/bin/env node
/**
 * READ-ONLY static server for the published dashboard copy.
 *
 *   node marketing-agents/install/publish/static-server.mjs [port]
 *
 * Serves install/publish/site over loopback only: GET and HEAD, no request
 * bodies, no /api/* (the published copy has no server API and no write path),
 * no directory listing, and a path-traversal guard. Anything else is 405/404.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(here, 'site');
const PORT = Number(process.argv[2] || process.env.PUBLISH_PORT || 8899);
const HOST = process.env.PUBLISH_HOST || '127.0.0.1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
};

function log(line) {
    process.stdout.write('[' + new Date().toISOString() + '] ' + line + '\n');
}

function send(res, status, body, type) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-Publish-Mode': 'read-only',
    });
    if (res.req && res.req.method === 'HEAD') res.end();
    else res.end(text);
}

const server = createServer((req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;

    if (method !== 'GET' && method !== 'HEAD') {
        log(method + ' ' + p + ' -> 405 (read-only copy)');
        return send(res, 405, { ok: false, error: 'read-only copy: only GET/HEAD', method, path: p }, 'application/json; charset=utf-8');
    }
    if (p === '/api' || p.startsWith('/api/')) {
        log(method + ' ' + p + ' -> 404 (no API here)');
        return send(res, 404, { ok: false, error: 'no server API in the published read-only copy', path: p }, 'application/json; charset=utf-8');
    }

    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = normalize(join(SITE_DIR, rel));
    if (target !== SITE_DIR && !target.startsWith(SITE_DIR + require_sep())) {
        log(method + ' ' + p + ' -> 403 (traversal)');
        return send(res, 403, '403 — путь вне публикуемой папки');
    }
    if (!existsSync(target)) {
        log(method + ' ' + p + ' -> 404');
        return send(res, 404, '404 — не найдено: ' + rel);
    }
    const st = statSync(target);
    if (st.isDirectory()) {
        const index = join(target, 'index.html');
        if (existsSync(index)) {
            log(method + ' ' + p + ' -> 200 (dir index)');
            return stream(res, index, st);
        }
        log(method + ' ' + p + ' -> 403 (no listing)');
        return send(res, 403, '403 — листинг каталогов отключён');
    }
    log(method + ' ' + p + ' -> 200 (' + st.size + ' B)');
    return stream(res, target, st);
});

function require_sep() {
    return process.platform === 'win32' ? '\\' : '/';
}

function stream(res, file, st) {
    res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-Publish-Mode': 'read-only',
    });
    if (res.req && res.req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
}

server.listen(PORT, HOST, () => {
    log('read-only static server: http://' + HOST + ':' + PORT + '  root=' + SITE_DIR);
});
server.on('error', (error) => {
    log('server error: ' + error.message);
    process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log('stopping on ' + signal);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500);
    });
}
