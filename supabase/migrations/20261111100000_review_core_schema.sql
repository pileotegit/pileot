-- PILEOT Google Review Automation, V1: Kernschema
--
-- Prinzipien
--   * Alle Tabellen liegen im Schema "review". Das Schema wird nicht über die API exponiert.
--   * Kein Zugriff für anon/authenticated/service_role auf Tabellen. Zugriff nur über
--     SECURITY-DEFINER-RPCs im Schema "public" (Präfix rv_, siehe nächste Migration).
--   * RLS ist auf allen Tabellen aktiv, es gibt bewusst keine Policies (deny-by-default).
--   * Mandantentrennung zusätzlich im Schema: zusammengesetzte Fremdschlüssel (tenant_id, id).
--   * Zeitstempel in UTC (timestamptz). Geschäftszeiten werden in der Mandantenzeitzone berechnet.
--   * Sichere Standardwerte: Mandant "paused", Testmodus an, globaler Versand pausiert.

create schema if not exists review;
revoke all on schema review from public;

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen (ohne Tabellenzugriff)
-- ---------------------------------------------------------------------------

create function review.email_hash(p_email text) returns bytea
language sql immutable parallel safe set search_path = ''
as $$ select sha256(convert_to(lower(btrim(p_email)), 'UTF8')) $$;

create function review.token_hash(p_token text) returns bytea
language sql immutable parallel safe set search_path = ''
as $$ select sha256(convert_to(p_token, 'UTF8')) $$;

-- 2 x UUIDv4 aus dem kryptografischen Zufallsgenerator des Servers = 244 Bit Zufall, hex.
create function review.new_token() returns text
language sql volatile set search_path = ''
as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

-- Liefert p_now, wenn p_now im Versandfenster liegt, sonst den Beginn des nächsten Fensters.
-- Rechnet in der Mandantenzeitzone, also korrekt über Sommerzeitwechsel hinweg.
create function review.next_send_slot(
  p_now timestamptz, p_tz text, p_start time, p_end time, p_weekdays smallint[]
) returns timestamptz
language plpgsql stable set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone p_tz;
  v_day date := v_local::date;
  v_candidate timestamp;
  i int;
begin
  if extract(isodow from v_local)::smallint = any (p_weekdays)
     and v_local::time >= p_start and v_local::time < p_end then
    return p_now;
  end if;
  for i in 0..8 loop
    v_candidate := (v_day + i) + p_start;
    if extract(isodow from v_candidate)::smallint = any (p_weekdays) and v_candidate > v_local then
      return v_candidate at time zone p_tz;
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- Mandanten, Standorte, Einstellungen, Integrationen
-- ---------------------------------------------------------------------------

create table review.system_settings (
  id boolean primary key default true check (id),
  send_paused boolean not null default true,
  -- Grund einer automatischen Pause (z. B. Provider lehnt API-Key ab). NULL = manuell oder nicht pausiert.
  pause_reason text check (char_length(pause_reason) <= 200),
  updated_at timestamptz not null default now()
);
insert into review.system_settings (id) values (true);

create table review.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  timezone text not null default 'Europe/Berlin'
    check ((now() at time zone timezone) is not null),
  status text not null default 'paused' check (status in ('active', 'paused')),
  created_at timestamptz not null default now()
);

create table review.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references review.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  -- Ziel der Weiterleitung. Nur Google-Hosts, keine Open-Redirect-Pfade von Google.
  google_review_url text not null
    check (char_length(google_review_url) <= 500
       and google_review_url ~ '^https://(g\.page|search\.google\.com|www\.google\.com|maps\.app\.goo\.gl|g\.co)/[^[:space:]@]*$'
       and google_review_url !~* '^https://[^/]+/(url|amp|aclk|pagead)([/?#]|$)'),
  google_location_id text,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table review.tenant_settings (
  tenant_id uuid primary key references review.tenants (id) on delete cascade,
  sender_name text not null check (char_length(sender_name) between 1 and 100),
  sender_email text not null check (sender_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  reply_to_email text not null check (reply_to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Freigegebene Empfängerin des Wochenberichts
  report_recipient_email text not null check (report_recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  send_window_start time not null default '09:00',
  send_window_end time not null default '18:00',
  send_weekdays smallint[] not null default '{1,2,3,4,5}'
    check (cardinality(send_weekdays) between 1 and 7
       and send_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  initial_delay_minutes int not null default 120 check (initial_delay_minutes between 0 and 4320),
  reminder_delay_hours int not null default 48 check (reminder_delay_hours between 24 and 336),
  max_sends_per_day int not null default 20 check (max_sends_per_day between 1 and 500),
  stale_after_hours int not null default 72 check (stale_after_hours between 1 and 720),
  template_version text not null default 'v1',
  -- Testmodus: nur Adressen aus test_recipients erhalten E-Mails, alle anderen Dry Run.
  test_mode boolean not null default true,
  test_recipients text[] not null default '{}',
  retention_days int not null default 365 check (retention_days between 30 and 1095),
  check (send_window_end > send_window_start)
);

create table review.integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  source text not null check (char_length(source) between 1 and 64),
  key_hash bytea not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, location_id) references review.locations (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Kontakte, Sperrliste
-- ---------------------------------------------------------------------------

create table review.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references review.tenants (id) on delete cascade,
  external_ref text not null check (char_length(external_ref) between 1 and 128),
  first_name text check (char_length(first_name) <= 80),
  email_normalized text not null
    check (email_normalized = lower(btrim(email_normalized))
       and email_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       and char_length(email_normalized) <= 254),
  -- Dokumentierte Versandgrundlage. NULL bedeutet: nicht versenden.
  consent_basis text check (consent_basis in ('explicit_opt_in', 'documented_other')),
  consent_source text check (char_length(consent_source) <= 200),
  consent_documented_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, external_ref),
  unique (tenant_id, email_normalized),
  check (consent_basis is null or (consent_source is not null and consent_documented_at is not null))
);

-- Dauerhafte Sperre. Bewusst ohne Fremdschlüssel auf contacts: Eine Kontaktlöschung
-- hebt die Sperre nicht auf. Gespeichert wird nur der Hash der normalisierten Adresse.
create table review.suppressions (
  tenant_id uuid not null references review.tenants (id) on delete cascade,
  email_hash bytea not null,
  reason text not null check (reason in ('unsubscribe', 'hard_bounce', 'complaint', 'manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, email_hash)
);

-- ---------------------------------------------------------------------------
-- Abschlussereignisse, Kampagnen, Versandaufträge
-- ---------------------------------------------------------------------------

create table review.completion_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  contact_id uuid not null,
  source text not null check (char_length(source) between 1 and 64),
  external_event_id text not null check (char_length(external_event_id) between 1 and 128),
  completed_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, source, external_event_id),
  foreign key (tenant_id, location_id) references review.locations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references review.contacts (tenant_id, id) on delete cascade
);

create table review.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  location_id uuid not null,
  contact_id uuid not null,
  event_id uuid not null,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  end_reason text check (end_reason in (
    'unsubscribe', 'hard_bounce', 'complaint', 'suppressed', 'no_consent', 'expired',
    'dry_run', 'send_failed', 'manual', 'reminder_sent', 'qualified_click')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  -- V1-Regel: höchstens eine Kampagne pro Kontakt und Standort.
  unique (tenant_id, location_id, contact_id),
  foreign key (tenant_id, location_id) references review.locations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references review.contacts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, event_id) references review.completion_events (tenant_id, id) on delete cascade,
  check ((status = 'active') = (end_reason is null))
);

create table review.send_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid not null,
  kind text not null check (kind in ('initial', 'reminder')),
  -- Dauerhafter Geschäftsschlüssel, zugleich Idempotenzschlüssel beim Provider.
  business_key text not null check (char_length(business_key) <= 128),
  idempotency_key text not null check (char_length(idempotency_key) <= 256),
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'sending', 'sent', 'unknown', 'failed', 'cancelled', 'dry_run')),
  due_at timestamptz not null,
  attempts int not null default 0,
  max_attempts int not null default 4 check (max_attempts between 1 and 10),
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  provider text not null default 'resend',
  provider_message_id text,
  delivery_state text not null default 'unknown'
    check (delivery_state in ('unknown', 'delayed', 'delivered', 'bounced', 'complained')),
  last_error_class text check (last_error_class in ('transient', 'permanent', 'unknown_outcome')),
  last_error_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, business_key),
  unique (tenant_id, campaign_id, kind),
  foreign key (tenant_id, campaign_id) references review.campaigns (tenant_id, id) on delete cascade
);
create index send_jobs_queued_due_idx on review.send_jobs (due_at) where status = 'queued';
create index send_jobs_lease_idx on review.send_jobs (lease_expires_at) where status in ('claimed', 'sending');
create index send_jobs_provider_msg_idx on review.send_jobs (provider, provider_message_id) where provider_message_id is not null;
create index send_jobs_claimed_at_idx on review.send_jobs (tenant_id, claimed_at) where claimed_at is not null;

-- Links in E-Mails: nur der Hash des Tokens wird gespeichert.
create table review.link_tokens (
  token_hash bytea primary key,
  tenant_id uuid not null,
  campaign_id uuid not null,
  job_id uuid not null,
  purpose text not null check (purpose in ('click', 'unsub')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (tenant_id, campaign_id) references review.campaigns (tenant_id, id) on delete cascade,
  foreign key (tenant_id, job_id) references review.send_jobs (tenant_id, id) on delete cascade
);
create index link_tokens_campaign_idx on review.link_tokens (tenant_id, campaign_id);

-- ---------------------------------------------------------------------------
-- Ereignisse
-- ---------------------------------------------------------------------------

create table review.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null check (char_length(provider_event_id) <= 128),
  tenant_id uuid not null,
  job_id uuid not null,
  event_type text not null
    check (event_type in ('delivered', 'delayed', 'bounced_hard', 'bounced_soft', 'complained')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id),
  foreign key (tenant_id, job_id) references review.send_jobs (tenant_id, id) on delete cascade
);

-- Rohaufrufe getrennt von bewusst bestätigten Klicks. Keine IP, kein User-Agent.
create table review.click_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid not null,
  click_class text not null check (click_class in ('raw', 'qualified')),
  occurred_at timestamptz not null default now(),
  foreign key (tenant_id, campaign_id) references review.campaigns (tenant_id, id) on delete cascade
);
create index click_events_campaign_idx on review.click_events (tenant_id, campaign_id);

-- ---------------------------------------------------------------------------
-- RLS: aktiv, ohne Policies (deny-by-default). Keine Rechte für API-Rollen.
-- ---------------------------------------------------------------------------

alter table review.system_settings enable row level security;
alter table review.tenants enable row level security;
alter table review.locations enable row level security;
alter table review.tenant_settings enable row level security;
alter table review.integrations enable row level security;
alter table review.contacts enable row level security;
alter table review.suppressions enable row level security;
alter table review.completion_events enable row level security;
alter table review.campaigns enable row level security;
alter table review.send_jobs enable row level security;
alter table review.link_tokens enable row level security;
alter table review.provider_events enable row level security;
alter table review.click_events enable row level security;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema review from %I', r);
      execute format('revoke all on all tables in schema review from %I', r);
      execute format('revoke all on all sequences in schema review from %I', r);
      execute format('revoke all on all functions in schema review from %I', r);
    end if;
  end loop;
end
$$;
revoke all on all functions in schema review from public;
