import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Versioned migrations. Append only; never edit a shipped one. */
const MIGRATIONS: string[] = [
	`
CREATE TABLE realms (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, policy TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE actors (
  realm_id TEXT NOT NULL REFERENCES realms(id), id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  roles TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (realm_id, id));
CREATE TABLE presence (
  realm_id TEXT NOT NULL, actor_id TEXT NOT NULL, state TEXT NOT NULL, echo INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (realm_id, actor_id),
  FOREIGN KEY (realm_id, actor_id) REFERENCES actors(realm_id, id));
CREATE TABLE work (
  realm_id TEXT NOT NULL REFERENCES realms(id), id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  goal TEXT NOT NULL, state TEXT NOT NULL, phase TEXT, owner_id TEXT, parent_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (realm_id, id));
CREATE INDEX work_state ON work(realm_id, state);
CREATE TABLE external_refs (
  realm_id TEXT NOT NULL, work_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
  label TEXT, url TEXT, state TEXT, observed_at INTEGER,
  PRIMARY KEY (realm_id, source, external_id),
  FOREIGN KEY (realm_id, work_id) REFERENCES work(realm_id, id));
CREATE INDEX refs_work ON external_refs(realm_id, work_id);
CREATE TABLE decisions (
  realm_id TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, work_id TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, context TEXT NOT NULL, urgency TEXT NOT NULL, required_authority TEXT NOT NULL,
  requested_by TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, decided_by TEXT, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER, decided_at INTEGER,
  PRIMARY KEY (realm_id, id), UNIQUE (realm_id, key),
  FOREIGN KEY (realm_id, work_id) REFERENCES work(realm_id, id));
CREATE INDEX decisions_status ON decisions(realm_id, status);
CREATE TABLE attention (
  realm_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  summary TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
  PRIMARY KEY (realm_id, id));
CREATE UNIQUE INDEX attention_open ON attention(realm_id, kind, subject_id) WHERE resolved_at IS NULL;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, realm_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
  actor_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX events_realm ON events(realm_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`,
	// OptChat memory tree: a rebuildable derivative of a conversation's transcript. `thread` is an opaque runtime conversation id.
	`
CREATE TABLE memleaves (
  thread TEXT NOT NULL, idx INTEGER NOT NULL, entry_id INTEGER NOT NULL, role TEXT NOT NULL,
  raw TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (thread, idx));
CREATE UNIQUE INDEX memleaves_entry ON memleaves(thread, entry_id);
CREATE TABLE memnodes (
  thread TEXT NOT NULL, level INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, quality TEXT NOT NULL,
  PRIMARY KEY (thread, level, idx));
`,
	// Spaces (channels), messages, and the links from work/decisions into a space.
	`
CREATE TABLE spaces (
  realm_id TEXT NOT NULL REFERENCES realms(id), id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', owner_id TEXT, agent_ids TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (realm_id, id));
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, realm_id TEXT NOT NULL, space_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'done', request_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (realm_id, space_id) REFERENCES spaces(realm_id, id));
CREATE INDEX messages_space ON messages(realm_id, space_id, id);
CREATE UNIQUE INDEX messages_request ON messages(realm_id, request_id) WHERE request_id IS NOT NULL;
ALTER TABLE work ADD COLUMN space_id TEXT;
ALTER TABLE decisions ADD COLUMN message_id INTEGER;
`,
	// Free-form actor profile: an agent's capability card (title, colour, what it can and cannot do) for UIs.
	`ALTER TABLE actors ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';`,
	// Transactional outbox: "wake this agent with this message" is committed together with the message itself, so a crash
	// between "message stored" and "runtime told" can never lose or duplicate the hand-over.
	`
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, realm_id TEXT NOT NULL, message_id INTEGER NOT NULL, agent_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, done_at INTEGER, UNIQUE (realm_id, message_id, agent_id));
CREATE INDEX outbox_pending ON outbox(status, id);
`,
];

export function openDb(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
	migrate(db);
	return db;
}

function migrate(db: DatabaseSync) {
	const have = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	for (let v = have; v < MIGRATIONS.length; v++) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[v]);
			db.exec(`PRAGMA user_version = ${v + 1}`);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}
}