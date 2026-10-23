export class FirebirdDataSource {
  async databaseHealth() {
    throw new Error('Der Firebird-Adapter ist vorbereitet, aber ohne Datenbankdatei und Schema bewusst nicht aktiviert.');
  }

  async listZones() { return this.#notConfigured(); }
  async listAppointments() { return this.#notConfigured(); }
  async getPatientReminderContext() { return this.#notConfigured(); }
  async getReminderContextsByAppointmentIds() { return this.#notConfigured(); }
  async close() {}

  #notConfigured() {
    throw new Error('Firebird ist noch nicht konfiguriert. Bitte DB_KIND=mariadb verwenden.');
  }
}
