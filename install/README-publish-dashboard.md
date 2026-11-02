# Публичная тестовая копия дашборда (только чтение)

Короткий ответ: **как запустить с телефона** — `publish-dashboard.ps1 -Start`, затем открыть напечатанный
`https://<random>.lhr.life` в браузере телефона. Ссылка живёт, пока работает процесс туннеля, и меняется
при каждом новом запуске.

## Что публикуется

* `publish/build-publish.mjs` копирует статику дашборда (`dashboard/public/**`) в `publish/site/`,
  собирает агрегат `data/state.json` и `data/state.js` (те же данные, вшитые как `window.__DASHBOARD_DATA__`)
  и дописывает в `index.html` баннер «Тестовая копия • только просмотр • данные на <дата/время>».
* Публичная копия — **только статические файлы**. Никакого серверного API и никакой записи:
  приложение само отключает правку реестра и пересборку данных в режиме STANDALONE
  (`if (STANDALONE)` в `dashboard/public/app.js`), а наш статический сервер отдаёт только GET/HEAD
  и на любой POST/PUT/DELETE и на `/api/*` отвечает 405/404.
* Секретов нет: сборка заканчивается «секретным шлюзом» — ищет значения ключей (`sk-…`, присваивания
  `*_API_KEY=…`, `Bearer …`, пути к `.credentials.yaml`, длинные хекс-блобы, JSON-поля `apiKey/token/secret`)
  в каждом публикуемом файле. При находке сборка падает (exit 2) и пишет `publish/scan-report.json`.
  Упоминания имён переменных и булевы флаги («ключ есть/нет») допустимы и остаются.
* В `publish/scan-report.json` видно, что именно проверялось; там же встречаемость слов
  ZVENOAI/SERPER/SANDBASE/TOKEN — это имена переменных и метрики токенов, не значения.

## Команды

powershell```
$s = "C:\Users\Артем\Desktop\тестDH\marketing-agents\install\publish-dashboard.ps1"

# поднять (по умолчанию -Tunnel auto: pinggy -> localhost.run -> serveo -> lan)
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start

# конкретный провайдер
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel localhostrun
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel pinggy
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel serveo
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel cloudflared
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel lan

# что с публикацией (жив ли сервер и туннель, последний адрес, отвечает ли он)
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Status

# погасить и сервер, и туннель
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Stop

# пересобрать статику и заново опубликовать
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Rebuild
```

Адрес сохраняется в `publish/last-url.txt`, состояние процессов — в `publish/run-state.json`,
логи — в `publish/logs/`. Адрес попадает в `last-url.txt` **только** после фактической проверки:
`Invoke-WebRequest` по публичной ссылке вернул 200 и в HTML есть русский заголовок дашборда.

## Проверено 31.10.2026 (сеть этого провайдера)

| Провайдер | Результат |
|---|---|
| **localhost.run** (`ssh -R 80:127.0.0.1:8899 nokey@localhost.run`) | **работает**: `https://<random>.lhr.life`, снаружи 200, заголовок и баннер на месте |
| pinggy через 443 (`ssh -p 443 -R0:127.0.0.1:8899 a.pinggy.io`) | SSH-соединение устанавливается, но адрес в выводе не появляется за 45 с — как рабочий вариант не подтверждён |
| serveo.net | не проверялся в этой сессии (оставлен в порядке попыток) |
| cloudflared quick tunnel | **заблокирован**: `Post https://api.trycloudflare.com/tunnel: context deadline exceeded`; DNS и TCP открыты, а сам HTTPS-запрос к API не проходит. Оставлен как опция `-Tunnel cloudflared` |
| LAN-режим | без туннеля: сервер на `0.0.0.0:8899`, адрес вида `http://<локальный-IP>:8899` |

Важно про `-R` и IPv6: на этой машине IPv6 не работает, поэтому в проброс идёт именно
`127.0.0.1:8899`, а не `localhost:8899` (с `localhost` проброс давал 502).

## Режим LAN (телефон в той же Wi-Fi)

powershell```
# 1) поднять сервер на 0.0.0.0 и получить адрес
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Start -Tunnel lan

# 2) если телефон не открывает — разрешить порт в брандмауэре Windows (нужны права администратора)
New-NetFirewallRule -DisplayName "Dashboard 8899 (LAN test)" -Direction Inbound -Protocol TCP -LocalPort 8899 -Action Allow
# убрать правило после теста:
Remove-NetFirewallRule -DisplayName "Dashboard 8899 (LAN test)"
```

LAN-адрес работает только для устройств в той же сети; из интернета он недоступен.

## Что помнить про безопасность и срок жизни ссылки

* Ссылка **временная**: при каждом `-Start` туннель получает новый случайный адрес.
* Ссылку **видит любой**, кому вы её передали — авторизации нет, но и записи нет: только чтение.
* Данные в публичной копии — снимок на момент сборки; кнопка «Обновить данные» в тестовой копии
  не пересобирает данные (так задумано), для свежих данных: `-Start -Rebuild`.
* `-Stop` гасит и статический сервер, и ssh-туннель (плюс подчищает осиротевшие процессы).
* Не публикуйте эту копию на постоянной основе: она для быстрого просмотра с телефона.
