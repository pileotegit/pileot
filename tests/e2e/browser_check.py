"""Öffnet Mail, Klickseite und Abmeldeseite in Chrome, klickt die Buttons, macht Screenshots
und prüft den Datenbankzustand über /__state. Aufruf: python3 browser_check.py <server-json>"""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright

info = json.loads(sys.argv[1])
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/e2e'
base = info['click'].split('/r/')[0]
state = lambda: json.loads(urllib.request.urlopen(base + '/__state').read())
errors = []

def until(fn, what, timeout=8.0):
    # Polling statt wait_for_function: die Seiten verbieten eval per CSP (gewollt).
    import time
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise AssertionError('Timeout: ' + what)

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

    # ------------------------------------------------------------ Admin-Formular
    count = lambda: json.loads(urllib.request.urlopen(base + '/__campaigns').read())['n']
    errors.clear()
    a = b.new_page(viewport={'width': 1440, 'height': 1000})
    a.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    a.on('pageerror', lambda e: errors.append(str(e)))
    a.goto(base + '/admin/')
    a.fill('#secret', 'falsch'); a.click('#loginBtn')
    a.wait_for_selector('#loginMsg.err'); assert 'Passwort' in a.inner_text('#loginMsg')
    a.fill('#secret', info['admin_secret']); a.click('#loginBtn')
    a.wait_for_selector('#app:not([hidden])')
    until(lambda: a.inner_text('#pvSubject').__contains__('Kosmetikstudio Beispiel'), "pvSubject")
    assert a.input_value('#f_name') == 'Kosmetikstudio Beispiel'
    assert a.locator('#tenantSelect option').count() == 2

    a.click('#newBtn'); until(lambda: a.inner_text('#formTitle') == 'Neue Kundin', "formTitle")
    until(lambda: a.input_value('#f_initial_button') == 'Bewertung bei Google schreiben', "f_initial_button")
    for k, v in {'name': 'Kosmetik Lena', 'location_name': 'Kosmetikstudio Lena',
                 'google_review_url': 'https://evil.example/review', 'sender_name': 'Kosmetikstudio Lena',
                 'sender_email': 'bewertung@mail.pileot.de', 'reply_to_email': 'lena@example.test',
                 'report_recipient_email': 'lena@example.test', 'test_recipients': 'malik@example.test',
                 'greeting_named': 'Liebe {{vorname}},', 'initial_subject': 'Danke für Ihren Besuch bei {{studio}}',
                 'imprint_text': 'Lena Muster, Musterstr. 1, 72070 Tübingen'}.items():
        a.fill('#f_' + k, v)
    until(lambda: a.inner_text('#pvSubject') == 'Danke für Ihren Besuch bei Kosmetikstudio Lena', "pvSubject")
    frame = a.frame_locator('#pvFrame')
    assert 'Liebe Anna,' in frame.locator('body').inner_text()
    assert 'Tübingen' in frame.locator('body').inner_text()
    a.click('#saveBtn'); a.wait_for_selector('#saveMsg.err')
    assert 'Google-Bewertungslink' in a.inner_text('#saveMsg'), a.inner_text('#saveMsg')
    assert count() == 1
    a.fill('#f_google_review_url', 'https://g.page/r/LENA123/review')
    a.click('#saveBtn'); until(lambda: a.inner_text('#saveMsg').startswith('Angelegt'), "saveMsg")
    assert 'Pausiert' in a.inner_text('#statusLine')
    a.click('.tab[data-kind=reminder]'); until(lambda: a.inner_text('#pvSubject').startswith('Kurze Erinnerung'), "pvSubject")
    a.click('.tab[data-kind=initial]')
    a.screenshot(path=f'{out}-admin.png', full_page=True)

    a.click('#keyBtn'); a.wait_for_selector('#keyOut:not([hidden])')
    entry = a.inner_text('#entryLink')
    assert '#k=rvk_' in entry, entry

    # ------------------------------------------------------------ Eintragsformular
    e = b.new_page(viewport={'width': 420, 'height': 820})
    e.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    e.goto(entry); e.wait_for_selector('#form:not([hidden])')
    e.fill('#email', 'Kundin.Neu@example.test'); e.fill('#firstName', 'Sara')
    e.click('#submit'); e.wait_for_selector('#result.err')
    assert 'zugestimmt' in e.inner_text('#result')
    e.check('#consent'); e.click('#submit'); until(lambda: e.inner_text('#result').__contains__('pausiert'), "result")
    assert count() == 1, 'pausiert: nichts angelegt'

    a.click('#testRunBtn'); until(lambda: a.inner_text('#statusLine').__contains__('Testbetrieb'), "statusLine")
    e.check('#consent'); e.click('#submit'); e.wait_for_selector('#result.ok >> text=Eingetragen')
    assert count() == 2
    e.screenshot(path=f'{out}-eintragen.png', full_page=True)
    e.fill('#email', 'kundin.neu@example.test'); e.check('#consent'); e.click('#submit')
    until(lambda: e.inner_text('#result').__contains__('bereits'), "result")
    assert count() == 2

    a.click('details summary'); a.fill('#confirmName', 'Kosmetik Lena'); a.click('#goLiveBtn')
    until(lambda: a.inner_text('#goLiveMsg').__contains__('Testmail'), "goLiveMsg")
    # Erwartete Fehlerantworten (401 falsches Passwort, 422 Speichern und rv-ingest) erzeugen Konsolenmeldungen der Ressourcen.
    unexpected = [x for x in errors if 'status of 422' not in x and 'status of 401' not in x]
    assert not unexpected, unexpected

    n = b.new_page(); n.goto(base + '/eintragen/'); n.wait_for_selector('#nokey:not([hidden])')
    b.close()

print('E2E OK')
