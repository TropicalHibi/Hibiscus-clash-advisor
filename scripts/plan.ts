// npm run plan -- <export.json> [--gold-pass max] [--hours 24] [--at-export]
// Prints the plan for an export file in the terminal.
import fs from 'node:fs';
import path from 'node:path';
import { loadGameDataNode, readConfig, PROJECT_ROOT } from '../src/data/loadNode';
import { buildPlan } from '../src/engine/plan';
import { planToText } from '../src/engine/planText';
import { coerceMeta } from '../src/meta/meta';
import { parseExport } from '../src/state/parseExport';
import { settingsFromYaml } from '../src/state/settings';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--gold-pass', '--hours']);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));

const candidates = [positional[0], 'samples/my-export.json', 'samples/myexport.json', 'tests/fixtures/export-th16.json'].filter(Boolean) as string[];
const file = candidates.map((f) => path.resolve(process.cwd(), f)).find((f) => fs.existsSync(f));
if (!file) {
  console.error('No export file found. Usage: npm run plan -- path/to/export.json');
  process.exit(1);
}

const data = loadGameDataNode();
const settings = settingsFromYaml(readConfig('settings.sample.yaml'));
if (flag('--gold-pass') === 'max') settings.goldPass = 'max';
if (flag('--hours')) settings.forecast.windowHours = Number(flag('--hours'));
const meta = coerceMeta(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'meta.json'), 'utf8')));

const account = parseExport(fs.readFileSync(file, 'utf8'), data);
const nowSec = args.includes('--at-export') && account.exportTimestamp ? account.exportTimestamp : Math.floor(Date.now() / 1000);
console.log(`Export: ${path.relative(PROJECT_ROOT, file)}\n`);
console.log(planToText(buildPlan(data, account, settings, meta, nowSec)));
