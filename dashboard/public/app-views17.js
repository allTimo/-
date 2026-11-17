/* Карточка Агента 2: блок «Кабинеты Яндекс.Директа» — OAuth-приложение, привязка кабинета
   по токену, список кабинетов с проверкой и удалением.

   Бэкенд: /api/direct/* (см. контракт задачи task-4):
     GET  /api/direct/accounts        -> {ok, oauth:{clientIdSet, clientIdMask, authorizeBase, redirectUri}, accounts:[...]}
     POST /api/direct/oauth           {clientId}              -> {ok, oauth}
     POST /api/direct/accounts        {token, login, sandbox} -> {ok, account} | {ok:false, message}
     POST /api/direct/accounts/check  {id}                    -> {ok, account}
     POST /api/direct/accounts/delete {id}                    -> {ok}

   Честность: токен в браузере не хранится (ни localStorage, ни куки) и не показывается —
   панель рисует только маску, которую отдал сервер. Если эндпоинтов ещё нет, блок
   остаётся на месте с текстом «не удалось получить список кабинетов: <причина>». */
'use strict';

var DIRECT_A2_ID = 'agent-2-direct-semantics';
var DIRECT_AUTHORIZE_BASE_DEFAULT = 'https://oauth.yandex.ru/authorize?response_type=token';
var DIRECT_REDIRECT_URI_DEFAULT = 'https://oauth.yandex.ru/verification_code';
var DIRECT_NEW_APP_URL = 'https://oauth.yandex.ru/client/new/';
var DIRECT_ACCOUNTS_HINT = 'Один кабинет — один OAuth-токен. Токен хранится только локально, в панели показывается маска. ' +
  'Альтернатива без привязки здесь: положите YANDEX_OAUTH_TOKEN в marketing-agents/.env — кнопка «Проверить доступ к API Директа» возьмёт токен оттуда.';

/* Полный Client ID живёт только в памяти этой вкладки: API отдаёт лишь маску, а ссылке
   авторизации нужен полный идентификатор. Ни localStorage, ни куки не используются. */
var DIRECT_CLIENT_ID_FULL = null;

var DIRECT_STATUS_TEXT = {
  ok: ['доступ есть', 'ok'],
  invalid: ['токен не работает', 'bad'],
  unchecked: ['не проверен', 'grey']
};

function directStatusBadge(status) {
  var s = DIRECT_STATUS_TEXT[status] || [status ? String(status) : 'статус не указан', 'grey'];
  return badge(s[0], s[1]);
}

function directDateText(v) {
  if (v === null || v === undefined || v === '') return '—';
  var ms = typeof v === 'number' ? v : Date.parse(v);
  return isFinite(ms) ? fmtDateTime(ms) : String(v);
}

function directCampaignsText(n) {
  return (typeof n === 'number' && isFinite(n)) ? fmtInt(n) : 'данных нет';
}

/* Один запрос к /api/direct/*. Различаем «эндпоинта ещё нет» (404) и сетевую ошибку:
   в обоих случаях блок обязан остаться на месте с честным текстом, а не исчезнуть. */
function directApi(path, method, body) {
  var opts = { cache: 'no-store' };
  if (method && method !== 'GET') {
    opts.method = method;
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body || {});
  }
  return fetch(path, opts).then(function (r) {
    if (r.status === 404) throw new Error('бэкенд кабинетов ещё не готов');
    return r.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
      if (!r.ok) throw new Error((data && data.message) ? String(data.message) : ('HTTP ' + r.status));
      if (!data) throw new Error('ответ сервера не разобран как JSON');
      return data;
    });
  }, function (e) {
    throw new Error('сеть недоступна' + ((e && e.message) ? ': ' + e.message : ''));
  });
}

function directTextField(placeholder) {
  var i = el('input');
  i.type = 'text';
  i.setAttribute('autocomplete', 'off');
  if (placeholder) i.placeholder = placeholder;
  return i;
}

/* Поле токена: type=password (как требует контракт), но с внешностью обычных полей панели.
   Общего класса для input в styles.css нет, поэтому стиль инлайновый — свой CSS не заводим. */
function directSecretField(placeholder) {
  var i = directTextField(placeholder);
  i.type = 'password';
  i.style.cssText = 'background:var(--panel-2);color:var(--text);border:1px solid var(--border);' +
    'border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit;';
  return i;
}

function directKnownClientId(oauth) {
  if (DIRECT_CLIENT_ID_FULL) return DIRECT_CLIENT_ID_FULL;
  var v = oauth && oauth.clientId;
  return (typeof v === 'string' && v) ? v : null;
}

/* Блок «Кабинеты Яндекс.Директа». Данные грузятся сразу при отрисовке карточки;
   после каждой операции список перезагружается GET-запросом. */
function directAccountsBlock() {
  var box = el('div', 'agent-stand');
  box.setAttribute('data-direct-accounts', DIRECT_A2_ID);

  var head = el('div', 'agent-stand-head');
  head.appendChild(el('div', 'agent-stand-title', 'Кабинеты Яндекс.Директа'));
  var headNote = el('span');
  head.appendChild(headNote);
  var reloadBtn = el('button', 'btn small', 'Обновить список');
  reloadBtn.title = 'Перечитать /api/direct/accounts';
  head.appendChild(reloadBtn);
  box.appendChild(head);
  box.appendChild(el('div', 'hintline', DIRECT_ACCOUNTS_HINT));

  var body = el('div');
  box.appendChild(body);

  /* Итог операции, который должен пережить перезагрузку списка (успех привязки,
     сохранение Client ID): рисуется заново внутри paint(). */
  var flash = null;

  function setHeadBadge(text, cls) {
    clear(headNote);
    if (text) headNote.appendChild(badge(text, cls));
  }

  function renderAccounts(doc) {
    var oauth = (doc && doc.oauth) || {};
    var accounts = (doc && doc.accounts) || [];
    var configured = oauth.clientIdSet === true;
    setHeadBadge(configured ? 'OAuth-приложение настроено' : 'OAuth-приложение не настроено', configured ? 'ok' : 'warn');

    clear(body);
    if (flash) body.appendChild(note(flash.kind, flash.text));

    /* --- 1. OAuth-приложение --- */
    var oauthBox = el('div', 'ag-group');
    oauthBox.appendChild(el('div', 'ag-group-title', 'OAuth-приложение'));
    var oauthMsg = el('div');
    var oauthRow = el('div', 'filters');

    if (configured) {
      oauthRow.appendChild(el('span', 'small muted', 'Client ID: ' + (oauth.clientIdMask || 'маска недоступна')));
      var known = directKnownClientId(oauth);
      var fullIn = null;
      if (!known) {
        fullIn = directTextField('полный Client ID (нужен для ссылки)');
        oauthRow.appendChild(fullIn);
      }
      var connect = el('button', 'btn small primary', 'Подключить кабинет');
      connect.title = 'Откроет страницу авторизации Яндекса в новой вкладке';
      connect.addEventListener('click', function () {
        var full = directKnownClientId(oauth) || (fullIn ? String(fullIn.value || '').trim() : '');
        clear(oauthMsg);
        if (!full) {
          oauthMsg.appendChild(note('warn', 'API отдаёт только маску Client ID — введите полный Client ID из кабинета Яндекса, иначе ссылку авторизации не собрать.'));
          return;
        }
        DIRECT_CLIENT_ID_FULL = full;
        var base = oauth.authorizeBase || DIRECT_AUTHORIZE_BASE_DEFAULT;
        var w = window.open(base + '&client_id=' + encodeURIComponent(full), '_blank', 'noopener');
        if (w) { try { w.opener = null; } catch (e) { /* политика браузера — не мешает работе */ } }
        oauthMsg.appendChild(note('ok', 'Войдите в аккаунт Яндекса с доступом к нужному кабинету Директа, разрешите доступ и скопируйте токен со страницы. Затем вставьте его ниже — он будет проверен и сохранён.'));
      });
      oauthRow.appendChild(connect);
    } else {
      oauthBox.appendChild(note('warn', 'OAuth-приложение не настроено: без Client ID подключить кабинет нельзя.'));
      var idIn = directTextField('Client ID приложения');
      var saveId = el('button', 'btn small primary', 'Сохранить Client ID');
      var link = el('a', 'small', 'Создать приложение');
      link.href = DIRECT_NEW_APP_URL;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Откроет форму создания приложения Яндекса в новой вкладке';
      saveId.addEventListener('click', function () {
        var v = String(idIn.value || '').trim();
        clear(oauthMsg);
        if (!v) { oauthMsg.appendChild(note('warn', 'Введите Client ID приложения.')); return; }
        flash = null;
        saveId.disabled = true;
        var was = saveId.textContent;
        saveId.textContent = 'Сохраняю…';
        directApi('/api/direct/oauth', 'POST', { clientId: v }).then(function (res) {
          if (!res || res.ok === false) throw new Error((res && res.message) || 'сервер отклонил Client ID');
          DIRECT_CLIENT_ID_FULL = v;
          flash = { kind: 'ok', text: 'Client ID сохранён — OAuth-приложение настроено, можно подключать кабинет.' };
          return reload();
        }).catch(function (e) {
          oauthMsg.appendChild(note('bad', 'Не удалось сохранить Client ID: ' + e.message));
        }).then(function () {
          saveId.disabled = false;
          saveId.textContent = was;
        });
      });
      oauthRow.appendChild(idIn);
      oauthRow.appendChild(saveId);
      oauthRow.appendChild(link);
      oauthBox.appendChild(oauthRow);
      oauthBox.appendChild(el('div', 'hintline',
        'В форме создания приложения выберите тип «Для доступа к API или отладки», включите доступ ' +
        '«Яндекс Директ» (direct:api) и при необходимости «Яндекс Метрика». Redirect URI: ' +
        (oauth.redirectUri || DIRECT_REDIRECT_URI_DEFAULT) + '.'));
      oauthRow = null;
    }
    if (oauthRow) oauthBox.appendChild(oauthRow);
    oauthBox.appendChild(oauthMsg);
    body.appendChild(oauthBox);

    /* --- 2. Привязка кабинета по токену --- */
    var bindBox = el('div', 'ag-group');
    bindBox.appendChild(el('div', 'ag-group-title', 'Привязка кабинета'));
    var tokenIn = directSecretField('OAuth-токен Директа');
    var loginIn = directTextField('Логин клиента (для агентских аккаунтов, необязательно)');
    var sandboxCb = el('input');
    sandboxCb.type = 'checkbox';
    var sandboxLab = el('label', 'small muted');
    sandboxLab.appendChild(sandboxCb);
    sandboxLab.appendChild(document.createTextNode(' Песочница'));
    sandboxLab.title = 'Тестовый контур Директа: кампании песочницы не влияют на реальные показы';

    var bind = el('button', 'btn small primary', 'Проверить и сохранить');
    bind.title = 'Проверить токен в API Директа и сохранить кабинет';
    var bindMsg = el('div');

    bind.addEventListener('click', function () {
      var token = String(tokenIn.value || '').trim();
      clear(bindMsg);
      if (!token) { bindMsg.appendChild(note('warn', 'Вставьте токен: без него кабинет не привязать.')); return; }
      flash = null;
      bind.disabled = true;
      var was = bind.textContent;
      bind.textContent = 'Проверяю токен…';
      directApi('/api/direct/accounts', 'POST', {
        token: token,
        login: String(loginIn.value || '').trim(),
        sandbox: sandboxCb.checked === true
      }).then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.message) || 'сервер не подтвердил кабинет');
        var acc = res.account || {};
        flash = {
          kind: 'ok',
          text: 'Кабинет подключён: ' + (acc.login || 'логин не указан') + ', кампаний ' + directCampaignsText(acc.campaigns)
        };
        return reload();
      }).catch(function (e) {
        bindMsg.appendChild(note('bad', 'Не удалось подключить кабинет: ' + e.message));
      }).then(function () {
        bind.disabled = false;
        bind.textContent = was;
      });
    });

    var bindRow1 = el('div', 'filters');
    bindRow1.appendChild(tokenIn);
    bindBox.appendChild(bindRow1);
    var bindRow2 = el('div', 'filters');
    bindRow2.appendChild(loginIn);
    bindRow2.appendChild(sandboxLab);
    bindRow2.appendChild(bind);
    bindBox.appendChild(bindRow2);
    bindBox.appendChild(el('div', 'hintline', 'Токен уходит на локальный сервер панели, проверяется запросом к API Директа и сохраняется только там; в браузере он не остаётся.'));
    bindBox.appendChild(bindMsg);
    body.appendChild(bindBox);

    /* --- 3. Список кабинетов --- */
    var listBox = el('div', 'ag-group');
    listBox.appendChild(el('div', 'ag-group-title', 'Список кабинетов'));
    if (!accounts.length) {
      listBox.appendChild(el('div', 'hintline', 'Кабинетов нет: привязка пока не выполнена.'));
    } else {
      var host = el('div');
      rowsTable(host, [
        ['Логин'],
        ['Маска'],
        ['Статус'],
        ['Кампаний', 'num'],
        ['Подключён'],
        ['Последняя проверка'],
        ['Действия']
      ], accounts.map(function (a) {
        var loginCell = el('div');
        loginCell.appendChild(el('span', null, a.login || '—'));
        if (a.sandbox === true) {
          loginCell.appendChild(document.createTextNode(' '));
          loginCell.appendChild(badge('песочница', 'purple'));
        }

        var acts = el('div', 'chip-row');
        var chk = el('button', 'btn small', 'Проверить');
        chk.title = 'Перечитать статус токена в API Директа';
        chk.addEventListener('click', function () {
          chk.disabled = true;
          var wasChk = chk.textContent;
          chk.textContent = 'Проверяю…';
          directApi('/api/direct/accounts/check', 'POST', { id: a.id }).then(function (res) {
            if (!res || res.ok === false) throw new Error((res && res.message) || 'сервер не подтвердил проверку');
            var acc = res.account || {};
            var st = DIRECT_STATUS_TEXT[acc.status];
            toast('Кабинет ' + (acc.login || a.login || a.id) + ': ' + (st ? st[0] : 'статус не указан'));
            return reload();
          }).catch(function (e) {
            toast('Проверка не прошла: ' + e.message, 'bad');
          }).then(function () {
            chk.disabled = false;
            chk.textContent = wasChk;
          });
        });
        var del = el('button', 'btn small', 'Удалить');
        del.title = 'Удалить кабинет и его токен из локального хранилища панели';
        del.addEventListener('click', function () {
          if (!window.confirm('Удалить кабинет ' + (a.login || a.id) + '? Токен будет удалён из локального хранилища панели.')) return;
          del.disabled = true;
          var wasDel = del.textContent;
          del.textContent = 'Удаляю…';
          directApi('/api/direct/accounts/delete', 'POST', { id: a.id }).then(function (res) {
            if (res && res.ok === false) throw new Error(res.message || 'сервер отклонил удаление');
            toast('Кабинет удалён.');
            return reload();
          }).catch(function (e) {
            toast('Не удалось удалить кабинет: ' + e.message, 'bad');
          }).then(function () {
            del.disabled = false;
            del.textContent = wasDel;
          });
        });
        acts.appendChild(chk);
        acts.appendChild(del);

        return [
          loginCell,
          a.masked || 'маска недоступна',
          directStatusBadge(a.status),
          directCampaignsText(a.campaigns),
          directDateText(a.connected_at),
          directDateText(a.last_check),
          acts
        ];
      }));
      listBox.appendChild(host);
      listBox.appendChild(el('div', 'hintline', '«доступ есть» — токен проверен и работает; «токен не работает» — Яндекс отклонил токен; «не проверен» — проверка ещё не выполнялась.'));
    }
    body.appendChild(listBox);
  }

  function renderError(reason) {
    clear(body);
    setHeadBadge('список недоступен', 'grey');
    body.appendChild(note('warn', 'не удалось получить список кабинетов: ' + reason));
    body.appendChild(el('div', 'hintline',
      'Блок остаётся на месте: когда эндпоинты /api/direct/* появятся, здесь будут OAuth-приложение, ' +
      'привязка токена и список кабинетов.'));
  }

  function reload() {
    reloadBtn.disabled = true;
    return directApi('/api/direct/accounts', 'GET').then(function (doc) {
      if (!doc || doc.ok === false) throw new Error((doc && doc.message) || 'сервер вернул отказ');
      renderAccounts(doc);
    }).catch(function (e) {
      renderError(e && e.message ? e.message : 'причина неизвестна');
    }).then(function () {
      reloadBtn.disabled = false;
    });
  }

  reloadBtn.addEventListener('click', function () { flash = null; reload(); });
  reload();
  return box;
}

/* Встраивание: блок появляется только в карточке Агента 2 и только на экране агентов.
   Карточку ищем по тумблеру с data-agent-id — это надёжнее, чем совпадение по названию.
   Блок добавляется В КОНЕЦ карточки (после кнопки «Детали»), чтобы не сдвигать порядок
   кнопок, на который опирается замороженный ux-check.mjs. Исходный app.js не правится. */
(function wrapDirectAccountsCard() {
  if (typeof VIEWS === 'undefined' || !VIEWS.agentsExecutors) return;
  var orig = VIEWS.agentsExecutors;
  VIEWS.agentsExecutors = function (view) {
    orig(view);
    var sw = view.querySelector('.switch[data-agent-id="' + DIRECT_A2_ID + '"]');
    if (!sw) return;
    var card = sw.closest ? sw.closest('.agent-card') : null;
    if (!card) return;
    if (card.querySelector('[data-direct-accounts]')) return; // ровно один блок на карточку
    card.appendChild(directAccountsBlock());
  };
})();
