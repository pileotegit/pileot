// Eintragsformular für das Studio. Der Zugangsschlüssel steht im Linkanker (#k=rvk_...),
// wird also nie an den Webserver übertragen, nur an rv-ingest. Es wird nichts im Browser gespeichert.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var key = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  if (!/^rvk_[0-9a-f]{64}$/.test(key)) { $('nokey').hidden = false; return; }
  $('form').hidden = false;

  var REASONS = {
    suppressed: 'Diese Adresse hat sich abgemeldet und wird nicht angeschrieben.',
    no_consent: 'Ohne Zustimmung der Kundin wird nichts versendet.',
    campaign_exists: 'Diese Kundin hat bereits eine Bewertungsanfrage bekommen.',
    stale_event: 'Der Termin liegt zu weit zurück.',
    future_event: 'Der Termin liegt in der Zukunft.',
    tenant_paused: 'Der Versand ist für Ihr Studio gerade pausiert. Der Eintrag wurde nicht übernommen.',
    location_paused: 'Der Versand ist für Ihr Studio gerade pausiert. Der Eintrag wurde nicht übernommen.',
    integration_invalid: 'Ihr Zugang ist ungültig oder wurde widerrufen. Bitte bei PILEOT melden.',
    invalid_payload: 'Bitte die E-Mail-Adresse prüfen.',
  };

  function localNow() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  $('completedAt').value = localNow();

  function show(text, ok) {
    $('result').textContent = text;
    $('result').className = 'result ' + (ok ? 'ok' : 'err');
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = $('email').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return show('Bitte eine gültige E-Mail-Adresse eingeben.');
    if (!$('consent').checked) return show('Bitte nur eintragen, wenn die Kundin zugestimmt hat.');
    var completed = $('completedAt').value ? new Date($('completedAt').value) : new Date();
    if (isNaN(completed.getTime())) return show('Bitte Datum und Uhrzeit prüfen.');
    var btn = $('submit');
    btn.disabled = true;
    show('Wird eingetragen ...', true);
    // Stabile Kennung der Kundin ohne Klartext: Hash der Adresse.
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)).then(function (h) {
      var now = new Date().toISOString();
      return fetch(window.RV_CONFIG.apiBase + '/rv-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({
          event_id: 'form-' + crypto.randomUUID(),
          contact_ref: 'mail-' + hex(h).slice(0, 32),
          email: email,
          first_name: $('firstName').value.trim() || null,
          completed_at: completed.toISOString(),
          consent: { basis: 'explicit_opt_in', source: 'Eintragsformular Studio', documented_at: now },
        }),
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; });
    }).then(function (b) {
      btn.disabled = false;
      if (b.result === 'created') {
        show('Eingetragen. Die Anfrage geht zum passenden Zeitpunkt raus.', true);
        $('email').value = '';
        $('firstName').value = '';
        $('consent').checked = false;
        $('completedAt').value = localNow();
        $('email').focus();
        return;
      }
      if (b.result === 'duplicate') return show('War bereits eingetragen.', true);
      show(REASONS[b.reason] || 'Das hat nicht geklappt. Bitte später erneut versuchen.');
    }, function () {
      btn.disabled = false;
      show('Keine Verbindung. Bitte später erneut versuchen.');
    });
  });
})();
