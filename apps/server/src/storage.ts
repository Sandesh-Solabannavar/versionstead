import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMonitoringSnapshot,
  type MonitoringSnapshot,
} from "@versionstead/contracts/monitoring";

export type StoredMonitoring = {
  snapshot: MonitoringSnapshot;
  due: Record<string, number>;
  notified: string[];
};

export class MonitoringStorage {
  private readonly database: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.database = new DatabaseSync(join(dataDir, "monitoring.sqlite"), { timeout: 5000 });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const version = this.database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) {
      this.database.close();
      throw new Error("The monitoring database needs a newer Versionstead version.");
    }
    if (version === 0) {
      this.database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE monitoring_state (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, due TEXT NOT NULL, notified TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;`);
    }
  }

  read(): StoredMonitoring | null {
    const row = this.database
      .prepare("SELECT snapshot, due, notified FROM monitoring_state WHERE id=1")
      .get();
    if (!row) return null;
    const snapshot = decodeMonitoringSnapshot(JSON.parse(String(row.snapshot)));
    const due: unknown = JSON.parse(String(row.due));
    const notified: unknown = JSON.parse(String(row.notified));
    if (
      !due ||
      typeof due !== "object" ||
      Array.isArray(due) ||
      Object.values(due).some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
      !Array.isArray(notified) ||
      notified.some((v) => typeof v !== "string")
    ) {
      throw new Error("The monitoring database contains invalid schedule state.");
    }
    return { snapshot, due: due as Record<string, number>, notified: notified as string[] };
  }

  write(state: StoredMonitoring) {
    // ponytail: one bounded personal-scale snapshot is written atomically; split tables when writes or size measurably exceed this ceiling.
    this.database
      .prepare(`INSERT INTO monitoring_state(id,snapshot,due,notified) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,due=excluded.due,notified=excluded.notified`)
      .run(
        JSON.stringify(state.snapshot),
        JSON.stringify(state.due),
        JSON.stringify(state.notified),
      );
  }

  close() {
    this.database.close();
  }
}
