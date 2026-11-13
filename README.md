# dsh-mishu

[![npm version](https://img.shields.io/npm/v/dsh-mishu?color=cb3837&logo=npm)](https://www.npmjs.com/package/dsh-mishu)
[![npm downloads](https://img.shields.io/npm/dm/dsh-mishu?color=cb3837)](https://www.npmjs.com/package/dsh-mishu)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#)
[![Languages](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87%20%7C%20English-orange)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![No telemetry](https://img.shields.io/badge/telemetry-none-success)](docs/调研与设计.md#用户数据安全)
[![DSH Plugin Hub](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/aicivilization/dsh-mishu)

`提醒` `通知` `待办` `收件箱` `秘书` `GitHub` `邮件` `飞书` `Telegram` · `reminder` `notifications` `todo` `inbox` `triage` `secretary`

[中文](#中文) · [English](#english)

---

## 中文

**DSH 小秘书，[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。**替你盯着 GitHub 通知，也记住你交代的事（账单、续费、证件到期、生日）。它会查清楚哪些事已经结束、替你关掉，只把真要你处理的留给你。

支持 macOS / Windows / Linux，界面中英双语。设计见 [docs/调研与设计.md](docs/调研与设计.md)，需求全景见 [docs/需求清单.md](docs/需求清单.md)。

### 能做什么

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

**邮件**：在设置页添加邮箱（QQ、163、126、企业微信邮箱、阿里云、新浪、139、Gmail、iCloud、Yahoo、Fastmail、Zoho，或自己填 IMAP + SMTP 服务器），然后有三件事可做：

1. **盯着**：定时看收件箱里最近的未读邮件，只看发件人、收件人、标题和几个邮件头，判断这封要不要你处理——这条链路不读正文、不动邮箱。
2. **看和找**：看板上的"邮件"页签里可以列任何文件夹、翻页、读全文（HTML 转纯文本，超长截断）、按主题/发件人/收件人/抄送/正文搜索、标已读或未读、加星、移动到别的文件夹、把附件存到 `~/.mishu/attachments`。服务器搜索先问，服务器不支持就退回本地扫最近的邮件头，再退回扫正文——结果里会写清是哪一种。文件夹也能自己建、改名、删（收件箱、已发送、草稿、垃圾箱这些邮箱自己的文件夹不动，里面还有信的也不让删）。列表每行前面能打勾，勾上就出现一条批量操作条：标为已读、标为未读、移到别的文件夹、删掉，一次最多 20 封；在废纸篓里同一个按钮变成"彻底删除"，问过你才动手。删信一律先移进废纸篓，只有废纸篓里才是真删。
3. **写和发**：写新邮件、回复、全部回复、转发，带附件（最多 20 个、合计 20MB），可以先存草稿（最多 50 封，存在记事本里，随时改、随时发、随时删）。**发信、回信、发草稿、定时每次都会先弹一张卡片**，写清从哪个账号发、收件人、抄送、密送、主题、附件和正文开头，你点了才发。写完也可以定个时间让它自己发：时间必须带时区（`2026-11-20T09:00:00+08:00`），至少留 30 秒，最多排一年。定时发信要 DSH 开着——它是小秘书自己在跑，不是塞进对方服务器的队列；没发出去的那封会回到草稿箱，并写明原因，不会自己一遍遍重试。

"测试并保存"会同时验 IMAP 和 SMTP：收信通、发信不通时也保存账号（可以先收），但会当场说清哪一步不通。

| 理由码 | 意思 |
|---|---|
| `mail-to-you` | 直接写给你、没有群发或自动发送标记的邮件，可能在等你回复 |
| `mail-invite` | 会议或日程邀请，等你回应 |
| `mail-bill` | 标题里有账单、还款、缴费、续费、发票之类的字眼（哪怕是群发的） |
| `mail-newsletter` / `mail-automated` | 群发邮件、系统自动邮件：折叠起来，不打扰你 |
| `mail-code` / `mail-github` / `mail-cc` | 验证码、GitHub 通知邮件（GitHub 来源已经在管）、只是抄送你 |

同一封邮件的往来回复算一件事。你在邮件客户端里看过之后，对应的事项会自动关闭。

**自己关注的**：GitHub 和邮箱之外，你也可以在设置页填任意一个网址让小秘书盯着：产品公告页、价格页、招聘页、RSS 订阅、JSON 接口都行。可以填几个"关注哪些字"（比如"上新、补丁、面试"），填了就只在出现这些字时提醒，不填就是有变化就提醒。检查间隔 15 分钟到 24 小时，默认一小时。

| 理由码 | 意思 |
|---|---|
| `watch-keyword` | 页面内容提到了你关注的字 |
| `watch-new` | 订阅源里出现了新的条目 |
| `watch-changed` | 普通网页的正文变了（比如价格） |
| `watch-removed` | 你删掉了这个关注，还没处理的事项一并关掉 |

一个关注项算一张卡片，不会因为一天更新十条就刷一屏。刚添加时第一次检查只记下"现在有什么"，不报警；但填了关键词的，第一次命中就告诉你。读不到（断网、404、要登录）会写清原因，卡片不会因此凭空出现。

**密码放在系统钥匙串**：macOS 钥匙串、Windows 凭据管理器、Linux 密钥环（Secret Service）。密码只在设置页输入一次，直接交给钥匙串，不写进任何文件，接口也从不返回它。没有钥匙串的电脑（比如没有桌面的 Linux 服务器），密码和 token 存进记事本目录里的 `secrets.json`：权限 600，只有你的系统账号能读，但没有加密，设置页会写明这一点和原因。

**关注一个网址**：点"+ 关注一个网址"，填网址（和想关注的字），点"先试读一下"当场看读到什么，再"保存并看一次"。

**添加邮箱**：点"+ 添加邮箱"弹出向导。填了地址就自动选好服务商，显示去哪里开 IMAP、拿授权码，带"打开设置页"；授权码位数不对会提醒；"测试并保存"同时验收信和发信，收信通就保存，发信通不通当场写明。

**邮件页签**：看板顶部切到"邮件"。左边选文件夹（带未读数），中间翻页看列表，点一封在右边读。列表上方可以搜索——先问服务器，再退回扫本地邮件头，最后才扫正文，结果里写明是哪一种答的。打开的一封可以标已读/未读、加星、移到别的文件夹、存附件，也可以回复、全部回复、转发。"写邮件"打开撰写窗口，"存草稿"存进记事本（最多 50 封），左边草稿箱里每封都有"发出"和"删掉"。撰写窗口里填一个时间就出现"定时"按钮，定好的草稿在草稿箱里标着"定时：11/20 09:00"，下面还有"取消定时"；到点没发出去的那封会带着原因回到草稿箱。没有那张审批卡片，什么都发不出去。左栏底部有"新建文件夹"，鼠标划过自建文件夹会露出改名和删除。列表每行前面有勾选框，勾上几封上面会露出一条批量操作条（标已读、标未读、移动、删掉）；阅读窗格右侧也有一个删除按钮，在废纸篓里它会变成"彻底删除"并先问你一次。回复走的是回信通道，不会丢掉线索：主题前面加"Re:"、带上原始 Message-ID，回信在对方邮箱里仍旧归在同一个往来里；从回复存的草稿，以后发出去也还在这条线上。

### 用法

**看板**：点 DSH 左侧栏的"小秘书"，打开整页看板。顶部是一句话总结和四个数字（要你处理、7 天内到期、今天替你关掉、待你核对），下面分三栏：

看板上方可以按来源筛选：全部、GitHub、邮件、关注、交代。

- **要你处理**：现在需要你的事。卡片平时是收起的，只显示标题；点标题展开，一次只展开一张，点另一张时前一张自动收起。展开后写明**是什么、问题在哪、怎么办**（比如 CI 失败在哪个 job 的哪一步、上次成功是什么时候），主按钮直接打开该看的地方（"看失败日志""去关掉 Actions""去审查"），还有办完了、明天再说、忽略。
- **我记着**：说过"明天再说"的事，以及还没到提醒时间的交代。底部可以直接交代新的事，填写时会实时显示小秘书理解成了什么。
- **替你办了**：最近 7 天关掉的事，按理由分组。展开一张卡片就能看到它是什么、为什么关掉（附证据链接）、小秘书做了什么、来自哪几条通知。判错了就点"恢复"。

**+AI**：看不明白就点彩色的"+AI"。它会开一个新对话，把这件事的说明、链接和相关通知放进输入框（不会自动发送），你看过、补上自己的问题再按发送。看板上的每张卡片、顶部总结、来源报错、设置页里各邮箱服务商的开通说明都有这个按钮。对话里的 AI 可以用 `mishu_detail` 查一件事的完整记录；要改状态时会先问你。

卡片可以拖动：拖到"替你办了"就是办完，拖到"我记着"就是明天再提醒，从"我记着"拖回"要你处理"就是现在处理。三栏之间的分隔条也能拖动调宽度，双击恢复等宽。

**设置**：点页面顶部的"设置"，按秘书的活分成四块：① 它看哪里（GitHub、邮箱、自己关注的网址）；② 什么事要告诉你（哪些算急事、各类别提前几天）；③ 什么时候、怎么告诉你（主动提醒，见下）；④ 能替你办什么（在 GitHub 上标已读的方式；邮件哪些事要你点头）。最后是语言和密码存在哪。每块都是折叠的卡片，平时只显示标题，点开才展开，一次只开一张；里面的邮箱账户、通知渠道也是同样可折叠的卡片，开关就在标题右边，不展开也能点。

**主动提醒**：不用打开看板也能知道。
- 每日简报：每天到点（默认 09:00）发一份"要你处理"和"快到期"的清单；没事就不发。
- 急事立刻提醒：有人请你 review、@ 你、把事分配给你；会议邀请；你交代的事到了当天或已经过期。每件只提醒一次；刚打开提醒时，看板上已有的不算新消息。
- 免打扰（默认 22:00 到 08:00）：这段时间不发，期间出现的急事等结束后一起发。
- 时间按你浏览器所在的时区算，DSH 跑在别的时区的服务器上也不会错。
- 发到：这台电脑的系统通知（macOS、Windows、Linux 桌面；服务器上没有），以及飞书群机器人（建一个只有你的群、加一个自定义机器人，把 Webhook 地址粘贴过来；支持签名校验）。飞书的地址和密钥当密码存；提醒内容会经过飞书的服务器。

**交给 DSH 的自动化任务**：设置页 ③ 里还有一个开关，把每日简报改成 DSH 自己的定时任务——到点它不弹通知，而是在 DSH 里出现一条对话，你下次打开就能看见，手机上装 DSH 客户端也一样。这一条用的是 DSH 自带的 `schedule` 服务，小秘书只建这一个任务，标题是"小秘书 · 每日简报"；改简报时间会跟着改，取消就删掉。下面同时列出 DSH 里所有定时任务（包括你自己在"自动化任务"页建的），每个都能"现在跑一次"或删除。DSH 没装这个服务时，这一块只说一句"这个 DSH 没有自动化任务服务"，不影响桌面通知。

**重启 DSH**：页面顶部"设置"后面的按键。重装或升级插件后点它，桌面版会按正常方式退出（有任务在跑时会先问你），再自动打开。用 dsh-vps 装在服务器上的 DSH，由 dsh-gate 网关托管：点了之后 DSH 正常退出，网关几秒内把它重新拉起，页面断开一会儿后自动刷新。直接用 `dsh` 命令启动的 DSH 没法从页面重启（新的登录地址只会打印在那个终端里），按键会告诉你回终端按 Ctrl+C 再运行一次。Windows 和 Linux 桌面版的重启还没在真机上测过。

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

agent 可用的工具：

- 记事本：`mishu_add`（交代，需要你审批）、`mishu_list`、`mishu_detail`、`mishu_update`、`mishu_stop`。
- 邮件：`mishu_mail_list`、`mishu_mail_read`、`mishu_mail_search`、`mishu_mail_mark`（`uid` 一封，或 `uids` 最多 20 封；`action` 可加 `delete` 进废纸篓、`purge` 在废纸篓里彻底删）、`mishu_mail_folders`（`action` 可选 list/create/rename/delete）、`mishu_mail_attachment`、`mishu_mail_draft`（`action=schedule` 定时、`send_at` 带时区；`action=cancel` 取消定时），以及要审批的 `mishu_mail_send`、`mishu_mail_reply`、`mishu_mail_draft`（`action` 是 `send` 或 `schedule` 时）、`mishu_mail_mark`（只在 `action=purge` 时，删了就找不回来）。账号只有一个时不用点名，多个时必须说清用哪个。

### 不会做的事

- **默认不在 GitHub 上标已读。**`markRead` 默认是 `shadow`：只记下"如果打开，会把哪些通知标成已读"，一条也不真标。核对过 `/mishu 已关闭` 后，再改成 `on`。还在待处理里的事项，永远不会被标已读。
- **通知文字不会触发任何动作。**只看查到的状态。
- **你改过的状态，不会被同样的证据改回去。**只有来源出现更新的动态，才会重新判断。
- **你重新打开一件被规则关掉的事，算一次纠正。**一条规则关掉的事项满 10 件、被纠正的比例超过 20%，这条规则就降级：之后它的结论只给你看，不再自动关闭。
- **不自己动你的邮箱。**定时分诊始终只读：不读正文，不标已读，不删不移，不发信。看邮件、搜、标已读、加星、移动、删信、存附件、发信都是你点了才做；发信、回信、发草稿每次先出卡片给你核对，彻底删除先问你一次。

### GitHub token

按顺序取，token 不写进任何文件：

1. 环境变量（默认 `GITHUB_TOKEN`）
2. 在设置页"用 GitHub 登录"拿到的 token（GitHub 设备登录：显示一个登录码，你在 github.com/login/device 输入并授权，手机或别的电脑上都行），或者你粘贴的 token：先拿到 GitHub 上检查，再存进系统钥匙串（没钥匙串时存进 `secrets.json`）。要用 classic token，勾选 `notifications`（看私有仓库再勾 `repo`）；GitHub 的通知接口不认 fine-grained token
3. `gh auth token`：装了 GitHub CLI，并运行过 `gh auth login` 就行。从 Dock、开始菜单启动的 DSH 拿到的 PATH 往往很短，所以小秘书除了 PATH，还会去 Homebrew、`~/.local/bin`、winget、Scoop 等常见安装位置找 `gh`

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
- 飞书；邮件里的"你发出去没人回""你答应别人的事"（要读已发送文件夹，现在能读，但还没做成规则）。
- POP3 和各家自建的 AgentMail 通道；现在只有 IMAP + SMTP。
- Outlook / Hotmail / Gmail 的 OAuth：微软和 Google 都收紧了密码登录，现在只能填应用专用密码。
- Windows 和 Linux 的钥匙串已经按各自系统的方式实现，但还没在真机上测过。
- 定时发信靠 DSH 里那个每 30 秒的检查：DSH 关着的时候到点不发，等下次开起来补发（晚了会晚，但不会丢）。

### 收录渠道

- [DSH Plugin Hub（dsh-plugin.org 社区插件市场）](https://dsh-plugin.org/plugins/aicivilization/dsh-mishu)
- [awesome-dsh-plugin 精选列表](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- dsh-plugin-shop 插件商店（每日自动收录）
- 52DSH / tuofangzhe 插件目录（证据分级收录）

---

## English

**A secretary plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** It watches your GitHub notifications and remembers the dated things you tell it (bills, renewals, document expiries, birthdays). It checks which of them are already resolved and closes those for you, so only what actually needs you stays on the list.

Runs on macOS, Windows and Linux. Speaks Chinese and English.

### What it does

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

**Mail**: add a mailbox on the settings page (QQ, 163, 126, Tencent Exmail, Aliyun, Sina, 139, Gmail, iCloud, Yahoo, Fastmail, Zoho, or your own IMAP + SMTP servers). Three things follow:

1. **Watching**: on a timer it reads recent unread mail in the inbox — sender, recipients, subject and a few headers only — and decides whether a message needs you. That path never reads a body and never changes the mailbox.
2. **Reading and searching**: the "Mail" tab lists any folder with paging, opens a message in full (HTML reduced to text, long bodies truncated), searches subject / from / to / cc / body, marks read or unread, stars, moves between folders, and saves attachments to `~/.mishu/attachments`. Folders you made can be created, renamed and deleted from the panel (the mailbox's own folders are left alone, and a folder still holding mail is not deleted). Every row has a tick box: tick a few and a bar appears with mark read, mark unread, move and delete, up to 20 at a time; inside Trash the same button becomes "Delete forever" and asks first. Deleting always means "into Trash" — only Trash removes mail for good. Search asks the server first, falls back to scanning recent headers locally, then to scanning bodies — and says which one answered.
3. **Writing and sending**: new mail, reply, reply-all, forward, with attachments (up to 20 files, 20 MB in all) and drafts (up to 50, kept in the notebook, editable, sendable, deletable). A draft can also be given a time and left to go on its own: the time has to name its timezone (`2026-11-20T09:00:00+08:00`), at least 30 seconds and at most a year ahead, and DSH has to be running — the secretary sends it, it is not queued on the far side. A scheduled send that fails comes back to drafts with the reason attached instead of retrying on its own. **Every send, reply, draft-send and schedule first shows a card** naming the account it goes out from, the recipients, cc, bcc, subject, attachments and the opening of the body; nothing leaves until you approve it.

"Test and save" checks IMAP and SMTP both: an account whose sending side fails is still saved — receiving works — and the dialog says exactly which half refused.

| Reason | Meaning |
|---|---|
| `mail-to-you` | Written to you directly, with no bulk or automated markers; someone may be waiting |
| `mail-invite` | A meeting or calendar invitation waiting for your answer |
| `mail-bill` | The subject mentions a bill, payment, renewal or invoice (even in bulk mail) |
| `mail-newsletter` / `mail-automated` | Bulk or automated mail, folded away |
| `mail-code` / `mail-github` / `mail-cc` | Verification codes, GitHub notification mail (the GitHub source has it), mail you are only copied on |

A thread of replies is one item. Once you read it in your mail client, its item closes by itself.

**Things you watch yourself**: beyond GitHub and mail, you can give the secretary any address on the settings page — a product announcements page, a price, a job posting, an RSS feed, a JSON endpoint. You can list a few words to watch for (say "release, patch, interview"): with words it only tells you when they show up, without words any change is worth a card. The interval runs from 15 minutes to 24 hours, one hour by default.

| Reason | Meaning |
|---|---|
| `watch-keyword` | the content mentions a word you watch for |
| `watch-new` | the feed has entries you have not seen |
| `watch-changed` | the text of a plain page changed (a price, say) |
| `watch-removed` | you deleted the watch; anything it left open is closed |

One watch is one card, so a feed that updates ten times a day does not flood the board. The first look only writes down what is there and says nothing — unless you gave it words, in which case a hit is reported at once. A read that fails (offline, 404, behind a login) says why, and never invents a card.

**Passwords live in the system keychain**: the macOS Keychain, Windows Credential Manager or the Linux keyring (Secret Service). You type a password once on the settings page; it goes straight to the keychain, is never written to a file and is never returned by any endpoint. On a computer without one (a Linux server with no desktop, say), passwords and tokens go to `secrets.json` in the notebook directory: mode 600, readable by your system account only, but not encrypted, and the settings page says so and why.

**Watching an address**: "+ Watch an address" asks for the address and, if you want, the words to watch for; "Read it once" shows what it finds before you save it, then "Save and look once".

**Adding a mail account**: "+ Add a mail account" opens a short guide. The address picks the provider; it says where to turn on IMAP and get the app password, with a button that opens that page; it warns when the password has the wrong length; "Test and save" checks IMAP and SMTP and keeps the account if receiving works, saying plainly whether sending does too.

**The Mail tab**: pick a folder on the left (unread counts come with it), page through the list, click a message to read it. Above the list you can search — the server is asked first, then recent headers are scanned locally, then bodies, and the result says which. On an open message you can mark read or unread, star it, move it to another folder, save an attachment, or reply, reply to all and forward. "Write" opens the composer; "Save draft" keeps it in the notebook (up to 50) with "Send" and "Delete" buttons on the left. Type a time in the composer and a "Schedule" button appears; a scheduled draft is labelled "Scheduled: 11/20 09:00" with "Cancel schedule" under it, and one that failed comes back with the reason attached. Nothing is sent without the approval card. At the bottom of that column is "New folder", and hovering a folder you made reveals rename and delete. Replies go out through the reply path, so the thread survives: "Re:" on the subject and the original Message-ID in the headers, which is also carried by a draft saved from a reply. Each row in the list has a tick box; tick several and a bar appears with mark read, mark unread, move and delete (20 at a time), and the read pane has its own delete button that turns into "Delete forever" and confirms first when the message is already in Trash.

### Usage

**The board**: click "Secretary" in DSH's left sidebar to open a full-page board. On top: one summary sentence and four numbers (to handle, due in 7 days, closed today, to review). Below, three columns:

Filter the board by source: All, GitHub, Mail, Watching, Noted.

- **To handle**: what needs you now. Cards stay folded and show only the title; click a title to unfold it — one at a time, so opening another folds the first. Unfolded, a card says **what it is, where the problem is and what to do** (for a failing CI: which job and step, when it last passed), and its main button opens the right place ("Open the failing log", "Turn off Actions", "Review it"), next to done, tomorrow and dismiss.
- **Keeping for you**: things you put off until tomorrow, and things you told it that are not due for a reminder yet. Add a new one at the bottom, with a live preview of what was understood.
- **Done for you**: what was closed in the last 7 days, grouped by reason. Unfold a card to see what it was, why it was closed (with the evidence link), what the secretary did and which notifications it came from. Reopen any that are wrong.

**+AI**: when something is unclear, press the colourful "+AI". It opens a new chat with the item's explanation, link and related notifications in the input box — unsent — so you can read it, add your question and press send. Every card, the summary, source errors and each mail provider's setup note have one. In that chat the AI can use `mishu_detail` to look an item up in full, and asks you before changing anything.

Cards can be dragged: onto "Done for you" to mark done, onto "Keeping for you" to snooze until tomorrow, from "Keeping for you" back to "To handle" to handle it now. The dividers between the columns can be dragged too; double-click one to make the columns equal.

**Settings**: the "Settings" tab at the top of the page: language, warning days per category, GitHub (on/off, where the token comes from, connection test, how to mark read), mail accounts (add, test, check now, edit, delete). Every block is a folded card that shows only its title until you click it, and only one is open at a time; mail accounts and notification channels fold the same way, with their switch on the title row so you can flip it without opening the card.

The settings follow the secretary's job in four parts: 1. where it looks (GitHub, mail, addresses you watch); 2. what to tell you about (what counts as urgent, warning days per category); 3. when and how to tell you (reminders, below); 4. what it may do for you (marking read on GitHub; which mail actions need your nod). Then language and where secrets are kept.

**Reminders**, without opening the board:
- Daily brief: at its time (09:00 by default) a list of what needs you and what is coming up; nothing is sent when there is nothing.
- Urgent items right away: a review requested, a mention, an assignment; a meeting invitation; something you told it that is due today or overdue. Each is sent once; what is already on the board when reminders start is not news.
- Quiet hours (22:00 to 08:00 by default): nothing is sent; urgent items from then come when they end.
- Times follow your browser's time zone, so DSH on a server in another zone still gets them right.
- Sent to this computer's notifications (macOS, Windows, a Linux desktop; a server has none) and to a Feishu / Lark group bot (a group of just you, a custom bot, its webhook address pasted in; signature verification supported). The bot's address and secret are kept like passwords; what reminders say passes through Feishu's servers.

**Handing the brief to DSH's scheduled tasks**: part 3 of the settings page can turn the daily brief into one of DSH's own scheduled tasks — instead of a notification it arrives as a conversation turn, there the next time you open DSH (including the mobile client). It uses DSH's built-in `schedule` service; the secretary creates exactly one task, titled "Secretary · daily brief", moves it when you change the brief's time, and deletes it when you turn it off. Below it, every scheduled task on this DSH is listed — including ones you made on DSH's own automation page — each with "run now" and delete. A DSH without that service says so in one line and keeps the desktop notification.

**Restart DSH**: the button after "Settings" at the top of the page. After reinstalling or upgrading plugins, click it: the desktop app quits the normal way (asking first if a task is running) and opens again. On a server set up with dsh-vps, DSH runs under the dsh-gate gateway: DSH exits cleanly, the gateway starts it again within seconds, and the page reloads once it is back. DSH started directly with the `dsh` command cannot be restarted from the page (its new sign-in address is printed only in that terminal), so the button tells you to press Ctrl+C there and run it again. Restarting the Windows and Linux desktop apps is not yet tested on real machines.

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

Tools for the agent:

- Notebook: `mishu_add` (needs your approval), `mishu_list`, `mishu_detail`, `mishu_update`, `mishu_stop`.
- Mail: `mishu_mail_list`, `mishu_mail_read`, `mishu_mail_search`, `mishu_mail_mark` (one `uid`, or `uids` for up to 20; `action` also takes `delete` for Trash and `purge` inside it), `mishu_mail_folders` (its `action` may be list, create, rename or delete), `mishu_mail_attachment`, `mishu_mail_draft` (`action=schedule` with a zoned `send_at`, or `action=cancel`), plus those that ask first: `mishu_mail_send`, `mishu_mail_reply`, `mishu_mail_draft` (when its action is `send` or `schedule`) and `mishu_mail_mark` (only for `action=purge`, where there is no undo). With one account it is picked for you; with several the tool has to name one.

### What it will not do

- **It does not mark anything read on GitHub by default.** `markRead` starts as `shadow`: it records which notifications it *would* mark read and touches none. Check `/mishu closed`, then switch to `on`. Items still on your list are never marked read.
- **Notification text never triggers an action.** Only verified state does.
- **Your own decision is not overturned by the same evidence.** Only newer activity at the source re-opens the question.
- **Reopening something a rule closed counts as a correction.** A rule that has closed at least 10 items and been corrected on more than 20% of them is demoted: from then on its conclusions are shown to you instead of closing items.
- **It does not touch your mailbox on its own.** The unread sweep stays read-only. Marking read, starring, moving, deleting, saving an attachment, sending, replying and sending a draft all happen only because you asked; every outbound message is shown as a card first, and removing mail for good asks a second time.

### GitHub token

It uses, in order, and never writes a token to a file:

1. an environment variable (default `GITHUB_TOKEN`)
2. a token from "Sign in with GitHub" on the settings page (GitHub's device flow: it shows a code you enter at github.com/login/device, from a phone or another computer if you like), or one you paste: checked with GitHub first, then kept in the system keychain (in `secrets.json` without one). Use a classic token with the `notifications` scope (plus `repo` for private repositories); GitHub's notifications API does not take fine-grained tokens
3. `gh auth token`: if the GitHub CLI is installed and you have run `gh auth login`. DSH started from the Dock or Start menu often gets a short PATH, so besides PATH the secretary looks for `gh` where Homebrew, `~/.local/bin`, winget and Scoop put it

### Install and configure

```bash
dsh plugin --profile <name> add dsh-mishu
```

Override settings in the profile's `cordis.patch.yml` (see the Chinese section for the full example; the keys are the same). `language` is `auto` (follow the system locale), `zh` or `en`.

The notebook is `~/.mishu/mishu.db` (SQLite). It keeps metadata and short notes only, never email bodies or tokens. On macOS and Linux the directory is readable and writable by you alone. Uninstalling the plugin leaves it in place.

### Not done yet

- Push to your phone (channels not chosen yet). For now the brief is only in DSH.
- Notifications the rules do not recognise (`unclassified`) are handed to you; no model triage yet.
- Feishu / Lark; "you sent it and nobody replied" and "things you promised" from mail (the Sent folder can be read now, the rules are not written).
- POP3 and AgentMail-style relays; only IMAP + SMTP for now.
- OAuth for Outlook / Hotmail / Gmail: both vendors have tightened password sign-in, so app passwords are the way in.
- The Windows and Linux keychains are implemented the way each system documents, but not yet tested on real machines.
- Scheduled mail rides on the half-minute check inside DSH: nothing leaves while DSH is closed; it goes on the first tick after it is back (late, not lost).

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
