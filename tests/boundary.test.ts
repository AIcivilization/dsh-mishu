import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Every file under src/core, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
const declared = new Set(Object.keys(pkg.dependencies ?? {}))

test('src/core imports nothing from DSH, and only the runtime dependencies package.json declares', () => {
  const core = fileURLToPath(new URL('../src/core', import.meta.url))
  for (const file of files(core)) {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]!)
    const foreign = imports.filter(s => !s.startsWith('.') && !s.startsWith('node:'))
    assert.deepEqual(foreign.filter(s => s.startsWith('@deepseek-ai/')), [], `${file} imports DSH`)
    assert.deepEqual(foreign.filter(s => !declared.has(s)), [], `${file} imports undeclared ${foreign.join(', ')}`)
  }
})
