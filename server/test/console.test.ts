import { describe, expect, it } from 'vitest';
import {
  T0, addGateway, addSensor, api, cover, gatewayAction, iso, noReadings, useCleanDatabase,
} from './helpers';

useCleanDatabase();

describe('console list endpoints', () => {
  it('lists gateways with sensor_ids, server_now and a status filter', async () => {
    const token = await addGateway('gw-1');
    await addGateway('gw-2');
    await addSensor('s-1');
    await addSensor('s-2');
    await cover('s-1', ['gw-1']).expect(200);
    await cover('s-2', ['gw-1']).expect(200);
    await noReadings(token, 'c1', T0).expect(202);

    const all = (await api().get('/api/v1/gateways').expect(200)).body;
    expect(all.server_now).toBe(iso(T0));
    expect(all.items.map((g: any) => [g.gateway_id, g.status, g.sensor_ids])).toEqual([
      ['gw-1', 'connected', ['s-1', 's-2']],
      ['gw-2', 'new', []],
    ]);
    expect(Object.keys(all.items[0]).sort()).toEqual([
      'command_state', 'coverage_class', 'disconnected_since', 'flags', 'gateway_id', 'last_heartbeat_at',
      'last_qualifying_at', 'name', 'sensor_ids', 'status', 'status_since',
    ]);
    const connected = (await api().get('/api/v1/gateways?status=connected').expect(200)).body.items;
    expect(connected.map((g: any) => g.gateway_id)).toEqual(['gw-1']);
    expect((await api().get('/api/v1/gateways/gw-1').expect(200)).body.sensor_ids).toEqual(['s-1', 's-2']);
  });

  it('lists sensors with gateway_ids and filters by lifecycle, coverage and collection', async () => {
    const token = await addGateway('gw-1');
    await addSensor('s-1');
    await addSensor('s-2', 'wind');
    await cover('s-1', ['gw-1']).expect(200);
    await noReadings(token, 'c1', T0).expect(202);

    const all = (await api().get('/api/v1/sensors').expect(200)).body;
    expect(all.server_now).toBe(iso(T0));
    expect(all.items.map((s: any) => [s.sensor_id, s.coverage, s.collection, s.gateway_ids])).toEqual([
      ['s-1', 'available', 'no_readings', ['gw-1']],
      ['s-2', 'none', 'not_checked', []],
    ]);
    const ids = async (query: string) => (await api().get(`/api/v1/sensors?${query}`).expect(200)).body.items.map((s: any) => s.sensor_id);
    expect(await ids('coverage=none')).toEqual(['s-2']);
    expect(await ids('collection=no_readings')).toEqual(['s-1']);
    expect(await ids('lifecycle=pending')).toEqual(['s-1', 's-2']);
    expect(await ids('lifecycle=pending&coverage=available')).toEqual(['s-1']);
    expect(await ids('lifecycle=active')).toEqual([]);
  });

  it('summarises situations with every known value present', async () => {
    await addGateway('gw-1');
    await addGateway('gw-2');
    await addSensor('s-1');
    await gatewayAction('gw-2', 'suspend', 'x').expect(200);
    const summary = (await api().get('/api/v1/summary').expect(200)).body;
    expect(summary.server_now).toBe(iso(T0));
    expect(summary.gateways.by_status).toEqual({
      new: 1, spare: 0, connected: 0, stale: 0, disconnected: 0, suspended: 1, retired: 0,
    });
    expect(summary.gateways.by_coverage_class).toEqual({ available: 0, stopped: 0, recoverable: 1, dead: 1 });
    expect(summary.gateways.flagged).toBe(0);
    expect(summary.sensors.by_lifecycle).toEqual({
      pending: 1, active: 0, dormant: 0, sampling: 0, retired: 0, decommissioned: 0,
    });
    expect(summary.sensors.by_coverage).toEqual({ available: 0, stopped: 0, recoverable: 0, none: 1 });
    expect(summary.sensors.by_collection).toEqual({
      readings: 0, no_readings: 0, could_not_read: 0, timed_out: 0, not_checked: 1, collection_stopped: 0,
    });
  });
});
