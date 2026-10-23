const elements = {
  history: document.querySelector('#history-list'),
  refresh: document.querySelector('#history-refresh'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Unbekannter Fehler');
  return body;
}

async function loadHistory() {
  elements.refresh.disabled = true;
  elements.refresh.querySelector('span').textContent = 'Lädt …';
  try {
    const { history, retentionDays } = await api('/api/history?limit=100');
    if (!history.length) {
      elements.history.innerHTML = `<p class="history-empty">Noch keine Versandvorgänge vorhanden.</p><p class="history-retention">Einträge werden nach ${retentionDays} Tagen automatisch gelöscht.</p>`;
      return;
    }
    const statusLabel = (entry) => {
      if (entry.status === 'simulated') return 'Test erfolgreich';
      if (entry.status === 'sent') return 'SMS gesendet';
      if (entry.status === 'accepted') return 'Vom Anbieter angenommen';
      if (entry.status === 'delivered') return 'Zugestellt';
      if (entry.status === 'read') return 'Gelesen';
      if (entry.status === 'unknown') return 'Status wird geklärt';
      if (entry.status === 'failed') return 'Fehlgeschlagen';
      return entry.status;
    };
    elements.history.innerHTML = history.map((entry) => `
      <article class="history-item">
        <div><strong>Termin ${entry.appointmentId}</strong><span>${escapeHtml(entry.phoneMasked || 'Nummer maskiert')}</span></div>
        <div class="history-flags">
          <span class="badge ${entry.status === 'failed' ? 'missing' : ''}">${entry.status === 'failed' ? '<svg class="icon" aria-hidden="true"><use href="#icon-alert"></use></svg>' : ''}${escapeHtml(statusLabel(entry))}</span>
          ${entry.channel ? `<span class="review-flag">${escapeHtml(entry.channel.toUpperCase())}</span>` : ''}
          ${entry.isDemo ? '<span class="review-flag demo"><svg class="icon" aria-hidden="true"><use href="#icon-flask"></use></svg>Demo</span>' : ''}
          ${entry.isRepeat ? '<span class="review-flag repeat"><svg class="icon" aria-hidden="true"><use href="#icon-repeat"></use></svg>Wiederholung</span>' : ''}
        </div>
        <div><span>${escapeHtml(entry.source === 'medical-office-button' ? 'MEDICAL-OFFICE-Button' : 'Kalenderauswahl')}</span><time>${escapeHtml(new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.createdAt)))}</time></div>
      </article>`).join('') + `<p class="history-retention">Einträge werden nach ${retentionDays} Tagen automatisch gelöscht.</p>`;
  } catch (error) {
    elements.history.innerHTML = `<p class="history-empty">${escapeHtml(error.message)}</p>`;
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.querySelector('span').textContent = 'Aktualisieren';
  }
}

elements.refresh.addEventListener('click', loadHistory);
await loadHistory();
