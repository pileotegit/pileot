(function () {
  var ALLOWED = ['g.page', 'search.google.com', 'www.google.com', 'maps.app.goo.gl', 'g.co'];
  var t = rvToken();
  if (!t) return rvShow('invalid');

  // Seite geladen: als "raw" erfassen. Das stoppt keine Erinnerung (Scanner können Links öffnen).
  rvPost('/rv-click', { t: t, class: 'raw' }).then(function (r) {
    if (!r.valid) return rvShow('invalid');
    if (r.studio) document.getElementById('studio').textContent = ' bei ' + r.studio;
    rvShow('ready');
  }, function () { rvShow('error'); });

  document.getElementById('go').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    // Bewusster Klick: stoppt die Erinnerung und liefert das geprüfte Ziel.
    rvPost('/rv-click', { t: t, class: 'qualified' }).then(function (r) {
      var ok = false;
      try {
        var u = new URL(r.url);
        ok = u.protocol === 'https:' && ALLOWED.indexOf(u.hostname) >= 0 && !u.username;
      } catch (e) { ok = false; }
      if (!r.valid || !ok) return rvShow('invalid');
      location.replace(r.url);
    }, function () { btn.disabled = false; rvShow('error'); });
  });
})();
