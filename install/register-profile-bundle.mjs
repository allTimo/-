#!/usr/bin/env node
/**
 * Idempotently add (or remove) one INSTALLED package name in
 * <profileDir>/package.json -> dsh.profile.bundles.
 *
 * This replicates dshmarket's addProfileBundle/removeProfileBundle
 * (node_modules/dshmarket/lib/profile.js): the dsh CLI's `plugin add` only
 * forwards to pnpm, so the bundle row has to be written here afterwards.
 * The write is atomic (temp file + rename) and keeps the 2-space JSON + trailing
 * newline serialization every other writer in the profile uses.
 *
 * Usage:
 *   node register-profile-bundle.mjs <profileDir> <packageName>
 *   node register-profile-bundle.mjs <profileDir> <packageName> --remove
 *
 * Exit codes: 0 = ok (changed or already in the desired state), 1 = failure.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [profileDir, packageName, ...flags] = process.argv.slice(2);
const remove = flags.includes('--remove');

function fail(message) {
    process.stderr.write('register-profile-bundle: ' + message + '\n');
    process.exit(1);
}

if (!profileDir || !packageName) fail('usage: register-profile-bundle.mjs <profileDir> <packageName> [--remove]');
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) fail('no package.json at ' + manifestPath);

let manifest;
try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
}
catch (error) {
    fail('package.json is not valid JSON: ' + error.message);
}

manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const existing = manifest.dsh.profile.bundles;
const bundles = Array.isArray(existing) ? existing.filter((entry) => typeof entry === 'string') : [];

let changed = false;
if (remove) {
    if (bundles.includes(packageName)) {
        manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== packageName);
        changed = true;
    }
}
else {
    if (!bundles.includes(packageName)) {
        bundles.push(packageName);
        manifest.dsh.profile.bundles = bundles;
        changed = true;
    }
}

// Refuse to declare a bundle that is not on disk: the loader dies on a name it
// cannot resolve, so a typo here would brick the next boot.
if (!remove && !existsSync(join(profileDir, 'node_modules', packageName, 'package.json'))) {
    fail('refusing to register ' + packageName + ': node_modules/' + packageName + '/package.json does not exist');
}

if (changed) {
    const temp = manifestPath + '.tmp-register-' + process.pid + '-' + Date.now();
    writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(temp, manifestPath);
}

process.stdout.write(JSON.stringify({
    package: packageName,
    action: remove ? 'remove' : 'add',
    changed,
    bundlesCount: manifest.dsh.profile.bundles.length,
    bundles: manifest.dsh.profile.bundles,
}, null, 2) + '\n');
