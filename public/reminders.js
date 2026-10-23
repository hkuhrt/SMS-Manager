const selectionKey = 'smsreminder.reminderSelection';
const selectionMaxAgeMs = 2 * 60 * 60 * 1000;

const state = {
  appointments: [],
  resend: new Set(),
  csrfToken: '',
  messageTemplate: '',
  templateId: null,
  templates: [],
  smsMode: 'mock',
  selectionPayload: null,
  pendingIdempotencyKey: null,
  sending: false,
};

const elements = {
  message: document.querySelector('#reminder-message'),
  empty: document.querySelector('#reminder-empty'),
  workspace: document.querySelector('#reminder-workspace'),
  success: document.querySelector('#reminder-success'),
  successText: document.querySelector('#reminder-success-text'),
  selectedCount: document.querySelector('#selected-count'),
  selectionList: document.querySelector('#reminder-selection-list'),
  template: document.querySelector('#template'),
  templateSelect: document.querySelector('#template-select'),
  reviewButton: document.querySelector('#review-button'),
  providerNote: document.querySelector('#provider-note'),
  reviewDialog: document.querySelector('#review-dialog'),
  reviewCount: document.querySelector('#review-count'),
  reviewTemplateName: document.querySelector('#review-template-name'),
  reviewMode: document.querySelector('#review-mode'),
  reviewTitle: document.querySelector('#review-title'),
  reviewDescription: document.querySelector('#review-description'),
  reviewWarning: document.querySelector('#review-warning'),
  reviewList: document.querySelector('#review-list'),
  reviewError: document.querySelector('#review-error'),
  finalSend: document.querySelector('#final-send-button'),
};

class ApiError extends Error {
  constructor(message, status, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
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
  if (!response.ok) throw new ApiError(body.error || 'Unbekannter Fehler', response.status, body.details || []);
  return body;
}

function patientLabel(item) {
  return [item.firstName, item.lastName].filter(Boolean).join(' ') || 'Patient nicht zugeordnet';
}

function formatDate(date, includeYear = true) {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: includeYear ? 'numeric' : undefined,
  }).format(new Date(`${date}T12:00:00`));
}

function renderTemplate(template, item) {
  return template
    .replaceAll('{datum}', formatDate(item.date))
    .replaceAll('{uhrzeit}', item.time?.slice(0, 5) || '')
    .trim();
}

function hasReminder(item) {
  return ['simulated', 'sent', 'accepted', 'delivered', 'read', 'unknown'].includes(item.reminderStatus?.status);
}

function isStillEligible(item) {
  if (!item?.hasPatient || !item.hasMobile || !item.hasConsent) return false;
  return !hasReminder(item) || state.resend.has(item.id);
}

function readSelection() {
  try {
    const payload = JSON.parse(sessionStorage.getItem(selectionKey));
    const ids = Array.isArray(payload?.appointmentIds)
      ? [...new Set(payload.appointmentIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
      : [];
    const repeats = Array.isArray(payload?.resendAppointmentIds)
      ? payload.resendAppointmentIds.filter((id) => ids.includes(id))
      : [];
    const fresh = Number.isFinite(payload?.createdAt) && Date.now() - payload.createdAt <= selectionMaxAgeMs;
    const validDates = /^\d{4}-\d{2}-\d{2}$/.test(payload?.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(payload?.to || '');
    if (payload?.version !== 1 || !ids.length || !fresh || !validDates) return null;
    return {
      version: 1,
      appointmentIds: ids,
      resendAppointmentIds: repeats,
      from: payload.from,
      to: payload.to,
      zoneId: /^\d+$/.test(String(payload.zoneId || '')) ? String(payload.zoneId) : null,
      createdAt: payload.createdAt,
    };
  } catch {
    return null;
  }
}

function persistSelection() {
  if (!state.selectionPayload || !state.appointments.length) {
    sessionStorage.removeItem(selectionKey);
    return;
  }
  state.selectionPayload.appointmentIds = state.appointments.map((item) => item.id);
  state.selectionPayload.resendAppointmentIds = [...state.resend]
    .filter((id) => state.selectionPayload.appointmentIds.includes(id));
  sessionStorage.setItem(selectionKey, JSON.stringify(state.selectionPayload));
}

function showMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.className = `message${isError ? ' error' : ''}`;
  elements.message.hidden = !text;
}

function showEmpty(message = '') {
  elements.workspace.hidden = true;
  elements.success.hidden = true;
  elements.empty.hidden = false;
  if (message) showMessage(message, true);
}

function activeTemplate() {
  return state.templates.find((template) => template.id === state.templateId) || null;
}

function selectTemplate(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return;
  state.templateId = template.id;
  state.messageTemplate = template.body;
  elements.template.value = template.body;
  elements.templateSelect.value = template.id;
}

async function loadSessionAndTemplates() {
  const [session, templateResult] = await Promise.all([api('/api/session'), api('/api/templates')]);
  state.csrfToken = session.csrfToken;
  state.messageTemplate = session.messageTemplate;
  state.templateId = session.messageTemplateId;
  state.smsMode = session.smsMode;
  state.templates = templateResult.templates;
  elements.templateSelect.innerHTML = state.templates.map((template) =>
    `<option value="${template.id}">${escapeHtml(template.name)}${template.isDefault ? ' · Standard' : ''}</option>`).join('');
  const selected = state.templates.some((template) => template.id === state.templateId)
    ? state.templateId
    : state.templates.find((template) => template.isDefault)?.id || state.templates[0]?.id;
  if (selected) selectTemplate(selected);
  const live = state.smsMode === 'seven';
  elements.providerNote.textContent = live
    ? 'RCS-freigegebene Empfänger erhalten RCS mit automatischem SMS-Fallback. Bestehende SMS-Freigaben bleiben SMS.'
    : 'Im Testmodus wird der gewählte Kanal nur simuliert. Die Telefonnummer verlässt diesen Rechner nicht.';
  elements.reviewMode.textContent = live ? 'seven · RCS/SMS' : 'Test · keine echte Nachricht';
  elements.reviewTitle.textContent = 'Terminerinnerungen prüfen';
  elements.reviewDescription.textContent = live
    ? 'Kontrollieren Sie Patientin, Terminzeit, Zielnummer und Versandkanal vor dem Versand.'
    : 'Kontrollieren Sie Patientin, Terminzeit und Zielnummer vor der Simulation.';
}

function flagsFor(item) {
  return [
    item.isDemo || item.reminderStatus?.isDemo
      ? '<span class="review-flag demo"><svg class="icon" aria-hidden="true"><use href="#icon-flask"></use></svg>Demo</span>'
      : '',
    state.resend.has(item.id)
      ? '<span class="review-flag repeat"><svg class="icon" aria-hidden="true"><use href="#icon-repeat"></use></svg>Wiederholung</span>'
      : '',
    `<span class="review-flag">${item.hasRcsConsent ? 'RCS + SMS-Fallback' : 'SMS'}</span>`,
  ].join('');
}

function renderSelection() {
  elements.selectedCount.textContent = state.appointments.length;
  elements.reviewButton.disabled = state.appointments.length === 0;
  elements.selectionList.innerHTML = state.appointments.map((item) => `
    <article class="reminder-selection-item">
      <div><strong>${escapeHtml(patientLabel(item))}</strong><span>${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.time?.slice(0, 5))} Uhr</span></div>
      <div class="reminder-selection-target"><span>${escapeHtml(item.mobileMasked)}</span><div class="review-flags">${flagsFor(item)}</div></div>
      <button class="icon-button remove-reminder-item" type="button" data-id="${item.id}" aria-label="${escapeHtml(patientLabel(item))} aus der Auswahl entfernen"><svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg></button>
    </article>`).join('');
  elements.selectionList.querySelectorAll('.remove-reminder-item').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.id);
      state.appointments = state.appointments.filter((item) => item.id !== id);
      state.resend.delete(id);
      persistSelection();
      if (!state.appointments.length) showEmpty();
      else renderSelection();
    });
  });
}

async function loadSelection() {
  state.selectionPayload = readSelection();
  if (!state.selectionPayload) {
    showEmpty();
    return;
  }
  const query = new URLSearchParams({
    from: state.selectionPayload.from,
    to: state.selectionPayload.to,
  });
  if (state.selectionPayload.zoneId) query.set('zone', state.selectionPayload.zoneId);
  const result = await api(`/api/appointments?${query}`);
  state.resend = new Set(state.selectionPayload.resendAppointmentIds);
  const byId = new Map(result.appointments.map((item) => [item.id, item]));
  const requested = state.selectionPayload.appointmentIds.map((id) => byId.get(id)).filter(Boolean);
  state.appointments = requested.filter(isStillEligible);
  const removed = state.selectionPayload.appointmentIds.length - state.appointments.length;
  if (!state.appointments.length) {
    sessionStorage.removeItem(selectionKey);
    showEmpty(removed ? 'Die Auswahl ist nicht mehr aktuell. Bitte laden und wählen Sie die Termine erneut.' : '');
    return;
  }
  persistSelection();
  elements.empty.hidden = true;
  elements.success.hidden = true;
  elements.workspace.hidden = false;
  if (removed) showMessage(`${removed} Termin${removed === 1 ? '' : 'e'} wurde entfernt, weil die Daten nicht mehr versandbereit sind.`, true);
  renderSelection();
}

function openReviewDialog() {
  if (!state.appointments.length) return;
  const repeats = state.appointments.filter((item) => state.resend.has(item.id)).length;
  const demos = state.appointments.filter((item) => item.isDemo || item.reminderStatus?.isDemo).length;
  elements.reviewCount.textContent = state.appointments.length;
  elements.reviewTemplateName.textContent = activeTemplate()?.name || 'Standardvorlage';
  elements.reviewList.innerHTML = state.appointments.map((item) => `
    <article class="review-item">
      <div class="review-item-main"><strong>${escapeHtml(patientLabel(item))}</strong><span>${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.time?.slice(0, 5))} Uhr</span></div>
      <div class="review-item-target"><span>${escapeHtml(item.mobileMasked)}</span><div class="review-flags">${flagsFor(item)}</div></div>
      <p>${escapeHtml(renderTemplate(state.messageTemplate, item))}</p>
    </article>`).join('');
  const warnings = [];
  if (repeats) warnings.push(`${repeats} Wiederholung${repeats === 1 ? '' : 'en'}`);
  if (demos) warnings.push(`${demos} Demo-Termin${demos === 1 ? '' : 'e'}`);
  elements.reviewWarning.hidden = warnings.length === 0;
  elements.reviewWarning.querySelector('p').textContent = warnings.length
    ? `${warnings.join(' und ')} sind enthalten. Bitte vor dem Versand besonders prüfen.`
    : '';
  elements.reviewError.hidden = true;
  elements.reviewError.textContent = '';
  state.pendingIdempotencyKey = crypto.randomUUID();
  elements.reviewDialog.showModal();
}

function setReviewBusy(busy) {
  state.sending = busy;
  elements.finalSend.disabled = busy;
  const testMode = state.smsMode === 'mock';
  elements.finalSend.querySelector('span').textContent = busy
    ? (testMode ? 'Simulation läuft …' : 'Versand läuft …')
    : (testMode ? 'Simulation jetzt ausführen' : 'Nachrichten jetzt senden');
  elements.reviewDialog.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = busy; });
}

async function sendReviewedBatch() {
  if (!state.appointments.length || state.sending) return;
  const appointmentIds = state.appointments.map((item) => item.id);
  const resendAppointmentIds = appointmentIds.filter((id) => state.resend.has(id));
  setReviewBusy(true);
  elements.reviewError.hidden = true;
  try {
    const result = await api('/api/reminder-batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken,
        'Idempotency-Key': state.pendingIdempotencyKey,
      },
      body: JSON.stringify({ appointmentIds, resendAppointmentIds, templateId: state.templateId }),
    });
    sessionStorage.removeItem(selectionKey);
    elements.reviewDialog.close('sent');
    const parts = [state.smsMode === 'mock'
      ? `${result.sent} Nachricht${result.sent === 1 ? '' : 'en'} erfolgreich simuliert`
      : `${result.sent} Nachricht${result.sent === 1 ? '' : 'en'} vom Anbieter angenommen`];
    if (result.unknown) parts.push(`${result.unknown} mit noch unbekanntem Status`);
    if (result.failed) parts.push(`${result.failed} fehlgeschlagen`);
    if (result.skipped) parts.push(`${result.skipped} nicht versucht`);
    elements.workspace.hidden = true;
    elements.empty.hidden = true;
    elements.successText.textContent = `${parts.join(', ')}.`;
    elements.success.hidden = false;
  } catch (error) {
    const details = Array.isArray(error.details) && error.details.length
      ? ` ${error.details.map((item) => `Termin ${item.appointmentId}: ${item.reason}`).join(' ')}`
      : '';
    elements.reviewError.textContent = `${error.message}${details}`;
    elements.reviewError.hidden = false;
  } finally {
    setReviewBusy(false);
  }
}

elements.templateSelect.addEventListener('change', () => selectTemplate(elements.templateSelect.value));
elements.reviewButton.addEventListener('click', openReviewDialog);
elements.finalSend.addEventListener('click', sendReviewedBatch);
elements.reviewDialog.addEventListener('cancel', (event) => {
  if (state.sending) event.preventDefault();
});

try {
  await Promise.all([loadSessionAndTemplates(), loadSelection()]);
} catch (error) {
  showEmpty(error.message || 'Die Erinnerungsauswahl konnte nicht geladen werden.');
}
