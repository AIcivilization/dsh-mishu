/**
 * DSH's own plugin manager, reached as a service.
 *
 * The page's "更新 DSH 插件" button does not shell out to `dsh plugin`: it asks
 * the running Host's `pluginManager` service, which is the same path DSH's own
 * plugin page takes — it holds the profile lock, rolls a failed install back,
 * and knows which versions accept this DSH version. A Host without that
 * service (an older DSH) simply has no updater, and the button says so.
 */

import { PluginUpdater, type PluginManagerLike } from '../core/plugin-update.ts'

interface ServiceScope {
  pluginManager?: unknown
  get?: (name: string) => unknown
}

interface InjectingCtx extends ServiceScope {
  inject(names: string[], run: (scope: ServiceScope) => void): void
  effect(fn: () => () => void, label?: string): void
}

/** Read the shape of the service we use, refusing anything that does not answer to it. */
export function asPluginManager(value: unknown): PluginManagerLike | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof PluginManagerLike, unknown>>
  if (typeof candidate.listBundles !== 'function') return undefined
  if (typeof candidate.listVersions !== 'function') return undefined
  if (typeof candidate.updateBundle !== 'function') return undefined
  return value as PluginManagerLike
}

/**
 * Hand `attach` an updater once the plugin manager exists, and `undefined` when
 * the plugin stops. A Host that never offers the service leaves the page
 * without a button, which is the truthful answer.
 * @returns Nothing; the shell ties the lifetime to its own context.
 */
export function watchPluginManager(
  ctx: InjectingCtx,
  attach: (updater: PluginUpdater | undefined) => void,
  clock: () => number = Date.now,
): void {
  ctx.effect(() => () => { attach(undefined) }, 'dsh-mishu: plugin manager lifetime')
  ctx.inject(['pluginManager'], (scope) => {
    const manager = asPluginManager(scope.pluginManager ?? (typeof scope.get === 'function' ? scope.get('pluginManager') : undefined))
    if (manager === undefined) return
    attach(new PluginUpdater(manager, clock))
  })
}
