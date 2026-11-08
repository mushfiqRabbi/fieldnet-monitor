# FieldNet Monitor

Server, state engine and operator console for a sensor network whose devices are unreliable.
It works out every gateway's and sensor's situation from the evidence the devices send, moves
them between situations by the rules of the brief, and shows them through an API and a console.

* **API**: Node 22, Express, TypeScript, PostgreSQL 16 (`server/`)
* **Console**: Next.js + TypeScript + Tailwind (`web/`)
* **Background work**: a DB-backed due-work loop (`worker` service)

## Run it

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Console | http://localhost:3000 |
| API | http://localhost:8000 |
| Postgres | inside the compose network (`db:5432`) |

The API starts with `TEST_MODE=1`, so the test endpoints (`/test/reset`, `/test/clock`,
`/test/drain`, `/test/faults`) are there. In test mode, background work runs **only** inside
`/test/clock` and `/test/drain`, as the brief requires.

For live mode, where the worker processes batches and timers every second on the real clock:

```bash
TEST_MODE=0 docker compose up --build
```

## Run the tests

```bash
docker compose run --rm test
```

This runs 195 tests against a separate database (`fieldnet_test`), so it does not touch the
console's data:

* `server/test/sensorEngine.test.ts`: the pure sensor engine, including the brief's worked
  example and its three variations.
* `server/test/workedExample.test.ts`: the same worked example played end to end through the HTTP
  API and the test clock.
* The other files cover the fixed API: gateway status, commands, cycles, batches and retries,
  coverage, corrections, timelines and the console endpoints.

## Run the simulator

```bash
docker compose run --rm sim                       # all stories
docker compose run --rm sim npm run sim -- --list # list them
docker compose run --rm sim npm run sim -- late-batch
```

The simulator acts like the gateways. It talks only to the fixed API and the test clock, and
each story ends in assertions (exit code 1 if any fails). It **resets the API's data**, so
afterwards the console shows the last story's state.

| Story | What goes wrong | What it asserts |
|---|---|---|
| `zombie-gateway` | heartbeats every hour, no cycles | stale exactly 12h after the last cycle while the heartbeat stays fresh |
| `lost-credentials` | `auth_failed` mid sampling window | window pauses; an ok heartbeat does not reconnect; a good cycle resumes it with the time left |
| `late-batch` | a batch arrives 11 days late | one `correction` entry; a repeat changes nothing |
| `ignored-stop` | a stop is never acknowledged, then acked late | `stop_failed` at 10 min, then `stopped`; readings after the ack raise `collecting_after_stop`; resume clears it |
| `flaky-upload` | duplicate PUT and 3 processing failures | 200 on repeat, retries after 1/2/4 min, each reading counted once |

## Without Docker (development)

```bash
# a Postgres on localhost:5433 with databases fieldnet and fieldnet_test
cd server && npm install
DATABASE_URL=postgres://fieldnet:fieldnet@localhost:5433/fieldnet TEST_MODE=1 npm run dev
npm test          # uses fieldnet_test
API_URL=http://localhost:8000 npm run sim
cd ../web && npm install && API_URL=http://localhost:8000 npm run dev
```

## Documents

* `DECISIONS.md`: how state and time are modelled, where each rule lives, retries, late data
  and corrections, interpretations, trade-offs.
* `docs/console-api.md`: the console API (the brief's operator/state API plus list and summary
  endpoints).
* `docs/DESIGN.md`: the longer design, with the sensor replay algorithm step by step.
* `AI.md`: how AI tools were used.

## Layout

```
server/src/
  domain/sensorEngine.ts   pure sensor replay (the core rules)
  domain/sensorStore.ts    replay -> timeline entries and corrections
  domain/gateway.ts        gateway status rules and operator actions
  domain/commands.ts       stop / resume, acks, collecting_after_stop
  domain/batches.ts        batch processing, retries, quarantine
  domain/work.ts           background due-work loop
  routes/                  HTTP: gateway API, operator API, console API, test API
  sim/                     the simulator
web/                       the operator console
```
