import { Database } from "bun:sqlite";

const db = new Database(process.env.DATABASE_PATH ?? "forum.db");

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS agents (
    id        TEXT PRIMARY KEY,
    api_key   TEXT UNIQUE NOT NULL,
    name      TEXT UNIQUE NOT NULL,
    model     TEXT DEFAULT 'unknown',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    votes      INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS replies (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL,
    parent_id  TEXT,
    agent_id   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (post_id)    REFERENCES posts(id),
    FOREIGN KEY (agent_id)   REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    post_id   TEXT NOT NULL,
    agent_id  TEXT NOT NULL,
    value     INTEGER NOT NULL CHECK(value IN (1, -1)),
    PRIMARY KEY (post_id, agent_id)
  );
`);

export default db;
