/* Реальные разделы сервиса: клиенты, подписки, услуги, очередь, экономика, качество. */
'use strict';

function svcEdit(kind, id, field, value, ctl, okText) {
  if (ctl && ctl.disabled !== undefined) ctl.disabled = true;
  return fetch('/api/service/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: kind, id: id, field: field, value: value })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (ctl && ctl.disabled !== undefined) ctl.disabled = false;
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return res; }
    toast(res.changed ? ((okText || 'Сохранено') + (res.backup ? ' · копия ' + res.backup : '')) : 'Значение уже такое.');
    return fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); return res; });
  }).catch(function (e) { if (ctl && ctl.disabled !== undefined) ctl.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
}

function svcRun(service, client, ctl, outHost) {
  if (!window.confirm('Запустить услугу «' + service + '» для клиента «' + client + '»?\n\nБудет создан прогон, запись в журнал и файл результата.')) return;
  if (ctl) ctl.disabled = true;
  if (outHost) { clear(outHost); outHost.appendChild(note(null, 'Выполняю прогон…')); }
  fetch('/api/service/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: service, client: client })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (ctl) ctl.disabled = false;
    if (outHost) { clear(outHost); outHost.appendChild(note(res.ok ? 'ok' : 'bad', res.message)); }
    toast(res.message, res.ok ? 'ok' : 'bad');
    return fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
  }).catch(function (e) { if (ctl) ctl.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
}

function statusSelect(kind, id, field, value, options, labels) {
  var sel = el('select');
  options.forEach(function (o) {
    var op = el('option', null, labels ? (labels[o] || o) : o);
    op.value = o;
    if (String(value) === String(o)) op.selected = true;
    sel.appendChild(op);
  });
  sel.title = 'Изменить и записать в реестр (атомарно, с копией .bak-)';
  sel.addEventListener('change', function () { svcEdit(kind, id, field, sel.value, sel); });
  return sel;
}

/* ---------------- КЛИЕНТЫ ---------------- */
VIEWS.clients = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Клиентов', String(d.counts.clients), 'активных: ' + d.counts.active, 'accent'));
  k.appendChild(kpi('Доход в месяц', money(d.economy.revenueRub, true), 'по активным подпискам', 'ok'));
  k.appendChild(kpi('Долг', money(d.economy.debtRub, true), 'счета со статусом «выставлен»', d.economy.debtRub > 0 ? 'warn' : 'ok'));
  k.appendChild(kpi('Подписок', String(d.counts.subscriptions), 'просрочено: ' + d.counts.overdue, d.counts.overdue ? 'bad' : 'ok'));
  view.appendChild(k);

  var s = section('Клиенты', 'источник: registry/clients.yaml');
  var grid = el('div', 'grid cards');
  d.clients.forEach(function (c) {
    var card1 = el('div', 'card agent-card');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', c.name));
    left.appendChild(el('div', 'agent-role', c.contact || 'контакт не заполнен'));
    head.appendChild(left);
    var right = el('div');
    right.appendChild(badge(c.statusLabel, c.status === 'active' ? 'ok' : (c.status === 'lead' ? 'accent' : 'grey')));
    head.appendChild(right);
    card1.appendChild(head);

    var meta = el('div', 'agent-meta');
    meta.appendChild(badge('тариф: ' + (c.plan || '—'), 'purple'));
    meta.appendChild(badge('услуг: ' + c.services.length, 'grey'));
    meta.appendChild(badge('подписок: ' + c.subscriptions, 'grey'));
    if (c.debtRub > 0) meta.appendChild(badge('долг ' + money(c.debtRub, true), 'bad'));
    card1.appendChild(meta);

    var stats = el('div', 'agent-stats');
    function stat(k1, v1, t1) { var x = el('div', 'stat'); x.appendChild(el('div', 'k', k1)); var vv = el('div', 'v', v1); if (t1) vv.title = t1; x.appendChild(vv); return x; }
    stats.appendChild(stat('доход', money(c.mrrRub, true)));
    stats.appendChild(stat('прогонов', String(c.runs)));
    stats.appendChild(stat('след. отчёт', c.nextReport ? fmtDay(c.nextReport) : '—'));
    card1.appendChild(stats);

    var row = el('div', 'setting-row');
    row.appendChild(el('span', 'small muted', 'Статус: '));
    row.appendChild(statusSelect('clients', c.id, 'status', c.status, ['lead', 'active', 'paused', 'churned'], d.labels.clientStatus));
    row.appendChild(el('span', 'small muted', 'Тариф: '));
    row.appendChild(statusSelect('clients', c.id, 'plan', c.plan, ['start', 'business', 'premium']));
    card1.appendChild(row);

    var b = el('button', 'btn small', 'Карточка клиента');
    b.title = 'Подписки, прогоны и счета клиента';
    b.addEventListener('click', function () { showClient(c); });
    card1.appendChild(b);
    grid.appendChild(card1);
  });
  s.appendChild(grid);
  view.appendChild(s);

  var s2 = section('Добавить клиента', 'запись в registry/clients.yaml, атомарно с копией');
  var c2 = card();
  var form = el('div', 'filters');
  var nIn = el('input'); nIn.type = 'text'; nIn.placeholder = 'Название клиента'; nIn.style.minWidth = '220px';
  var ctIn = el('input'); ctIn.type = 'text'; ctIn.placeholder = 'Контакт (имя, телефон)'; ctIn.style.minWidth = '200px';
  var idIn = el('input'); idIn.type = 'text'; idIn.placeholder = 'id (латиница, напр. client-svet2)'; idIn.style.minWidth = '200px';
  var plSel = el('select'); ['start', 'business', 'premium'].forEach(function (p) { var o = el('option', null, p); o.value = p; plSel.appendChild(o); });
  var addBtn = el('button', 'btn primary', 'Добавить клиента');
  addBtn.addEventListener('click', function () {
    if (!window.confirm('Добавить клиента «' + nIn.value + '» в реестр?')) return;
    addBtn.disabled = true;
    fetch('/api/service/add-client', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nIn.value, contact: ctIn.value, id: idIn.value, plan: plSel.value })
    }).then(function (r) { return r.json(); }).then(function (res) {
      addBtn.disabled = false;
      if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
      toast('Клиент добавлен: ' + res.id + (res.backup ? ' · копия ' + res.backup : ''));
      fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
    }).catch(function (e) { addBtn.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
  });
  form.appendChild(nIn); form.appendChild(ctIn); form.appendChild(idIn); form.appendChild(plSel); form.appendChild(addBtn);
  c2.appendChild(form);
  s2.appendChild(c2);
  view.appendChild(s2);
};

function showClient(c) {
  var d = STATE.service;
  openDrawer(c.name, function (dr) {
    kv(dr, [
      ['id', el('code', null, c.id)],
      ['контакт', c.contact],
      ['статус', c.statusLabel],
      ['тариф', c.plan],
      ['подключён', c.since],
      ['доход в месяц', money(c.mrrRub, true)],
      ['долг', money(c.debtRub, true)],
      ['заметка', c.note]
    ]);
    var subs = d.subscriptions.filter(function (s) { return s.client === c.id; });
    dr.appendChild(el('h4', null, 'Подписки (' + subs.length + ')'));
    if (subs.length === 0) dr.appendChild(el('div', 'small muted', 'Подписок нет.'));
    else subs.forEach(function (s) {
      dr.appendChild(el('div', 'small muted', s.serviceName + ' · ' + s.statusLabel + ' · до ' + (s.end || '—') + ' · ' + money(s.priceRub, true) + (s.invoiced ? ' · счёт выставлен' : '')));
    });
    var runs = d.runs.filter(function (r) { return r.client === c.id; });
    dr.appendChild(el('h4', null, 'Прогоны (' + runs.length + ')'));
    if (runs.length === 0) dr.appendChild(el('div', 'small muted', 'Прогонов ещё не было.'));
    else runs.slice(0, 8).forEach(function (r) {
      dr.appendChild(el('div', 'small muted', fmtDateTime(Date.parse(r.ts)) + ' · ' + r.serviceName + ' · ' + r.statusLabel + (r.artifact ? ' · ' + r.artifact.split(/[\\/]/).pop() : '')));
    });
    var inv = d.invoices.filter(function (i) { return i.client === c.id; });
    dr.appendChild(el('h4', null, 'Счета (' + inv.length + ')'));
    if (inv.length === 0) dr.appendChild(el('div', 'small muted', 'Счетов нет.'));
    else inv.forEach(function (i) {
      dr.appendChild(el('div', 'small muted', i.id + ' · ' + i.period + ' · ' + money(i.amountRub, true) + ' · ' + i.statusLabel));
    });
  });
}

/* ---------------- ПОДПИСКИ ---------------- */
VIEWS.subscriptions = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Подписок', String(d.counts.subscriptions), 'активных: ' + d.counts.subsActive, 'accent'));
  k.appendChild(kpi('Просрочено', String(d.counts.overdue), 'нужно связаться с клиентом', d.counts.overdue ? 'bad' : 'ok'));
  k.appendChild(kpi('Истекают за 7 дней', String(d.counts.expiring), 'пора продлевать', d.counts.expiring ? 'warn' : 'ok'));
  k.appendChild(kpi('Не оплачено', String(d.counts.unpaid), 'счетов выставлено', d.counts.unpaid ? 'warn' : 'ok'));
  view.appendChild(k);

  var s = section('Подписки и тарифы', 'источник: registry/subscriptions.yaml');
  var c = card();
  rowsTable(c, [['Клиент'], ['Услуга'], ['Тариф'], ['Цена', 'num'], ['Начало'], ['Окончание'], ['Осталось'], ['Счёт'], ['Статус'], ['Действия']], d.subscriptions.map(function (s2) {
    var act = el('span');
    var ext = el('button', 'btn small', 'Продлить');
    ext.title = 'Продлить на месяц: дата окончания +1 месяц, запись атомарно с копией';
    ext.addEventListener('click', function () {
      if (!window.confirm('Продлить подписку «' + s2.serviceName + '» для ' + s2.clientName + ' на месяц?')) return;
      var end = s2.end ? new Date(s2.end + 'T00:00:00') : new Date();
      end.setMonth(end.getMonth() + 1);
      svcEdit('subscriptions', s2.id, 'end', end.toISOString().slice(0, 10), ext, 'Подписка продлена');
    });
    act.appendChild(ext);
    var inv2 = el('button', 'btn small', 'Выставить счёт');
    inv2.title = 'Создать счёт за текущий период по всем подпискам клиента';
    inv2.addEventListener('click', function () {
      if (!window.confirm('Выставить счёт клиенту «' + s2.clientName + '» за текущий месяц?')) return;
      inv2.disabled = true;
      fetch('/api/service/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: s2.client, period: new Date().toISOString().slice(0, 7) }) })
        .then(function (r) { return r.json(); }).then(function (res) {
          inv2.disabled = false;
          toast(res.ok ? ('Счёт ' + res.id + ' на ' + res.amountRub + ' ₽ создан' + (res.backup ? ' · копия ' + res.backup : '')) : ('Не удалось: ' + res.message), res.ok ? 'ok' : 'bad');
          if (res.ok) fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
        });
    });
    act.appendChild(document.createTextNode(' '));
    act.appendChild(inv2);
    return [s2.clientName, s2.serviceName, s2.plan || '—', money(s2.priceRub, true), s2.start || '—', s2.end || '—',
      s2.daysLeft === null ? '—' : (s2.daysLeft + ' дн.'), s2.invoiced ? 'выставлен' : 'нет',
      statusSelect('subscriptions', s2.id, 'status', s2.status, ['active', 'paused', 'overdue', 'closed'], d.labels.subStatus), act];
  }));
  s.appendChild(c);
  view.appendChild(s);

  var s3 = section('Счета', 'источник: registry/invoices.yaml');
  var c3 = card();
  if (d.invoices.length === 0) c3.appendChild(el('div', 'muted', 'Счетов нет.'));
  else rowsTable(c3, [['Номер'], ['Клиент'], ['Период'], ['Сумма', 'num'], ['Статус'], ['Выставлен']], d.invoices.map(function (i) {
    return [i.id, i.clientName, i.period, money(i.amountRub, true),
      statusSelect('invoices', i.id, 'status', i.status, ['draft', 'issued', 'paid'], d.labels.invoiceStatus), i.issued || '—'];
  }));
  s3.appendChild(c3);
  view.appendChild(s3);
};

/* ---------------- УСЛУГИ ---------------- */
VIEWS.services = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var agents = (STATE.agents && STATE.agents.agents) ? STATE.agents.agents : [];
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Услуг в каталоге', String(d.counts.services), 'включено: ' + d.counts.servicesEnabled, 'accent'));
  k.appendChild(kpi('Доход услуг', money(d.economy.revenueRub, true), 'по активным подпискам', 'ok'));
  k.appendChild(kpi('Средняя маржа', d.economy.marginPct === null ? '—' : fmtPct(d.economy.marginPct), 'от цены клиенту', 'purple'));
  k.appendChild(kpi('Прогонов', String(d.counts.runs), 'успешно: ' + d.counts.runsOk, d.counts.runsFailed ? 'warn' : 'ok'));
  view.appendChild(k);

  var s = section('Каталог услуг', 'услуга = агент + регламент + артефакты + расписание + цена');
  var grid = el('div', 'grid cards');
  d.services.forEach(function (sv) {
    var c = el('div', 'card agent-card');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', sv.name));
    left.appendChild(el('div', 'agent-role', sv.what || ''));
    head.appendChild(left);
    var right = el('div');
    right.style.textAlign = 'right';
    var sw = el('button', 'switch' + (sv.enabled ? ' on' : ''));
    sw.setAttribute('role', 'switch');
    sw.title = sv.enabled ? 'Выключить услугу: запускать её будет нельзя' : 'Включить услугу: разрешить запуск клиентам';
    sw.appendChild(el('span', 'knob'));
    sw.addEventListener('click', function () {
      if (!window.confirm((sv.enabled ? 'Выключить' : 'Включить') + ' услугу «' + sv.name + '»?')) return;
      svcEdit('services', sv.id, 'enabled', !sv.enabled, sw, 'Услуга переключена');
    });
    right.appendChild(sw);
    right.appendChild(el('div', 'small muted', sv.enabled ? 'включена' : 'выключена'));
    head.appendChild(right);
    c.appendChild(head);

    var meta = el('div', 'agent-meta');
    meta.appendChild(badge(sv.statusLabel, sv.status === 'active' ? 'ok' : 'grey'));
    meta.appendChild(badge('подписчиков: ' + sv.subscribers, 'accent'));
    meta.appendChild(badge('прогонов: ' + sv.runs, 'grey'));
    if (sv.runsFailed) meta.appendChild(badge('ошибок: ' + sv.runsFailed, 'bad'));
    c.appendChild(meta);

    var stats = el('div', 'agent-stats');
    function stat(k1, v1, t1) { var x = el('div', 'stat'); x.appendChild(el('div', 'k', k1)); var vv = el('div', 'v', v1); if (t1) vv.title = t1; x.appendChild(vv); return x; }
    stats.appendChild(stat('цена', money(sv.priceRub, true)));
    stats.appendChild(stat('себестоимость', money(sv.costRub, true)));
    stats.appendChild(stat('маржа', money(sv.marginRub, true), sv.marginPct === null ? '' : fmtPct(sv.marginPct) + ' от цены'));
    c.appendChild(stats);

    c.appendChild(el('div', 'small muted', 'Что получает клиент: ' + (sv.artifacts.join(' · ') || '—')));
    var row = el('div', 'setting-row');
    row.appendChild(el('span', 'small muted', 'Цена, ₽: '));
    var pIn = el('input'); pIn.type = 'number'; pIn.value = sv.priceRub; pIn.style.maxWidth = '110px';
    row.appendChild(pIn);
    var pBtn = el('button', 'btn small', 'ок');
    pBtn.addEventListener('click', function () {
      if (!window.confirm('Изменить цену услуги «' + sv.name + '» на ' + pIn.value + ' ₽?')) return;
      svcEdit('services', sv.id, 'price_rub', Number(pIn.value), pBtn, 'Цена изменена');
    });
    row.appendChild(pBtn);
    row.appendChild(el('span', 'small muted', 'Себест., ₽: '));
    var cIn = el('input'); cIn.type = 'number'; cIn.value = sv.costRub; cIn.style.maxWidth = '110px';
    row.appendChild(cIn);
    var cBtn = el('button', 'btn small', 'ок');
    cBtn.addEventListener('click', function () {
      if (!window.confirm('Изменить себестоимость услуги «' + sv.name + '» на ' + cIn.value + ' ₽?')) return;
      svcEdit('services', sv.id, 'cost_rub', Number(cIn.value), cBtn, 'Себестоимость изменена');
    });
    row.appendChild(cBtn);
    c.appendChild(row);

    var row2 = el('div', 'setting-row');
    row2.appendChild(el('span', 'small muted', 'Исполнитель: '));
    var aSel = el('select');
    agents.forEach(function (a) { var o = el('option', null, a.name); o.value = a.id; if (a.id === sv.agent) o.selected = true; aSel.appendChild(o); });
    if (!agents.some(function (a) { return a.id === sv.agent; })) { var o0 = el('option', null, sv.agent || 'не назначен'); o0.value = sv.agent || ''; o0.selected = true; aSel.insertBefore(o0, aSel.firstChild); }
    aSel.addEventListener('change', function () {
      if (!window.confirm('Назначить исполнителем услуги «' + sv.name + '» агента ' + aSel.value + '?')) return;
      svcEdit('services', sv.id, 'agent', aSel.value, aSel, 'Исполнитель назначен');
    });
    row2.appendChild(aSel);
    row2.appendChild(el('span', 'small muted', 'Расписание: '));
    var sIn = el('input'); sIn.type = 'text'; sIn.value = sv.schedule || ''; sIn.style.minWidth = '180px';
    row2.appendChild(sIn);
    var sBtn = el('button', 'btn small', 'ок');
    sBtn.addEventListener('click', function () {
      if (!window.confirm('Изменить расписание услуги «' + sv.name + '» на «' + sIn.value + '»?')) return;
      svcEdit('services', sv.id, 'schedule', sIn.value, sBtn, 'Расписание изменено');
    });
    row2.appendChild(sBtn);
    c.appendChild(row2);

    // запуск услуги клиенту
    var row3 = el('div', 'setting-row');
    row3.appendChild(el('span', 'small muted', 'Запустить клиенту: '));
    var clSel = el('select');
    d.clients.forEach(function (cl) { var o = el('option', null, cl.name); o.value = cl.id; clSel.appendChild(o); });
    row3.appendChild(clSel);
    var runBtn = el('button', 'btn small primary', 'Запустить услугу');
    runBtn.title = 'Создаст прогон, запись в журнал и файл результата';
    var out = el('div');
    runBtn.addEventListener('click', function () { svcRun(sv.id, clSel.value, runBtn, out); });
    row3.appendChild(runBtn);
    c.appendChild(row3);
    c.appendChild(out);
    c.appendChild(el('div', 'hintline', sv.note || ''));
    grid.appendChild(c);
  });
  s.appendChild(grid);
  view.appendChild(s);
};

/* ---------------- ОЧЕРЕДЬ РАБОТ ---------------- */
VIEWS.queue = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Прогонов всего', String(d.counts.runs), 'журнал registry/runs.jsonl', 'accent'));
  k.appendChild(kpi('Успешно', String(d.counts.runsOk), 'отработали без ошибок', 'ok'));
  k.appendChild(kpi('С ошибкой', String(d.counts.runsFailed), 'нужно разобрать', d.counts.runsFailed ? 'bad' : 'ok'));
  k.appendChild(kpi('Результатов', String(d.counts.results), 'готовых работ', 'purple'));
  view.appendChild(k);

  var s1 = section('Запустить услугу клиенту', 'создаёт прогон и запись в журнал');
  var c1 = card();
  var row = el('div', 'setting-row');
  row.appendChild(el('span', 'small muted', 'Услуга: '));
  var svSel = el('select');
  d.services.forEach(function (sv) { var o = el('option', null, sv.name + (sv.enabled ? '' : ' (выключена)')); o.value = sv.id; svSel.appendChild(o); });
  row.appendChild(svSel);
  row.appendChild(el('span', 'small muted', 'Клиент: '));
  var clSel = el('select');
  d.clients.forEach(function (cl) { var o = el('option', null, cl.name); o.value = cl.id; clSel.appendChild(o); });
  row.appendChild(clSel);
  var runBtn = el('button', 'btn primary', 'Запустить');
  var out = el('div');
  runBtn.addEventListener('click', function () { svcRun(svSel.value, clSel.value, runBtn, out); });
  row.appendChild(runBtn);
  c1.appendChild(row);
  c1.appendChild(out);
  s1.appendChild(c1);
  view.appendChild(s1);

  var s2 = section('Журнал прогонов', 'свежие сверху');
  var c2 = card();
  if (d.runs.length === 0) c2.appendChild(el('div', 'muted', 'Прогонов пока нет. Запустите услугу выше — запись появится здесь.'));
  else rowsTable(c2, [['Когда'], ['Услуга'], ['Клиент'], ['Статус'], ['Длительность', 'num'], ['Себест.', 'num'], ['Артефакт'], ['Действия']], d.runs.slice(0, 40).map(function (r) {
    var act = el('span');
    var rep = el('button', 'btn small', 'Повторить');
    rep.title = 'Повторить прогон этой услуги для этого клиента';
    rep.addEventListener('click', function () { svcRun(r.service, r.client, rep, out); });
    act.appendChild(rep);
    return [fmtDateTime(Date.parse(r.ts)), r.serviceName, r.clientName, r.statusLabel,
      r.durationMs === null ? '—' : (Math.round(r.durationMs / 100) / 10) + ' с',
      r.costRub === null ? '—' : money(r.costRub, true),
      r.artifact ? el('code', null, r.artifact.split(/[\\/]/).pop()) : (r.error || '—'), act];
  }));
  s2.appendChild(c2);
  view.appendChild(s2);
};

/* ---------------- ЭКОНОМИКА ---------------- */
VIEWS.economy = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var e = d.economy;
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Доход', money(e.revenueRub, true), 'по активным подпискам', 'ok'));
  k.appendChild(kpi('Себестоимость факта', money(e.actualCostRub, true), 'сумма прогонов из журнала', 'accent'));
  k.appendChild(kpi('Маржа', money(e.marginRub, true), e.marginPct === null ? '' : fmtPct(e.marginPct) + ' от дохода', e.marginRub >= 0 ? 'ok' : 'bad'));
  k.appendChild(kpi('Долг клиентов', money(e.debtRub, true), 'выставленные счета', e.debtRub > 0 ? 'warn' : 'ok'));
  view.appendChild(k);
  view.appendChild(note(null, e.note));

  var s1 = section('Маржа по услугам', 'цена, себестоимость и что остаётся');
  var c1 = card();
  rowsTable(c1, [['Услуга'], ['Цена', 'num'], ['Себест. прогона', 'num'], ['Маржа', 'num'], ['Маржа, %', 'num'], ['Подписчиков', 'num'], ['Доход', 'num'], ['Прогонов', 'num'], ['Себест. факта', 'num']], e.byService.map(function (s) {
    return [s.name, money(s.priceRub, true), money(s.costRub, true), money(s.marginRub, true),
      s.marginPct === null ? '—' : fmtPct(s.marginPct), String(s.subscribers), money(s.mrrRub, true), String(s.runs), money(s.actualCostRub, true)];
  }));
  s1.appendChild(c1);
  view.appendChild(s1);

  var s2 = section('Маржа по клиентам', 'сколько приносит каждый клиент');
  var c2 = card();
  rowsTable(c2, [['Клиент'], ['План', 'num'], ['Доход', 'num'], ['Расход', 'num'], ['Маржа', 'num'], ['Маржа, %', 'num'], ['Прогонов', 'num'], ['Долг', 'num']], e.byClient.map(function (c) {
    return [c.name, c.plan || '—', money(c.incomeRub, true), money(c.costRub, true), money(c.marginRub, true),
      c.marginPct === null ? '—' : fmtPct(c.marginPct), String(c.runs), money(c.debtRub, true)];
  }));
  s2.appendChild(c2);
  view.appendChild(s2);

  var s3 = section('Динамика по неделям', 'по журналу прогонов');
  var c3 = card();
  var byWeek = {};
  d.runs.forEach(function (r) {
    if (!r.ts) return;
    var dt = new Date(Date.parse(r.ts));
    var day = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    var ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    var wk = dt.getUTCFullYear() + '-W' + String(Math.ceil(((dt - ys) / 86400000 + 1) / 7)).padStart(2, '0');
    if (!byWeek[wk]) byWeek[wk] = { week: wk, runs: 0, cost: 0, ok: 0 };
    byWeek[wk].runs++;
    byWeek[wk].cost += r.costRub || 0;
    if (r.status === 'ok') byWeek[wk].ok++;
  });
  var weeks = Object.keys(byWeek).sort().map(function (k2) { return byWeek[k2]; });
  if (weeks.length === 0) c3.appendChild(el('div', 'muted', 'Прогонов пока нет — динамика появится после первых запусков.'));
  else rowsTable(c3, [['Неделя'], ['Прогонов', 'num'], ['Успешно', 'num'], ['Себестоимость', 'num']], weeks.map(function (w) {
    return [w.week, String(w.runs), String(w.ok), money(w.cost, true)];
  }));
  s3.appendChild(c3);
  view.appendChild(s3);

  var s4 = section('Расход панели и цены моделей', 'честно про неизвестные цены');
  var c4 = card();
  var u = STATE.usage;
  c4.appendChild(el('div', 'small muted', 'Общий расход по логам DSH: ' + money(u.totals.rub, u.totals.rubComplete) + '. Доля кэша: ' + fmtPct(u.cache.share) + '.'));
  if (u.unknownPriceModels.length) c4.appendChild(note('warn', 'Без цены в прайсе: ' + u.unknownPriceModels.join(', ') + ' — их токены посчитаны, рубли нет. Итоговый расход занижен.'));
  else c4.appendChild(note('ok', 'У всех использованных моделей есть цена.'));
  s4.appendChild(c4);
  view.appendChild(s4);
};

/* ---------------- КАЧЕСТВО ---------------- */
VIEWS.quality = function (view) {
  var d = STATE.service;
  if (!d) { view.appendChild(note('bad', 'Нет данных сервиса.')); return; }
  var runs = d.runs;
  var ok = runs.filter(function (r) { return r.status === 'ok'; }).length;
  var failed = runs.filter(function (r) { return r.status === 'failed'; }).length;
  var avg = runs.length ? Math.round(runs.reduce(function (a, r) { return a + (r.durationMs || 0); }, 0) / runs.length) : null;
  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Доля успешных', runs.length ? fmtPct(ok / runs.length) : '—', 'успешно ' + ok + ' из ' + runs.length, failed ? 'warn' : 'ok'));
  k.appendChild(kpi('Упавших прогонов', String(failed), 'записаны в журнал с причиной', failed ? 'bad' : 'ok'));
  k.appendChild(kpi('Среднее время', avg === null ? '—' : (Math.round(avg / 100) / 10) + ' с', 'на один прогон', 'accent'));
  k.appendChild(kpi('Результатов без отправки', String(d.counts.resultsPending), 'готово, но клиенту не ушло', d.counts.resultsPending ? 'warn' : 'ok'));
  view.appendChild(k);

  var s1 = section('Сбои', 'что упало и почему');
  var c1 = card();
  if (failed === 0) c1.appendChild(note('ok', 'Сбоев не было.'));
  else rowsTable(c1, [['Когда'], ['Услуга'], ['Клиент'], ['Причина']], runs.filter(function (r) { return r.status === 'failed'; }).map(function (r) {
    return [fmtDateTime(Date.parse(r.ts)), r.serviceName, r.clientName, r.error || 'причина не записана'];
  }));
  s1.appendChild(c1);
  view.appendChild(s1);

  var s2 = section('Сроки', 'давность последнего прогона по услуге');
  var c2 = card();
  rowsTable(c2, [['Услуга'], ['Прогонов', 'num'], ['Последний прогон'], ['Успешных', 'num'], ['Сбоев', 'num']], d.services.map(function (sv) {
    var mine = runs.filter(function (r) { return r.service === sv.id; });
    return [sv.name, String(mine.length), sv.lastRun ? fmtAgo(Date.parse(sv.lastRun)) : 'не запускалась', String(sv.runs - sv.runsFailed), String(sv.runsFailed)];
  }));
  s2.appendChild(c2);
  view.appendChild(s2);
};

/* ---------------- КОМАНДА И ДОСТУПЫ ---------------- */
VIEWS.team = function (view) {
  var d = STATE.service;
  view.appendChild(note('warn', 'Роли и приглашения появятся, когда сервис выйдет за пределы одного человека. Пока здесь реально работает только назначение исполнителя услуги.'));
  var c = card('Роли');
  rowsTable(c, [['Роль'], ['Что может'], ['Кто']], [
    ['Владелец', 'Всё: настройки, деньги, доступы, агенты', 'Артём'],
    ['Помощник', 'Клиенты, очередь, отчёты; без настроек и оплат', 'пока никто'],
    ['Наблюдатель', 'Только просмотр', 'пока никто']
  ]);
  view.appendChild(c);

  if (d) {
    var s = section('Исполнители услуг', 'какой агент отвечает за услугу');
    var c2 = card();
    var agents = (STATE.agents && STATE.agents.agents) ? STATE.agents.agents : [];
    rowsTable(c2, [['Услуга'], ['Исполнитель'], ['Расписание'], ['Статус агента']], d.services.map(function (sv) {
      var w = el('span');
      var sel = el('select');
      agents.forEach(function (a) { var o = el('option', null, a.name); o.value = a.id; if (a.id === sv.agent) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () {
        if (!window.confirm('Назначить исполнителем услуги «' + sv.name + '» агента ' + sel.value + '?')) return;
        svcEdit('services', sv.id, 'agent', sel.value, sel, 'Исполнитель назначен');
      });
      w.appendChild(sel);
      var ag = agents.filter(function (a) { return a.id === sv.agent; })[0];
      return [sv.name, w, sv.schedule || '—', ag ? (ag.enabled ? 'включён' : 'выключен') : 'агент не найден'];
    }));
    s.appendChild(c2);
    view.appendChild(s);
  }
};
