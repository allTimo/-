/* Раздел «Скилы»: реестр скиллов агента и журнал прогонов. Только чтение. */
'use strict';

function skillRunText(last) {
  if (!last) return 'прогонов нет';
  var parts = [String(last.status || 'без статуса')];
  if (typeof last.count === 'number') parts.push('записей: ' + last.count);
  if (last.ts) parts.push(String(last.ts).replace('T', ' ').slice(0, 19));
  return parts.join(' · ');
}

VIEWS['skills'] = function (view) {
  var d = STATE['skills'] || null;
  if (!d || !d.counts) {
    view.appendChild(note('warn', 'Данных о скилах нет: сборщик панели не собрал skills.json.'));
    return;
  }

  var head = card('Скилы агентов');
  head.appendChild(el('div', 'small muted', d.honesty || ''));
  head.appendChild(el('div', 'small muted',
    'Реестр: ' + d.file + ' · всего: ' + d.counts.total +
    ' · включено: ' + d.counts.enabled +
    ' · требуют ключ: ' + d.counts.needsKey +
    ' · с прогонами: ' + d.counts.withRuns));
  view.appendChild(head);

  var registry = card('Реестр скиллов');
  rowsTable(registry, [
    ['Скил'],
    ['Назначение'],
    ['Ключи'],
    ['Последний прогон'],
    ['Ограничения (честно)']
  ], d.skills.map(function (s) {
    return [
      s.title + (s.enabled ? '' : ' (выключен)'),
      s.purpose,
      s.requiredEnv.length ? s.requiredEnv.join(', ') : (s.needsKey ? 'требуется ключ' : 'ключ не нужен'),
      skillRunText(s.lastRun),
      s.limits || '—'
    ];
  }));
  view.appendChild(registry);

  var journal = card('Журнал прогонов');
  journal.appendChild(el('div', 'small muted', 'Файл: ' + d.journal.file));
  if (!d.journal.exists) {
    journal.appendChild(note('muted', 'Журнала пока нет: ни один скил ещё не вызывался.'));
  } else {
    var ul = el('ul', 'clean');
    ul.appendChild(el('li', null, 'записей всего: ' + d.journal.runs));
    ul.appendChild(el('li', null, 'успешных (ok): ' + d.journal.ok));
    ul.appendChild(el('li', null, 'пустых (empty): ' + d.journal.empty));
    ul.appendChild(el('li', null, 'без ключа (skipped_no_key): ' + d.journal.skipped));
    ul.appendChild(el('li', null, 'с ошибкой (error): ' + d.journal.errors));
    journal.appendChild(ul);
  }
  view.appendChild(journal);

  if (d.warnings && d.warnings.length) {
    var warn = card('Предупреждения сборщика');
    d.warnings.forEach(function (w) { warn.appendChild(note('warn', w)); });
    view.appendChild(warn);
  }
};
