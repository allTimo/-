# R2 (T29) — отчёт исполнителя: русификация интерфейса dshmarket

**Teammate:** market-ru · **Задача:** task-2 · **Статус:** выполнено, 762/762 ключа (основной проход + добор)
**Правленый файл (единственный):** `C:\Users\Артем\.dsh\profiles\desktop\node_modules\dshmarket\client\client.js`
**Подробности и таблица разделов:** `marketing-agents\install\README-ui-ru-translations.md`

---

## 1. Короткая суть

У `dshmarket` **есть** штатный i18n, которого не хватало только для русского: бандл объявляет словари
`zh` / `en` / `ja` и регистрирует их через `ctx.locale.register(NS, { zh, en, ja })`, `NS = "dsh-market"`.
Язык `ru` в хосте есть (`node_modules\dsh-locale-ru\lib\client.js`:
`{"id":"ru","label":"Русский","fallback":"en"}`), но словаря `dsh-market` для него не было — поэтому при
активной локали `ru` рынок падал на английский fallback. Это и была причина «в маркете плагины на
английском», а не «отсутствие i18n».

**Сделано:** добавлен `const ru = {…}` — 762 ключа (строки 2501–3264) и он зарегистрирован:

```js
// client.js:18292
ctx.effect(() => ctx.locale.register(NS, {
    zh,
    en,
    ja,
    ru
}), "dsh-market: dictionaries");
```

Все 762 строки клиента (вкладки, кнопки, статусы, пустые состояния, подтверждения, тосты,
поиск, фильтры, настройки, подсказки, ошибки, диагностика, группы, темы, бэкапы, восстановление)
переведены. Словари `zh` и `ja` **расширены строго аддитивно на один новый ключ**
(`agentQueueTargetChanged`, добор — см. §4): ни одно существующее значение не изменено и не удалено,
что доказано сравнением с бэкапами, а не на словах.

**Зависимость (важно):** словарь `ru` работает, когда в хосте активна локаль `ru`. Сам язык `ru`
регистрирует пакет `dsh-locale-ru` (`locale.addLanguage`, задача task-1). В `dshmarket` свой
`addLanguage` намеренно не добавлен — иначе один и тот же язык регистрировался бы дважды. Если
`dsh-locale-ru` не установлен/неактивен, словарь `ru` не запрашивается: безвредно, ничего не ломает.

## 2. Числа

| Показатель | Значение |
|---|---|
| Ключей `en` / `ru` | 762 / 762 |
| `ru` без ключа из `en` (`missing`) | **0** |
| Лишних ключей в `ru` (`extra`) | **0** |
| Порядок ключей `ru` = порядок `en` | да |
| CJK в значениях `ru` | **0** |
| Несовпадений подстановок `{0}`,`{1}`,`{2}`,… `ru` vs `en` | **0** |
| Несовпадений пустых значений | **0** |
| Переводов, идентичных `en` | 5 (`readme`, `hostRequirement`=`DSH {0}`, `webdav`, `gist`, `gistSrcGh` — бренды и идентификаторы) |
| Размер файла | 925 932 → 1 007 828 байт, LF, без BOM |
| Добор аддитивен | `added=["agentQueueTargetChanged"]`, `removed=[]`, `changed values=0` — для всех четырёх словарей |

Разбивка по разделам интерфейса (18 групп, сумма 762) — в `README-ui-ru-translations.md`, там же
таблица «раздел → ключей → переведено».

### Правки видимой пунктуации вне словарей (8 штук)

Полноширинные `（…）` в трёх `overview`-строках диагностики; `.join("；")`; скобки у причин активации;
перечисление через `、` в предупреждении о namespace; полноширинное двоеточие в ошибке экспорта копии;
подпись провайдера `"坚果云 / Nutstore"`. Там, где `lang` был в области видимости, сделано
языкозависимо (`lang === "zh" ? "（" : "("`) — китайский интерфейс сохранил свою пунктуацию.
Каждая правка — адресная замена с проверкой «ровно 1 вхождение», без массовых регулярок.

## 3. Метрика CJK и сверка расхождения 23903 vs 13669

Числа различались из-за набора диапазонов — снято измерением:

| Метрика | До | После основного прохода | После добора (итог) |
|---|---|---|---|
| Han + кана `[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]` = **23903** из разведки тимлида | 23903 | 23903 | **23942** |
| Моя: CJK с пунктуацией, без каны `[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]` | 13669 | 13662 | **13675** |
| Только CJK-пунктуация/fullwidth `[\u3000-\u303F\uFF00-\uFFEF]` | 1662 | 1655 | 1658 |

Тождество подтверждено: `Han+кана+punct (25565) − punct (1662) = 23903`.

**23903** — это Han+kana, и вся масса лежит в словарях `zh` и `ja` плюс регекспы; их удаление сломало бы
китайскую и японскую локали. Поэтому метрика тимлида в основном проходе не менялась. После добора она
выросла 23903 → 23942, потому что добор **добавил** китайское и японское значения нового ключа — это
аддитивное расширение словарей, а не остаток. Пунктуация: 1662 → 1655 (основной проход, −7) → 1658 (добор, +3).

Раскладка (13 675 по моей метрике): `zh` 8670 · `ja` 4773 · `en` 0 · `ru` 0 ·
вне словарей 232 (комментарии 90/17 строк, регекспы 133/7, языкозависимая пунктуация 9/6).
Строка «двуязычная строка очереди агента — 20 CJK / 1 строка» из остатка убрана: закрыта добором.

## 4. Приёмка — команды и вывод

```text
> node --check C:\Users\Артем\.dsh\profiles\desktop\node_modules\dshmarket\client\client.js
(без вывода)  exit 0        # после вставки словаря, после правок пунктуации и после добора

> node marketing-agents\install\check-profile-bundles.mjs "C:\Users\Артем\.dsh\profiles\desktop"
package.json: parses OK
bundles: 28 (0 duplicates)
js-yaml: loaded
- dsh-review  0.1.1  patch=strict  entry=ok
- dshmarket  1.73.3  patch=strict  entry=ok
...
inserted entry ids across community bundles: 16

RESULT: OK                  exit 0
```

Проверка словарей по живому файлу (скрипт-разбор четырёх словарей):

```text
zh: keys=762 cjk_in_values=8670  (строки 200-966)
en: keys=762 cjk_in_values=0     (строки 967-1732)
ja: keys=762 cjk_in_values=4773  (строки 1733-2500)
ru: keys=762 cjk_in_values=0     (строки 2501-3264)
ru: missing_vs_en=0 extra_vs_en=0 key_order_identical_to_en=true
ru: placeholder_mismatch=[] empty_parity_ok=true
registration: true
```

**Прогон бандла в песочнице** (`vm`, заглушки внешних модулей; DSH не перезапускался) — проверяет не
текст, а фактическую регистрацию в реестре локалей:

```text
> node simulate.cjs
module id                      : dshmarket
locale.register calls          : ["dsh-market -> zh,en,ja,ru"]
dictionaries effect registered : true
languages                      : zh, en, ja, ru
ru keys                        : 762
authored ru keys               : 762
values differing from authored : 0
key order identical to en      : true   (ru order == en order in the file)
CJK in registered ru values    : 0
zh/ja still registered         : true (zh keys=762, ja keys=762)
new key ru value               : "Цель обновления изменилась, поэтому задача пропущена. Выберите обновление заново."
sample ru strings              : nav="Рынок плагинов" | tabDiscover="Исследовать" | install="Установить" | uninstalling="Удаление…" | searchPh="Поиск плагинов: уведомления, терминал, память…"

SIMULATION OK: 762 ru strings registered live, zh/ja untouched, order == en
node exit code: 0
```

### Добор (revision 7): что именно изменено и почему это аддитивно

Адресная замена, «ровно 1 вхождение»:

* `client.js:10596` было: `stale(verdict === "target-changed" ? localizeBilingual("更新目标已变化，已跳过。请重新选择更新。 / The update target changed, so this task was skipped. Choose the update again.", lang) : …)`
* `client.js:10596` стало: `stale(verdict === "target-changed" ? t("agentQueueTargetChanged") : …)`

Причина: `lang` в этой точке — бинарный `zh|en` (`client.js:10400`), поэтому `localizeBilingual` отдавал
локали `ru` английскую половину строки.

Новый ключ добавлен в **четыре** словаря вставкой новой пары после `agentQueueStaleNoUpdate`
(ни одна существующая строка не изменена и не удалена): `zh` 377, `en` 1143, `ja` 1909, `ru` 2677.

```text
=== 202604 (до добора) -> live ===
  zh: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0 | pre-existing order preserved=true
  en: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0 | pre-existing order preserved=true
  ja: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0 | pre-existing order preserved=true
  ru: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0 | pre-existing order preserved=true

=== zh/ja vs ИСХОДНЫЙ upstream-бэкап 201740 ===
  zh: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0
  ja: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0
  en: keys 761 -> 762 | added=["agentQueueTargetChanged"] | removed=[] | changed values=0
```

Значения нового ключа: `zh` — `更新目标已变化，已跳过。请重新选择更新。` (дословно из заменённого
литерала), `en` — `The update target changed, so this task was skipped. Choose the update again.`,
`ja` — `更新対象が変更されたため、このタスクはスキップされました。更新を選び直してください。`
(стиль согласован с соседними `agentQueueStale*` того же словаря), `ru` — `Цель обновления изменилась,
поэтому задача пропущена. Выберите обновление заново.`

В `stderr` этого прогона есть `[dsh-market] mounting failed … setTimeout is not defined` — артефакт
песочницы (в `vm` нет браузерных глобалов), наступает **после** проверяемой регистрации словарей.

## 5. Бэкапы и откат

| Роль | Файл |
|---|---|
| Бэкап №1 — исходный, до всех правок | `…\dshmarket\client\client.js.bak-ru-20261031-201740` (925 932 байта) |
| Бэкап №2 — промежуточный (словарь вставлен, пунктуация исходная) | `…\dshmarket\client\client.js.bak-ru-20261031-202151` (1 007 294 байта) |
| Бэкап №3 — **перед добором** (до правки словарей `zh`/`ja`) | `…\dshmarket\client\client.js.bak-ru-20261031-202604` (1 007 425 байт) |

Бэкапы создавались **до** соответствующей правки и не удалялись. Бэкап №3 — тот самый бэкап, относительно
которого доказана аддитивность добора. Откат одной командой:

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dshmarket\client\client.js.bak-ru-20261031-201740" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dshmarket\client\client.js" -Force
```

## 6. Что слетит при обновлении

Обновление/переустановка `dshmarket` (`dsh plugin add`, обновление из маркета, `pnpm install`) вернёт
оригинальный `client.js` — словарь `ru` пропадёт, рынок снова станет английским; правку надо применить
заново. `pnpm install` дополнительно вычищает каталоги в `node_modules`, не объявленные в зависимостях
профиля. **Нужен перезапуск DSH** (полностью закрыть приложение, включая трей) — перезапуск в этой
сессии не выполнялся.

## 7. Что осознанно осталось непереведённым

| # | Что | Объём | Почему |
|---|---|---|---|
| 1 | Словари `zh` и `ja` | 8670 + 4773 CJK | Не «остаток перевода», а источник для китайской и японской локалей; удаление сломает эти языки |
| 2 | Регекспы под китайские данные вендора (строки 3612, 3613, 3614, 4181–4184) | 133 CJK / 7 строк | Логика сопоставления (определение «терминального плагина», классификация скриншотов в описаниях), а не текст интерфейса |
| 3 | Комментарии внутри бандла | 90 CJK / 17 строк | Заметки разработчика (ссылки на issue, цитаты репортов); пользователю не видны, через `t()` не проходят |
| 4 | Языкозависимая пунктуация, ветка `zh` | 9 CJK / 6 строк | Для `ru`/`en`/`ja` подставляется ASCII-вариант |
| 5 | ~~Строка L10592~~ | — | **ЗАКРЫТО добором** (см. §4): строка переведена на `t("agentQueueTargetChanged")`, ключ добавлен во все четыре словаря строго аддитивно. Видимых строк, остающихся английскими при локали `ru`, в этом бандле больше нет |
| 6 | Идентификаторы/протокольные значения, похожие на английский текст (`"insert is not an array"`, `"reads credentials"`, `"duplicate loader entry id"`, `"not a parseable URL"`) | — | Это ключи сравнения с серверными кодами (`src/check.ts`) и селекторы иконок, а не подписи; перевод сломал бы сопоставление |

Также **не тронуты** (вне зоны задачи): `dshmarket\lib\**` (task-6, market-lib-ru), остальные плагины
профиля, `cordis.patch.yml`, `package.json` профиля, `node_modules\dsh-locale-ru`.

## 8. Замечания по доработке (не делалось)

* Правильное долгосрочное решение — отправить автору `dshmarket` словарь `ru` (и `locale/ru.json`):
  механизм в плагине уже есть, нужен только словарь — тогда правка переживёт обновления.
* Двуязычные серверные строки (`localizeBilingual`) в дальнейшем стоит уводить в словарь ключом, как это
  сделано добором для `agentQueueTargetChanged`: `lang` здесь бинарный `zh|en`, поэтому всё, что
  приходит как «中文 / English», для локали `ru` отдаётся по-английски.
