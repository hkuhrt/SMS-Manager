const mount = document.querySelector('#app-navigation');

const icons = {
  calendar: '<path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z"/>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  collapse: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 9l-3 3 3 3"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

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
  if (!response.ok) throw new Error(body.error || 'Nicht erreichbar');
  return body;
}

if (mount) {
  const active = mount.dataset.active || '';
  const navItems = [
    { id: 'appointments', href: '/', icon: 'calendar', label: 'Termine' },
    { id: 'reminders', href: '/reminders.html', icon: 'message', label: 'Erinnerung' },
    { id: 'history', href: '/history.html', icon: 'history', label: 'Protokoll' },
    { id: 'settings', href: '/settings.html', icon: 'settings', label: 'Einstellungen' },
  ];
  mount.innerHTML = `
    <header class="mobile-app-bar">
      <button class="nav-toggle" type="button" aria-label="Navigation öffnen" aria-expanded="false">${icon('menu')}</button>
      <a href="/" aria-label="Zur Terminübersicht"><img src="/assets/praxis-sabrina-recker-logo.png" alt="Frauenarztpraxis Sabrina Recker"></a>
      <span class="mobile-mode-dot" title="Lokaler Testmodus" aria-label="Lokaler Testmodus"></span>
    </header>
    <aside class="app-sidebar" aria-label="Hauptnavigation">
      <div class="sidebar-top">
        <a class="sidebar-brand" href="/" aria-label="Frauenarztpraxis Sabrina Recker · Terminübersicht">
          <img src="/assets/praxis-sabrina-recker-logo.png" alt="Frauenarztpraxis Sabrina Recker">
        </a>
        <button class="nav-close" type="button" aria-label="Navigation schließen">${icon('close')}</button>
      </div>
      <nav class="primary-navigation">
        ${navItems.map((item) => `<a href="${item.href}" class="nav-item${active === item.id ? ' active' : ''}" ${active === item.id ? 'aria-current="page"' : ''} data-nav-id="${item.id}" data-tooltip="${item.label}">${icon(item.icon)}<span>${item.label}</span></a>`).join('')}
      </nav>
      <button class="sidebar-collapse" type="button" aria-label="Menü einklappen" aria-expanded="true" data-tooltip="Menü einklappen">
        ${icon('collapse')}<span>Menü einklappen</span>
      </button>
      <div class="sidebar-status">
        <a class="mode-line" href="/settings.html#system" title="Testmodus · kein echter SMS-Versand">
          <span class="status-dot warning"></span><span>Testmodus</span>
        </a>
        <a class="connection-line" id="nav-connection" href="/settings.html#system" title="Datenbankverbindung wird geprüft">
          <span class="status-dot"></span><span>Verbindung wird geprüft</span>
        </a>
        <span class="version-line" id="nav-version">Version wird geprüft</span>
      </div>
    </aside>
    <button class="nav-backdrop" type="button" tabindex="-1" aria-label="Navigation schließen"></button>`;

  const toggle = mount.querySelector('.nav-toggle');
  const close = mount.querySelector('.nav-close');
  const backdrop = mount.querySelector('.nav-backdrop');
  const collapse = mount.querySelector('.sidebar-collapse');
  const collapseStorageKey = 'smsreminder.navigationCollapsed';
  const syncCollapsedNavigation = (collapsed) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    collapse.setAttribute('aria-label', collapsed ? 'Menü ausklappen' : 'Menü einklappen');
    collapse.dataset.tooltip = collapsed ? 'Menü ausklappen' : 'Menü einklappen';
    collapse.querySelector('span').textContent = collapsed ? 'Menü ausklappen' : 'Menü einklappen';
  };
  try {
    const storedCollapsed = localStorage.getItem(collapseStorageKey);
    const compactViewport = window.matchMedia('(min-width: 760px) and (max-width: 1199px)').matches;
    syncCollapsedNavigation(storedCollapsed === null ? compactViewport : storedCollapsed === 'true');
  } catch {
    syncCollapsedNavigation(window.matchMedia('(min-width: 760px) and (max-width: 1199px)').matches);
  }
  collapse.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    syncCollapsedNavigation(collapsed);
    try { localStorage.setItem(collapseStorageKey, String(collapsed)); } catch { /* Browser-Speicher ist optional. */ }
  });
  const setOpen = (open) => {
    document.body.classList.toggle('navigation-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Navigation schließen' : 'Navigation öffnen');
    if (open) close.focus();
    else toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('navigation-open')));
  close.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));
  mount.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    if (document.body.classList.contains('navigation-open')) setOpen(false);
  }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('navigation-open')) setOpen(false);
  });

  const connection = mount.querySelector('#nav-connection');
  const version = mount.querySelector('#nav-version');
  const modeLine = mount.querySelector('.mode-line');
  const mobileMode = mount.querySelector('.mobile-mode-dot');
  Promise.allSettled([api('/api/health'), api('/api/update-status'), api('/api/session')]).then(([healthResult, updateResult, sessionResult]) => {
    if (healthResult.status === 'fulfilled') {
      const health = healthResult.value;
      const label = health.markerConfigured ? 'Datenbank bereit' : 'Marker fehlt';
      connection.className = `connection-line ${health.markerConfigured ? 'online' : 'warning'}`;
      connection.querySelector('span:last-child').textContent = label;
      connection.title = `${health.database} · MariaDB ${health.version} · nur lesen${health.markerConfigured ? '' : ' · Freigabemarker fehlt'}`;
    } else {
      connection.className = 'connection-line offline';
      connection.querySelector('span:last-child').textContent = 'Nicht erreichbar';
      connection.title = escapeHtml(healthResult.reason?.message || 'Datenbank nicht erreichbar');
    }
    if (updateResult.status === 'fulfilled') version.textContent = `Version ${updateResult.value.currentVersion}`;
    else version.textContent = 'Version unbekannt';
    if (sessionResult.status === 'fulfilled') {
      const testMode = sessionResult.value.smsMode === 'mock';
      modeLine.querySelector('span:last-child').textContent = testMode ? 'Testmodus' : 'seven RCS/SMS';
      modeLine.title = testMode ? 'Testmodus · kein echter Versand' : 'Echtversand · RCS mit SMS-Fallback oder SMS';
      modeLine.querySelector('.status-dot').className = `status-dot ${testMode ? 'warning' : 'online'}`;
      mobileMode.title = modeLine.title;
      mobileMode.setAttribute('aria-label', modeLine.title);
    }
  });
}
