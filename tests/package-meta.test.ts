import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

// DSH's plugin manager shows a plugin's title, description and icon only when
// the package exports them: `<pkg>/locale/en.json` (plus any sibling language
// files), `<pkg>/package.json` and `<pkg>/icon`. Anything not exported resolves
// to ERR_PACKAGE_PATH_NOT_EXPORTED and the manager falls back to the bare name
// with no description — which is what a plugin without these files looks like
// in the plugin list. See @deepseek-ai/dsh-app-boot readPluginMeta.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  icon?: string
  exports?: Record<string, unknown>
  files?: string[]
}

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

test('package.json exports the resources the plugin manager reads', () => {
  const exports = pkg.exports ?? {}
  assert.ok(Object.hasOwn(exports, './package.json'), 'exports must contain "./package.json"')
  assert.ok(Object.hasOwn(exports, './locale/*.json'), 'exports must contain "./locale/*.json"')
  assert.equal(pkg.icon, 'icon.svg', 'package.json must declare a relative icon path')
  for (const file of ['locale', 'icon.svg']) {
    assert.ok((pkg.files ?? []).includes(file), `files must ship ${file}`)
  }
})

test('locale dictionaries carry a title and a description in every language', () => {
  const english = new URL('../locale/en.json', import.meta.url)
  assert.ok(existsSync(english), 'locale/en.json must exist; it is the resource that proves a locale directory')
  const dir = new URL('../locale/', import.meta.url)
  const files = readdirSync(dir)
  for (const language of ['en', 'zh']) {
    assert.ok(files.includes(`${language}.json`), `locale/${language}.json must exist`)
    assert.ok(LANGUAGE_ID.test(language))
    const meta = (JSON.parse(readFileSync(new URL(`${language}.json`, dir), 'utf8')) as { meta?: Record<string, unknown> }).meta
    assert.ok(meta !== undefined, `locale/${language}.json needs a meta object`)
    assert.ok(text(meta.title) !== undefined, `locale/${language}.json needs meta.title`)
    assert.ok(text(meta.description) !== undefined, `locale/${language}.json needs meta.description`)
  }
})

test('the icon is a small image the plugin manager accepts', () => {
  const icon = new URL(`../${pkg.icon ?? 'icon.svg'}`, import.meta.url)
  assert.ok(existsSync(icon), 'icon.svg must exist')
  assert.ok(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(icon.pathname.slice(icon.pathname.lastIndexOf('.'))))
  assert.ok(statSync(icon).size <= 256 * 1024, 'the plugin manager rejects icons over 256 KiB')
})
