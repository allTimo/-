/* Заявка с лендинга: валидация, состояние «отправляется», честный ответ,
   если сервер приёма заявок ещё не поднят (эндпоинт POST /api/lead делает задача T80).
   Никакой имитации отправки: без ответа сервера заявка не считается принятой. */
(function () {
  'use strict';

  var form = document.getElementById('lead-form');
  if (!form) return;

  var statusBox = document.getElementById('lf-status');
  var submitBtn = document.getElementById('lf-submit');
  var endpoint = form.getAttribute('data-endpoint') || '/api/lead';

  var FIELDS = ['name', 'contact', 'object', 'competitors', 'comment', 'consent'];

  function el(name) { return document.getElementById('lf-' + name); }
  function errEl(name) { return form.querySelector('[data-err-for="' + name + '"]'); }

  function setError(name, message) {
    var box = errEl(name);
    var input = el(name);
    if (box) {
      if (message) { box.textContent = message; box.hidden = false; } else { box.textContent = ''; box.hidden = true; }
    }
    if (input) {
      if (message) { input.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); }
      else { input.classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); }
    }
  }

  function digitsOnly(v) { return String(v || '').replace(/\D/g, ''); }

  function looksLikePhone(v) {
    var d = digitsOnly(v);
    return d.length >= 10 && d.length <= 15;
  }

  function looksLikeTelegram(v) {
    var s = String(v || '').trim();
    if (/^@?[A-Za-z0-9_]{5,32}$/.test(s)) return true;
    return /^(https?:\/\/)?(t\.me|telegram\.me)\/[A-Za-z0-9_]{5,32}\/?$/i.test(s);
  }

  function validate() {
    var errors = {};
    var name = el('name').value.trim();
    var contact = el('contact').value.trim();
    var object = el('object').value.trim();
    var consent = el('consent').checked;

    if (name.length < 2) errors.name = 'Укажите имя — минимум 2 символа.';
    else if (name.length > 80) errors.name = 'Слишком длинное имя — до 80 символов.';

    if (contact === '') errors.contact = 'Укажите телефон или Telegram — без этого мы не сможем ответить.';
    else if (!looksLikePhone(contact) && !looksLikeTelegram(contact)) {
      errors.contact = 'Похоже на опечатку. Телефон — 10–15 цифр (например +7 999 123-45-67), Telegram — @nickname или ссылка t.me/nickname.';
    }

    if (object.length < 2) errors.object = 'Укажите объект или ЖК — хотя бы название.';
    else if (object.length > 160) errors.object = 'Слишком длинное название — до 160 символов.';

    if (!consent) errors.consent = 'Нужно согласие на обработку данных из формы — без него заявку принять нельзя.';

    return { errors: errors, values: { name: name, contact: contact, object: object } };
  }

  function clearAll() { FIELDS.forEach(function (f) { setError(f, ''); }); }

  FIELDS.forEach(function (f) {
    var node = el(f);
    if (!node) return;
    var evt = f === 'consent' ? 'change' : 'input';
    node.addEventListener(evt, function () { setError(f, ''); });
  });

  function setStatus(kind, html) {
    statusBox.hidden = false;
    statusBox.className = 'f-status f-status--' + kind;
    statusBox.innerHTML = html;
  }

  function payloadFromForm() {
    return {
      name: el('name').value.trim(),
      contact: el('contact').value.trim(),
      object: el('object').value.trim(),
      competitors: el('competitors').value.trim(),
      comment: el('comment').value.trim(),
      consent: el('consent').checked,
      source: 'landing',
      page: location.pathname,
      sentAt: new Date().toISOString()
    };
  }

  function plainText(payload) {
    return [
      'Заявка с лендинга',
      'Имя: ' + payload.name,
      'Контакт: ' + payload.contact,
      'Объект: ' + payload.object,
      'Конкуренты: ' + (payload.competitors || '—'),
      'Комментарий: ' + (payload.comment || '—')
    ].join('\n');
  }

  function copyButton(payload) {
    var id = 'lf-copy-' + Date.now();
    setTimeout(function () {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        var text = plainText(payload);
        var done = function () { btn.textContent = 'Текст заявки скопирован'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        } else { fallbackCopy(text, done); }
      });
    }, 0);
    return '<button type="button" class="btn" id="' + id + '">Скопировать текст заявки</button>';
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ничего не поделать */ }
    document.body.removeChild(ta);
  }

  function endpointNotReady(payload) {
    setStatus('warn',
      '<b>Заявка не отправлена.</b> Приём заявок на сервере ещё не включён — эндпоинт <code>POST /api/lead</code> ' +
      'появится вместе с задачей «приём заявок» (T80). Мы сознательно не показываем «спасибо» вместо отправки: ' +
      'пока сервер не ответил, заявка нигде не сохранена и оператор её не увидит.' +
      '<div class="f-status-actions">' + copyButton(payload) + '</div>' +
      '<span class="small">Скопируйте текст заявки — он не потеряется. Как только сервер запустят, форма начнёт отправлять заявки сама.</span>');
  }

  function serverError(payload, code) {
    setStatus('warn',
      '<b>Сервер не принял заявку</b> (ответ ' + code + '). Заявка не сохранена — попробуйте ещё раз через минуту.' +
      '<div class="f-status-actions">' + copyButton(payload) + '</div>');
  }

  function networkFailure(payload) {
    setStatus('warn',
      '<b>Заявка не отправлена:</b> сервер приёма заявок не отвечает. Так бывает, если страница открыта файлом ' +
      '(<code>file://</code>) или сервер ещё не запущен. Заявка нигде не сохранена.' +
      '<div class="f-status-actions">' + copyButton(payload) + '</div>');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearAll();

    var result = validate();
    var firstBad = FIELDS.filter(function (f) { return result.errors[f]; })[0];
    if (firstBad) {
      Object.keys(result.errors).forEach(function (f) { setError(f, result.errors[f]); });
      setStatus('error', 'Проверьте поля, отмеченные выше — заявка пока не отправлена.');
      var node = el(firstBad);
      if (node && node.focus) node.focus();
      return;
    }

    var payload = payloadFromForm();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';
    setStatus('busy', 'Отправляем заявку…');

    var done = function () {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить заявку';
    };

    var finishOk = function () {
      try {
        sessionStorage.setItem('dsh-lead-name', payload.name);
        sessionStorage.setItem('dsh-lead-object', payload.object);
      } catch (e) { /* приватный режим — не критично */ }
      location.href = 'thanks.html?name=' + encodeURIComponent(payload.name);
    };

    if (typeof fetch !== 'function') {
      done();
      endpointNotReady(payload);
      return;
    }

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
    }).then(function (r) {
      done();
      if (r.res.ok && r.body && r.body.ok !== false) { finishOk(); return; }
      // 404/405/501/401 = эндпоинт ещё не реализован или закрыт ключом панели
      if (r.res.status === 404 || r.res.status === 405 || r.res.status === 501 || r.res.status === 401) { endpointNotReady(payload); return; }
      serverError(payload, r.res.status);
    }).catch(function () {
      done();
      networkFailure(payload);
    });
  });
})();
