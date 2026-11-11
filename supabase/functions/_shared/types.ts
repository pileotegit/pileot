// Gemeinsame Typen. Handler bekommen alle Abhängigkeiten injiziert, damit sie ohne Deno
// (in Node-Tests gegen echtes Postgres) und in Supabase Edge Functions gleich laufen.

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<any>;

export type Env = {
  /** Basis-URL der Funktionen, z. B. https://<ref>.supabase.co/functions/v1 */
  FUNCTIONS_BASE_URL: string;
  /** Statische Seite für den Bewertungsklick, z. B. https://link.pileot.de/r/ */
  CLICK_PAGE_URL: string;
  /** Statische Seite für die Abmeldung, z. B. https://link.pileot.de/abmelden/ */
  UNSUB_PAGE_URL: string;
  /** Kommagetrennte Origins der statischen Seiten (CORS) */
  ALLOWED_ORIGINS: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  WORKER_SECRET?: string;
  OPS_ALERT_EMAIL?: string;
  OPS_SENDER?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
};

export type Deps = {
  rpc: Rpc;
  env: Env;
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string, data?: Record<string, unknown>) => void;
};
