/**
 * Build `client/bundle.js` from `client/index.js`.
 *
 * Follows the client-modules bundle protocol:
 * `window.__ModuleLoader__.load({ id, factory })` registers a lazy CommonJS
 * factory that receives a `require` resolving framework modules (react is a
 * platform module; every other dependency is inlined). Unlike the simpler
 * verbatim inlining used by dsh-tasks, this build runs esbuild so npm deps
 * (echarts, gridstack) and the shared `client/formula.js` are bundled into
 * the factory scope, with `react` left external for the platform require.
 *
 * Run: `npm run build:client` (requires devDependencies installed).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'client', 'index.js')
const bundlePath = join(root, 'client', 'bundle.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  external: ['react'],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  write: false,
  logLevel: 'info',
})

let code = result.outputFiles[0].text
if (!code.endsWith('\n')) code += '\n'

const banner = `/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require("react")
`

const footer = `
    return module.exports
  }
})`

writeFileSync(bundlePath, banner + code + footer)
const kb = Math.round(Buffer.byteLength(banner + code + footer) / 1024)
console.log(`client/bundle.js written (${kb} KB)`)
