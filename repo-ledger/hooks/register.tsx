import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Ledger, RepoRow } from '../types'

// repo-ledger：提示框上方一行，列出這個對話動過、還沒 commit 的 repo。
// 追蹤哪些 repo：Edit／Write／NotebookEdit 的檔案路徑、Bash 指令裡 cd／git -C 後面的字面路徑（有 $ 或反引號的不認），
// 以及沒有 cd 就跑 git 時的工作目錄。工作目錄本身不會一開場就列：對話動到它之前，裡面原有的改動不算。
// 什麼時候重算：每輪結束、Bash 跑過 git 指令之後、第一次碰到新 repo 時。
// 沒有未 commit 的檔、本輪也沒改檔時整行不畫（只剩未 push 的 commit 不算）。
//
// /clear 之後 $.state 歸零、模組變數保留；hot reload 反過來（ctx-relay P1 probe 實測）。
// 所以追蹤清單兩邊各存一份：模組變數撐過 clear，$.state 撐過 reload，session.start（reload 會重跑）把兩邊合併。

// 和 ctx-relay 同一組 dark-daltonized 可分辨色
const ORANGE = '#E69F00'
const SKY = '#56B4E9'
const LABEL = '#7d8794'
const VALUE = '#f5f7fa'
const GIT = '󰊢' // Nerd Font md-git U+F02A2
// 本輪改超過這麼多檔，檔數變橘色（「改太大了」的早期提醒）
const WIDE_TURN = 5

const ledgerAtom = atom({ plugin: 'repo-ledger', key: 'ledger' } as const, { rows: [], turnFiles: 0 } as Ledger)
const rootsAtom = atom({ plugin: 'repo-ledger', key: 'roots' } as const, [] as string[])

// 追蹤中的 repo 根目錄（加入順序）
const roots: string[] = []
// 目錄 → repo 根目錄；不是 repo 記 null，不重問 git
const rootOf = new Map<string, string | null>()
// 本輪 Edit／Write 過的檔案（含子代理的）
const turnFiles = new Set<string>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    for (const root of await read($, rootsAtom)) {
      if (!roots.includes(root)) roots.push(root)
    }
    if (roots.length > 0) await refresh($)
    return result
  })

  // 只有主對話有 turn.start：你送出訊息就是新的一輪
  on('turn.start', async ($, e, next) => {
    turnFiles.clear()
    await update($, ledgerAtom, l => ({ ...l, turnFiles: 0 }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const file = await absolute($, await $.session.cwd(), e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path)
      const isNew = await track($, dirname(file))
      // 只算 repo 裡的檔（scratchpad 這類暫存檔不算）
      if (rootOf.get(dirname(file))) turnFiles.add(file)
      if (isNew) await refresh($)
      await update($, ledgerAtom, l => ({ ...l, turnFiles: turnFiles.size }))
    } else if (e.tool === 'Bash') {
      const cwd = await $.session.cwd()
      const runsGit = /\bgit\b/.test(e.command)
      const dirs = commandDirs(e.command)
      // 完全沒有 cd／git -C 就跑 git：在工作目錄跑的（有但看不穿的，不猜）
      if (runsGit && !MOVE_RE.test(e.command)) dirs.push(cwd)
      let isNew = false
      for (const dir of dirs) {
        if (await track($, await absolute($, cwd, dir))) isNew = true
      }
      if (isNew || runsGit) await refresh($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    // band 只有一個：先讓排在下面的 mod 畫，自己這行疊在它下面
    const below = await next(e)
    const mine = await drawBand($, e)
    if (mine === null) return below
    if (!below) return mine
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  })
}

// Bash 指令裡 cd／pushd／git -C 後面的路徑；帶 $ 或反引號的看不穿，不認
const DIR_RE = /(?:^|[\s;&|(])(?:cd|pushd)\s+(?:--\s+)?('[^']*'|"[^"]*"|[^\s;&|)]+)|\bgit\s+-C\s+('[^']*'|"[^"]*"|[^\s;&|)]+)/g
const MOVE_RE = /(?:^|[\s;&|(])(?:cd|pushd)\s|\bgit\s+-C\s/

function commandDirs(command: string): string[] {
  const dirs: string[] = []
  for (const m of command.matchAll(DIR_RE)) {
    const dir = (m[1] ?? m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    if (dir === '' || dir === '-' || /[$`]/.test(dir)) continue
    dirs.push(dir)
  }
  return dirs
}

async function absolute($: EngineInterface, cwd: string, path: string): Promise<string> {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}`
  return `${cwd}/${path}`
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

// 目錄所屬 repo 加進追蹤；回傳是否新加入
async function track($: EngineInterface, dir: string): Promise<boolean> {
  let root = rootOf.get(dir)
  if (root === undefined) {
    const run = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    root = run.exitCode === 0 ? run.stdout.trim() || null : null
    rootOf.set(dir, root)
  }
  if (root === null || roots.includes(root)) return false
  roots.push(root)
  await update($, rootsAtom, () => [...roots])
  return true
}

async function refresh($: EngineInterface): Promise<void> {
  const rows: RepoRow[] = []
  for (const root of roots) {
    const row = await inspect($, root)
    if (row !== null) rows.push(row)
  }
  await update($, ledgerAtom, l => ({ ...l, rows }))
  // /clear 把 $.state 歸零後，下一次重算就把模組變數的清單寫回去，之後的 hot reload 才讀得到
  await update($, rootsAtom, () => [...roots])
}

async function inspect($: EngineInterface, root: string): Promise<RepoRow | null> {
  const status = await $.process.run(['git', '-C', root, 'status', '--porcelain=v1', '--branch'], { timeoutMs: 10_000 })
  if (status.exitCode !== 0) return null
  const [head = '', ...files] = status.stdout.split('\n')
  const worktrees = await $.process.run(['git', '-C', root, 'worktree', 'list', '--porcelain'], { timeoutMs: 5000 })
  const others = worktrees.exitCode === 0 ? worktrees.stdout.split('\n').filter(l => l.startsWith('worktree ')).length - 1 : 0
  return {
    root,
    name: root.split('/').filter(Boolean).at(-1) ?? root,
    branch: branchOf(head),
    dirty: files.filter(l => l.trim() !== '').length,
    ahead: Number(/\[ahead (\d+)/.exec(head)?.[1] ?? 0),
    worktrees: Math.max(0, others),
  }
}

// `## master...origin/master [ahead 1]`、`## No commits yet on main`、`## HEAD (no branch)`
function branchOf(head: string): string {
  const text = head.replace(/^## /, '')
  const unborn = /^No commits yet on (\S+)/.exec(text)
  if (unborn) return unborn[1] ?? text
  return text.split(/\.\.\.| /)[0] ?? text
}

// 沒有東西要畫時回 null
async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<RenderElement | null> {
  const ledger = await read($, ledgerAtom)
  const isPending = ledger.rows.some(r => r.dirty > 0)
  if (!isPending && ledger.turnFiles === 0) return null
  const { Box, Text } = $.ui.resolve(e)
  const parts: RenderElement[] = []
  ledger.rows.forEach((r, i) => {
    if (i > 0) parts.push(<Text color={LABEL}>{' · '}</Text>)
    const isClean = r.dirty === 0 && r.ahead === 0
    parts.push(<Text color={isClean ? LABEL : VALUE}>{`${r.name}(${r.branch})`}</Text>)
    parts.push(isClean ? <Text color={LABEL}>{' ✓'}</Text> : <Text color={ORANGE} bold>{r.dirty > 0 ? ` ${r.dirty}` : ''}</Text>)
    if (r.ahead > 0) parts.push(<Text color={SKY}>{` ↑${r.ahead}`}</Text>)
    if (r.worktrees > 0) parts.push(<Text color={LABEL}>{` ⎇${r.worktrees}`}</Text>)
  })
  if (ledger.turnFiles > 0) {
    parts.push(<Text color={LABEL}>{' · 本輪 '}</Text>)
    parts.push(<Text color={ledger.turnFiles > WIDE_TURN ? ORANGE : VALUE} bold={ledger.turnFiles > WIDE_TURN}>{`${ledger.turnFiles}`}</Text>)
    parts.push(<Text color={LABEL}>{' 檔'}</Text>)
  }
  return (
    <Box flexDirection="row">
      <Text color={LABEL} wrap="truncate-end">
        {` ${GIT} `}
        {parts}
      </Text>
    </Box>
  )
}
