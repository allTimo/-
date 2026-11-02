/* Одинаковая структура для всех трёх макетов. Различается только оформление. */
'use strict';

var MOCK = {
  workspace: 'Личное',
  user: { name: 'Артём', plan: 'тариф платформы: Личный' },
  nav: [
    ['Работа', ['Обзор', 'Клиенты', 'Подписки и тарифы', 'Услуги', 'Очередь работ', 'Агенты']],
    ['Аналитика', ['Аналитика', 'Результаты', 'Расходы', 'Экономика']],
    ['Система', ['Интеграции', 'Оплаты', 'Журнал', 'Настройки']],
    ['Помощь', ['Обучение', 'Поддержка']]
  ],
  kpi: [
    ['Клиентов', '3', 'активных 2'],
    ['Услуг', '3', 'включено 2'],
    ['Прогонов за неделю', '6', 'успешно 5'],
    ['Доход в месяц', '41 900 ₽', 'по подпискам'],
    ['Себестоимость', '2 340 ₽', 'шесть прогонов'],
    ['Маржа', '39 560 ₽', '94% от дохода']
  ],
  services: [
    ['Мониторинг конкурентов и цен', '2 900 ₽', '120 ₽', '2 780 ₽', '2 подписчика'],
    ['Настройка Яндекс Директа', '9 900 ₽', '450 ₽', '9 450 ₽', '1 подписчик'],
    ['Размещение и аудит на площадках', '5 900 ₽', '260 ₽', '5 640 ₽', '2 подписчика']
  ],
  queue: [
    ['10:02', 'Мониторинг конкурентов', 'ЖК «Свет»', 'готово', '1,5 с'],
    ['10:14', 'Мониторинг конкурентов', 'Селигер Сити', 'готово', '1,3 с'],
    ['11:00', 'Настройка Директа', 'Селигер Сити', 'в работе', '—'],
    ['11:20', 'Размещение и аудит', 'ЖК «Свет»', 'ждёт', '—'],
    ['12:05', 'Мониторинг конкурентов', 'Донстрой', 'ошибка', '0,4 с'],
    ['12:30', 'Отчёт для клиента', 'Селигер Сити', 'готово', '0,9 с']
  ]
};

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function add(p, tag, cls, text) { var n = el(tag, cls, text); p.appendChild(n); return n; }

function statusClass(s) {
  if (s === 'готово') return 'st-ok';
  if (s === 'ошибка') return 'st-bad';
  if (s === 'в работе') return 'st-run';
  return 'st-wait';
}

function build() {
  var root = document.getElementById('app');
  if (!root) return;

  // шапка
  var head = add(root, 'header', 'hd');
  var brand = add(head, 'div', 'hd-brand');
  add(brand, 'div', 'hd-logo', 'ЦУ');
  var bt = add(brand, 'div');
  add(bt, 'div', 'hd-title', 'Центр управления агентами');
  add(bt, 'div', 'hd-sub', 'макет интерфейса · вымышленные данные');
  var hactions = add(head, 'div', 'hd-actions');
  var wsSel = add(hactions, 'select', 'hd-ws');
  ['Личное', 'Студия'].forEach(function (w) { var o = el('option', null, w); o.value = w; wsSel.appendChild(o); });
  var create = add(hactions, 'button', 'btn btn-primary', '+ Создать');
  create.title = 'Создать клиента, услугу, задачу, объект или счёт';
  add(hactions, 'button', 'btn', 'Поиск · Ctrl+K').title = 'Командная палитра';

  var body = add(root, 'div', 'shell');
  var side = add(body, 'aside', 'side');
  MOCK.nav.forEach(function (g) {
    add(side, 'div', 'side-group', g[0]);
    g[1].forEach(function (item, i) {
      var a = add(side, 'button', 'side-item' + ((g[0] === 'Работа' && i === 0) || item === 'Клиенты' ? '' : ''));
      if (g[0] === 'Работа' && i === 0) a.className = 'side-item active';
      a.appendChild(el('span', 'side-dot'));
      a.appendChild(el('span', 'side-label', item));
      if (item === 'Обзор') a.appendChild(el('span', 'side-count', '3'));
      if (item === 'Очередь работ') a.appendChild(el('span', 'side-count', '1'));
      a.title = 'Раздел «' + item + '»';
    });
  });
  var foot = add(side, 'div', 'side-foot');
  add(foot, 'div', 'side-avatar', 'А');
  var u = add(foot, 'div');
  add(u, 'div', 'side-name', MOCK.user.name);
  add(u, 'div', 'side-plan', MOCK.user.plan);

  var main = add(body, 'main', 'main');
  add(main, 'h1', 'page-title', 'Обзор');
  add(main, 'div', 'page-sub', 'Что происходит в сервисе прямо сейчас · данные вымышленные, это макет');

  var kpis = add(main, 'div', 'kpis');
  MOCK.kpi.forEach(function (k) {
    var c = add(kpis, 'div', 'kpi');
    add(c, 'div', 'kpi-label', k[0]);
    add(c, 'div', 'kpi-value', k[1]);
    add(c, 'div', 'kpi-foot', k[2]);
  });

  var cards = add(main, 'div', 'cards');
  var c1 = add(cards, 'div', 'card');
  add(c1, 'h2', 'card-title', 'Маржа по услугам');
  MOCK.services.forEach(function (s) {
    var row = add(c1, 'div', 'row');
    add(row, 'div', 'row-name', s[0]);
    add(row, 'div', 'row-value', s[3]);
    var bar = add(row, 'div', 'bar');
    add(bar, 'i').style.width = Math.max(8, Math.round((parseInt(s[3].replace(/\D/g, ''), 10) / 9450) * 100)) + '%';
  });
  var c2 = add(cards, 'div', 'card');
  add(c2, 'h2', 'card-title', 'Клиенты');
  [['ЖК «Свет» (Dominanta)', 'Бизнес', '2 услуги'], ['СГ «Гранель» — Селигер Сити', 'Премиум', '3 услуги'], ['«Донстрой» (лид)', 'Старт', 'услуги не подключены']].forEach(function (c) {
    var row = add(c2, 'div', 'row');
    add(row, 'div', 'row-name', c[0]);
    add(row, 'div', 'row-meta', c[1] + ' · ' + c[2]);
  });

  var table = add(main, 'div', 'card');
  add(table, 'h2', 'card-title', 'Очередь работ');
  var tbl = add(table, 'table', 'tbl');
  var thead = add(tbl, 'thead');
  var trh = add(thead, 'tr');
  ['Время', 'Услуга', 'Клиент', 'Статус', 'Длительность'].forEach(function (h) { add(trh, 'th', null, h); });
  var tb = add(tbl, 'tbody');
  MOCK.queue.forEach(function (q) {
    var tr = add(tb, 'tr');
    add(tr, 'td', 'mono', q[0]);
    add(tr, 'td', null, q[1]);
    add(tr, 'td', null, q[2]);
    var td = add(tr, 'td');
    add(td, 'span', 'badge ' + statusClass(q[3]), q[3]);
    add(tr, 'td', 'mono', q[4]);
  });
}

document.addEventListener('DOMContentLoaded', build);
