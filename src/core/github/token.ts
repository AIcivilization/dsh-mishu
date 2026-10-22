/**
 * Where the GitHub token comes from, in this order:
 *
 *   1. the environment variable named in the config (GITHUB_TOKEN)
 *   2. a token you pasted on the settings page, kept in the system keychain
 *   3. the GitHub CLI (`gh auth token`), which keeps its own in the keychain
 *
 * A token is never written to the notebook or a file.
 */

import { findProgram, runProgram } from '../exec.ts'
import { bi, MishuError, type Bi } from '../i18n.ts'
import type { SecretStore } from '../secrets.ts'
import { GitHubClient, GitHubError, type FetchLike } from './client.ts'

/** The keychain entry for a token pasted on the settings page. */
export const GITHUB_SECRET = 'github'

/** Opens GitHub's "new classic token" page with the two scopes ticked. */
export const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=notifications,repo&description=DSH%20mishu'

export type TokenSource = 'env' | 'keychain' | 'gh'

export type TokenResult = { token: string; from: TokenSource } | { error: Bi }

/** `ghPath` is for tests: a fixed path, or `null` for "not installed". */
export async function resolveGithubToken(options: { envName: string; useGhCli: boolean; secrets?: SecretStore; ghPath?: string | null }): Promise<TokenResult> {
  const { envName, useGhCli, secrets } = options
  const fromEnv = envName === '' ? undefined : process.env[envName]?.trim()
  if (fromEnv) return { token: fromEnv, from: 'env' }
  const stored = await secrets?.get(GITHUB_SECRET).catch(() => undefined)
  if (stored) return { token: stored, from: 'keychain' }

  const none = bi(
    envName === '' ? '没有 GitHub token' : `没有 GitHub token（环境变量 ${envName} 是空的，钥匙串里也没有存）`,
    envName === '' ? 'no GitHub token' : `no GitHub token (environment variable ${envName} is empty and none is saved in the keychain)`,
  )
  const paste = bi('在小秘书的设置页填一个 token', 'paste a token on the secretary\'s settings page')
  if (!useGhCli) return { error: bi(`${none.zh}。${paste.zh}。`, `${none.en}. ${cap(paste.en)}.`) }

  const gh = options.ghPath === undefined ? findProgram('gh') : options.ghPath ?? undefined
  if (gh === undefined) {
    return {
      error: bi(
        `${none.zh}，这台电脑上也没找到 GitHub CLI（gh）。${paste.zh}，或者装上 gh 后运行 gh auth login。`,
        `${none.en}, and the GitHub CLI (gh) is not installed on this computer. ${cap(paste.en)}, or install gh and run gh auth login.`,
      ),
    }
  }
  const r = await runProgram(gh, ['auth', 'token'], undefined, 5000)
  const token = r.stdout.trim()
  if (r.code === 0 && token !== '') return { token, from: 'gh' }
  const why = (r.stderr.trim() || r.failure || `exit ${r.code}`).split('\n')[0]!.slice(0, 200)
  return {
    error: bi(
      `${none.zh}，gh 也没给出 token（${why}）。运行 gh auth login 登录，或者${paste.zh}。`,
      `${none.en}, and gh gave no token (${why}). Run gh auth login, or ${paste.en}.`,
    ),
  }
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Check a pasted token with GitHub, then keep it in the keychain. It must
 * read notifications, which only classic tokens with the `notifications`
 * scope can (fine-grained tokens cannot reach that API).
 */
export async function saveGithubToken(secrets: SecretStore, raw: string, fetch?: FetchLike): Promise<{ login: string }> {
  const token = raw.trim()
  if (!/^[\w-]{20,255}$/.test(token)) {
    throw new MishuError(bi('这不像 GitHub token：应该是一串没有空格的字母数字，classic token 以 ghp_ 开头', 'That does not look like a GitHub token: it should be letters and digits without spaces; classic tokens start with ghp_'))
  }
  const status = await secrets.status()
  if (!status.available) throw new MishuError(bi(`没法保存：${status.why.zh}`, `Cannot save it: ${status.why.en}`))
  const gh = new GitHubClient({ token, ...fetch === undefined ? {} : { fetch } })
  let login: string
  try {
    login = (await gh.user()).login
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) throw new MishuError(bi('GitHub 不认这个 token（可能填错了、过期了或被撤销了）', 'GitHub does not accept this token (mistyped, expired or revoked)'))
    throw error
  }
  if (!await gh.canReadNotifications()) {
    throw new MishuError(bi(
      `这个 token 属于 ${login}，但读不了通知。GitHub 的通知接口只认 classic token：生成时勾选 notifications（要看私有仓库再勾 repo）。`,
      `This token belongs to ${login} but cannot read notifications. GitHub's notifications API only takes classic tokens: tick notifications when you create it (and repo for private repositories).`,
    ))
  }
  await secrets.set(GITHUB_SECRET, token)
  return { login }
}

export async function deleteGithubToken(secrets: SecretStore): Promise<void> {
  await secrets.delete(GITHUB_SECRET)
}
