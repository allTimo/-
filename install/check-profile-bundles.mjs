#!/usr/bin/env node
/**
 * Pre-restart safety check for the desktop profile's community bundles.
 *
 * The Electron app owns the desktop profile, so \`dsh --dump-config\` refuses to
 * compose it and there is no offline boot test. This script covers what can be
 * checked offline and what actually bricks a boot:
 *
 *   1. profile package.json parses, dsh.profile.bundles has no duplicates and
 *      every COMMUNITY bundle is declared in dependencies;
 *   2. each community bundle resolves in node_modules with a loadable entry
 *      (main/exports/index.js) or is a carrier bundle naming other packages;
 *   3. each bundle's dsh.bundle.patch exists and parses as YAML (js-yaml from
 *      the profile; !!js tags are tolerated structurally);
 *   4. no two bundles INSERT the same loader entry id — a duplicate id makes
 *      cordis fail the whole tree, which is the failure the market's
 *      conflictingEntryIds guards (#122).
 *
 * Usage: node check-profile-bundles.mjs <profileDir>
 * Exit 0 = all checks passed, 1 = at least one finding.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const profileDir = process.argv[2];
if (!profileDir) {
    process.stderr.write('usage: check-profile-bundles.mjs <profileDir>\n');
    process.exit(1);
}

const INBOX = (name) => name.startsWith('@deepseek-ai/');
const findings = [];
const report = [];

const manifestPath = join(profileDir, 'package.json');
let manifest;
try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    report.push('package.json: parses OK');
}
catch (error) {
    report.push('package.json: PARSE FAILED - ' + error.message);
    process.stdout.write(report.join('\n') + '\n');
    process.exit(1);
}

const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
const duplicates = bundles.filter((name, index) => bundles.indexOf(name) !== index);
if (duplicates.length > 0) findings.push('duplicate bundles: ' + [...new Set(duplicates)].join(', '));
report.push('bundles: ' + bundles.length + ' (' + duplicates.length + ' duplicates)');

const community = bundles.filter((name) => !INBOX(name));
const dependencies = manifest.dependencies ?? {};

let yaml = null;
for (const candidate of [join(profileDir, 'node_modules', 'js-yaml'), 'js-yaml']) {
    try {
        yaml = createRequire(import.meta.url)(candidate);
        break;
    }
    catch { /* try the next resolution root */ }
}
report.push('js-yaml: ' + (yaml ? 'loaded' : 'NOT AVAILABLE (patch parsing skipped)'));

const insertedIds = new Map();
const loadable = (dir) => {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); }
    catch { return false; }
    const candidates = [pkg.main, pkg.module, 'index.js', 'index.mjs']
        .filter((value) => typeof value === 'string' && value.length > 0);
    if (pkg.exports !== undefined) candidates.unshift('exports');
    for (const value of candidates) {
        if (value === 'exports') return true;
        if (existsSync(join(dir, value))) return true;
    }
    return false;
};

const parsePatch = (file) => {
    const text = readFileSync(file, 'utf8');
    if (!yaml) return { ok: true, mode: 'skipped' };
    try { return { ok: true, mode: 'strict', doc: yaml.load(text) }; }
    catch (error) {
        if (!/unknown tag/i.test(String(error?.message))) return { ok: false, detail: String(error.message).split('\n')[0] };
        const stripped = text.split(/\r?\n/).map((line) => line.replace(/(:\s*|-\s*)!!js\S*\s*/, '$1')).join('\n');
        try { return { ok: true, mode: 'tolerant (!!js stripped)', doc: yaml.load(stripped) }; }
        catch (inner) { return { ok: false, detail: String(inner.message).split('\n')[0] }; }
    }
};

for (const name of community) {
    const dir = join(profileDir, 'node_modules', name);
    const line = ['- ' + name];
    if (!existsSync(join(dir, 'package.json'))) {
        findings.push(name + ': not installed (no node_modules/' + name + '/package.json)');
        report.push(line.concat('NOT INSTALLED').join('  '));
        continue;
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    line.push(pkg.version ?? '?');
    if (!dependencies[name]) findings.push(name + ': in bundles but not in dependencies');

    const patchRel = typeof pkg.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch.replace(/^\.\//, '') : null;
    let parsed = null;
    if (!patchRel) {
        findings.push(name + ': declares no dsh.bundle.patch');
    }
    else if (!existsSync(join(dir, patchRel))) {
        findings.push(name + ': patch file ' + patchRel + ' is missing');
    }
    else {
        parsed = parsePatch(join(dir, patchRel));
        if (!parsed.ok) findings.push(name + ': patch does not parse: ' + parsed.detail);
        else line.push('patch=' + parsed.mode);
    }

    if (loadable(dir)) line.push('entry=ok');
    else {
        // Carrier bundle: its patch mounts other packages. Accept when the patch
        // names at least one package that resolves locally.
        const rows = [];
        if (parsed?.doc) {
            for (const entry of Array.isArray(parsed.doc) ? parsed.doc : []) {
                for (const item of Array.isArray(entry?.insert) ? entry.insert : []) {
                    if (typeof item?.name === 'string') rows.push(item.name);
                }
            }
        }
        const targets = rows.filter((target) => target !== name);
        const communityTargets = targets.filter((target) => !INBOX(target));
        const resolves = communityTargets.some((target) => existsSync(join(profileDir, 'node_modules', target, 'package.json')));
        // A carrier that mounts ONLY in-box packages is sound: those resolve from
        // the DSH installation, not from the profile (dshmarket's hasLoadableEntry
        // checks the host's own tree for exactly this case, #906).
        const inboxOnly = targets.length > 0 && communityTargets.length === 0;
        if (resolves) line.push('entry=carrier(' + communityTargets.length + ' community targets)');
        else if (inboxOnly) line.push('entry=carrier(in-box only: ' + targets.join(', ') + ')');
        else {
            findings.push(name + ': no loadable entry and no resolvable carrier target');
            line.push('entry=MISSING');
        }
    }

    if (parsed?.doc) {
        for (const entry of Array.isArray(parsed.doc) ? parsed.doc : []) {
            for (const item of Array.isArray(entry?.insert) ? entry.insert : []) {
                const id = item?.id;
                if (typeof id !== 'string' || id === '') continue;
                if (!insertedIds.has(id)) insertedIds.set(id, []);
                if (!insertedIds.get(id).includes(name)) insertedIds.get(id).push(name);
            }
        }
    }
    report.push(line.join('  '));
}

for (const [id, owners] of insertedIds) {
    if (owners.length > 1) findings.push('duplicate inserted entry id "' + id + '" in: ' + owners.join(', '));
}

report.push('inserted entry ids across community bundles: ' + insertedIds.size);
report.push('');
report.push(findings.length === 0 ? 'RESULT: OK' : 'RESULT: ' + findings.length + ' finding(s)');
for (const finding of findings) report.push('  ! ' + finding);
process.stdout.write(report.join('\n') + '\n');
process.exit(findings.length === 0 ? 0 : 1);
