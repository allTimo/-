// Minimal YAML subset parser + surgical writer for the marketing-agents registry.
// No external dependencies. Supports the subset actually used by registry/*.yaml:
// nested maps by indentation, block lists ('- '), inline [..] / {..}, quoted strings,
// numbers, booleans, null, block scalars (| and >), and '#' comments.

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') { i++; out += line[i] === undefined ? '' : line[i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function unescapeDouble(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, function (m, g) {
    switch (g[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case '0': return '\u0000';
      case 'u': case 'x': return String.fromCharCode(parseInt(g.slice(1), 16));
      default: return g;
    }
  });
}

function splitInline(s) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { cur += s[i + 1] === undefined ? '' : s[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*?)\s*:(?:\s+|$)/;
const BLOCK_RE = /^[|>][-+]?\d*$/;

export function matchKey(text) {
  return KEY_RE.exec(text);
}

export function parseScalar(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unescapeDouble(s.slice(1, -1));
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInline(inner).map(parseScalar);
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const raw of splitInline(inner)) {
      // Части после запятой приходят с ведущим пробелом — без trim ключ не распознаётся,
      // и в инлайн-объекте читался бы только первый ключ.
      const part = raw.trim();
      const m = matchKey(part);
      if (!m) continue;
      obj[parseScalar(m[1])] = parseScalar(part.slice(m[0].length));
    }
    return obj;
  }
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

export function parseYaml(text) {
  const items = [];
  const rawLines = String(text).split(/\r?\n/);
  for (let n = 0; n < rawLines.length; n++) {
    const stripped = stripComment(rawLines[n]).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    const indent = stripped.match(/^ */)[0].length;
    items.push({ indent: indent, text: stripped.slice(indent), lineNo: n + 1 });
  }
  let pos = 0;
  function peek() { return pos < items.length ? items[pos] : null; }

  function readBlockScalar(parentIndent) {
    const lines = [];
    let baseIndent = null;
    while (pos < items.length && items[pos].indent > parentIndent) {
      const it = items[pos];
      if (baseIndent === null) baseIndent = it.indent;
      lines.push(' '.repeat(Math.max(0, it.indent - baseIndent)) + it.text);
      pos++;
    }
    return lines.join('\n');
  }

  function parseNode(indent) {
    const it = peek();
    if (!it || it.indent < indent) return null;
    if (it.text === '-' || it.text.startsWith('- ')) return parseList(it.indent);
    return parseMap(it.indent);
  }

  function parseList(indent) {
    const arr = [];
    while (true) {
      const it = peek();
      if (!it || it.indent !== indent) break;
      if (!(it.text === '-' || it.text.startsWith('- '))) break;
      pos++;
      const body = it.text === '-' ? '' : it.text.slice(1);
      const lead = body.match(/^ */)[0].length;
      const contentIndent = indent + 1 + lead;
      const content = body.slice(lead);
      if (content === '') {
        const nxt = peek();
        arr.push(nxt && nxt.indent > indent ? parseNode(nxt.indent) : null);
        continue;
      }
      if (BLOCK_RE.test(content)) { arr.push(readBlockScalar(indent)); continue; }
      // Инлайн-объект или массив: `- { id: x, name: "y" }` — это ЗНАЧЕНИЕ, а не начало блока.
      // Без этой проверки строка вида «{ id: x }» ошибочно принималась за карту.
      if (content[0] === '{' || content[0] === '[') { arr.push(parseScalar(content)); continue; }
      if (matchKey(content)) {
        items.splice(pos, 0, { indent: contentIndent, text: content, lineNo: it.lineNo });
        arr.push(parseMap(contentIndent));
        continue;
      }
      arr.push(parseScalar(content));
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (true) {
      const it = peek();
      if (!it || it.indent !== indent) break;
      if (it.text === '-' || it.text.startsWith('- ')) break;
      const m = matchKey(it.text);
      if (!m) { pos++; continue; }
      pos++;
      const key = parseScalar(m[1]);
      const rest = it.text.slice(m[0].length).replace(/^\s+/, '');
      if (rest === '') {
        const nxt = peek();
        obj[key] = nxt && nxt.indent > indent ? parseNode(nxt.indent) : null;
      } else if (BLOCK_RE.test(rest)) {
        obj[key] = readBlockScalar(indent);
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  const root = parseNode(items.length ? items[0].indent : 0);
  return root === null ? {} : root;
}

export function parseYamlFile(fs, filePath) {
  return parseYaml(fs.readFileSync(filePath, 'utf8'));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate the block of one list item (agent entry) in agents.yaml by its id.
export function findListItem(lines, idField, idValue) {
  const re = new RegExp('^\\s*-\\s*' + escapeRe(idField) + '\\s*:\\s*["\']?' + escapeRe(idValue) + '["\']?\\s*(?:#.*)?$');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const ind = line.match(/^\s*/)[0].length;
    if (ind <= indent) { end = i; break; }
  }
  return { start: start, end: end, indent: indent };
}

// Surgically flip 'enabled:' inside one agent block, preserving every comment.
export function setListItemFlag(text, opts) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const block = findListItem(lines, opts.idField || 'id', opts.idValue);
  if (!block) return { ok: false, reason: 'agent-not-found', text: text };
  const flag = opts.flag || 'enabled';
  const want = opts.value === true ? 'true' : 'false';
  const flagRe = new RegExp('^(\\s*' + escapeRe(flag) + '\\s*:\\s*)(true|false)(\\s*(?:#.*)?)$');
  for (let i = block.start; i < block.end; i++) {
    const m = flagRe.exec(lines[i]);
    if (m) {
      if (m[2] === want) return { ok: true, changed: false, text: text, line: i + 1, previous: m[2] };
      lines[i] = m[1] + want + m[3];
      return { ok: true, changed: true, text: lines.join(eol), line: i + 1, previous: m[2] };
    }
  }
  const indent = ' '.repeat(block.indent + 2);
  lines.splice(block.start + 1, 0, indent + flag + ': ' + want);
  return { ok: true, changed: true, text: lines.join(eol), line: block.start + 2, previous: null };
}
// --- Правка значений в YAML с сохранением комментариев и порядка строк ---
// Используется вкладкой «Настройки»: меняется ровно значение после двоеточия,
// всё остальное в файле остаётся байт-в-байт.

export function setYamlScalar(text, path, value) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    const indent = stripped.match(/^ */)[0].length;
    const m = /^([A-Za-z0-9_.@/\-]+)\s*:\s*(.*)$/.exec(stripped.slice(indent));
    if (!m) continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[1];
    const cur = stack.map(function (s) { return s.key; }).concat([key]);
    const matches = cur.length === path.length && cur.every(function (k, idx) { return k === path[idx]; });
    if (matches) {
      const colon = raw.indexOf(':', indent);
      if (colon < 0) continue;
      const after = raw.slice(colon + 1);
      const cm = /^(\s*)([^#]*?)(\s*#.*)?$/.exec(after);
      const prev = cm[2].trim();
      lines[i] = raw.slice(0, colon + 1) + cm[1] + String(value) + (cm[3] || '');
      return { ok: true, changed: prev !== String(value), text: lines.join(eol), line: i + 1, previous: prev };
    }
    stack.push({ key: key, indent: indent });
  }
  return { ok: false, reason: 'path-not-found', path: path.join('.') };
}

// Замена списка (например output.formats) — переписываются только строки списка.
export function setYamlList(text, path, values) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    const indent = stripped.match(/^ */)[0].length;
    const m = /^([A-Za-z0-9_.@/\-]+)\s*:\s*(.*)$/.exec(stripped.slice(indent));
    if (!m) continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[1];
    const cur = stack.map(function (s) { return s.key; }).concat([key]);
    if (cur.length === path.length && cur.every(function (k, idx) { return k === path[idx]; })) {
      // собираем блок строк списка сразу после ключа
      let j = i + 1;
      const itemIndent = indent + 2;
      const before = [];
      const items = [];
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') { j++; continue; }
        const li = l.match(/^ */)[0].length;
        if (li < itemIndent || !/^\s*-/.test(l)) break;
        const cleaned = stripComment(l).trim();
        before.push(cleaned);
        items.push({ value: cleaned.replace(/^-\s*/, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'), raw: l });
        j++;
      }
      // Сохраняем исходные строки (с отступами и комментариями) для значений,
      // которые не изменились, — тогда правка не трогает ничего лишнего.
      const rawByVal = {};
      for (const it of items) rawByVal[it.value] = it.raw;
      const rendered = values.map(function (v) {
        const key = String(v);
        return rawByVal[key] !== undefined ? rawByVal[key] : (' '.repeat(itemIndent) + '- "' + key + '"');
      });
      const out = lines.slice(0, i + 1).concat(rendered, lines.slice(j));
      return { ok: true, changed: before.join(',') !== values.map(function (v) { return '- "' + v + '"'; }).join(','), text: out.join(eol), line: i + 1, previous: before.join(', ') };
    }
    stack.push({ key: key, indent: indent });
  }
  return { ok: false, reason: 'path-not-found', path: path.join('.') };
}
// Правка скалярного поля внутри блока элемента списка (агента/источника).
export function setListItemField(text, opts) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const block = findListItem(lines, opts.idField || 'id', opts.idValue);
  if (!block) return { ok: false, reason: 'item-not-found' };
  const field = opts.field;
  const re = new RegExp('^(\\s*' + escapeRe(field) + '\\s*:\\s*)([^#]*?)(\\s*#.*)?$');
  for (let i = block.start; i < block.end; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const prev = m[2].trim();
      const next = String(opts.value);
      if (prev === next) return { ok: true, changed: false, text: text, line: i + 1, previous: prev };
      lines[i] = m[1] + next + (m[3] || '');
      return { ok: true, changed: true, text: lines.join(eol), line: i + 1, previous: prev };
    }
  }
  // поля нет — добавляем после id
  const indent = ' '.repeat(block.indent + 2);
  lines.splice(block.start + 1, 0, indent + field + ': ' + String(opts.value));
  return { ok: true, changed: true, text: lines.join(eol), line: block.start + 2, previous: null };
}

// Правка списочного поля внутри блока (projects: [a, b], groups: ["x", "y"]).
export function setListItemArray(text, opts) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const block = findListItem(lines, opts.idField || 'id', opts.idValue);
  if (!block) return { ok: false, reason: 'item-not-found' };
  const values = opts.values || [];
  const quoted = opts.quoted !== false;
  const rendered = '[' + values.map(function (v) { return quoted ? '"' + String(v) + '"' : String(v); }).join(', ') + ']';
  const re = new RegExp('^(\\s*' + escapeRe(opts.field) + '\\s*:\\s*)([^#]*?)(\\s*#.*)?$');
  for (let i = block.start; i < block.end; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const prev = m[2].trim();
      if (prev === rendered) return { ok: true, changed: false, text: text, line: i + 1, previous: prev };
      lines[i] = m[1] + rendered + (m[3] || '');
      return { ok: true, changed: true, text: lines.join(eol), line: i + 1, previous: prev };
    }
  }
  const indent = ' '.repeat(block.indent + 2);
  lines.splice(block.start + 1, 0, indent + opts.field + ': ' + rendered);
  return { ok: true, changed: true, text: lines.join(eol), line: block.start + 2, previous: null };
}