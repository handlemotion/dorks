// Schema migrations, applied in order and tracked with PRAGMA user_version. Append only; never edit a shipped entry.
// Strings, not .sql files, so the compiled sidecar needs no files next to it.
export const MIGRATIONS: string[] = [
  `
  -- Singleton: global settings. Token columns hold AES-GCM envelopes (core/crypto.ts); nothing here is ever returned to a client.
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sleep_minutes REAL NOT NULL DEFAULT 5,
    claude_token_enc TEXT,
    boat_key_enc TEXT,
    boat_org TEXT,
    boat_environment TEXT,
    base_snapshot_id TEXT,
    github_token_enc TEXT,
    github_login TEXT,
    comment_policy TEXT
  );
  INSERT INTO settings (id) VALUES (1);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE secrets (name TEXT PRIMARY KEY, value_enc TEXT NOT NULL);

  -- Client-visible row. Nothing here changes per streamed delta, so list queries stay quiet mid-turn.
  CREATE TABLE dorks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    state TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    box_id TEXT,
    claude_session_id TEXT,
    codex_thread_id TEXT,
    codex_model TEXT,
    codex_model_choices TEXT,
    preview TEXT,
    pr_url TEXT,
    deleting INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX dorks_archived_activity ON dorks (archived, last_activity_at DESC);

  -- Server-only bookkeeping, one row per dork.
  CREATE TABLE dork_runtime (
    dork_id TEXT PRIMARY KEY REFERENCES dorks (id) ON DELETE CASCADE,
    bridge_seq INTEGER NOT NULL DEFAULT 0,
    stream_msg_id TEXT NOT NULL DEFAULT '',
    sleep_minutes REAL NOT NULL,
    bridge_seen_at INTEGER NOT NULL DEFAULT 0,
    bridge_lost INTEGER NOT NULL DEFAULT 0,
    op_gen INTEGER NOT NULL DEFAULT 0,
    pause TEXT,
    pause_retries INTEGER NOT NULL DEFAULT 0
  );

  -- Append-only per-dork log; seq is dense per dork. This is the unit a later sync replicates.
  CREATE TABLE events (
    dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (dork_id, seq)
  ) WITHOUT ROWID;

  -- Outbox plus control frames for the bridge. Holds no secrets: 'configure' is a marker the bridge answers by calling the configure rpc.
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    cid TEXT NOT NULL,
    text TEXT,
    meta TEXT,
    released INTEGER NOT NULL DEFAULT 0,
    acked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX commands_open ON commands (dork_id, acked);

  -- Durable timers and jobs. owner is a dork id, or '' for global ones. A row is claimed by deleting it.
  CREATE TABLE timers (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    payload TEXT,
    PRIMARY KEY (owner, name)
  ) WITHOUT ROWID;
  CREATE INDEX timers_due ON timers (due_at);

  -- A dork's subscription to a PR (docs/autonomy.md). repo is stored lowercase. poll_* is the poller's bookkeeping.
  CREATE TABLE pr_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    head_ref TEXT,
    base_ref TEXT,
    head_sha TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    ci TEXT NOT NULL,
    review TEXT NOT NULL,
    mergeable INTEGER,
    ci_fix_attempts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    last_event_at INTEGER NOT NULL,
    ci_failing TEXT,
    ci_notified INTEGER,
    ready_sha TEXT,
    conflict_sha TEXT,
    poll TEXT,
    UNIQUE (dork_id, repo, number)
  );
  CREATE INDEX pr_subscriptions_repo_number ON pr_subscriptions (repo, number);

  -- Debounce buffer between the poller and the agent: folded into one notify command by the per-dork notify timer.
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
    subscription_id INTEGER NOT NULL REFERENCES pr_subscriptions (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX inbox_pending ON inbox (dork_id, delivered);

  -- Dev/test only (BOX_PROVIDER=sim): what a real provider would hold remotely.
  CREATE TABLE sim_boxes (name TEXT PRIMARY KEY, running INTEGER NOT NULL, gen INTEGER NOT NULL);
  `,
  `
  -- Singleton: the "Prepare Boat" base-snapshot build (services/snapshot.ts). status is the current or last attempt; ready_* is the
  -- last snapshot that was built successfully, kept while a rebuild runs or fails so the app can say what the dorks still start from.
  CREATE TABLE snapshot_build (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'failed')),
    step TEXT,
    message TEXT,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    build_sandbox_id TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    ready_name TEXT,
    ready_bundle_id TEXT,
    ready_at INTEGER
  );
  INSERT INTO snapshot_build (id) VALUES (1);
  `,
  `
  -- Where a dork's title came from: 'message' (the first message, cut short: the bridge may replace it with a generated name),
  -- 'auto' (generated in the box) or 'user' (typed, never overwritten). Existing dorks whose title is not their first message were
  -- renamed by hand.
  ALTER TABLE dorks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'message' CHECK (title_source IN ('message', 'auto', 'user'));
  UPDATE dorks SET title_source = 'user' WHERE title IS NOT (
    SELECT substr(trim(json_extract(e.body, '$.text')), 1, 120) FROM events e
    WHERE e.dork_id = dorks.id AND json_extract(e.body, '$.type') = 'user_message' ORDER BY e.seq LIMIT 1
  );
  `,
  `
  -- The model and effort chosen in the UI (NULL: the agent's default), what the agent confirmed it runs, and the choices it offers.
  ALTER TABLE dorks ADD COLUMN model TEXT;
  ALTER TABLE dorks ADD COLUMN effort TEXT;
  ALTER TABLE dorks ADD COLUMN agent_model TEXT;
  ALTER TABLE dorks ADD COLUMN agent_effort TEXT;
  ALTER TABLE dorks ADD COLUMN model_choices TEXT;
  -- The current turn's final-answer candidate (the last assistant message with no tool call after it), and whether the user pressed
  -- Stop during it: both are stamped on the turn's turn_complete event, then reset.
  ALTER TABLE dork_runtime ADD COLUMN final_msg_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE dork_runtime ADD COLUMN interrupt_requested INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The dev servers the agent showed (preview_show): a JSON array of { port, url, title? }, newest last. Public URLs, no secret.
  ALTER TABLE dorks ADD COLUMN previews TEXT;
  `,
  `
  -- Images in a chat: screenshots the agent shared (screenshot_share) and images the owner attached to a message. The id is 128 random
  -- bits: it is the capability that GET /images/:id serves the bytes for. An attachment is uploaded before its message exists (dork_id
  -- NULL) and claimed by the dork whose message names it. The dork keeps a JSON list of the agent's screenshots for the Artifacts tab.
  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    dork_id TEXT REFERENCES dorks (id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX images_dork ON images (dork_id);
  ALTER TABLE dorks ADD COLUMN images TEXT;
  `,
  `
  -- Builds (docs/builds.md): named machine setups, each a Boat saved snapshot layered on the base snapshot. spec_hash covers what
  -- changes the image (size, setup script, repos, names of build-time variables); approved_hash is the spec the owner last approved.
  -- image_vars is a keyed hash (HMAC, never a plain hash) of the build-time variable values the image was built with, for staleness.
  CREATE TABLE builds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    machine_type TEXT NOT NULL DEFAULT 'default',
    setup_script TEXT NOT NULL DEFAULT '',
    repos TEXT NOT NULL DEFAULT '[]',
    rev INTEGER NOT NULL DEFAULT 1,
    spec_hash TEXT NOT NULL,
    approved_hash TEXT,
    image TEXT,
    image_rev INTEGER,
    image_hash TEXT,
    image_base TEXT,
    image_vars TEXT,
    image_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Values are AES-GCM envelopes bound to (build, name). value_enc NULL: an agent asked for it and the owner has not filled it in.
  CREATE TABLE build_vars (
    build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value_enc TEXT,
    secret INTEGER NOT NULL,
    build_time INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (build_id, name)
  ) WITHOUT ROWID;

  -- One execution of a spec. 'image' runs save the build's snapshot; 'trial' runs only check that the setup works.
  CREATE TABLE build_runs (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'trial')),
    spec TEXT NOT NULL,
    spec_hash TEXT NOT NULL,
    started_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    step TEXT,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    sandbox_id TEXT,
    process_id INTEGER,
    command_id TEXT,
    exit_code INTEGER,
    log TEXT NOT NULL DEFAULT '',
    log_bytes INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX build_runs_build ON build_runs (build_id, created_at DESC);

  -- An agent's proposed change to its dork's build, one per (build, dork).
  CREATE TABLE build_drafts (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    dork_id TEXT NOT NULL REFERENCES dorks (id) ON DELETE CASCADE,
    base_rev INTEGER NOT NULL,
    spec TEXT NOT NULL,
    vars TEXT NOT NULL DEFAULT '[]',       -- DraftVar[]: proposed variable changes (a secret's value never appears here)
    note TEXT,
    status TEXT NOT NULL CHECK (status IN ('editing', 'submitted', 'approved', 'rejected')),
    updated_at INTEGER NOT NULL,
    UNIQUE (build_id, dork_id)
  );

  ALTER TABLE dorks ADD COLUMN build_id TEXT REFERENCES builds (id) ON DELETE SET NULL;
  ALTER TABLE settings ADD COLUMN default_build_id TEXT;
  `,
];
