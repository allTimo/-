/* Раздел «Реклама и кэшбэк»: бюджеты каналов и вознаграждение за ведение. */
'use strict';

var ADS_IMPORT_TEXT = '';

function adsAct(payload, ctl, okText) {
  if (ctl && ctl.disabled !== undefined) ctl.disabled = true;
  return fetch('/api/ads/act', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (ctl && ctl.disabled !== undefined) ctl.disabled = false;
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return res; }
    toast((okText || 'Готово') + (res.backup ? ' · копия ' + res.backup : '') + (res.amountRub !== undefined ? ' — ' + res.formula : ''));
    return fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); return res; });
  }).catch(function (e) { if (ctl && ctl.disabled !== undefined) ctl.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
}

function adsSpark(host, timeline, channels) {
  if (!timeline.length) { emptyNote(host, 'расходов пока нет'); return; }
  var w = 900, h = 150, padB = 22;
  var svg = sEl('svg', { viewBox: '0 0 ' + w + ' ' + h, class: 'chart-svg' });
  svg.style.height = h + 'px';
  var max = 1;
  timeline.forEach(function (t) { max = Math.max(max, t.total); });
  var groupW = (w - 20) / timeline.length;
  var colors = ['#7553ff', '#4fc1ff', '#05df72', '#ffb020', '#f14c4c'];
  channels.forEach(function (ch, ci) {
    timeline.forEach(function (t, i) {
      var v = t[ch.id] || 0;
      if (!v) return;
      var bh = Math.max(1, (v / max) * (h - padB - 8));
      svg.appendChild(sEl('rect', { x: 10 + i * groupW + ci * Math.min(12, groupW / 6), y: h - padB - bh, width: Math.max(3, Math.min(10, groupW / 6) - 1), height: bh, fill: colors[ci % colors.length], rx: 2 }));
    });
  });
  var t2 = sEl('text', { x: 10, y: h - 6, fill: 'var(--muted-2)', 'font-size': 11 });
  t2.textContent = timeline[0].date + ' → ' + timeline[timeline.length - 1].date + ' · максимум за день ' + niceNum(max) + ' ₽';
  svg.appendChild(t2);
  host.appendChild(svg);
  var ul = el('ul', 'clean');
  channels.forEach(function (ch, ci) {
    var li = el('li');
    var d = el('span', 'legend-dot');
    d.style.background = colors[ci % colors.length];
    li.appendChild(d);
    li.appendChild(document.createTextNode(ch.name));
    ul.appendChild(li);
  });
  host.appendChild(ul);
}

VIEWS.ads = function (view) {
  var a = STATE.ads;
  if (!a) { view.appendChild(note('bad', 'Нет данных раздела. Пересоберите: node marketing-agents/dashboard/collector/collect.mjs')); return; }
  var t = a.totals;

  // ---------- ЕДИНЫЙ КОШЕЛЁК КЛИЕНТА (модель click.ru) ----------
  var w = a.wallet;
  var sw = section('Единый кошелёк', 'пополнение → расход по площадкам → возврат → кэшбэк — всё в одном месте');
  var swc = card();
  swc.appendChild(note('ok', 'УТП: ' + a.utp.text + '. ' + a.utp.detail));
  var wk = el('div', 'grid kpi');
  wk.appendChild(kpi('Пополнено', money(w.topupRub, true), 'деньги клиентов на платформе', 'accent'));
  wk.appendChild(kpi('Израсходовано', money(w.spendRub, true), 'по всем площадкам', ''));
  wk.appendChild(kpi('Возврат от площадок', money(w.returnRub, true), 'агентское вознаграждение — ФАКТ', 'ok'));
  wk.appendChild(kpi('Кэшбэк операторам', money(w.cashbackRub, true), 'платится ИЗ ВОЗВРАТА', 'purple'));
  wk.appendChild(kpi('Комиссия платформы', money(w.commissionRub, true), 'независимый источник дохода', 'ok'));
  wk.appendChild(kpi('Маржа платформы', money(w.marginRub, true), 'возврат − кэшбэк + комиссия', w.marginRub >= 0 ? 'ok' : 'bad'));
  swc.appendChild(wk);
  swc.appendChild(el('div', 'hintline', 'Остаток кошелька: ' + money(w.balanceRub, true) + ' = пополнено ' + money(w.topupRub, true) + ' − израсходовано ' + money(w.spendRub, true) + '. Кэшбэк оператору считается ОТ ВОЗВРАТА площадки, а не от оборота напрямую: если возврата нет, платить кэшбэк нечем.'));
  sw.appendChild(swc);
  view.appendChild(sw);

  // ---------- ПРЕДОХРАНИТЕЛЬ ОТ УБЫТКА ----------
  if (a.risk && a.risk.lossClients > 0) {
    var sr = section('ПРЕДОХРАНИТЕЛЬ ОТ УБЫТКА', 'сработал на ' + a.risk.lossClients + ' клиенте — всего ' + money(a.risk.lossRub, true));
    var src = card();
    src.appendChild(note('bad', 'ВНИМАНИЕ: на части клиентов кэшбэк оператору НЕ ПОКРЫТ возвратом площадки. Платформа платит из своего кармана. Общий убыток: ' + money(a.risk.lossRub, true) + '.'));
    rowsTable(src, [['Клиент'], ['Оборот', 'num'], ['Ставка оператора %', 'num'], ['Кэшбэк к выплате', 'num'], ['Возврат площадки', 'num'], ['УБЫТОК', 'num']], a.risk.rows.map(function (r) {
      var loss = el('span', null, '−' + money(r.lossRub, true));
      loss.style.color = 'var(--bad)';
      loss.style.fontWeight = '700';
      return [r.name, money(r.spend, true), String(r.operatorRatePct), money(r.cashback, true), money(r.returnRub, true), loss];
    }));
    src.appendChild(el('div', 'hintline', 'Расчёт: оборот × ставка оператора = кэшбэк к выплате; кэшбэк − возврат = убыток. Что делать: снизить ставку оператору до уровня возврата или заключить партнёрский договор с площадкой.'));
    sr.appendChild(src);
    view.appendChild(sr);
  } else {
    view.appendChild(note('ok', 'Предохранитель от убытка: все клиенты покрыты возвратом площадок.'));
  }

  // ---------- ВОЗВРАТЫ, ОТСРОЧКА ----------
  var sret = section('Возвраты от площадок', 'факт: сколько площадка реально вернула. Кэшбэк считается отсюда');
  var cret = card();
  rowsTable(cret, [['Канал'], ['Ставка возврата, %', 'num'], ['Договор'], ['Возврат (факт)', 'num'], ['Ожидается', 'num']], a.channels.map(function (c) {
    var row = a.channelRows.filter(function (x) { return x.id === c.id; })[0] || {};
    var ag = el('span');
    ag.appendChild(badge(c.agreement ? 'есть' : 'нет', c.agreement ? 'ok' : 'bad'));
    if (!c.agreement) ag.title = 'Партнёрского договора нет: возврат 0%, кэшбэк платить нечем';
    return [c.name, String(c.returnPct), ag, money(a.returns.filter(function (r) { return r.channel === c.id; }).reduce(function (x, r) { return x + r.amountRub; }, 0), true), money((row.spend || 0) * c.returnPct / 100, true)];
  }));
  sret.appendChild(cret);
  view.appendChild(sret);

  var sdef = section('Отсрочка платежа', 'заготовка: только учёт дней и напоминание, финансирование не реализовано');
  var cdef = card();
  if (!a.deferred || !a.deferred.length) cdef.appendChild(el('div', 'muted', 'Отсрочек нет.'));
  else rowsTable(cdef, [['Клиент'], ['Дней', 'num'], ['С какой даты'], ['Срок оплаты'], ['Осталось', 'num'], ['Напоминание']], a.deferred.map(function (d) {
    var cl = a.clientRows.filter(function (c) { return c.id === d.client; })[0];
    var st = el('span');
    st.appendChild(badge(d.overdue ? 'просрочено' : (d.daysLeft <= 14 ? 'скоро срок' : 'в срок'), d.overdue ? 'bad' : (d.daysLeft <= 14 ? 'warn' : 'ok')));
    return [cl ? cl.name : d.client, String(d.days), d.since || '—', d.dueDate || '—', d.daysLeft === null ? '—' : String(d.daysLeft), st];
  }));
  sdef.appendChild(cdef);
  view.appendChild(sdef);

  view.appendChild(note('warn', 'ЮРИДИЧЕСКИ ВАЖНО. Работают два режима. «Клиент платит площадке сам» — мы получаем вознаграждение за услугу ведения: это чистая услуга, НПД подходит. «Бюджет через сервис» — деньги клиента проходят через нас, и мы оплачиваем площадки: это агентская схема, и по 422-ФЗ НПД к ней НЕ применяется. Для агентской схемы нужно ИП или ООО; при НПД выставляем вознаграждение за ведение.'));

  // ---------- ТРЁХУРОВНЕВАЯ МОДЕЛЬ: платформа -> оператор -> клиент ----------
  var p = a.platform;
  var sp = section('Платформа: оборот, комиссия, кэшбэк операторов', 'ПЛАТФОРМА (ИП) → ОПЕРАТОР (маркетолог/агентство) → КЛИЕНТ ОПЕРАТОРА (рекламодатель)');
  var spc = card();
  spc.appendChild(note('warn', 'ОБОРОТ — НЕ ДОХОД ПЛАТФОРМЫ. Оборот — это чужие деньги клиентов, прошедшие через платформу. Доход платформы — только КОМИССИЯ ЗА СЕРВИС. Налоговая база считается с комиссии, а не с оборота. Не перепутайте: если показать оборот как доход, получите налоговую ошибку.'));
  spc.appendChild(note(p.ipoRegistered ? 'ok' : 'bad', p.legalNote));
  var pk = el('div', 'grid kpi');
  pk.appendChild(kpi('Оборот (не доход)', money(p.turnoverRub, true), 'чужие деньги клиентов', 'accent'));
  pk.appendChild(kpi('Комиссия платформы — доход', money(p.commissionRub, true), 'оборот × ' + p.commissionPct + '%', 'ok'));
  pk.appendChild(kpi('Кэшбэк операторов', money(p.operatorsCashbackRub, true), 'их вознаграждение', 'purple'));
  pk.appendChild(kpi('Маржа платформы', money(p.marginRub, true), 'комиссия − кэшбэк' + (p.marginPct === null ? '' : ' · ' + fmtPct(p.marginPct)), p.marginRub >= 0 ? 'ok' : 'bad'));
  pk.appendChild(kpi('К выплате операторам', money(p.operatorsDueRub, true), 'начислено − выплачено', ''));
  pk.appendChild(kpi('Операторов / клиентов', String(a.counts.operators) + ' / ' + a.counts.clients, 'по договорам', ''));
  spc.appendChild(pk);
  spc.appendChild(el('div', 'hintline', 'Формула комиссии: ' + p.formula + '. Проверка: комиссия + кэшбэк (' + money(p.commissionRub + p.operatorsCashbackRub, true) + ') ≤ оборот (' + money(p.turnoverRub, true) + ') — ' + (p.commissionRub + p.operatorsCashbackRub <= p.turnoverRub ? 'да' : 'НАРУШЕНО')));
  spc.appendChild(el('div', 'hintline', 'Выгрузки: ' + ''));
  var prow = el('div', 'filters');
  [['platform', 'Отчёт платформы'], ['operators', 'Отчёт по операторам'], ['channels', 'Отчёт по каналам'], ['clients', 'Отчёт клиенту']].forEach(function (x) {
    var b = el('button', 'btn small', x[1]);
    b.appendChild(document.createTextNode(' (CSV)'));
    b.addEventListener('click', function () { window.open('/api/ads/export?what=' + x[0], '_blank'); });
    prow.appendChild(b);
  });
  var ipoBtn = el('button', 'btn small' + (p.ipoRegistered ? ' primary' : ''), p.ipoRegistered ? 'ИП оформлен — снять отметку' : 'Отметить, что ИП оформлен');
  ipoBtn.title = 'Переключает предупреждение о 422-ФЗ: пока ИП не оформлен, агентский режим использовать нельзя';
  ipoBtn.addEventListener('click', function () {
    if (!window.confirm(p.ipoRegistered ? 'Снять отметку об ИП?' : 'Отметить, что ИП оформлен? После этого предупреждение по 422-ФЗ исчезнет.')) return;
    adsAct({ kind: 'ipo', value: !p.ipoRegistered }, ipoBtn, 'Статус ИП обновлён');
  });
  prow.appendChild(ipoBtn);
  spc.appendChild(prow);
  sp.appendChild(spc);
  view.appendChild(sp);

  var k = el('div', 'grid kpi');
  k.appendChild(kpi('Прогнано бюджета', money(t.spendRub, true), 'пополнено ' + money(t.topupRub, true), 'accent'));
  k.appendChild(kpi('Вознаграждение (кэшбэк)', money(t.cashbackRub, true), 'средняя ставка ' + (t.avgRatePct === null ? '—' : t.avgRatePct + '%'), 'ok'));
  k.appendChild(kpi('Выплачено клиентам', money(t.paidRub, true), 'к выплате ' + money(t.dueRub, true), ''));
  k.appendChild(kpi('Остаток бюджетов', money(t.balanceRub, true), 'по всем клиентам', t.lowBalance ? 'warn' : 'ok'));
  k.appendChild(kpi('Каналов', String(t.channels), 'клиентов: ' + t.clients, ''));
  k.appendChild(kpi('Низкий остаток', String(t.lowBalance), 'порог ' + money(a.defaults.lowBalanceThresholdRub, true), t.lowBalance ? 'bad' : 'ok'));
  view.appendChild(k);

  if (a.alerts.length) {
    var sa = section('Требует внимания', a.counts.alerts + ' записей');
    a.alerts.forEach(function (al) {
      var c = el('div', 'card alert ' + al.level);
      c.appendChild(el('div', 'agent-name', al.title));
      c.appendChild(el('div', 'small muted', 'Что случилось: ' + al.what));
      c.appendChild(el('div', 'small muted', 'Что это значит: ' + al.meaning));
      c.appendChild(el('div', 'hintline', 'Что делать: ' + al.action));
      sa.appendChild(c);
    });
    view.appendChild(sa);
  }

  // --- действия ---
  var s1 = section('Действия', 'каждое пишет в реестр атомарно, с копией .bak-<timestamp>');
  var c1 = card();
  var clients = a.clientRows;
  var channels = a.channels.filter(function (c) { return c.status === 'active'; });

  function clientSelect() {
    var s = el('select');
    clients.forEach(function (c) { var o = el('option', null, c.name); o.value = c.id; s.appendChild(o); });
    return s;
  }
  function channelSelect() {
    var s = el('select');
    channels.forEach(function (c) { var o = el('option', null, c.name + ' (' + c.sourceLabel + ')'); o.value = c.id; s.appendChild(o); });
    return s;
  }
  function dateInput() {
    var i = el('input'); i.type = 'date'; i.value = a.today; i.style.maxWidth = '160px'; return i;
  }
  function amountInput(ph) {
    var i = el('input'); i.type = 'number'; i.placeholder = ph || 'сумма, ₽'; i.style.maxWidth = '150px'; return i;
  }

  // пополнение и расход
  var row1 = el('div', 'setting-row');
  row1.appendChild(el('span', 'small muted', 'Пополнение:'));
  var topClient = clientSelect(), topCh = channelSelect(), topDate = dateInput(), topAmt = amountInput();
  var topBtn = el('button', 'btn small primary', 'Зафиксировать пополнение');
  topBtn.addEventListener('click', function () {
    if (!window.confirm('Зафиксировать пополнение ' + topAmt.value + ' ₽ для клиента ' + topClient.options[topClient.selectedIndex].text + '?')) return;
    adsAct({ kind: 'topup', client: topClient.value, channel: topCh.value, date: topDate.value, amount: Number(topAmt.value) }, topBtn, 'Пополнение записано');
  });
  [topClient, topCh, topDate, topAmt, topBtn].forEach(function (x) { row1.appendChild(x); });
  c1.appendChild(row1);

  var row2 = el('div', 'setting-row');
  row2.appendChild(el('span', 'small muted', 'Расход:'));
  var spClient = clientSelect(), spCh = channelSelect(), spDate = dateInput(), spAmt = amountInput();
  var spPeriod = el('input'); spPeriod.type = 'text'; spPeriod.placeholder = 'период, напр. 01.10–07.10'; spPeriod.style.minWidth = '170px';
  var spBtn = el('button', 'btn small primary', 'Зафиксировать расход');
  spBtn.addEventListener('click', function () {
    if (!window.confirm('Зафиксировать расход ' + spAmt.value + ' ₽?')) return;
    adsAct({ kind: 'spend', client: spClient.value, channel: spCh.value, date: spDate.value, amount: Number(spAmt.value), period: spPeriod.value }, spBtn, 'Расход записан');
  });
  [spClient, spCh, spDate, spAmt, spPeriod, spBtn].forEach(function (x) { row2.appendChild(x); });
  c1.appendChild(row2);
  c1.appendChild(el('div', 'hintline', 'Расходы по каналам с пометкой «вручную / импорт выгрузки» заводятся этим же способом или импортом CSV ниже.'));

  // импорт CSV
  var row3 = el('div', 'setting-row');
  row3.appendChild(el('span', 'small muted', 'Импорт выгрузки (CSV):'));
  var imp = el('textarea');
  imp.placeholder = 'client;channel;date;amount;period — по строке на расход';
  imp.rows = 3; imp.style.minWidth = '420px'; imp.style.fontFamily = 'var(--mono)'; imp.style.fontSize = '12px';
  var impBtn = el('button', 'btn small', 'Разобрать и записать');
  impBtn.title = 'Формат: client;channel;date;amount;period. Записи добавляются по одной, с копией файла';
  impBtn.addEventListener('click', function () {
    var lines = String(imp.value || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) { toast('Пусто: вставьте строки выгрузки', 'bad'); return; }
    if (!window.confirm('Импортировать ' + lines.length + ' строк(и) расхода?')) return;
    var bad = [];
    lines.forEach(function (l) {
      var p = l.split(';').map(function (x) { return x.trim(); });
      if (p.length < 4) { bad.push(l); return; }
      var payload = { kind: 'spend', client: p[0], channel: p[1], date: p[2], amount: Number(p[3]), period: p[4] || p[2] };
      fetch('/api/ads/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(function () { bad.push(l); });
    });
    setTimeout(function () {
      toast('Импорт отправлен: ' + (lines.length - bad.length) + ' строк, не разобрано ' + bad.length);
      fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { STATE = j; renderSidebar(); renderActive(); });
    }, 900);
  });
  row3.appendChild(imp); row3.appendChild(impBtn);
  c1.appendChild(row3);

  // начисление кэшбэка с формулой
  var row4 = el('div', 'setting-row');
  row4.appendChild(el('span', 'small muted', 'Начислить кэшбэк:'));
  var acClient = clientSelect(), acCh = channelSelect();
  var acBase = amountInput('база, ₽');
  var acRate = el('input'); acRate.type = 'number'; acRate.placeholder = 'ставка, %'; acRate.style.maxWidth = '110px'; acRate.value = a.defaults.ratePct;
  var acPeriod = el('input'); acPeriod.type = 'text'; acPeriod.placeholder = 'период 2026-10'; acPeriod.style.maxWidth = '130px'; acPeriod.value = a.today.slice(0, 7);
  var acCalc = el('span', 'small muted', '');
  function recalc() {
    var base = Number(acBase.value) || 0, rate = Number(acRate.value) || 0;
    acCalc.textContent = 'формула: ' + base + ' × ' + rate + '% = ' + (Math.round(base * rate / 100 * 100) / 100) + ' ₽';
  }
  acBase.addEventListener('input', recalc); acRate.addEventListener('input', recalc); recalc();
  var acBtn = el('button', 'btn small primary', 'Начислить');
  acBtn.addEventListener('click', function () {
    var f = acCalc.textContent;
    if (!window.confirm('Начислить кэшбэк?\n\n' + f)) return;
    adsAct({ kind: 'accrue', client: acClient.value, channel: acCh.value, base_rub: Number(acBase.value), rate_pct: Number(acRate.value), period: acPeriod.value }, acBtn, 'Кэшбэк начислен');
  });
  [acClient, acCh, acBase, acRate, acPeriod, acCalc, acBtn].forEach(function (x) { row4.appendChild(x); });
  c1.appendChild(row4);

  // выплата
  var row5 = el('div', 'setting-row');
  row5.appendChild(el('span', 'small muted', 'Выплата кэшбэка:'));
  var paClient = clientSelect(), paDate = dateInput(), paAmt = amountInput();
  var paMethod = el('select'); ['СБП', 'счёт для юрлиц', 'карта'].forEach(function (m) { var o = el('option', null, m); o.value = m; paMethod.appendChild(o); });
  var paBtn = el('button', 'btn small primary', 'Зафиксировать выплату');
  paBtn.addEventListener('click', function () {
    if (!window.confirm('Зафиксировать выплату ' + paAmt.value + ' ₽?')) return;
    adsAct({ kind: 'payout', client: paClient.value, date: paDate.value, amount: Number(paAmt.value), method: paMethod.value }, paBtn, 'Выплата записана');
  });
  [paClient, paDate, paAmt, paMethod, paBtn].forEach(function (x) { row5.appendChild(x); });
  c1.appendChild(row5);

  // выгрузки
  var row6 = el('div', 'setting-row');
  row6.appendChild(el('span', 'small muted', 'Выгрузка CSV:'));
  [['spends', 'расходы'], ['channels', 'по каналам'], ['clients', 'по клиентам'], ['accruals', 'начисления']].forEach(function (x) {
    var b = el('button', 'btn small', x[1]);
    b.addEventListener('click', function () { window.open('/api/ads/export?what=' + x[0], '_blank'); });
    row6.appendChild(b);
  });
  c1.appendChild(row6);
  s1.appendChild(c1);
  view.appendChild(s1);

  // --- таблица по каналам + мини-график ---
  var s2 = section('По каналам', 'расход, доля, ставка, вознаграждение');
  var c2 = card();
  rowsTable(c2, [['Канал'], ['Расход', 'num'], ['Доля', 'num'], ['Остаток', 'num'], ['Ставка %', 'num'], ['Кэшбэк', 'num'], ['Получение расходов'], ['Клиентов', 'num']], a.channelRows.map(function (c) {
    var note = el('span', 'small muted', c.sourceLabel + (c.urgentNote ? ' · ' + c.urgentNote : '') + (c.fixedRub ? ' · фикс ' + c.fixedRub + ' ₽' : ''));
    return [c.name, money(c.spend, true), fmtPct(c.share), money(c.balance, true), String(c.ratePct), money(c.cashback, true), note, String(c.clients)];
  }));
  c2.appendChild(el('div', 'hintline', 'Сумма расхода по каналам: ' + money(t.spendRub, true) + ' — совпадает с итогом раздела.'));
  var spHost = el('div');
  c2.appendChild(el('h4', null, 'Динамика расхода по каналам'));
  adsSpark(spHost, a.timeline, a.channels);
  c2.appendChild(spHost);
  s2.appendChild(c2);
  view.appendChild(s2);

  // --- таблица ПО ОПЕРАТОРАМ ---
  var sOp = section('По операторам', 'оборот, комиссия платформы, кэшбэк оператора, к выплате');
  var cOp = card();
  rowsTable(cOp, [['Оператор'], ['Ставка %', 'num'], ['Клиентов', 'num'], ['Оборот', 'num'], ['Комиссия платформы', 'num'], ['Кэшбэк оператора', 'num'], ['Выплачено', 'num'], ['К выплате', 'num'], ['Статус'], ['']], a.operatorRows.map(function (o) {
    var st = el('span');
    st.appendChild(badge(o.statusLabel, o.status === 'active' ? 'ok' : 'grey'));
    var acc = el('button', 'btn small', 'Начислить кэшбэк');
    acc.title = 'Формула: оборот × ставка = сумма. Начисление уйдёт оператору';
    acc.addEventListener('click', function () {
      if (!window.confirm('Начислить кэшбэк оператору «' + o.name + '»?\n\nоборот ' + o.turnover + ' ₽ × ' + o.ratePct + '% = ' + (Math.round(o.turnover * o.ratePct) / 100) + ' ₽')) return;
      adsAct({ kind: 'op-accrue', operator: o.id, base_rub: o.turnover, rate_pct: o.ratePct, period: a.today.slice(0, 7) }, acc, 'Кэшбэк оператору начислен');
    });
    var pay = el('button', 'btn small', 'Выплатить');
    pay.disabled = o.due <= 0;
    pay.title = o.due > 0 ? 'Зафиксировать выплату ' + o.due + ' ₽' : 'Начислений к выплате нет';
    pay.addEventListener('click', function () {
      if (!window.confirm('Выплатить оператору «' + o.name + '» ' + o.due + ' ₽?')) return;
      adsAct({ kind: 'op-payout', operator: o.id, amount: o.due, date: a.today, method: 'СБП' }, pay, 'Выплата оператору записана');
    });
    var rt = el('button', 'btn small', 'Ставка');
    rt.title = 'Изменить ставку кэшбэка оператора';
    rt.addEventListener('click', function () {
      var v = window.prompt('Новая ставка кэшбэка для «' + o.name + '», %', String(o.ratePct));
      if (v === null) return;
      adsAct({ kind: 'op-rate', operator: o.id, rate_pct: Number(v) }, rt, 'Ставка оператора изменена');
    });
    var cell = el('span');
    cell.appendChild(acc); cell.appendChild(document.createTextNode(' '));
    cell.appendChild(pay); cell.appendChild(document.createTextNode(' '));
    cell.appendChild(rt);
    var nameCell = el('span');
    nameCell.appendChild(el('div', null, o.name));
    nameCell.appendChild(el('div', 'small muted', o.contract || 'договора нет'));
    var turn = el('span');
    turn.appendChild(el('div', 'mono', money(o.turnover, true)));
    turn.appendChild(el('div', 'small muted', 'оборот — не доход'));
    return [nameCell, String(o.ratePct), String(o.clientsCount), turn, money(o.commission, true), money(o.cashback, true), money(o.paid, true), money(o.due, true), st, cell];
  }));
  if (a.operatorRows.some(function (o) { return !o.hasClients; })) {
    cOp.appendChild(el('div', 'hintline', 'Без клиентов: ' + a.operatorRows.filter(function (o) { return !o.hasClients; }).map(function (o) { return o.name; }).join(', ') + ' — это нормально, пока не подключили.'));
  }
  sOp.appendChild(cOp);
  view.appendChild(sOp);

  var sOpAcc = section('Кэшбэк операторов: начисления и выплаты', 'формула: оборот клиентов оператора × ставка');
  var cOpAcc = card();
  if (!a.operatorAccruals.length) cOpAcc.appendChild(el('div', 'muted', 'Начислений операторам пока нет.'));
  else rowsTable(cOpAcc, [['Оператор'], ['Период'], ['Формула'], ['Сумма', 'num'], ['Статус']], a.operatorAccruals.map(function (x) {
    var f = el('span', 'small muted', x.formula + (x.formulaOk ? '' : ' — НЕ СХОДИТСЯ'));
    if (!x.formulaOk) f.style.color = 'var(--bad)';
    return [x.operatorName, x.period, f, money(x.amountRub, true), x.statusLabel];
  }));
  if (a.operatorPayouts.length) {
    cOpAcc.appendChild(el('h4', null, 'Выплаты операторам'));
    rowsTable(cOpAcc, [['Оператор'], ['Дата'], ['Сумма', 'num'], ['Способ'], ['Статус']], a.operatorPayouts.map(function (x) {
      return [x.operatorName, x.date || '—', money(x.amountRub, true), x.method || '—', x.statusLabel];
    }));
  }
  sOpAcc.appendChild(cOpAcc);
  view.appendChild(sOpAcc);

  // --- таблица по клиентам ---
  var s3 = section('По клиентам', 'бюджет, расход, остаток, вознаграждение, режим');
  var c3 = card();
  rowsTable(c3, [['Клиент'], ['Оператор'], ['Бюджет', 'num'], ['Прогнано', 'num'], ['Остаток', 'num'], ['Комиссия платформы', 'num'], ['Кэшбэк оператору', 'num'], ['Режим'], ['Статус'], ['']], a.clientRows.map(function (c) {
    var modeCell = el('span');
    modeCell.appendChild(badge(c.modeLabel, c.mode === 'client-pays' ? 'ok' : 'warn'));
    if (c.mode === 'through-service') modeCell.title = 'Агентская схема: по 422-ФЗ НПД не применяется, нужно ИП или ООО';
    var st = el('span');
    st.appendChild(badge(c.status, c.status === 'ок' ? 'ok' : (c.status === 'низкий остаток' ? 'warn' : 'grey')));
    var b = el('button', 'btn small', 'Карточка');
    b.addEventListener('click', function () { showAdsClient(a, c); });
    var opCell = el('span');
    opCell.appendChild(el('div', null, c.operatorName || 'НЕ НАЗНАЧЕН'));
    if (!c.operatorId) opCell.appendChild(el('div', 'small muted', 'нужно связать с оператором'));
    return [c.name, opCell, money(c.topup, true), money(c.spend, true), money(c.balance, true), money(c.commissionRub, true), money(c.operatorCashbackRub, true), modeCell, st, b];
  }));
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- кэшбэк: начисления и выплаты ---
  var s4 = section('Кэшбэк: начисления и выплаты', 'формула: база × ставка + фикс');
  var c4 = card();
  if (!a.accruals.length) c4.appendChild(el('div', 'muted', 'Начислений пока нет.'));
  else rowsTable(c4, [['Клиент'], ['Канал'], ['Период'], ['Формула'], ['Сумма', 'num'], ['Статус'], ['Документ']], a.accruals.map(function (x) {
    var ok = el('span', 'small muted', x.formula + (x.formulaOk ? '' : ' — НЕ СХОДИТСЯ, в файле ' + x.amountRub + ' ₽'));
    if (!x.formulaOk) ok.style.color = 'var(--bad)';
    return [x.clientName, x.channelName, x.period, ok, money(x.amountRub, true), x.statusLabel, x.doc || '—'];
  }));
  if (a.accruals.length) c4.appendChild(el('div', 'hintline', 'Проверка формулы пройдена у всех начислений: ' + (a.accruals.every(function (x) { return x.formulaOk; }) ? 'да' : 'НЕТ') + '. Итого начислено ' + money(a.totals.cashbackRub, true) + ', выплачено ' + money(a.totals.paidRub, true) + ', к выплате ' + money(a.totals.dueRub, true) + '.'));
  if (a.payouts.length) {
    c4.appendChild(el('h4', null, 'Выплаты'));
    rowsTable(c4, [['Клиент'], ['Дата'], ['Сумма', 'num'], ['Способ'], ['Статус'], ['Документ']], a.payouts.map(function (p) {
      return [p.clientName, p.date || '—', money(p.amountRub, true), p.method || '—', p.statusLabel, p.doc || '—'];
    }));
  }
  s4.appendChild(c4);
  view.appendChild(s4);

  // --- ставки ---
  var s5 = section('Ставки вознаграждения', 'глобальная, по каналу и по клиенту');
  var c5 = card();
  c5.appendChild(el('div', 'small muted', 'Ставка по умолчанию: ' + a.defaults.ratePct + '% от расхода. Округление: ' + a.defaults.rounding + '. Порог низкого остатка: ' + money(a.defaults.lowBalanceThresholdRub, true) + ' (меняется в dashboard/config).'));
  rowsTable(c5, [['Канал'], ['Ставка по каналу, %', 'num'], ['Фикс, ₽', 'num'], ['Статус'], ['Расход'], ['Кэшбэк']], a.channels.map(function (c) {
    return [c.name, String(c.ratePct), String(c.fixedRub), c.status === 'active' ? 'активен' : 'на паузе', money((a.channelRows.filter(function (x) { return x.id === c.id; })[0] || {}).spend || 0, true), money((a.channelRows.filter(function (x) { return x.id === c.id; })[0] || {}).cashback || 0, true)];
  }));
  if (a.rateOverrides.length) {
    c5.appendChild(el('h4', null, 'Переопределения по клиенту'));
    rowsTable(c5, [['Клиент'], ['Канал'], ['Ставка %', 'num'], ['Фикс, ₽', 'num'], ['С какой даты'], ['Причина']], a.rateOverrides.map(function (r) {
      var cl = a.clientRows.filter(function (c) { return c.id === r.client; })[0];
      return [cl ? cl.name : r.client, r.channel, String(r.ratePct), String(r.fixedRub), r.since || '—', r.reason || '—'];
    }));
  }
  var rowR = el('div', 'setting-row');
  rowR.appendChild(el('span', 'small muted', 'Изменить ставку:'));
  var rClient = el('select');
  var oAll = el('option', null, 'для всех клиентов'); oAll.value = ''; rClient.appendChild(oAll);
  a.clientRows.forEach(function (c) { var o = el('option', null, c.name); o.value = c.id; rClient.appendChild(o); });
  var rCh = channelSelect();
  var rRate = el('input'); rRate.type = 'number'; rRate.placeholder = '%'; rRate.style.maxWidth = '90px';
  var rFixed = el('input'); rFixed.type = 'number'; rFixed.placeholder = 'фикс ₽'; rFixed.style.maxWidth = '110px';
  var rReason = el('input'); rReason.type = 'text'; rReason.placeholder = 'причина'; rReason.style.minWidth = '180px';
  var rBtn = el('button', 'btn small primary', 'Сохранить ставку');
  rBtn.addEventListener('click', function () {
    if (!window.confirm('Сохранить ставку ' + rRate.value + '% для ' + (rClient.value || 'всех клиентов') + ' по каналу ' + rCh.value + '?')) return;
    adsAct({ kind: 'rate', client: rClient.value, channel: rCh.value, rate_pct: Number(rRate.value), fixed_rub: Number(rFixed.value || 0), reason: rReason.value }, rBtn, 'Ставка сохранена');
  });
  [rClient, rCh, rRate, rFixed, rReason, rBtn].forEach(function (x) { rowR.appendChild(x); });
  c5.appendChild(rowR);
  s5.appendChild(c5);
  view.appendChild(s5);

  // --- режимы ---
  var s6 = section('Режим работы с клиентом', 'юридические последствия видны сразу');
  var c6 = card();
  var g6 = el('div', 'grid cards');
  a.clientRows.forEach(function (c) {
    var cc = card(c.name);
    cc.appendChild(el('div', 'small muted', 'Режим: ' + c.modeLabel + (c.throughService ? ' (есть каналы через сервис)' : '')));
    if (c.mode === 'through-service') cc.appendChild(note('warn', 'Агентская схема. По 422-ФЗ НПД не применяется: нужно ИП или ООО. При НПД выставляем вознаграждение за ведение.'));
    else cc.appendChild(note('ok', 'Чистая услуга: клиент платит площадке сам, мы выставляем вознаграждение за ведение. НПД подходит.'));
    var row = el('div', 'filters');
    [['client-pays', 'Клиент платит сам'], ['through-service', 'Бюджет через сервис']].forEach(function (m) {
      var b = el('button', 'btn small' + (c.mode === m[0] ? ' primary' : ''), m[1]);
      b.addEventListener('click', function () {
        if (m[0] === 'through-service' && !window.confirm('Переключить клиента на агентскую схему?\n\nПо 422-ФЗ НПД к ней не применяется: потребуется ИП или ООО.')) return;
        adsAct({ kind: 'mode', client: c.id, mode: m[0], reason: 'изменено из панели' }, b, 'Режим изменён');
      });
      row.appendChild(b);
    });
    cc.appendChild(row);
    g6.appendChild(cc);
  });
  c6.appendChild(g6);
  if (a.modeHistory && a.modeHistory.length) {
    c6.appendChild(el('h4', null, 'История режимов'));
    rowsTable(c6, [['Клиент', 'num'], ['Режим'], ['С какой даты'], ['Причина']], a.modeHistory.map(function (m) {
      var cl = a.clientRows.filter(function (c) { return c.id === m.client; })[0];
      return [cl ? cl.name : m.client, m.mode === 'client-pays' ? 'клиент платит сам' : 'бюджет через сервис', m.since || '—', m.reason || '—'];
    }));
  }
  s6.appendChild(c6);
  view.appendChild(s6);
};

function showAdsClient(a, c) {
  openDrawer(c.name, function (dr) {
    kv(dr, [
      ['Режим', c.modeLabel],
      ['Бюджет (пополнено)', money(c.topup, true)],
      ['Прогнано', money(c.spend, true)],
      ['Остаток', money(c.balance, true)],
      ['Начислено кэшбэка', money(c.cashback, true)],
      ['Выплачено', money(c.paid, true)],
      ['Эффективная ставка', c.effRate === null ? '—' : fmtPct(c.effRate)],
      ['Статус', c.status]
    ]);
    dr.appendChild(el('h4', null, 'По каналам'));
    if (!c.channelList.length) dr.appendChild(el('div', 'small muted', 'Нет каналов.'));
    else c.channelList.forEach(function (x) {
      dr.appendChild(el('div', 'small muted', x.name + ' — прогнано ' + money(x.spend, true) + ' · ' + x.modeLabel));
    });
    dr.appendChild(el('h4', null, 'История пополнений'));
    var tops = a.topups.filter(function (x) { return x.client === c.id; });
    if (!tops.length) dr.appendChild(el('div', 'small muted', 'Пополнений не было.'));
    else tops.forEach(function (x) { dr.appendChild(el('div', 'small muted', x.date + ' · ' + money(x.amountRub, true) + ' · ' + (x.by || ''))); });
    dr.appendChild(el('h4', null, 'История списаний'));
    var sps = a.spends.filter(function (x) { return x.client === c.id; });
    if (!sps.length) dr.appendChild(el('div', 'small muted', 'Расходов не было.'));
    else sps.forEach(function (x) { dr.appendChild(el('div', 'small muted', x.date + ' · ' + money(x.amountRub, true) + ' · ' + (x.period || ''))); });
    dr.appendChild(el('h4', null, 'Кэшбэк'));
    a.accruals.filter(function (x) { return x.client === c.id; }).forEach(function (x) {
      dr.appendChild(el('div', 'small muted', x.period + ' · ' + x.formula + ' · ' + x.statusLabel + (x.doc ? ' · ' + x.doc : '')));
    });
    a.payouts.filter(function (x) { return x.client === c.id; }).forEach(function (x) {
      dr.appendChild(el('div', 'small muted', 'выплата ' + x.date + ' · ' + money(x.amountRub, true) + ' · ' + x.statusLabel));
    });
  });
}
