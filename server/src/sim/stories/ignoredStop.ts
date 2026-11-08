import type { Story } from '../assert';
import { MINUTE, iso, reading } from '../client';

// A gateway that ignores a stop command. After 10 minutes the server calls it stop_failed (it
// does not know whether the gateway stopped). The gateway keeps uploading readings. Later it
// acknowledges the stop, and from then on readings count as "collecting after stop". A resume
// that is acknowledged clears the flag.
export const ignoredStop: Story = {
  name: 'ignored-stop',
  summary: 'stop never acked: stop_failed after 10 min; late ack; collecting_after_stop; resume clears it',
  async run(api, check) {
    await api.reset();
    const gw = await api.addGateway('gw-stop');
    await api.addSensor('s-1');
    await api.cover('s-1', ['gw-stop']);
    await gw.cycle([{ sensor_id: 's-1', outcome: 'no_readings' }]);
    await api.showGateway('gw-stop');

    api.say('the operator stops the gateway');
    const t0 = api.now;
    const pending = await api.gatewayAction('gw-stop', 'stop', 'site maintenance');
    check.equal('command state is stop_pending', pending.command_state, 'stop_pending');
    const [stop] = await gw.commands();
    check.equal('the gateway can see a stop command', stop.type, 'stop');

    api.say('the gateway never acknowledges it, but keeps taking readings');
    await api.advance(5 * MINUTE);
    await gw.putBatch('b-before-ack', 's-1', [reading('r-before-ack', api.now)]);
    await api.drain();
    await api.setClock(t0 + 9 * MINUTE);
    check.equal('after 9 minutes it is still stop_pending', (await api.gateway('gw-stop')).command_state, 'stop_pending');
    await api.setClock(t0 + 10 * MINUTE);
    const failed = await api.showGateway('gw-stop');
    check.equal('10 minutes after the stop it is stop_failed', failed.command_state, 'stop_failed');
    check.equal('stop_failed is not proof of a stop: coverage class stays available', failed.coverage_class, 'available');
    check.equal('the stop command is still waiting for an ack', (await gw.commands()).length, 1);
    check.equal('readings taken before any ack raise no flag', failed.flags, []);

    api.say('30 minutes after the stop, the gateway finally acknowledges it');
    await api.setClock(t0 + 30 * MINUTE);
    const ack = await gw.ack(stop.command_id);
    check.equal('the late ack is accepted (204)', ack.status, 204);
    const stopped = await api.showGateway('gw-stop');
    check.equal('a late ack of the latest command moves stop_failed to stopped', stopped.command_state, 'stopped');
    check.equal('the class is now stopped', stopped.coverage_class, 'stopped');
    check.equal('the acknowledged command is no longer offered', (await gw.commands()).length, 0);
    check.equal('readings taken before the ack still raise no flag', stopped.flags, []);

    api.say('the gateway keeps collecting although it said it stopped');
    await api.advance(10 * MINUTE);
    await gw.putBatch('b-after-ack', 's-1', [reading('r-after-ack', api.now)]);
    await api.drain();
    const flagged = await api.showGateway('gw-stop');
    check.equal('a reading taken after the ack raises collecting_after_stop', flagged.flags, ['collecting_after_stop']);
    check.equal('the reading is kept and counted', (await api.batch('b-after-ack')).accepted_count, 1);

    api.say('the operator resumes the gateway and it acknowledges');
    const resuming = await api.gatewayAction('gw-stop', 'resume');
    check.equal('command state is resume_pending', resuming.command_state, 'resume_pending');
    const [resume] = await gw.commands();
    check.equal('the gateway sees a resume command', resume.type, 'resume');
    await api.advance(MINUTE);
    await gw.ack(resume.command_id);
    const running = await api.showGateway('gw-stop');
    check.equal('the resume ack sets the state to running', running.command_state, 'running');
    check.equal('the flag is cleared', running.flags, []);

    const stamp = (await api.timeline('gateways', 'gw-stop')).filter((e) => e.rule === 'collecting_after_stop');
    check.equal('the flag was recorded in the timeline with the reading as evidence', stamp.map((e) => e.evidence_ids), [['r-after-ack']]);
    const issued = (await api.timeline('gateways', 'gw-stop')).find((e) => e.rule === 'stop');
    check.equal('the timeline shows the stop issued at the time the operator asked', issued?.effective_at, iso(t0));
  },
};
