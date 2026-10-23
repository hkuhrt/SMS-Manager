-- Als MariaDB-Administrator ausführen und das Beispielkennwort vorher ersetzen.
-- Die Anwendung benötigt ausschließlich SELECT auf Termin-, Patienten- und Markiertabellen.

CREATE USER IF NOT EXISTS 'smsreminder_reader'@'localhost'
  IDENTIFIED BY 'BITTE_EIN_SICHERES_PASSWORT_SETZEN';
CREATE USER IF NOT EXISTS 'smsreminder_reader'@'127.0.0.1'
  IDENTIFIED BY 'BITTE_EIN_SICHERES_PASSWORT_SETZEN';

GRANT SELECT ON medoff.termin TO 'smsreminder_reader'@'localhost';
GRANT SELECT ON medoff.patstamm TO 'smsreminder_reader'@'localhost';
GRANT SELECT ON medoff.tzone TO 'smsreminder_reader'@'localhost';
GRANT SELECT ON medoff.patmark TO 'smsreminder_reader'@'localhost';
GRANT SELECT ON medoff.markier TO 'smsreminder_reader'@'localhost';

GRANT SELECT ON medoff.termin TO 'smsreminder_reader'@'127.0.0.1';
GRANT SELECT ON medoff.patstamm TO 'smsreminder_reader'@'127.0.0.1';
GRANT SELECT ON medoff.tzone TO 'smsreminder_reader'@'127.0.0.1';
GRANT SELECT ON medoff.patmark TO 'smsreminder_reader'@'127.0.0.1';
GRANT SELECT ON medoff.markier TO 'smsreminder_reader'@'127.0.0.1';

FLUSH PRIVILEGES;

