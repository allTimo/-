# inbox\audio — сюда кладём запись встречи или голосовое

Поддерживаются: wav, mp3, m4a, ogg, opus, aac, flac, wma, mp4, mkv, webm, mov.

Что произойдёт при запуске run_intake.ps1:

1. если рядом с аудио уже лежит одноимённый .txt — он считается расшифровкой;
2. иначе вызывается внешний ASR, если он задан (-Command или CW_ASR_COMMAND);
3. иначе рядом появится <имя>.pending.md с объяснением и инструкциями.

Автоматической локальной расшифровки русских записей на этой машине нет: движок DSH
(SenseVoice) понимает только auto, zh, en, yue, ja, ko. Подробности — в ../README.md.

Проверить, что нашлось на машине:

    powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\scripts\transcribe.ps1 -Check
