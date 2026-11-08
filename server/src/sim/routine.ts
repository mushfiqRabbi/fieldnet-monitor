import { Client, DAY, Device, HOUR, START, reading } from './client';

// The routine the brief's worked example needs. G reports sensor S once a day at 12:00, but a
// gateway whose only evidence is one cycle per day goes stale every night (12-hour rule). So
// G also covers a second sensor, S2, and sends a cycle for it every 8 hours (04:00 and 20:00).
// That keeps G connected without ever reporting S more than the brief says.

/** Day n at the given hour (day n means 00:00 UTC on the n-th day after day 0). */
export const at = (day: number, hour = 0) => START + day * DAY + hour * HOUR;

/** Register gateway G with sensors S and S2, both covered by G. */
export async function setupGateway(api: Client): Promise<Device> {
  const g = await api.addGateway('G');
  await api.addSensor('S');
  await api.addSensor('S2');
  await api.cover('S', ['G']);
  await api.cover('S2', ['G']);
  return g;
}

/** Day 0: S2 at 04:00, then S's first reading at 12:00 (batch processed at 12:01), S2 at 20:00. */
export async function playDay0(api: Client, g: Device): Promise<void> {
  await api.setClock(at(0, 4));
  await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
  await api.setClock(at(0, 12));
  await g.putBatch('batch-day-0', 'S', [reading('reading-day-0', at(0, 12))]);
  await g.cycle([{ sensor_id: 'S', outcome: 'readings', batch_id: 'batch-day-0' }]);
  await api.setClock(at(0, 12) + 60_000);
  await api.setClock(at(0, 20));
  await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
}

/** A normal day: S2 at 04:00, S (no readings) at 12:00, S2 at 20:00. */
export async function playDay(api: Client, g: Device, day: number): Promise<void> {
  await api.setClock(at(day, 4));
  await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
  await api.setClock(at(day, 12));
  await g.cycle([{ sensor_id: 'S', outcome: 'no_readings' }]);
  await api.setClock(at(day, 20));
  await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
}
