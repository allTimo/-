# inbox\text — сюда кладём готовый текст

Что подходит: расшифровка из Телемоста, заметки после встречи, пересказ голосового.
Форматы: .txt или .md в UTF-8. Один файл = одна встреча.

Имя файла: любое, например 2026-10-31-planirovka.txt. Если файл получен из аудио,
допустимо имя <имя>.voice.txt — тогда источник задач будет telemost-voice, иначе telemost-text.

Дальше:

    powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\scripts\run_intake.ps1 -Date 2026-10-31

Задачи появятся в marketing-agents\registry\tasks\<YYYY-MM>.yaml.
