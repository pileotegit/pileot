import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const sched = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Alle 15 Minuten, 08 bis 18 Uhr', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '*/15 8-18 * * *' }] }, misfirePolicy: 'skip' } }
});

const call = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fällige Anfragen senden',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-jobs',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"action":"send"}',
      options: { timeout: 140000 }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Review Worker') }
  }
});

export default workflow('rv-b-send', 'PILEOT Review B: Versand').add(sched).to(call);
