import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** Every file under src/core, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))
}

test('src/core imports nothing from DSH', () => {
  const core = fileURLToPath(new URL('../src/core', import.meta.url))
  for (const file of files(core)) {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]!)
    const foreign = imports.filter(s => !s.startsWith('.') && !s.startsWith('node:'))
    assert.deepEqual(foreign, [], `${file} imports ${foreign.join(', ')}`)
  }
})
