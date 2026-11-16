// Token Radar's entry point (Node 22, standard library only).
//
// It reads the sealed snapshot — /input/snapshot.json in the grader's container, or
// --input <file|dir> anywhere else — scores every eligible pre-token protocol with the
// radar-2 model in lib/model.ts, and writes the ranked board to the output directory:
// board.json, data.js for the dashboard, a copy of dashboard/ and screenshots/, and
// dossier.json, the summary the judge reads, built with the vendored make.fun library.
//
// The dashboard is a static page with no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read data.js, which this program writes from
// the very same board the judge grades.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBoardProblem, assembleRadar, renderDataScript, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_CAP_BYTES = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` (or `--name=<value>`) on the command line, else `fallback`. */
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === `--${name}` && i + 1 < argv.length) return argv[i + 1]!;
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return fallback;
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const inputArg = flagValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = assembleRadar(snapshot);
const problem = findBoardProblem(board, snapshot);
if (problem !== null) fail(`token radar: the model wrote a board the gate refuses: ${problem}`, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), renderDataScript(radar));

/** Copy one directory's plain files into `dest`, skipping dot-names; returns the names copied. */
function copyPlainFiles(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(dest, name));
    copied.push(name);
  }
  return copied;
}

copyPlainFiles(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyPlainFiles(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(
    `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`,
    1,
  );
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    fail(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }
}

// The dossier goes last: the scorer rebuilds it from this output directory and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: TEXT_CAP_BYTES,
    screenshots: SHOT_LIMIT,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
