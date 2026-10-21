/**
 * The few GitHub REST calls the secretary needs, over plain `fetch`.
 *
 * Every call is a GET except `markThreadRead`, which only runs when you have
 * turned on marking read for a rule. `fetch` is injectable so tests replay
 * recorded responses and never touch the network.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export class GitHubError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string, message: string) {
    super(`GitHub ${status}: ${message} (${url})`)
    this.status = status
    this.url = url
  }
}

export interface Notification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  last_read_at: string | null
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string }
  repository: { full_name: string; html_url: string; fork: boolean }
}

export interface RepoInfo {
  full_name: string
  fork: boolean
  default_branch: string
  html_url: string
  parent?: { full_name: string; default_branch: string; owner: { login: string } }
  owner: { login: string }
}

export interface PullInfo {
  state: 'open' | 'closed'
  merged: boolean
  merged_at: string | null
  html_url: string
  number: number
  closed_at?: string | null
  draft?: boolean
  user?: { login: string } | null
  changed_files?: number
  additions?: number
  deletions?: number
}

export interface IssueInfo {
  state: 'open' | 'closed'
  state_reason?: string | null
  html_url: string
  number: number
  closed_at?: string | null
  user?: { login: string } | null
}

export interface JobInfo {
  name: string
  conclusion: string | null
  html_url: string
  steps?: Array<{ name: string; conclusion: string | null; number: number }>
}

export interface WorkflowRun {
  id: number
  name: string
  head_branch: string | null
  status: string
  conclusion: string | null
  created_at: string
  html_url: string
  event: string
}

export interface CommitInfo {
  html_url: string
  sha: string
}

export interface CommentInfo {
  body: string
  html_url: string
  created_at: string
  user: { login: string; type: string } | null
}

const API = 'https://api.github.com'

function nextLink(link: string | null): string | undefined {
  if (link === null) return undefined
  for (const part of link.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match !== null) return match[1]
  }
  return undefined
}

export class GitHubClient {
  private readonly token: string
  private readonly fetch: FetchLike
  /** Every request made, for the sync report ("used N API calls"). */
  calls = 0

  constructor(options: { token: string; fetch?: FetchLike }) {
    this.token = options.token
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  }

  private async raw(method: string, url: string): Promise<{ status: number; body: unknown; link: string | null }> {
    this.calls++
    const response = await this.fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'dsh-mishu',
      },
    })
    const text = await response.text()
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body, link: response.headers.get('link') }
  }

  private async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`
    const { status, body } = await this.raw('GET', url)
    if (status < 200 || status >= 300) throw new GitHubError(status, url, (body as { message?: string } | undefined)?.message ?? 'request failed')
    return body as T
  }

  /** GET that answers `undefined` on 404 instead of throwing. */
  private async find<T>(path: string): Promise<T | undefined> {
    const url = `${API}${path}`
    const { status, body } = await this.raw('GET', url)
    if (status === 404) return undefined
    if (status < 200 || status >= 300) throw new GitHubError(status, url, (body as { message?: string } | undefined)?.message ?? 'request failed')
    return body as T
  }

  /** All unread notification threads (GET never marks anything read). */
  async notifications(): Promise<Notification[]> {
    const all: Notification[] = []
    let url: string | undefined = `${API}/notifications?per_page=50`
    while (url !== undefined) {
      const { status, body, link } = await this.raw('GET', url)
      if (status < 200 || status >= 300) throw new GitHubError(status, url, (body as { message?: string } | undefined)?.message ?? 'request failed')
      all.push(...body as Notification[])
      url = nextLink(link)
    }
    return all
  }

  /** Who the token belongs to, for the settings page's connection test. */
  user(): Promise<{ login: string }> {
    return this.get('/user')
  }

  repo(fullName: string): Promise<RepoInfo> {
    return this.get(`/repos/${fullName}`)
  }

  pull(apiUrl: string): Promise<PullInfo> {
    return this.get(apiUrl)
  }

  issue(apiUrl: string): Promise<IssueInfo> {
    return this.get(apiUrl)
  }

  commit(apiUrl: string): Promise<CommitInfo> {
    return this.get(apiUrl)
  }

  /** The most recent workflow runs of a repo (one page, newest first). */
  async runs(fullName: string, perPage = 100): Promise<WorkflowRun[]> {
    const body = await this.get<{ workflow_runs: WorkflowRun[] }>(`/repos/${fullName}/actions/runs?per_page=${perPage}`)
    return body.workflow_runs
  }

  run(fullName: string, id: number): Promise<WorkflowRun> {
    return this.get(`/repos/${fullName}/actions/runs/${id}`)
  }

  comment(apiUrl: string): Promise<CommentInfo> {
    return this.get(apiUrl)
  }

  /** Jobs of one run, to say which step failed. */
  async jobs(fullName: string, runId: number): Promise<JobInfo[]> {
    const body = await this.get<{ jobs: JobInfo[] }>(`/repos/${fullName}/actions/runs/${runId}/jobs?per_page=50`)
    return body.jobs
  }

  /** Commits the fork has that its parent does not. */
  async aheadOfParent(repo: RepoInfo): Promise<number> {
    if (repo.parent === undefined) return 0
    const base = `${repo.parent.owner.login}:${repo.parent.default_branch}`
    const body = await this.get<{ ahead_by: number }>(
      `/repos/${repo.full_name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(repo.default_branch)}`,
    )
    return body.ahead_by
  }

  async branchExists(fullName: string, branch: string): Promise<boolean> {
    return (await this.find(`/repos/${fullName}/branches/${encodeURIComponent(branch)}`)) !== undefined
  }

  async tagExists(fullName: string, tag: string): Promise<boolean> {
    return (await this.find(`/repos/${fullName}/git/ref/tags/${encodeURIComponent(tag)}`)) !== undefined
  }

  /** Mark one thread read on GitHub. The only write; reversible on github.com. */
  async markThreadRead(threadId: string): Promise<void> {
    const url = `${API}/notifications/threads/${threadId}`
    const { status, body } = await this.raw('PATCH', url)
    if (status !== 205 && status !== 304 && (status < 200 || status >= 300)) {
      throw new GitHubError(status, url, (body as { message?: string } | undefined)?.message ?? 'mark read failed')
    }
  }
}
