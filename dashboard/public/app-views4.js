/* Вкладка «Настройки»: управление всеми параметрами системы. */
'use strict';

function applySetting(payload, btn, okText) {
  if (STANDALONE) { toast('Это автономная копия — управление только в живой панели.', 'bad'); return; }
  if (btn) btn.disabled = true;
  fetch('/api/settings/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (btn) btn.disabled = false;
    if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
    toast(res.changed ? (okText || 'Сохранено') + (res.backup ? ' · копия ' + res.backup : '') : 'Значение уже такое — ничего не менял.');
    loadState().then(boot);
  }).catch(function (e) {
    if (btn) btn.disabled = false;
    toast('Ошибка запроса: ' + e.message, 'bad');
  });
}

function historyLine(h, kind) {
  if (!h) return el('div', 'hintline', 'Через панель это ещё не меняли.');
  var prev = Array.isArray(h.previous) ? h.previous.join(', ') : String(h.previous);
  var now = Array.isArray(h.now) ? h.now.join(', ') : String(h.now);
  return el('div', 'changed', 'Последнее изменение: ' + fmtDateTime(h.at) + ' (' + fmtAgo(h.at) + '), было «' + prev + '» → стало «' + now + '». Копия: ' + h.backup);
}

// Откат делается восстановлением файла из копии .bak-*, которую создала та самая
// правка: так состояние возвращается БАЙТ-В-БАЙТ (проверяется по SHA-256).
function revertBtn(payload, h, btnLabel) {
  if (!h || !h.backup) return null;
  var b = el('button', 'btn small', btnLabel || 'Вернуть как было');
  b.title = 'Восстановить файл из копии ' + h.backup + ' (состояние до правки)';
  b.addEventListener('click', function () {
    if (STANDALONE) { toast('Автономная копия — управление только в живой панели.', 'bad'); return; }
    if (!window.confirm('Вернуть файл к состоянию до правки ' + fmtDateTime(h.at) + '?\nТекущее состояние тоже сохранится в отдельную копию.')) return;
    b.disabled = true;
    fetch('/api/settings/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: payload.file, backup: h.backup })
    }).then(function (r) { return r.json(); }).then(function (res) {
      b.disabled = false;
      if (!res.ok) { toast('Не удалось вернуть: ' + res.message, 'bad'); return; }
      toast('Файл восстановлен из копии ' + res.restoredFrom + '. Текущее состояние сохранено в ' + res.backup + '.');
      loadState().then(boot);
    }).catch(function (e) { b.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
  });
  return b;
}

function settingCard(item) {
  var c = card(item.label);
  var top = el('div', 'setting-row');

  var valueHost = el('div', 'setting-value');
  if (item.kind === 'number') {
    var inp = el('input');
    inp.type = 'number';
    if (item.step) inp.step = item.step;
    if (item.min !== null && item.min !== undefined) inp.min = item.min;
    if (item.max !== null && item.max !== undefined) inp.max = item.max;
    inp.value = item.value === null || item.value === undefined ? '' : item.value;
    inp.style.maxWidth = '150px';
    valueHost.appendChild(inp);
    var save = el('button', 'btn small primary', 'Сохранить');
    save.addEventListener('click', function () {
      applySetting({ kind: 'settings-scalar', path: item.path, value: Number(inp.value) }, save);
    });
    valueHost.appendChild(document.createTextNode(' '));
    valueHost.appendChild(save);
  } else if (item.kind === 'select') {
    var sel = el('select');
    (item.options || []).forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      if (String(item.value) === String(o[0])) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () {
      applySetting({ kind: 'settings-scalar', path: item.path, value: sel.value }, null);
    });
    valueHost.appendChild(sel);
  } else if (item.kind === 'list') {
    var cur = Array.isArray(item.value) ? item.value : [];
    var boxes = [];
    (item.options || []).forEach(function (o) {
      var lab = el('label');
      lab.style.marginRight = '12px';
      var cb = el('input');
      cb.type = 'checkbox';
      cb.value = o[0];
      cb.checked = cur.indexOf(o[0]) >= 0;
      boxes.push(cb);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + o[1]));
      valueHost.appendChild(lab);
    });
    var save2 = el('button', 'btn small primary', 'Сохранить');
    save2.addEventListener('click', function () {
      var vals = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      applySetting({ kind: 'settings-list', path: item.path, value: vals }, save2);
    });
    valueHost.appendChild(document.createTextNode(' '));
    valueHost.appendChild(save2);
  }
  top.appendChild(valueHost);
  c.appendChild(top);

  c.appendChild(el('div', 'small muted', 'Что произойдёт: ' + item.what));
  c.appendChild(el('div', 'small muted', 'Текущее значение: ' + (Array.isArray(item.value) ? item.value.join(', ') : String(item.value))));
  c.appendChild(historyLine(item.history));
  var rb = revertBtn({ kind: 'settings-scalar', path: item.path, file: 'settings' }, item.history);
  if (rb) { var row = el('div', 'filters'); row.appendChild(rb); c.appendChild(row); }
  return c;
}

VIEWS.settings = function (view) {
  var doc = STATE.settings;
  if (!doc) { view.appendChild(note('bad', 'Нет данных настроек. Пересоберите: node marketing-agents/dashboard/collector/collect.mjs')); return; }

  view.appendChild(note('warn', 'Тестовый режим на ПК: управление разрешено. Каждая правка пишет в файл атомарно (temp + rename) и делает копию .bak-<timestamp>. Кнопка «Вернуть как было» возвращает прежнее значение из истории.'));

  // --- правила отчёта ---
  var s1 = section(doc.report.title, doc.report.note);
  var g1 = el('div', 'grid two');
  doc.report.items.forEach(function (it) { g1.appendChild(settingCard(it)); });
  s1.appendChild(g1);
  view.appendChild(s1);

  // --- агенты ---
  var s2 = section(doc.agents.title, doc.agents.note);
  var c2 = card();
  doc.agents.rows.forEach(function (a) {
    var box = el('div', 'setting-agent');
    var head = el('div', 'agent-head');
    var left = el('div');
    left.appendChild(el('h3', 'agent-name', a.name));
    left.appendChild(el('div', 'agent-role', 'id: ' + a.id + ' · ' + (a.status === 'active' ? 'активен' : a.status)));
    head.appendChild(left);
    var right = el('div');
    right.style.textAlign = 'right';
    var sw = el('button', 'switch' + (a.enabled ? ' on' : ''));
    sw.setAttribute('role', 'switch');
    sw.title = a.enabled ? 'Выключить: агент перестанет получать задачи' : 'Включить: агент начнёт получать задачи';
    sw.appendChild(el('span', 'knob'));
    sw.addEventListener('click', function () {
      if (STANDALONE) { toast('Автономная копия — управление только в живой панели.', 'bad'); return; }
      sw.classList.add('busy');
      fetch('/api/agents/' + encodeURIComponent(a.id) + '/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled })
      }).then(function (r) { return r.json(); }).then(function (res) {
        sw.classList.remove('busy');
        if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
        toast('Агент «' + a.name + '» теперь ' + (res.enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'));
        loadState().then(boot);
      });
    });
    right.appendChild(sw);
    right.appendChild(el('div', 'small muted', a.enabled ? 'включён' : 'выключен'));
    head.appendChild(right);
    box.appendChild(head);

    // модель
    var mrow = el('div', 'setting-row');
    mrow.appendChild(el('span', 'small muted', 'Модель: '));
    var msel = el('select');
    var opts = (a.modelOptions || []).slice();
    if (a.model && !opts.some(function (o) { return o.id === a.model; })) opts.unshift({ id: a.model, rubIn: null, rubOut: null });
    opts.forEach(function (o) {
      var price = o.rubIn === null || o.rubIn === undefined ? 'цена неизвестна' : (o.rubIn + ' ₽ за 1 млн вход, ' + o.rubOut + ' ₽ выход');
      var op = el('option', null, o.id + ' — ' + price);
      op.value = o.id;
      if (o.id === a.model) op.selected = true;
      msel.appendChild(op);
    });
    msel.addEventListener('change', function () {
      applySetting({ kind: 'agent-field', id: a.id, field: 'model', value: msel.value }, null, 'Модель агента изменена');
    });
    mrow.appendChild(msel);
    box.appendChild(mrow);
    box.appendChild(el('div', 'small muted', 'Что произойдёт: агент начнёт работать на выбранной модели. Сильная модель дороже — смотрите цену рядом с названием.'));

    // расписание
    var srow = el('div', 'setting-row');
    srow.appendChild(el('span', 'small muted', 'Расписание: '));
    var sinp = el('input');
    sinp.type = 'text';
    sinp.value = a.schedule || '';
    sinp.placeholder = 'например weekly:monday:10:00 или on-demand';
    sinp.style.minWidth = '240px';
    srow.appendChild(sinp);
    var ssave = el('button', 'btn small', 'Сохранить');
    ssave.addEventListener('click', function () {
      applySetting({ kind: 'agent-field', id: a.id, field: 'schedule', value: sinp.value }, ssave, 'Расписание изменено');
    });
    srow.appendChild(ssave);
    box.appendChild(srow);
    box.appendChild(el('div', 'small muted', 'Что произойдёт: когда агент запускается сам. «on-demand» — только по команде.'));

    // проекты и группы
    [['projects', 'Проекты (id через запятую; пусто = все)', a.projects], ['groups', 'Группы задач (через запятую)', a.groups]].forEach(function (f) {
      var row = el('div', 'setting-row');
      row.appendChild(el('span', 'small muted', f[1] + ': '));
      var inp = el('input');
      inp.type = 'text';
      inp.value = (f[2] || []).join(', ');
      inp.style.minWidth = '240px';
      row.appendChild(inp);
      var sv = el('button', 'btn small', 'Сохранить');
      sv.addEventListener('click', function () {
        var vals = inp.value.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
        applySetting({ kind: 'agent-field', id: a.id, field: f[0], value: vals }, sv, 'Список изменён');
      });
      row.appendChild(sv);
      box.appendChild(row);
    });

    box.appendChild(historyLine(a.history.enabled));
    if (a.history.model) box.appendChild(historyLine(a.history.model));
    if (a.history.schedule) box.appendChild(historyLine(a.history.schedule));
    var rb = revertBtn({ kind: 'agent-field', id: a.id, field: 'model', file: 'agents' }, a.history.model, 'Вернуть прежнюю модель');
    if (rb) { var rrow = el('div', 'filters'); rrow.appendChild(rb); box.appendChild(rrow); }
    c2.appendChild(box);
  });
  s2.appendChild(c2);
  view.appendChild(s2);

  // --- источники ---
  var s3 = section(doc.sources.title, doc.sources.note);
  var c3 = card();
  doc.sources.rows.forEach(function (s) {
    var row = el('div', 'setting-row');
    var left = el('div');
    left.style.flex = '1';
    left.appendChild(el('div', 't', s.name));
    left.appendChild(el('div', 'small muted', 'id: ' + s.id + ' · ' + (s.kind || '') + ' · лотов: ' + fmtInt(s.lots)));
    row.appendChild(left);
    var sw = el('button', 'switch' + (s.enabled ? ' on' : ''));
    sw.setAttribute('role', 'switch');
    sw.title = s.enabled ? 'Выключить: сбор пропустит этот источник' : 'Включить: сбор снова будет брать этот источник';
    sw.appendChild(el('span', 'knob'));
    sw.addEventListener('click', function () {
      if (STANDALONE) { toast('Автономная копия — управление только в живой панели.', 'bad'); return; }
      sw.classList.add('busy');
      fetch('/api/sources/' + encodeURIComponent(s.id) + '/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled })
      }).then(function (r) { return r.json(); }).then(function (res) {
        sw.classList.remove('busy');
        if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
        toast('Источник «' + s.name + '» теперь ' + (res.enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'));
        loadState().then(boot);
      });
    });
    row.appendChild(sw);
    c3.appendChild(row);
    c3.appendChild(historyLine(s.history.enabled));
  });
  s3.appendChild(c3);
  view.appendChild(s3);

  // --- цены и курс ---
  var s4 = section(doc.prices.title, doc.prices.note);
  var rate = doc.prices.rate;
  var c4 = card('Курс валюты');
  var rr = el('div', 'setting-row');
  var rin = el('input');
  rin.type = 'number';
  rin.step = rate.step || '0.01';
  rin.value = rate.value === null ? '' : rate.value;
  rin.style.maxWidth = '140px';
  rr.appendChild(el('span', 'small muted', rate.label + ': '));
  rr.appendChild(rin);
  var rsave = el('button', 'btn small primary', 'Сохранить');
  rsave.addEventListener('click', function () { applySetting({ kind: 'price-rate', value: Number(rin.value) }, rsave, 'Курс изменён'); });
  rr.appendChild(rsave);
  c4.appendChild(rr);
  c4.appendChild(el('div', 'small muted', 'Что произойдёт: ' + rate.what));
  c4.appendChild(historyLine(rate.history));
  var rrb = revertBtn({ kind: 'price-rate', file: 'prices' }, rate.history, 'Вернуть прежний курс');
  if (rrb) { var rrow2 = el('div', 'filters'); rrow2.appendChild(rrb); c4.appendChild(rrow2); }
  s4.appendChild(c4);

  var c5 = card('Цены моделей, ₽ за 1 млн токенов');
  c5.appendChild(el('div', 'small muted', 'Пустое поле = «цена неизвестна» (модель не оценивается в рублях).'));
  doc.prices.models.forEach(function (m) {
    var row = el('div', 'setting-row');
    var name = el('div');
    name.style.flex = '1';
    name.appendChild(el('div', 't', m.id));
    name.appendChild(el('div', 'small muted', m.acceptsImages === true ? 'принимает изображения' : (m.acceptsImages === false ? 'только текст' : '')));
    row.appendChild(name);
    [['rub_per_1m_in', 'вход', m.rubIn], ['rub_per_1m_out', 'выход', m.rubOut]].forEach(function (f) {
      var w = el('span');
      w.appendChild(el('span', 'small muted', f[1] + ': '));
      var inp = el('input');
      inp.type = 'number';
      inp.step = '0.01';
      inp.value = f[2] === null || f[2] === undefined ? '' : f[2];
      inp.style.maxWidth = '110px';
      w.appendChild(inp);
      var sv = el('button', 'btn small', 'ок');
      sv.addEventListener('click', function () {
        applySetting({ kind: 'price-model', id: m.id, field: f[0], value: inp.value === '' ? null : Number(inp.value) }, sv, 'Цена обновлена');
      });
      w.appendChild(sv);
      row.appendChild(w);
    });
    c5.appendChild(row);
    var hist = m.historyIn || m.historyOut;
    if (hist) c5.appendChild(historyLine(hist));
  });
  s4.appendChild(c5);
  view.appendChild(s4);


  // --- роутинг моделей ---
  if (doc.routing) {
    var s6 = section(doc.routing.title, doc.routing.note);
    var c7 = card();
    doc.routing.items.forEach(function (it) {
      var row = el('div', 'setting-row');
      row.appendChild(el('span', 'small muted', it.label + ': '));
      var sel = el('select');
      var found = false;
      (it.options || []).forEach(function (o) {
        var op = el('option', null, o[1]);
        op.value = o[0];
        if (String(it.value) === String(o[0])) { op.selected = true; found = true; }
        sel.appendChild(op);
      });
      if (!found) {
        var op0 = el('option', null, 'не выбрана — выберите модель');
        op0.value = '';
        op0.selected = true;
        sel.insertBefore(op0, sel.firstChild);
      }
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        if (STANDALONE) { toast('Автономная копия — управление только в живой панели.', 'bad'); return; }
        sel.disabled = true;
        fetch('/api/settings/routing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: it.id, value: sel.value })
        }).then(function (r) { return r.json(); }).then(function (res) {
          sel.disabled = false;
          if (!res.ok) { toast('Не удалось: ' + res.message, 'bad'); return; }
          toast((res.created ? 'Файл роутинга создан. ' : '') + it.label + ' → ' + sel.value + (res.backup ? ' · копия ' + res.backup : ''));
          loadState().then(boot);
        }).catch(function (e) { sel.disabled = false; toast('Ошибка: ' + e.message, 'bad'); });
      });
      row.appendChild(sel);
      c7.appendChild(row);
      c7.appendChild(el('div', 'small muted', 'Что произойдёт: ' + it.what));
      c7.appendChild(historyLine(it.history));
      var rb2 = revertBtn({ kind: 'routing', file: 'router' }, it.history);
      if (rb2) { var rr3 = el('div', 'filters'); rr2 = rb2; rr3.appendChild(rb2); c7.appendChild(rr3); }
    });
    if (!doc.routing.exists) c7.appendChild(note(null, 'Файла конфигурации ещё нет — он создастся при первом сохранении: ' + doc.routing.file));
    s6.appendChild(c7);
    view.appendChild(s6);
  }

  // --- плагины профиля ---
  if (doc.plugins) {
    var s7 = section(doc.plugins.title, doc.plugins.note);
    var c8 = card();
    c8.appendChild(note('warn', doc.plugins.restartNote));
    c8.appendChild(el('div', 'small muted', 'Файл профиля: ' + doc.plugins.manifest));
    var lockedList = doc.plugins.rows.filter(function (r) { return r.protected; });
    c8.appendChild(note('ok', 'Защищены от выключения: ' + lockedList.length + ' пакетов — встроенные бандлы DeepSeek и языковой пакет dsh-locale-ru (его выключение вернуло бы интерфейс на китайский). Панель не даёт их менять.'));
    doc.plugins.rows.forEach(function (pl) {
      if (pl.inbox) return; // встроенные показываем отдельным списком ниже
      var row = el('div', 'setting-row');
      var left = el('div');
      left.style.flex = '1';
      left.appendChild(el('div', 't', pl.name));
      var meta = el('div', 'small muted');
      meta.appendChild(badge(pl.inBundles ? 'в загрузке' : 'выключен из загрузки', pl.inBundles ? 'ok' : 'grey'));
      meta.appendChild(document.createTextNode(' ' + (pl.declaredVersion || 'версия не указана')));
      if (pl.protected) { meta.appendChild(document.createTextNode(' ')); meta.appendChild(badge('нельзя выключать', 'bad')); }
      left.appendChild(meta);
      if (pl.protected) left.appendChild(el('div', 'hintline', pl.protectReason));
      row.appendChild(left);
      if (pl.protected) {
        var lock = el('span', 'lock', 'защищён');
        lock.title = pl.protectReason;
        row.appendChild(lock);
      } else {
        var sw2 = el('button', 'switch' + (pl.inBundles ? ' on' : ''));
        sw2.setAttribute('role', 'switch');
        sw2.title = pl.inBundles ? 'Выключить из загрузки профиля (потребуется перезапуск DSH)' : 'Включить в загрузку профиля (потребуется перезапуск DSH)';
        sw2.appendChild(el('span', 'knob'));
        sw2.addEventListener('click', function () {
          if (STANDALONE) { toast('Автономная копия — управление только в живой панели.', 'bad'); return; }
          sw2.classList.add('busy');
          fetch('/api/settings/plugin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ package: pl.name, enabled: !pl.inBundles })
          }).then(function (r) { return r.json(); }).then(function (res) {
            sw2.classList.remove('busy');
            if (!res.ok) {
              toast('Отменено: ' + res.message + (res.checker ? ' | ' + res.checker.split('\n')[0] : ''), 'bad');
              loadState().then(boot);
              return;
            }
            toast('Пакет ' + pl.name + ' ' + (res.enabled ? 'включён' : 'выключен') + '. Профиль проверен. НУЖЕН ПЕРЕЗАПУСК DSH.', 'bad');
            loadState().then(boot);
          }).catch(function (e) { sw2.classList.remove('busy'); toast('Ошибка: ' + e.message, 'bad'); });
        });
        row.appendChild(sw2);
      }
      c8.appendChild(row);
    });
    var inboxRows = doc.plugins.rows.filter(function (r) { return r.inbox; });
    if (inboxRows.length > 0) {
      var det = el('details');
      var sm = el('summary');
      sm.appendChild(el('span', null, 'Встроенные бандлы DeepSeek (' + inboxRows.length + ')'));
      sm.appendChild(el('span', 'spacer'));
      sm.appendChild(badge('нельзя выключать', 'bad'));
      det.appendChild(sm);
      var inner = el('div', 'inner');
      inboxRows.forEach(function (r) {
        inner.appendChild(el('div', 'small muted', r.name + ' — ' + (r.protectReason || '')));
      });
      det.appendChild(inner);
      c8.appendChild(det);
    }
    s7.appendChild(c8);
    view.appendChild(s7);
  }

  // --- доставка ---
  if (doc.delivery) {
    var s8 = section(doc.delivery.title, doc.delivery.note);
    var c9 = card();
    var w = doc.delivery.where;
    c9.appendChild(el('div', 'setting-row')).appendChild(el('span', 'small muted', 'Куда уходит отчёт: '));
    var lines2 = el('div');
    lines2.appendChild(el('div', 'small muted', 'Режим отправки: ' + w.sendMode));
    lines2.appendChild(el('div', 'small muted', 'Telegram: ' + w.telegram));
    lines2.appendChild(el('div', 'small muted', 'Почта: ' + w.email));
    lines2.appendChild(el('div', 'small muted', 'Форматы отчёта: ' + ((w.formats || []).join(', ') || 'не заданы')));
    c9.appendChild(lines2);
    doc.delivery.items.forEach(function (it) {
      var row = el('div', 'setting-row');
      var left = el('div');
      left.style.flex = '1';
      left.appendChild(el('div', 't', it.label));
      left.appendChild(el('div', 'small muted', 'Что произойдёт: ' + it.what));
      row.appendChild(left);
      var sw3 = el('button', 'switch' + (it.value ? ' on' : ''));
      sw3.setAttribute('role', 'switch');
      sw3.title = it.value ? 'Выключить отметку' : 'Включить отметку';
      sw3.appendChild(el('span', 'knob'));
      sw3.addEventListener('click', function () {
        applySetting({ kind: 'settings-bool', path: it.path, value: !it.value }, sw3, 'Отметка доставки изменена');
      });
      row.appendChild(sw3);
      c9.appendChild(row);
      c9.appendChild(historyLine(it.history));
    });
    s8.appendChild(c9);
    view.appendChild(s8);
  }

  if (doc.warnings && doc.warnings.length) {
    var s5 = section('Предупреждения');
    var c6 = card();
    doc.warnings.forEach(function (w) { c6.appendChild(note('warn', w)); });
    s5.appendChild(c6);
    view.appendChild(s5);
  }
};
