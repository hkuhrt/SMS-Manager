@echo off
setlocal
title MEDICAL OFFICE - SMS-Erinnerung

set "APP_DIR=%~dp0"
set "NODE_EXE=%APP_DIR%runtime\node.exe"

if not exist "%NODE_EXE%" set "NODE_EXE=C:\Users\h.kuhrt\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  echo Die lokale Node.js-Laufzeit wurde nicht gefunden.
  echo Bitte SMSReminder installieren oder Codex starten.
  pause
  exit /b 1
)

cd /d "%APP_DIR%"
"%NODE_EXE%" --env-file-if-exists=.env "bridge\medical-office.js"
if errorlevel 1 (
  echo.
  echo Die Patientenuebergabe war nicht erfolgreich.
  pause
  exit /b 1
)

exit /b 0
