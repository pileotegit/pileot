"""Öffnet Mail, Klickseite und Abmeldeseite in Chrome, klickt die Buttons, macht Screenshots
und prüft den Datenbankzustand über /__state. Aufruf: python3 browser_check.py <server-json>"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright

info = json.loads(sys.argv[1])
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/e2e'
base = info['click'].split('/r/')[0]
state = lambda: json.loads(urllib.request.urlopen(base + '/__state').read())
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 420, 'height': 820})
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('https://g.page/**', lambda route: route.fulfill(status=200, body='GOOGLE REVIEW PAGE'))

    pg.goto(base + '/__mail.html'); pg.screenshot(path=f'{out}-mail.png', full_page=True)

    pg.goto(info['click']); pg.wait_for_selector('#ready:not([hidden])')
    assert 'Kosmetikstudio Beispiel' in pg.inner_text('#ready'), pg.inner_text('body')
    assert '?t=' not in pg.url, 'Token muss aus der Adresszeile entfernt werden'
    s = state(); assert s['clicks'] == ['raw'], s
    assert s['camp'] == 'active:', s
    pg.screenshot(path=f'{out}-click.png', full_page=True)
    pg.click('#go'); pg.wait_for_url('https://g.page/**')
    s = state(); assert sorted(s['clicks']) == ['qualified', 'raw'], s
    assert s['camp'] == 'completed:qualified_click', s

    pg.goto(info['unsub']); pg.wait_for_selector('#ready:not([hidden])')
    assert state()['supp'] == 0
    pg.screenshot(path=f'{out}-unsub.png', full_page=True)
    pg.click('#confirm'); pg.wait_for_selector('#done:not([hidden])')
    assert state()['supp'] == 1
    pg.screenshot(path=f'{out}-unsub-done.png', full_page=True)

    assert not errors, errors
    # Ungültiger Token: API antwortet absichtlich mit 404, die Seite zeigt den Hinweis.
    pg.goto(base + '/r/?t=' + 'a' * 64); pg.wait_for_selector('#invalid:not([hidden])')
    b.close()

print('E2E OK')
