import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const sched = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Täglich 03:37', parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 37 }] }, misfirePolicy: 'skip' } }
});

const call = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Aufbewahrungsfristen anwenden',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-jobs',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"action":"purge"}',
      options: { timeout: 140000 }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Review Worker') }
  }
});

export default workflow('rv-f-ops', 'PILEOT Review F: Betrieb (Teil 2, im selben Workflow)').add(sched).to(call);
