import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const sched = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Alle 4 Stunden', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '7 */4 * * *' }] }, misfirePolicy: 'skip' } }
});

const call = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Betriebsprüfung',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-jobs',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"action":"ops"}',
      options: { timeout: 140000 }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Review Worker') }
  }
});

export default workflow('rv-f-ops', 'PILEOT Review F: Betrieb (Teil 1)').add(sched).to(call);
