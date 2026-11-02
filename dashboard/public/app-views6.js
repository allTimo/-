/* Новые разделы: сервис, оплаты, система, журнал, аккаунт, помощь. */
'use strict';

function placeholderCard(title, desc, bullets) {
  var c = card(title);
  c.appendChild(note('warn', 'Раздел в подготовке. ' + desc));
  if (bullets && bullets.length) {
    var ul = el('ul', 'clean');
    bullets.forEach(function (b) { ul.appendChild(el('li', null, b)); });
    c.appendChild(ul);
  }
  return c;
}

function rowsTable(host, headers, rows) {
  var wrap = el('div', 'table-wrap');
  var t = el('table', 'data');
  var thead = el('thead'); var tr = el('tr');
  headers.forEach(function (h) { add(tr, 'th', h[1] || null, h[0]); });
  thead.appendChild(tr); t.appendChild(thead);
  var tb = el('tbody');
  rows.forEach(function (r) {
    var row = el('tr');
    r.forEach(function (cell, i) {
      if (cell instanceof Node) { var td = el('td'); td.appendChild(cell); row.appendChild(td); }
      else add(row, 'td', headers[i] && headers[i][1] === 'num' ? 'num' : null, cell);
    });
    tb.appendChild(row);
  });
  t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
  return wrap;
}

/* ---------- каркасы сервиса (данные есть, интерфейс — следующий этап) ---------- */
function serviceStub(id, title, desc, bullets) {
  VIEWS[id] = function (view) {
    view.appendChild(placeholderCard(title, desc, bullets));
    var doc = STATE.service;
    if (doc) {
      var c = card('Что уже готово в модели данных');
      c.appendChild(el('div', 'small muted', 'Файлы модели данных созданы и читаются панелью: registry/clients.yaml, services.yaml, subscriptions.yaml, invoices.yaml, runs.jsonl.'));
      var ul = el('ul', 'clean');
      ul.appendChild(el('li', null, 'клиентов: ' + doc.counts.clients + ' (активных ' + doc.counts.active + ')'));
      ul.appendChild(el('li', null, 'услуг: ' + doc.counts.services + ' (включено ' + doc.counts.servicesEnabled + ')'));
      ul.appendChild(el('li', null, 'подписок: ' + doc.counts.subscriptions + ' (просрочено ' + doc.counts.overdue + ')'));
      ul.appendChild(el('li', null, 'прогонов в журнале: ' + doc.counts.runs));
      ul.appendChild(el('li', null, 'счетов: ' + doc.counts.invoices + ' (не оплачено ' + doc.counts.unpaid + ')'));
      c.appendChild(ul);
      view.appendChild(c);
    }
  };
}

serviceStub('clients', 'Клиенты', 'Список клиентов сервиса, их тарифы, услуги, оплата и следующий отчёт. Появится вместе с каркасом сервиса (следующий этап по решению пользователя).',
  ['Список с фильтрами по статусу и тарифу', 'Карточка клиента: объекты, услуги, прогоны, счета', 'Действия: добавить, пауза, сменить тариф, сменить статус']);
serviceStub('subscriptions', 'Подписки и тарифы', 'Кто на каком тарифе, сроки, продления и долги. Появится вместе с каркасом сервиса.',
  ['Продлить подписку, сменить тариф', 'Выставить счёт за период', 'Контроль просроченных оплат']);
serviceStub('services', 'Услуги', 'Каталог услуг: что делает агент, кто исполняет, расписание, себестоимость, цена и маржа. Появится вместе с каркасом сервиса.',
  ['Карточки трёх услуг MVP', 'Включение и выключение услуги', 'Правка цены и расписания']);
serviceStub('queue', 'Очередь работ', 'Что запущено, что в работе, что упало. Данные будут браться из registry/runs.jsonl.',
  ['Статусы прогонов и длительность', 'Повторить упавший прогон', 'Посмотреть лог прогона']);
serviceStub('economy', 'Экономика', 'Доход по подпискам, себестоимость прогонов и маржа по услуге и клиенту. Появится вместе с каркасом сервиса.',
  ['Маржа по каждой услуге', 'Маржа по каждому клиенту', 'Динамика по неделям']);
serviceStub('quality', 'Качество', 'Сроки, доля отчётов без правок, сбои и повторные прогоны.',
  ['Сколько прогонов упало и почему', 'Среднее время прогона', 'Разбор инцидентов']);

/* ---------- Объекты: переехали в «Проекты» ---------- */
// Отдельного пункта «Объекты» в меню больше нет: он дублировал «Проекты» — и там и там
// список ЖК из registry/projects.yaml. Старая ссылка #objects ведёт в «Проекты».
VIEWS.objects = function (view) {
  toast('Раздел «Объекты» объединён с «Проектами» — открываю «Проекты».');
  if (window.location.hash !== '#projects') window.location.hash = '#projects';
  return VIEWS.projects ? VIEWS.projects(view) : view.appendChild(note('bad', 'Экран проектов не загружен.'));
};

VIEWS.objectsLegacy = function (view) {
  var p = STATE.projects;
  if (!p) { view.appendChild(note('bad', 'Нет данных по объектам.')); return; }
  view.appendChild(note(null, 'Объекты — это наши ЖК и конкуренты. Сейчас показаны проекты из registry/projects.yaml; добавление и правка появятся на этапе 2 T35.'));
  var s = section('Проекты (ЖК)', 'источник: registry/projects.yaml');
  p.projects.forEach(function (pr) {
    var c = card(pr.name);
    kv(c, [
      ['id', el('code', null, pr.id)],
      ['застройщик', pr.developer],
      ['класс', pr.klass],
      ['статус', pr.status === 'active' ? 'активен' : pr.status],
      ['агенты', (pr.agentsDetail || []).map(function (a) { return a.name; }).join(', ')],
      ['задач', String(pr.metrics.tasks.total)],
      ['расход', pr.metrics.tokens.totalTokens === 0 ? 'агент ещё не запускался' : money(pr.metrics.rub, pr.metrics.rubComplete)]
    ]);
    s.appendChild(c);
  });
  view.appendChild(s);

  var s2 = section('Конкуренты', 'встречаются в снимках');
  var c2 = card();
  var names = {};
  (STATE.sources.sources || []).forEach(function (src) {
    (src.stats.competitors || []).forEach(function (x) { names[x.name] = (names[x.name] || 0) + x.lots; });
  });
  var keys = Object.keys(names).sort(function (a, b) { return names[b] - names[a]; });
  if (keys.length === 0) c2.appendChild(el('div', 'muted', 'Конкуренты появятся после первого снимка.'));
  else {
    var ul = el('ul', 'clean');
    keys.forEach(function (k) { ul.appendChild(el('li', null, k + ' — лотов в снимках: ' + names[k])); });
    c2.appendChild(ul);
  }
  s2.appendChild(c2);
  view.appendChild(s2);
};

/* ---------- Оплаты ---------- */
VIEWS.payments = function (view) {
  view.appendChild(note('warn', 'В MVP счета выставляются ВРУЧНУЮ: панель помогает собрать счёт и акт, но не проводит оплату. Онлайн-оплата — следующий этап.'));

  var s1 = section('Способы приёма', 'как клиент может заплатить');
  var g1 = el('div', 'grid cards');
  [
    ['СБП', 'Перевод по номеру телефона или QR. Самый быстрый способ для частных клиентов.', 'Готов к работе вручную'],
    ['Банковская карта', 'Оплата картой по ссылке. Требует подключения платёжного провайдера.', 'Нужен провайдер'],
    ['Счёт для юрлиц', 'Счёт и акт для бухгалтерии клиента. Выставляем вручную из панели.', 'Готов к работе вручную']
  ].forEach(function (x) {
    var c = card(x[0]);
    c.appendChild(el('div', 'small muted', x[1]));
    c.appendChild(el('div', 'agent-meta')).appendChild(badge(x[2], x[2] === 'Нужен провайдер' ? 'warn' : 'ok'));
    g1.appendChild(c);
  });
  s1.appendChild(g1);
  view.appendChild(s1);

  var s2 = section('Платёжные провайдеры', 'подключение — заглушка, реальных платежей нет');
  var c2 = card();
  var providers = [
    ['ЮKassa', 'Приём карт и СБП, чеки для самозанятых', 'комиссия ~2,8%'],
    ['Тинькофф (Т-Банк)', 'Счёт на оплату и эквайринг', 'тариф по договору'],
    ['Robokassa', 'Карты, СБП, кошельки', 'комиссия от 2,7%'],
    ['Сбербанк', 'СБП и эквайринг', 'тариф по договору']
  ];
  rowsTable(c2, [['Провайдер'], ['Что даёт'], ['Условия'], ['Действие']], providers.map(function (p) {
    var b = el('button', 'btn small', 'Подключить');
    b.title = 'Заглушка: в MVP подключение делается вручную';
    b.addEventListener('click', function () { toast('«' + p[0] + '» — подключение появится после выбора провайдера. Пока это заглушка.', 'bad'); });
    return [p[0], p[1], p[2], b];
  }));
  s2.appendChild(c2);
  view.appendChild(s2);

  var s3 = section('Реквизиты и документы', 'что нужно для приёма оплаты');
  var c3 = card();
  kv(c3, [
    ['Статус', 'самозанятый (НПД)'],
    ['ИНН', 'заполняется в разделе «Аккаунт»'],
    ['Чеки НПД', 'формируются в приложении «Мой налог» после каждой оплаты'],
    ['Документы', 'оферта, политика обработки данных, акт за период']
  ]);
  s3.appendChild(c3);
  view.appendChild(s3);

  var s4 = section('Счета и акты', 'в MVP — вручную');
  var c4 = card();
  if (!STATE.service) c4.appendChild(el('div', 'muted', 'Модель счетов появится вместе с каркасом сервиса.'));
  else {
    var inv = STATE.service.invoices || [];
    if (inv.length === 0) c4.appendChild(el('div', 'muted', 'Счетов пока нет.'));
    else rowsTable(c4, [['Номер'], ['Клиент'], ['Период'], ['Сумма', 'num'], ['Статус'], ['Выставлен']], inv.map(function (i) {
      return [i.id, i.clientName, i.period, money(i.amountRub, true), i.statusLabel, i.issued || '—'];
    }));
    c4.appendChild(el('div', 'hintline', 'Счета ведутся в registry/invoices.yaml. Выставление и печать PDF — вручную, на следующем этапе.'));
  }
  s4.appendChild(c4);
  view.appendChild(s4);
};

/* ---------- Уведомления ---------- */
VIEWS.notifications = function (view) {
  var d = STATE.settings && STATE.settings.delivery ? STATE.settings.delivery : null;
  view.appendChild(note(null, 'Куда уходит отчёт и что включено. Автоматическая отправка в этой версии выключена: отчёт готовит агент, отправляете вы сами.'));
  var c = card('Каналы');
  if (!d) c.appendChild(el('div', 'muted', 'Данные о доставке недоступны.'));
  else {
    kv(c, [
      ['Режим отправки', d.where.sendMode],
      ['Telegram', d.where.telegram],
      ['Почта', d.where.email],
      ['Форматы отчёта', (d.where.formats || []).join(', ') || 'не заданы']
    ]);
    c.appendChild(el('div', 'hintline', 'Включить каналы и поменять формат можно во вкладке «Настройки» — блок «Доставка и уведомления».'));
  }
  view.appendChild(c);
  var s = section('Что стоит подключить');
  var c2 = card();
  var ul = el('ul', 'clean');
  ul.appendChild(el('li', null, 'Telegram-пульт: получать отчёты и ставить задачи из телефона. Нужен токен бота — сейчас выключен.'));
  ul.appendChild(el('li', null, 'Почта: отправлять отчёт клиенту письмом. Нужен адрес и почтовый шлюз.'));
  c2.appendChild(ul);
  s.appendChild(c2);
  view.appendChild(s);
};

/* ---------- Состояние системы ---------- */
VIEWS.system = function (view) {
  var meta = STATE.meta, usage = STATE.usage, alerts = STATE.alerts, sources = STATE.sources;
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Тревог', alerts ? String(alerts.counts.total) : '—', alerts ? (alerts.counts.critical + ' критичных') : '', alerts && alerts.counts.critical > 0 ? 'bad' : 'ok'));
  k.appendChild(kpi('Источников включено', sources.summary.enabled + ' / ' + sources.summary.total, 'работает: ' + sources.sources.filter(function (s) { return s.status === 'working'; }).length, 'accent'));
  k.appendChild(kpi('Моделей с ценой', usage.pricing.modelCount + ' / ' + usage.byModel.length, usage.unknownPriceModels.length ? 'без цены: ' + usage.unknownPriceModels.length : 'все с ценой', usage.unknownPriceModels.length ? 'warn' : 'ok'));
  k.appendChild(kpi('Прогонов упало', STATE.service ? String(STATE.service.counts.runsFailed) : '0', 'журнал registry/runs.jsonl', STATE.service && STATE.service.counts.runsFailed > 0 ? 'bad' : 'ok'));
  view.appendChild(k);

  var s1 = section('Источники', 'здоровье сбора');
  var c1 = card();
  rowsTable(c1, [['Источник'], ['Статус'], ['Лотов', 'num'], ['Последние данные'], ['Ограничения']], sources.sources.map(function (s) {
    var td = el('span'); td.appendChild(sourceStatusBadge(s.status));
    return [s.name, td, String(s.stats.lots), s.stats.lastDate ? fmtDay(s.stats.lastDate) : '—', (s.limits || '').slice(0, 60)];
  }));
  s1.appendChild(c1);
  view.appendChild(s1);

  var s2 = section('Модели и цены', 'источник: registry/prices.yaml');
  var c2 = card();
  c2.appendChild(el('div', 'small muted', 'Курс: ' + (usage.currency.usdRub || 'не задан') + ' ₽/$. Прайс: ' + (usage.pricing.schema || '—') + ', обновлён ' + (usage.pricing.fetchedAt || '—') + '.'));
  if (usage.unknownPriceModels.length) c2.appendChild(note('warn', 'Без цены в прайсе: ' + usage.unknownPriceModels.join(', ') + '. Их токены считаются, рубли — нет.'));
  else c2.appendChild(note('ok', 'У всех использованных моделей есть цена.'));
  s2.appendChild(c2);
  view.appendChild(s2);

  var s3 = section('Предупреждения сборщика', 'ошибки и неполные данные');
  var c3 = card();
  if (meta.warnings.length === 0) c3.appendChild(note('ok', 'Сборщик отработал без предупреждений.'));
  else meta.warnings.forEach(function (w) { c3.appendChild(note('warn', w.message)); });
  s3.appendChild(c3);
  view.appendChild(s3);

  var s4 = section('Файлы данных', 'откуда панель берёт цифры');
  var c4 = card();
  rowsTable(c4, [['Источник'], ['Путь'], ['Записей', 'num'], ['Состояние']], meta.sources.map(function (s) {
    var td = el('span'); td.appendChild(badge(s.exists ? 'ок' : 'нет файла', s.exists ? 'ok' : 'bad'));
    return [s.label, el('code', null, s.path), fmtInt(s.items), td];
  }));
  s4.appendChild(c4);
  view.appendChild(s4);
};

/* ---------- Журнал ---------- */
VIEWS.journal = function (view) {
  var meta = STATE.meta;
  var events = [];
  function push(at, what, was, now, kind) { events.push({ at: at, what: what, was: was, now: now, kind: kind }); }
  ['agents', 'sources'].forEach(function (kind) {
    var h = meta.history && meta.history[kind] ? meta.history[kind] : {};
    Object.keys(h).forEach(function (id) {
      var c = h[id];
      push(c.at, (kind === 'agents' ? 'агент ' : 'источник ') + id, c.previous ? 'включён' : 'выключен', c.now ? 'включён' : 'выключен', 'tumbler');
    });
  });
  if (STATE.service && STATE.service.runs) {
    STATE.service.runs.forEach(function (r) {
      push(r.ts ? Date.parse(r.ts) : null, 'прогон ' + (r.serviceName || r.service) + ' для ' + (r.clientName || r.client), '—', r.statusLabel + (r.artifact ? ' · ' + r.artifact.split(/[\\/]/).pop() : ''), 'run');
    });
  }
  events = events.filter(function (e) { return e.at; }).sort(function (a, b) { return b.at - a.at; });

  view.appendChild(note(null, 'Единая лента: переключения тумблеров восстанавливаются по копиям .bak-*, прогоны берутся из registry/runs.jsonl.'));
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Событий', String(events.length), 'изменений и прогонов', 'accent'));
  k.appendChild(kpi('Копий агентов', String(meta.history && meta.history.backups ? meta.history.backups.agents.count : 0), 'файлов .bak-*', ''));
  k.appendChild(kpi('Копий источников', String(meta.history && meta.history.backups ? meta.history.backups.sources.count : 0), 'файлов .bak-*', ''));
  k.appendChild(kpi('Прогонов', String(STATE.service ? STATE.service.counts.runs : 0), 'registry/runs.jsonl', ''));
  view.appendChild(k);

  var s = section('Лента изменений', 'свежие сверху');
  var c = card();
  if (events.length === 0) c.appendChild(el('div', 'muted', 'Пока пусто: журнал наполнится после первых правок и прогонов.'));
  else rowsTable(c, [['Когда'], ['Что'], ['Было'], ['Стало']], events.slice(0, 60).map(function (e) {
    return [fmtDateTime(e.at) + ' (' + fmtAgo(e.at) + ')', e.what, e.was, e.now];
  }));
  s.appendChild(c);
  view.appendChild(s);
};

/* ---------- Рабочие пространства ---------- */
VIEWS.workspaces = function (view) {
  var c = card('Личное');
  c.appendChild(el('div', 'small muted', 'Основное пространство: агенты, проекты, источники и настройки этой машины.'));
  c.appendChild(el('div', 'agent-meta')).appendChild(badge('текущее', 'ok'));
  view.appendChild(c);
  var c2 = card('Создать второе пространство');
  c2.appendChild(el('div', 'small muted', 'Например «Студия» — отдельный набор клиентов и услуг. Каркас сервиса появится на следующем этапе.'));
  var row = el('div', 'setting-row');
  var inp = el('input'); inp.type = 'text'; inp.placeholder = 'Название пространства'; inp.style.minWidth = '240px';
  row.appendChild(inp);
  var b = el('button', 'btn small primary', 'Создать');
  b.title = 'Заглушка: пространства появятся вместе с каркасом сервиса';
  b.addEventListener('click', function () { toast('Создание пространств появится вместе с каркасом сервиса.', 'bad'); });
  row.appendChild(b);
  c2.appendChild(row);
  view.appendChild(c2);
};

/* ---------- Команда, Безопасность, Обучение, Поддержка ---------- */
VIEWS.team = function (view) {
  view.appendChild(placeholderCard('Команда и доступы', 'Роли и приглашения появятся, когда сервис выйдет за пределы одного человека.',
    ['Владелец — полный доступ (сейчас это вы)', 'Помощник — видит клиентов и очередь, но не меняет настройки', 'Приглашения по ссылке — позже']));
  var c = card('Роли');
  rowsTable(c, [['Роль'], ['Что может'], ['Кто']], [
    ['Владелец', 'Всё: настройки, деньги, доступы, агенты', 'Артём'],
    ['Помощник', 'Клиенты, очередь, отчёты; без настроек и оплат', 'пока никто'],
    ['Наблюдатель', 'Только просмотр', 'пока никто']
  ]);
  view.appendChild(c);
};

VIEWS.security = function (view) {
  view.appendChild(placeholderCard('Безопасность', 'Раздел в подготовке: ключи, журнал входов и ограничения по IP.',
    ['Панель уже закрыта ключом доступа при открытии не с localhost', 'Ключ лежит в dashboard/config/access.key и печатается при запуске', 'Журнал входов и ограничения по IP — позже']));
  var c = card('Что уже работает');
  var ul = el('ul', 'clean');
  ul.appendChild(el('li', null, 'Локально (127.0.0.1) панель открывается без ключа.'));
  ul.appendChild(el('li', null, 'Снаружи нужен ключ: ?key=…, заголовок X-Dashboard-Key или cookie. Без ключа — 401.'));
  ul.appendChild(el('li', null, 'Ключ хранится в dashboard/config/access.key, в интерфейс не выводится.'));
  c.appendChild(ul);
  view.appendChild(c);
};

VIEWS.learning = function (view) {
  var s = section('Обучение', 'короткие гайды');
  [
    ['Что делает каждая услуга', 'Мониторинг конкурентов — недельный снимок цен и акций конкурентов и отчёт с динамикой. Настройка Яндекс Директа — семантика, кампании, объявления. Размещение и аудит на площадках — подготовка объявлений для Циан, Авито и Яндекс Недвижимости.'],
    ['Как читать отчёт', 'Раздел 2 «Главное за неделю» — то, что изменилось сильнее порога. Раздел 4 — изменения цен по лотам. Раздел 5 — акции и промо. Раздел 9 — ограничения: что не удалось собрать.'],
    ['Что такое себестоимость прогона', 'Это расход на модели за один запуск услуги. Панель считает его по токенам и ценам из registry/prices.yaml. Цена клиенту ставится от себестоимости.'],
    ['Почему «цена неизвестна»', 'У модели нет цены в прайсе — её токены посчитаны, а рубли нет. Итоговая сумма помечается звёздочкой.']
  ].forEach(function (x) {
    var c = card(x[0]);
    c.appendChild(el('div', 'small muted', x[1]));
    s.appendChild(c);
  });
  view.appendChild(s);
};

VIEWS.support = function (view) {
  var c = card('Поддержка');
  c.appendChild(el('div', 'small muted', 'В MVP поддержка — это вы сами. Вопрос от клиента приходит как задача.'));
  var ul = el('ul', 'clean');
  ul.appendChild(el('li', null, 'Telegram-канал поддержки: подключается вместе с Telegram-пультом (сейчас выключен).'));
  ul.appendChild(el('li', null, 'Раздел «Вопрос агенту» в кабинете клиента появится вместе с каркасом сервиса.'));
  ul.appendChild(el('li', null, 'База знаний — раздел «Обучение».'));
  c.appendChild(ul);
  view.appendChild(c);
};

/* ---------- Аккаунт и профиль ---------- */
VIEWS.account = function (view) {
  view.appendChild(note(null, 'Аккаунт владельца платформы. Реквизиты нужны для счетов и актов клиентам.'));
  var c = card('Реквизиты самозанятого');
  kv(c, [
    ['Статус', 'самозанятый, налог на профессиональный доход (НПД)'],
    ['ИНН', 'заполните в своём профиле — панель подставит его в счёт и акт'],
    ['ФИО', 'для документов клиенту'],
    ['Чеки НПД', 'формируются в приложении «Мой налог» после оплаты'],
    ['Ставка', '4% с доходов от физлиц, 6% — от юрлиц и ИП']
  ]);
  c.appendChild(el('div', 'hintline', 'Правка реквизитов появится вместе с разделом счетов: сейчас они только показываются.'));
  view.appendChild(c);

  var c2 = card('Документы');
  var ul = el('ul', 'clean');
  ul.appendChild(el('li', null, 'Договор-оферта на услуги — шаблон подготовить перед первым платящим клиентом.'));
  ul.appendChild(el('li', null, 'Политика обработки персональных данных (152-ФЗ) — обязательна до первых платящих клиентов.'));
  ul.appendChild(el('li', null, 'Акт за период — формируется вручную вместе со счётом.'));
  ul.appendChild(el('li', null, 'Согласие на обработку данных для клиента.'));
  c2.appendChild(ul);
  view.appendChild(c2);

  var c3 = card('Тариф платформы');
  c3.appendChild(el('div', 'small muted', 'Личный — локальная панель на этой машине, без внешнего хостинга.'));
  c3.appendChild(el('div', 'agent-meta')).appendChild(badge('личный', 'accent'));
  view.appendChild(c3);
};

VIEWS.profile = function (view) {
  var c = card('Профиль');
  kv(c, [
    ['Имя', 'Артём'],
    ['Роль', 'владелец платформы и оператор'],
    ['Почта', 'заполните в своём профиле'],
    ['Телефон', 'заполните в своём профиле'],
    ['Часовой пояс', 'Europe/Moscow'],
    ['Язык интерфейса', 'русский']
  ]);
  view.appendChild(c);
  var c2 = card('Тема оформления');
  var row = el('div', 'setting-row');
  var dark = el('button', 'btn small' + (currentTheme() === 'dark' ? ' primary' : ''), 'Тёмная');
  var light = el('button', 'btn small' + (currentTheme() === 'light' ? ' primary' : ''), 'Светлая');
  dark.addEventListener('click', function () { applyTheme('dark'); renderSidebar(); renderActive(); });
  light.addEventListener('click', function () { applyTheme('light'); renderSidebar(); renderActive(); });
  row.appendChild(dark); row.appendChild(light);
  c2.appendChild(row);
  c2.appendChild(el('div', 'hintline', 'Тема запоминается в браузере и применяется ко всем разделам.'));
  view.appendChild(c2);
};
