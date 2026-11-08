import type { Story } from '../assert';
import { iso, reading } from '../client';
import { at, playDay, playDay0, setupGateway } from '../routine';

// The brief's "A late reading". S went dormant on day 15. On day 20 the gateway uploads a batch
// with a reading taken on day 9. That changes history: days 10 to 19 are only 10 quiet days, so S
// should be active. The server appends ONE correction entry. Sending the same data again changes
// nothing.
export const lateBatch: Story = {
  name: 'late-batch',
  summary: 'a batch arrives days late with an old reading: one correction, a repeat changes nothing',
  async run(api, check) {
    await api.reset();
    const g = await setupGateway(api);

    api.say('playing days 0 to 20: S reads once on day 0, then no_readings every day; dormant from day 15');
    api.quiet = true;
    await playDay0(api, g);
    for (let day = 1; day <= 19; day++) await playDay(api, g, day);
    await api.setClock(at(20, 4));
    await g.cycle([{ sensor_id: 'S2', outcome: 'no_readings' }]);
    await api.setClock(at(20, 12));
    await g.cycle([{ sensor_id: 'S', outcome: 'no_readings' }]);
    api.quiet = false;
    const before = await api.showSensor('S');
    check.equal('before the late batch S is dormant since day 15, 00:00', [before.lifecycle, before.lifecycle_since], ['dormant', iso(at(15))]);

    api.say('the gateway uploads a batch with a reading taken on day 9');
    const late = [reading('late-reading', at(9, 12))];
    const first = await g.putBatch('late-batch', 'S', late);
    await api.drain();
    check.equal('the batch is accepted (202)', first.status, 202);
    const after = await api.showSensor('S');
    check.equal('S is active again, since its first reading', [after.lifecycle, after.lifecycle_since], ['active', iso(at(0, 12))]);
    check.equal('quiet_checked_days is 10 (days 10 to 19)', after.quiet_checked_days, 10);

    const lifecycle = (await api.timeline('sensors', 'S')).filter((e) => e.axis === 'lifecycle');
    const corrections = lifecycle.filter((e) => e.kind === 'correction');
    check.equal('exactly one correction entry', corrections.length, 1);
    check.equal('the correction is dormant -> active', [corrections[0].from, corrections[0].to], ['dormant', 'active']);
    check.equal('it names the late reading as evidence', corrections[0].evidence_ids, ['late-reading']);
    check.equal(
      'the original day-15 dormant entry is still there, unchanged',
      lifecycle.filter((e) => e.kind === 'transition' && e.to === 'dormant').map((e) => e.effective_at),
      [iso(at(15))],
    );

    api.say('the gateway is unsure the upload worked, so it sends the same batch again');
    const entriesBefore = await api.timeline('sensors', 'S');
    const repeat = await g.putBatch('late-batch', 'S', late);
    await api.drain();
    check.equal('an identical repeat answers 200', repeat.status, 200);

    api.say('and it sends the same reading again inside a new batch');
    const resent = await g.putBatch('late-batch-again', 'S', late);
    await api.drain();
    check.equal('the new batch is accepted (202)', resent.status, 202);
    check.equal('its duplicate reading is ignored, not counted', (await api.batch('late-batch-again')).accepted_count, 0);
    check.equal('the first batch still counts its reading once', (await api.batch('late-batch')).accepted_count, 1);

    await api.showSensor('S');
    const entriesAfter = await api.timeline('sensors', 'S');
    check.equal('the sensor timeline did not change at all', JSON.stringify(entriesAfter) === JSON.stringify(entriesBefore), true);
    check.equal('same number of timeline entries as before', entriesAfter.length, entriesBefore.length);
    check.equal(
      'still exactly one correction',
      entriesAfter.filter((e) => e.kind === 'correction').length,
      1,
    );
  },
};
