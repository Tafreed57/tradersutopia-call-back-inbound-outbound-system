create table public.callback_leads (
  id text primary key,
  phone text not null,
  phone_key text not null unique,
  created_at timestamptz not null default now(),
  name text not null default 'Lead',
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'called')),
  called_at timestamptz,
  called_by text not null default '',
  notes text not null default '',
  last_updated_at timestamptz not null default now(),
  called_number text not null default '',
  source_call_sid text not null default '',
  digits text not null default ''
);

create index callback_leads_status_created_idx
  on public.callback_leads (status, created_at desc);
create index callback_leads_created_idx
  on public.callback_leads (created_at desc);

create table public.callback_call_logs (
  log_id text primary key,
  created_at timestamptz not null default now(),
  lead_id text not null default '',
  action text not null,
  affiliate_phone text not null default '',
  details text not null default '',
  twilio_call_sid text not null default ''
);

create index callback_call_logs_created_idx
  on public.callback_call_logs (created_at desc);
create index callback_call_logs_twilio_sid_idx
  on public.callback_call_logs (twilio_call_sid)
  where twilio_call_sid <> '';

create table public.callback_recording_favorites (
  recording_sid text primary key,
  favorited_at timestamptz not null default now(),
  recording jsonb not null
);

create index callback_recording_favorites_date_idx
  on public.callback_recording_favorites (favorited_at desc);

create table public.callback_live_calls (
  agent_number text not null,
  conference_name text not null,
  caller_number text not null default '',
  start_time timestamptz,
  status text not null default 'LIVE' check (status in ('LIVE', 'ENDED')),
  call_duration text not null default '',
  end_time timestamptz,
  updated_at timestamptz not null default now(),
  primary key (agent_number, conference_name)
);

create index callback_live_calls_status_start_idx
  on public.callback_live_calls (status, start_time desc);

create table public.callback_push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table public.callback_push_notified (
  agent_number text not null,
  conference_name text not null,
  notified_at timestamptz not null default now(),
  primary key (agent_number, conference_name)
);

create index callback_push_notified_date_idx
  on public.callback_push_notified (notified_at desc);

create table public.callback_routing_lines (
  phone text primary key,
  label text not null,
  enabled boolean not null default true,
  is_default boolean not null default false,
  twilio_sid text not null default '',
  updated_at timestamptz not null default now()
);

create unique index callback_routing_one_default_idx
  on public.callback_routing_lines (is_default)
  where is_default;

create table public.callback_routing_agents (
  phone text primary key,
  label text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.callback_routing_agent_lines (
  agent_phone text not null references public.callback_routing_agents(phone) on delete cascade,
  line_phone text not null references public.callback_routing_lines(phone) on delete cascade,
  primary key (agent_phone, line_phone)
);

create index callback_routing_agent_lines_line_idx
  on public.callback_routing_agent_lines (line_phone, agent_phone);

alter table public.callback_leads enable row level security;
alter table public.callback_call_logs enable row level security;
alter table public.callback_recording_favorites enable row level security;
alter table public.callback_live_calls enable row level security;
alter table public.callback_push_subscriptions enable row level security;
alter table public.callback_push_notified enable row level security;
alter table public.callback_routing_lines enable row level security;
alter table public.callback_routing_agents enable row level security;
alter table public.callback_routing_agent_lines enable row level security;

revoke all on table public.callback_leads from anon, authenticated;
revoke all on table public.callback_call_logs from anon, authenticated;
revoke all on table public.callback_recording_favorites from anon, authenticated;
revoke all on table public.callback_live_calls from anon, authenticated;
revoke all on table public.callback_push_subscriptions from anon, authenticated;
revoke all on table public.callback_push_notified from anon, authenticated;
revoke all on table public.callback_routing_lines from anon, authenticated;
revoke all on table public.callback_routing_agents from anon, authenticated;
revoke all on table public.callback_routing_agent_lines from anon, authenticated;

grant all on table public.callback_leads to service_role;
grant all on table public.callback_call_logs to service_role;
grant all on table public.callback_recording_favorites to service_role;
grant all on table public.callback_live_calls to service_role;
grant all on table public.callback_push_subscriptions to service_role;
grant all on table public.callback_push_notified to service_role;
grant all on table public.callback_routing_lines to service_role;
grant all on table public.callback_routing_agents to service_role;
grant all on table public.callback_routing_agent_lines to service_role;
