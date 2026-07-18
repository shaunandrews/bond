#!/usr/bin/env node
// Bundles the daemon and the bin/bond CLI subcommands with esbuild.
//
// Usage:
//   node scripts/build.mjs daemon         Bundle the daemon → out/daemon/main.mjs
//   node scripts/build.mjs cli            Bundle the CLI subcommands → out/cli/*.js
//   node scripts/build.mjs cli --if-stale Rebuild the CLI only when a source is newer
//   node scripts/build.mjs all            Both
//
// This is the single source of truth for entry points, externals, and banners —
// package.json and bin/bond both call into it so the lists can't drift.

import { build } from 'esbuild'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// CLI subcommands that get their own bundled entry point in out/cli/.
// (connect.ts is a shared helper, bundled transitively — not an entry.)
const CLI_ENTRIES = ['media', 'screenshot', 'soul', 'sense', 'collection']

// esbuild ESM output has no CommonJS `require`; recreate it for externalized deps.
const requireBanner =
  "import{createRequire as createNodeRequire}from'module';const require=createNodeRequire(import.meta.url);"

async function buildDaemon() {
  await build({
    entryPoints: [resolve(root, 'src/daemon/main.ts')],
    outfile: resolve(root, 'out/daemon/main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: requireBanner },
    external: [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      'better-sqlite3',
    ],
  })
}

async function buildCli() {
  await build({
    entryPoints: CLI_ENTRIES.map((name) => resolve(root, `src/cli/${name}.ts`)),
    outdir: resolve(root, 'out/cli'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: requireBanner },
    external: ['ws'],
  })
}

// True when any CLI source is newer than its built output (or the output is missing).
function cliIsStale() {
  return CLI_ENTRIES.some((name) => {
    const src = resolve(root, `src/cli/${name}.ts`)
    const out = resolve(root, `out/cli/${name}.js`)
    try {
      return statSync(src).mtimeMs > statSync(out).mtimeMs
    } catch {
      return true // output missing
    }
  })
}

const [target, flag] = process.argv.slice(2)

switch (target) {
  case 'daemon':
    await buildDaemon()
    break
  case 'cli':
    if (flag === '--if-stale' && !cliIsStale()) break
    await buildCli()
    break
  case 'all':
    await Promise.all([buildDaemon(), buildCli()])
    break
  default:
    console.error(`Unknown build target: ${target ?? '(none)'} (use daemon | cli | all)`)
    process.exit(1)
}
