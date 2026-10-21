/**
 * dsh-mishu — DSH 小秘书.
 *
 * Watches GitHub notifications and the things you tell it, closes what the
 * facts show is already resolved, and keeps a short list of what needs you.
 * The core (`src/core`) never imports DSH; this entry exposes the plugin shell.
 */

export const name = 'dsh-mishu'

export const usage = `DSH 小秘书: triages GitHub notifications against their current state (merged, recovered, superseded…) and remembers dated things you tell it (bills, renewals, documents, birthdays). /mishu shows the brief.`

export { Config, type MishuConfig } from './dsh/config.ts'
export { apply } from './dsh/plugin.ts'
