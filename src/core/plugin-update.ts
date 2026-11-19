/**
 * Updating every installed plugin that has a newer version.
 *
 * The page's "更新 DSH 插件" button means one thing: look at everything this
 * profile installed, ask each registry package what it offers, and install the
 * newest version that can replace what is running (declares a bundle, accepts
 * this DSH version, is not a prerelease and not deprecated). Official bundles
 * follow the DSH version and are never touched; a package installed from a Git
 * commit has no version list and is left alone.
 *
 * Nothing here imports DSH: the manager is a small structural interface, so
 * this file stays testable without a Host and a fake manager stands in for the
 * real plugin manager.
 */

/** One published version, as the host's version list describes it. */
export interface PluginVersionLike {
  version: string
  /** Whether the version declares a `dsh.bundle`; one that does not cannot replace a bundle. */
  bundle: boolean
  prerelease: boolean
  deprecated?: string
  /** Present when the version rejects the running DSH version. */
  incompatible?: unknown
}

/** What asking a registry for a package's newer versions answered. */
export type PluginVersionListLike =
  | { status: 'listed'; installed: string; registry: string; versions: readonly PluginVersionLike[] }
  | { status: 'refused'; problem: string; reason: string }

/** One installed (or shipped) bundle, as the host lists it. */
export interface PluginBundleLike {
  name: string
  installed: boolean
  official: boolean
  /** `installation` (ships with DSH), `profile` (this profile installed it), `missing`. */
  availability: string
  /** How the host replaces it: `registry` for a registry dependency, `git` for a pinned commit. */
  update?: 'registry' | 'git'
  version?: string
  readOnlyReason?: string
}

/** What one update answered; only the fields this page reads. */
export interface PluginUpdateAnswer {
  result?: {
    application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
    error?: { code?: string; diagnostic?: string }
  }
}

/** The slice of DSH's `pluginManager` service this uses. */
export interface PluginManagerLike {
  listBundles(): Promise<readonly PluginBundleLike[]>
  listVersions(name: string): Promise<PluginVersionListLike>
  updateBundle(name: string, version: string, options?: { registry?: string }): Promise<PluginUpdateAnswer | unknown>
}

/** Why one package was left out of a run. */
export type PluginSkip = 'official' | 'not-installed' | 'no-registry-update' | 'read-only' | 'git' | 'version-list-refused' | 'up-to-date' | 'no-installable-version'

/** What a run has done so far, from its first click to its settle. */
export interface PluginUpdateState {
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  /** How many packages the run will touch, known once the versions are read. */
  total: number
  /** The package being installed right now. */
  current: string | null
  updated: Array<{ name: string; from: string; to: string }>
  failed: Array<{ name: string; error: string }>
  skipped: Array<{ name: string; why: PluginSkip }>
  /** Whether at least one change waits for DSH to start again. */
  restartNeeded: boolean
  /** A sentence when the run could not even start (no manager, listing failed). */
  error: string | null
}

const EMPTY: PluginUpdateState = {
  running: false, startedAt: null, finishedAt: null, total: 0, current: null,
  updated: [], failed: [], skipped: [], restartNeeded: false, error: null,
}

/**
 * The version to install: the newest one, as the list is newest first, that
 * declares a bundle, accepts this DSH, and is neither a prerelease nor deprecated.
 * @param versions - the host's listed versions, newest first.
 * @returns the chosen version, if any qualifies.
 */
export function pickUpdateVersion(versions: readonly PluginVersionLike[]): PluginVersionLike | undefined {
  return versions.find(v => v.bundle && v.incompatible === undefined && !v.prerelease && v.deprecated === undefined)
}

/** Whether this bundle is one the run may replace, and why not when it is not. */
export function bundleEligibility(bundle: PluginBundleLike): PluginSkip | null {
  if (!bundle.installed) return 'not-installed'
  if (bundle.official) return 'official'
  if (bundle.availability !== 'profile') return 'not-installed'
  if (bundle.readOnlyReason !== undefined) return 'read-only'
  if (bundle.update === 'git') return 'git'
  if (bundle.update !== 'registry') return 'no-registry-update'
  return null
}

/**
 * Updates one plugin at a time, remembering what happened so the page can show
 * progress instead of waiting on a request that takes minutes.
 */
export class PluginUpdater {
  private manager: PluginManagerLike
  private clock: () => number
  /** This plugin's own package name: it goes last, so a self-update cannot cut the run short. */
  private selfName: string
  private state: PluginUpdateState = EMPTY
  private run: Promise<void> | undefined

  constructor(manager: PluginManagerLike, clock: () => number = Date.now, selfName = 'dsh-mishu') {
    this.manager = manager
    this.clock = clock
    this.selfName = selfName
  }

  /** The current or last run. */
  report(): PluginUpdateState {
    return this.state
  }

  /**
   * Start a run, or answer the one in flight. Resolves when the run settles,
   * so tests can await it; the page only ever reads `report()`.
   */
  start(): Promise<void> {
    // A run that throws would otherwise leave `running` true for ever and be an unhandled rejection.
    this.run ??= this.loop().catch((error: unknown) => {
      this.state = { ...this.state, running: false, current: null, finishedAt: this.clock(), error: messageOf(error) }
    }).finally(() => { this.run = undefined })
    return this.run
  }

  private async loop(): Promise<void> {
    const startedAt = this.clock()
    this.state = { ...EMPTY, running: true, startedAt }
    let bundles: readonly PluginBundleLike[]
    try {
      bundles = await this.manager.listBundles()
    } catch (error) {
      this.state = { ...this.state, running: false, finishedAt: this.clock(), error: messageOf(error) }
      return
    }
    const targets: Array<{ name: string; from: string; to: string; registry: string }> = []
    const skipped: PluginUpdateState['skipped'] = []
    for (const bundle of bundles) {
      const why = bundleEligibility(bundle)
      if (why !== null) {
        skipped.push({ name: bundle.name, why })
        continue
      }
      let list: PluginVersionListLike
      try {
        list = await this.manager.listVersions(bundle.name)
      } catch {
        skipped.push({ name: bundle.name, why: 'version-list-refused' })
        continue
      }
      if (list.status !== 'listed') {
        skipped.push({ name: bundle.name, why: 'version-list-refused' })
        continue
      }
      const pick = pickUpdateVersion(list.versions)
      if (pick === undefined) {
        skipped.push({ name: bundle.name, why: list.versions.length === 0 ? 'up-to-date' : 'no-installable-version' })
        continue
      }
      targets.push({ name: bundle.name, from: list.installed, to: pick.version, registry: list.registry })
    }
    // Updating this plugin replaces the code running the run: everything else goes first.
    targets.sort((a, b) => Number(a.name === this.selfName) - Number(b.name === this.selfName))
    this.state = { ...this.state, total: targets.length, skipped }
    for (const target of targets) {
      this.state = { ...this.state, current: target.name }
      try {
        const answer = await this.manager.updateBundle(target.name, target.to, { registry: target.registry }) as PluginUpdateAnswer | undefined
        const application = answer?.result?.application
        if (application === 'failed' || application === 'cancelled' || answer?.result?.error !== undefined) {
          this.state = {
            ...this.state,
            failed: [...this.state.failed, { name: target.name, error: answer?.result?.error?.diagnostic ?? answer?.result?.error?.code ?? application ?? 'failed' }],
          }
        } else {
          this.state = {
            ...this.state,
            updated: [...this.state.updated, { name: target.name, from: target.from, to: target.to }],
            restartNeeded: this.state.restartNeeded || application === 'restart-required',
          }
        }
      } catch (error) {
        this.state = { ...this.state, failed: [...this.state.failed, { name: target.name, error: messageOf(error) }] }
      }
    }
    this.state = { ...this.state, running: false, current: null, finishedAt: this.clock() }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
