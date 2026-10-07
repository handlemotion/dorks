create table user_settings (
  user_id text primary key references "user" ("id") on delete cascade,
  claude_token_enc text,
  github_installation_id integer,
  workstation_snapshot_id text,
  workstation_box_id text,
  sleep_minutes integer not null default 5,
  key_version integer not null default 1
);

create table user_secrets (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  name text not null,
  value_enc text not null,
  key_version integer not null default 1,
  created_at integer not null,
  updated_at integer not null,
  unique (user_id, name)
);

create table dorks (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  title text,
  repo_full_name text not null,
  branch text,
  box_id text,
  snapshot_id text,
  claude_session_id text,
  status text not null default 'creating',
  archived_at integer,
  last_preview text,
  pr_url text,
  created_at integer not null,
  last_activity_at integer not null
);
create index dorks_user_activity_idx on dorks (user_id, last_activity_at desc);
create index dorks_repo_branch_idx on dorks (repo_full_name, branch);

create table push_tokens (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  expo_push_token text not null unique,
  created_at integer not null
);
