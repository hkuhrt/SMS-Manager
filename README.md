# MEDICAL OFFICE RCS/SMS Reminder

Lokale Web-App zum sicheren Vorbereiten von Terminerinnerungen aus MEDICAL OFFICE. Die Anwendung liest die MariaDB ausschließlich mit einem eigenen `SELECT`-Benutzer. Im Standard läuft sie sichtbar im **Testmodus**. Für den Echtbetrieb ist seven als RCS-/SMS-Anbieter integriert: RCS wird nur bei eigener RCS-Einwilligung verwendet und enthält immer einen expliziten SMS-Fallback.

## Aktueller Funktionsumfang

- Kalenderansicht mit einem Standardzeitraum von sieben Tagen
- separate Erinnerungsseite für Auswahlprüfung, Vorlagenwahl und bewusste Versandbestätigung
- paginierte Terminliste mit wahlweise 10, 20 oder 50 Einträgen pro Seite
- einheitliche, responsive Navigation für Termine, Protokoll und Einstellungen
- lokal gespeicherte Bedienoptionen für Zeitraum, Seitengröße, bevorzugte Zone und automatisches Laden
- eigener Einstellungsbereich für den RCS-/SMS-Versandstatus mit sicherer Konfigurationsübersicht und manuellem, rein lesendem seven-Verbindungstest
- ausschließlich `patstamm.FTelefonmobil`, kein Rückgriff auf Privat- oder Dienstnummern
- getrennte Freigaben: `SMS-Erinnerung erlaubt` für reinen SMS-Versand und `RCS-Erinnerung mit SMS-Fallback erlaubt` für RCS mit SMS-Fallback
- MEDICAL-OFFICE-Button für den aktuell geöffneten Patienten über `AKTPAT.TXT`
- Einzelpatienten-Ansicht mit bis zu 365 Tagen Vorschau und vorausgewähltem nächstem Termin
- großer Prüfdialog mit Patientin, Terminzeit, maskierter Zielnummer sowie Demo- und Wiederholungskennzeichnung
- lokaler Nachrichtenvorlagenmanager mit bis zu 20 Vorlagen, geschützter Standardvorlage und den Platzhaltern `{datum}` und `{uhrzeit}`
- Begrenzung jeder gerenderten Nachricht auf einen SMS-Fallback-Teil (160 GSM-7-Zeicheneinheiten oder 70 Unicode-Zeichen)
- atomarer Doppelversandschutz je Termin und Versandmodus für 90 Tage, zusätzlich zur Idempotenzkennung
- einzeln und zweistufig bestätigbare Wiederholungen, die im Protokoll markiert werden
- teilfehlertoleranter Sammelversand: Erfolge bleiben protokolliert, sichere Ablehnungen und nicht versuchte Termine werden wieder freigegeben
- konservative Timeout-Behandlung: Ein unklarer Versand bleibt gegen Wiederholung gesperrt und wird über das seven-Versandjournal abgeglichen
- lokale SQLite-Historie mit automatischer, rückwärtskompatibler Migration und Löschung nach 90 Tagen
- keine Namen, vollständigen Telefonnummern oder Nachrichtentexte in der Historie
- vorbereitete Datenquellen-Grenze für einen späteren Firebird-Adapter
- lokale Testzone mit 25 vollständig erfundenen Musterterminen an einem Tag; nur im Mockmodus und ohne Schreibzugriff auf MEDICAL OFFICE

## Schnellstart

1. `SMSReminder starten.cmd` doppelt anklicken.
2. Im Browser `http://127.0.0.1:4173` öffnen.
3. Das Konsolenfenster während der manuellen Nutzung geöffnet lassen.

Die App verwendet die lokale `.env`. Datenbankkennwörter und die erzeugte Integrationskennung sind von Git ausgeschlossen.

Vor jedem manuellen Start wird nach einem stabilen GitHub-Release gesucht. Nur ein sauberer `main`-Checkout wird per Fast-Forward aktualisiert. Bei lokalen Änderungen oder fehlendem Internet startet die vorhandene Version weiter; Details stehen in `data\update.log`.

## MEDICAL-OFFICE-Marker einrichten

In MEDICAL OFFICE zwei Patientenmarker mit den **exakten Namen** aus der `.env` anlegen:

- `SMS-Erinnerung erlaubt`: bestehende oder neue Einwilligung ausschließlich für SMS
- `RCS-Erinnerung mit SMS-Fallback erlaubt`: Einwilligung für RCS einschließlich automatischem SMS-Fallback

Der RCS-Marker hat beim Versand Vorrang. Der vorhandene SMS-Marker wird aus Sicherheitsgründen nicht als RCS-Einwilligung interpretiert. Ist keiner der beiden Marker gesetzt, bleibt der Termin gesperrt.

Die Marker sind nur technische Freigabesignale. Die informierte Einwilligung, der Hinweis auf die beteiligten Dienste und der eigentliche Nachweis bleiben wie vorgesehen in der Patientenakte.

## seven-Echtbetrieb aktivieren

1. Bei seven einen RCS-Agenten anlegen, mit Testnummern prüfen und für den produktiven Betrieb freigeben lassen.
2. Einen API-Schlüssel mit den minimal benötigten Berechtigungen `rcs`, `sms` und `journal` anlegen; wenn möglich zusätzlich eine IP-Beschränkung verwenden.
3. Mit seven einen Auftragsverarbeitungsvertrag abschließen und die Datenschutzinformation für RCS/SMS prüfen.
4. In der lokalen `.env` `SEVEN_API_KEY`, `SEVEN_RCS_AGENT_ID` und `SEVEN_SMS_SENDER` setzen.
5. Erst nach abgeschlossenem Test `MESSAGE_MODE=seven` setzen und den Dienst neu starten.

Der API-Schlüssel wird weder an den Browser gegeben noch protokolliert. Der Versandtext bleibt neutral und enthält keinen Namen, keine Diagnose und keine Fachrichtung. Interaktive RCS-Antworten sind in dieser Stufe bewusst nicht aktiviert, weil die Anwendung ausschließlich auf dem lokalen Rechner lauscht und keinen öffentlichen Webhook-Endpunkt bereitstellt.

## MEDICAL-OFFICE-Button einrichten

1. In der MEDICAL-OFFICE-Datenpflege ein externes Programm anlegen.
2. Als Programm `MEDICAL OFFICE SMS.cmd` aus diesem Projekt beziehungsweise nach Dienstinstallation aus `C:\ProgramData\PraxisRecker\SMSReminder` auswählen.
3. **Text-Export** aktivieren. MEDICAL OFFICE erzeugt dadurch vor dem Start `C:\MEDOFF\AKTPAT.TXT`.
4. Das externe Programm als Button an der gewünschten Stelle in MEDICAL OFFICE hinterlegen.

Der Helfer akzeptiert nur eine höchstens 30 Sekunden alte Datei und liest ausschließlich die numerische Patientennummer aus der ersten Zeile. Der Browser erhält nur eine zufällige, fünf Minuten gültige Übergabe-ID; Namen, Telefonnummern und Patientennummern stehen nicht in der URL.

## API

- `GET /api/health` – Datenbank-, Marker- und Versandmodusstatus
- `GET /api/update-status` – lokale App-Version und letzter automatischer Update-Status
- `GET /api/session` – flüchtige CSRF-Kennung, Versandmodus und neutrale Nachrichtenvorlage
- `GET/PUT /api/settings` – harmlose, lokal gespeicherte Bedienoptionen und lesbarer Systemstatus
- `POST /api/messaging/test` – geschützter, rein lesender Test von RCS-Agent und Versandjournal; versendet keine Nachricht und gibt keine Zugangsdaten zurück
- `GET /api/appointments?from=JJJJ-MM-TT&to=JJJJ-MM-TT&zone=ID` – Kalenderansicht
- `GET /api/templates` sowie `POST/PUT/DELETE /api/templates` – lokale Vorlagenverwaltung
- `POST /api/integrations/medical-office/selections` – authentifizierte Übergabe des lokalen Helfers
- `GET /api/integrations/medical-office/selections/:launchId` – Einzelpatienten-Kontext
- `POST /api/reminders/single` – manuell bestätigter Einzelversand
- `POST /api/reminder-batches` – manuell bestätigter Sammelversand; optionale Wiederholungen über `resendAppointmentIds`
- `GET /api/history` – minimierte lokale Historie

Schreibende Browser-Endpunkte verlangen einen gültigen lokalen Origin, CSRF-Header, JSON und eine Idempotenzkennung. Zusätzlich reserviert SQLite jeden Termin atomar; eine neue Idempotenzkennung umgeht die 90-Tage-Sperre nicht. Verwaiste Reservierungen werden nach 15 Minuten freigegeben. Test- und Echtversände besitzen getrennte Sperren; ein Wechsel zwischen RCS und SMS kann die Echtversandsperre nicht umgehen. Der Integrationsendpunkt verwendet eine separat erzeugte lokale Schlüsseldatei.

## Sicherheitsmodell

- Bindung ausschließlich an `127.0.0.1`
- fester SQL-Code und zusätzliche Read-only-Transaktionen
- MariaDB-Benutzer `smsreminder_reader` mit `SELECT` nur auf `termin`, `patstamm`, `tzone`, `patmark` und `markier`
- maskierte Telefonnummern in Browser und Historie
- keine externen Ressourcen oder Analyse-Skripte im Browser; im Echtbetrieb verlässt ausschließlich die Zielnummer mit dem neutralen Nachrichtentext den Rechner in Richtung seven
- Request-Größenlimit, Rate-Limit, Host-/Origin-Prüfung, CSP und CSRF-Schutz
- neutraler, serverseitig festgelegter Nachrichtentext ohne Fachrichtung, Diagnose oder Patientenname
- API-Schlüssel ausschließlich in der lokalen, zugriffsbeschränkten `.env`; keine Secrets in Browserantworten oder Protokollen
- expliziter SMS-Fallback statt Webview-Fallback und Statusabgleich über das seven-Versandjournal

## Windows-Dienst

Für den automatischen Start ist eine WinSW-Konfiguration enthalten.

1. `WinSW-x64.exe` aus der offiziellen WinSW-2.12-Version nach `tools\WinSW-x64.exe` legen.
2. Eine eventuell manuell gestartete SMSReminder-Konsole schließen.
3. PowerShell als Administrator öffnen.
4. `powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-service.ps1` ausführen.

Das Skript kopiert App und Node-Laufzeit nach `C:\ProgramData\PraxisRecker\SMSReminder`, beschränkt die Windows-Dateirechte, installiert `PraxisReckerSMSReminder` als `LocalService`, startet den Dienst und legt eine Desktop-Verknüpfung an.

Zusätzlich wird die SYSTEM-Aufgabe `PraxisReckerSMSReminderUpdate` eingerichtet. Sie prüft zwei Minuten nach dem Windows-Start und täglich um 03:00 Uhr auf stabile Releases. Programmdateien werden erst nach erfolgreicher Prüfsummen- und Manifestprüfung ausgetauscht. `.env`, `data`, Node-Laufzeit und WinSW bleiben erhalten; ein fehlgeschlagener Versionscheck stellt die vorherige Version wieder her.

## Updates veröffentlichen

1. Die Version in `package.json` erhöhen und die Änderung nach `main` pushen.
2. Einen passenden Tag setzen, beispielsweise `git tag v0.3.0`.
3. Den Tag mit `git push origin v0.3.0` veröffentlichen.

Der GitHub-Workflow führt alle Tests aus, erzeugt ein geprüftes Release-ZIP samt SHA-256-Datei und veröffentlicht das stabile Release. Tags und Paketversion müssen exakt übereinstimmen. Vorabversionen und Downgrades werden vom Updater ignoriert.

## Konfiguration

Siehe `.env.example`. Wichtige Werte:

- `SMS_CONSENT_MARKER_TEXT`: exakter MEDICAL-OFFICE-Marker für reinen SMS-Versand; der alte Name `CONSENT_MARKER_TEXT` bleibt kompatibel
- `RCS_CONSENT_MARKER_TEXT`: exakter MEDICAL-OFFICE-Marker für RCS mit SMS-Fallback
- `MO_AKTPAT_PATH`: lokale Text-Export-Datei
- `MO_INTEGRATION_KEY_FILE`: automatisch erzeugte Integrationskennung
- `DATA_DIR`: SQLite-Historie und Dienstprotokolle
- `HISTORY_RETENTION_DAYS`: standardmäßig 90 Tage
- `SINGLE_PATIENT_LOOKAHEAD_DAYS`: standardmäßig 365 Tage
- `MESSAGE_MODE`: `mock` oder nach vollständiger Einrichtung `seven`; der alte Name `SMS_MODE` bleibt kompatibel
- `SEVEN_API_KEY`: lokaler seven-API-Schlüssel
- `SEVEN_RCS_AGENT_ID`: freigegebene RCS-Agent-ID
- `SEVEN_SMS_SENDER`: SMS-Absender mit höchstens 11 alphanumerischen oder 16 numerischen Zeichen
- `SEVEN_RCS_TTL_MINUTES`: Gültigkeit einer RCS-Nachricht, standardmäßig 60 Minuten
- `SEVEN_STATUS_SYNC_MINUTES`: Intervall für den Journalabgleich, standardmäßig 5 Minuten
- `AUTO_UPDATE`: standardmäßig `true`; mit `false` werden automatische Updateprüfungen vollständig deaktiviert

## Tests

```powershell
node --test
```

Die Tests decken AKTPAT-Parsing und Frischeprüfung, kurzlebige Übergaben, API-Authentifizierung, CSRF, Datenminimierung, Mobilnummern-Normalisierung, Idempotenz, atomare Terminreservierungen, getrennte Versandmodi und Einwilligungen, den seven-RCS-/SMS-Adapter, SMS-Fallbacks, unklare Providerzustände, Wiederholungen, Teilfehler, die SQLite-Historie sowie Versions- und Releasevalidierung ab.

Für einen Oberflächentest im Kalender die Zone `TEST · 25 Mustertermine` auswählen. Die Termine werden für das im Feld „Von“ gewählte Datum erzeugt. 20 Einträge sind auswählbar: zehn simulieren eine RCS-Freigabe und zehn eine reine SMS-Freigabe. Drei Einträge besitzen absichtlich keine Mobilnummer und zwei keine Freigabe. Es werden keine Datensätze in MEDICAL OFFICE angelegt oder verändert.
