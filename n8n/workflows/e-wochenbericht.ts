import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const sched = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Montag und Dienstag morgens, stündlich', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '17 6-12 * * 1,2' }] }, misfirePolicy: 'skip' } }
});

const call = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Wochenberichte senden',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-jobs',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: '{"action":"weekly-report"}',
      options: { timeout: 140000 }
    },
    credentials: { httpHeaderAuth: newCredential('PILEOT Review Worker') }
  }
});

export default workflow('rv-e-report', 'PILEOT Review E: Wochenbericht').add(sched).to(call);
