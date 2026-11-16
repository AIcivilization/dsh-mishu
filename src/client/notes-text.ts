/**
 * 「随手贴」页签的界面文字，中英各一份。
 *
 * 形状照抄 text.ts：先写中文，英文用 `typeof zh` 锁住同一组键，少一个键、
 * 多一个键都编译不过。Notes.tsx 里不写用户能看到的字，全部从这里取，
 * 这样加一句话只改一个文件，两边的说法也不会走样。
 */

import type { UiLang } from './text.ts'

/**
 * 服务端认的六个类别键。存进库里、发给服务端的就是这几个中文键（规则和模型
 * 都按它们判），所以它们是数据而不是文案：显示时才查 `categoryNames` 翻成
 * 当前语言。放在这里是为了 Notes.tsx 里不出现半句中文。
 */
/** The one list the host validates against; imported so the two cannot drift. */
export { NOTE_CATEGORIES as NOTE_CATEGORY_KEYS } from '../core/notes/rules.ts'

const zh = {
  title: '随手贴',

  // 捕获区
  capturePlaceholder: '想到什么就记下来…',
  captureSave: '记下来',
  captureHint: 'Ctrl / ⌘ + Enter 也能记下。',
  captureOrganize: '记住后让 AI 整理',
  captureOrganizeOff: '设置里关着「让 AI 整理便签」：打开后这个勾选框才生效，现在便签原文不会离开这台电脑',
  captureEmpty: '先写点什么再记。',
  captured: (title: string) => `记下了：${title}`,
  duplicateHint: (title: string) => `你之前记过类似的：${title}`,
  /** 只提示，不合并：两条都留着，是否合并由人决定。 */
  duplicateNote: '只是提醒一下，两条都留着。',
  dismiss: '知道了',
  dueSeen: (day: string, label: string) => (label === '' || label === day ? `认出了日期：${day}` : `认出了日期：${day}（${label}）`),

  // 三档与搜索
  tabs: { live: '便签', archived: '归档', deleted: '废纸篓' },
  searchPlaceholder: '搜便签…',
  /** 服务端的搜索不跨废纸篓，所以那一档里干脆把搜索关掉，免得搜出别的档的便签。 */
  searchTrashOff: '废纸篓里不搜索',
  clearSearch: '清除',
  searchFound: (count: number) => `搜到 ${count} 条`,
  searchEmpty: (query: string) => `没有找到含「${query}」的便签。`,
  loading: '正在读取…',
  reload: '刷新',
  failed: '没成功：',

  // 空状态
  emptyLive: '还没有便签。上面写一句，按「记下来」就存住了。',
  emptyArchived: '归档里是空的。不想让它占着列表时，用「归档」收起来。',
  emptyTrash: '废纸篓是空的。删掉的便签先来这里，之后还能恢复。',

  // 卡片
  noTitle: '（无标题）',
  pickOne: '点一条便签看详情。',
  userPicked: '·你',
  userPickedTitle: '你手选的类别，AI 不会再改',
  aiBadge: '+AI',
  aiBadgeTitle: '这条便签 AI 整理过',
  aiStaleTitle: '基于更早的版本',
  aiWorking: 'AI 整理中…',
  aiPoints: '要点',
  aiTodos: '待办',
  aiDueHint: '提示的日期',
  todoCount: (count: number) => `待办 ${count} 项`,
  dueOn: (day: string) => `日期 ${day}`,
  isReminder: '已是提醒',
  related: '相似便签',
  sends: '投递历史',
  sendTargets: { 'new-chat': '新对话', 'current-chat': '当前对话', clipboard: '剪贴板' } as Record<string, string>,

  // 类别：存的是中文键，显示按语言来
  categoryNames: {
    工作: '工作', 想法: '想法', 待办: '待办', 参考: '参考', 生活: '生活', 未分类: '未分类',
  } as Record<string, string>,

  // 详情与编辑
  editText: '正文',
  editCategory: '类别',
  editTags: '标签',
  tagsPlaceholder: '用逗号分开，比如：家里, 报销',
  save: '保存',
  saved: '存好了。',
  resetEdit: '放弃修改',
  refresh: '重新读取',
  refreshHint: '这是服务端说的原话；重新读取后再改一遍。',
  categoryFromRule: '规则认出来的',
  categoryFromModel: 'AI 归的',
  categoryFromUser: '你手选的',

  // 按钮
  aiOrganize: '+AI 整理',
  organized: 'AI 整理好了。',
  remind: '设为提醒',
  remindPickDay: '先选一天',
  remindRepeat: '重复',
  repeats: { none: '不重复', weekly: '每周', monthly: '每月', yearly: '每年' } as Record<string, string>,
  reminderSet: (title: string) => `已经设成提醒：${title}`,
  toChat: '加到当前对话',
  chatOpened: '已经放进新对话的输入框，看一眼再发。',
  chatCopied: '这台 DSH 没有对话服务，已经复制到剪贴板。',
  copyFailed: '没能复制：浏览器没给剪贴板权限。',
  archive: '归档',
  restore: '恢复',
  remove: '删除',
  purge: '彻底删除',
  purgeConfirm: '这条便签会彻底删掉，找不回来了。',
  cancel: '取消',

  // 结果
  archived: '已归档。',
  deleted: '已放进废纸篓。',
  restored: '已恢复。',
  purged: '已彻底删除。',
  count: (live: number, archived: number, deleted: number) => `${live} 条便签，${archived} 条归档，${deleted} 条在废纸篓`,
}

const en: typeof zh = {
  title: 'Notes',

  capturePlaceholder: 'Write down whatever comes to mind…',
  captureSave: 'Save',
  captureHint: 'Ctrl / ⌘ + Enter saves too.',
  captureOrganize: 'Let AI tidy it after saving',
  captureOrganizeOff: 'Off in Settings ("let AI organise notes"): turn it on for this to take effect. Right now no note text leaves this computer',
  captureEmpty: 'Write something first.',
  captured: (title: string) => `Saved: ${title}`,
  duplicateHint: (title: string) => `You wrote something like this before: ${title}`,
  duplicateNote: 'Just a hint; both notes stay.',
  dismiss: 'Got it',
  dueSeen: (day: string, label: string) => (label === '' || label === day ? `Spotted a date: ${day}` : `Spotted a date: ${day} (${label})`),

  tabs: { live: 'Notes', archived: 'Archived', deleted: 'Trash' },
  searchPlaceholder: 'Search notes…',
  searchTrashOff: 'Search does not reach the trash',
  clearSearch: 'Clear',
  searchFound: (count: number) => `${count} found`,
  searchEmpty: (query: string) => `Nothing matching “${query}”.`,
  loading: 'Loading…',
  reload: 'Refresh',
  failed: 'Did not work: ',

  emptyLive: 'No notes yet. Write one above and press Save.',
  emptyArchived: 'Nothing archived. Use “Archive” to put a note away without deleting it.',
  emptyTrash: 'The trash is empty. Deleted notes wait here and can come back.',

  noTitle: '(no title)',
  pickOne: 'Pick a note to see it in full.',
  userPicked: ' · you',
  userPickedTitle: 'You picked this category by hand; AI will not change it',
  aiBadge: '+AI',
  aiBadgeTitle: 'AI has tidied this note',
  aiStaleTitle: 'based on an earlier version',
  aiWorking: 'AI tidying…',
  aiPoints: 'Points',
  aiTodos: 'To-do',
  aiDueHint: 'Date it suggests',
  todoCount: (count: number) => `${count} to-do`,
  dueOn: (day: string) => `dated ${day}`,
  isReminder: 'already a reminder',
  related: 'Similar notes',
  sends: 'Delivered to',
  sendTargets: { 'new-chat': 'a new chat', 'current-chat': 'this chat', clipboard: 'the clipboard' } as Record<string, string>,

  categoryNames: {
    工作: 'Work', 想法: 'Idea', 待办: 'To-do', 参考: 'Reference', 生活: 'Life', 未分类: 'Unsorted',
  } as Record<string, string>,

  editText: 'Text',
  editCategory: 'Category',
  editTags: 'Tags',
  tagsPlaceholder: 'Comma separated, e.g. home, expenses',
  save: 'Save',
  saved: 'Saved.',
  resetEdit: 'Discard changes',
  refresh: 'Read it again',
  refreshHint: 'That is the server’s own wording; read the note again and retry.',
  categoryFromRule: 'recognised by a rule',
  categoryFromModel: 'picked by AI',
  categoryFromUser: 'picked by you',

  aiOrganize: '+AI tidy',
  organized: 'AI tidied it.',
  remind: 'Make it a reminder',
  remindPickDay: 'Pick a day first',
  remindRepeat: 'Repeat',
  repeats: { none: 'never', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' } as Record<string, string>,
  reminderSet: (title: string) => `Now a reminder: ${title}`,
  toChat: 'Add to this chat',
  chatOpened: 'Put into a new chat’s input box; read it before sending.',
  chatCopied: 'This Host has no chat service, so it was copied to the clipboard.',
  copyFailed: 'Could not copy: the browser withheld the clipboard.',
  archive: 'Archive',
  restore: 'Restore',
  remove: 'Delete',
  purge: 'Delete for good',
  purgeConfirm: 'This note will be gone for good.',
  cancel: 'Cancel',

  archived: 'Archived.',
  deleted: 'Moved to the trash.',
  restored: 'Restored.',
  purged: 'Deleted for good.',
  count: (live: number, archived: number, deleted: number) => `${live} notes, ${archived} archived, ${deleted} in the trash`,
}

export type NotesText = typeof zh

export const NOTES_TEXT: Record<UiLang, NotesText> = { zh, en }
