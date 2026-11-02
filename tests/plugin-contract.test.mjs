/**
 * Contract test for the dsh-marketing-skills skill provider.
 *
 * node:test only — no external dependencies. The test imports the plugin entry
 * point directly, drives apply() with a fake registrant context and checks the
 * provider against real SKILL.md files on disk.
 *
 * Usage:
 *   node --test marketing-agents/tests/plugin-contract.test.mjs
 *   DSH_MARKETING_SKILLS_DIR=<dir> node --test marketing-agents/tests/plugin-contract.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const pluginEntry = join(repoRoot, 'plugin', 'lib', 'index.js');
const realSkillsDir = join(repoRoot, 'skills');
const stubSkillsDir = join(here, 'fixtures', 'stub-skills');
const missingSkillsDir = join(here, 'fixtures', 'does-not-exist');
const PROVIDER_ID = 'dsh-marketing-skills';

const plugin = await import(pathToFileURL(pluginEntry).href);

/** Drive apply() with a fake ctx and return what it registered. */
function captureProvider(config) {
    const captured = { injected: [], providers: [] };
    const ctx = {
        inject(services, callback) {
            captured.injected.push(services);
            callback({
                skills: {
                    registerProvider(factory) {
                        captured.providers.push(factory());
                    },
                },
            });
        },
    };
    plugin.apply(ctx, config);
    return captured;
}

/** Skill directories that really contain a SKILL.md, sorted. */
function skillDirNames(root) {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort();
}

/** Full provider contract against one skills root; returns the candidates. */
async function assertProviderContract(provider, root) {
    const expected = skillDirNames(root);
    assert.ok(expected.length > 0, 'expected at least one SKILL.md under ' + root);

    const candidates = await provider.list();
    assert.ok(Array.isArray(candidates), 'list() must resolve to an array');
    assert.equal(candidates.length, expected.length, 'one candidate per skill directory');

    const names = new Set();
    for (const candidate of candidates) {
        const where = root + ' :: ' + String(candidate && candidate.name);
        assert.equal(typeof candidate.name, 'string', where + ': name must be a string');
        assert.ok(candidate.name.length > 0, where + ': name must not be empty');
        assert.equal(typeof candidate.description, 'string', where + ': description must be a string');
        assert.ok(candidate.description.trim().length > 0, where + ': description must not be empty');
        assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true }, where + ': invocation');
        assert.equal(candidate.provider, PROVIDER_ID, where + ': provider id');
        assert.equal(candidate.source, 'bundled', where + ': source');
        assert.ok(candidate.locator instanceof URL, where + ': locator must be a URL');
        assert.equal(candidate.resourceBase.kind, 'directory', where + ': resourceBase.kind');
        assert.ok(statSync(candidate.resourceBase.path).isDirectory(), where + ': resourceBase.path must be an existing directory');
        const seenBefore = names.size;
        names.add(candidate.name);
        assert.equal(names.size, seenBefore + 1, where + ': duplicate skill name');

        const skillPath = join(candidate.resourceBase.path, 'SKILL.md');
        assert.equal(fileURLToPath(candidate.locator), skillPath, where + ': locator must point at resourceBase/SKILL.md');

        const raw = readFileSync(skillPath, 'utf8');
        const fetched = await provider.get(candidate);
        assert.equal(fetched.content, raw, where + ': get().content must be the raw SKILL.md, frontmatter included');
        assert.equal(fetched.name, candidate.name, where + ': get() must preserve candidate identity');
        assert.equal(fetched.description, candidate.description, where + ': get() must preserve the description');
        assert.equal(fetched.provider, PROVIDER_ID, where + ': get() must preserve the provider id');

        const declared = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        if (declared) {
            const declaredName = /^name:[ \t]*(.+)$/m.exec(declared[1]);
            if (declaredName) {
                assert.equal(candidate.name, declaredName[1].trim(), where + ': name must come from the frontmatter');
            }
        }
    }
    return candidates;
}

test('apply() registers exactly one skills provider', () => {
    assert.equal(plugin.name, PROVIDER_ID, 'plugin entry name');
    const captured = captureProvider({ skillsDir: stubSkillsDir });
    assert.deepEqual(captured.injected, [['skills']], 'apply() must soft-inject the skills service');
    assert.equal(captured.providers.length, 1, 'exactly one provider factory must be registered');
    assert.equal(captured.providers[0].name, PROVIDER_ID, 'provider name');
    assert.equal(typeof captured.providers[0].list, 'function', 'provider.list');
    assert.equal(typeof captured.providers[0].get, 'function', 'provider.get');
});

test('stub fixture: candidate contract, resourceBase and get() content', async () => {
    const provider = captureProvider({ skillsDir: stubSkillsDir }).providers[0];
    const candidates = await assertProviderContract(provider, stubSkillsDir);
    assert.equal(candidates.length, 2, 'fixture exposes two skills');
    assert.deepEqual(candidates.map((candidate) => candidate.name), ['Heading only skill', 'stub-marketing-skill']);
});

test('stub fixture: frontmatter, heading fallback and non-skill dirs', async () => {
    const provider = captureProvider({ skillsDir: stubSkillsDir }).providers[0];
    const candidates = await provider.list();
    const stub = candidates.find((candidate) => candidate.name === 'stub-marketing-skill');
    const heading = candidates.find((candidate) => candidate.name === 'Heading only skill');
    assert.ok(stub, 'frontmatter name wins');
    assert.equal(stub.description.startsWith('Stub skill used by the contract test'), true, 'frontmatter description wins');
    assert.equal(basename(stub.resourceBase.path), 'stub-marketing-skill');
    assert.ok(existsSync(join(stub.resourceBase.path, 'references', 'checklist.md')), 'skill resources travel with the skill');
    assert.ok(heading, 'a SKILL.md without frontmatter falls back to its H1');
    assert.equal(heading.description, 'This skill has no YAML frontmatter, so the provider must fall back to its H1 heading and first paragraph.');
    assert.equal(candidates.some((candidate) => candidate.name === 'not-a-skill'), false, 'a directory without SKILL.md is skipped');
});

test('candidate list is cached per skills root', async () => {
    const provider = captureProvider({ skillsDir: stubSkillsDir }).providers[0];
    const first = await provider.list();
    const second = await provider.list();
    assert.equal(first, second, 'list() must reuse the cached candidate list');
});

test('a missing skills directory degrades to an empty list', async () => {
    const provider = captureProvider({ skillsDir: missingSkillsDir }).providers[0];
    assert.deepEqual(await provider.list(), []);
});

test('get() rejects a candidate with no locator and no resourceBase', async () => {
    const provider = captureProvider({ skillsDir: stubSkillsDir }).providers[0];
    await assert.rejects(() => provider.get({ name: 'broken' }), /neither locator nor resourceBase/);
});

test('real marketing-agents/skills: provider contract holds', async (t) => {
    const dirs = skillDirNames(realSkillsDir);
    if (dirs.length === 0) {
        t.skip('no SKILL.md under ' + realSkillsDir + ' yet');
        return;
    }
    const provider = captureProvider({ skillsDir: realSkillsDir }).providers[0];
    const candidates = await assertProviderContract(provider, realSkillsDir);
    assert.deepEqual(candidates.map((candidate) => basename(candidate.resourceBase.path)).sort(), dirs);
    console.log('[real skills] ' + dirs.length + ' skill(s): ' + candidates.map((candidate) => candidate.name).join(', '));
});
