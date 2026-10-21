# dsh-mishu

[中文](#中文) · [English](#english)

---

## 中文

**DSH 小秘书，[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。**替你盯着 GitHub 通知，也记住你交代的事（账单、续费、证件到期、生日）。它会查清楚哪些事已经结束、替你关掉，只把真要你处理的留给你。

支持 macOS / Windows / Linux，界面中英双语。设计见 [docs/调研与设计.md](docs/调研与设计.md)，需求全景见 [docs/需求清单.md](docs/需求清单.md)。

### 第一版做什么

**GitHub 通知**：每 15 分钟拉一次全部未读通知，**查对象现在的状态**再判断，不看通知文字。

| 理由码 | 意思 |
|---|---|
| `merged` / `closed` | PR 已合并，或 issue / PR 已关闭 |
| `recovered` | 同一工作流在同一分支上后来通过了 |
| `superseded` | 旧版本 tag 失败了，但后面的 main 或更新的 tag 已经通过 |
| `ref-gone` | 失败的那个分支已经删了 |
| `fork-upstream-schedule` | fork 没有自己的提交，却在跑上游的定时任务，失败通知全是噪音；合成一件事：关掉这个 fork 的 Actions |
| `ci-failing` | 最近一次还是失败，交给你 |
| `review-requested` / `mentioned` / `assigned` / `your-pr` / `commit-comment` | 交给你 |

几十条通知会合并成"事项"：同一工作流在同一分支上的失败算一件事，同一个 fork 的噪音也算一件事。

**手动交代**：在任何 DSH 对话里说一句，比如"护照 2027 年 3 月 10 日到期"或"每月 15 号交房租"。模型会整理出日期、重复方式和提前多久提醒，**DSH 弹出审批卡片让你核对，你同意了才存**。到了提醒那天，它出现在待处理里。你说办了，这一期就关闭，下一期按周期自动出现。

默认提前量：证件 90 天，账单 3 天，生日纪念日 7 天，续费续保 7 天，其他 1 天。

### 用法

**看板**：点 DSH 左侧栏的"小秘书"，打开整页看板。顶部是一句话总结和四个数字（要你处理、7 天内到期、今天替你关掉、待你核对），下面分三栏：

- **要你处理**：现在需要你的事。每张卡片写明**是什么、问题在哪、怎么办**（比如 CI 失败在哪个 job 的哪一步、上次成功是什么时候），主按钮直接打开该看的地方（"看失败日志""去关掉 Actions""去审查"），还有办完了、明天再说、忽略。
- **我记着**：说过"明天再说"的事，以及还没到提醒时间的交代。底部可以直接交代新的事，填写时会实时显示小秘书理解成了什么。
- **替你办了**：最近 7 天关掉的事，按理由分组。点"怎么回事"能看到它是什么、为什么关掉（附证据链接）、小秘书做了什么、来自哪几条通知。判错了就点"恢复"。

卡片可以拖动：拖到"替你办了"就是办完，拖到"我记着"就是明天再提醒，从"我记着"拖回"要你处理"就是现在处理。三栏之间的分隔条也能拖动调宽度，双击恢复等宽。

**文字命令**：

```
/mishu                 简报：要处理的、快到了的、最近替你关掉了什么
/mishu 同步            立刻同步一次 GitHub
/mishu 完成 12         把 #12 标为完成（还有：忽略 12、恢复 12）
/mishu 已关闭          最近 3 天关掉的事项和理由
/mishu 交代            你交代过、还在进行的事
/mishu 停止 3          交代 #3 以后不再提醒
```

英文命令也能用：`sync`、`done`、`dismiss`、`reopen`、`closed`、`series`、`stop`、`help`。

agent 可用的工具：`mishu_add`（交代，需要你审批）、`mishu_list`、`mishu_update`、`mishu_stop`。

### 不会做的事

- **默认不在 GitHub 上标已读。**`markRead` 默认是 `shadow`：只记下"如果打开，会把哪些通知标成已读"，一条也不真标。核对过 `/mishu 已关闭` 后，再改成 `on`。还在待处理里的事项，永远不会被标已读。
- **通知文字不会触发任何动作。**只看查到的状态。
- **你改过的状态，不会被同样的证据改回去。**只有来源出现更新的动态，才会重新判断。
- **你重新打开一件被规则关掉的事，算一次纠正。**一条规则关掉的事项满 10 件、被纠正的比例超过 20%，这条规则就降级：之后它的结论只给你看，不再自动关闭。

### GitHub token

mishu 自己不保存 token。按顺序取：

1. 环境变量（默认 `GITHUB_TOKEN`）
2. `gh auth token`：装了 GitHub CLI，并运行过 `gh auth login` 就行

### 安装和配置

```bash
dsh plugin --profile <name> add dsh-mishu
```

在 profile 的 `cordis.patch.yml` 里可以覆盖配置：

```yaml
- id: dsh-mishu
  name: dsh-mishu
  config:
    home: ~/.mishu              # 记事本目录，在 DSH 之外
    language: auto              # auto（跟系统语言）/ zh / en
    github:
      enabled: true
      intervalMinutes: 15
      tokenEnv: GITHUB_TOKEN
      useGhCli: true
      markRead: shadow          # off / shadow / on
      markReadReasons: [merged, closed, recovered, superseded, ref-gone]
    leadDays: { document: 90, bill: 3, birthday: 7, renewal: 7, other: 1 }
    upcomingDays: 30            # 简报里"快到了"往后看多少天
```

记事本是 `~/.mishu/mishu.db`（SQLite），只存元数据和简短备注，不存邮件正文和 token。在 macOS / Linux 上，这个目录只有你本人能读写。卸载插件不会删它。

### 还没做

- 推送到手机（渠道还没定）。现在简报只能在 DSH 里看。
- 规则认不出的通知（`unclassified`）先直接交给你，还没接模型。
- 邮箱、飞书等其他来源。

---

## English

**A secretary plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** It watches your GitHub notifications and remembers the dated things you tell it (bills, renewals, document expiries, birthdays). It checks which of them are already resolved and closes those for you, so only what actually needs you stays on the list.

Runs on macOS, Windows and Linux. Speaks Chinese and English.

### What version 1 does

**GitHub notifications**: every 15 minutes it pulls all unread notifications and judges each one by **the current state of what it is about**, never by the notification text.

| Reason | Meaning |
|---|---|
| `merged` / `closed` | The PR was merged, or the issue / PR was closed |
| `recovered` | The same workflow later passed on the same branch |
| `superseded` | An old release tag failed, but main or a newer tag has passed since |
| `ref-gone` | The failing branch has been deleted |
| `fork-upstream-schedule` | A fork with no commits of its own runs its parent's scheduled workflows; every failure is noise, folded into one item: turn off Actions on the fork |
| `ci-failing` | The latest run still fails; handed to you |
| `review-requested` / `mentioned` / `assigned` / `your-pr` / `commit-comment` | Handed to you |

Dozens of notifications fold into a few *items*: all failures of one workflow on one branch are one item, and all noise from one fork is one item.

**Things you tell it**: in any DSH chat, say "my passport expires on 2027-03-10" or "rent is due on the 15th every month". The model works out the date, the repeat and how early to remind you; **DSH shows an approval card with exactly what was understood, and nothing is saved until you approve it**. On the reminder day the item appears on your list. When you say it is done, that occurrence closes and the next one appears on its own schedule.

Default warning times: documents 90 days, bills 3, birthdays 7, renewals 7, everything else 1.

### Usage

**The board**: click "Secretary" in DSH's left sidebar to open a full-page board. On top: one summary sentence and four numbers (to handle, due in 7 days, closed today, to review). Below, three columns:

- **To handle**: what needs you now. Every card says **what it is, where the problem is and what to do** (for a failing CI: which job and step, when it last passed), and its main button opens the right place ("Open the failing log", "Turn off Actions", "Review it"), next to done, tomorrow and dismiss.
- **Keeping for you**: things you put off until tomorrow, and things you told it that are not due for a reminder yet. Add a new one at the bottom, with a live preview of what was understood.
- **Done for you**: what was closed in the last 7 days, grouped by reason. "What happened" shows what it was, why it was closed (with the evidence link), what the secretary did and which notifications it came from. Reopen any that are wrong.

Cards can be dragged: onto "Done for you" to mark done, onto "Keeping for you" to snooze until tomorrow, from "Keeping for you" back to "To handle" to handle it now. The dividers between the columns can be dragged too; double-click one to make the columns equal.

**Text commands**:

```
/mishu                 brief: what needs you, what is coming up, what was closed for you
/mishu sync            sync GitHub now
/mishu done 12         mark #12 done (also: dismiss 12, reopen 12)
/mishu closed          items closed in the last 3 days, with reasons
/mishu series          things you told me that are still in play
/mishu stop 3          stop reminding series #3
```

Chinese commands work too: `同步`, `完成`, `忽略`, `恢复`, `已关闭`, `交代`, `停止`, `帮助`.

Tools for the agent: `mishu_add` (needs your approval), `mishu_list`, `mishu_update`, `mishu_stop`.

### What it will not do

- **It does not mark anything read on GitHub by default.** `markRead` starts as `shadow`: it records which notifications it *would* mark read and touches none. Check `/mishu closed`, then switch to `on`. Items still on your list are never marked read.
- **Notification text never triggers an action.** Only verified state does.
- **Your own decision is not overturned by the same evidence.** Only newer activity at the source re-opens the question.
- **Reopening something a rule closed counts as a correction.** A rule that has closed at least 10 items and been corrected on more than 20% of them is demoted: from then on its conclusions are shown to you instead of closing items.

### GitHub token

mishu never stores a token. It uses, in order:

1. an environment variable (default `GITHUB_TOKEN`)
2. `gh auth token`: if the GitHub CLI is installed and you have run `gh auth login`

### Install and configure

```bash
dsh plugin --profile <name> add dsh-mishu
```

Override settings in the profile's `cordis.patch.yml` (see the Chinese section for the full example; the keys are the same). `language` is `auto` (follow the system locale), `zh` or `en`.

The notebook is `~/.mishu/mishu.db` (SQLite). It keeps metadata and short notes only, never email bodies or tokens. On macOS and Linux the directory is readable and writable by you alone. Uninstalling the plugin leaves it in place.

### Not done yet

- Push to your phone (channels not chosen yet). For now the brief is only in DSH.
- Notifications the rules do not recognise (`unclassified`) are handed to you; no model triage yet.
- Other sources such as email and Feishu / Lark.

---

## Development · 开发

```bash
npm install
npm test     # node:test runs the TypeScript directly (Node ≥ 22.18); the time zone is pinned in tests/setup.ts
npm run build
npm run record   # record a real, read-only sync of your own account into tests/fixtures/local/
```

**Test data · 测试数据**

- The committed tests use a made-up GitHub account built in `tests/fixtures/synthetic.ts` (`example-org`, `upstream-org`, `demo-*`): a fork running its parent's schedules, superseded release tags, recovered failures, a deleted branch, a red feature branch, a bot comment on a commit, PRs and issues in every state.
- 仓库里的测试只用编造的账号（`tests/fixtures/synthetic.ts`），覆盖所有规则要处理的情况。
- `npm run record` writes a recording of **your own** account to `tests/fixtures/local/`. Git ignores that folder; never commit it. When it exists, `npm test` also checks it (every notification judged, every closure has a known reason); when it does not, those checks are skipped.
- `npm run record` 录下的是**你自己账号的真实数据**，放在 `tests/fixtures/local/`，git 会忽略这个目录，绝不提交。本机有这份数据时，`npm test` 会多跑一组检查；没有就跳过。

```
src/core/          notebook, items, things you tell it, GitHub rules, brief, board, i18n — node: built-ins only, no DSH imports
src/core/github/   client (REST) → facts (current state) → rules (pure) → sync (fold into items)
src/dsh/           plugin shell: config, timers, /mishu, agent tools, approval gate, board API
src/client/        browser half: left-sidebar entry and the board page (React, bundled by scripts/build-client.mjs)
```

Test in a separate profile: `npm pack`, then `dsh plugin --profile mishu-test add ./dsh-mishu-x.y.z.tgz` with `home: ~/.mishu-test`.
