import { TEST_MODE, loadClock, now } from './clock';
import { runDueWork } from './domain/work';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (TEST_MODE) {
    // Brief: in test mode background work runs only inside /test/clock and /test/drain.
    console.log('TEST_MODE is on: the worker idles');
    setInterval(() => undefined, 60_000);
    return;
  }
  await loadClock();
  for (;;) {
    try {
      await runDueWork(now());
    } catch (err) {
      console.error('due work failed', err);
    }
    await sleep(1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
