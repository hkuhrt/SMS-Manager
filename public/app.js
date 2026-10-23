const state = {
  appointments: [],
  selected: new Set(),
  resend: new Set(),
  page: 1,
  pageSize: 20,
  summaryFilter: 'all',
  settings: null,
  pendingResendId: null,
};

const reminderSelectionKey = 'smsreminder.reminderSelection';
const reminderSelectionMaxAgeMs = 2 * 60 * 60 * 1000;

const elements = {
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
  pageSize: document.querySelector('#page-size'),
  pageInfo: document.querySelector('#page-info'),
  pageNumber: document.querySelector('#page-number'),
  previousPage: document.querySelector('#previous-page'),
  nextPage: document.querySelector('#next-page'),
  total: document.querySelector('#total-count'),
  missing: document.querySelector('#missing-count'),
  eligible: document.querySelector('#eligible-count'),
  missingConsent: document.querySelector('#missing-consent-count'),
  missingPatient: document.querySelector('#missing-patient-count'),
  missingPatientSummary: document.querySelector('#missing-patient-summary'),
  summaryFilters: [...document.querySelectorAll('[data-summary-filter]')],
  resendDialog: document.querySelector('#resend-dialog'),
  resendDetail: document.querySelector('#resend-detail'),
  confirmResend: document.querySelector('#confirm-resend-button'),
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

function setDefaultRange(days = 7) {
  const from = new Date();
  from.setDate(from.getDate() + 1);
  const to = new Date(from);
  to.setDate(to.getDate() + Math.max(0, days - 1));
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

async function loadSettings() {
  const result = await api('/api/settings');
  state.settings = result.preferences;
  state.pageSize = result.preferences.appointmentsPerPage;
  elements.pageSize.value = String(state.pageSize);
  setDefaultRange(result.preferences.defaultRangeDays);
  return result.preferences;
}

async function loadUpdateStatus() {
  try {
    const result = await api('/api/update-status');
    if (result.state === 'failed' || result.state === 'blocked') {
      elements.updateWarning.textContent = result.message;
      elements.updateWarning.hidden = false;
    } else {
      elements.updateWarning.hidden = true;
    }
  } catch { elements.updateWarning.hidden = true; }
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
    return zones;
  } catch {
    // Der Verbindungshinweis zeigt den Fehler bereits an.
    return [];
  }
}

function searchFilteredAppointments() {
  const needle = elements.search.value.trim().toLocaleLowerCase('de');
  if (!needle) return state.appointments;
  return state.appointments.filter((item) =>
    `${item.firstName || ''} ${item.lastName || ''}`.toLocaleLowerCase('de').includes(needle));
}

function matchesSummaryFilter(item) {
  if (state.summaryFilter === 'ready') return isSelectable(item);
  if (state.summaryFilter === 'missing-mobile') return item.hasPatient && !item.hasMobile;
  if (state.summaryFilter === 'missing-consent') return item.hasPatient && item.hasMobile && !item.hasConsent;
  if (state.summaryFilter === 'missing-patient') return !item.hasPatient;
  return true;
}

function filteredAppointments() {
  return searchFilteredAppointments().filter(matchesSummaryFilter);
}

function renderSummary() {
  const appointments = searchFilteredAppointments();
  const missingPatient = appointments.filter((item) => !item.hasPatient).length;
  elements.total.textContent = appointments.length;
  elements.eligible.textContent = appointments.filter(isSelectable).length;
  elements.missing.textContent = appointments.filter((item) => item.hasPatient && !item.hasMobile).length;
  elements.missingConsent.textContent = appointments.filter((item) => item.hasPatient && item.hasMobile && !item.hasConsent).length;
  elements.missingPatient.textContent = missingPatient;
  elements.missingPatientSummary.hidden = missingPatient === 0 && state.summaryFilter !== 'missing-patient';
  for (const button of elements.summaryFilters) {
    const active = button.dataset.summaryFilter === state.summaryFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
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
  return ['simulated', 'sent', 'accepted', 'delivered', 'read', 'unknown'].includes(item.reminderStatus?.status);
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
    const status = item.reminderStatus.status;
    const labels = {
      simulated: 'Bereits getestet',
      sent: 'Bereits gesendet',
      accepted: 'Vom Anbieter angenommen',
      delivered: 'Zugestellt',
      read: 'Gelesen',
      unknown: 'Status wird geklärt',
    };
    const channel = item.reminderStatus.channel ? ` · ${item.reminderStatus.channel.toUpperCase()}` : '';
    const label = `${labels[status] || 'Bereits verarbeitet'}${channel}`;
    const time = formatDateTime(item.reminderStatus.remindedAt);
    if (status === 'unknown') {
      return `<span class="status-badge blocked">${label}</span><span class="status-time">${escapeHtml(time)}</span>`;
    }
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
  renderSummary();
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
  persistReminderSelection();
}

function persistReminderSelection() {
  if (!state.selected.size) {
    sessionStorage.removeItem(reminderSelectionKey);
    return;
  }
  sessionStorage.setItem(reminderSelectionKey, JSON.stringify({
    version: 1,
    appointmentIds: [...state.selected],
    resendAppointmentIds: [...state.resend].filter((id) => state.selected.has(id)),
    from: elements.from.value,
    to: elements.to.value,
    zoneId: elements.zone.value || null,
    createdAt: Date.now(),
  }));
}

function readReminderSelection() {
  try {
    const payload = JSON.parse(sessionStorage.getItem(reminderSelectionKey));
    const appointmentIds = Array.isArray(payload?.appointmentIds)
      ? payload.appointmentIds.filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    const fresh = Number.isFinite(payload?.createdAt)
      && Date.now() - payload.createdAt <= reminderSelectionMaxAgeMs;
    const validDates = /^\d{4}-\d{2}-\d{2}$/.test(payload?.from || '')
      && /^\d{4}-\d{2}-\d{2}$/.test(payload?.to || '');
    if (payload?.version !== 1 || !appointmentIds.length || !fresh || !validDates) return null;
    return {
      ...payload,
      appointmentIds: [...new Set(appointmentIds)],
      resendAppointmentIds: Array.isArray(payload.resendAppointmentIds)
        ? payload.resendAppointmentIds.filter((id) => appointmentIds.includes(id))
        : [],
    };
  } catch {
    return null;
  }
}

function showMessage(text, isError = false) {
  elements.message.hidden = !text;
  elements.message.className = `message${isError ? ' error' : ''}`;
  elements.message.textContent = text;
}

async function loadAppointments({ preserveMessage = false, restoreSelection = null } = {}) {
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
    if (restoreSelection) {
      const availableIds = new Set(state.appointments.map((item) => item.id));
      restoreSelection.appointmentIds.filter((id) => availableIds.has(id)).forEach((id) => state.selected.add(id));
      restoreSelection.resendAppointmentIds.filter((id) => state.selected.has(id)).forEach((id) => state.resend.add(id));
    }
    state.page = 1;
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

function openResendDialog(id) {
  const item = state.appointments.find((appointment) => appointment.id === id);
  if (!item || !hasReminder(item)) return;
  state.pendingResendId = id;
  elements.resendDetail.innerHTML = `<strong>${escapeHtml(patientLabel(item))}</strong>
    <span>${escapeHtml(formatDate(item.date, true))} · ${escapeHtml(item.time?.slice(0, 5))} Uhr · ${escapeHtml(item.mobileMasked)}</span>`;
  elements.resendDialog.showModal();
}

function goToReminderPage() {
  if (!state.selected.size) return;
  persistReminderSelection();
  window.location.assign('/reminders.html');
}

elements.load.addEventListener('click', loadAppointments);
elements.search.addEventListener('input', () => {
  state.page = 1;
  renderTable();
});
for (const button of elements.summaryFilters) {
  button.addEventListener('click', () => {
    state.summaryFilter = button.dataset.summaryFilter;
    state.page = 1;
    renderTable();
  });
}
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
elements.reviewButton.addEventListener('click', goToReminderPage);
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
const [settings, zones] = await Promise.all([loadSettings(), loadZones(), loadUpdateStatus()]);
const storedSelection = readReminderSelection();
if (storedSelection) {
  elements.from.value = storedSelection.from;
  elements.to.value = storedSelection.to;
  if (storedSelection.zoneId && zones.some((zone) => String(zone.id) === String(storedSelection.zoneId))) {
    elements.zone.value = String(storedSelection.zoneId);
  }
  await loadAppointments({ restoreSelection: storedSelection });
} else if (settings.preferredZoneId !== null && zones.some((zone) => Number(zone.id) === settings.preferredZoneId)) {
  elements.zone.value = String(settings.preferredZoneId);
}
if (!storedSelection && settings.autoLoadAppointments) await loadAppointments();
