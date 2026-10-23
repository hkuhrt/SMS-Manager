const elements = {
  loading: document.querySelector('#single-loading'),
  error: document.querySelector('#single-error'),
  content: document.querySelector('#single-content'),
  patient: document.querySelector('#single-patient'),
  mobile: document.querySelector('#single-mobile'),
  consent: document.querySelector('#single-consent'),
  reasons: document.querySelector('#single-reasons'),
  fieldset: document.querySelector('#appointment-fieldset'),
  appointments: document.querySelector('#single-appointments'),
  preview: document.querySelector('#single-preview-text'),
  send: document.querySelector('#single-send'),
  cancel: document.querySelector('#single-cancel'),
  success: document.querySelector('#single-success'),
};

const state = {
  launchId: new URLSearchParams(window.location.search).get('launch') || '',
  csrfToken: '',
  context: null,
  selectedAppointmentId: null,
  idempotencyKey: null,
};

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
  if (!response.ok) throw new Error(body.error || 'Unbekannter Fehler');
  return body;
}

function patientLabel(patient) {
  return [patient.salutation, patient.firstName, patient.lastName].filter(Boolean).join(' ') || 'Unbekannter Patient';
}

function appointmentLabel(appointment) {
  const date = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(`${appointment.date}T12:00:00`));
  return `${date} um ${appointment.time?.slice(0, 5) || '–'} Uhr`;
}

function updatePreview() {
  const appointment = state.context?.appointments.find((item) => item.id === state.selectedAppointmentId);
  elements.preview.textContent = appointment?.messagePreview || 'Bitte einen Termin auswählen.';
  elements.send.disabled = !state.context?.eligible || !appointment;
}

function renderContext(context) {
  state.context = context;
  const patient = context.patient;
  elements.patient.textContent = patientLabel(patient);
  elements.mobile.textContent = patient.mobileMasked || 'Nicht vorhanden';
  elements.consent.textContent = patient.hasConsent ? 'Vorhanden' : 'Fehlt';
  elements.consent.className = patient.hasConsent ? 'status-positive' : 'status-negative';

  if (context.reasons.length) {
    elements.reasons.hidden = false;
    elements.reasons.innerHTML = `<strong>Versand derzeit nicht möglich</strong><ul>${context.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  }

  if (context.appointments.length) {
    state.selectedAppointmentId = context.appointments[0].id;
    elements.appointments.innerHTML = context.appointments.map((appointment, index) => `
      <label class="appointment-option">
        <input type="radio" name="appointment" value="${appointment.id}" ${index === 0 ? 'checked' : ''}>
        <span><strong>${escapeHtml(appointmentLabel(appointment))}</strong><small>${escapeHtml(appointment.zoneName)} · Termin ${appointment.id}</small></span>
      </label>`).join('');
    elements.appointments.querySelectorAll('input[name="appointment"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.selectedAppointmentId = Number(radio.value);
        state.idempotencyKey = null;
        updatePreview();
      });
    });
  } else {
    elements.fieldset.disabled = true;
    elements.appointments.innerHTML = '<p class="history-empty">Keine kommenden Termine vorhanden.</p>';
  }
  updatePreview();
  elements.loading.hidden = true;
  elements.content.hidden = false;
}

async function initialize() {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state.launchId)) {
    throw new Error('Die Patientenübergabe fehlt oder ist ungültig. Bitte den Button in MEDICAL OFFICE erneut drücken.');
  }
  const session = await api('/api/session');
  state.csrfToken = session.csrfToken;
  const context = await api(`/api/integrations/medical-office/selections/${encodeURIComponent(state.launchId)}`);
  renderContext(context);
}

async function sendReminder() {
  if (!state.selectedAppointmentId) return;
  if (!window.confirm('Diesen Testversand für den angezeigten Termin verbindlich bestätigen?')) return;
  state.idempotencyKey ||= crypto.randomUUID();
  elements.send.disabled = true;
  elements.send.textContent = 'Testversand läuft …';
  try {
    await api('/api/reminders/single', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken,
        'Idempotency-Key': state.idempotencyKey,
      },
      body: JSON.stringify({
        launchId: state.launchId,
        appointmentId: state.selectedAppointmentId,
      }),
    });
    elements.content.hidden = true;
    elements.success.hidden = false;
    window.history.replaceState({}, '', '/single.html');
  } catch (error) {
    elements.error.textContent = error.message;
    elements.error.hidden = false;
    elements.send.disabled = false;
    elements.send.textContent = 'Testversand verbindlich bestätigen';
  }
}

async function cancelSelection() {
  elements.cancel.disabled = true;
  try {
    await api(`/api/integrations/medical-office/selections/${encodeURIComponent(state.launchId)}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken,
      },
      body: '{}',
    });
  } catch {
    // Auch bei einer bereits abgelaufenen Übergabe kann die Seite geschlossen werden.
  }
  window.history.replaceState({}, '', '/single.html');
  window.location.href = '/';
}

elements.send.addEventListener('click', sendReminder);
elements.cancel.addEventListener('click', cancelSelection);

try {
  await initialize();
} catch (error) {
  elements.loading.hidden = true;
  elements.error.textContent = error.message;
  elements.error.hidden = false;
}
