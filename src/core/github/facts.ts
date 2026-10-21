/**
 * Look up the current state behind a notification.
 *
 * A notification says "something happened"; whether you still need to act
 * depends on what is true now: is the PR merged, did the next run pass, does
 * the branch still exist. This module gathers those facts; `rules.ts` decides.
 * Lookups are memoized per sync, so fifty CI notifications on one repo cost
 * one runs request, not fifty.
 */

import type { CommentInfo, GitHubClient, Notification, PullInfo, IssueInfo, RepoInfo, WorkflowRun } from './client.ts'

export interface RunFact {
  id: number
  ref: string | null
  conclusion: string | null
  at: number
  url: string
}

export interface CiFacts {
  workflow: string
  ref: string
  /** When the failure happened (the notification or the failing run). */
  failedAt: number
  /** Newest completed run of this workflow on the same ref. */
  latestSameRef?: RunFact
  /** Newest completed run of this workflow on another ref after that; the default branch is preferred. */
  newerElsewhere?: RunFact
  /** Whether the ref still exists as a branch or tag; only looked up when nothing newer passed. */
  refExists?: boolean
  /** Failed runs of this workflow on this ref in the last 7 days. */
  recentFailures: number
  /** Failed runs of any workflow in this repo in the last 7 days. */
  repoFailures: number
  /** Workflows in this repo that failed in the last 7 days. */
  failingWorkflows: string[]
  /** Newest successful run of this workflow on the same ref. */
  lastSuccess?: RunFact
  /** Completed runs of this workflow on this ref in the history we can see. */
  runsSeen: number
  /** Where the latest run failed, when it still fails. */
  failure?: { job: string; step: string | null; url: string }
}

/** The latest comment on a thread, shortened for a card. */
export interface CommentFact {
  author: string
  bot: boolean
  url: string
  at: number
  /** First line or two, at most 160 characters. */
  excerpt: string
}

export interface Facts {
  repo?: {
    fullName: string
    fork: boolean
    parent?: string
    defaultBranch: string
    /** Commits the fork has that its parent lacks; only for forks. */
    ahead?: number
  }
  pull?: PullInfo
  issue?: IssueInfo
  ci?: CiFacts
  comment?: CommentFact
  /** Commit SHA for commit notifications. */
  sha?: string
  /** A lookup failed; the rules hand the notification to you instead of guessing. */
  error?: string
}

/** "Nightly report workflow run failed for main branch" → workflow, outcome, ref. */
export function parseCheckSuiteTitle(title: string): { workflow: string; outcome: string; ref: string } | undefined {
  const match = /^(.+) workflow run (.+?) for (.+) branch$/.exec(title.trim())
  if (match === null) return undefined
  return { workflow: match[1]!, outcome: match[2]!, ref: match[3]! }
}

/** `…/actions/runs/123` inside a comment body. */
export function findRunLink(body: string): { repo: string; id: number } | undefined {
  const match = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/.exec(body)
  return match === null ? undefined : { repo: match[1]!, id: Number(match[2]) }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Refs that look like release tags (v2.3.0, 1.0.1). */
export const VERSION_REF = /^v?\d+(\.\d+)+$/

function toRun(run: WorkflowRun): RunFact {
  return { id: run.id, ref: run.head_branch, conclusion: run.conclusion, at: Date.parse(run.created_at), url: run.html_url }
}

/** Memoized lookups shared by one sync. */
export class Lookups {
  private readonly cache = new Map<string, Promise<unknown>>()
  readonly gh: GitHubClient

  constructor(gh: GitHubClient) {
    this.gh = gh
  }

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined
    if (hit === undefined) {
      hit = load()
      this.cache.set(key, hit)
    }
    return hit
  }

  repo(name: string) { return this.memo(`repo:${name}`, () => this.gh.repo(name)) }
  runs(name: string) { return this.memo(`runs:${name}`, () => this.gh.runs(name)) }
  ahead(repo: RepoInfo) { return this.memo(`ahead:${repo.full_name}`, () => this.gh.aheadOfParent(repo)) }
  pull(url: string) { return this.memo(`pull:${url}`, () => this.gh.pull(url)) }
  issue(url: string) { return this.memo(`issue:${url}`, () => this.gh.issue(url)) }
  commit(url: string) { return this.memo(`commit:${url}`, () => this.gh.commit(url)) }
  comment(url: string) { return this.memo(`comment:${url}`, () => this.gh.comment(url)) }
  run(name: string, id: number) { return this.memo(`run:${name}:${id}`, () => this.gh.run(name, id)) }
  jobs(name: string, runId: number) { return this.memo(`jobs:${name}:${runId}`, () => this.gh.jobs(name, runId)) }
  refExists(name: string, ref: string) {
    return this.memo(`ref:${name}:${ref}`, async () => (await this.gh.branchExists(name, ref)) || this.gh.tagExists(name, ref))
  }
}

async function repoFacts(lookups: Lookups, name: string): Promise<NonNullable<Facts['repo']>> {
  const repo = await lookups.repo(name)
  return {
    fullName: repo.full_name,
    fork: repo.fork,
    defaultBranch: repo.default_branch,
    ...repo.parent === undefined ? {} : { parent: repo.parent.full_name },
    ...repo.fork ? { ahead: await lookups.ahead(repo) } : {},
  }
}

async function ciFacts(
  lookups: Lookups, repoName: string, defaultBranch: string, workflow: string, ref: string, failedAt: number, now: number,
): Promise<CiFacts> {
  const all = await lookups.runs(repoName)
  const repoFailures = all.filter(r => r.conclusion === 'failure' && now - Date.parse(r.created_at) <= WEEK_MS).length
  const runs = all.filter(r => r.name === workflow && r.status === 'completed').map(toRun)
  runs.sort((a, b) => b.at - a.at)
  const latestSameRef = runs.find(r => r.ref === ref)
  const pivot = latestSameRef?.at ?? failedAt
  const newer = runs.filter(r => r.ref !== ref && r.at > pivot)
  const newerElsewhere = newer.find(r => r.ref === defaultBranch) ?? newer[0]
  const recentFailures = runs.filter(r => r.ref === ref && r.conclusion === 'failure' && now - r.at <= WEEK_MS).length
  const failingWorkflows = [...new Set(all.filter(r => r.conclusion === 'failure' && now - Date.parse(r.created_at) <= WEEK_MS).map(r => r.name))].sort()
  const sameRef = runs.filter(r => r.ref === ref)
  const lastSuccess = sameRef.find(r => r.conclusion === 'success')
  const facts: CiFacts = {
    workflow, ref, failedAt, recentFailures, repoFailures, failingWorkflows, runsSeen: sameRef.length,
    ...latestSameRef === undefined ? {} : { latestSameRef },
    ...newerElsewhere === undefined ? {} : { newerElsewhere },
    ...lastSuccess === undefined ? {} : { lastSuccess },
  }
  // A release tag can be superseded by later green runs; a branch has to pass on its own or be gone.
  if (latestSameRef?.conclusion !== 'success' && ref !== defaultBranch && !VERSION_REF.test(ref)) {
    facts.refExists = await lookups.refExists(repoName, ref)
  }
  // Still failing: say which job and step, so the card can point at the problem.
  const superseded = VERSION_REF.test(ref) && newerElsewhere?.conclusion === 'success'
  if (latestSameRef?.conclusion === 'failure' && !superseded && facts.refExists !== false) {
    const jobs = await lookups.jobs(repoName, latestSameRef.id)
    const job = jobs.find(j => j.conclusion === 'failure')
    if (job !== undefined) {
      const step = job.steps?.find(s => s.conclusion === 'failure')
      facts.failure = { job: job.name, step: step?.name ?? null, url: job.html_url }
    }
  }
  return facts
}

function commentFact(comment: CommentInfo): CommentFact {
  const author = comment.user?.login ?? '?'
  // Plain words only: no HTML, no Markdown markers, no heading or quote prefixes.
  const text = comment.body.replace(/<[^>]+>/g, ' ').replace(/[*_`~]+/g, '').replace(/^\s*[#>]+\s*/gm, '').replace(/\s+/g, ' ').trim()
  return {
    author,
    bot: comment.user?.type === 'Bot' || author.endsWith('[bot]'),
    url: comment.html_url,
    at: Date.parse(comment.created_at),
    excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text,
  }
}

/** The latest comment, when the thread has one (GitHub points at the thread itself when it does not). */
async function latestComment(n: Notification, lookups: Lookups): Promise<CommentFact | undefined> {
  const url = n.subject.latest_comment_url
  if (url === null || url === n.subject.url) return undefined
  return commentFact(await lookups.comment(url))
}

/** Everything the rules need to judge one notification. Never throws: a failed lookup becomes `error`. */
export async function gatherFacts(n: Notification, lookups: Lookups, now: number): Promise<Facts> {
  const name = n.repository.full_name
  const updatedAt = Date.parse(n.updated_at)
  try {
    switch (n.subject.type) {
      case 'PullRequest': {
        if (n.subject.url === null) return {}
        const pull = await lookups.pull(n.subject.url)
        const comment = pull.state === 'open' ? await latestComment(n, lookups) : undefined
        return { pull, ...comment === undefined ? {} : { comment } }
      }
      case 'Issue': {
        if (n.subject.url === null) return {}
        const issue = await lookups.issue(n.subject.url)
        const comment = issue.state === 'open' ? await latestComment(n, lookups) : undefined
        return { issue, ...comment === undefined ? {} : { comment } }
      }
      case 'CheckSuite': {
        const repo = await repoFacts(lookups, name)
        const parsed = parseCheckSuiteTitle(n.subject.title)
        if (parsed === undefined) return { repo }
        return { repo, ci: await ciFacts(lookups, name, repo.defaultBranch, parsed.workflow, parsed.ref, updatedAt, now) }
      }
      case 'Commit': {
        const facts: Facts = {}
        if (n.subject.url !== null) facts.sha = (await lookups.commit(n.subject.url)).sha
        if (n.subject.latest_comment_url === null) return facts
        const comment = await lookups.comment(n.subject.latest_comment_url)
        facts.comment = commentFact(comment)
        const link = facts.comment.bot ? findRunLink(comment.body) : undefined
        if (link !== undefined && link.repo === name) {
          const run = await lookups.run(name, link.id)
          const repo = await repoFacts(lookups, name)
          facts.repo = repo
          if (run.head_branch !== null) {
            facts.ci = await ciFacts(lookups, name, repo.defaultBranch, run.name, run.head_branch, Date.parse(run.created_at), now)
          }
        }
        return facts
      }
      default:
        return {}
    }
  } catch (error) {
    return { error: (error as Error).message }
  }
}
