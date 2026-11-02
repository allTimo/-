/* Правки навигации T40: «Агенты» с двумя вкладками и раздел «Результаты». */
'use strict';

var agentsTab = 'executors';

// Сохраняем исходные экраны под понятными именами, потом подменяем их обёртками.
VIEWS.agentsExecutors = VIEWS.agents;   // исходный экран агентов (app.js)
VIEWS.agentsSources = VIEWS.sources;    // исходный экран источников (app-views2.js)

// ОДНА категория «Агенты» с внутренними вкладками. Список вкладок — из конфига
// dashboard/config/agents-tabs.yaml, поэтому новая агентская категория добавляется
// записью в конфиге, без правки этой логики.
var AGENT_TAB_KEY = 'dsh.agents.tab';

function agentTabsList() {
  // Внимание: имя файла данных — agents-tabs.json, ключ в STATE получается с дефисом
  // ('agent-tabs'), а не в camelCase. Обращаемся по точному имени.
  var d = STATE && (STATE['agent-tabs'] || STATE.agentTabs);
  if (d && d.tabs && d.tabs.length) return d.tabs;
  return [{ id: 'executors', label: 'Исполнители', enabled: true }, { id: 'sources', label: 'Источники', enabled: true }];
}
function agentTabFromHash() {
  var m = /^#agents\/([a-z0-9-]+)/i.exec(String(window.location.hash || ''));
  return m ? m[1] : null;
}
function currentAgentTab() {
  var list = agentTabsList();
  var fromHash = agentTabFromHash();
  if (fromHash && list.some(function (t) { return t.id === fromHash; })) return fromHash;
  if (fromHash) {
    // Неизвестная подвкладка: остаёмся в разделе «Агенты», показываем ПЕРВУЮ вкладку и
    // выравниваем адрес под неё, чтобы адрес и содержимое не расходились.
    var first = (list[0] || {}).id || 'executors';
    toast('Вкладка «' + fromHash + '» не найдена — показываю «' + ((list[0] || {}).label || '') + '».', 'bad');
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#agents/' + first);
    return first;
  }
  var saved = null;
  try { saved = window.localStorage.getItem(AGENT_TAB_KEY); } catch (e) { /* ignore */ }
  if (saved && list.some(function (t) { return t.id === saved; })) return saved;
  return (list[0] || {}).id || 'executors';
}
function setAgentTab(id) {
  try { window.localStorage.setItem(AGENT_TAB_KEY, id); } catch (e) { /* ignore */ }
  if (window.location.hash !== '#agents/' + id) window.location.hash = '#agents/' + id;
}

VIEWS.agents = function (view) {
  var list = agentTabsList();
  var active = currentAgentTab();
  var tabs = el('div', 'seg-switch');
  list.forEach(function (t) {
    var b = el('button', 'seg-btn' + (active === t.id ? ' on' : '') + (t.enabled === false ? ' off' : ''), t.label + (t.enabled === false ? ' · скоро' : ''));
    b.title = t.hint || t.label;
    b.addEventListener('click', function () {
      if (t.enabled === false) { toast('Вкладка «' + t.label + '» появится позже: экран ещё не готов.', 'bad'); return; }
      setAgentTab(t.id);
      renderSidebar();
      renderActive();
    });
    tabs.appendChild(b);
  });
  view.appendChild(tabs);
  var cur = list.filter(function (t) { return t.id === active; })[0];
  if (cur && cur.hint) view.appendChild(el('div', 'hintline', cur.hint));
  if (!cur) { view.appendChild(note('bad', 'Вкладка «' + active + '» не найдена в конфиге.')); return; }
  if (cur.enabled === false) {
    view.appendChild(note('warn', 'Раздел «' + cur.label + '» в подготовке. ' + (cur.hint || '')));
    return;
  }
  var screen = VIEWS['agents-' + cur.id] || VIEWS[cur.id];
  var legacy = { executors: 'agentsExecutors', sources: 'agentsSources' };
  if (legacy[cur.id] && VIEWS[legacy[cur.id]]) screen = VIEWS[legacy[cur.id]];
  if (screen) screen(view);
  else view.appendChild(note('bad', 'Экран вкладки «' + cur.label + '» не загружен.'));
};

// Старые ссылки не ломаем: #sources открывает «Агентов» на вкладке источников.
VIEWS.sources = function (view) {
  setAgentTab('sources');
  VIEWS.agents(view);
};

/* ---------------- Результаты ---------------- */
var resultsFilters = { client: 'all', status: 'all' };

function sentStatusBadge(st) {
  var map = { 'отправлено': 'ok', 'ожидает': 'warn', 'ошибка': 'bad', 'не отправлялось': 'grey' };
  return badge(st, map[st] || 'grey');
}

VIEWS.results = function (view) {
  var doc = STATE.service;
  if (!doc || !doc.results) {
    view.appendChild(note('bad', 'Нет данных о результатах. Пересоберите: node marketing-agents/dashboard/collector/collect.mjs'));
    return;
  }
  var all = doc.results;
  view.appendChild(note(null, 'Здесь фиксируется ФИНАЛЬНЫЙ результат работы: что сделано, какие файлы получились и КУДА ЭТО ОТПРАВЛЕНО. В MVP отправка выполняется вручную — панель хранит факт отправки, но сама сообщения не рассылает.'));

  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Результатов', String(doc.counts.results), 'готовых работ', 'accent'));
  k.appendChild(kpi('Отправлено', String(doc.counts.resultsSent), 'клиенту доставлено', 'ok'));
  k.appendChild(kpi('Ожидает отправки', String(doc.counts.resultsPending), 'нужно отправить вручную', doc.counts.resultsPending ? 'warn' : 'ok'));
  k.appendChild(kpi('Каналов', '5', 'Telegram · VK · WhatsApp · Почта · ссылка', ''));
  view.appendChild(k);

  // фильтры
  var f = el('div', 'filters');
  var cw = el('div');
  cw.appendChild(el('label', null, 'Клиент: '));
  var csel = el('select');
  var o0 = el('option', null, 'все'); o0.value = 'all'; csel.appendChild(o0);
  var clients = {};
  all.forEach(function (r) { clients[r.clientName] = true; });
  Object.keys(clients).forEach(function (n) {
    var o = el('option', null, n); o.value = n;
    if (resultsFilters.client === n) o.selected = true;
    csel.appendChild(o);
  });
  csel.addEventListener('change', function () { resultsFilters.client = this.value; renderActive(); });
  cw.appendChild(csel);
  f.appendChild(cw);

  var sw = el('div');
  sw.appendChild(el('label', null, 'Статус отправки: '));
  var ssel = el('select');
  ['все', 'отправлено', 'ожидает', 'ошибка', 'не отправлялось'].forEach(function (s) {
    var o = el('option', null, s); o.value = s;
    if (resultsFilters.status === s) o.selected = true;
    ssel.appendChild(o);
  });
  ssel.addEventListener('change', function () { resultsFilters.status = this.value; renderActive(); });
  sw.appendChild(ssel);
  f.appendChild(sw);
  view.appendChild(f);

  var list = all.filter(function (r) {
    if (resultsFilters.client !== 'all' && r.clientName !== resultsFilters.client) return false;
    if (resultsFilters.status !== 'all' && r.sentStatus !== resultsFilters.status) return false;
    return true;
  });

  var s = section('Результаты работы', 'показано ' + list.length + ' из ' + all.length);
  if (list.length === 0) s.appendChild(note(null, 'Под фильтр ничего не попало.'));
  list.forEach(function (r) { s.appendChild(resultCard(r)); });
  view.appendChild(s);
};

function resultCard(r) {
  var c = card(r.title);
  var meta = el('div', 'agent-meta');
  meta.appendChild(badge(r.clientName, 'accent'));
  if (r.period) meta.appendChild(badge('период: ' + r.period, 'grey'));
  if (r.serviceName) meta.appendChild(badge(r.serviceName, 'purple'));
  if (r.agent) meta.appendChild(badge(r.agent, 'grey'));
  meta.appendChild(sentStatusBadge(r.sentStatus));
  c.appendChild(meta);

  c.appendChild(el('div', 'small muted', 'Что сделано: ' + (r.summary || '—')));
  c.appendChild(el('div', 'hintline', 'Готово: ' + (r.created ? fmtDateTime(Date.parse(r.created)) : '—')));

  // артефакты
  var af = el('div', 'small muted');
  af.appendChild(el('span', null, 'Файлы результата: '));
  if (r.artifacts.length === 0) af.appendChild(el('span', null, 'нет'));
  else r.artifacts.forEach(function (a, i) {
    if (i > 0) af.appendChild(document.createTextNode(' · '));
    var code = el('code', null, a.split(/[\\/]/).pop());
    code.title = 'Файл на диске: ' + a;
    af.appendChild(code);
  });
  c.appendChild(af);

  // куда отправлено — редактируемое
  var box = el('div', 'sent-box');
  box.appendChild(el('div', 'sent-title', 'Куда отправлено'));
  var row1 = el('div', 'setting-row');
  row1.appendChild(el('span', 'small muted', 'Канал: '));
  var ch = el('select');
  Object.keys(STATE.service.sentChannels).forEach(function (k) {
    var o = el('option', null, STATE.service.sentChannels[k]); o.value = k;
    if (r.sentChannel === k) o.selected = true;
    ch.appendChild(o);
  });
  ch.addEventListener('change', function () { saveResult(r, 'sent_channel', ch.value, ch); });
  row1.appendChild(ch);
  row1.appendChild(el('span', 'small muted', 'Куда: '));
  var to = el('input');
  to.type = 'text';
  to.value = r.sentTo || '';
  to.placeholder = 'канал, чат или адрес';
  to.style.minWidth = '200px';
  row1.appendChild(to);
  var saveTo = el('button', 'btn small', 'Сохранить');
  saveTo.addEventListener('click', function () { saveResult(r, 'sent_to', to.value, saveTo); });
  row1.appendChild(saveTo);
  row1.appendChild(el('span', 'small muted', 'Статус: '));
  var st = el('select');
  ['отправлено', 'ожидает', 'ошибка', 'не отправлялось'].forEach(function (s) {
    var o = el('option', null, s); o.value = s;
    if (r.sentStatus === s) o.selected = true;
    st.appendChild(o);
  });
  st.addEventListener('change', function () { saveResult(r, 'sent_status', st.value, st); });
  row1.appendChild(st);
  box.appendChild(row1);
  box.appendChild(el('div', 'hintline', 'Отправлено: ' + (r.sentAt ? fmtDateTime(Date.parse(r.sentAt)) : 'ещё не отправлено') + '. Правки пишутся в registry/results.yaml атомарно, с копией .bak-<timestamp>.'));
  c.appendChild(box);
  return c;
}

function saveResult(r, field, value, ctl) {
  if (ctl && ctl.disabled !== undefined) ctl.disabled = true;
  fetch('/api/service/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'results', id: r.id, field: field, value: value })
  }).then(function (x) { return x.json(); }).then(function (res) {
    if (ctl && ctl.disabled !== undefined) ctl.disabled = false;
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
    toast(res.changed ? ('Сохранено: ' + field + (res.backup ? ' · копия ' + res.backup : '')) : 'Значение уже такое.');
    fetch('/api/state', { cache: 'no-store' }).then(function (x) { return x.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
  }).catch(function (e) {
    if (ctl && ctl.disabled !== undefined) ctl.disabled = false;
    toast('Ошибка: ' + e.message, 'bad');
  });
}
