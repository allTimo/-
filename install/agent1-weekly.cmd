@echo off
rem ============================================================================
rem  Недельный прогон Агента 1 «Мониторинг конкурентов» (четверг, 11:00).
rem  Запускается Планировщиком задач Windows через install/agent1-weekly-task.ps1.
rem
rem  Что делает: находит Python, запускает реальный сбор по всем клиентам
rem  (collect_clients.py: сбор -> снимок -> diff -> отчёт клиента -> журналы),
rem  пишет лог в marketing-agents\logs\agent1-weekly.log и возвращает код выхода.
rem
rem  Почему не run_weekly.ps1: тот сам данные не собирает и падает, если снимка
rem  на сегодня ещё нет (exit 2). Сбор живёт в collect_clients.py.
rem ============================================================================
setlocal EnableExtensions

set "MADIR=%~dp0.."
set "PY=%MADIR%\connectors\ru-marketplace-mcp\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%MADIR%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=py"

if not exist "%MADIR%\logs" mkdir "%MADIR%\logs" 2>nul

pushd "%MADIR%\.."
echo [%DATE% %TIME%] --- старт недельного прогона Агента 1 (python: %PY%) --->> "%MADIR%\logs\agent1-weekly.log"
"%PY%" "%MADIR%\01-competitor-watch\scripts\collect_clients.py" --email-mode always >> "%MADIR%\logs\agent1-weekly.log" 2>&1
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] --- конец, код %RC% --->> "%MADIR%\logs\agent1-weekly.log"
popd

exit /b %RC%
