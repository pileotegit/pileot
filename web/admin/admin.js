// Kundenverwaltung: alle kundenspezifischen Angaben pflegen, Mails live ansehen, Schlüssel
// erzeugen, Testbetrieb und Livegang. Spricht nur mit rv-admin. Kein Speicher im Browser.
(function () {
  'use strict';

  var PH = 'Platzhalter: {{studio}} = Studioname. ';
  var FIELDS = [
    { section: 'Kunde und Studio' },
    { key: 'name', label: 'Kundenname (intern)', req: true, help: 'Zum Beispiel der Firmenname. Wird beim Livegang zur Bestätigung abgefragt.' },
    { key: 'location_name', label: 'Studioname', req: true, help: 'So heißt das Studio in den Mails ({{studio}}).' },
    { key: 'google_review_url', label: 'Google-Bewertungslink', type: 'url', req: true,
      help: 'Im Google-Unternehmensprofil unter "Nach Rezensionen fragen" kopieren. Erlaubt: g.page, search.google.com, www.google.com, maps.app.goo.gl, g.co.' },
    { key: 'timezone', label: 'Zeitzone', type: 'select', options: ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Sarajevo'] },

    { section: 'Absender und Empfänger' },
    { key: 'sender_name', label: 'Absendername', req: true, help: 'Steht im Postfach der Kundin als Absender, z. B. "Kosmetikstudio Lena".' },
    { key: 'sender_email', label: 'Absenderadresse', type: 'email', req: true, help: 'Muss auf der bei Resend bestätigten Domain liegen, z. B. bewertung@mail.pileot.de.' },
    { key: 'reply_to_email', label: 'Antwortadresse', type: 'email', req: true, help: 'Antworten der Kundinnen landen hier (Postfach des Studios).' },
    { key: 'report_recipient_email', label: 'Empfängerin Wochenbericht', type: 'email', req: true },
    { key: 'report_enabled', label: 'Wochenbericht montags senden', type: 'checkbox' },

    { section: 'Testmodus' },
    { key: 'test_recipients', label: 'Testadressen', type: 'emails', help: 'Eine pro Zeile. Im Testmodus bekommen nur diese Adressen echte Mails, alle anderen werden nur protokolliert.' },

    { section: 'Versandregeln' },
    { key: 'send_window_start', label: 'Versand frühestens um', type: 'time' },
    { key: 'send_window_end', label: 'Versand spätestens bis', type: 'time' },
    { key: 'send_weekdays', label: 'Versandtage', type: 'weekdays' },
    { key: 'initial_delay_minutes', label: 'Erste Mail nach Terminende (Minuten)', type: 'number', min: 0, max: 4320 },
    { key: 'reminder_delay_hours', label: 'Erinnerung nach (Stunden)', type: 'number', min: 24, max: 336, help: 'Genau eine Erinnerung. Entfällt, wenn die Kundin den Bewertungsbutton geklickt oder sich abgemeldet hat.' },
    { key: 'max_sends_per_day', label: 'Höchstens Mails pro Tag', type: 'number', min: 1, max: 500 },
    { key: 'stale_after_hours', label: 'Termine älter als (Stunden) nicht mehr anschreiben', type: 'number', min: 1, max: 720 },
    { key: 'retention_days', label: 'Kundendaten löschen nach (Tagen)', type: 'number', min: 30, max: 1095 },

    { section: 'Texte für beide Mails', note: PH + '{{vorname}} nur in der Anrede mit Vorname. Leerzeile = neuer Absatz.' },
    { key: 'greeting_named', label: 'Anrede mit Vorname', help: 'Z. B. "Hallo {{vorname}}," oder "Liebe {{vorname}},".' },
    { key: 'greeting_anonymous', label: 'Anrede ohne Vorname' },
    { key: 'signature', label: 'Grußformel', type: 'textarea' },
    { key: 'footer_text', label: 'Fußzeile', type: 'textarea' },
    { key: 'unsubscribe_label', label: 'Text des Abmeldelinks' },
    { key: 'imprint_text', label: 'Impressum im Fuß', type: 'textarea', help: 'Pflicht vor dem Livegang: Name des Studios bzw. der Inhaberin, Anschrift, Kontakt.' },
    { key: 'accent_color', label: 'Farbe des Buttons', type: 'color' },

    { section: 'Erste Mail', note: 'Der Text folgt direkt auf die Anrede. Danach kommt der Button mit dem Google-Link.' },
    { key: 'initial_subject', label: 'Betreff' },
    { key: 'initial_body', label: 'Text', type: 'textarea', rows: 6 },
    { key: 'initial_button', label: 'Button-Text' },
    { key: 'initial_closing', label: 'Zeile unter dem Button (optional)', type: 'textarea' },

    { section: 'Erinnerung' },
    { key: 'reminder_subject', label: 'Betreff' },
    { key: 'reminder_body', label: 'Text', type: 'textarea', rows: 5 },
    { key: 'reminder_button', label: 'Button-Text' },
    { key: 'reminder_closing', label: 'Zeile unter dem Button (optional)', type: 'textarea' },
  ];
  var DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  var secret = '';
  var current = null; // tenant_id oder null (neu)
  var tenant = null;
  var preview = null;
  var kind = 'initial';
  var timer = null;

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function msg(id, text, ok) {
    var m = $(id);
    m.textContent = text || '';
    m.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
  }

  function api(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    return fetch(window.RV_CONFIG.apiBase + '/rv-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rv-admin-secret': secret },
      body: JSON.stringify(body),
      referrerPolicy: 'no-referrer',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    });
  }
  function errText(r) {
    if (r.status === 401) return 'Nicht angemeldet oder falsches Passwort.';
    return (r.body && (r.body.message || r.body.error)) || ('Fehler ' + r.status);
  }

  // ---------------------------------------------------------------- Formular aufbauen
  function buildForm() {
    var box = $('fields');
    FIELDS.forEach(function (f) {
      if (f.section) {
        box.appendChild(el('h3', {}, f.section));
        if (f.note) box.appendChild(el('p', { class: 'muted' }, f.note));
        return;
      }
      // Wochentage: eigene Checkbox-Labels, daher außen kein <label> (keine verschachtelten Labels).
      var label = el(f.type === 'weekdays' ? 'div' : 'label', f.type === 'weekdays' ? { class: 'lbl' } : { for: 'f_' + f.key });
      label.appendChild(document.createTextNode(f.label));
      if (f.req) label.appendChild(el('span', { class: 'req' }, ' *'));
      var input;
      if (f.type === 'textarea' || f.type === 'emails') {
        input = el('textarea', { id: 'f_' + f.key, rows: String(f.rows || 3) });
      } else if (f.type === 'select') {
        input = el('select', { id: 'f_' + f.key });
        f.options.forEach(function (o) { input.appendChild(el('option', { value: o }, o)); });
      } else if (f.type === 'checkbox') {
        label = el('label', { class: 'check' });
        input = el('input', { id: 'f_' + f.key, type: 'checkbox' });
        label.appendChild(input);
        label.appendChild(document.createTextNode(f.label));
        box.appendChild(label);
        return;
      } else if (f.type === 'weekdays') {
        input = el('span', { id: 'f_' + f.key, class: 'days' });
        DAYS.forEach(function (d, i) {
          var l = el('label');
          l.appendChild(el('input', { type: 'checkbox', value: String(i + 1), 'data-day': '1' }));
          l.appendChild(document.createTextNode(d));
          input.appendChild(l);
        });
      } else {
        input = el('input', { id: 'f_' + f.key, type: f.type || 'text' });
        if (f.min !== undefined) input.setAttribute('min', String(f.min));
        if (f.max !== undefined) input.setAttribute('max', String(f.max));
      }
      label.appendChild(input);
      if (f.help) label.appendChild(el('span', { class: 'help' }, f.help));
      box.appendChild(label);
    });
  }

  function setValues(cfg) {
    FIELDS.forEach(function (f) {
      if (!f.key) return;
      var v = cfg[f.key];
      var input = $('f_' + f.key);
      if (f.type === 'checkbox') input.checked = !!v;
      else if (f.type === 'weekdays') {
        input.querySelectorAll('input').forEach(function (c) { c.checked = (v || []).indexOf(Number(c.value)) >= 0; });
      } else if (f.type === 'emails') input.value = (v || []).join('\n');
      else input.value = v === undefined || v === null ? '' : String(v);
    });
  }

  function collect() {
    var cfg = {};
    FIELDS.forEach(function (f) {
      if (!f.key) return;
      var input = $('f_' + f.key);
      if (f.type === 'checkbox') cfg[f.key] = input.checked;
      else if (f.type === 'weekdays') {
        cfg[f.key] = Array.prototype.filter.call(input.querySelectorAll('input'), function (c) { return c.checked; })
          .map(function (c) { return Number(c.value); });
      } else if (f.type === 'emails') {
        cfg[f.key] = input.value.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      } else if (f.type === 'number') {
        var n = Number(input.value);
        cfg[f.key] = input.value.trim() !== '' && Number.isInteger(n) ? n : input.value;
      } else cfg[f.key] = input.value;
    });
    return cfg;
  }

  function missingRequired(cfg) {
    return FIELDS.filter(function (f) { return f.req && !String(cfg[f.key] || '').trim(); }).map(function (f) { return f.label; });
  }

  // ---------------------------------------------------------------- Vorschau
  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(runPreview, 500);
  }
  function runPreview() {
    api('preview', { config: collect() }).then(function (r) {
      if (r.status !== 200) return;
      preview = r.body;
      showPreview();
    });
  }
  function showPreview() {
    if (!preview) return;
    var m = preview[kind];
    $('pvFrom').textContent = preview.from;
    $('pvReply').textContent = preview.reply_to || '';
    $('pvSubject').textContent = m.subject;
    $('pvSubject2').textContent = preview[kind + '_ohne_vorname'];
    $('pvFrame').srcdoc = m.html;
  }

  // ---------------------------------------------------------------- Kundinnen
  function loadList(selectId) {
    return api('list').then(function (r) {
      if (r.status !== 200) return msg('globalMsg', errText(r));
      var sel = $('tenantSelect');
      sel.textContent = '';
      sel.appendChild(el('option', { value: '' }, r.body.tenants.length ? 'Bitte wählen' : 'Noch keine Kundin'));
      r.body.tenants.forEach(function (t) {
        var label = t.name + (t.status === 'active' ? (t.test_mode ? ' (Testbetrieb)' : ' (live)') : ' (pausiert)');
        sel.appendChild(el('option', { value: t.tenant_id }, label));
      });
      sel.value = selectId || '';
    });
  }

  function newTenant() {
    current = null;
    tenant = null;
    $('tenantSelect').value = '';
    $('formTitle').textContent = 'Neue Kundin';
    $('statusCard').hidden = true;
    $('keysCard').hidden = true;
    msg('saveMsg', '');
    return api('defaults').then(function (r) {
      if (r.status !== 200) return msg('globalMsg', errText(r));
      setValues(r.body);
      runPreview();
    });
  }

  function loadTenant(id) {
    return api('get', { tenant_id: id }).then(function (r) {
      if (r.status !== 200) return msg('globalMsg', errText(r));
      current = id;
      tenant = r.body;
      $('formTitle').textContent = tenant.config.name;
      setValues(tenant.config);
      renderStatus();
      renderKeys();
      msg('saveMsg', '');
      runPreview();
    });
  }

  function renderStatus() {
    var t = tenant;
    $('statusCard').hidden = false;
    var line = $('statusLine');
    line.textContent = '';
    var badge = function (text, cls) { line.appendChild(el('span', { class: 'badge ' + cls }, text)); };
    if (t.status === 'paused') badge('Pausiert', 'off');
    else if (t.test_mode) badge('Testbetrieb', 'warn');
    else badge('Live', 'on');
    badge(t.test_mode ? 'Testmodus an' : 'Testmodus aus', t.test_mode ? 'warn' : 'on');
    if (t.global_paused) badge('Versand global pausiert', 'off');
    line.appendChild(document.createTextNode(' Versendete Mails: ' + t.sent_total));
    $('pauseBtn').disabled = t.status !== 'active';
    $('testRunBtn').disabled = !(t.test_mode && t.status === 'paused');
    $('testOnBtn').disabled = t.test_mode;
    $('confirmName').value = '';
    msg('goLiveMsg', '');
  }

  function renderKeys() {
    $('keysCard').hidden = false;
    $('keyOut').hidden = true;
    var ul = $('keyList');
    ul.textContent = '';
    if (!tenant.integrations.length) ul.appendChild(el('li', {}, 'Noch kein Schlüssel.'));
    tenant.integrations.forEach(function (i) {
      var li = el('li');
      li.appendChild(el('span', {}, i.source + ', erstellt ' + new Date(i.created_at).toLocaleDateString('de-DE')));
      if (i.revoked_at) li.appendChild(el('span', { class: 'badge off' }, 'widerrufen'));
      else {
        li.appendChild(el('span', { class: 'badge on' }, 'aktiv'));
        var b = el('button', { type: 'button', class: 'secondary' }, 'Widerrufen');
        b.addEventListener('click', function () {
          if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Wirklich widerrufen?'; return; }
          api('revoke-key', { tenant_id: current, integration_id: i.id }).then(function () { loadTenant(current); });
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- Aktionen
  function save(ev) {
    ev.preventDefault();
    var cfg = collect();
    var miss = missingRequired(cfg);
    if (miss.length) return msg('saveMsg', 'Pflichtfelder fehlen: ' + miss.join(', '));
    $('saveBtn').disabled = true;
    msg('saveMsg', 'Speichere ...', true);
    api('save', { tenant_id: current, config: cfg }).then(function (r) {
      $('saveBtn').disabled = false;
      if (r.status !== 200) return msg('saveMsg', errText(r));
      var id = r.body.tenant_id;
      return loadList(id).then(function () { return loadTenant(id); }).then(function () {
        msg('saveMsg', r.body.created ? 'Angelegt. Status: pausiert, Testmodus an.' : 'Gespeichert.', true);
      });
    }, function () { $('saveBtn').disabled = false; msg('saveMsg', 'Keine Verbindung.'); });
  }

  function statusAction(action, extra) {
    return api(action, Object.assign({ tenant_id: current }, extra || {})).then(function (r) {
      if (r.status !== 200) { msg('globalMsg', errText(r)); return r; }
      msg('globalMsg', '');
      return loadList(current).then(function () { return loadTenant(current); }).then(function () { return r; });
    });
  }

  function init() {
    buildForm();
    $('loginBtn').addEventListener('click', function () {
      secret = $('secret').value.trim();
      api('list').then(function (r) {
        if (r.status !== 200) return msg('loginMsg', errText(r));
        $('secret').value = '';
        $('login').hidden = true;
        $('app').hidden = false;
        $('who').textContent = 'angemeldet';
        loadList().then(function () {
          if (r.body.tenants.length) { $('tenantSelect').value = r.body.tenants[0].tenant_id; return loadTenant(r.body.tenants[0].tenant_id); }
          return newTenant();
        });
      }, function () { msg('loginMsg', 'Keine Verbindung zur Schnittstelle.'); });
    });
    $('secret').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
    $('tenantSelect').addEventListener('change', function () { if (this.value) loadTenant(this.value); else newTenant(); });
    $('newBtn').addEventListener('click', newTenant);
    $('form').addEventListener('submit', save);
    $('form').addEventListener('input', schedulePreview);
    $('form').addEventListener('change', schedulePreview);
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
        kind = t.dataset.kind;
        showPreview();
      });
    });
    $('pauseBtn').addEventListener('click', function () { statusAction('set-status', { status: 'paused' }); });
    $('testRunBtn').addEventListener('click', function () { statusAction('set-status', { status: 'active' }); });
    $('testOnBtn').addEventListener('click', function () { statusAction('test-mode-on'); });
    $('goLiveBtn').addEventListener('click', function () {
      var names = { confirm_name_mismatch: 'Kundenname stimmt nicht', imprint_missing: 'Impressum fehlt', no_test_send: 'noch keine Testmail versendet' };
      statusAction('go-live', { confirm_name: $('confirmName').value }).then(function (r) {
        if (r.status !== 200) return;
        if (r.body.ok) return msg('goLiveMsg', r.body.global_paused ? 'Live. Achtung: Versand ist global noch pausiert.' : 'Live.', true);
        msg('goLiveMsg', 'Nicht live geschaltet: ' + r.body.missing.map(function (m) { return names[m] || m; }).join(', '));
      });
    });
    $('keyBtn').addEventListener('click', function () {
      api('create-key', { tenant_id: current, source: 'eintragsformular' }).then(function (r) {
        if (r.status !== 200) return msg('globalMsg', errText(r));
        return loadTenant(current).then(function () {
          $('keyValue').textContent = r.body.key;
          $('entryLink').textContent = new URL('../eintragen/', location.href).toString() + '#k=' + r.body.key;
          $('keyOut').hidden = false;
        });
      });
    });
  }

  init();
})();
