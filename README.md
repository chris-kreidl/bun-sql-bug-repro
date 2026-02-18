# Bun MySQL Repro

Minimal standalone repro for Bun MySQL connection instability in a cache-like workload.

## Requirements

Set environment variables:

- `MYSQL_HOST`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- optional: `MYSQL_PORT`
- optional: `MYSQL_TLS` (`true` or `false`, default `false`)

## Run

Default scenario (single connection for reads+writes, transactional write):

```bash
REPRO_MODE=single REPRO_TX=true REPRO_ROWS=30000 REPRO_BATCH=500 bun scripts/bun-mysql-repro/repro.ts
```

Split read/write connections:

```bash
REPRO_MODE=split REPRO_TX=true REPRO_ROWS=30000 REPRO_BATCH=500 bun scripts/bun-mysql-repro/repro.ts
```

Autocommit write (no transaction):

```bash
REPRO_MODE=single REPRO_TX=false REPRO_ROWS=30000 REPRO_BATCH=100 bun scripts/bun-mysql-repro/repro.ts
```

## What it does

1. Creates two repro tables:
   - `bun_repro_cached_ranges`
   - `bun_repro_cached_inventory_movements`
2. Clears scenario-specific rows
3. Reads range metadata
4. Writes a large batch of movement rows
5. Reads rows back

If the runtime fails, output typically stops mid-step (or reports `MySQLError: Connection closed`).

## Notes

- This script is intentionally independent of app code.
- It uses only `Bun.SQL` and MySQL.
