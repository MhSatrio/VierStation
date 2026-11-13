import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from './config.ts';

export let db: DatabaseSync;
const stmtCache = new Map<string, StatementSync>();

type Params = (string | number | bigint | null | Uint8Array)[];

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pw_hash TEXT NOT NULL,
    prefs TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_login TEXT, disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, ip TEXT, ua TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT);
  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX wm_user ON workspace_members(user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace','private')),
    deadline TEXT, color TEXT, created_at TEXT NOT NULL, created_by TEXT
  );
  CREATE INDEX projects_ws ON projects(workspace_id);
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE tables (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'custom',
    description TEXT NOT NULL DEFAULT '', icon TEXT, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX tables_ws ON tables(workspace_id, project_id);
  CREATE TABLE fields (
    id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, name TEXT NOT NULL,
    type TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, key TEXT
  );
  CREATE INDEX fields_table ON fields(table_id);
  CREATE TABLE records (
    id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT
  );
  CREATE INDEX records_table ON records(table_id);
  CREATE TABLE links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    meta TEXT, created_at TEXT NOT NULL, UNIQUE (field_id, from_id, to_id)
  );
  CREATE INDEX links_from ON links(from_id, field_id);
  CREATE INDEX links_to ON links(to_id, field_id);
  CREATE TABLE views (
    id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, name TEXT NOT NULL,
    type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX views_table ON views(table_id);
  CREATE TABLE comments (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
    body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX comments_rec ON comments(record_id);
  CREATE TABLE provenance (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, source_db TEXT NOT NULL,
    accession TEXT, query TEXT, url TEXT, retrieved_at TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'import', note TEXT
  );
  CREATE INDEX provenance_rec ON provenance(record_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', payload TEXT NOT NULL DEFAULT '{}', progress_done INTEGER, progress_total INTEGER,
    message TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, run_at TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT, result TEXT, output TEXT, created_by TEXT,
    dedupe_key TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, automation_id TEXT, automation_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX jobs_status ON jobs(status, run_at);
  CREATE INDEX jobs_ws ON jobs(workspace_id, created_at);
  CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
  CREATE TABLE job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, ts TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
  CREATE INDEX job_logs_job ON job_logs(job_id);
  CREATE TABLE automations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, table_id TEXT REFERENCES tables(id) ON DELETE CASCADE,
    name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, spec TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
    last_run_at TEXT, run_count INTEGER NOT NULL DEFAULT 0, template TEXT
  );
  CREATE INDEX automations_table ON automations(table_id, enabled);
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, record_id TEXT,
    status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, log TEXT NOT NULL DEFAULT '[]', trigger_event TEXT
  );
  CREATE INDEX automation_runs_a ON automation_runs(automation_id, started_at);
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, emailed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notifications_user ON notifications(user_id, read, created_at);
  CREATE TABLE secrets (workspace_id TEXT NOT NULL, name TEXT NOT NULL, enc TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, name));
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, user_id TEXT, workspace_id TEXT, action TEXT NOT NULL,
    target_type TEXT, target_id TEXT, detail TEXT, ip TEXT
  );
  CREATE INDEX audit_ws ON audit_log(workspace_id, ts);
  CREATE TABLE http_cache (key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_s INTEGER NOT NULL);
  CREATE TABLE analyses (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL,
    params TEXT NOT NULL, input TEXT NOT NULL, result TEXT, status TEXT NOT NULL DEFAULT 'queued', job_id TEXT,
    created_by TEXT, created_at TEXT NOT NULL, result_record_id TEXT
  );
  CREATE INDEX analyses_ws ON analyses(workspace_id, created_at);
  CREATE TABLE files (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, record_id TEXT, field_id TEXT, name TEXT NOT NULL, size INTEGER NOT NULL,
    mime TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT
  );
  CREATE TABLE structures_cache (id TEXT PRIMARY KEY, source TEXT NOT NULL, fmt TEXT NOT NULL, fetched_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(rid UNINDEXED, tid UNINDEXED, wid UNINDEXED, text, tokenize = "unicode61 remove_diacritics 2 tokenchars '_.-'");
  `,
  /* 2 – Sequence Lab: immutable raw sequence + derived versions, per-record workflow history */
  `
  CREATE TABLE seq_versions (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, n INTEGER NOT NULL, parent_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('raw','derived')), seq TEXT NOT NULL, qual TEXT, map TEXT, marks TEXT NOT NULL DEFAULT '[]',
    op_id TEXT, label TEXT, created_at TEXT NOT NULL, UNIQUE (record_id, n)
  );
  CREATE TRIGGER seq_raw_no_update BEFORE UPDATE ON seq_versions WHEN OLD.kind = 'raw' BEGIN SELECT RAISE(ABORT, 'The raw sequence is immutable'); END;
  CREATE TRIGGER seq_raw_no_delete BEFORE DELETE ON seq_versions WHEN OLD.kind = 'raw' AND EXISTS (SELECT 1 FROM records WHERE id = OLD.record_id) BEGIN SELECT RAISE(ABORT, 'The raw sequence is immutable'); END;
  CREATE TABLE seq_state (record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE, head TEXT NOT NULL, redo TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE seq_ops (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, step TEXT NOT NULL, name TEXT NOT NULL,
    input_ref TEXT, output_ref TEXT, params TEXT NOT NULL DEFAULT '{}', changes TEXT, result TEXT, tool TEXT, tool_version TEXT,
    db_source TEXT, db_retrieved_at TEXT, actor TEXT, automatic INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'completed',
    warnings TEXT NOT NULL DEFAULT '[]', error TEXT, job_id TEXT, supersedes TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX seq_ops_rec ON seq_ops(record_id, created_at);
  `,
  /* 3 – local-first: accounts removed (no sessions, no passwords) */
  `
  DROP TABLE IF EXISTS sessions;
  UPDATE users SET pw_hash = '!';
  `,
  /* 4 – relationships (many-to-many, typed, evidenced), reactions and pathways */
  `
  CREATE TABLE relationship_types (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE,
    inverse_name TEXT, description TEXT NOT NULL DEFAULT '', directional INTEGER NOT NULL DEFAULT 1, source_kinds TEXT NOT NULL DEFAULT '[]', target_kinds TEXT NOT NULL DEFAULT '[]',
    edge_style TEXT NOT NULL DEFAULT 'solid', builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (workspace_id, name)
  );
  CREATE TABLE relationships (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    type_id TEXT NOT NULL REFERENCES relationship_types(id), directional INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '',
    evidence_class TEXT NOT NULL DEFAULT 'unverified', verification TEXT NOT NULL DEFAULT 'unverified', organism TEXT, conditions TEXT,
    source_db TEXT, accession TEXT, origin TEXT NOT NULL DEFAULT 'user', link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT
  );
  CREATE INDEX rel_src ON relationships(source_id);
  CREATE INDEX rel_tgt ON relationships(target_id);
  CREATE INDEX rel_type ON relationships(type_id);
  CREATE INDEX rel_ws ON relationships(workspace_id);
  CREATE UNIQUE INDEX rel_unique ON relationships(source_id, target_id, type_id, evidence_class, ifnull(organism, ''));
  CREATE UNIQUE INDEX rel_link ON relationships(link_id) WHERE link_id IS NOT NULL;
  CREATE TABLE citations (
    id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK (owner_type IN ('relationship','record')), owner_id TEXT NOT NULL,
    kind TEXT NOT NULL, value TEXT NOT NULL, title TEXT, url TEXT, record_ref TEXT, note TEXT, retrieved_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX citations_owner ON citations(owner_type, owner_id);
  CREATE TABLE relationship_tags (relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE, tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (relationship_id, tag));
  CREATE TABLE record_tags (record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, tag TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (record_id, tag));
  CREATE INDEX record_tags_tag ON record_tags(tag);
  CREATE TABLE reaction_participants (
    id TEXT PRIMARY KEY, reaction_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('reactant','product','catalyst','enzyme','cofactor','inhibitor','activator','regulator')), stoichiometry REAL, note TEXT,
    UNIQUE (reaction_id, record_id, role)
  );
  CREATE INDEX rp_record ON reaction_participants(record_id);
  CREATE TABLE pathway_steps (
    id TEXT PRIMARY KEY, pathway_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, reaction_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    label TEXT, position INTEGER, branch TEXT, notes TEXT, order_basis TEXT NOT NULL DEFAULT 'unknown', UNIQUE (pathway_id, reaction_id)
  );
  CREATE INDEX ps_reaction ON pathway_steps(reaction_id);
  CREATE TABLE pathway_step_edges (
    id TEXT PRIMARY KEY, pathway_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, from_step TEXT NOT NULL REFERENCES pathway_steps(id) ON DELETE CASCADE,
    to_step TEXT NOT NULL REFERENCES pathway_steps(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'next' CHECK (kind IN ('next','alternative')), basis TEXT, UNIQUE (from_step, to_step)
  );
  CREATE INDEX pse_pathway ON pathway_step_edges(pathway_id);
  CREATE TABLE image_cache (
    record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE, kind TEXT NOT NULL, file TEXT, mime TEXT, source TEXT, source_url TEXT, identifier TEXT,
    note TEXT, retrieved_at TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = () => MIGRATIONS.length;
export function closeDb() { try { db?.close(); } catch { /* already closed */ } stmtCache.clear(); }

export function openDb(file = config.dbFile): DatabaseSync {
  db = new DatabaseSync(file);
  stmtCache.clear();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let v = row ? Number(row.value) : 0;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

/** Plain-object rows (node:sqlite returns null-prototype objects). */
const plain = <T>(r: unknown): T => (r === undefined ? r : { ...(r as object) }) as T;

export const q = {
  all: <T = Record<string, any>>(sql: string, ...p: Params): T[] => (stmt(sql).all(...p) as unknown[]).map((r) => plain<T>(r)),
  get: <T = Record<string, any>>(sql: string, ...p: Params): T | undefined => plain<T | undefined>(stmt(sql).get(...p)),
  run: (sql: string, ...p: Params) => stmt(sql).run(...p),
  exec: (sql: string) => db.exec(sql),
};

let txDepth = 0;
/** Run fn inside a transaction (re-entrant via savepoints). Rolls back on throw. */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) {
    const sp = `sp${txDepth}`;
    db.exec(`SAVEPOINT ${sp}`);
    txDepth++;
    try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; }
    catch (e) { db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e; }
    finally { txDepth--; }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}

export function placeholders(n: number) { return new Array(n).fill('?').join(','); }
