# MEDICAL OFFICE SMS Reminder

Lokale Web-App zum sicheren Vorbereiten von Terminerinnerungen aus MEDICAL OFFICE. Die Anwendung liest die MariaDB ausschließlich mit einem eigenen `SELECT`-Benutzer und läuft derzeit sichtbar im **Testmodus**: Ein Versand wird protokolliert, aber es wird keine echte SMS übertragen.

## Aktueller Funktionsumfang

- Kalenderansicht mit einem Standardzeitraum von sieben Tagen
- paginierte Terminliste mit wahlweise 10, 20 oder 50 Einträgen pro Seite
- ausschließlich `patstamm.FTelefonmobil`, kein Rückgriff auf Privat- oder Dienstnummern
- SMS-Freigabe über den Patientenmarker `SMS-Erinnerung erlaubt`
- MEDICAL-OFFICE-Button für den aktuell geöffneten Patienten über `AKTPAT.TXT`
- Einzelpatienten-Ansicht mit bis zu 365 Tagen Vorschau und vorausgewähltem nächstem Termin
- großer Prüfdialog mit Patientin, Terminzeit, maskierter Zielnummer sowie Demo- und Wiederholungskennzeichnung
- lokaler SMS-Vorlagenmanager mit bis zu 20 Vorlagen, geschützter Standardvorlage und den Platzhaltern `{datum}` und `{uhrzeit}`
- atomarer Doppelversandschutz je Termin und Versandmodus für 90 Tage, zusätzlich zur Idempotenzkennung
- einzeln und zweistufig bestätigbare Wiederholungen, die im Protokoll markiert werden
- teilfehlertoleranter Sammelversand: Erfolge bleiben protokolliert, Fehler und nicht versuchte Termine werden wieder freigegeben
- lokale SQLite-Historie mit automatischer, rückwärtskompatibler Migration und Löschung nach 90 Tagen
- keine Namen, vollständigen Telefonnummern oder Nachrichtentexte in der Historie
- vorbereitete Datenquellen-Grenze für einen späteren Firebird-Adapter
- lokale Testzone mit 25 vollständig erfundenen Musterterminen an einem Tag; nur im Mockmodus und ohne Schreibzugriff auf MEDICAL OFFICE

## Schnellstart

1. `SMSReminder starten.cmd` doppelt anklicken.
2. Im Browser `http://127.0.0.1:4173` öffnen.
3. Das Konsolenfenster während der manuellen Nutzung geöffnet lassen.

Die App verwendet die lokale `.env`. Datenbankkennwörter und die erzeugte Integrationskennung sind von Git ausgeschlossen.

## MEDICAL-OFFICE-Marker einrichten

In MEDICAL OFFICE einmal einen Patientenmarker mit dem **exakten Namen** `SMS-Erinnerung erlaubt` anlegen. Die App ermittelt dessen interne ID automatisch. Nur Patienten, bei denen dieser Marker gesetzt ist, sind auswählbar.

Der Marker ist nur das technische Freigabesignal. Der eigentliche Einwilligungsnachweis bleibt wie vorgesehen in der Patientenakte.

## MEDICAL-OFFICE-Button einrichten

1. In der MEDICAL-OFFICE-Datenpflege ein externes Programm anlegen.
2. Als Programm `MEDICAL OFFICE SMS.cmd` aus diesem Projekt beziehungsweise nach Dienstinstallation aus `C:\ProgramData\PraxisRecker\SMSReminder` auswählen.
3. **Text-Export** aktivieren. MEDICAL OFFICE erzeugt dadurch vor dem Start `C:\MEDOFF\AKTPAT.TXT`.
4. Das externe Programm als Button an der gewünschten Stelle in MEDICAL OFFICE hinterlegen.

Der Helfer akzeptiert nur eine höchstens 30 Sekunden alte Datei und liest ausschließlich die numerische Patientennummer aus der ersten Zeile. Der Browser erhält nur eine zufällige, fünf Minuten gültige Übergabe-ID; Namen, Telefonnummern und Patientennummern stehen nicht in der URL.

## API

- `GET /api/health` – Datenbank-, Marker- und Testmodusstatus
- `GET /api/session` – flüchtige CSRF-Kennung und neutrale SMS-Vorlage
- `GET /api/appointments?from=JJJJ-MM-TT&to=JJJJ-MM-TT&zone=ID` – Kalenderansicht
- `GET /api/templates` sowie `POST/PUT/DELETE /api/templates` – lokale Vorlagenverwaltung
- `POST /api/integrations/medical-office/selections` – authentifizierte Übergabe des lokalen Helfers
- `GET /api/integrations/medical-office/selections/:launchId` – Einzelpatienten-Kontext
- `POST /api/reminders/single` – manuell bestätigter Einzel-Testversand
- `POST /api/reminder-batches` – manuell bestätigter Sammel-Testversand; optionale Wiederholungen über `resendAppointmentIds`
- `GET /api/history` – minimierte lokale Historie

Schreibende Browser-Endpunkte verlangen einen gültigen lokalen Origin, CSRF-Header, JSON und eine Idempotenzkennung. Zusätzlich reserviert SQLite jeden Termin atomar; eine neue Idempotenzkennung umgeht die 90-Tage-Sperre nicht. Verwaiste Reservierungen werden nach 15 Minuten freigegeben. Test- und spätere Echtversände besitzen getrennte Sperren. Der Integrationsendpunkt verwendet eine separat erzeugte lokale Schlüsseldatei.

## Sicherheitsmodell

- Bindung ausschließlich an `127.0.0.1`
- fester SQL-Code und zusätzliche Read-only-Transaktionen
- MariaDB-Benutzer `smsreminder_reader` mit `SELECT` nur auf `termin`, `patstamm`, `tzone`, `patmark` und `markier`
- maskierte Telefonnummern in Browser und Historie
- keine Cloud-Dienste, Analyse-Skripte oder externen Ressourcen
- Request-Größenlimit, Rate-Limit, Host-/Origin-Prüfung, CSP und CSRF-Schutz
- neutraler, serverseitig festgelegter Nachrichtentext ohne Fachrichtung, Diagnose oder Patientenname
- echter SMS-Anbieter technisch gesperrt; ausschließlich `SMS_MODE=mock` ist zulässig

## Windows-Dienst

Für den automatischen Start ist eine WinSW-Konfiguration enthalten.

1. `WinSW-x64.exe` aus der offiziellen WinSW-2.12-Version nach `tools\WinSW-x64.exe` legen.
2. Eine eventuell manuell gestartete SMSReminder-Konsole schließen.
3. PowerShell als Administrator öffnen.
4. `powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-service.ps1` ausführen.

Das Skript kopiert App und Node-Laufzeit nach `C:\ProgramData\PraxisRecker\SMSReminder`, beschränkt die Windows-Dateirechte, installiert `PraxisReckerSMSReminder` als `LocalService`, startet den Dienst und legt eine Desktop-Verknüpfung an.

## Konfiguration

Siehe `.env.example`. Wichtige Werte:

- `CONSENT_MARKER_TEXT`: exakter MEDICAL-OFFICE-Markername
- `MO_AKTPAT_PATH`: lokale Text-Export-Datei
- `MO_INTEGRATION_KEY_FILE`: automatisch erzeugte Integrationskennung
- `DATA_DIR`: SQLite-Historie und Dienstprotokolle
- `HISTORY_RETENTION_DAYS`: standardmäßig 90 Tage
- `SINGLE_PATIENT_LOOKAHEAD_DAYS`: standardmäßig 365 Tage
- `SMS_MODE`: bleibt bis zur bewussten Anbieterentscheidung auf `mock`

## Tests

```powershell
node --test
```

Die Tests decken AKTPAT-Parsing und Frischeprüfung, kurzlebige Übergaben, API-Authentifizierung, CSRF, Datenminimierung, Mobilnummern-Normalisierung, Idempotenz, atomare Terminreservierungen, getrennte Versandmodi, Wiederholungen, Teilfehler und die SQLite-Historie ab.

Für einen Oberflächentest im Kalender die Zone `TEST · 25 Mustertermine` auswählen. Die Termine werden für das im Feld „Von“ gewählte Datum erzeugt. 20 Einträge sind auswählbar, drei besitzen absichtlich keine Mobilnummer und zwei keine SMS-Freigabe. Es werden keine Datensätze in MEDICAL OFFICE angelegt oder verändert.
