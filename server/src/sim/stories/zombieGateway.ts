import type { Story } from '../assert';
import { HOUR, MINUTE, START, iso } from '../client';

// A gateway that heartbeats every hour but has stopped sending cycles. Heartbeats are not
// qualifying evidence, so the server must call it stale 12 hours after its last real cycle,
// even though last_heartbeat_at stays fresh. That is the console's "heartbeating while
// collecting nothing".
export const zombieGateway: Story = {
  name: 'zombie-gateway',
  summary: 'heartbeats every hour, no cycles: stale exactly 12h after the last cycle',
  async run(api, check) {
    await api.reset();
    const gw = await api.addGateway('zombie');
    await api.addSensor('s-1');
    await api.cover('s-1', ['zombie']);

    api.say('the gateway reports one cycle (s-1 has no readings), then goes silent apart from heartbeats');
    await gw.cycle([{ sensor_id: 's-1', outcome: 'no_readings' }]);
    await api.showGateway('zombie');

    for (let hour = 1; hour <= 11; hour++) {
      await api.advance(HOUR);
      await gw.heartbeat();
    }
    await api.showGateway('zombie');
    check.equal('after 11 hours of heartbeats the gateway is still connected', (await api.gateway('zombie')).status, 'connected');

    await api.setClock(START + 12 * HOUR - MINUTE);
    check.equal('one minute before the 12 hours are up it is still connected', (await api.gateway('zombie')).status, 'connected');

    await api.setClock(START + 12 * HOUR);
    await gw.heartbeat();
    const stale = await api.showGateway('zombie');
    check.equal('exactly 12 hours after the last cycle it is stale', stale.status, 'stale');
    check.equal('stale since exactly last cycle + 12h', stale.status_since, iso(START + 12 * HOUR));

    await api.advance(2 * HOUR);
    await gw.heartbeat();
    const later = await api.showGateway('zombie');
    check.equal('heartbeats do not revive it: still stale', later.status, 'stale');
    check.equal('last_heartbeat_at is fresh (the latest heartbeat)', later.last_heartbeat_at, iso(START + 14 * HOUR));
    check.equal('last_qualifying_at is still the one cycle', later.last_qualifying_at, iso(START));
    check.equal('its coverage class is recoverable', later.coverage_class, 'recoverable');

    const sensor = await api.showSensor('s-1');
    check.equal('the sensor it covers is not checked (nothing counts)', sensor.collection, 'not_checked');
    check.equal('the sensor coverage is recoverable', sensor.coverage, 'recoverable');

    api.say('the gateway finally sends a real cycle again');
    await gw.cycle([{ sensor_id: 's-1', outcome: 'no_readings' }]);
    check.equal('a cycle with a result brings it back to connected', (await api.showGateway('zombie')).status, 'connected');
  },
};
