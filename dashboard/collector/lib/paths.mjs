// Path resolution for the dashboard collector. Works from any CWD.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));      // .../dashboard/collector/lib
export const DASHBOARD_DIR = path.resolve(here, '..', '..');     // .../dashboard
export const COLLECTOR_DIR = path.resolve(here, '..');           // .../dashboard/collector
export const PUBLIC_DIR = path.join(DASHBOARD_DIR, 'public');
export const DATA_DIR = path.join(PUBLIC_DIR, 'data');
export const CONFIG_DIR = path.join(DASHBOARD_DIR, 'config');
export const SCREENSHOTS_DIR = path.join(DASHBOARD_DIR, 'screenshots');

export const PROJECT_DIR = path.resolve(DASHBOARD_DIR, '..');            // .../marketing-agents
export const WORKSPACE_ROOT = path.resolve(PROJECT_DIR, '..');           // workspace
export const REGISTRY_DIR = path.join(PROJECT_DIR, 'registry');
export const TASKS_DIR = path.join(REGISTRY_DIR, 'tasks');

export const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');

export const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR && process.env.DSH_SESSIONS_DIR.trim() !== ''
  ? process.env.DSH_SESSIONS_DIR
  : path.join(DSH_HOME, 'sessions');

export const PROJCACHE_ROOT = process.env.DSH_PROJCACHE_DIR && process.env.DSH_PROJCACHE_DIR.trim() !== ''
  ? process.env.DSH_PROJCACHE_DIR
  : path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

export const SESSION_FILE = 'session.v4.jsonl.zstd';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSessionFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let subs = [];
    try { subs = fs.readdirSync(projDir, { withFileTypes: true }); } catch (e) { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const file = path.join(projDir, sub.name, SESSION_FILE);
      if (fs.existsSync(file)) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch (e) { size = 0; }
        out.push({ sessionId: sub.name, projectKey: proj.name, file: file, size: size });
      }
    }
  }
  out.sort(function (a, b) { return a.sessionId < b.sessionId ? -1 : 1; });
  return out;
}

// Human label for a workspace path, e.g. C:\Users\x\Desktop\test -> 'Desktop/test'.
export function workspaceLabel(cwd) {
  if (!cwd) return 'неизвестно';
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return String(cwd);
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join('/');
}
