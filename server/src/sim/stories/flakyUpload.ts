import type { Story } from '../assert';
import { MINUTE, SECOND, reading } from '../client';

// A gateway retries the same upload, and the server's processing fails three times. The batch
// is retried after 1, 2 and 4 minutes (2^(k-1) after attempt k) and is then processed. Every
// reading is counted once, however many times it was sent or attempted.
export const flakyUpload: Story = {
  name: 'flaky-upload',
  summary: 'same batch PUT twice, 3 processing failures: retries at 1/2/4 minutes, counted once',
  async run(api, check) {
    await api.reset();
    const gw = await api.addGateway('gw-flaky');
    await api.addSensor('s-1');
    await api.cover('s-1', ['gw-flaky']);

    const t0 = api.now;
    const readings = [reading('r1', t0), reading('r2', t0 + 30 * SECOND)];
    await api.faults(3);
    api.say('the next 3 processing attempts will fail');

    const first = await gw.putBatch('b-flaky', 's-1', readings);
    check.equal('the first PUT is accepted (202)', first.status, 202);
    const second = await gw.putBatch('b-flaky', 's-1', readings);
    check.equal('the identical second PUT answers 200', second.status, 200);

    const batchAt = async (offset: number, label: string, processing: string, attempts: number) => {
      await api.setClock(t0 + offset);
      const b = await api.batch('b-flaky');
      api.say(`server: batch is ${b.processing}, attempts ${b.attempts}, accepted ${b.accepted_count}`);
      check.equal(label, [b.processing, b.attempts], [processing, attempts]);
    };

    await api.drain();
    api.say('attempt 1 failed; the next try is due after 1 minute');
    await batchAt(59 * SECOND, '59 seconds in: retrying, 1 attempt', 'retrying', 1);
    await batchAt(1 * MINUTE, '1 minute in: attempt 2 failed', 'retrying', 2);
    await batchAt(2 * MINUTE + 59 * SECOND, '2:59 in: still waiting (attempt 2 wait is 2 minutes)', 'retrying', 2);
    await batchAt(3 * MINUTE, '3 minutes in: attempt 3 failed', 'retrying', 3);
    await batchAt(6 * MINUTE + 59 * SECOND, '6:59 in: still waiting (attempt 3 wait is 4 minutes)', 'retrying', 3);
    await batchAt(7 * MINUTE, '7 minutes in: attempt 4 succeeded', 'processed', 4);

    const done = await api.batch('b-flaky');
    check.equal('both readings are accepted, each counted once', done.accepted_count, 2);
    check.equal('nothing is quarantined', done.quarantined, []);

    const third = await gw.putBatch('b-flaky', 's-1', readings);
    check.equal('a PUT after processing still answers 200', third.status, 200);
    await api.drain();
    check.equal('and the count does not change', (await api.batch('b-flaky')).accepted_count, 2);
    await api.showSensor('s-1');
  },
};
