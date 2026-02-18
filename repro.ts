import { SQL } from "bun";

type Mode = "single" | "split";

type Scenario = {
  mode: Mode;
  transactionalWrite: boolean;
  rows: number;
  batchSize: number;
};

function env(name: string, required = true): string | undefined {
  const value = process.env[name]?.trim();
  if (required && !value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nowLabel(): string {
  return new Date().toISOString();
}

function log(step: string, payload?: unknown): void {
  const prefix = `[${nowLabel()}] ${step}`;
  if (payload === undefined) {
    console.log(prefix);
    return;
  }
  console.log(prefix, payload);
}

function buildRows(count: number, startMs: number, endMs: number): Array<{
  id: number;
  created_at: string;
  variant_id: number;
  quantity_change: number;
}> {
  const span = Math.max(1, endMs - startMs);
  const rows: Array<{
    id: number;
    created_at: string;
    variant_id: number;
    quantity_change: number;
  }> = [];

  for (let i = 0; i < count; i += 1) {
    const created = new Date(startMs + Math.floor((i / count) * span)).toISOString();
    rows.push({
      id: i + 1,
      created_at: created,
      variant_id: (i % 3000) + 1,
      quantity_change: -((i % 8) + 1),
    });
  }

  return rows;
}

function connOptions() {
  const hostname = env("MYSQL_HOST") as string;
  const username = env("MYSQL_USER") as string;
  const password = env("MYSQL_PASSWORD") as string;
  const database = env("MYSQL_DATABASE") as string;
  const portRaw = env("MYSQL_PORT", false);
  const port = portRaw ? Number(portRaw) : undefined;
  const tls = boolEnv("MYSQL_TLS", false);

  return {
    adapter: "mysql" as const,
    hostname,
    ...(Number.isFinite(port) ? { port } : {}),
    username,
    password,
    database,
    tls,
  };
}

async function ensureSchema(sql: InstanceType<typeof SQL>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS bun_repro_cached_ranges (
      query_type   VARCHAR(255) NOT NULL,
      params_hash  VARCHAR(255) NOT NULL,
      range_start  BIGINT       NOT NULL,
      range_end    BIGINT       NOT NULL,
      cached_at    BIGINT       NOT NULL,
      PRIMARY KEY (query_type, params_hash, range_start),
      INDEX idx_ranges_type_params (query_type, params_hash)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS bun_repro_cached_inventory_movements (
      id              BIGINT       NOT NULL,
      query_type      VARCHAR(255) NOT NULL,
      params_hash     VARCHAR(255) NOT NULL DEFAULT '',
      created_at_api  BIGINT       NOT NULL,
      cached_at       BIGINT       NOT NULL,
      created_at      VARCHAR(64)  NULL,
      variant_id      BIGINT       NULL,
      quantity_change DOUBLE       NULL,
      PRIMARY KEY (query_type, params_hash, id),
      INDEX idx_movements_type_created (query_type, params_hash, created_at_api)
    )
  `;
}

async function clearScenarioData(sql: InstanceType<typeof SQL>, paramsHash: string): Promise<void> {
  await sql.unsafe(
    `DELETE FROM bun_repro_cached_inventory_movements WHERE query_type = ? AND params_hash = ?`,
    ["inventoryMovements", paramsHash],
  );
  await sql.unsafe(
    `DELETE FROM bun_repro_cached_ranges WHERE query_type = ? AND params_hash = ?`,
    ["inventoryMovements", paramsHash],
  );
}

async function runScenario(s: Scenario): Promise<void> {
  log("scenario:start", s);

  const options = connOptions();
  const writeSql = new SQL(options);
  const readSql = s.mode === "split" ? new SQL(options) : writeSql;

  const queryType = "inventoryMovements";
  const paramsHash = `bun-repro-${s.mode}-${s.transactionalWrite ? "tx" : "autocommit"}`;
  const end = Date.now();
  const start = end - 90 * 24 * 60 * 60 * 1000;
  const rows = buildRows(s.rows, start, end);

  try {
    log("step:ensureSchema");
    await ensureSchema(writeSql);
    log("step:ensureSchema:ok");

    log("step:clear");
    await clearScenarioData(writeSql, paramsHash);
    log("step:clear:ok");

    log("step:readRanges:before");
    const rangesBefore = await readSql.unsafe(
      `SELECT range_start, range_end FROM bun_repro_cached_ranges WHERE query_type = ? AND params_hash = ? ORDER BY range_start`,
      [queryType, paramsHash],
    );
    log("step:readRanges:ok", { count: rangesBefore.length });

    const now = Date.now();
    if (s.transactionalWrite) {
      log("step:write:beginTransaction", { rows: rows.length, batchSize: s.batchSize });
      await writeSql.begin(async (tx) => {
        for (let i = 0; i < rows.length; i += s.batchSize) {
          const batch = rows.slice(i, i + s.batchSize);
          const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
          const values: unknown[] = [];
          for (const row of batch) {
            values.push(
              row.id,
              queryType,
              paramsHash,
              new Date(row.created_at).getTime(),
              now,
              row.created_at,
              row.variant_id,
              row.quantity_change,
            );
          }
          await tx.unsafe(
            `INSERT INTO bun_repro_cached_inventory_movements (id, query_type, params_hash, created_at_api, cached_at, created_at, variant_id, quantity_change) VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE created_at_api = VALUES(created_at_api), cached_at = VALUES(cached_at), created_at = VALUES(created_at), variant_id = VALUES(variant_id), quantity_change = VALUES(quantity_change)`,
            values,
          );
        }
        await tx.unsafe(
          `INSERT INTO bun_repro_cached_ranges (query_type, params_hash, range_start, range_end, cached_at)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             range_end = GREATEST(range_end, VALUES(range_end)),
             cached_at = VALUES(cached_at)`,
          [queryType, paramsHash, start, end, now],
        );
      });
      log("step:write:commit:ok");
    } else {
      log("step:write:autocommit", { rows: rows.length, batchSize: s.batchSize });
      for (let i = 0; i < rows.length; i += s.batchSize) {
        const batch = rows.slice(i, i + s.batchSize);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        const values: unknown[] = [];
        for (const row of batch) {
          values.push(
            row.id,
            queryType,
            paramsHash,
            new Date(row.created_at).getTime(),
            now,
            row.created_at,
            row.variant_id,
            row.quantity_change,
          );
        }
        await writeSql.unsafe(
          `INSERT INTO bun_repro_cached_inventory_movements (id, query_type, params_hash, created_at_api, cached_at, created_at, variant_id, quantity_change) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE created_at_api = VALUES(created_at_api), cached_at = VALUES(cached_at), created_at = VALUES(created_at), variant_id = VALUES(variant_id), quantity_change = VALUES(quantity_change)`,
          values,
        );
      }
      await writeSql.unsafe(
        `INSERT INTO bun_repro_cached_ranges (query_type, params_hash, range_start, range_end, cached_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           range_end = GREATEST(range_end, VALUES(range_end)),
           cached_at = VALUES(cached_at)`,
        [queryType, paramsHash, start, end, now],
      );
      log("step:write:autocommit:ok");
    }

    log("step:readRows:before");
    const rowsRead = await readSql.unsafe(
      `SELECT id, created_at_api, cached_at, created_at, variant_id, quantity_change
       FROM bun_repro_cached_inventory_movements
       WHERE query_type = ? AND params_hash = ?
       ORDER BY created_at_api`,
      [queryType, paramsHash],
    );
    log("step:readRows:ok", { count: rowsRead.length });

    log("scenario:done");
  } finally {
    if (readSql !== writeSql) {
      await Promise.allSettled([readSql.close(), writeSql.close()]);
    } else {
      await writeSql.close();
    }
  }
}

async function main() {
  const rows = intEnv("REPRO_ROWS", 30000);
  const batchSize = intEnv("REPRO_BATCH", 500);

  const modeRaw = (process.env.REPRO_MODE ?? "single").toLowerCase();
  const mode: Mode = modeRaw === "split" ? "split" : "single";

  const transactionalWrite = boolEnv("REPRO_TX", true);

  log("repro:start", {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    mode,
    transactionalWrite,
    rows,
    batchSize,
  });

  await runScenario({
    mode,
    transactionalWrite,
    rows,
    batchSize,
  });
}

main().catch((error) => {
  console.error("repro:error", error);
  process.exit(1);
});
