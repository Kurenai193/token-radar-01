// Token Radar entrypoint (token-radar-01, Node 22, standard library only).
//
// Pipeline, in order:
//   1. Load the sealed snapshot (from /input, or from --input <file|directory>).
//   2. Score every pre-token protocol with the fitted model in lib/model.ts and
//      run the board past the gate in the same file; a board the gate refuses
//      stops the run before anything is written.
//   3. Write board.json and data.js (the dashboard's dataset) to the output
//      directory, then mirror this repository's dashboard/ and screenshots/
//      beside them.
//   4. Write dossier.json last of all, with the vendored make.fun library: the
//      scorer rebuilds it from the finished output and compares bytes, so it
//      must describe the output exactly as it stands when the run ends.
//
// Local runs point MAKEFUN_OUTPUT_DIR at a scratch directory:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** Print why the run stops, and stop with the given exit code. */
function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** The value of `--name value` or `--name=value` in the arguments, else the fallback. */
function readFlag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1]!;
    if (args[i]!.startsWith(`--${name}=`)) return args[i]!.slice(name.length + 3);
  }
  return fallback;
}

// --- 1. Snapshot -----------------------------------------------------------

const inputGiven = readFlag('input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));

// --- 2. Board --------------------------------------------------------------

const { board, radar } = buildRadar(snapshot);
const refusal = boardIssue(board, snapshot);
if (refusal !== null) fail(`the model wrote a board the gate refuses: ${refusal}`, 1);

// --- 3. Outputs ------------------------------------------------------------

const outDir = readFlag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Mirror a directory's regular files into the output, skipping dotfiles; returns the names copied. */
function mirrorDir(name: string): string[] {
  const from = join(repoDir, name);
  if (!existsSync(from)) return [];
  const to = join(outDir, name);
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isFile()) continue;
    copyFileSync(join(from, entry.name), join(to, entry.name));
    copied.push(entry.name);
  }
  return copied;
}

mirrorDir('dashboard');
const shotNames = mirrorDir('screenshots');
if (shotNames.length < 3) {
  fail(`screenshots/ holds ${shotNames.length}: hand in 3, the board, a detail view and a filtered view`, 1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shotNames) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
}

// --- 4. Dossier (last, so it describes the finished output) -----------------

const DOSSIER_LIMITS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, DOSSIER_LIMITS));

process.stdout.write(
  [
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)`,
    `token radar: wrote board.json, data.js, dashboard/, screenshots/ (${shotNames.length} images) and dossier.json under ${outDir}`,
    '',
  ].join('\n'),
);
