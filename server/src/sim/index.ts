import { Checker, type Story } from './assert';
import { BASE_URL, Client, waitForApi } from './client';
import { flakyUpload } from './stories/flakyUpload';
import { ignoredStop } from './stories/ignoredStop';
import { lateBatch } from './stories/lateBatch';
import { lostCredentials } from './stories/lostCredentials';
import { zombieGateway } from './stories/zombieGateway';

// The gateway simulator. It plays failure stories through the fixed API and the test clock.
//   npm run sim                  run every story
//   npm run sim -- <story-name>  run one
//   npm run sim -- --list        list the stories
// The API must run with TEST_MODE=1. Set API_URL if it is not on http://localhost:8000.

const STORIES: Story[] = [zombieGateway, lostCredentials, lateBatch, ignoredStop, flakyUpload];

async function runStory(story: Story): Promise<boolean> {
  console.log(`\n=== ${story.name}: ${story.summary}`);
  const check = new Checker();
  try {
    await story.run(new Client(), check);
  } catch (err) {
    check.failed++;
    console.log(`  FAIL  the story stopped with an error: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`  -> ${story.name}: ${check.failed === 0 ? 'PASSED' : 'FAILED'} (${check.passed} passed, ${check.failed} failed)`);
  return check.failed === 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const s of STORIES) console.log(`${s.name.padEnd(18)} ${s.summary}`);
    return 0;
  }
  const chosen = args.length === 0 ? STORIES : STORIES.filter((s) => args.includes(s.name));
  const unknown = args.filter((a) => !STORIES.some((s) => s.name === a));
  if (unknown.length > 0) {
    console.error(`unknown story: ${unknown.join(', ')}. Try --list.`);
    return 2;
  }

  await waitForApi();
  console.log(`playing ${chosen.length} stor${chosen.length === 1 ? 'y' : 'ies'} against ${BASE_URL}`);
  const results: boolean[] = [];
  for (const story of chosen) results.push(await runStory(story));

  const failed = chosen.filter((_, i) => !results[i]);
  console.log(`\n${chosen.length - failed.length}/${chosen.length} stories passed${failed.length ? `; failed: ${failed.map((s) => s.name).join(', ')}` : ''}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
