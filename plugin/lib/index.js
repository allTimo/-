/**
 * dsh-marketing-skills — bundled skill provider for the real-estate marketing
 * agent project.
 *
 * The provider scans this plugin's own `skills/<name>/SKILL.md` tree (populated
 * by install/install-marketing-plugin.ps1) and serves every skill it finds to
 * the DSH skill registry.
 *
 * There are no static imports of DSH packages on purpose: the
 * @deepseek-ai/dsh-skill lookup below is dynamic and optional, so this file also
 * loads — and can be unit-tested — outside a running DSH profile.
 *
 * @module dsh-marketing-skills
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Loader entry name; must match the roster row's `name` in cordis.patch.yml. */
export const name = 'dsh-marketing-skills';

const PROVIDER_NAME = 'dsh-marketing-skills';
const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true });
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Rank assigned to our candidates. Bundled skills normally share one rank tier;
 * the DSH constant is resolved dynamically so a missing package (unit tests, a
 * bare checkout) degrades to the literal instead of failing module load.
 */
let RANK = 100;
try {
    const skillApi = await import('@deepseek-ai/dsh-skill');
    if (typeof skillApi?.BUNDLED_SKILL_RANK === 'number') RANK = skillApi.BUNDLED_SKILL_RANK;
}
catch {
    // Not running inside a DSH profile — keep the fallback rank.
}

/** Write one diagnostic line; never throws. */
function warn(message) {
    try {
        process.stderr.write('[' + PROVIDER_NAME + '] ' + message + '\n');
    }
    catch {
        // A broken stderr must not take the skill registry down with it.
    }
}

/** Strip one pair of matching surrounding quotes and unescape the inner ones. */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = trimmed.slice(1, -1);
            return first === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/\\'/g, "'");
        }
    }
    return trimmed;
}

/**
 * Parse the optional YAML frontmatter of a SKILL.md file.
 *
 * Handles what a skill author actually writes: `key: value`, quoted values,
 * folded continuations and the `|` / `>` block scalars. It is not a general YAML
 * parser and does not need to be — SKILL.md frontmatter carries name and
 * description.
 *
 * @param text - full file contents; a leading BOM is tolerated.
 * @returns the parsed attributes plus the body with the frontmatter removed.
 */
export function parseFrontmatter(text) {
    const source = typeof text === 'string' ? text : '';
    const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
    if (!match) return { attributes: {}, body: normalized };

    const attributes = {};
    let key = null;
    let chunks = [];
    let mode = 'plain';
    const commit = () => {
        if (key === null) return;
        attributes[key] = (mode === 'literal' ? chunks.join('\n') : chunks.join(' ')).trim();
        key = null;
        chunks = [];
        mode = 'plain';
    };
    const start = (line) => {
        const parsed = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
        if (!parsed) return;
        commit();
        key = parsed[1];
        const rest = parsed[2].trim();
        if (rest === '|' || rest === '|-' || rest === '|+') mode = 'literal';
        else if (rest === '>' || rest === '>-' || rest === '>+') mode = 'fold';
        else {
            mode = 'plain';
            chunks = [unquote(rest)];
        }
    };

    for (const rawLine of match[1].split(/\r?\n/)) {
        const line = rawLine.replace(/[ \t]+$/, '');
        if (key !== null && /^[ \t]+\S/.test(line)) {
            chunks.push(mode === 'literal' ? line : line.trim());
            continue;
        }
        if (key !== null) commit();
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        start(line);
    }
    commit();
    return { attributes, body: normalized.slice(match[0].length) };
}

/** First markdown H1 of a body, used when the frontmatter has no name. */
export function firstHeading(body) {
    for (const rawLine of String(body ?? '').split(/\r?\n/)) {
        const parsed = /^#\s+(.+?)\s*$/.exec(rawLine);
        if (parsed) return parsed[1].replace(/\s+/g, ' ').trim();
    }
    return '';
}

/** First non-heading, non-fence paragraph of a body, whitespace-collapsed. */
export function firstParagraph(body) {
    let insideFence = false;
    for (const rawLine of String(body ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('\u0060\u0060\u0060')) { insideFence = !insideFence; continue; }
        if (insideFence || !line || line.startsWith('#')) continue;
        return line.replace(/\s+/g, ' ');
    }
    return '';
}

/** List the skill directories under root that actually contain a SKILL.md. */
async function listSkillDirs(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            warn('skills directory not found: ' + root + ' — serving 0 skills (run install/install-marketing-plugin.ps1)');
            return [];
        }
        throw error;
    }
    const found = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const dir = join(root, entry.name);
        try {
            const info = await stat(dir);
            if (!info.isDirectory()) continue;
            const skill = await stat(join(dir, 'SKILL.md'));
            if (!skill.isFile()) {
                warn('skipping ' + entry.name + ': SKILL.md is not a regular file');
                continue;
            }
        }
        catch {
            warn('skipping ' + entry.name + ': no SKILL.md');
            continue;
        }
        found.push({ dirName: entry.name, dir });
    }
    found.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
    return found;
}

/** Build one skill candidate descriptor from a skill directory. */
async function buildCandidate(dirName, dir) {
    const skillPath = join(dir, 'SKILL.md');
    const text = await readFile(skillPath, 'utf8');
    const parsed = parseFrontmatter(text);
    const attributes = parsed.attributes;
    const frontName = typeof attributes.name === 'string' && attributes.name.trim()
        ? attributes.name.trim()
        : (firstHeading(parsed.body) || dirName);
    const described = typeof attributes.description === 'string' ? attributes.description.trim() : '';
    const description = described || firstParagraph(parsed.body) || 'Real-estate marketing skill: ' + frontName + '.';
    return {
        name: frontName,
        description: description.slice(0, MAX_DESCRIPTION_LENGTH),
        invocation: { ...INVOCATION },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dir },
        rank: RANK,
        locator: pathToFileURL(skillPath),
    };
}

/** Resolve the candidate list of a skills root, tolerating a missing directory. */
async function buildCandidates(root) {
    const dirs = await listSkillDirs(root);
    const candidates = [];
    for (const entry of dirs) {
        try {
            candidates.push(await buildCandidate(entry.dirName, entry.dir));
        }
        catch (error) {
            warn('skipping ' + entry.dirName + ': ' + (error?.message ?? error));
        }
    }
    if (candidates.length === 0) warn('no skills found under ' + root);
    return candidates;
}

const candidateCache = new Map();

/** Cached per-root candidate list; a rejection is never cached. */
function loadCandidates(root) {
    let pending = candidateCache.get(root);
    if (!pending) {
        pending = buildCandidates(root).catch((error) => {
            candidateCache.delete(root);
            throw error;
        });
        candidateCache.set(root, pending);
    }
    return pending;
}

/** Turn a candidate locator (URL, path string or resourceBase) into a URL. */
export function locatorToUrl(locator, candidate) {
    if (locator instanceof URL) return locator;
    if (typeof locator === 'string' && locator.length > 0) {
        if (/^[A-Za-z]:[\\/]/.test(locator) || locator.startsWith('\\\\')) return pathToFileURL(locator);
        try {
            return new URL(locator);
        }
        catch {
            return pathToFileURL(locator);
        }
    }
    const base = candidate?.resourceBase?.path;
    if (typeof base === 'string' && base.length > 0) return pathToFileURL(join(base, 'SKILL.md'));
    throw new Error('candidate has neither locator nor resourceBase.path');
}

/**
 * Pick the skills root: explicit config first, then the environment override the
 * contract test uses, then this plugin's own skills directory.
 */
export function resolveSkillsDir(config) {
    const configured = config?.skillsDir ?? process.env?.DSH_MARKETING_SKILLS_DIR;
    return configured ? String(configured) : DEFAULT_SKILLS_DIR;
}

/** Create the provider object handed to skills.registerProvider. */
export function createProvider(config) {
    const root = resolveSkillsDir(config);
    return {
        name: PROVIDER_NAME,
        list: () => loadCandidates(root),
        async get(candidate) {
            const content = await readFile(locatorToUrl(candidate?.locator, candidate), 'utf8');
            return { ...candidate, content };
        },
    };
}

/**
 * Register the provider with the DSH skill registry.
 * @param ctx - registrant context; ctx.inject is the soft dependency on skills.
 * @param config - bundle config from the roster row (may carry skillsDir).
 */
export function apply(ctx, config) {
    const provider = createProvider(config ?? {});
    ctx.inject(['skills'], (skillCtx) => {
        skillCtx.skills.registerProvider(() => provider);
    });
    return provider;
}
