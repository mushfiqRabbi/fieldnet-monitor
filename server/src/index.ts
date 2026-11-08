import { createApp } from './app';
import { loadClock } from './clock';
import { migrate } from './migrate';

async function main(): Promise<void> {
  await migrate();
  await loadClock();
  const port = Number(process.env.PORT ?? 8000);
  createApp().listen(port, () => console.log(`api listening on ${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
