/* Центр управления агентами — клиент. Vanilla JS, без сборки и внешних зависимостей. */
'use strict';

var STATE = null;
var VIEWS = {};
var activeTab = 'overview';
var NS = 'http://www.w3.org/2000/svg';

// Автономная копия (Дашборд.html) вшивает данные внутрь файла и открывается с диска
// по file:// — там нет ни сервера, ни сети, поэтому запись в реестр невозможна.
var STANDALONE = !!(typeof window !== 'undefined' && window.__DASHBOARD_STANDALONE__);

// Поверхность: «Оператор» (панель, стиль «Пульт») или «Клиент» (кабинет, стиль «Кабинет»).
// Можно задать ссылкой: ?surface=client или ?surface=operator.
var clientMode = (function () {
  try {
    if (window.location.search.indexOf('surface=client') >= 0) return true;
    if (window.location.search.indexOf('surface=operator') >= 0) return false;
  } catch (e) { /* ignore */ }
  return false;
})();

// --- КЛИЕНТСКИЙ КАБИНЕТ (T78): что клиенту НЕЛЬЗЯ показывать ни при каких условиях ---
// Показатели сервиса и внутренние данные оператора. Проверяется автотестом на утечку.
var CLIENT_FORBIDDEN_RE = /доход|марж|себестоимост|экономик[аи] сервиса|расходы панели|прибыл|наценк|оператор|дебет|очередь|токен|сесси|логи|внутренн/i;
var CLIENT_FORBIDDEN_ACTIONS = ['Запустить услугу', 'Продлить', 'Выставить счёт', 'Отправить отчёт', 'Сменить режим', 'Начислить', 'Выплатить'];
// Клиент видит только своё.
var CLIENT_TABS = ['cabinet'];

function clientNodeText(node) { return String((node && (node.innerText || node.textContent)) || ''); }

// Убирает из уже отрисованного вида всё операторское. Вызывается после каждой отрисовки.
function applyClientSurface(root) {
  if (!clientMode) return;
  var view = root || document.getElementById('view');
  if (!view) return;
  // 1) операторские блоки, помеченные якорем
  view.querySelectorAll('[data-anchor="actions"], [data-anchor="economy"], [data-anchor="internals"]').forEach(function (n) {
    if (n.parentNode) n.parentNode.removeChild(n);
  });
  // 2) операторские действия по подписи кнопки
  view.querySelectorAll('button').forEach(function (b) {
    var t = String(b.innerText || '').trim();
    if (CLIENT_FORBIDDEN_ACTIONS.indexOf(t) >= 0 && b.parentNode) b.parentNode.removeChild(b);
  });
  // 3) секции, в заголовке которых есть операторский показатель
  view.querySelectorAll('section, .section, .card').forEach(function (s) {
    var h = s.querySelector('h1, h2, h3, .section-title, .ag-group-title, .card-title');
    if (h && CLIENT_FORBIDDEN_RE.test(clientNodeText(h)) && !s.querySelector('.client-keep') && s.parentNode) {
      s.parentNode.removeChild(s);
    }
  });
  // 4) отдельные подписи с операторскими числами (плитки показателей)
  view.querySelectorAll('.kpi, .kpi-label, .hb-val, td, .small').forEach(function (n) {
    if (CLIENT_FORBIDDEN_RE.test(clientNodeText(n)) && n.parentNode && !n.querySelector('.client-keep')) {
      var box = n.closest('.kpi') || n;
      if (box.parentNode) box.parentNode.removeChild(box);
    }
  });
}

var TABS = [
  { id: 'overview', label: 'Обзор' },
  { id: 'agents', label: 'Агенты' },
  { id: 'tasks', label: 'Задачи' },
  { id: 'projects', label: 'Проекты' },
  { id: 'analytics', label: 'Аналитика' },
  { id: 'usage', label: 'Расходы' },
  { id: 'integrations', label: 'Интеграции API' },
  { id: 'sources', label: 'Источники мониторинга' },
  { id: 'settings', label: 'Настройки' },
  { id: 'infra', label: 'Инфраструктура' }
];

var STATUS = {
  new: { label: 'новая', cls: 'accent' },
  in_progress: { label: 'в работе', cls: 'warn' },
  done: { label: 'готово', cls: 'ok' },
  blocked: { label: 'заблокирована', cls: 'bad' },
  unassigned: { label: 'требует уточнения', cls: 'purple' }
};

var AGENT_STATUS = {
  active: { label: 'активен', cls: 'ok' },
  planned: { label: 'запланирован', cls: 'grey' },
  paused: { label: 'на паузе', cls: 'warn' },
  disabled: { label: 'выключен', cls: 'grey' },
  unknown: { label: 'неизвестно', cls: 'grey' }
};

/* ---------------- DOM helpers ---------------- */
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function add(parent, tag, cls, text) {
  var n = el(tag, cls, text);
  parent.appendChild(n);
  return n;
}
function ns(tag) { return document.createElementNS(NS, tag); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function q(id) { return document.getElementById(id); }

/* ---------------- formatters ---------------- */
function fmtInt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  var s = (Math.round(n * 100) / 100).toFixed(2);
  var parts = s.split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + parts[1] + ' ₽';
}
// Сумма в рублях. complete === false -> часть моделей без цены, сумма неполная.
function money(n, complete) {
  if (n === null || n === undefined || isNaN(n)) return 'цена неизвестна';
  return fmtMoney(n) + (complete === false ? '*' : '');
}
function fmtUsd(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + (Math.round(n * 10000) / 10000).toFixed(4);
}
// В русском интерфейсе дробная часть отделяется запятой.
function fmtTokens(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' млрд';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' тыс.';
  return String(Math.round(n));
}
function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return String(Math.round(n * 1000) / 1000).replace('.', ',');
}
function fmtPct(x) {
  if (x === null || x === undefined || isNaN(x)) return '—';
  return (x * 100).toFixed(1).replace('.', ',') + '%';
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmtDateTime(ms) {
  if (!ms) return '—';
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '—';
  return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtDay(iso) {
  if (!iso) return '—';
  var p = String(iso).split('-');
  if (p.length !== 3) return String(iso);
  return p[2] + '.' + p[1] + '.' + p[0].slice(2);
}
function fmtAgo(ms) {
  if (!ms) return '—';
  var diff = Date.now() - Number(ms);
  if (diff < 0) diff = 0;
  var min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return min + ' мин назад';
  var h = Math.floor(min / 60);
  if (h < 24) return h + ' ч назад';
  var d = Math.floor(h / 24);
  if (d < 30) return d + ' дн назад';
  return fmtDateTime(ms);
}

/* ---------------- small builders ---------------- */
function badge(text, cls) { return el('span', 'badge ' + (cls || 'grey'), text); }
function statusBadge(st) {
  var s = STATUS[st] || { label: st || '—', cls: 'grey' };
  var b = el('span', 'badge ' + s.cls);
  b.appendChild(el('span', 'dot'));
  b.appendChild(document.createTextNode(s.label));
  return b;
}
function agentStatusBadge(st) {
  var s = AGENT_STATUS[st] || { label: st || '—', cls: 'grey' };
  return badge(s.label, s.cls);
}
function kpi(label, value, foot, variant, valueSmall) {
  var c = el('div', 'card kpi ' + (variant || ''));
  c.appendChild(el('div', 'accent-bar'));
  c.appendChild(el('div', 'label', label));
  c.appendChild(el('div', 'value' + (valueSmall ? ' small' : ''), value));
  if (foot) c.appendChild(el('div', 'foot', foot));
  return c;
}
function card(title, sub) {
  var c = el('div', 'card');
  if (title) c.appendChild(el('h3', null, title));
  if (sub) c.appendChild(el('div', 'card-sub', sub));
  return c;
}
function section(title, hint) {
  var s = el('div', 'section');
  var head = add(s, 'div', 'section-head');
  add(head, 'h2', null, title);
  if (hint) add(head, 'div', 'hint', hint);
  return s;
}
function barRow(label, value, max, right, fillCls, title) {
  var row = el('div', 'bar-row');
  var lab = el('div', 'bar-label', label);
  if (title) lab.title = title;
  row.appendChild(lab);
  var track = el('div', 'bar-track');
  var fill = el('div', 'bar-fill ' + (fillCls || ''));
  var pct = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  fill.style.width = pct.toFixed(1) + '%';
  track.appendChild(fill);
  row.appendChild(track);
  var val = el('div', 'bar-value', right);
  row.appendChild(val);
  return row;
}
function note(kind, text) {
  var n = el('div', 'note ' + (kind || ''));
  n.appendChild(el('span', 'note-icon', kind === 'bad' ? '!' : (kind === 'warn' ? '!' : (kind === 'ok' ? '✓' : 'i'))));
  n.appendChild(el('span', null, text));
  return n;
}
function toast(message, kind) {
  var t = el('div', null, message);
  t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:200;' +
    'padding:11px 18px;border-radius:10px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.5);' +
    'background:' + (kind === 'bad' ? '#3a1a14' : '#14251a') + ';color:' + (kind === 'bad' ? '#f59b86' : '#86d894') + ';' +
    'border:1px solid ' + (kind === 'bad' ? 'rgba(240,96,63,.45)' : 'rgba(63,185,80,.45)') + ';max-width:min(760px,92vw);';
  document.body.appendChild(t);
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, kind === 'bad' ? 7000 : 4000);
}

/* ---------------- state ---------------- */
function loadState(forceCollect) {
  if (STANDALONE) {
    STATE = (typeof window !== 'undefined' && window.__DASHBOARD_DATA__) ? window.__DASHBOARD_DATA__ : null;
    return Promise.resolve(STATE);
  }
  var url = '/api/state' + (forceCollect ? '?collect=1' : '');
  return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (json) {
    STATE = json;
    return json;
  });
}

function renderHeader() {
  var meta = STATE && STATE.meta;
  var pill = q('genAt');
  var sub = q('brandSub');
  var banner = q('testmode');
  if (banner) {
    if (STANDALONE) banner.hidden = true;
    else { banner.hidden = false; banner.textContent = 'Тестовый режим на ПК • управление разрешено — правки пишутся в файлы с копией .bak-<timestamp>'; }
  }
  if (meta) {
    if (STANDALONE) {
      pill.textContent = 'автономная копия · данные на ' + fmtDateTime(meta.generatedAtMs);
      pill.title = 'Файл собран ' + fmtDateTime(meta.standalone && meta.standalone.builtAtMs ? meta.standalone.builtAtMs : meta.generatedAtMs) +
        '. Данные вшиты в файл, обновляются пересборкой: node marketing-agents/dashboard/build-standalone.mjs';
      if (sub) sub.textContent = 'автономная копия: открывается без сервера и без сети · данные на ' + fmtDateTime(meta.generatedAtMs);
    } else {
      pill.textContent = 'данные на ' + fmtDateTime(meta.generatedAtMs) + ' · сборка ' + meta.durationMs + ' мс';
      pill.title = 'generatedAt: ' + meta.generatedAt + '\nисточников: ' + meta.sources.length + '\nпредупреждений: ' + meta.warnings.length;
    }
  } else {
    pill.textContent = 'нет данных';
  }
}

// Горизонтальной ленты вкладок больше нет: навигацию рисует левая панель.
function renderTabs() {
  if (typeof renderSidebar === 'function') renderSidebar();
}

function renderTabsLegacy() {
  var nav = q('tabs');
  if (!nav) return;
  clear(nav);
  var counts = {
    agents: STATE && STATE.agents ? String(STATE.agents.agents.length) : '',
    tasks: STATE && STATE.tasks ? String(STATE.tasks.counts.total) : '',
    projects: STATE && STATE.projects ? String(STATE.projects.projects.length) : '',
    integrations: STATE && STATE.integrations ? String(STATE.integrations.summary.connected) : '',
    sources: STATE && STATE.sources ? String(STATE.sources.summary.enabled) : '',
    settings: ''
  };
  TABS.forEach(function (t) {
    var b = el('button', 'tab' + (t.id === activeTab ? ' active' : ''), t.label);
    b.setAttribute('role', 'tab');
    if (counts[t.id]) b.appendChild(el('span', 'count', counts[t.id]));
    b.addEventListener('click', function () {
      activeTab = t.id;
      if (window.location.hash !== '#' + t.id) window.location.hash = t.id;
      renderTabs(); renderActive();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    nav.appendChild(b);
  });
}

// Онбординг первого входа: три шага, состояние сохраняется. Показывается только клиенту.
function clientOnboarding() {
  var box = el('div', 'card client-keep');
  var key = 'dsh.onboarding';
  var saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(key) || '{}') || {}; } catch (e) { saved = {}; }
  box.appendChild(el('div', 'ag-group-title', 'С чего начать'));
  box.appendChild(el('div', 'small muted', 'Три шага, чтобы получить первый отчёт. Состояние сохраняется — можно вернуться позже.'));
  var steps = [
    { id: 'object', title: 'Заполнить свой объект', hint: 'Название ЖК и адрес — по ним агент ищет конкурентов и собирает цены.' },
    { id: 'competitors', title: 'Подтвердить конкурентов', hint: 'Мы подберём их автоматически в радиусе и покажем список — вам останется подтвердить или убрать лишних.' },
    { id: 'report', title: 'Получить первый отчёт', hint: 'Отчёт по конкурентам приходит раз в неделю: сравнение цен, лотов и акций. Придёт на вашу почту и появится здесь.' }
  ];
  var done = steps.filter(function (s) { return saved[s.id] === true; }).length;
  box.appendChild(el('div', 'small', 'Прогресс: ' + done + ' из ' + steps.length));
  var track = el('div', 'hb-track');
  var fill = el('div', 'hb-fill');
  fill.style.width = Math.round(done / steps.length * 100) + '%';
  track.appendChild(fill);
  box.appendChild(track);
  steps.forEach(function (s, i) {
    var row = el('div', 'ag-row');
    var lab = el('div', 'ag-label');
    lab.appendChild(el('div', 'ag-name', (saved[s.id] ? '✓ ' : (i + 1) + '. ') + s.title));
    lab.appendChild(el('div', 'ag-what', s.hint));
    row.appendChild(lab);
    var b = el('button', 'btn small' + (saved[s.id] ? '' : ' primary'), saved[s.id] ? 'Отметить невыполненным' : 'Отметить выполненным');
    b.addEventListener('click', function () {
      saved[s.id] = !saved[s.id];
      try { window.localStorage.setItem(key, JSON.stringify(saved)); } catch (e) { /* ignore */ }
      renderActive();
    });
    row.appendChild(b);
    box.appendChild(row);
  });
  box.appendChild(el('div', 'hintline', 'Когда все три шага отмечены, дальше всё идёт само: агент собирает данные по расписанию, отчёты приходят еженедельно.'));
  return box;
}

function renderActive() {
  var view = q('view');
  clear(view);
  // РЕЖИМ «КЛИЕНТ»: рисуем ТОЛЬКО кабинет. Операторские разделы в этом режиме не отрисовываются
  // вообще, поэтому утечка внутренних данных структурно невозможна, а не «спрятана» стилями.
  if (clientMode) {
    clientCabinet(view);
    applyClientSurface(view);
    return;
  }
  var fn = VIEWS[activeTab];
  if (!fn) { view.appendChild(el('div', 'loading', 'Раздел «' + activeTab + '» не загружен.')); return; }
  try { fn(view); }
  catch (e) {
    view.appendChild(note('bad', 'Ошибка отрисовки вкладки: ' + e.message));
    console.error(e);
  }
}

/* ПОДТВЕРЖДЕНИЯ БЕЗ НАТИВНЫХ ДИАЛОГОВ (баг T73).
   Нативный window.confirm БЛОКИРУЕТ JavaScript: браузер ждёт ответа, а автоматизация (CDP) виснет
   таймаутом. Поэтому переопределяем его на своё, ВНУТРИПАНЕЛЬНОЕ подтверждение в два шага:
   первый вызов показывает сообщение и НЕ выполняет действие, повторный клик по тому же действию
   в течение 20 секунд подтверждает. Диалог остаётся (требование чек-листа для действий с последствиями),
   но JS больше не блокируется и автоматизация не падает. */
var __dshAsk = null;
// ОДНО ДЕЙСТВИЕ — ОДНО СОСТОЯНИЕ: «подтвердите» → «выполняется» → «готово».
// Плашка подтверждения не должна оставаться на экране после старта и после результата:
// иначе пользователь одновременно видит «готово» и «подтвердите ещё раз» и не понимает, выполнено ли.
function clearConfirmNote() {
  var n = document.querySelector('#view .confirm-note');
  if (n && n.parentNode) n.parentNode.removeChild(n);
}
function showBusy(text) {
  clearConfirmNote();
  var v = document.getElementById('view');
  if (!v) return;
  var old = v.querySelector('.run-busy');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var d = document.createElement('div');
  d.className = 'run-busy';
  d.setAttribute('role', 'status');
  d.style.cssText = 'margin:0 0 10px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--panel);font-size:13px';
  d.textContent = text;
  v.insertBefore(d, v.firstChild);
}
function clearBusy() {
  var n = document.querySelector('#view .run-busy');
  if (n && n.parentNode) n.parentNode.removeChild(n);
}
window.confirm = function (message) {
  var text = String(message == null ? '' : message);
  var now = Date.now();
  if (__dshAsk && __dshAsk.text === text && now - __dshAsk.at < 20000) { __dshAsk = null; clearConfirmNote(); return true; }
  __dshAsk = { text: text, at: now };
  if (typeof toast === 'function') toast('Подтверждение: ' + text + ' — нажмите ещё раз, чтобы выполнить', 'warn');
  // ВАЖНО: реакция должна быть видна ВНУТРИ раздела, а не только во всплывашке.
  // Иначе первое нажатие выглядит как «кнопка без эффекта» и для пользователя, и для автотеста,
  // который наблюдает изменения именно внутри #view.
  try {
    var view = document.getElementById('view');
    if (view) {
      var old = view.querySelector('.confirm-note');
      if (old) old.parentNode.removeChild(old);
      var note = document.createElement('div');
      note.className = 'confirm-note';
      note.setAttribute('role', 'status');
      note.style.cssText = 'margin:0 0 10px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--panel);font-size:13px';
      note.textContent = 'Подтверждение: ' + text + ' — нажмите ту же кнопку ещё раз, чтобы выполнить.';
      view.insertBefore(note, view.firstChild);
    }
  } catch (e) { /* ignore */ }
  return false;
};
window.alert = function (message) {
  if (typeof toast === 'function') toast(String(message == null ? '' : message), 'ok');
};

function renderFooter() {
  var f = q('footer');
  clear(f);
  if (!STATE || !STATE.meta) { f.textContent = 'Данные не загружены.'; return; }
  var meta = STATE.meta;
  // ВЕРСИЯ ИНТЕРФЕЙСА: всегда видно, какая версия открыта. Если у вас старая — обновите страницу.
  var uv = STATE.uiVersion;
  if (uv) {
    var vl = el('div', 'small muted');
    // fmtDateTime принимает МИЛЛИСЕКУНДЫ, поэтому ISO-строку сначала разбираем через Date.parse
    // (иначе в подвале было «собрана —», и по строке нельзя было понять свежесть версии).
    var builtMs = uv.builtAt ? Date.parse(uv.builtAt) : NaN;
    var builtText = isNaN(builtMs) ? 'время сборки неизвестно' : ('собрана ' + fmtDateTime(builtMs));
    vl.appendChild(document.createTextNode('Версия интерфейса: ' + uv.version + ' · ' + builtText + ' · файлов интерфейса: ' + uv.files + '. '));
    var rb = el('button', 'btn small', 'Обновить страницу');
    rb.title = 'Если вы видите старую версию — нажмите, страница перезагрузится без кэша';
    rb.addEventListener('click', function () { window.location.reload(true); });
    vl.appendChild(rb);
    f.appendChild(vl);
  }
  if (STANDALONE) {
    f.appendChild(el('div', null, 'Автономная копия: данные вшиты в этот файл на момент сборки ' + fmtDateTime(meta.standalone && meta.standalone.builtAtMs ? meta.standalone.builtAtMs : meta.generatedAtMs) + '. Сеть не используется.'));
    f.appendChild(el('div', null, 'Обновить данные: node marketing-agents/dashboard/collector/collect.mjs, затем node marketing-agents/dashboard/build-standalone.mjs'));
    f.appendChild(el('div', null, 'Рабочая папка: ' + meta.workspaceRoot));
    return;
  }
  var line1 = 'Источники: ' + meta.sources.map(function (s) { return s.label + (s.exists ? '' : ' (нет)'); }).join(' · ');
  f.appendChild(el('div', null, line1));
  f.appendChild(el('div', null, 'Рабочая папка: ' + meta.workspaceRoot + ' · данные: ' + meta.dataDir));
  f.appendChild(el('div', null, 'Локальная публикация: сервер слушает только 127.0.0.1, наружу ничего не отдаётся.'));
}


/* ---------------- тревоги и действия ---------------- */
function goTab(tab, anchor) {
  activeTab = tab;
  if (window.location.hash !== '#' + tab) window.location.hash = tab;
  renderTabs();
  renderActive();
  if (anchor) {
    setTimeout(function () {
      var host = document.querySelector('[data-anchor="' + anchor + '"]');
      if (host) host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }
}

var ALERT_LABEL = { critical: ['критично', 'bad'], warning: ['внимание', 'warn'], info: ['заметка', 'grey'] };

function alertCard(al) {
  var lv = ALERT_LABEL[al.level] || ['заметка', 'grey'];
  var c = el('div', 'card alert ' + al.level);
  var head = el('div', 'agent-head');
  var left = el('div');
  left.appendChild(el('h3', 'agent-name', al.title));
  head.appendChild(left);
  head.appendChild(badge(lv[0], lv[1]));
  c.appendChild(head);
  c.appendChild(el('div', 'small muted', 'Что случилось: ' + (al.what || '—')));
  c.appendChild(el('div', 'small muted', 'Что это значит: ' + (al.meaning || '—')));
  if (al.items && al.items.length) {
    var ul = el('ul', 'clean');
    al.items.slice(0, 5).forEach(function (t) {
      ul.appendChild(el('li', null, t.id + ' — ' + t.subject + (t.due ? ' (срок ' + t.due + ')' : '') + ', ' + (t.owner || 'без исполнителя')));
    });
    c.appendChild(ul);
  }
  var row = el('div', 'filters');
  var b = el('button', 'btn small primary', al.action.label);
  b.title = 'Перейти в раздел';
  b.addEventListener('click', function () { goTab(al.action.tab, al.action.anchor); });
  row.appendChild(b);
  c.appendChild(row);
  return c;
}

function runAction(a, btn, outHost) {
  if (STANDALONE) { toast('Это автономная копия — действия доступны в живой панели.', 'bad'); return; }
  if (!window.confirm(a.label + '?\n\n' + a.hint)) return;
  // Подтверждено: плашку убираем, показываем состояние «выполняется».
  clearConfirmNote();
  showBusy('Выполняется: ' + a.label + '… Это может занять до минуты.');
  clear(outHost);
  outHost.appendChild(note(null, 'Выполняю: ' + a.label + '… Это может занять до минуты.'));
  btn.disabled = true;
  var started = Date.now();
  fetch('/api/actions/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: a.id, agent: a.agent || null })
  }).then(function (r) { return r.json(); }).then(function (res) {
    btn.disabled = false;
    clearBusy();            // работа закончилась — состояние «выполняется» снимаем
    clearConfirmNote();     // и подтверждение тоже: результат уже на экране
    clear(outHost);
    var secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!res.ok) {
      outHost.appendChild(note('bad', 'Не получилось: ' + (res.message || 'ошибка') + ' — за ' + secs + ' с.'));
      if (res.output) outHost.appendChild(el('pre', null, res.output));
      return;
    }
    outHost.appendChild(note('ok', res.message + ' — за ' + secs + ' с.'));
    var details = [];
    if (res.result) {
      if (res.result.sessions !== undefined) details.push('сессий: ' + res.result.sessions);
      if (res.result.tasks !== undefined) details.push('задач: ' + res.result.tasks);
      if (res.result.rub !== undefined && res.result.rub !== null) details.push('расход: ' + money(res.result.rub, true));
      if (res.result.curr) details.push('снимок: ' + res.result.curr + (res.result.prev ? ', сравнение с ' + res.result.prev : ''));
    }
    if (details.length) outHost.appendChild(el('div', 'small muted', details.join(' · ')));
    if (res.result && res.result.report) outHost.appendChild(el('div', 'small muted', 'Файл: ' + res.result.report.path + ' (' + res.result.report.bytes + ' байт)'));
    if (res.output) {
      var det = el('details');
      var sm = el('summary');
      sm.appendChild(el('span', null, 'Что напечатала команда'));
      det.appendChild(sm);
      det.appendChild(el('pre', null, res.output));
      outHost.appendChild(det);
    }
    // тихо обновляем данные, не убирая результат с экрана
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; }).catch(function () {});
  }).catch(function (e) {
    btn.disabled = false;
    clearBusy();
    clearConfirmNote();
    clear(outHost);
    outHost.appendChild(note('bad', 'Ошибка запроса: ' + e.message));
  });
}

/* ---------------- Обзор ---------------- */
function sumLastDays(byDay, n) {
  var days = (byDay || []).slice(-n);
  var acc = { tokens: 0, rub: 0, usd: 0, sessions: 0, rubComplete: true };
  days.forEach(function (d) {
    acc.tokens += d.tokens.totalTokens || 0;
    acc.sessions += d.sessions || 0;
    if (d.rub === null || d.rub === undefined) acc.rubComplete = false; else acc.rub += d.rub;
    acc.usd += d.usd || 0;
  });
  return acc;
}

function buildDayChart(days, mode) {
  var svg = ns('svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', '0 0 1000 230');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  var defs = ns('defs');
  var grad = ns('linearGradient');
  grad.setAttribute('id', 'barGrad');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  var s1 = ns('stop'); s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#7553ff');
  var s2 = ns('stop'); s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#553db8');
  grad.appendChild(s1); grad.appendChild(s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  var W = 1000, H = 230, padL = 54, padR = 16, padT = 18, padB = 44;
  var plotW = W - padL - padR, plotH = H - padT - padB;
  var vals = days.map(function (d) { return mode === 'rub' ? (d.rub || 0) : (d.tokens.totalTokens || 0); });
  var max = Math.max.apply(null, vals.concat([1]));
  var n = Math.max(1, days.length);
  var step = plotW / n;
  var barW = Math.max(4, Math.min(46, step * 0.62));

  for (var g = 0; g <= 4; g++) {
    var y = padT + plotH - (plotH * g / 4);
    var line = ns('line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'axis');
    line.setAttribute('stroke-dasharray', g === 0 ? '' : '3 4');
    svg.appendChild(line);
    var t = ns('text');
    t.setAttribute('x', padL - 8); t.setAttribute('y', y + 3.5);
    t.setAttribute('text-anchor', 'end');
    var tickVal = max * g / 4;
    t.textContent = mode === 'rub' ? fmtInt(tickVal) : fmtTokens(tickVal);
    svg.appendChild(t);
  }

  days.forEach(function (d, i) {
    var v = mode === 'rub' ? (d.rub || 0) : (d.tokens.totalTokens || 0);
    var h = max > 0 ? (v / max) * plotH : 0;
    var x = padL + step * i + (step - barW) / 2;
    var rect = ns('rect');
    rect.setAttribute('class', 'bar');
    rect.setAttribute('x', x); rect.setAttribute('y', padT + plotH - h);
    rect.setAttribute('width', barW); rect.setAttribute('height', Math.max(1, h));
    rect.setAttribute('rx', '3');
    var tip = ns('title');
    tip.textContent = fmtDay(d.date) + ': ' + fmtTokens(d.tokens.totalTokens) + ' токенов, ' + money(d.rub, d.rubComplete) + ', сессий: ' + d.sessions;
    rect.appendChild(tip);
    svg.appendChild(rect);

    if (days.length <= 16) {
      var vt = ns('text');
      vt.setAttribute('class', 'value-label');
      vt.setAttribute('x', x + barW / 2);
      vt.setAttribute('y', padT + plotH - h - 5);
      vt.setAttribute('text-anchor', 'middle');
      vt.textContent = mode === 'rub' ? fmtInt(v) : fmtTokens(v);
      svg.appendChild(vt);
    }

    if (days.length <= 34) {
      var lt = ns('text');
      lt.setAttribute('x', x + barW / 2);
      lt.setAttribute('y', H - padB + 16);
      lt.setAttribute('text-anchor', 'middle');
      lt.textContent = fmtDay(d.date);
      svg.appendChild(lt);
    }
  });
  return svg;
}

VIEWS.overview = function (view) {
  var meta = STATE.meta, usage = STATE.usage, agents = STATE.agents, tasks = STATE.tasks;
  if (!meta || !usage) { view.appendChild(note('bad', 'Данные не собраны. Нажмите «Обновить данные» или запустите collector.')); return; }

  // --- ТРЕВОГИ: что требует внимания прямо сейчас ---
  var alertsDoc = STATE.alerts;
  if (alertsDoc && alertsDoc.alerts.length > 0) {
    var aSec = section('Требует внимания',
      alertsDoc.counts.critical + ' критичных · ' + alertsDoc.counts.warning + ' предупреждений · ' + alertsDoc.counts.info + ' заметок');
    var aStack = el('div', 'stack');
    alertsDoc.alerts.forEach(function (al) { aStack.appendChild(alertCard(al)); });
    aSec.appendChild(aStack);
    view.appendChild(aSec);
  } else if (alertsDoc) {
    var okSec = section('Требует внимания', 'проверено автоматически');
    var okCard = card();
    okCard.appendChild(note('ok', 'Тревог нет: источники в порядке, данные свежие (последний снимок ' + (alertsDoc.lastSnapshot || '—') + '), просроченных задач нет, расход в норме.'));
    okSec.appendChild(okCard);
    view.appendChild(okSec);
  }

  // --- ДЕЙСТВИЯ ---
  var actSec = section('Действия', 'панель выполняет команду и показывает, что получилось');
  actSec.setAttribute('data-anchor', 'actions');
  var actCard = card();
  actCard.appendChild(note(null, 'Каждое действие спрашивает подтверждение и выполняется на сервере. Файлы реестра при этом не меняются — правки параметров живут во вкладке «Настройки» с копиями .bak-.'));
  var actRow = el('div', 'group-actions');
  var actOut = el('div');
  [
    { id: 'collect', label: 'Собрать данные сейчас', hint: 'Перечитать логи сессий DSH и реестр, обновить все цифры панели. Ничего не удаляется и не портится.', agent: null },
    { id: 'report', label: 'Сформировать отчёт за неделю', hint: 'Запустить движок Агента 1: сравнить два последних снимка и собрать отчёт (Markdown + Excel, 9 разделов).', agent: null },
    { id: 'agent', label: 'Запустить агента', hint: 'Полный недельный цикл Агента 1: проверка снимка, сравнение прошлой и текущей недели, сборка отчёта. Сбор с площадок пропускается — он требует входа в Chrome.', agent: 'agent-1-competitor-watch' }
  ].forEach(function (a) {
    var b = el('button', 'btn', a.label);
    b.title = a.hint;
    b.addEventListener('click', function () { runAction(a, b, actOut); });
    actRow.appendChild(b);
  });
  actCard.appendChild(actRow);
  actCard.appendChild(actOut);
  actSec.appendChild(actCard);
  view.appendChild(actSec);

  var week = sumLastDays(usage.byDay, 7);
  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Агентов включено', agents.summary.enabled + ' / ' + agents.summary.total,
    'активны: ' + agents.summary.active + ' · запланированы: ' + agents.summary.planned + ' · исполнителей DSH: ' + agents.summary.membersTotal, 'ok'));
  kpis.appendChild(kpi('Задач в работе', String(tasks.counts.inProgress),
    'готово: ' + tasks.counts.done + ' · всего: ' + tasks.counts.total + (tasks.counts.unassigned ? ' · уточнить: ' + tasks.counts.unassigned : ''), 'warn'));
  kpis.appendChild(kpi('Токенов за 7 дней', fmtTokens(week.tokens),
    'всего за всё время: ' + fmtTokens(usage.totals.tokens.totalTokens), 'purple'));
  kpis.appendChild(kpi('Расход за всё время', fmtMoney(usage.totals.rub),
    fmtUsd(usage.totals.usd) + (usage.currency.usdRub ? ' по курсу ' + usage.currency.usdRub + ' ₽/$' : ' · курс не задан'),
    usage.totals.rubComplete ? 'accent' : 'bad', true));
  kpis.appendChild(kpi('Сессий в логах', String(meta.totals.sessions),
    fmtInt(meta.totals.events) + ' событий · ' + fmtTokens(meta.totals.tokens.cacheReadTokens) + ' из кэша', ''));
  view.appendChild(kpis);

  // график
  var chartSection = section('Расход по дням', 'последние ' + usage.byDay.length + ' дн. · наведите на столбец для деталей');
  var chartCard = card();
  var modeRow = el('div', 'chip-row');
  modeRow.style.marginBottom = '10px';
  var modes = [{ id: 'tokens', label: 'токены' }, { id: 'rub', label: 'рубли' }];
  var chartMode = 'tokens';
  var chartHost = el('div');
  function drawChart() {
    clear(chartHost);
    if (usage.byDay.length === 0) { chartHost.appendChild(el('div', 'muted', 'Нет данных по дням.')); return; }
    chartHost.appendChild(buildDayChart(usage.byDay.slice(-30), chartMode));
  }
  modes.forEach(function (m) {
    var b = el('button', 'btn small' + (m.id === chartMode ? ' primary' : ''), m.label);
    b.addEventListener('click', function () {
      chartMode = m.id;
      Array.prototype.forEach.call(modeRow.children, function (c) { c.className = 'btn small'; });
      b.className = 'btn small primary';
      drawChart();
    });
    modeRow.appendChild(b);
  });
  chartCard.appendChild(modeRow);
  chartCard.appendChild(chartHost);
  if (!usage.totals.rubComplete) chartCard.appendChild(note('warn', 'Часть моделей без цены — суммы в рублях неполные и помечены звёздочкой (*). Подробности на вкладке «Расходы».'));
  chartSection.appendChild(chartCard);
  drawChart();
  view.appendChild(chartSection);

  var two = el('div', 'grid two');

  // топ моделей
  var mc = card('Топ моделей', 'по токенам за всё время');
  var bars = el('div', 'bars');
  var models = usage.byModel.slice(0, 7);
  var maxTok = models.length ? models[0].tokens.totalTokens : 1;
  models.forEach(function (m) {
    bars.appendChild(barRow(m.model, m.tokens.totalTokens, maxTok,
      fmtTokens(m.tokens.totalTokens) + ' · ' + (m.priceKnown ? fmtMoney(m.rub) : 'цена неизвестна'),
      m.priceKnown ? '' : 'warn', (m.provider || '') + ' · ' + fmtInt(m.tokens.totalTokens) + ' токенов'));
  });
  if (models.length === 0) bars.appendChild(el('div', 'muted', 'Нет данных.'));
  mc.appendChild(bars);
  two.appendChild(mc);

  // агенты по расходу
  var ac = card('Кто потратил больше', 'сессии сгруппированы по исполнителю');
  var abars = el('div', 'bars');
  var agentList = usage.byAgent.slice(0, 7);
  var maxA = agentList.length ? agentList[0].tokens.totalTokens : 1;
  agentList.forEach(function (a) {
    abars.appendChild(barRow(a.name, a.tokens.totalTokens, maxA,
      fmtTokens(a.tokens.totalTokens) + ' · ' + money(a.rub, a.rubComplete),
      'ok', a.sessions + ' сессий'));
  });
  ac.appendChild(abars);
  two.appendChild(ac);
  view.appendChild(two);

  // источники + предупреждения
  var srcSection = section('Источники данных и качество');
  var srcCard = card();
  var tbl = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  ['Источник', 'Путь', 'Записей', 'Состояние'].forEach(function (h) { add(tr, 'th', null, h); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  meta.sources.forEach(function (s) {
    var row = el('tr');
    add(row, 'td', null, s.label);
    add(row, 'td', 'mono', s.path);
    add(row, 'td', 'num', fmtInt(s.items));
    var td = el('td');
    td.appendChild(badge(s.exists ? 'ок' : 'нет файла', s.exists ? 'ok' : 'bad'));
    if (s.note) td.appendChild(el('span', 'small muted', '  ' + s.note));
    row.appendChild(td);
    tb.appendChild(row);
  });
  t.appendChild(tb); tbl.appendChild(t); srcCard.appendChild(tbl);

  if (meta.warnings.length > 0) {
    srcCard.appendChild(el('h4', null, 'Предупреждения сборщика (' + meta.warnings.length + ')'));
    var stack = el('div', 'stack');
    meta.warnings.slice(0, 10).forEach(function (w) { stack.appendChild(note('warn', w.message)); });
    if (meta.warnings.length > 10) stack.appendChild(el('div', 'small muted', '…и ещё ' + (meta.warnings.length - 10)));
    srcCard.appendChild(stack);
  } else {
    srcCard.appendChild(note('ok', 'Сборщик отработал без предупреждений.'));
  }
  srcSection.appendChild(srcCard);
  view.appendChild(srcSection);
};

/* ---------------- Агенты ---------------- */
function openDrawer(title, build) {
  var drawer = q('drawer');
  var backdrop = q('drawerBackdrop');
  clear(drawer);
  var close = el('button', 'btn small drawer-close', 'Закрыть');
  close.addEventListener('click', closeDrawer);
  drawer.appendChild(close);
  drawer.appendChild(el('h2', null, title));
  build(drawer);
  drawer.hidden = false;
  backdrop.hidden = false;
}
function closeDrawer() {
  q('drawer').hidden = true;
  q('drawerBackdrop').hidden = true;
}
function kv(parent, pairs) {
  var g = el('div', 'kv');
  pairs.forEach(function (p) {
    if (p[1] === null || p[1] === undefined || p[1] === '') return;
    g.appendChild(el('div', 'k', p[0]));
    var v = el('div', 'v');
    if (p[1] instanceof Node) v.appendChild(p[1]); else v.textContent = String(p[1]);
    g.appendChild(v);
  });
  parent.appendChild(g);
  return g;
}

// В автономной копии запись в реестр невозможна (file://), поэтому показываем
// готовый YAML-фрагмент и подсказку — пользователь вставит его сам.
function showToggleFragment(id, next, agentName) {
  openDrawer('Включение агента: ' + (agentName || id), function (d) {
    d.appendChild(note('warn', 'Это автономная копия — она открыта с диска (file://) и не может менять registry/agents.yaml. Ниже готовый фрагмент: вставьте его в реестр вручную или пользуйтесь версией с сервером («Открыть дашборд.cmd»).'));
    d.appendChild(el('h4', null, 'Что вставить в registry/agents.yaml'));
    d.appendChild(el('pre', null, '  - id: ' + id + '\n    enabled: ' + (next ? 'true' : 'false')));
    d.appendChild(el('h4', null, 'Куда вставлять'));
    d.appendChild(el('div', 'small muted', 'В блок этого агента в marketing-agents/registry/agents.yaml — строка enabled: должна быть ровно одна. Комментарии и остальные строки не трогайте.'));
    d.appendChild(el('h4', null, 'Как включить тумблером'));
    d.appendChild(el('div', 'small muted', 'Двойной щелчок по «Открыть дашборд.cmd» в папке marketing-agents/dashboard — откроется версия с сервером, где тумблер пишет в файл сам (с бэкапом).'));
    var row = el('div', 'filters');
    var copy = el('button', 'btn small primary', 'Скопировать фрагмент');
    copy.addEventListener('click', function () {
      var text = '  - id: ' + id + '\n    enabled: ' + (next ? 'true' : 'false');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Фрагмент скопирован.'); }, function () { toast('Не удалось скопировать — выделите вручную.', 'bad'); });
      } else {
        toast('Скопируйте фрагмент вручную.');
      }
    });
    row.appendChild(copy);
    d.appendChild(row);
    d.appendChild(el('h4', null, 'После правки'));
    d.appendChild(el('div', 'small muted', 'Пересоберите автономную копию: node marketing-agents/dashboard/build-standalone.mjs — тогда в файле будет новое состояние.'));
  });
}

// Групповое управление: один запрос — одна атомарная правка файла и один бэкап.
function runBulk(target, ids, enabled, btn, onDone) {
  if (STANDALONE) {
    toast('Это автономная копия: тумблеры не пишут в реестр. Управление доступно в живой панели (Открыть дашборд.cmd).', 'bad');
    return;
  }
  if (btn) btn.disabled = true;
  fetch('/api/bulk/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: target, ids: (ids && ids.length) ? ids : 'all', enabled: enabled })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (btn) btn.disabled = false;
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
    var n = res.changedIds ? res.changedIds.length : 0;
    toast(n === 0 ? 'Ничего не изменилось — уже в нужном состоянии.' : ('Изменено: ' + n + ' · ' + (enabled ? 'включено' : 'выключено') + (res.backup ? ' · бэкап ' + res.backup : '')));
    if (onDone) onDone(res); else loadState().then(boot);
  }).catch(function (e) {
    if (btn) btn.disabled = false;
    toast('Ошибка запроса: ' + e.message, 'bad');
  });
}

function bulkBtn(label, target, ids, enabled, cls, onDone) {
  var b = el('button', 'btn ' + (cls || 'small'), label);
  b.addEventListener('click', function () { runBulk(target, ids, enabled, b, onDone); });
  return b;
}

function lastChangeFor(kind, id) {
  var h = STATE && STATE.meta && STATE.meta.history ? STATE.meta.history[kind] : null;
  return h ? h[id] : null;
}

function toggleAgent(id, next, btn, onDone) {
  if (STANDALONE) {
    showToggleFragment(id, next, btn && btn.getAttribute ? btn.getAttribute('data-agent-name') : null);
    return;
  }
  btn.classList.add('busy');
  fetch('/api/agents/' + encodeURIComponent(id) + '/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: next })
  }).then(function (r) { return r.json(); }).then(function (res) {
    btn.classList.remove('busy');
    if (!res.ok) { toast('Не удалось переключить: ' + res.message, 'bad'); return; }
    toast('Агент «' + id + '» теперь ' + (res.enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН') + '. Реестр обновлён' + (res.backup ? ', бэкап: ' + res.backup : '') + '.');
    if (onDone) onDone(res);
  }).catch(function (e) {
    btn.classList.remove('busy');
    toast('Ошибка запроса: ' + e.message, 'bad');
  });
}

function agentTasks(agent) {
  var t = STATE.tasks.tasks || [];
  return t.filter(function (x) { return x.owner === agent.id; });
}

VIEWS.agents = function (view) {
  var agentsDoc = STATE.agents;
  if (!agentsDoc) { view.appendChild(note('bad', 'Нет данных по агентам.')); return; }

  var s = agentsDoc.summary;
  var kpis = el('div', 'grid kpi');
  kpis.appendChild(kpi('Агентов в реестре', String(s.total), 'включено: ' + s.enabled + ' · выключено: ' + s.disabled, 'accent'));
  kpis.appendChild(kpi('Активных', String(s.active), 'запланировано: ' + s.planned, 'ok'));
  kpis.appendChild(kpi('Исполнителей DSH', String(s.membersTotal), 'в работе: ' + s.membersActive + ' · из логов сессий', 'purple'));
  kpis.appendChild(kpi('Задач на агентах', String((STATE.tasks.tasks || []).filter(function (t) { return t.owner; }).length),
    'с исполнителем из реестра', 'warn'));
  view.appendChild(kpis);

  // --- УПРАВЛЕНИЕ: счётчик, групповые действия, что произойдёт ---
  var ctlSection = section('Управление агентами', 'каждое переключение — атомарная правка registry/agents.yaml с копией .bak-<timestamp>');
  var ctl = card();
  var onOff = agentsDoc.agents.filter(function (a) { return a.enabled; }).length;
  ctl.appendChild(note(onOff > 0 ? 'ok' : null,
    'Включено ' + onOff + ' из ' + agentsDoc.agents.length + '. Включённый агент получает задачи и запускается по расписанию; выключенный — нет. Задачи на нём остаются, но новые не берутся.'));
  var actions = el('div', 'group-actions');
  actions.appendChild(bulkBtn('Включить всех', 'agents', null, true, 'small'));
  actions.appendChild(bulkBtn('Выключить всех', 'agents', null, false, 'small'));
  var onlyActive = el('button', 'btn small', 'Только активные');
  onlyActive.title = 'Включить агентов со статусом «активен», остальных выключить';
  onlyActive.addEventListener('click', function () {
    var on = agentsDoc.agents.filter(function (a) { return a.status === 'active'; }).map(function (a) { return a.id; });
    var off = agentsDoc.agents.filter(function (a) { return a.status !== 'active'; }).map(function (a) { return a.id; });
    runBulk('agents', on, true, onlyActive, function () {
      runBulk('agents', off, false, null, function () { loadState().then(boot); });
    });
  });
  actions.appendChild(onlyActive);
  ctl.appendChild(actions);

  var groupIds = {};
  agentsDoc.agents.forEach(function (a) {
    (a.groups || []).forEach(function (g) { (groupIds[g] = groupIds[g] || []).push(a.id); });
  });
  var groupKeys = Object.keys(groupIds).sort();
  if (groupKeys.length > 0) {
    ctl.appendChild(el('div', 'small muted', 'По группам задач (группа из реестра):'));
    var grows = el('div', 'group-actions');
    groupKeys.forEach(function (g) {
      var chip = el('span');
      chip.appendChild(el('span', 'small muted', g + ': '));
      chip.appendChild(bulkBtn('вкл', 'agents', groupIds[g], true, 'small'));
      chip.appendChild(document.createTextNode(' '));
      chip.appendChild(bulkBtn('выкл', 'agents', groupIds[g], false, 'small'));
      grows.appendChild(chip);
    });
    ctl.appendChild(grows);
  }
  var hb = STATE.meta && STATE.meta.history ? STATE.meta.history.backups : null;
  if (hb) {
    ctl.appendChild(el('div', 'hintline', 'История переключений: копий agents.yaml — ' + hb.agents.count +
      ', sources.yaml — ' + hb.sources.count + '. Последняя правка: ' + (hb.agents.newestAt ? fmtAgo(hb.agents.newestAt) : 'не было') + '.'));
  }
  ctlSection.appendChild(ctl);
  view.appendChild(ctlSection);

  var listSection = section('Агенты реестра', 'тумблер пишет enabled прямо в registry/agents.yaml (атомарно, с бэкапом)');
  var grid = el('div', 'grid cards');
  agentsDoc.agents.forEach(function (a) {
    var c = el('div', 'card agent-card');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', a.name));
    left.appendChild(el('div', 'agent-role', a.role || '—'));
    head.appendChild(left);

    var right = el('div');
    right.style.textAlign = 'right';
    var sw = el('button', 'switch' + (a.enabled ? ' on' : ''));
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', a.enabled ? 'true' : 'false');
    sw.title = a.enabled
      ? 'Выключить: агент перестанет получать новые задачи и запускаться по расписанию'
      : 'Включить: агент начнёт получать задачи и запускаться по расписанию';
    sw.setAttribute('data-agent-id', a.id);
    sw.setAttribute('data-agent-name', a.name);
    sw.appendChild(el('span', 'knob'));
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAgent(a.id, !a.enabled, sw, function () { loadState().then(boot); });
    });
    right.appendChild(sw);
    right.appendChild(el('div', 'small muted', a.enabled ? 'включён' : 'выключен'));
    head.appendChild(right);
    c.appendChild(head);

    var meta = el('div', 'agent-meta');
    meta.appendChild(agentStatusBadge(a.status));
    meta.appendChild(badge(a.model || 'модель не задана', 'accent'));
    if (a.schedule) meta.appendChild(badge(a.schedule, 'grey'));
    (a.groups || []).forEach(function (g) { meta.appendChild(badge(g, 'purple')); });
    c.appendChild(meta);

    var stats = el('div', 'agent-stats');
    function stat(k, v, title) {
      var d = el('div', 'stat');
      d.appendChild(el('div', 'k', k));
      var val = el('div', 'v', v);
      if (title) val.title = title;
      d.appendChild(val);
      return d;
    }
    var m = a.metrics;
    stats.appendChild(stat('задач', String(m.tasks.total), 'всего задач на агенте'));
    stats.appendChild(stat('токенов', fmtTokens(m.tokens.totalTokens), fmtInt(m.tokens.totalTokens)));
    stats.appendChild(stat('расход', m.tokens.totalTokens === 0 ? '—' : money(m.rub, m.rubComplete), m.tokens.totalTokens === 0 ? 'агент ещё не запускался' : ''));
    c.appendChild(stats);

    var foot = el('div', 'small muted');
    var parts = [];
    parts.push('проекты: ' + ((a.projects && a.projects.length) ? a.projects.join(', ') : 'все'));
    parts.push('сессий: ' + m.sessions);
    parts.push('активность: ' + (m.lastActivityAt ? fmtAgo(m.lastActivityAt) : 'не запускался'));
    if (a.linkedMembers && a.linkedMembers.length) parts.push('исполнители: ' + a.linkedMembers.join(', '));
    foot.textContent = parts.join(' · ');
    c.appendChild(foot);

    var ch = lastChangeFor('agents', a.id);
    if (ch) {
      c.appendChild(el('div', 'changed', 'Последнее изменение тумблера: ' + fmtDateTime(ch.at) + ' (' + fmtAgo(ch.at) + '), было ' + (ch.previous ? 'включён' : 'выключен') + ' → стало ' + (ch.now ? 'включён' : 'выключен') + '. Копия: ' + ch.backup));
    } else {
      c.appendChild(el('div', 'hintline', 'Через дашборд этот агент ещё не переключали.'));
    }

    var more = el('button', 'btn small', 'Подробнее и задачи');
    more.addEventListener('click', function () { showAgent(a); });
    c.appendChild(more);

    c.classList.add('clickable');
    c.addEventListener('click', function () { showAgent(a); });
    grid.appendChild(c);
  });
  listSection.appendChild(grid);
  view.appendChild(listSection);

  // исполнители
  var memSection = section('Исполнители в DSH', 'кто реально работал в сессиях: расход считается по логам');
  var memCard = card();
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  [['Исполнитель'], ['Тип'], ['Что делает'], ['Сессий', 'num'], ['Токенов', 'num'], ['Расход', 'num'], ['Активность']].forEach(function (h) { add(tr, 'th', h[1] || null, h[0]); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  agentsDoc.members.forEach(function (m) {
    var row = el('tr');
    add(row, 'td', null, m.name || m.id);
    var kind = m.kind === 'system' ? 'сборка системы' : (m.kind === 'product' ? 'агент реестра' : 'разовый');
    var td0 = el('td'); td0.appendChild(badge(kind, m.kind === 'product' ? 'ok' : (m.kind === 'system' ? 'accent' : 'grey'))); row.appendChild(td0);
    add(row, 'td', 'small muted', (m.description || '').slice(0, 70));
    add(row, 'td', 'num', String(m.sessions));
    add(row, 'td', 'num', fmtTokens(m.tokens.totalTokens)).title = fmtInt(m.tokens.totalTokens) + ' токенов';
    add(row, 'td', 'num', money(m.rub, m.rubComplete));
    add(row, 'td', null, m.lastActivityAt ? fmtAgo(m.lastActivityAt) : '—');
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); memCard.appendChild(wrap);
  memCard.appendChild(el('div', 'small muted', 'Связь «агент реестра ↔ исполнитель DSH» настраивается в dashboard/config/links.yaml.'));
  memSection.appendChild(memCard);
  view.appendChild(memSection);
};

function showAgent(a) {
  openDrawer(a.name, function (d) {
    var head = el('div', 'agent-meta');
    head.appendChild(agentStatusBadge(a.status));
    head.appendChild(badge(a.enabled ? 'включён' : 'выключен', a.enabled ? 'ok' : 'grey'));
    head.appendChild(badge(a.model || '—', 'accent'));
    d.appendChild(head);

    kv(d, [
      ['id', el('code', null, a.id)],
      ['роль', a.role],
      ['модель', a.model],
      ['почему такая модель', a.modelHint],
      ['расписание', a.schedule],
      ['группы задач', (a.groups || []).join(' → ') || '—'],
      ['проекты', (a.projects && a.projects.length) ? a.projects.join(', ') : 'все проекты из projects.yaml'],
      ['входы', (a.inputs || []).join(', ')],
      ['выходы', (a.outputs || []).join(', ')],
      ['runbook', a.runbook],
      ['заметки', a.notes],
      ['исполнители DSH', (a.linkedMembers || []).join(', ') || 'не привязаны (см. links.yaml)']
    ]);

    var m = a.metrics;
    d.appendChild(el('h4', null, 'Расход и активность'));
    kv(d, [
      ['сессий', String(m.sessions)],
      ['токенов', fmtInt(m.tokens.totalTokens)],
      ['из них кэш', fmtInt(m.tokens.cacheReadTokens)],
      ['вход / выход', fmtInt(m.tokens.inputTokens) + ' / ' + fmtInt(m.tokens.outputTokens)],
      ['расход', m.tokens.totalTokens === 0 ? 'агент ещё не запускался' : (money(m.rub, m.rubComplete) + ' (' + fmtUsd(m.usd) + ')')],
      ['последняя активность', m.lastActivityAt ? fmtDateTime(m.lastActivityAt) : '—']
    ]);

    var mine = agentTasks(a);
    d.appendChild(el('h4', null, 'Задачи агента (' + mine.length + ')'));
    if (mine.length === 0) {
      d.appendChild(el('div', 'small muted', 'Задач с этим исполнителем нет. Задачи берутся из registry/tasks/*.yaml и из событий team/task в логах DSH.'));
    } else {
      var stack = el('div', 'stack');
      mine.forEach(function (t) {
        var row = el('div', 'task-row');
        var h = el('div', 't-head');
        h.appendChild(el('span', 't-id', t.id));
        h.appendChild(el('span', 't-subject', t.subject));
        h.appendChild(el('span', 'spacer'));
        h.appendChild(statusBadge(t.status));
        row.appendChild(h);
        var meta = el('div', 't-meta');
        meta.appendChild(el('span', null, t.group + ' → ' + t.category));
        if (t.originLabel) meta.appendChild(el('span', null, 'источник: ' + t.originLabel));
        if (t.due) meta.appendChild(el('span', null, 'срок: ' + t.due));
        row.appendChild(meta);
        stack.appendChild(row);
      });
      d.appendChild(stack);
    }
  });
}

/* ---------------- boot ---------------- */
function boot() {
  renderHeader();
  renderTabs();
  renderActive();
  renderFooter();
}

// КАБИНЕТ КЛИЕНТА (T78). Раньше здесь была плашка «панель в виде КЛИЕНТА (каркас)» — она сообщала
// клиенту, что продукт недоделан, и НЕ мешала показывать операторские данные. Теперь клиент видит
// только своё: приветствие, шаги первого входа, свои услуги и счета, историю и «Вопрос агенту».
// Операторские показатели и действия в этом режиме не отрисовываются вообще — см. renderActive().
function clientCabinet(host) {
  if (!clientMode) return;
  var clientId = (function () {
    var m = /[?&]client=([^&]+)/.exec(String(window.location.search || ''));
    return m ? decodeURIComponent(m[1]) : null;
  })();
  var svc = (STATE && STATE.service) || null;
  var clientRec = null;
  if (svc) {
    var list = svc.clients || svc.items || [];
    clientRec = clientId ? list.filter(function (c) { return String(c.id) === clientId; })[0] : list[0];
  }
  var name = clientRec && (clientRec.name || clientRec.title) ? String(clientRec.name || clientRec.title) : 'Здравствуйте';
  var head = el('div', 'card client-keep');
  head.appendChild(el('div', 'ag-group-title', name + '! Это ваш кабинет'));
  head.appendChild(el('div', 'small muted', 'Здесь только ваши объекты, услуги и отчёты. Внутренних показателей сервиса тут нет.'));

  // «Что дальше» — онбординг первого входа.
  head.appendChild(clientOnboarding());

  // Свои услуги и счета (только этого клиента).
  var own = el('div', 'card client-keep');
  own.appendChild(el('div', 'ag-group-title', 'Ваши услуги и счета'));
  var mine = clientRec && Array.isArray(clientRec.services) ? clientRec.services : [];
  if (!clientRec) {
    own.appendChild(note('warn', 'данных нет: кабинет ещё не привязан к клиенту. Оператор подключит вас — и здесь появятся ваши услуги.'));
  } else if (!mine.length) {
    own.appendChild(note('warn', 'данных нет: услуги ещё не подключены. После подключения здесь будет список с ценами и датами.'));
  } else {
    rowsTable(own, [['Услуга'], ['Статус'], ['Стоимость'], ['Следующее списание']], mine.map(function (s) {
      return [String(s.name || s.serviceName || '—'), s.enabled === false ? 'приостановлена' : 'активна',
        s.priceRub !== undefined && s.priceRub !== null ? money(s.priceRub, true) : (s.price !== undefined ? String(s.price) : '—'),
        s.nextAt || s.next || '—'];
    }));
  }
  head.appendChild(own);

  // Вопрос агенту: рабочая форма — уходит оператору, клиент видит статус.
  var ask = el('div', 'card client-keep');
  ask.appendChild(el('div', 'ag-group-title', 'Вопрос агенту'));
  ask.appendChild(el('div', 'small muted', 'Напишите вопрос — он попадёт оператору, а здесь появится отметка, что вопрос принят.'));
  var topic = el('input'); topic.type = 'text'; topic.placeholder = 'Тема (например: почему выросли цены у соседа)'; topic.style.width = '100%'; topic.style.marginBottom = '8px';
  var text = el('textarea'); text.placeholder = 'Ваш вопрос'; text.rows = 3; text.style.width = '100%';
  var send = el('button', 'btn primary small', 'Отправить вопрос');
  var out = el('div');
  send.addEventListener('click', function () {
    if (!String(text.value || '').trim()) { out.textContent = 'Опишите вопрос — пустое сообщение отправить нельзя.'; return; }
    send.disabled = true;
    fetch('/api/client/question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: name, contact: (clientRec && (clientRec.contact || clientRec.email)) || '',
      topic: String(topic.value || '').trim(), comment: String(text.value).trim(),
      source: 'client-cabinet', page: window.location.pathname + window.location.search
    }) }).then(function (r) { return r.json(); }).then(function (res) {
      send.disabled = false;
      out.textContent = res && res.ok ? 'Вопрос принят оператору. Статус: новая. Ответ придёт на ваш контакт.' : ('Не удалось отправить: ' + ((res && res.message) || 'ошибка'));
    }).catch(function (e) { send.disabled = false; out.textContent = 'Не удалось отправить: ' + e.message; });
  });
  ask.appendChild(topic); ask.appendChild(text);
  var rowQ = el('div', 'filters'); rowQ.appendChild(send);
  ask.appendChild(rowQ); ask.appendChild(out);
  head.appendChild(ask);

  host.appendChild(head);
}

// Совместимость: старые вызовы плашки.
function clientModeBanner(host) { if (clientMode) clientCabinet(host); }

function refresh(btn) {
  if (STANDALONE) {
    toast('Это автономная копия: данные вшиты в файл и сами не обновляются. Пересоберите: node marketing-agents/dashboard/build-standalone.mjs', 'bad');
    return;
  }
  clearConfirmNote();
  showBusy('Выполняется: сбор данных…');
  btn.disabled = true;
  btn.textContent = 'Собираю…';
  fetch('/api/collect', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.message || 'ошибка сборки');
      return loadState();
    })
    .then(function () {
      boot();
      toast('Данные пересобраны: ' + STATE.meta.totals.sessions + ' сессий, ' + STATE.meta.totals.tasks + ' задач.');
    })
    .catch(function (e) { toast('Не удалось пересобрать: ' + e.message, 'bad'); })
    .then(function () { clearBusy(); clearConfirmNote(); btn.disabled = false; btn.textContent = 'Обновить данные'; });
}

// Адрес может быть составным: #раздел или #раздел/подвкладка (#agents/sources).
// Раньше «#agents/sources» целиком уходило в поиск по VIEWS, не находилось и молча
// падало на «Обзор» — из-за этого клик по вкладке выбрасывал из раздела.
function hashTarget() {
  var raw = String(window.location.hash || '').replace(/^#/, '');
  if (!raw) return { tab: null, sub: null, raw: '' };
  var parts = raw.split('/');
  return { tab: parts[0] || null, sub: parts[1] || null, raw: raw };
}

function tabFromHash() {
  var t = hashTarget().tab;
  if (t && typeof VIEWS !== 'undefined' && VIEWS[t]) return t;
  return null;
}

document.addEventListener('DOMContentLoaded', function () {
  var fromHash = tabFromHash();
  if (fromHash) activeTab = fromHash;
  var lastHash = window.location.hash;
  window.addEventListener('hashchange', function () {
    if (window.location.hash === lastHash) return;
    lastHash = window.location.hash;
    if (typeof closeDrawer === 'function') closeDrawer();
    if (typeof closeMenu === 'function') closeMenu();
    var hs = hashTarget();
    var t = tabFromHash();
    if (!hs.tab) {
      t = 'overview';                      // адрес без хэша — «Обзор»
    } else if (!t) {
      // Неизвестный раздел: НЕ выбрасываем на «Обзор», остаёмся где были и говорим прямо.
      toast('Раздел «' + hs.tab + '» не найден — остаёмся на «' + activeTab + '».', 'bad');
      window.location.hash = '#' + activeTab;
      return;
    }
    activeTab = t;
    renderTabs();
    renderActive();
  });
  // Поверхность и тема связаны: «Клиент» без явной темы в ссылке открывается в «Кабинете».
  var themeFromLink = window.location.search.indexOf('theme=') >= 0;
  applyTheme(clientMode && !themeFromLink ? 'light' : currentTheme());
  document.addEventListener('keydown', function (e) { if (typeof sidebarHotkeys === 'function') sidebarHotkeys(e); });
  q('btnRefresh').addEventListener('click', function () { refresh(this); });
  q('drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  loadState().then(boot).catch(function (e) {
    q('view').appendChild(note('bad', 'Не удалось загрузить /api/state: ' + e.message + '. Сервер запущен?'));
  });
});
