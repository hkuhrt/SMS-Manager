const state = {
  appointments: [],
  selected: new Set(),
  resend: new Set(),
  csrfToken: '',
  messageTemplate: '',
  templateId: null,
  templates: [],
  smsMode: 'mock',
  page: 1,
  pageSize: 20,
  editingTemplateId: null,
  deleteTemplateArmed: false,
  pendingResendId: null,
  pendingIdempotencyKey: null,
  sending: false,
};

const elements = {
  connection: document.querySelector('#connection'),
  appVersion: document.querySelector('#app-version'),
  updateWarning: document.querySelector('#update-warning'),
  from: document.querySelector('#from-date'),
  to: document.querySelector('#to-date'),
  zone: document.querySelector('#zone-filter'),
  search: document.querySelector('#search'),
  load: document.querySelector('#load-button'),
  table: document.querySelector('#appointments'),
  message: document.querySelector('#message'),
  selectAll: document.querySelector('#select-all'),
  selectedCount: document.querySelector('#selected-count'),
  reviewButton: document.querySelector('#review-button'),
  template: document.querySelector('#template'),
  templateSelect: document.querySelector('#template-select'),
  openTemplateManager: document.querySelector('#open-template-manager'),
  pageSize: document.querySelector('#page-size'),
  pageInfo: document.querySelector('#page-info'),
  pageNumber: document.querySelector('#page-number'),
  previousPage: document.querySelector('#previous-page'),
  nextPage: document.querySelector('#next-page'),
  total: document.querySelector('#total-count'),
  patient: document.querySelector('#patient-count'),
  mobile: document.querySelector('#mobile-count'),
  missing: document.querySelector('#missing-count'),
  eligible: document.querySelector('#eligible-count'),
  reviewDialog: document.querySelector('#review-dialog'),
  reviewCount: document.querySelector('#review-count'),
  reviewTemplateName: document.querySelector('#review-template-name'),
  reviewWarning: document.querySelector('#review-warning'),
  reviewList: document.querySelector('#review-list'),
  reviewError: document.querySelector('#review-error'),
  finalSend: document.querySelector('#final-send-button'),
  resendDialog: document.querySelector('#resend-dialog'),
  resendDetail: document.querySelector('#resend-detail'),
  confirmResend: document.querySelector('#confirm-resend-button'),
  templateDialog: document.querySelector('#template-dialog'),
  templateList: document.querySelector('#template-list'),
  newTemplate: document.querySelector('#new-template-button'),
  templateName: document.querySelector('#template-name'),
  templateBody: document.querySelector('#template-body'),
  templateCharacterCount: document.querySelector('#template-character-count'),
  templateError: document.querySelector('#template-error'),
  saveTemplate: document.querySelector('#save-template-button'),
  defaultTemplate: document.querySelector('#default-template-button'),
  deleteTemplate: document.querySelector('#delete-template-button'),
};

class ApiError extends Error {
  constructor(message, status, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function localIso(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function setDefaultRange() {
  const from = new Date();
  from.setDate(from.getDate() + 1);
  const to = new Date(from);
  to.setDate(to.getDate() + 6);
  elements.from.value = localIso(from);
  elements.to.value = localIso(to);
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

async function loadSession() {
  const session = await api('/api/session');
  state.csrfToken = session.csrfToken;
  state.messageTemplate = session.messageTemplate;
  state.templateId = session.messageTemplateId;
  state.smsMode = session.smsMode;
  elements.template.value = session.messageTemplate;
}

function mutationOptions(method, body = {}) {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': state.csrfToken,
    },
    body: JSON.stringify(body),
  };
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

function renderTemplatePicker() {
  elements.templateSelect.innerHTML = state.templates.map((template) =>
    `<option value="${template.id}">${escapeHtml(template.name)}${template.isDefault ? ' · Standard' : ''}</option>`).join('');
  const selected = state.templates.some((template) => template.id === state.templateId)
    ? state.templateId
    : state.templates.find((template) => template.isDefault)?.id || state.templates[0]?.id;
  if (selected) selectTemplate(selected);
}

async function loadTemplates(preferredId = state.templateId) {
  const result = await api('/api/templates');
  state.templates = result.templates;
  state.templateId = state.templates.some((item) => item.id === preferredId)
    ? preferredId
    : state.templates.find((item) => item.isDefault)?.id || state.templates[0]?.id || null;
  renderTemplatePicker();
  renderTemplateManager();
}

async function checkConnection() {
  try {
    const result = await api('/api/health');
    const marker = result.markerConfigured ? '' : ' · Freigabemarker fehlt';
    elements.connection.className = `connection ${result.markerConfigured ? 'online' : 'warning'}`;
    elements.connection.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-database"></use></svg><span>${escapeHtml(result.database)} · MariaDB ${escapeHtml(result.version)} · nur lesen${marker}</span>`;
  } catch (error) {
    elements.connection.className = 'connection offline';
    elements.connection.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-database"></use></svg><span>${escapeHtml(error.message)}</span>`;
  }
}

async function loadUpdateStatus() {
  try {
    const result = await api('/api/update-status');
    elements.appVersion.textContent = `Version ${result.currentVersion}`;
    if (result.state === 'failed' || result.state === 'blocked') {
      elements.updateWarning.textContent = result.message;
      elements.updateWarning.hidden = false;
    } else {
      elements.updateWarning.hidden = true;
    }
  } catch {
    elements.appVersion.textContent = 'Version unbekannt';
  }
}

async function loadZones() {
  try {
    const { zones } = await api('/api/zones');
    for (const zone of zones) {
      const option = document.createElement('option');
      option.value = zone.id;
      option.textContent = zone.name;
      elements.zone.append(option);
    }
  } catch {
    // Der Verbindungshinweis zeigt den Fehler bereits an.
  }
}

function filteredAppointments() {
  const needle = elements.search.value.trim().toLocaleLowerCase('de');
  if (!needle) return state.appointments;
  return state.appointments.filter((item) =>
    `${item.firstName || ''} ${item.lastName || ''}`.toLocaleLowerCase('de').includes(needle));
}

function paginatedAppointments() {
  const filtered = filteredAppointments();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const start = (state.page - 1) * state.pageSize;
  return {
    appointments: filtered.slice(start, start + state.pageSize),
    total: filtered.length,
    pageCount,
    start,
  };
}

function renderPagination({ total, pageCount, start }) {
  const end = Math.min(total, start + state.pageSize);
  elements.pageInfo.textContent = total ? `${start + 1}–${end} von ${total} Terminen` : '0 Termine';
  elements.pageNumber.textContent = `Seite ${state.page} von ${pageCount}`;
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= pageCount;
}

function patientLabel(item) {
  return [item.firstName, item.lastName].filter(Boolean).join(' ') || 'Patient nicht zugeordnet';
}

function formatDate(date, includeYear = false) {
  return new Intl.DateTimeFormat('de-DE', {
    weekday: includeYear ? undefined : 'short',
    day: '2-digit',
    month: '2-digit',
    year: includeYear ? 'numeric' : undefined,
  }).format(new Date(`${date}T12:00:00`));
}

function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function hasReminder(item) {
  return ['simulated', 'sent'].includes(item.reminderStatus?.status);
}

function isBaseEligible(item) {
  return item.hasPatient && item.hasMobile && item.hasConsent;
}

function isSelectable(item) {
  return isBaseEligible(item) && (!hasReminder(item) || state.resend.has(item.id));
}

function statusMarkup(item) {
  if (!item.hasPatient) return '<span class="status-badge blocked">Patient fehlt</span>';
  if (!item.hasMobile) return '<span class="status-badge blocked">Mobil fehlt</span>';
  if (!item.hasConsent) return '<span class="status-badge blocked">Freigabe fehlt</span>';
  if (hasReminder(item)) {
    const tested = item.reminderStatus.status === 'simulated';
    const label = tested ? 'Bereits getestet' : 'Bereits gesendet';
    const time = formatDateTime(item.reminderStatus.remindedAt);
    if (state.resend.has(item.id)) {
      return `<span class="status-badge repeat"><svg class="icon" aria-hidden="true"><use href="#icon-repeat"></use></svg>Wiederholung freigegeben</span>
        <button class="text-button resend-cancel-button" type="button" data-id="${item.id}">Zurücknehmen</button>`;
    }
    return `<span class="status-badge complete"><svg class="icon" aria-hidden="true"><use href="#icon-check-circle"></use></svg>${label}</span>
      <span class="status-time">${escapeHtml(time)}</span>
      <button class="text-button resend-button" type="button" data-id="${item.id}">Erneut auswählen</button>`;
  }
  return `<span class="status-badge ready"><svg class="icon" aria-hidden="true"><use href="#icon-check-circle"></use></svg>Bereit</span>`;
}

function renderTable() {
  const page = paginatedAppointments();
  const appointments = page.appointments;
  renderPagination(page);
  if (!appointments.length) {
    elements.table.innerHTML = '<tr class="empty-row"><td colspan="6">Für diesen Filter wurden keine Termine gefunden.</td></tr>';
    updateSelection();
    return;
  }

  elements.table.innerHTML = appointments.map((item) => {
    const checked = state.selected.has(item.id) ? 'checked' : '';
    const disabled = isSelectable(item) ? '' : 'disabled';
    let mobile = '<span class="badge missing">Mobil fehlt</span>';
    if (item.hasMobile && item.hasConsent) mobile = `<span class="badge">${escapeHtml(item.mobileMasked)}</span>`;
    else if (item.hasMobile) mobile = '<span class="badge missing">Freigabe fehlt</span>';
    const classes = [
      hasReminder(item) ? 'appointment-reminded' : '',
      state.resend.has(item.id) ? 'appointment-repeat' : '',
      item.isDemo || item.reminderStatus?.isDemo ? 'appointment-demo' : '',
    ].filter(Boolean).join(' ');
    const demo = item.isDemo || item.reminderStatus?.isDemo
      ? '<span class="demo-label"><svg class="icon" aria-hidden="true"><use href="#icon-flask"></use></svg>Demo</span>'
      : '';
    return `<tr class="${classes}">
      <td class="check-column"><input class="row-check" type="checkbox" data-id="${item.id}" aria-label="${escapeHtml(patientLabel(item))} auswählen" ${checked} ${disabled}></td>
      <td><strong>${escapeHtml(item.time?.slice(0, 5) || '–')}</strong><span class="patient-meta">${escapeHtml(formatDate(item.date))}</span></td>
      <td><span class="patient-name">${escapeHtml(patientLabel(item))} ${demo}</span><span class="patient-meta">Termin ${item.id}</span></td>
      <td>${escapeHtml(item.zoneName)}</td>
      <td>${mobile}</td>
      <td class="status-cell">${statusMarkup(item)}</td>
    </tr>`;
  }).join('');

  elements.table.querySelectorAll('.row-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const id = Number(checkbox.dataset.id);
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelection();
    });
  });
  elements.table.querySelectorAll('.resend-button').forEach((button) => {
    button.addEventListener('click', () => openResendDialog(Number(button.dataset.id)));
  });
  elements.table.querySelectorAll('.resend-cancel-button').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.id);
      state.resend.delete(id);
      state.selected.delete(id);
      renderTable();
    });
  });
  updateSelection();
}

function updateSelection() {
  for (const id of [...state.selected]) {
    const appointment = state.appointments.find((item) => item.id === id);
    if (!appointment || !isSelectable(appointment)) state.selected.delete(id);
  }
  elements.selectedCount.textContent = state.selected.size;
  elements.reviewButton.disabled = state.selected.size === 0;
  const selectable = paginatedAppointments().appointments.filter(isSelectable);
  elements.selectAll.checked = selectable.length > 0 && selectable.every((item) => state.selected.has(item.id));
  elements.selectAll.indeterminate = selectable.some((item) => state.selected.has(item.id))
    && !elements.selectAll.checked;
}

function showMessage(text, isError = false) {
  elements.message.hidden = !text;
  elements.message.className = `message${isError ? ' error' : ''}`;
  elements.message.textContent = text;
}

async function loadAppointments({ preserveMessage = false } = {}) {
  elements.load.disabled = true;
  elements.load.querySelector('span').textContent = 'Lädt …';
  if (!preserveMessage) showMessage('');
  try {
    const query = new URLSearchParams({ from: elements.from.value, to: elements.to.value });
    if (elements.zone.value) query.set('zone', elements.zone.value);
    const result = await api(`/api/appointments?${query}`);
    state.appointments = result.appointments;
    state.selected.clear();
    state.resend.clear();
    state.page = 1;
    elements.total.textContent = result.summary.total;
    elements.patient.textContent = result.summary.withPatient;
    elements.mobile.textContent = result.summary.withMobile;
    elements.missing.textContent = result.summary.missingMobile;
    elements.eligible.textContent = result.summary.eligible;
    if (result.truncated) showMessage('Die Ergebnismenge wurde begrenzt. Bitte den Zeitraum verkleinern.');
    renderTable();
  } catch (error) {
    state.appointments = [];
    state.selected.clear();
    state.resend.clear();
    renderTable();
    showMessage(error.message, true);
  } finally {
    elements.load.disabled = false;
    elements.load.querySelector('span').textContent = 'Termine laden';
  }
}

function renderTemplate(template, item) {
  return template
    .replaceAll('{datum}', formatDate(item.date, true))
    .replaceAll('{uhrzeit}', item.time?.slice(0, 5) || '')
    .trim();
}

function openResendDialog(id) {
  const item = state.appointments.find((appointment) => appointment.id === id);
  if (!item || !hasReminder(item)) return;
  state.pendingResendId = id;
  elements.resendDetail.innerHTML = `<strong>${escapeHtml(patientLabel(item))}</strong>
    <span>${escapeHtml(formatDate(item.date, true))} · ${escapeHtml(item.time?.slice(0, 5))} Uhr · ${escapeHtml(item.mobileMasked)}</span>`;
  elements.resendDialog.showModal();
}

function selectedAppointments() {
  return state.appointments.filter((item) => state.selected.has(item.id));
}

function openReviewDialog() {
  const selected = selectedAppointments();
  if (!selected.length) return;
  const repeats = selected.filter((item) => state.resend.has(item.id)).length;
  const demos = selected.filter((item) => item.isDemo || item.reminderStatus?.isDemo).length;
  elements.reviewCount.textContent = selected.length;
  elements.reviewTemplateName.textContent = activeTemplate()?.name || 'Standardvorlage';
  elements.reviewList.innerHTML = selected.map((item) => {
    const flags = [
      item.isDemo || item.reminderStatus?.isDemo
        ? '<span class="review-flag demo"><svg class="icon" aria-hidden="true"><use href="#icon-flask"></use></svg>Demo</span>'
        : '',
      state.resend.has(item.id)
        ? '<span class="review-flag repeat"><svg class="icon" aria-hidden="true"><use href="#icon-repeat"></use></svg>Wiederholung</span>'
        : '',
    ].join('');
    return `<article class="review-item">
      <div class="review-item-main">
        <strong>${escapeHtml(patientLabel(item))}</strong>
        <span>${escapeHtml(formatDate(item.date, true))} · ${escapeHtml(item.time?.slice(0, 5))} Uhr</span>
      </div>
      <div class="review-item-target"><span>${escapeHtml(item.mobileMasked)}</span><div class="review-flags">${flags}</div></div>
      <p>${escapeHtml(renderTemplate(state.messageTemplate, item))}</p>
    </article>`;
  }).join('');
  const warningParts = [];
  if (repeats) warningParts.push(`${repeats} Wiederholung${repeats === 1 ? '' : 'en'}`);
  if (demos) warningParts.push(`${demos} Demo-Termin${demos === 1 ? '' : 'e'}`);
  elements.reviewWarning.hidden = warningParts.length === 0;
  elements.reviewWarning.querySelector('p').textContent = warningParts.length
    ? `${warningParts.join(' und ')} sind enthalten. Bitte vor dem Versand besonders prüfen.`
    : '';
  elements.reviewError.hidden = true;
  elements.reviewError.textContent = '';
  state.pendingIdempotencyKey = crypto.randomUUID();
  elements.reviewDialog.showModal();
}

function setReviewBusy(busy) {
  state.sending = busy;
  elements.finalSend.disabled = busy;
  elements.finalSend.querySelector('span').textContent = busy ? 'Testversand läuft …' : 'Testversand jetzt ausführen';
  elements.reviewDialog.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = busy;
  });
}

async function sendReviewedBatch() {
  const appointmentIds = [...state.selected];
  if (!appointmentIds.length || state.sending) return;
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
    elements.reviewDialog.close('sent');
    const parts = [`${result.sent} Test-SMS erfolgreich simuliert`];
    if (result.failed) parts.push(`${result.failed} fehlgeschlagen`);
    if (result.skipped) parts.push(`${result.skipped} nicht versucht`);
    showMessage(`${parts.join(', ')}.`, Boolean(result.failed));
    await loadAppointments({ preserveMessage: true });
  } catch (error) {
    const details = error.details.length
      ? ` ${error.details.map((item) => `Termin ${item.appointmentId}: ${item.reason}`).join(' ')}`
      : '';
    elements.reviewError.textContent = `${error.message}${details}`;
    elements.reviewError.hidden = false;
  } finally {
    setReviewBusy(false);
  }
}

function showTemplateError(text = '') {
  elements.templateError.hidden = !text;
  elements.templateError.textContent = text;
}

function updateTemplateCharacterCount() {
  elements.templateCharacterCount.textContent = `${elements.templateBody.value.length} / 320 Zeichen`;
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
  elements.newTemplate.disabled = state.templates.length >= 20;
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

function openTemplateManager() {
  editTemplate(state.templateId || state.templates[0]?.id || null);
  elements.templateDialog.showModal();
}

async function saveTemplate() {
  const payload = {
    name: elements.templateName.value,
    body: elements.templateBody.value,
  };
  elements.saveTemplate.disabled = true;
  showTemplateError();
  try {
    const path = state.editingTemplateId
      ? `/api/templates/${state.editingTemplateId}`
      : '/api/templates';
    const method = state.editingTemplateId ? 'PUT' : 'POST';
    const result = await api(path, mutationOptions(method, payload));
    state.editingTemplateId = result.template.id;
    await loadTemplates(result.template.id);
    editTemplate(result.template.id);
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
    const result = await api(
      `/api/templates/${state.editingTemplateId}/default`,
      mutationOptions('POST'),
    );
    await loadTemplates(result.template.id);
    editTemplate(result.template.id);
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
    editTemplate(state.templateId);
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

elements.load.addEventListener('click', loadAppointments);
elements.search.addEventListener('input', () => {
  state.page = 1;
  renderTable();
});
elements.zone.addEventListener('change', loadAppointments);
elements.selectAll.addEventListener('change', () => {
  for (const item of paginatedAppointments().appointments) {
    if (!isSelectable(item)) continue;
    if (elements.selectAll.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
  }
  renderTable();
});
elements.pageSize.addEventListener('change', () => {
  state.pageSize = Number(elements.pageSize.value);
  state.page = 1;
  renderTable();
});
elements.previousPage.addEventListener('click', () => {
  state.page -= 1;
  renderTable();
});
elements.nextPage.addEventListener('click', () => {
  state.page += 1;
  renderTable();
});
elements.templateSelect.addEventListener('change', () => selectTemplate(elements.templateSelect.value));
elements.openTemplateManager.addEventListener('click', openTemplateManager);
elements.newTemplate.addEventListener('click', () => editTemplate(null));
elements.saveTemplate.addEventListener('click', saveTemplate);
elements.defaultTemplate.addEventListener('click', makeTemplateDefault);
elements.deleteTemplate.addEventListener('click', deleteTemplate);
elements.templateBody.addEventListener('input', updateTemplateCharacterCount);
document.querySelectorAll('.placeholder-button').forEach((button) => {
  button.addEventListener('click', () => insertPlaceholder(button.dataset.placeholder));
});
elements.reviewButton.addEventListener('click', openReviewDialog);
elements.finalSend.addEventListener('click', sendReviewedBatch);
elements.confirmResend.addEventListener('click', () => {
  const id = state.pendingResendId;
  if (id !== null) {
    state.resend.add(id);
    state.selected.add(id);
  }
  state.pendingResendId = null;
  elements.resendDialog.close('confirmed');
  renderTable();
});
elements.resendDialog.addEventListener('close', () => {
  state.pendingResendId = null;
});
elements.reviewDialog.addEventListener('cancel', (event) => {
  if (state.sending) event.preventDefault();
});

setDefaultRange();
await loadSession();
await Promise.all([checkConnection(), loadZones(), loadTemplates(), loadUpdateStatus()]);
