import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Exercise actual transaction and SQL behavior without Cloudflare credentials.
export function d1Fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const totalChanges = sqlite.prepare('SELECT total_changes() AS count');
  class Statement {
    constructor(query, values = []) {
      this.query = query;
      this.values = values;
    }
    bind(...values) { return new Statement(this.query, values); }
    execute() {
      const statement = sqlite.prepare(this.query);
      const before = totalChanges.get().count;
      let results = [];
      if (statement.columns().length) results = statement.all(...this.values);
      else statement.run(...this.values);
      return { results, meta: { changes: totalChanges.get().count - before } };
    }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
    async first() { return this.execute().results[0] ?? null; }
  }
  const db = {
    prepare: query => new Statement(query),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite };
}
