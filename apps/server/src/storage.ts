import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMonitoringSnapshot,
  type Finding,
  type MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";
import { DATABASE_FILE } from "./runtime.ts";

export type StoredMonitoring = {
  snapshot: MonitoringSnapshot;
  due: Record<string, number>;
  notified: string[];
};
// The JSON of each stored row: everything but projects and findings, each project, and the
// findings of each subject.
type Rows = { meta: string; projects: Map<string, string>; findings: Map<string, string> };

const invalid = (record: string, cause?: unknown) =>
  new Error(`The monitoring database contains an invalid ${record}.`, { cause });
const parse = (value: unknown, record: string): unknown => {
  try {
    return JSON.parse(String(value));
  } catch (cause) {
    throw invalid(record, cause);
  }
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validated(snapshot: unknown, due: unknown, notified: unknown): StoredMonitoring {
  let decoded;
  try {
    decoded = decodeMonitoringSnapshot(snapshot);
  } catch (cause) {
    throw invalid("monitoring snapshot", cause);
  }
  if (
    !isObject(due) ||
    Object.values(due).some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
    !Array.isArray(notified) ||
    notified.some((v) => typeof v !== "string")
  ) {
    throw invalid("schedule state");
  }
  return { snapshot: decoded, due: due as Record<string, number>, notified: notified as string[] };
}

function rows({
  snapshot: { projects, findings, ...meta },
  due,
  notified,
}: StoredMonitoring): Rows {
  const subjects = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = subjects.get(finding.subjectId);
    if (group) group.push(finding);
    else subjects.set(finding.subjectId, [finding]);
  }
  return {
    meta: JSON.stringify({ snapshot: meta, due, notified }),
    projects: new Map(projects.map((project) => [project.id, JSON.stringify(project)])),
    findings: new Map([...subjects].map(([id, group]) => [id, JSON.stringify(group)])),
  };
}

export class MonitoringStorage {
  private readonly database: DatabaseSync;
  // What each row holds, so a write replaces only the rows whose JSON changed.
  private written: Rows | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.database = new DatabaseSync(join(dataDir, DATABASE_FILE), { timeout: 5000 });
    try {
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      const version = this.database.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2)
        throw new Error("The monitoring database needs a newer Versionstead version.");
      // Version 2 splits the version 1 single-row snapshot into per-subject rows. Older builds
      // refuse version 2, so a migrated database cannot be downgraded.
      if (version !== 2)
        this.transaction(() => {
          const old =
            version === 1
              ? this.database
                  .prepare("SELECT snapshot, due, notified FROM monitoring_state WHERE id=1")
                  .get()
              : undefined;
          const stored =
            old &&
            validated(
              parse(old.snapshot, "monitoring snapshot"),
              parse(old.due, "schedule state"),
              parse(old.notified, "schedule state"),
            );
          this.database.exec(`
            CREATE TABLE monitoring_meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
            CREATE TABLE monitoring_projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE monitoring_findings (subject_id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
          if (stored) this.save(rows(stored));
          this.database.exec("PRAGMA user_version=2");
          if (version === 1) this.database.exec("DROP TABLE monitoring_state");
        });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  read(): StoredMonitoring | null {
    const meta = this.database.prepare("SELECT value FROM monitoring_meta WHERE id=1").get();
    const projects = this.database
      .prepare("SELECT id, value FROM monitoring_projects ORDER BY rowid")
      .all()
      .map(({ id, value }) => {
        const project = parse(value, "project record");
        if (!isObject(project) || project.id !== id) throw invalid("project record");
        return project;
      });
    // Findings return grouped by subject; every reader groups them by subject anyway.
    const findings = this.database
      .prepare("SELECT subject_id, value FROM monitoring_findings ORDER BY rowid")
      .all()
      .flatMap(({ subject_id, value }) => {
        const group = parse(value, "findings record");
        if (!Array.isArray(group) || group.some((f) => !isObject(f) || f.subjectId !== subject_id))
          throw invalid("findings record");
        return group as unknown[];
      });
    // Rows without their meta row are damage, never an empty database to start over in.
    if (!meta && !projects.length && !findings.length) return null;
    const state = meta && parse(meta.value, "monitoring state record");
    if (!isObject(state) || !isObject(state.snapshot)) throw invalid("monitoring state record");
    const stored = validated({ ...state.snapshot, projects, findings }, state.due, state.notified);
    this.written = rows(stored);
    return stored;
  }

  readApplication(): unknown {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS application_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const row = this.database.prepare("SELECT value FROM application_state WHERE id=1").get();
    return row ? JSON.parse(String(row.value)) : null;
  }

  writeApplication(value: unknown) {
    this.database
      .prepare(
        "INSERT INTO application_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value));
  }

  // Writes the rows whose JSON changed and deletes removed subjects, all in one transaction.
  // ponytail: every write serializes all subjects to compare (~0.1 s at 50 projects x 2,000
  // dependencies) and rewrites the whole shared row, which grows with pending notifications;
  // give notifications their own rows or skip unchanged subjects if either measurably matters.
  write(state: StoredMonitoring) {
    const next = rows(state);
    this.transaction(() => this.save(next));
    this.written = next;
  }

  close() {
    this.database.close();
  }

  private save(next: Rows) {
    if (next.meta !== this.written?.meta)
      this.database
        .prepare(
          "INSERT INTO monitoring_meta(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(next.meta);
    for (const [table, key, values, written] of [
      ["monitoring_projects", "id", next.projects, this.written?.projects],
      ["monitoring_findings", "subject_id", next.findings, this.written?.findings],
    ] as const) {
      const upsert = this.database.prepare(
        `INSERT INTO ${table}(${key},value) VALUES(?,?) ON CONFLICT(${key}) DO UPDATE SET value=excluded.value`,
      );
      for (const [id, value] of values) if (written?.get(id) !== value) upsert.run(id, value);
      this.database
        .prepare(`DELETE FROM ${table} WHERE ${key} NOT IN (SELECT value FROM json_each(?))`)
        .run(JSON.stringify([...values.keys()]));
    }
  }

  private transaction(run: () => void) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
