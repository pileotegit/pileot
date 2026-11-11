(function () {
  var t = rvToken();
  if (!t) return rvShow('invalid');
  // Nur prüfen. Abgemeldet wird erst durch den bewussten Klick.
  rvPost('/rv-unsubscribe', { t: t, action: 'check' }).then(function (r) {
    rvShow(r.valid ? 'ready' : 'invalid');
  }, function () { rvShow('error'); });

  document.getElementById('confirm').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    rvPost('/rv-unsubscribe', { t: t, action: 'confirm' }).then(function (r) {
      rvShow(r.ok ? 'done' : 'invalid');
    }, function () { btn.disabled = false; rvShow('error'); });
  });
})();
