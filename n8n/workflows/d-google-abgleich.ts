import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const sched = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Täglich 05:23', parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 5, triggerAtMinute: 23 }] }, misfirePolicy: 'skip' } }
});

const call = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Google-Bewertungen abgleichen',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-jobs',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"action":"google-sync"}',
      options: { timeout: 140000 }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Review Worker') }
  }
});

export default workflow('rv-d-google', 'PILEOT Review D: Google-Abgleich').add(sched).to(call);
