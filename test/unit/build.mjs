import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

// Bundle the pure model modules so the .test.mjs files can import them.
const entryPoints = readdirSync('src/model').filter((f) => f.endsWith('.ts')).map((f) => `src/model/${f}`);
await esbuild.build({ entryPoints, outdir: 'out-test/model', bundle: true, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'warning' });
