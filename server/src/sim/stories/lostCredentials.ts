import type { Story } from '../assert';
import { HOUR, iso } from '../client';
import { at, playDay, playDay0, setupGateway } from '../routine';

// The brief's "Disconnection mid-window". Sensor S is in its first sampling window when the
// gateway loses its credentials. The window pauses. An ok heartbeat does not reconnect the
// gateway, only a good cycle does, and then the window resumes with the time it had left.
export const lostCredentials: Story = {
  name: 'lost-credentials',
  summary: 'auth_failed mid sampling window: pause, ok heartbeat does not help, good cycle resumes',
  async run(api, check) {
    await api.reset();
    const g = await setupGateway(api);

    api.say('playing days 0 to 29: S reads once, then no_readings every day; S goes dormant, then samples');
    api.quiet = true;
    await playDay0(api, g);
    for (let day = 1; day <= 28; day++) await playDay(api, g, day);
    await api.setClock(at(29));
    api.quiet = false;
    const sampling = await api.showSensor('S');
    check.equal('S is sampling from day 29, 00:00', [sampling.lifecycle, sampling.lifecycle_since], ['sampling', iso(at(29))]);
    check.equal('the window ends on day 32, 00:00', sampling.next_evaluation_at, iso(at(32)));

    api.quiet = true;
    await playDay(api, g, 29);
    await api.setClock(at(30, 4));
    await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
    api.quiet = false;

    await api.setClock(at(30, 12));
    api.say('the gateway has lost its credentials and reports auth_failed');
    const failed = await g.cycle([{ sensor_id: 'S', outcome: 'no_readings' }], { session: 'auth_failed' });
    check.equal('the server still accepts the cycle (202)', failed.status, 202);
    const gw = await api.showGateway('G');
    const paused = await api.showSensor('S');
    check.equal('the gateway is disconnected', gw.status, 'disconnected');
    check.equal('disconnected_since is the failed cycle time', gw.disconnected_since, iso(at(30, 12)));
    check.equal('S is still sampling', paused.lifecycle, 'sampling');
    check.equal('the window is paused: no next evaluation', paused.next_evaluation_at, null);
    check.equal('collection is not_checked', paused.collection, 'not_checked');
    check.equal('coverage is recoverable', paused.coverage, 'recoverable');

    await api.setClock(at(31));
    api.say('the gateway can send heartbeats again (session ok), but still no cycles');
    await g.heartbeat('ok');
    await api.setClock(at(36));
    await g.heartbeat('ok');
    const afterHeartbeat = await api.showGateway('G');
    const stillPaused = await api.showSensor('S');
    check.equal('an ok heartbeat does not reconnect the gateway', afterHeartbeat.status, 'disconnected');
    check.equal('S is still paused', stillPaused.next_evaluation_at, null);

    await api.setClock(at(37, 12));
    api.say('a good cycle at last');
    await g.cycle([{ sensor_id: 'S', outcome: 'no_readings' }]);
    const back = await api.showGateway('G');
    const resumed = await api.showSensor('S');
    check.equal('the good cycle reconnects the gateway', back.status, 'connected');
    check.equal('S is sampling with coverage available', [resumed.lifecycle, resumed.coverage], ['sampling', 'available']);
    check.equal(
      'the window resumes with the 36 hours it had left: ends day 39, 00:00',
      resumed.next_evaluation_at,
      iso(at(37, 12) + 36 * HOUR),
    );

    api.say('the gateway keeps reporting until the window ends');
    api.quiet = true;
    await api.setClock(at(37, 20));
    await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
    await api.setClock(at(38, 4));
    await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
    await api.setClock(at(38, 12));
    await g.cycle([{ sensor_id: 'S', outcome: 'no_readings' }]);
    await api.setClock(at(38, 20));
    await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
    await api.setClock(at(39));
    api.quiet = false;
    const done = await api.showSensor('S');
    check.equal('the window ends on day 39 and S is dormant with one sampling cycle done', [done.lifecycle, done.sampling_cycles_done], ['dormant', 1]);
  },
};
