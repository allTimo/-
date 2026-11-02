/* Левая панель навигации: структура, счётчики, сворачивание, палитра, тема. */
'use strict';

var NAV = [
  { group: 'Работа', items: [
    { id: 'overview', label: 'Обзор', icon: 'grid', counter: function (s) { return s.alerts ? s.alerts.counts.total : 0; }, counterKind: 'alert' },
    { id: 'clients', label: 'Клиенты', icon: 'users' },
    { id: 'subscriptions', label: 'Подписки и тарифы', icon: 'card', counter: function (s) { return s.service ? s.service.counts.overdue : 0; }, counterKind: 'bad' },
    { id: 'services', label: 'Услуги', icon: 'spark' },
    { id: 'queue', label: 'Очередь работ', icon: 'list', counter: function (s) { return s.service ? s.service.counts.runsFailed : 0; }, counterKind: 'bad' },
    { id: 'agents', label: 'Агенты', icon: 'bot' },
    { id: 'sources', label: 'Агенты-источники', icon: 'plug', sub: true },
    { id: 'objects', label: 'Объекты', icon: 'home' }
  ] },
  { group: 'Аналитика', items: [
    { id: 'analytics', label: 'Аналитика', icon: 'chart' },
    { id: 'results', label: 'Результаты', icon: 'check' },
    { id: 'usage', label: 'Расходы', icon: 'ruble' },
    { id: 'economy', label: 'Экономика', icon: 'trend' },
    { id: 'quality', label: 'Качество', icon: 'check' }
  ] },
  { group: 'Система', items: [
    { id: 'integrations', label: 'Интеграции', icon: 'box' },
    { id: 'payments', label: 'Оплаты', icon: 'wallet', counter: function (s) { return s.service ? s.service.counts.unpaid : 0; }, counterKind: 'bad' },
    { id: 'notifications', label: 'Уведомления', icon: 'bell' },
    { id: 'system', label: 'Состояние системы', icon: 'pulse' },
    { id: 'journal', label: 'Журнал', icon: 'clock' },
    { id: 'infra', label: 'Инфраструктура', icon: 'wrench' }
  ] },
  { group: 'Управление', items: [
    { id: 'workspaces', label: 'Рабочие пространства', icon: 'layers' },
    { id: 'projects', label: 'Проекты', icon: 'folder' },
    { id: 'team', label: 'Команда и доступы', icon: 'userplus' },
    { id: 'security', label: 'Безопасность', icon: 'lock' },
    { id: 'settings', label: 'Настройки', icon: 'gear' }
  ] },
  { group: 'Помощь', items: [
    { id: 'learning', label: 'Обучение', icon: 'book' },
    { id: 'support', label: 'Поддержка', icon: 'help' }
  ] }
];

// Вид клиента: что видит заказчик в своём кабинете (каркас).
var CLIENT_NAV = [
  { group: 'Кабинет клиента', items: [
    { id: 'services', label: 'Мои услуги', icon: 'spark' },
    { id: 'objects', label: 'Мои объекты', icon: 'home' },
    { id: 'analytics', label: 'Отчёты', icon: 'chart' },
    { id: 'journal', label: 'Изменения', icon: 'clock' },
    { id: 'subscriptions', label: 'Подписка и счета', icon: 'card' },
    { id: 'support', label: 'Вопрос агенту', icon: 'help' }
  ] }
];

var ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  users: 'M8 11a4 4 0 100-8 4 4 0 000 8zm8 0a3 3 0 100-6 3 3 0 000 6zM2 21v-2a5 5 0 015-5h2a5 5 0 015 5v2M16 21v-2a5 5 0 00-2-4',
  card: 'M2 6h20v12H2zM2 10h20',
  spark: 'M12 2l2.2 6.2L20 10l-5.8 1.8L12 18l-2.2-6.2L4 10l5.8-1.8z',
  list: 'M4 6h16M4 12h16M4 18h16',
  bot: 'M6 8h12v10H6zM12 4v4M9 13h.01M15 13h.01M3 12h3M18 12h3',
  home: 'M4 11l8-7 8 7v9a1 1 0 01-1 1H5a1 1 0 01-1-1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  ruble: 'M8 20V4h5a4 4 0 010 8H6M4 16h9M4 12h9',
  trend: 'M3 17l6-6 4 4 8-8M21 7h-6M21 7v6',
  check: 'M4 12l5 5L20 6',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 01-6 6 6 6 0 01-6-6zM12 17v5',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  wallet: 'M3 7h18v12H3zM3 7l3-4h12l3 4M16 13h2',
  bell: 'M6 16V10a6 6 0 1112 0v6l2 2H4zM10 20a2 2 0 004 0',
  pulse: 'M2 12h4l3-8 4 16 3-8h6',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l4 2',
  wrench: 'M14 6a4 4 0 105.2 5.2L21 12l-3 3-9 9-3-3 9-9z',
  layers: 'M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  folder: 'M3 6h6l2 2h10v11H3z',
  userplus: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-2a5 5 0 015-5h4a5 5 0 015 5v2M18 8v6M15 11h6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-2-4-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 2h4l1-2 2-1 2 1 2-4-2-1z',
  book: 'M4 4h7a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-7a3 3 0 00-3 3v13a2 2 0 012-2h8z',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9a2.5 2.5 0 115 0c0 1.5-2.5 2-2.5 3.5M12 17h.01'
};

function svgIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'nico');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.grid);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

var SIDEBAR_COLLAPSED_KEY = 'dsh.nav.collapsed';
var THEME_KEY = 'dsh.theme';

// Свёрнутость запоминается в браузере. Дополнительно можно задать ссылкой:
// ?nav=collapsed — удобно для скриншотов и прямых ссылок.
function navCollapsed() {
  try {
    if (window.location.search.indexOf('nav=collapsed') >= 0) return true;
    if (window.location.search.indexOf('nav=expanded') >= 0) return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch (e) { return false; }
}
function setNavCollapsed(v) { try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ } }
// Тема запоминается в браузере. Ссылкой можно задать принудительно:
// ?theme=light или ?theme=dark — удобно для скриншотов и прямых ссылок.
function currentTheme() {
  try {
    if (window.location.search.indexOf('theme=light') >= 0) return 'light';
    if (window.location.search.indexOf('theme=dark') >= 0) return 'dark';
    return window.localStorage.getItem(THEME_KEY) || 'dark';
  } catch (e) { return 'dark'; }
}
function applyTheme(t) {
  try { window.localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', t);
}

// Счётчики задаются в nav.yaml ПО ИМЕНИ, а не кодом.
var COUNTERS = {
  alerts: function (s) { return s.alerts ? s.alerts.counts.total : 0; },
  overdue: function (s) { return s.service ? s.service.counts.overdue : 0; },
  failed: function (s) { return s.service ? s.service.counts.runsFailed : 0; },
  unpaid: function (s) { return s.service ? s.service.counts.unpaid : 0; }
};

function navItemCounter(item) {
  if (!STATE) return 0;
  if (typeof item.counter === 'function') { try { return Number(item.counter(STATE)) || 0; } catch (e) { return 0; } }
  var fn = item.counter ? COUNTERS[item.counter] : null;
  if (!fn) return 0;
  try { return Number(fn(STATE)) || 0; } catch (e) { return 0; }
}

// Источник меню: конфиг dashboard/config/nav.yaml (приходит как STATE.nav).
// Если конфига нет — работает встроенная схема, чтобы панель не осталась без меню.
function navGroups() {
  if (STATE && STATE.nav && STATE.nav.groups && STATE.nav.groups.length > 0) {
    if (clientMode) return CLIENT_NAV;
    return STATE.nav.groups;
  }
  return clientMode ? CLIENT_NAV : NAV;
}

function allNavItems() {
  var out = [];
  navGroups().forEach(function (g) { g.items.forEach(function (i) { out.push(i); }); });
  return out;
}

function renderSidebar() {
  var host = q('sidebar');
  if (!host) return;
  clear(host);
  var collapsed = navCollapsed();
  host.className = 'sidebar' + (collapsed ? ' collapsed' : '');

  // --- шапка панели ---
  var head = el('div', 'sb-head');
  var brand = el('div', 'sb-brand');
  var logo = el('div', 'logo', 'ЦУ');
  brand.appendChild(logo);
  brand.appendChild(el('div', 'sb-brand-text', 'Центр управления'));
  head.appendChild(brand);
  var themeBtn = el('button', 'sb-collapse sb-theme', currentTheme() === 'dark' ? '☾' : '☀');
  themeBtn.title = currentTheme() === 'dark' ? 'Сейчас тёмная тема — включить светлую' : 'Сейчас светлая тема — включить тёмную';
  themeBtn.setAttribute('aria-label', 'Переключить тему');
  themeBtn.addEventListener('click', function () {
    var t = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    renderSidebar();
    if (typeof renderActive === 'function') renderActive();
    toast('Тема: ' + (t === 'dark' ? 'тёмная' : 'светлая'));
  });
  head.appendChild(themeBtn);
  var collapseBtn = el('button', 'sb-collapse', collapsed ? '»' : '«');
  collapseBtn.title = collapsed ? 'Развернуть панель' : 'Свернуть панель до иконок';
  collapseBtn.addEventListener('click', function () { setNavCollapsed(!navCollapsed()); renderSidebar(); });
  head.appendChild(collapseBtn);
  host.appendChild(head);

  // рабочее пространство + создать + поиск
  var ws = el('div', 'sb-ws');
  var wsSel = el('select');
  wsSel.title = 'Рабочее пространство';
  [['personal', 'Личное']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; wsSel.appendChild(op); });
  var opAdd = el('option', null, '+ Новое пространство…'); opAdd.value = '__new'; wsSel.appendChild(opAdd);
  wsSel.addEventListener('change', function () {
    if (wsSel.value === '__new') { wsSel.value = 'personal'; goTab('workspaces'); }
  });
  ws.appendChild(wsSel);
  host.appendChild(ws);

  var actions = el('div', 'sb-actions');
  var createBtn = el('button', 'btn primary sb-create', '+ Создать');
  createBtn.title = 'Создать клиента, услугу, задачу, объект или счёт';
  createBtn.addEventListener('click', function (e) { e.stopPropagation(); openCreateMenu(createBtn); });
  actions.appendChild(createBtn);
  var searchBtn = el('button', 'sb-search', 'Поиск…');
  searchBtn.title = 'Командная палитра — Ctrl+K';
  searchBtn.addEventListener('click', function () { openPalette(); });
  actions.appendChild(searchBtn);
  host.appendChild(actions);

  var surface = el('div', 'sb-surface');
  var opBtn = el('button', 'sb-surface-btn' + (!clientMode ? ' on' : ''), 'Оператор');
  var clBtn = el('button', 'sb-surface-btn' + (clientMode ? ' on' : ''), 'Клиент');
  opBtn.title = 'Панель оператора: всё про сервис';
  clBtn.title = 'Вид клиента: только услуги, отчёты и счета вашей компании';
  // Поверхность и тема связаны: «Оператор» — «Пульт» (тёмная), «Клиент» — «Кабинет» (светлая).
  // Вручную тему всё равно можно переключить — кнопка темы в шапке панели.
  opBtn.addEventListener('click', function () { clientMode = false; applyTheme('dark'); renderSidebar(); renderActive(); });
  clBtn.addEventListener('click', function () { clientMode = true; applyTheme('light'); renderSidebar(); renderActive(); });
  surface.appendChild(opBtn);
  surface.appendChild(clBtn);
  host.appendChild(surface);

  // --- группы ---
  var navHost = el('nav', 'sb-nav');
  navGroups().forEach(function (g) {
    var gh = el('div', 'sb-group');
    gh.appendChild(el('div', 'sb-group-title', g.title || g.group));
    g.items.forEach(function (it) { gh.appendChild(navLink(it)); });
    navHost.appendChild(gh);
  });
  host.appendChild(navHost);

  // --- подвал: аккаунт ---
  var foot = el('div', 'sb-foot');
  var av = el('div', 'sb-avatar', 'А');
  foot.appendChild(av);
  var meta = el('div', 'sb-user');
  meta.appendChild(el('div', 'sb-user-name', 'Артём'));
  meta.appendChild(el('div', 'sb-user-plan', 'тариф платформы: Личный'));
  foot.appendChild(meta);
  var menuBtn = el('button', 'sb-user-menu', '⋯');
  menuBtn.title = 'Профиль · Реквизиты · Документы · Тема · Язык · Выход';
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); openAccountMenu(menuBtn); });
  foot.appendChild(menuBtn);
  host.appendChild(foot);
}

function navLink(item) {
  // «Источники» теперь живут внутри «Агентов»: подсвечиваем родителя,
  // когда открыт старый адрес #sources.
  // «Агенты-исполнители» и «Агенты-источники» — равноправные пункты, вложенности нет.
  var isActive = activeTab === item.id;
  var a = el('button', 'sb-item' + (isActive ? ' active' : ''));
  a.setAttribute('data-nav', item.id);
  a.title = item.label;
  a.setAttribute('data-nav', item.id);
  a.appendChild(svgIcon(item.icon));
  a.appendChild(el('span', 'sb-label', item.label));
  var n = navItemCounter(item);
  if (n > 0) {
    var kind = item.counterKind || item.counter_kind || (item.counter === 'alerts' ? '' : 'bad');
    var c = el('span', 'sb-count' + (kind === 'bad' ? ' bad' : ''), String(n));
    c.title = kind === 'bad' ? 'Требует внимания' : 'Есть тревоги';
    a.appendChild(c);
  }
  a.addEventListener('click', function () { goTab(item.id); });
  return a;
}

function goTab(tab) {
  activeTab = tab;
  // БАГ: при переходе между разделами оставались открытыми выдвижная панель (её оверлей
  // перекрывал новый раздел), командная палитра и меню. Закрываем всё перед отрисовкой.
  if (typeof closeDrawer === 'function') closeDrawer();
  var pal = q('palette');
  if (pal) pal.remove();
  closeMenu();
  if (window.location.hash !== '#' + tab) window.location.hash = tab;
  renderSidebar();
  renderActive();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- меню «+ Создать» ---------------- */
var CREATE_ITEMS = [
  ['client', 'Клиент', 'Добавить заказчика: название, контакт, тариф'],
  ['service', 'Услуга', 'Новая услуга в каталоге: что делает, цена, расписание'],
  ['task', 'Задача', 'Поставить задачу исполнителю со сроком'],
  ['object', 'Объект', 'Добавить ЖК или конкурента'],
  ['invoice', 'Счёт', 'Выставить счёт за период вручную']
];

// ЕДИНОЕ закрытие всех всплывающих меню: по Esc, клику вне и любому действию.
// Раньше каждое меню вешало свой обработчик и «залипало» при Esc.
var OPEN_MENU = null;
var MENU_OUTSIDE = null;

function closeMenu() {
  if (OPEN_MENU) { try { OPEN_MENU.remove(); } catch (e) { /* ignore */ } OPEN_MENU = null; }
  if (MENU_OUTSIDE) { document.removeEventListener('click', MENU_OUTSIDE); MENU_OUTSIDE = null; }
}

function openMenu(anchor, items) {
  closeMenu();
  var m = el('div', 'sb-popup');
  m.setAttribute('role', 'menu');
  items.forEach(function (it) {
    var b = el('button', 'sb-popup-item');
    b.appendChild(el('span', 'sb-popup-title', it[0]));
    b.appendChild(el('span', 'sb-popup-hint', it[1]));
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      if (typeof it[3] === 'function') it[3]();
      else if (it[4]) { toast(it[2] || it[0]); goTab(it[4]); }
      else toast(it[2] || ('«' + it[0] + '» — раздел в подготовке, откроется на следующем этапе.'), 'bad');
    });
    m.appendChild(b);
  });
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  var left = Math.round(r.left);
  var top = Math.round(r.bottom + 6);
  // не даём меню уехать за экран
  var mw = m.offsetWidth || 320;
  var mh = m.offsetHeight || 240;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  OPEN_MENU = m;
  MENU_OUTSIDE = function (e) { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(function () { document.addEventListener('click', MENU_OUTSIDE); }, 0);
  return m;
}

function popupMenu(anchor, items) { return openMenu(anchor, items); }

function openCreateMenu(anchor) {
  // Раньше пункт обещал открыть раздел, но только показывал уведомление.
  // Теперь действительно переходим в нужный раздел.
  var targets = { client: 'clients', service: 'services', task: 'tasks', object: 'projects', invoice: 'subscriptions' };
  openMenu(anchor, CREATE_ITEMS.map(function (c) {
    return [c[1], c[2], 'Открываю раздел «' + c[1] + '»', null, targets[c[0]]];
  }));
}

function openAccountMenu(anchor) {
  var m = openMenu(anchor, [
    ['Профиль', 'Имя, контакты', null, function () { goTab('profile'); }],
    ['Реквизиты', 'ИНН, статус НПД', null, function () { goTab('account'); }],
    ['Документы', 'Оферта, политика, акты', null, function () { goTab('account'); }],
    ['Тема: ' + (currentTheme() === 'dark' ? 'светлая' : 'тёмная'), 'Переключить оформление', null, function () {
      var t = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(t);
      renderSidebar();
      if (typeof renderActive === 'function') renderActive();
      toast('Тема: ' + (t === 'dark' ? 'тёмная' : 'светлая'));
    }],
    ['Язык: русский', 'Другие языки позже', null, function () { toast('Интерфейс пока только на русском.'); }],
    ['Выход', 'Завершить сеанс', null, function () { toast('Это локальная панель: выхода нет, просто закройте окно.'); }]
  ]);
  return m;
}

function openAccountMenuLegacy(anchor) {
  var items = [
    ['Профиль', 'Имя, контакты', 'Открываю профиль', 'profile'],
    ['Реквизиты', 'ИНН, статус НПД', 'Открываю реквизиты', 'account'],
    ['Документы', 'Оферта, политика, акты', 'Открываю документы', 'account'],
    ['Тема: ' + (currentTheme() === 'dark' ? 'светлая' : 'тёмная'), 'Переключить оформление', null, null],
    ['Язык: русский', 'Другие языки позже', 'Интерфейс пока только на русском.', null],
    ['Выход', 'Завершить сеанс', 'Это локальная панель: выхода нет, просто закройте окно.', null]
  ];
  popupMenu(anchor, items.map(function (i) {
    return [i[0], i[1], i[2], i[3]];
  }).map(function (i) {
    return [i[0], i[1], i[2]];
  }));
  // отдельно навесим переключение темы и переходы
  var opened = document.querySelector('.sb-popup');
  if (!opened) return;
  var btns = opened.querySelectorAll('.sb-popup-item');
  btns[3].addEventListener('click', function () {
    var t = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    opened.remove();
    renderSidebar();
    toast('Тема: ' + (t === 'dark' ? 'тёмная' : 'светлая'));
  });
  btns[0].addEventListener('click', function () { opened.remove(); goTab('profile'); });
  btns[1].addEventListener('click', function () { opened.remove(); goTab('account'); });
  btns[2].addEventListener('click', function () { opened.remove(); goTab('account'); });
}

/* ---------------- командная палитра Ctrl+K ---------------- */
function openPalette() {
  var old = q('palette');
  if (old) { old.remove(); return; }
  var back = el('div', 'palette-back');
  back.id = 'palette';
  var box = el('div', 'palette');
  var inp = el('input');
  inp.type = 'text';
  inp.placeholder = 'Перейти к разделу…';
  box.appendChild(inp);
  var list = el('div', 'palette-list');
  box.appendChild(list);
  back.appendChild(box);
  back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  inp.focus();

  function draw(query) {
    clear(list);
    var items = allNavItems().map(function (i) { return { label: i.label, id: i.id, hint: 'раздел' }; })
      .concat([
        { label: 'Создать клиента', id: 'clients', hint: 'создать' },
        { label: 'Создать услугу', id: 'services', hint: 'создать' },
        { label: 'Создать задачу', id: 'tasks', hint: 'создать' },
        { label: 'Создать счёт', id: 'subscriptions', hint: 'создать' }
      ]);
    var q1 = String(query || '').trim().toLowerCase();
    var shown = 0;
    items.forEach(function (i) {
      if (q1 && i.label.toLowerCase().indexOf(q1) === -1) return;
      if (shown++ > 14) return;
      var b = el('button', 'palette-item');
      b.appendChild(el('span', null, i.label));
      b.appendChild(el('span', 'palette-hint', i.hint));
      b.addEventListener('click', function () { back.remove(); goTab(i.id); });
      list.appendChild(b);
    });
    if (shown === 0) list.appendChild(el('div', 'palette-empty', 'Ничего не найдено'));
  }
  inp.addEventListener('input', function () { draw(inp.value); });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') back.remove();
    if (e.key === 'Enter') {
      var first = list.querySelector('.palette-item');
      if (first) first.click();
    }
  });
  draw('');
}

/* ---------------- горячие клавиши ---------------- */
function sidebarHotkeys(e) {
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); return; }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    var m = /^[1-9]$/.exec(e.key);
    if (m) {
      var idx = Number(m[0]) - 1;
      var all = allNavItems().slice(0, 9);
      if (all[idx]) { e.preventDefault(); goTab(all[idx].id); }
    }
  }
  if (e.key === 'Escape') {
    // Esc должен закрывать ВСЕ всплывающие слои: палитру, меню, выдвижную панель.
    var p = q('palette');
    if (p) p.remove();
    closeMenu();
    if (typeof closeDrawer === 'function') closeDrawer();
  }
}
