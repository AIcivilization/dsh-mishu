// Bundle src/client into lib/client.js in DSH's browser module format:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
// React and cordis come from the page through the injected `require`;
// everything else is bundled. Runs the same on macOS, Windows and Linux.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Modules the DSH page provides to browser plugins.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  legalComments: 'inline',
  logLevel: 'warning',
})

const body = result.outputFiles[0].text
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
mkdirSync(new URL('../lib', import.meta.url), { recursive: true })
writeFileSync(new URL('../lib/client.js', import.meta.url), out)

const required = [...body.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1])
const stray = required.filter(r => !PLATFORM_MODULES.includes(r))
if (stray.length > 0) {
  console.error(`client bundle requires modules the page does not provide: ${stray.join(', ')}`)
  process.exit(1)
}
console.log(`lib/client.js: ${(out.length / 1024).toFixed(1)} KiB, externals: ${[...new Set(required)].join(', ')}`)
