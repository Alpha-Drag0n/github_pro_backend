# Online-DB Drainer

A single-connection tool that evacuates data from the **online** (Atlas) DB to local
JSON files and deletes the exported docs from online, so the 512 MB free cluster never
fills. You import the files into your local DB yourself with **MongoDB Compass**.

It connects to the online DB **only**. It never connects to or writes your local DB.

## What it drains

| Pass | Collections | When |
|---|---|---|
| Telemetry | `spans`, `events` | any time (append-only, safe) |
| Results | `users` | **only** for deep searches with `status: "completed"` |

Everything else is left untouched: `profiles` (login!), `tokens`, `apifytokens`, `agents`,
`bucketledgers`, `deepsearchlogs`, `tasks`, `deepsearches`, `quicksearches`.

> **`logs` is excluded on purpose.** Despite the name it is the Quick Search dedup ledger
> (`Log.findOne(comboFilter)` in `quickSearchRoutes.js`), not telemetry. Draining it can make
> Quick Search redo API work. Only add it (`--telemetry spans,events,logs`) if you never run
> Quick Search.

## Run

```bash
cd backend

# one pass, DELETE nothing - verify the files first
npm run drain -- --uri "mongodb+srv://USER:PASS@cluster.mongodb.net/github-user-research" --once --dry-run

# one real pass (export + delete)
npm run drain -- --uri "mongodb+srv://...github-user-research" --once

# continuous, every 5 min (telemetry keeps the DB from filling during a search)
npm run drain -- --uri "mongodb+srv://...github-user-research" --watch --interval 300

# only telemetry / only users
npm run drain -- --uri "..." --once --mode telemetry
npm run drain -- --uri "..." --once --mode users
```

The URI can instead come from `ONLINE_MONGODB_URI` (or `MONGODB_URI`). The database name is
taken from the URI path; pass `--db <name>` if your URI has none.

## Output

Files land in `data/YYYY.MM.DD/` (repo root), named to match your existing exports:

```
data/2026.06.19/
  D_spans.json  D_spans_1.json  ...      # telemetry, size-rotated
  D_events.json
  D_users_2021.01.14.json                # one completed search (single-day range)
  D_users_2021.01.01_2021.01.10.json     # one completed search (date range)
  _drain_manifest.jsonl                  # one line per finalized file (audit)
```

Each file is a **JSON array in relaxed Extended JSON** (`{"$oid":..}`, `{"$date":"ISO"}`),
compact (one doc per line). Import in Compass: *Collection → Add Data → Import JSON or CSV file*.

## Safety model

- Per part file: `write → fsync → atomic rename → verify read-back → deleteMany({_id: {$in: thosePartIds}})`.
  A doc leaves online only after it is durable on disk **and** the file re-opens with the exact
  doc count written. Delete targets the **exact** `_ids` written, so real-time inserts arriving
  mid-run are never deleted un-exported.
- **Read-back verify (default ON):** before deleting, the finalized file is re-parsed and its doc
  count compared to what was written (files > 160 MB get a structural `[ … ]` check instead, to
  avoid loading them into memory). On failure the docs are **kept online** and the file is
  quarantined as `*.UNVERIFIED.json`. Disable with `--no-verify`.
- A crash at worst re-exports one part next run (a few duplicate docs in a new file, never a
  loss). Leftover `*.tmp` files are cleaned at the next run's start.
- `--dry-run` writes (and verifies) files but deletes nothing - always do one first on a new
  cluster. Note: dry-run files stay on disk while their docs stay online, so the next real run
  re-exports them; delete dry-run files first or use `--out ./data_dryrun`.

## Watch mode & network errors

In `--watch`, a **clean** run is followed by `--interval` seconds (default 300). A **failed**
run (e.g. a network drop / Atlas unreachable) retries fast - `--retry-interval` seconds
(default 5) with exponential backoff up to 60s - instead of waiting the full interval. Once a
run succeeds, the cadence resets to `--interval`. A failed *startup* connect in watch mode also
retries (the watcher won't die on a blip). One-shot (`--once`) still fails fast.

## Flags

`--uri --db --out --mode (both|telemetry|users) --telemetry <csv> --statuses <csv>
 --watch --interval <sec> --retry-interval <sec> --max-part-mb <n> --max-part-docs <n>
 --batch <n> --dry-run --no-verify --pretty`
