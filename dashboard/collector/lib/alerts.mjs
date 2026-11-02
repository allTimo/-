// Тревоги на «Обзоре»: что случилось, что это значит и куда перейти.
import path from 'node:path';
import { PROJECT_DIR } from './paths.mjs';

const STALE_DAYS = 7;
const SPIKE_FACTOR = 2;

function daysBetween(a, b) {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  return Math.round((d2 - d1) / 86400000);
}

export function buildAlertsDoc(ctx) {
  const alerts = [];
  const today = ctx.today;
  const sourcesDoc = ctx.sourcesDoc;
  const tasksDoc = ctx.tasksDoc;
  const usage = ctx.usage;
  const agentsDoc = ctx.agentsDoc;

  // 1. Источник не отвечает / не проверен, но включён
  for (const s of sourcesDoc.sources) {
    if (s.status === 'blocked') {
      alerts.push({
        id: 'source-blocked-' + s.id, level: 'critical',
        title: 'Источник не отвечает: ' + s.name,
        what: 'Источник помечен как заблокированный' + (s.limits ? ' (' + s.limits + ')' : ''),
        meaning: 'Сбор по нему не идёт. Если это ваш основной источник — данные в отчёте будут неполными.',
        action: { label: 'Открыть источники', tab: 'sources' },
      });
    } else if (s.enabled && s.stats.lots === 0 && s.kind !== 'manual') {
      alerts.push({
        id: 'source-empty-' + s.id, level: 'warning',
        title: 'Включён, но данных нет: ' + s.name,
        what: 'Источник включён в реестре, но в снимках по нему 0 лотов',
        meaning: 'Либо сбор ещё не запускался, либо источник ничего не отдаёт. Стоит запустить сбор вручную.',
        action: { label: 'Запустить сбор', tab: 'overview', anchor: 'actions' },
      });
    }
  }

  // 2. Данные устарели
  const lastSnapshot = sourcesDoc.snapshots.length
    ? sourcesDoc.snapshots.map(function (s) { return s.date; }).filter(Boolean).sort().slice(-1)[0]
    : null;
  if (lastSnapshot) {
    const age = daysBetween(lastSnapshot, today);
    if (age !== null && age > STALE_DAYS) {
      alerts.push({
        id: 'stale-data', level: age > STALE_DAYS * 2 ? 'critical' : 'warning',
        title: 'Данные устарели: последний снимок ' + lastSnapshot,
        what: 'Свежих снимков нет ' + age + ' дн. (порог ' + STALE_DAYS + ' дн.)',
        meaning: 'Отчёт за текущую неделю будет без свежих данных. Нужно запустить сбор.',
        action: { label: 'Собрать данные сейчас', tab: 'overview', anchor: 'actions' },
      });
    }
  } else if (sourcesDoc.summary.total > 0) {
    alerts.push({
      id: 'no-snapshots', level: 'warning',
      title: 'Снимков нет вообще',
      what: 'В папке снимков не найдено ни одного lots.csv',
      meaning: 'Отчёт построить не из чего. Проверьте источники и запустите сбор.',
      action: { label: 'Открыть источники', tab: 'sources' },
    });
  }

  // 3. Просроченные задачи
  const overdue = (tasksDoc.tasks || []).filter(function (t) { return t.overdue; });
  if (overdue.length > 0) {
    alerts.push({
      id: 'tasks-overdue', level: 'critical',
      title: 'Просрочено задач: ' + overdue.length,
      what: overdue.slice(0, 3).map(function (t) { return t.id + ' «' + t.subject.slice(0, 40) + '» (срок ' + t.due + ')'; }).join('; '),
      meaning: 'Сроки прошли, а задачи не закрыты. Клиент может не получить результат вовремя.',
      action: { label: 'Открыть задачи', tab: 'tasks' },
      items: overdue.map(function (t) { return { id: t.id, subject: t.subject, due: t.due, owner: t.ownerLabel || t.ownerName || 'без исполнителя' }; }),
    });
  }

  // 4. Расход за день выше обычного
  const days = usage.byDay || [];
  if (days.length >= 3) {
    const withRub = days.filter(function (d) { return d.rub !== null && d.rub !== undefined; });
    if (withRub.length >= 3) {
      const last = withRub[withRub.length - 1];
      const prev = withRub.slice(0, -1).map(function (d) { return d.rub; }).sort(function (a, b) { return a - b; });
      const median = prev[Math.floor(prev.length / 2)];
      if (median > 0 && last.rub > median * SPIKE_FACTOR) {
        alerts.push({
          id: 'spend-spike', level: 'warning',
          title: 'Расход за ' + last.date + ' выше обычного',
          what: fmt(last.rub) + ' ₽ против обычных ' + fmt(median) + ' ₽ в день (в ' + (last.rub / median).toFixed(1) + ' раза больше)',
          meaning: 'День стоил заметно дороже. Проверьте, какая модель и какой агент потратили больше.',
          action: { label: 'Открыть расходы', tab: 'usage' },
        });
      }
    }
  }

  // 5. Агент выключен, но задачи на нём есть
  for (const a of agentsDoc.agents) {
    if (!a.enabled && a.metrics.tasks.total > 0) {
      const open = a.metrics.tasks.total - (a.metrics.tasks.byStatus.done || 0);
      alerts.push({
        id: 'agent-off-tasks-' + a.id, level: 'warning',
        title: 'Агент выключен, но у него задачи: ' + a.name,
        what: 'Задач всего ' + a.metrics.tasks.total + ', из них не закрыто ' + open,
        meaning: 'Выключенный агент не берёт новые задачи и не запускается. Незакрытые задачи останутся висеть.',
        action: { label: 'Открыть агентов', tab: 'agents' },
      });
    }
  }

  // 6. Модели без цены — деньги считаются не полностью
  if (usage.unknownPriceModels && usage.unknownPriceModels.length > 0) {
    alerts.push({
      id: 'unknown-prices', level: 'info',
      title: 'Модели без цены: ' + usage.unknownPriceModels.length,
      what: usage.unknownPriceModels.join(', '),
      meaning: 'Их токены посчитаны, а рубли — нет. Итоговый расход в рублях занижен.',
      action: { label: 'Открыть настройки цен', tab: 'settings' },
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort(function (a, b) { return order[a.level] - order[b.level]; });

  return {
    generatedAtMs: Date.now(),
    today: today,
    thresholds: { staleDays: STALE_DAYS, spikeFactor: SPIKE_FACTOR },
    counts: {
      total: alerts.length,
      critical: alerts.filter(function (a) { return a.level === 'critical'; }).length,
      warning: alerts.filter(function (a) { return a.level === 'warning'; }).length,
      info: alerts.filter(function (a) { return a.level === 'info'; }).length,
    },
    alerts: alerts,
    lastSnapshot: lastSnapshot,
    checked: {
      sources: sourcesDoc.summary.total,
      tasks: tasksDoc.counts.total,
      days: days.length,
      agents: agentsDoc.agents.length,
    },
  };
}

function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
