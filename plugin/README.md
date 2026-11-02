# dsh-marketing-skills — провайдер скилов проекта «Агенты для маркетолога недвижимости»

Локальный плагин DeepSeek Harness. Регистрирует провайдер скилов `dsh-marketing-skills` и отдаёт
агенту скилы из `marketing-agents\skills\<имя>\SKILL.md`.

## Состав

| Путь | Что это |
|---|---|
| `lib/index.js` | точка входа: `export const name`, `export function apply(ctx, config)`, провайдер |
| `cordis.patch.yml` | roster-строка для профиля (`insert -> id: marketing-skills, name: dsh-marketing-skills`) |
| `package.json` | `name: dsh-marketing-skills`, `type: module`, `main: lib/index.js`, `dsh.bundle.patch` |
| `skills/` | **сгенерированная** копия скилов проекта; создаётся установщиком из `..\skills\` |
| `README.md` | этот файл |

## Как это работает

1. DSH читает патч профиля `<profile>\cordis.patch.yml`. Наша строка `- insert: ...` подключает
   пакет `dsh-marketing-skills` из `<profile>\node_modules`.
2. Загрузчик вызывает `apply(ctx, config)`. Плагин делает мягкую инъекцию сервиса скилов:
   `ctx.inject(['skills'], (s) => s.skills.registerProvider(() => provider))`.
3. Провайдер лениво сканирует свою папку `skills\<имя>\SKILL.md`: берутся только каталоги, в которых
   есть файл `SKILL.md`. Каталоги без него пропускаются с предупреждением в stderr.
4. Из frontmatter (между `---`) читаются `name` и `description`. Если frontmatter нет — fallback:
   первый заголовок `# Заголовок` как `name` и первый абзац как `description`.
5. `get(candidate)` возвращает **сырой файл целиком, включая frontmatter** (как `dsh-review`).
6. Плагин не делает статических импортов DSH-пакетов: ранг берётся динамически из
   `BUNDLED_SKILL_RANK` (`@deepseek-ai/dsh-skill`), при неудаче — литерал `100`. Поэтому модуль
   грузится и тестируется вне профиля.

Контракт кандидата:

`@js
{
  name: 'competitor-watch',
  description: '...',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'dsh-marketing-skills',
  source: 'bundled',
  resourceBase: { kind: 'directory', path: '<абс. путь к папке скила>' },
  rank: 100,
  locator: URL('file:///.../SKILL.md')
}
`@

Необязательный ключ `config.skillsDir` и переменная окружения `DSH_MARKETING_SKILLS_DIR`
переопределяют папку скилов (используется тестами).

## Установка и переустановка

`@powershell
# обычная установка (идемпотентна)
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\install-marketing-plugin.ps1

# посмотреть, что будет сделано, ничего не меняя
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\install-marketing-plugin.ps1 -DryRun

# удалить плагин и roster-строку
powershell -NoProfile -ExecutionPolicy Bypass -File marketing-agents\install\install-marketing-plugin.ps1 -Revert
`@

Что делает установщик:

1. копирует `marketing-agents\skills\*` -> `plugin\skills\` (каждый каталог с `SKILL.md` вместе с ресурсами);
2. проверяет, что `plugin\lib\index.js` загружается и `apply()` регистрирует провайдер, и что провайдер видит все скилы;
3. копирует `plugin` -> `<profile>\node_modules\dsh-marketing-skills`;
4. добавляет **ровно одну** roster-строку `id: marketing-skills` в `<profile>\cordis.patch.yml`;
   перед правкой пишется бэкап `cordis.patch.yml.bak-marketing-<timestamp>`, после правки файл
   парсится js-yaml из профиля; при ошибке бэкап восстанавливается и установщик падает.

Повторный запуск не добавляет дубль (проверка по `id`) и не создаёт новый бэкап.
После установки **нужно перезапустить DSH** (полностью закрыть приложение — включая значок в трее).

### Обновление скилов после правок

Скилы отдаются из копии внутри плагина, поэтому после изменения `marketing-agents\skills\*`:
запустите установщик заново и перезапустите DSH. Список кандидатов кешируется на время жизни процесса.

## Проверка

`@powershell
node --test marketing-agents\tests\plugin-contract.test.mjs
`@

Тест без внешних зависимостей: поднимает `apply()` на фейковом `ctx`, проверяет, что провайдер
зарегистрирован, список непустой, у каждого скила есть `name`/`description`, папка `resourceBase`
существует, а `get(candidate).content` совпадает с файлом `SKILL.md`. Отдельно проверяются
frontmatter, fallback по заголовку, пропуск каталогов без `SKILL.md` и деградация до пустого списка.

## Диагностика

| Симптом | Причина и что делать |
|---|---|
| в stderr `no skills found under ...` | папка скилов пуста или скилы не скопированы: запустите установщик и перезапустите DSH |
| скила нет в каталоге | у каталога нет `SKILL.md`, либо имя в frontmatter совпало с другим скилом |
| `Cannot bind argument to parameter 'Path'` / кракозябры | у `install-marketing-plugin.ps1` потерян BOM: файл должен быть UTF-8 **с BOM** |
| установщик упал на валидации YAML | бэкап уже восстановлен; проверьте `cordis.patch.yml` и логи node |

## Ограничения

- Плагин отдаёт только те скилы, что лежат в его собственной папке `skills\` (копия, а не оригинал).
- Имена скилов должны быть уникальными: `name` из frontmatter — идентификатор в каталоге.
- Никаких внешних зависимостей у плагина нет и не должно появиться: только `node:*`.
