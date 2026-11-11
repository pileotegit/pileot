// Token aus ?t= oder #t= lesen und danach aus der Adresszeile entfernen.
window.rvToken = function () {
  var q = new URLSearchParams(location.search).get('t');
  var h = new URLSearchParams(location.hash.slice(1)).get('t');
  var t = q || h || '';
  if (t) history.replaceState(null, '', location.pathname);
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
};
window.rvPost = function (path, body) {
  return fetch(window.RV_CONFIG.apiBase + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    referrerPolicy: 'no-referrer',
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
};
window.rvShow = function (id) {
  document.querySelectorAll('[data-state]').forEach(function (el) { el.hidden = el.id !== id; });
};
