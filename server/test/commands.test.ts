import { describe, expect, it } from 'vitest';
import {
  T0, HOUR, addGateway, addSensor, api, auth, cover, drain, gateway, gatewayAction, iso, noReadings,
  putBatch, reading, sensor, setClock, timeline, useCleanDatabase,
} from './helpers';

useCleanDatabase();

const MIN = 60_000;

async function connectedGateway(id = 'gw-1', sensorId = 's-1') {
  const token = await addGateway(id);
  await addSensor(sensorId);
  await cover(sensorId, [id]);
  await noReadings(token, `c-${id}`, T0, sensorId).expect(202);
  return token;
}

const commands = async (token: string) => (await api().get('/gw/v1/commands').set(auth(token)).expect(200)).body.commands;
const ack = (token: string, id: string, at: number) =>
  api().post(`/gw/v1/commands/${id}/ack`).set(auth(token)).send({ acked_at: iso(at) });

describe('stop and resume flow', () => {
  it('stop -> stop_pending -> ack -> stopped; resume -> resume_pending -> ack -> running', async () => {
    const token = await connectedGateway();
    expect(await commands(token)).toEqual([]);

    const stop = await gatewayAction('gw-1', 'stop').expect(200);
    expect(stop.body).toMatchObject({ command_state: 'stop_pending', coverage_class: 'available' });
    const [stopCmd] = await commands(token);
    expect(stopCmd).toMatchObject({ seq: 1, type: 'stop', issued_at: iso(T0) });

    await ack(token, stopCmd.command_id, T0 + MIN).expect(204);
    expect(await gateway()).toMatchObject({ command_state: 'stopped', coverage_class: 'stopped' });
    expect(await commands(token)).toEqual([]);

    await gatewayAction('gw-1', 'resume').expect(200);
    expect(await gateway()).toMatchObject({ command_state: 'resume_pending', coverage_class: 'stopped' });
    const [resumeCmd] = await commands(token);
    expect(resumeCmd).toMatchObject({ seq: 2, type: 'resume' });
    await ack(token, resumeCmd.command_id, T0 + 2 * MIN).expect(204);
    expect(await gateway()).toMatchObject({ command_state: 'running', coverage_class: 'available' });
  });

  it('answers 409 for stop while stop_pending/stopped and resume while running', async () => {
    const token = await connectedGateway();
    expect((await gatewayAction('gw-1', 'resume')).status).toBe(409);
    await gatewayAction('gw-1', 'stop').expect(200);
    expect((await gatewayAction('gw-1', 'stop')).status).toBe(409);
    const [cmd] = await commands(token);
    await ack(token, cmd.command_id, T0).expect(204);
    expect((await gatewayAction('gw-1', 'stop')).status).toBe(409);
  });

  it('times out after 10 minutes (effective at issued+10m), and a late ack still stops it', async () => {
    const token = await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    await setClock(T0 + 10 * MIN - 1);
    expect((await gateway()).command_state).toBe('stop_pending');
    await setClock(T0 + HOUR);
    expect(await gateway()).toMatchObject({ command_state: 'stop_failed', coverage_class: 'available' });
    const entries = await timeline('gateways', 'gw-1');
    const failed = entries.find((e) => e.to === 'stop_failed');
    expect(failed).toMatchObject({ effective_at: iso(T0 + 10 * MIN), recorded_at: iso(T0 + HOUR), rule: 'command_timeout' });

    const [cmd] = await commands(token); // still offered while unacknowledged
    await ack(token, cmd.command_id, T0 + 20 * MIN).expect(204);
    expect(await gateway()).toMatchObject({ command_state: 'stopped', coverage_class: 'stopped' });
  });

  it('a resume supersedes a stop; the stop ack is recorded but changes nothing', async () => {
    const token = await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    const [stopCmd] = await commands(token);
    await gatewayAction('gw-1', 'resume').expect(200);
    expect(await commands(token)).toHaveLength(1);
    expect((await commands(token))[0].type).toBe('resume');

    await ack(token, stopCmd.command_id, T0 + MIN).expect(204);
    expect((await gateway()).command_state).toBe('resume_pending');
    const entries = await timeline('gateways', 'gw-1');
    expect(entries.at(-1)).toMatchObject({ kind: 'ack', rule: 'ack_superseded', evidence_ids: [stopCmd.command_id] });
  });

  it('a stop after a pending resume supersedes the resume', async () => {
    await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    await gatewayAction('gw-1', 'resume').expect(200);
    await gatewayAction('gw-1', 'stop').expect(200);
    expect((await gateway()).command_state).toBe('stop_pending');
  });

  it('ack is idempotent', async () => {
    const token = await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    const [cmd] = await commands(token);
    await ack(token, cmd.command_id, T0).expect(204);
    const before = (await timeline('gateways', 'gw-1')).length;
    await ack(token, cmd.command_id, T0 + MIN).expect(204);
    expect((await timeline('gateways', 'gw-1')).length).toBe(before);
    expect((await gateway()).command_state).toBe('stopped');
  });

  it('ack of an unknown command or another gateway\'s command is 404', async () => {
    const token = await connectedGateway();
    const other = await connectedGateway('gw-2', 's-2');
    await gatewayAction('gw-2', 'stop').expect(200);
    const [theirs] = await commands(other);
    expect((await ack(token, theirs.command_id, T0)).status).toBe(404);
    expect((await ack(token, 'not-a-command', T0)).status).toBe(404);
    expect((await gateway('gw-2')).command_state).toBe('stop_pending');
  });
});

describe('gateway coverage class', () => {
  const setStatus = async (token: string, status: string) => {
    if (status === 'stale') await setClock(T0 + 13 * HOUR);
    if (status === 'suspended') await gatewayAction('gw-1', 'suspend', 'x').expect(200);
    if (status === 'disconnected') await api().post('/gw/v1/heartbeat').set(auth(token)).send({ sent_at: iso(T0 + MIN), session: 'auth_failed' });
    if (status === 'retired') await gatewayAction('gw-1', 'retire').expect(200);
  };

  it.each([
    ['connected', 'running', 'available'],
    ['connected', 'stop_pending', 'available'],
    ['connected', 'stop_failed', 'available'],
    ['connected', 'stopped', 'stopped'],
    ['connected', 'resume_pending', 'stopped'],
    ['connected', 'resume_failed', 'stopped'],
    ['stale', 'stopped', 'recoverable'],
    ['disconnected', 'running', 'recoverable'],
    ['suspended', 'stopped', 'dead'],
    ['retired', 'running', 'dead'],
  ])('%s with %s is %s', async (status, commandState, expected) => {
    const token = await connectedGateway();
    // reach the command state while still connected
    if (commandState !== 'running') {
      await gatewayAction('gw-1', commandState.startsWith('resume') ? 'stop' : 'stop').expect(200);
      if (commandState !== 'stop_pending' && commandState !== 'stop_failed') {
        const [stopCmd] = await commands(token);
        await ack(token, stopCmd.command_id, T0 + MIN).expect(204);
      }
      if (commandState.startsWith('resume')) await gatewayAction('gw-1', 'resume').expect(200);
      if (commandState === 'stop_failed' || commandState === 'resume_failed') await setClock(T0 + 11 * MIN);
    }
    expect((await gateway()).command_state).toBe(commandState);
    await setStatus(token, status);
    expect(await gateway()).toMatchObject({ status, coverage_class: expected });
  });

  it('feeds the sensor coverage: stopped gateway gives collection_stopped', async () => {
    const token = await connectedGateway();
    expect(await sensor()).toMatchObject({ coverage: 'available', collection: 'no_readings' });
    await gatewayAction('gw-1', 'stop').expect(200);
    const [cmd] = await commands(token);
    await ack(token, cmd.command_id, T0 + MIN).expect(204);
    await setClock(T0 + 2 * MIN);
    expect(await sensor()).toMatchObject({ coverage: 'stopped', collection: 'collection_stopped' });
  });
});

describe('collecting_after_stop', () => {
  async function stoppedGateway(ackAt: number) {
    const token = await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    const [cmd] = await commands(token);
    await ack(token, cmd.command_id, ackAt).expect(204);
    return token;
  }

  it('is raised by readings taken inside the stop period, not before the stop ack, and cleared on resume ack', async () => {
    const token = await stoppedGateway(T0 + MIN);

    await putBatch(token, 'before', 's-1', [reading('r-before', T0 + 30_000)]).expect(202);
    await drain();
    expect((await gateway()).flags).toEqual([]);

    await putBatch(token, 'inside', 's-1', [reading('r-in', T0 + 2 * MIN)]).expect(202);
    await drain();
    expect((await gateway()).flags).toEqual(['collecting_after_stop']);
    const flagEntry = (await timeline('gateways', 'gw-1')).find((e) => e.kind === 'flag');
    expect(flagEntry).toMatchObject({ evidence_ids: ['r-in'], rule: 'collecting_after_stop' });

    await gatewayAction('gw-1', 'resume').expect(200);
    expect((await gateway()).flags).toEqual(['collecting_after_stop']); // cleared only by the ack
    const [resumeCmd] = await commands(token);
    await ack(token, resumeCmd.command_id, T0 + 5 * MIN).expect(204);
    expect((await gateway()).flags).toEqual([]);

    await putBatch(token, 'after', 's-1', [reading('r-after', T0 + 6 * MIN)]).expect(202);
    await drain();
    expect((await gateway()).flags).toEqual([]);
  });

  it('keeps and counts the reading even though the gateway was stopped', async () => {
    const token = await stoppedGateway(T0 + MIN);
    await putBatch(token, 'b', 's-1', [reading('r1', T0 + 2 * MIN)]).expect(202);
    await setClock(T0 + 3 * MIN);
    expect((await api().get('/api/v1/batches/b')).body).toMatchObject({ processing: 'processed', accepted_count: 1 });
    expect((await sensor()).lifecycle).toBe('active');
  });

  it('a stop ack that arrives after the readings raises the flag too', async () => {
    const token = await connectedGateway();
    await gatewayAction('gw-1', 'stop').expect(200);
    const [cmd] = await commands(token);
    await putBatch(token, 'b', 's-1', [reading('r1', T0 + 2 * MIN)]).expect(202);
    await drain();
    expect((await gateway()).flags).toEqual([]);
    await ack(token, cmd.command_id, T0 + MIN).expect(204);
    expect((await gateway()).flags).toEqual(['collecting_after_stop']);
  });
});
