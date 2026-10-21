/**
 * Rules: from a notification plus the current facts to a verdict.
 *
 * Pure and deterministic. Every verdict carries a reason code, and an
 * explanation a person can act on: what this is, where the problem is (or,
 * for a closed item, why it is closed), and what to do about it. Notification
 * text never triggers an action; only verified state does. Everything the
 * secretary writes comes in both languages and is stored that way.
 */

import { bi, type Bi } from '../i18n.ts'
import { shortDay } from '../time.ts'
import type { Notification } from './client.ts'
import { VERSION_REF, type CiFacts, type CommentFact, type Facts } from './facts.ts'

/** What a card says: what this is, why it is here (or why it was closed), and what to do. */
export interface Explain {
  what: Bi
  why: Bi
  /** The next step; `null` when nothing is left to do. */
  fix: Bi | null
  /** The one link worth opening, with a label saying what it opens. */
  link?: { label: Bi; url: string }
}

export interface Verdict {
  /** Matters with the same key are one thing to handle (fifty CI notices, one fork). */
  matterKey: string
  kind: string
  /** Source text (a PR title) stays a string; text the secretary writes is bilingual. */
  title: Bi | string
  url: string | null
  status: 'open' | 'done'
  reason: string
  note: Bi | null
  explain: Explain
}

/** Reasons that close a matter because the facts show nothing is left to do. */
export const CLOSING_REASONS = ['merged', 'closed', 'recovered', 'superseded', 'ref-gone', 'info-release'] as const

const ago = (ms: number) => shortDay(ms)
const quote = (c: CommentFact) => bi(`${c.author}（${shortDay(c.at)}）：「${c.excerpt}」`, `${c.author} (${shortDay(c.at)}): "${c.excerpt}"`)

/**
 * Only a release tag is "superseded": tags are never re-run, so a newer green
 * run on the default branch or a newer tag is the fix. A branch has to pass on
 * its own (`recovered`) or be deleted (`ref-gone`).
 */
function supersedes(ci: CiFacts, defaultBranch: string): boolean {
  const newer = ci.newerElsewhere
  if (newer === undefined || newer.conclusion !== 'success' || !VERSION_REF.test(ci.ref)) return false
  return newer.ref === defaultBranch || (newer.ref !== null && VERSION_REF.test(newer.ref))
}

function where(ci: CiFacts): Bi | undefined {
  const f = ci.failure
  if (f === undefined) return undefined
  return f.step === null
    ? bi(`失败在 job「${f.job}」`, `it fails in job "${f.job}"`)
    : bi(`失败在 job「${f.job}」的「${f.step}」这一步`, `it fails in job "${f.job}", step "${f.step}"`)
}

function ciVerdict(repo: string, defaultBranch: string, ci: CiFacts, base: Pick<Verdict, 'matterKey' | 'kind' | 'title'>): Verdict {
  const what = bi(`${repo} 的「${ci.workflow}」工作流，在 ${ci.ref} 上`, `The "${ci.workflow}" workflow of ${repo}, on ${ci.ref}`)
  if (ci.latestSameRef?.conclusion === 'success') {
    const day = ago(ci.latestSameRef.at)
    return {
      ...base, url: ci.latestSameRef.url, status: 'done', reason: 'recovered',
      note: bi(`${ci.ref} 上 ${day} 那次已经通过`, `passed on ${ci.ref} on ${day}`),
      explain: {
        what,
        why: bi(`之前失败过，但 ${ci.ref} 上 ${day} 那次运行已经通过，问题已经不在了。`, `It failed before, but the run on ${ci.ref} on ${day} passed, so the problem is gone.`),
        fix: null,
        link: { label: bi('看通过的那次运行', 'See the passing run'), url: ci.latestSameRef.url },
      },
    }
  }
  if (supersedes(ci, defaultBranch)) {
    const newer = ci.newerElsewhere!
    const day = ago(newer.at)
    return {
      ...base, url: newer.url, status: 'done', reason: 'superseded',
      note: bi(`更新的 ${newer.ref} 在 ${day} 已经通过`, `newer ${newer.ref} passed on ${day}`),
      explain: {
        what,
        why: bi(
          `${ci.ref} 是旧版本的 tag，tag 不会再重跑；之后的 ${newer.ref} 在 ${day} 已经通过，说明问题在后来的版本里修好了。`,
          `${ci.ref} is an old release tag, and tags are never re-run; the later ${newer.ref} passed on ${day}, so the problem was fixed in a later version.`,
        ),
        fix: null,
        link: { label: bi('看后来通过的运行', 'See the later passing run'), url: newer.url },
      },
    }
  }
  if (ci.refExists === false) {
    return {
      ...base, url: null, status: 'done', reason: 'ref-gone',
      note: bi(`${ci.ref} 这个分支或 tag 已经删了`, `${ci.ref} (branch or tag) has been deleted`),
      explain: {
        what,
        why: bi(`失败的分支 ${ci.ref} 已经删掉了，这次失败不会再有后续。`, `The failing branch ${ci.ref} has been deleted, so this failure has no follow-up.`),
        fix: null,
      },
    }
  }

  const last = ci.latestSameRef === undefined ? undefined : ago(ci.latestSameRef.at)
  const many = ci.recentFailures > 1
  const step = where(ci)
  const since = ci.lastSuccess !== undefined
    ? bi(`上次成功是 ${ago(ci.lastSuccess.at)}。`, `It last passed on ${ago(ci.lastSuccess.at)}.`)
    : bi(`能看到的 ${ci.runsSeen} 次记录里一次都没成功过。`, `It has not passed in any of the ${ci.runsSeen} runs on record.`)
  const stale = ci.latestSameRef !== undefined && ci.recentFailures === 0
  const url = ci.failure?.url ?? ci.latestSameRef?.url ?? `https://github.com/${repo}/actions`
  return {
    ...base,
    url,
    status: 'open',
    reason: 'ci-failing',
    note: bi(
      `${ci.ref} 上最近一次${last === undefined ? '' : `（${last}）`}还是失败${many ? `，最近 7 天失败了 ${ci.recentFailures} 次` : ''}`,
      `latest run on ${ci.ref}${last === undefined ? '' : ` (${last})`} still fails${many ? `; ${ci.recentFailures} failures in the last 7 days` : ''}`,
    ),
    explain: {
      what,
      why: bi(
        `最近一次运行${last === undefined ? '' : `（${last}）`}失败了${step === undefined ? '' : `，${step.zh}`}。${many ? `最近 7 天失败了 ${ci.recentFailures} 次。` : ''}${since.zh}`,
        `The latest run${last === undefined ? '' : ` (${last})`} failed${step === undefined ? '' : `; ${step.en}`}.${many ? ` ${ci.recentFailures} failures in the last 7 days.` : ''} ${since.en}`,
      ),
      fix: stale
        ? bi(
            '这个仓库最近一周没有再跑过：如果还在维护，打开失败日志修好再推送，通过后这件事会自动关掉；如果不维护了，停用这个工作流或者归档仓库，然后点"忽略"。',
            'Nothing has run here for a week. If you still maintain it, open the failing log, fix it and push; it closes itself once a run passes. If not, disable the workflow or archive the repo, then dismiss this.',
          )
        : bi(
            '打开失败的日志看报错，修好后推送；下一次运行通过，这件事会自动关掉。',
            'Open the failing log, fix the error and push; once the next run passes, this closes itself.',
          ),
      link: { label: bi('看失败日志', 'Open the failing log'), url },
    },
  }
}

function numberFromUrl(url: string | null): string {
  return url === null ? '' : (/\/(\d+)$/.exec(url)?.[1] ?? '')
}

export function judge(n: Notification, facts: Facts): Verdict {
  const repo = n.repository.full_name
  const threadKey = `gh:thread:${n.id}`
  const plainTitle = `${repo} · ${n.subject.title}`

  if (facts.error !== undefined) {
    return {
      matterKey: threadKey, kind: 'other', title: plainTitle, url: n.repository.html_url,
      status: 'open', reason: 'check-failed', note: bi(`查当前状态时出错，先交给你看：${facts.error}`, `could not check the current state, handing it to you: ${facts.error}`),
      explain: {
        what: bi(`${repo} 的一条 ${n.subject.type} 通知：${n.subject.title}`, `A ${n.subject.type} notification from ${repo}: ${n.subject.title}`),
        why: bi(`小秘书去 GitHub 查它现在的状态时出错了（${facts.error}），没法判断，先交给你。`, `Checking its current state on GitHub failed (${facts.error}), so it is handed to you instead of guessed.`),
        fix: bi('下次同步会自动重试；一直出错的话，检查 GitHub token 能不能访问这个仓库。', 'The next sync retries by itself. If it keeps failing, check that your GitHub token can access this repo.'),
        link: { label: bi('打开仓库', 'Open the repo'), url: n.repository.html_url },
      },
    }
  }

  // A fork with no commits of its own only runs its parent's schedules: every
  // failure is noise, and together they are one thing to do.
  const forkRepo = facts.repo
  if ((n.subject.type === 'CheckSuite' || facts.ci !== undefined) && forkRepo?.fork === true && forkRepo.ahead === 0) {
    const count = facts.ci?.repoFailures ?? 0
    const workflows = facts.ci?.failingWorkflows ?? []
    const parent = forkRepo.parent
    const settings = `https://github.com/${repo}/settings/actions`
    const list = workflows.length === 0 ? undefined : workflows.join(' / ')
    return {
      matterKey: `gh:fork-actions:${repo}`,
      kind: 'fork-actions',
      title: bi(`关掉 fork ${repo} 的 Actions（或删掉这个 fork）`, `Turn off Actions on fork ${repo} (or delete the fork)`),
      url: settings,
      status: 'open',
      reason: 'fork-upstream-schedule',
      note: bi(
        `它是 ${parent ?? '上游'} 的 fork，没有自己的提交，跑的是上游的定时工作流，失败通知都是噪音${count > 0 ? `；最近 7 天失败了 ${count} 次` : ''}`,
        `it is a fork of ${parent ?? 'its parent'} with no commits of its own, running the parent's scheduled workflows; every failure notice is noise${count > 0 ? `; ${count} failures in the last 7 days` : ''}`,
      ),
      explain: {
        what: bi(`你的 fork ${repo}（来自 ${parent ?? '上游仓库'}）里的 GitHub Actions。`, `GitHub Actions in your fork ${repo} (from ${parent ?? 'its parent'}).`),
        why: bi(
          `这个 fork 没有你自己的提交，却一直在按计划跑上游的工作流${list === undefined ? '' : `（${list}）`}。这些工作流本来是给上游仓库用的，在 fork 里一直失败，每次都给你发通知${count > 0 ? `：最近 7 天失败了 ${count} 次` : ''}。每条单看都是噪音，合起来只有一件事要做。`,
          `The fork has no commits of yours, yet it keeps running the parent's scheduled workflows${list === undefined ? '' : ` (${list})`}. They are meant for the parent repo; in the fork they keep failing and notify you each time${count > 0 ? `: ${count} failures in the last 7 days` : ''}. Each notice is noise; together they are one thing to do.`,
        ),
        fix: bi(
          '打开仓库的 Settings → Actions → General，选「Disable actions」；如果这个 fork 已经不用了，直接删掉仓库更干净。做完后点"办完了"。',
          'Open the repo\'s Settings → Actions → General and choose "Disable actions". If you no longer need the fork, deleting it is cleaner. Then mark this done.',
        ),
        link: { label: bi('去关掉 Actions', 'Turn off Actions'), url: settings },
      },
    }
  }

  if (facts.ci !== undefined && facts.repo !== undefined) {
    const ci = facts.ci
    return ciVerdict(repo, facts.repo.defaultBranch, ci, {
      matterKey: `gh:ci:${repo}:${ci.workflow}@${ci.ref}`,
      kind: 'ci',
      title: bi(`${repo} · ${ci.workflow} 在 ${ci.ref} 上失败`, `${repo} · ${ci.workflow} failing on ${ci.ref}`),
    })
  }

  switch (n.subject.type) {
    case 'PullRequest': {
      const pull = facts.pull
      const number = pull?.number ?? numberFromUrl(n.subject.url)
      const url = pull?.html_url ?? null
      const base = { matterKey: `gh:pr:${repo}#${number}`, kind: 'pr', title: `${repo}#${number} ${n.subject.title}`, url }
      const author = pull?.user?.login
      const what = bi(
        `${repo} 的 PR #${number}「${n.subject.title}」${author === undefined ? '' : `，作者 ${author}`}`,
        `PR #${number} "${n.subject.title}" in ${repo}${author === undefined ? '' : ` by ${author}`}`,
      )
      const link = url === null ? undefined : { label: bi('打开 PR', 'Open the PR'), url }
      if (pull?.merged === true) {
        const day = ago(Date.parse(pull.merged_at!))
        return { ...base, status: 'done', reason: 'merged', note: bi(`已在 ${day} 合并`, `merged on ${day}`),
          explain: { what, why: bi(`这个 PR 已在 ${day} 合并，没有要你再做的了。`, `It was merged on ${day}; nothing is left for you.`), fix: null, ...link === undefined ? {} : { link } } }
      }
      if (pull?.state === 'closed') {
        return { ...base, status: 'done', reason: 'closed', note: bi('已关闭，没有合并', 'closed without merging'),
          explain: { what, why: bi(`这个 PR 已经关闭（没有合并）${pull.closed_at ? `，时间 ${ago(Date.parse(pull.closed_at))}` : ''}，讨论结束了。`, `It was closed without merging${pull.closed_at ? ` on ${ago(Date.parse(pull.closed_at))}` : ''}; the discussion is over.`), fix: null, ...link === undefined ? {} : { link } } }
      }
      const size = pull?.changed_files === undefined ? undefined
        : bi(`改了 ${pull.changed_files} 个文件（+${pull.additions ?? 0} / -${pull.deletions ?? 0}）`, `${pull.changed_files} files changed (+${pull.additions ?? 0} / -${pull.deletions ?? 0})`)
      const said = facts.comment === undefined ? undefined : quote(facts.comment)
      const sizeZh = size === undefined ? '' : `，${size.zh}`
      const sizeEn = size === undefined ? '' : `; ${size.en}`
      const saidZh = said === undefined ? '' : `最新的评论：${said.zh}`
      const saidEn = said === undefined ? '' : ` Latest comment: ${said.en}`
      const explain = (reason: string): Explain => {
        switch (reason) {
          case 'review-requested':
            return { what, why: bi(`有人请你审查这个 PR${sizeZh}，正在等你。${saidZh}`, `You were asked to review it${sizeEn}; it is waiting on you.${saidEn}`),
              fix: bi('打开 PR 看改动，批准或者提修改意见。审查完后点"办完了"。', 'Open the PR, read the changes, then approve or request changes. Mark this done afterwards.'), ...link === undefined ? {} : { link: { ...link, label: bi('去审查', 'Review it') } } }
          case 'mentioned':
            return { what, why: bi(`有人在这个 PR 的讨论里 @了你。${saidZh}`, `Someone mentioned you in this PR.${saidEn}`),
              fix: bi('打开看看要你回答或决定什么，回复后点"办完了"。', 'Open it to see what you are asked to answer or decide; reply, then mark this done.'), ...link === undefined ? {} : { link } }
          case 'assigned':
            return { what, why: bi(`这个 PR 指派给了你${sizeZh}。${saidZh}`, `This PR is assigned to you${sizeEn}.${saidEn}`),
              fix: bi('接手处理；如果不该是你，取消指派。', 'Take it on, or unassign yourself if it should not be you.'), ...link === undefined ? {} : { link } }
          case 'your-pr':
            return { what, why: bi(`你提的这个 PR 有了新动态${pull?.draft ? '（还是草稿）' : ''}。${saidZh}`, `There is new activity on your PR${pull?.draft ? ' (still a draft)' : ''}.${saidEn}`),
              fix: bi('看看评论或审查意见，需要改就改，需要回就回。', 'Read the comments or review; change or reply where needed.'), ...link === undefined ? {} : { link } }
          default:
            return { what, why: bi(`这个 PR 有新动态。${saidZh}`, `There is new activity on this PR.${saidEn}`),
              fix: bi('打开看一眼；和你无关的话点"忽略"。', 'Take a look; dismiss it if it does not concern you.'), ...link === undefined ? {} : { link } }
        }
      }
      const reason = ({ review_requested: 'review-requested', mention: 'mentioned', team_mention: 'mentioned', assign: 'assigned', author: 'your-pr' } as Record<string, string>)[n.reason] ?? 'pr-activity'
      return { ...base, status: 'open', reason, note: null, explain: explain(reason) }
    }
    case 'Issue': {
      const issue = facts.issue
      const number = issue?.number ?? numberFromUrl(n.subject.url)
      const url = issue?.html_url ?? null
      const base = { matterKey: `gh:issue:${repo}#${number}`, kind: 'issue', title: `${repo}#${number} ${n.subject.title}`, url }
      const what = bi(`${repo} 的 issue #${number}「${n.subject.title}」`, `Issue #${number} "${n.subject.title}" in ${repo}`)
      const link = url === null ? undefined : { label: bi('打开 issue', 'Open the issue'), url }
      if (issue?.state === 'closed') {
        const how = issue.state_reason === 'not_planned' ? bi('（不打算处理）', ' (not planned)') : issue.state_reason === 'completed' ? bi('（已完成）', ' (completed)') : bi('', '')
        return { ...base, status: 'done', reason: 'closed', note: bi('已关闭', 'closed'),
          explain: { what, why: bi(`这个 issue 已经关闭${how.zh}${issue.closed_at ? `，时间 ${ago(Date.parse(issue.closed_at))}` : ''}。`, `It was closed${how.en}${issue.closed_at ? ` on ${ago(Date.parse(issue.closed_at))}` : ''}.`), fix: null, ...link === undefined ? {} : { link } } }
      }
      const said = facts.comment === undefined ? undefined : quote(facts.comment)
      const saidZh = said === undefined ? '' : `最新的评论：${said.zh}`
      const saidEn = said === undefined ? '' : ` Latest comment: ${said.en}`
      const reason = ({ mention: 'mentioned', team_mention: 'mentioned', assign: 'assigned' } as Record<string, string>)[n.reason] ?? 'issue-activity'
      const why = reason === 'mentioned' ? bi(`有人在这个 issue 里 @了你。${saidZh}`, `Someone mentioned you in this issue.${saidEn}`)
        : reason === 'assigned' ? bi(`这个 issue 指派给了你。${saidZh}`, `This issue is assigned to you.${saidEn}`)
          : bi(`这个 issue 有新动态。${saidZh}`, `There is new activity on this issue.${saidEn}`)
      const fix = reason === 'assigned'
        ? bi('接手处理；如果不该是你，取消指派。', 'Take it on, or unassign yourself if it should not be you.')
        : bi('打开看看要你做什么，回复或处理后点"办完了"。', 'Open it to see what is asked of you; reply or act, then mark this done.')
      return { ...base, status: 'open', reason, note: null, explain: { what, why, fix, ...link === undefined ? {} : { link } } }
    }
    case 'Commit': {
      const sha = facts.sha?.slice(0, 7) ?? ''
      const who = facts.comment?.author
      const said = facts.comment === undefined ? undefined : quote(facts.comment)
      const url = facts.comment?.url ?? null
      return {
        matterKey: `gh:commit:${repo}@${facts.sha ?? n.id}`,
        kind: 'commit',
        title: bi(`${repo} 提交 ${sha} 有新评论：${n.subject.title}`, `${repo} commit ${sha} has a new comment: ${n.subject.title}`),
        url,
        status: 'open',
        reason: 'commit-comment',
        note: bi(`${who === undefined ? '有人' : who} 在你的提交下留了言`, `${who ?? 'someone'} commented on your commit`),
        explain: {
          what: bi(`${repo} 里你的提交 ${sha}「${n.subject.title}」`, `Your commit ${sha} "${n.subject.title}" in ${repo}`),
          why: said === undefined ? bi('有人在这个提交下留了言。', 'Someone commented on this commit.') : bi(`有人在这个提交下留了言：${said.zh}`, `Someone commented on this commit: ${said.en}`),
          fix: bi('打开评论看要你做什么；回复或处理后点"办完了"。', 'Open the comment to see what is asked; reply or act, then mark this done.'),
          ...url === null ? {} : { link: { label: bi('看评论', 'Open the comment'), url } },
        },
      }
    }
    case 'Release':
      return {
        matterKey: `gh:release:${repo}:${n.subject.title}`, kind: 'release',
        title: bi(`${repo} 发布了 ${n.subject.title}`, `${repo} released ${n.subject.title}`), url: null,
        status: 'done', reason: 'info-release', note: bi('只是通知，不用处理', 'just a notice, nothing to do'),
        explain: {
          what: bi(`${repo} 发布了新版本 ${n.subject.title}。`, `${repo} published ${n.subject.title}.`),
          why: bi('这只是关注的仓库发了新版本，没有要你做的事。', 'A repo you watch released a new version; nothing is asked of you.'),
          fix: null,
          link: { label: bi('看发布说明', 'Read the release'), url: `https://github.com/${repo}/releases` },
        },
      }
    default: {
      const ciTitle = n.subject.type === 'CheckSuite'
      return {
        matterKey: threadKey, kind: ciTitle ? 'ci' : 'other', title: plainTitle,
        url: ciTitle ? `https://github.com/${repo}/actions` : n.repository.html_url,
        status: 'open', reason: 'unclassified',
        note: ciTitle ? bi('看不懂这条 CI 通知的标题，交给你看', 'cannot read this CI notice\'s title, handing it to you')
          : bi(`规则还不认识 ${n.subject.type} 类通知，交给你看`, `the rules do not know ${n.subject.type} notifications yet, handing it to you`),
        explain: {
          what: bi(`${repo} 的一条 ${n.subject.type} 通知：${n.subject.title}`, `A ${n.subject.type} notification from ${repo}: ${n.subject.title}`),
          why: ciTitle ? bi('这条 CI 通知的标题格式小秘书看不懂，没法判断它现在的状态。', 'The secretary cannot read this CI notice\'s title, so it cannot check the current state.')
            : bi(`小秘书的规则还不认识「${n.subject.type}」这类通知，不确定要不要你处理。`, `The rules do not know "${n.subject.type}" notifications yet, so it is not sure whether this needs you.`),
          fix: bi('打开看一眼：要处理就处理，和你无关就点"忽略"。', 'Take a look: handle it if needed, otherwise dismiss it.'),
          link: { label: bi('打开', 'Open'), url: ciTitle ? `https://github.com/${repo}/actions` : n.repository.html_url },
        },
      }
    }
  }
}
