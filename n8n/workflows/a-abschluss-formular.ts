import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Termin abgeschlossen (Formular)',
    parameters: {
      authentication: 'basicAuth',
      formTitle: 'Termin abgeschlossen',
      formDescription: 'Nach dem Termin eintragen. Die Kundin erhält frühestens 2 Stunden später und nur innerhalb der Versandzeiten eine E-Mail mit der Bitte um eine Google-Bewertung, dazu höchstens eine Erinnerung.',
      formFields: {
        values: [
          { fieldLabel: 'Vorname der Kundin', fieldName: 'vorname', fieldType: 'text', placeholder: 'Anna', requiredField: false },
          { fieldLabel: 'E-Mail der Kundin', fieldName: 'email', fieldType: 'email', placeholder: 'kundin@example.de', requiredField: true },
          { fieldLabel: 'Einwilligung', fieldName: 'einwilligung', fieldType: 'checkbox',
            fieldOptions: { values: [{ option: 'Die Kundin hat zugestimmt, per E-Mail um eine Bewertung gebeten zu werden.' }] }, requiredField: true }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Eintragen', path: 'pileot-termin-abgeschlossen', ignoreBots: true }
    },
    credentials: { httpBasicAuth: newCredential('PILEOT Studio Formular Login') }
  }
});

const ingest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Abschluss an rv-ingest senden',
    retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-ingest',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify({ event_id: 'form-' + $execution.id, contact_ref: 'email:' + String($json.email).trim().toLowerCase(), email: String($json.email).trim(), first_name: ($json.vorname || '').trim() || null, completed_at: $now.toISO(), consent: { basis: 'explicit_opt_in', source: 'Studio-Formular: Einwilligung von der Inhaberin bestätigt', documented_at: $now.toISO() } }) }}"),
      options: { timeout: 20000, response: { response: { neverError: true, responseFormat: 'json' } } }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Studio Integration Key') }
  }
});

const done = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Ergebnis anzeigen',
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: expr("{{ $json.result === 'created' ? 'Eingetragen' : ($json.result === 'duplicate' ? 'Bereits eingetragen' : 'Nicht eingetragen') }}"),
      completionMessage: expr("{{ $json.result === 'created' ? 'Die Bewertungsanfrage ist geplant.' : ($json.result === 'duplicate' ? 'Dieser Termin war schon erfasst.' : ({ suppressed: 'Diese Adresse hat sich abgemeldet oder ist gesperrt.', campaign_exists: 'Diese Kundin wurde bereits angeschrieben.', tenant_paused: 'Der Versand ist pausiert. Bitte bei PILEOT melden.', invalid_payload: 'Bitte die E-Mail-Adresse prüfen.', no_consent: 'Ohne Einwilligung wird keine E-Mail verschickt.', integration_invalid: 'Technischer Fehler (Zugang). Bitte bei PILEOT melden.' }[$json.reason] || 'Technischer Fehler. Bitte bei PILEOT melden.')) }}")
    }
  }
});

export default workflow('rv-a-intake', 'PILEOT Review A: Abschluss aufnehmen').add(form).to(ingest).to(done);
