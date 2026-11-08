// A tiny client for the fieldnet API: operator calls, device calls (with a bearer token),
// and the test endpoints (clock, drain, faults). It uses Node's global fetch.

export const BASE_URL = (process.env.API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Every story starts at day 0, 00:00 UTC. */
export const START = Date.UTC(2026, 0, 1, 0, 0, 0);

export const iso = (t: number) => new Date(t).toISOString();
/** The time in a story's own words: "day 3 12:00" counts days from START. */
export function label(t: number): string {
  const day = Math.floor((t - START) / DAY);
  return `day ${day} ${iso(t).slice(11, 16)}`;
}

/**
 * On a cold start the API may still be starting or migrating. Retry GET /healthz with backoff
 * (connection refused or 5xx) for about a minute before giving up.
 */
export async function waitForApi(timeoutMs = 60 * SECOND): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  for (;;) {
    let why: string;
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
      why = `status ${res.status}`;
    } catch (err) {
      why = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code ?? err.message : String(err);
    }
    if (Date.now() + delay > deadline) throw new Error(`the API at ${BASE_URL} is not up after ${timeoutMs / SECOND}s (${why})`);
    console.log(`waiting for the API at ${BASE_URL} (${why}); retrying in ${delay} ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 4 * SECOND);
  }
}

export interface Reply {
  status: number;
  body: any;
}

export class Client {
  /** Our copy of the server's test clock, so devices can stamp their events with "now". */
  now = START;
  /** When true, device calls are not narrated (used to fast-forward through routine days). */
  quiet = false;

  async call(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** An operator or test call that must succeed. */
  private async ok(method: string, path: string, body?: unknown): Promise<any> {
    const reply = await this.call(method, path, body);
    if (reply.status >= 300) {
      throw new Error(`${method} ${path} -> ${reply.status} ${JSON.stringify(reply.body)}`);
    }
    return reply.body;
  }

  say(text: string): void {
    console.log(`  [${label(this.now)}] ${text}`);
  }

  // --- test endpoints ----------------------------------------------------------

  /** Empty the database and put the clock at `at`. */
  async reset(at = START): Promise<void> {
    const reply = await this.call('POST', '/test/reset');
    if (reply.status !== 200) {
      throw new Error(`POST /test/reset -> ${reply.status}; is the server running with TEST_MODE=1?`);
    }
    await this.setClock(at);
  }

  /** Move the clock forward. The server does all due background work before it answers. */
  async setClock(t: number): Promise<void> {
    await this.ok('POST', '/test/clock', { now: iso(t) });
    this.now = t;
  }

  advance(ms: number): Promise<void> {
    return this.setClock(this.now + ms);
  }

  /** Run due background work (batch processing) without moving the clock. */
  async drain(): Promise<void> {
    await this.ok('POST', '/test/drain');
  }

  /** The next n batch processing attempts fail. */
  async faults(n: number): Promise<void> {
    await this.ok('POST', '/test/faults', { processing_failures: n });
  }

  // --- operator calls ----------------------------------------------------------

  async addGateway(id: string): Promise<Device> {
    const body = await this.ok('POST', '/api/v1/gateways', { gateway_id: id, name: `Gateway ${id}` });
    return new Device(this, id, body.token);
  }

  async addSensor(id: string, type = 'temperature'): Promise<void> {
    await this.ok('POST', '/api/v1/sensors', { sensor_id: id, type });
  }

  async cover(sensorId: string, gatewayIds: string[]): Promise<void> {
    await this.ok('PUT', `/api/v1/sensors/${sensorId}/coverage`, { gateway_ids: gatewayIds });
  }

  gatewayAction(id: string, action: string, reason?: string): Promise<any> {
    return this.ok('POST', `/api/v1/gateways/${id}/actions`, { action, reason });
  }

  gateway(id: string): Promise<any> {
    return this.ok('GET', `/api/v1/gateways/${id}`);
  }

  sensor(id: string): Promise<any> {
    return this.ok('GET', `/api/v1/sensors/${id}`);
  }

  batch(id: string): Promise<any> {
    return this.ok('GET', `/api/v1/batches/${id}`);
  }

  async timeline(kind: 'gateways' | 'sensors', id: string): Promise<any[]> {
    return this.ok('GET', `/api/v1/${kind}/${id}/timeline`);
  }

  // --- narrating what the server now says ---------------------------------------

  async showGateway(id: string): Promise<any> {
    const g = await this.gateway(id);
    const flags = g.flags.length ? ` flags=${g.flags.join(',')}` : '';
    this.say(
      `server: gateway ${id} is ${g.status} since ${label(Date.parse(g.status_since))}, ` +
        `command ${g.command_state}, coverage class ${g.coverage_class}${flags}`,
    );
    return g;
  }

  async showSensor(id: string): Promise<any> {
    const s = await this.sensor(id);
    const next = s.next_evaluation_at ? label(Date.parse(s.next_evaluation_at)) : 'none';
    this.say(
      `server: sensor ${id} is ${s.lifecycle} (quiet days ${s.quiet_checked_days}, sampling cycles ` +
        `${s.sampling_cycles_done}), coverage ${s.coverage}, collection ${s.collection}, next evaluation ${next}`,
    );
    return s;
  }
}

export interface ReadingInput {
  reading_id: string;
  taken_at: string;
  value: number;
  unit: string;
}

export const reading = (id: string, takenAt: number, value = 20, unit = 'C'): ReadingInput => ({
  reading_id: id,
  taken_at: iso(takenAt),
  value,
  unit,
});

export interface CycleResult {
  sensor_id: string;
  outcome: 'readings' | 'no_readings' | 'could_not_read' | 'timeout';
  batch_id?: string;
}

/** A gateway as the server sees it: it only knows its bearer token and the clock it is told. */
export class Device {
  private cycleCount = 0;

  constructor(
    private api: Client,
    readonly id: string,
    private token: string,
  ) {}

  private async send(what: string, method: string, path: string, body?: unknown): Promise<Reply> {
    const reply = await this.api.call(method, path, body, this.token);
    if (!this.api.quiet) this.api.say(`${this.id} ${what} -> ${reply.status}`);
    return reply;
  }

  heartbeat(session: 'ok' | 'auth_failed' = 'ok'): Promise<Reply> {
    return this.send(`sends a heartbeat (${session})`, 'POST', '/gw/v1/heartbeat', {
      sent_at: iso(this.api.now),
      session,
    });
  }

  /** Reports one cycle that finished now. A fresh cycle_id is made unless one is given. */
  cycle(
    results: CycleResult[],
    opts: { session?: 'ok' | 'auth_failed'; cycleId?: string } = {},
  ): Promise<Reply> {
    const session = opts.session ?? 'ok';
    const cycleId = opts.cycleId ?? `${this.id}-cycle-${++this.cycleCount}`;
    const what = results.map((r) => `${r.sensor_id}:${r.outcome}`).join(', ');
    return this.send(`reports a cycle (${session}; ${what})`, 'POST', '/gw/v1/cycles', {
      cycle_id: cycleId,
      started_at: iso(this.api.now - MINUTE),
      finished_at: iso(this.api.now),
      session,
      results,
    });
  }

  putBatch(batchId: string, sensorId: string, readings: ReadingInput[]): Promise<Reply> {
    return this.send(
      `uploads batch ${batchId} (${readings.length} reading${readings.length === 1 ? '' : 's'} of ${sensorId})`,
      'PUT',
      `/gw/v1/batches/${batchId}`,
      { sensor_id: sensorId, readings },
    );
  }

  async commands(): Promise<any[]> {
    const reply = await this.send('asks for commands', 'GET', '/gw/v1/commands');
    return reply.body.commands;
  }

  ack(commandId: string): Promise<Reply> {
    return this.send(`acknowledges command ${commandId.slice(0, 8)}`, 'POST', `/gw/v1/commands/${commandId}/ack`, {
      acked_at: iso(this.api.now),
    });
  }
}
