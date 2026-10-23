@echo off
setlocal
title SMSReminder - Frauenarztpraxis Sabrina Recker

set "NODE_EXE=C:\Users\h.kuhrt\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  set "NODE_EXE="
  for /r "%LOCALAPPDATA%\OpenAI\Codex\bin" %%F in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%F"
)

if not exist "%NODE_EXE%" (
  echo Node.js wurde nicht gefunden.
  echo Bitte Codex starten oder Node.js installieren.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo Suche nach einem freigegebenen Update ...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Mode Checkout -ApplicationDirectory "%~dp0"
if errorlevel 1 echo Update wurde uebersprungen. Details stehen im lokalen Update-Protokoll.
echo.

echo SMSReminder wird gestartet ...
echo Die Seite oeffnet sich gleich automatisch im Browser.
echo Dieses Fenster waehrend der Nutzung geoeffnet lassen.
echo Zum Beenden Strg+C druecken.
echo.

start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://127.0.0.1:4173'"
"%NODE_EXE%" --env-file=.env "src\server.js"

echo.
echo SMSReminder wurde beendet.
pause
