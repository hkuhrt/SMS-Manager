const state = {
  csrfToken: '',
  templates: [],
  editingTemplateId: null,
  deleteTemplateArmed: false,
  maxTemplates: 20,
  messaging: null,
};

const elements = {
  form: document.querySelector('#settings-form'),
  defaultRangeDays: document.querySelector('#default-range-days'),
  appointmentsPerPage: document.querySelector('#appointments-per-page'),
  preferredZone: document.querySelector('#preferred-zone'),
  autoLoad: document.querySelector('#auto-load'),
  saveSettings: document.querySelector('#save-settings'),
  settingsMessage: document.querySelector('#settings-message'),
  templateList: document.querySelector('#template-list'),
  newTemplate: document.querySelector('#new-template-button'),
  templateName: document.querySelector('#template-name'),
  templateBody: document.querySelector('#template-body'),
  templateCharacterCount: document.querySelector('#template-character-count'),
  templateError: document.querySelector('#template-error'),
  saveTemplate: document.querySelector('#save-template-button'),
  defaultTemplate: document.querySelector('#default-template-button'),
  deleteTemplate: document.querySelector('#delete-template-button'),
  systemDatabase: document.querySelector('#system-database'),
  systemDatabaseDetail: document.querySelector('#system-database-detail'),
  systemMarker: document.querySelector('#system-marker'),
  systemMarkerName: document.querySelector('#system-marker-name'),
  systemMode: document.querySelector('#system-mode'),
  systemLocal: document.querySelector('#system-local'),
  systemRetention: document.querySelector('#system-retention'),
  systemVersion: document.querySelector('#system-version'),
  messagingReadiness: document.querySelector('#messaging-readiness'),
  messagingMode: document.querySelector('#messaging-mode'),
  messagingModeDetail: document.querySelector('#messaging-mode-detail'),
  messagingApiKey: document.querySelector('#messaging-api-key'),
  messagingAgent: document.querySelector('#messaging-agent'),
  messagingAgentDetail: document.querySelector('#messaging-agent-detail'),
  messagingSender: document.querySelector('#messaging-sender'),
  messagingFallback: document.querySelector('#messaging-fallback'),
  messagingFallbackDetail: document.querySelector('#messaging-fallback-detail'),
  messagingSync: document.querySelector('#messaging-sync'),
  messagingSyncDetail: document.querySelector('#messaging-sync-detail'),
  messagingSmsMarker: document.querySelector('#messaging-sms-marker'),
  messagingSmsMarkerName: document.querySelector('#messaging-sms-marker-name'),
  messagingRcsMarker: document.querySelector('#messaging-rcs-marker'),
  messagingRcsMarkerName: document.querySelector('#messaging-rcs-marker-name'),
  messagingTest: document.querySelector('#test-messaging-connection'),
  messagingTestResult: document.querySelector('#messaging-test-result'),
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || 'Unbekannter Fehler', response.status);
  return body;
}

function mutationOptions(method, body = {}) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken },
    body: JSON.stringify(body),
  };
}

function showSettingsMessage(text = '', error = false) {
  elements.settingsMessage.hidden = !text;
  elements.settingsMessage.className = `form-message${error ? ' error' : ' success'}`;
  elements.settingsMessage.textContent = text;
}

function formatDateTime(value) {
  if (!value) return 'Noch nicht ausgeführt';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' })
    .format(new Date(value));
}

function setStatus(element, text, status = '') {
  element.textContent = text;
  element.className = status ? `status-${status}` : '';
}

function setMessagingReadiness(title, detail, status) {
  elements.messagingReadiness.className = `messaging-readiness status-${status}`;
  elements.messagingReadiness.querySelector('strong').textContent = title;
  elements.messagingReadiness.querySelector('span').textContent = detail;
}

function renderMessagingConfiguration(messaging) {
  state.messaging = messaging;
  const live = messaging.mode === 'seven';
  setStatus(elements.messagingMode, live ? 'seven-Echtversand' : 'Sicherer Testmodus', live ? 'positive' : 'warning');
  elements.messagingModeDetail.textContent = live
    ? 'RCS mit SMS-Fallback beziehungsweise reiner SMS-Versand aktiv'
    : 'Es werden keine echten Nachrichten übertragen';
  setStatus(
    elements.messagingApiKey,
    messaging.apiKeyConfigured ? 'Sicher hinterlegt' : 'Fehlt',
    messaging.apiKeyConfigured ? 'positive' : 'negative',
  );
  setStatus(
    elements.messagingAgent,
    messaging.rcsAgentId || 'Nicht konfiguriert',
    messaging.rcsAgentId ? '' : 'negative',
  );
  elements.messagingAgentDetail.textContent = 'Status noch nicht online geprüft';
  setStatus(
    elements.messagingSender,
    messaging.smsSender || 'Nicht konfiguriert',
    messaging.smsSender ? '' : 'negative',
  );
  elements.messagingFallback.textContent = 'SMS aktiviert';
  elements.messagingFallbackDetail.textContent = `RCS-Gültigkeit ${messaging.rcsTtlMinutes} Minuten`;

  const sync = messaging.deliverySync;
  const syncFailed = sync?.lastErrorAt && (!sync.lastSuccessAt || sync.lastErrorAt > sync.lastSuccessAt);
  if (syncFailed) {
    setStatus(elements.messagingSync, `Fehlgeschlagen · ${formatDateTime(sync.lastErrorAt)}`, 'negative');
    elements.messagingSyncDetail.textContent = `Automatischer Versuch alle ${messaging.statusSyncMinutes} Minuten`;
  } else if (sync?.lastSuccessAt) {
    setStatus(elements.messagingSync, formatDateTime(sync.lastSuccessAt), 'positive');
    elements.messagingSyncDetail.textContent = `${sync.lastChecked} geprüft · ${sync.lastUpdated} aktualisiert · alle ${messaging.statusSyncMinutes} Minuten`;
  } else {
    setStatus(elements.messagingSync, live ? 'Wartet auf ersten Abgleich' : 'Im Testmodus inaktiv', 'warning');
    elements.messagingSyncDetail.textContent = `Im Echtbetrieb alle ${messaging.statusSyncMinutes} Minuten`;
  }

  if (!messaging.locallyConfigured) {
    setMessagingReadiness(
      'Echtversand noch nicht konfiguriert',
      'API-Schlüssel, RCS-Agent und SMS-Absender müssen in der lokalen .env hinterlegt werden.',
      'negative',
    );
  } else if (!live) {
    setMessagingReadiness(
      'Konfiguration vorhanden · Testmodus aktiv',
      'Prüfen Sie die seven-Verbindung, bevor MESSAGE_MODE auf seven gestellt wird.',
      'warning',
    );
  } else {
    setMessagingReadiness(
      'Echtversand konfiguriert',
      'Prüfen Sie Agentstatus, Einwilligungsmarker und Journalzugriff regelmäßig.',
      'positive',
    );
  }
}

async function loadSettingsAndZones() {
  const [{ preferences, system }, { zones }] = await Promise.all([api('/api/settings'), api('/api/zones')]);
  elements.defaultRangeDays.max = String(system.maxRangeDays);
  elements.defaultRangeDays.value = String(preferences.defaultRangeDays);
  elements.appointmentsPerPage.value = String(preferences.appointmentsPerPage);
  for (const zone of zones) {
    const option = document.createElement('option');
    option.value = zone.id;
    option.textContent = zone.name;
    elements.preferredZone.append(option);
  }
  const preferredExists = preferences.preferredZoneId !== null
    && zones.some((zone) => Number(zone.id) === preferences.preferredZoneId);
  elements.preferredZone.value = preferredExists ? String(preferences.preferredZoneId) : '';
  elements.autoLoad.checked = preferences.autoLoadAppointments;
  elements.systemMode.textContent = system.smsMode === 'mock'
    ? 'Testmodus · kein echter Versand'
    : 'seven · RCS mit SMS-Fallback / SMS';
  elements.systemRetention.textContent = `${system.historyRetentionDays} Tage`;
  elements.systemMarkerName.textContent = `SMS: ${system.smsConsentMarker || 'nicht konfiguriert'} · RCS: ${system.rcsConsentMarker || 'nicht konfiguriert'}`;
  elements.systemLocal.textContent = system.loopbackOnly ? 'Nur auf diesem PC erreichbar' : 'Netzwerkzugriff aktiv';
  renderMessagingConfiguration(system.messaging);
}

async function saveSettings(event) {
  event.preventDefault();
  elements.saveSettings.disabled = true;
  elements.saveSettings.querySelector('span').textContent = 'Speichert …';
  showSettingsMessage();
  try {
    await api('/api/settings', mutationOptions('PUT', {
      defaultRangeDays: Number(elements.defaultRangeDays.value),
      appointmentsPerPage: Number(elements.appointmentsPerPage.value),
      preferredZoneId: elements.preferredZone.value ? Number(elements.preferredZone.value) : null,
      autoLoadAppointments: elements.autoLoad.checked,
    }));
    showSettingsMessage('Die Einstellungen wurden lokal gespeichert.');
  } catch (error) {
    showSettingsMessage(error.message, true);
  } finally {
    elements.saveSettings.disabled = false;
    elements.saveSettings.querySelector('span').textContent = 'Einstellungen speichern';
  }
}

async function loadSystemStatus() {
  const [healthResult, updateResult] = await Promise.allSettled([api('/api/health'), api('/api/update-status')]);
  if (healthResult.status === 'fulfilled') {
    const health = healthResult.value;
    elements.systemDatabase.textContent = `${health.database} · MariaDB ${health.version}`;
    elements.systemDatabaseDetail.textContent = `Port ${health.port} · ausschließlich lesen`;
    const bothMarkers = health.smsMarkerConfigured && health.rcsMarkerConfigured;
    elements.systemMarker.textContent = bothMarkers ? 'Beide Marker bereit' : 'Marker unvollständig';
    elements.systemMarker.className = bothMarkers ? 'status-positive' : 'status-warning';
    setStatus(elements.messagingSmsMarker, health.smsMarkerConfigured ? 'Bereit' : 'Fehlt', health.smsMarkerConfigured ? 'positive' : 'negative');
    setStatus(elements.messagingRcsMarker, health.rcsMarkerConfigured ? 'Bereit' : 'Fehlt', health.rcsMarkerConfigured ? 'positive' : 'negative');
  } else {
    elements.systemDatabase.textContent = 'Nicht erreichbar';
    elements.systemDatabase.className = 'status-negative';
    elements.systemDatabaseDetail.textContent = healthResult.reason.message;
    elements.systemMarker.textContent = 'Nicht prüfbar';
    setStatus(elements.messagingSmsMarker, 'Nicht prüfbar', 'negative');
    setStatus(elements.messagingRcsMarker, 'Nicht prüfbar', 'negative');
  }
  elements.systemVersion.textContent = updateResult.status === 'fulfilled'
    ? `Version ${updateResult.value.currentVersion}`
    : 'Version unbekannt';
}

async function testMessagingConnection() {
  elements.messagingTest.disabled = true;
  elements.messagingTest.querySelector('span').textContent = 'Verbindung wird geprüft …';
  elements.messagingTestResult.hidden = true;
  try {
    const { connection } = await api('/api/messaging/test', mutationOptions('POST'));
    if (connection.missing?.length) {
      setMessagingReadiness(
        'seven-Verbindung noch nicht prüfbar',
        `In der lokalen .env fehlen: ${connection.missing.join(', ')}.`,
        'negative',
      );
      elements.messagingTestResult.textContent = 'Es wurde keine externe Anfrage ausgeführt.';
      elements.messagingTestResult.className = 'form-message error';
    } else if (!connection.agentFound) {
      setMessagingReadiness(
        'RCS-Agent nicht gefunden',
        'Der API-Zugang funktioniert, aber die konfigurierte Agent-ID gehört nicht zu diesem seven-Konto.',
        'negative',
      );
      elements.messagingAgentDetail.textContent = 'Nicht im seven-Konto gefunden';
      elements.messagingTestResult.textContent = 'API und Versandjournal sind erreichbar; bitte die RCS-Agent-ID korrigieren.';
      elements.messagingTestResult.className = 'form-message error';
    } else {
      const statusLabels = {
        pending: 'Noch nicht eingereicht',
        test: 'Testnummern freigeschaltet',
        launched: 'Produktiv gestartet',
        approved: 'Von Netzbetreibern freigegeben',
      };
      const agentStatus = connection.agent.status;
      setStatus(elements.messagingAgent, connection.agent.displayName, connection.productionReady ? 'positive' : 'warning');
      elements.messagingAgentDetail.textContent = `${statusLabels[agentStatus] || agentStatus} · ID ${connection.agent.id}`;
      if (connection.productionReady && state.messaging?.mode === 'seven') {
        setMessagingReadiness(
          'RCS-/SMS-Versand ist betriebsbereit',
          'Agent und Journalzugriff wurden bestätigt. Die SMS-Berechtigung wird erst bei einem echten Versand geprüft.',
          'positive',
        );
      } else if (connection.testReady) {
        setMessagingReadiness(
          'seven-Testbetrieb ist bereit',
          'RCS ist derzeit nur für die beim Agenten hinterlegten Testnummern freigegeben.',
          'warning',
        );
      } else {
        setMessagingReadiness(
          'RCS-Agent noch nicht versandbereit',
          'Der seven-Zugang funktioniert, der Agent muss jedoch noch freigegeben werden.',
          'warning',
        );
      }
      elements.messagingTestResult.textContent = `Verbindung und Journalzugriff erfolgreich geprüft · ${formatDateTime(connection.checkedAt)}.`;
      elements.messagingTestResult.className = 'form-message success';
    }
    elements.messagingTestResult.hidden = false;
  } catch (error) {
    setMessagingReadiness('seven-Verbindung fehlgeschlagen', error.message, 'negative');
    elements.messagingTestResult.textContent = error.message;
    elements.messagingTestResult.className = 'form-message error';
    elements.messagingTestResult.hidden = false;
  } finally {
    elements.messagingTest.disabled = false;
    elements.messagingTest.querySelector('span').textContent = 'seven-Verbindung testen';
  }
}

function showTemplateError(text = '') {
  elements.templateError.hidden = !text;
  elements.templateError.textContent = text;
}

function updateTemplateCharacterCount() {
  elements.templateCharacterCount.textContent = `${elements.templateBody.value.length} / 160 Zeichen`;
}

function renderTemplateManager() {
  elements.templateList.innerHTML = state.templates.map((template) => `
    <button class="template-list-item${template.id === state.editingTemplateId ? ' active' : ''}" type="button" data-id="${template.id}">
      <span>${escapeHtml(template.name)}</span>
      ${template.isDefault ? '<small><svg class="icon" aria-hidden="true"><use href="#icon-star"></use></svg>Standard</small>' : ''}
    </button>`).join('');
  elements.templateList.querySelectorAll('.template-list-item').forEach((button) => {
    button.addEventListener('click', () => editTemplate(button.dataset.id));
  });
  const current = state.templates.find((template) => template.id === state.editingTemplateId);
  elements.defaultTemplate.disabled = !current || current.isDefault;
  elements.deleteTemplate.disabled = !current || current.isDefault;
  elements.newTemplate.disabled = state.templates.length >= state.maxTemplates;
}

function editTemplate(id) {
  const template = state.templates.find((item) => item.id === id);
  state.editingTemplateId = template?.id || null;
  state.deleteTemplateArmed = false;
  elements.deleteTemplate.querySelector('span').textContent = 'Löschen';
  elements.templateName.value = template?.name || '';
  elements.templateBody.value = template?.body
    || 'Praxis Recker: Wir erinnern Sie an Ihren Termin am {datum} um {uhrzeit} Uhr.';
  showTemplateError();
  updateTemplateCharacterCount();
  renderTemplateManager();
}

async function loadTemplates(preferredId = state.editingTemplateId) {
  const result = await api('/api/templates');
  state.templates = result.templates;
  state.maxTemplates = result.maxTemplates;
  const selected = state.templates.some((item) => item.id === preferredId)
    ? preferredId
    : state.templates.find((item) => item.isDefault)?.id || state.templates[0]?.id || null;
  editTemplate(selected);
}

async function saveTemplate() {
  elements.saveTemplate.disabled = true;
  showTemplateError();
  try {
    const path = state.editingTemplateId ? `/api/templates/${state.editingTemplateId}` : '/api/templates';
    const method = state.editingTemplateId ? 'PUT' : 'POST';
    const result = await api(path, mutationOptions(method, {
      name: elements.templateName.value,
      body: elements.templateBody.value,
    }));
    await loadTemplates(result.template.id);
  } catch (error) {
    showTemplateError(error.message);
  } finally {
    elements.saveTemplate.disabled = false;
  }
}

async function makeTemplateDefault() {
  if (!state.editingTemplateId) return;
  elements.defaultTemplate.disabled = true;
  showTemplateError();
  try {
    const result = await api(`/api/templates/${state.editingTemplateId}/default`, mutationOptions('POST'));
    await loadTemplates(result.template.id);
  } catch (error) {
    showTemplateError(error.message);
  }
}

async function deleteTemplate() {
  if (!state.editingTemplateId) return;
  if (!state.deleteTemplateArmed) {
    state.deleteTemplateArmed = true;
    elements.deleteTemplate.querySelector('span').textContent = 'Löschen bestätigen';
    return;
  }
  elements.deleteTemplate.disabled = true;
  showTemplateError();
  try {
    await api(`/api/templates/${state.editingTemplateId}`, mutationOptions('DELETE'));
    state.editingTemplateId = null;
    await loadTemplates();
  } catch (error) {
    state.deleteTemplateArmed = false;
    elements.deleteTemplate.querySelector('span').textContent = 'Löschen';
    showTemplateError(error.message);
  }
}

function insertPlaceholder(value) {
  const input = elements.templateBody;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(value, start, end, 'end');
  input.focus();
  updateTemplateCharacterCount();
}

elements.form.addEventListener('submit', saveSettings);
elements.newTemplate.addEventListener('click', () => editTemplate(null));
elements.saveTemplate.addEventListener('click', saveTemplate);
elements.defaultTemplate.addEventListener('click', makeTemplateDefault);
elements.deleteTemplate.addEventListener('click', deleteTemplate);
elements.templateBody.addEventListener('input', updateTemplateCharacterCount);
elements.messagingTest.addEventListener('click', testMessagingConnection);
document.querySelectorAll('.placeholder-button').forEach((button) => {
  button.addEventListener('click', () => insertPlaceholder(button.dataset.placeholder));
});

try {
  const session = await api('/api/session');
  state.csrfToken = session.csrfToken;
  elements.messagingSmsMarkerName.textContent = session.smsConsentMarker || 'Nicht konfiguriert';
  elements.messagingRcsMarkerName.textContent = session.rcsConsentMarker || 'Nicht konfiguriert';
  await Promise.all([loadSettingsAndZones(), loadTemplates(session.messageTemplateId), loadSystemStatus()]);
} catch (error) {
  showSettingsMessage(error.message, true);
}
