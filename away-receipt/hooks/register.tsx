import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Receipt, RepoPart, Task, Test } from '../types'

// away-receipt：對話旁的 pane 列出「你離開期間發生了什麼」。
// 離開從你上次自己送出訊息（提示框或 Remote Control）算起；plugin 代送的（ctx-relay 接續、your-turn 回報）、
// 背景工作通知、排程觸發都不算你回來。
// 收據：第一行離開多久、跑了幾輪、花多少；每個動過的 repo 一段（新 commit、未 commit 檔、分支、別的 worktree）；
// 驗證（跑過的測試指令和 exit code，失敗的紅色）；背景工作（做完或失敗的子代理和 shell，失敗的紅色）。
// 你上次送出超過 20 分鐘、回來開始打字時自動打開（同一次離開只開一次；開了 Claude 還沒送出過不算），也可以打 /receipt 打開；
// pane 有焦點時按 q（或點「關閉」）或 ctrl+x x 關掉；自動打開時焦點在提示框，要先 ctrl+x tab。
//
// 離開期間的紀錄放模組變數：/clear 會把 $.state 歸零、模組變數保留（repo-ledger 實測），
// ctx-relay 在你離開時自動 /clear 接續，紀錄才不會斷。$.state 只放打開當下算好的收據，給 pane 畫。

const PANE = 'away-receipt'
const TITLE = '離開期間'

// 和 ctx-relay 同一組 dark-daltonized 可分辨色；失敗用同一組的 vermillion
const ORANGE = '#E69F00'
const SKY = '#56B4E9'
const LABEL = '#7d8794'
const VALUE = '#f5f7fa'
const RED = '#D55E00'
const GIT = '󰊢' // Nerd Font md-git U+F02A2

// 離開超過這麼久，回來打字時自動打開
const AWAY_MS = 20 * 60_000
// 新 commit、未 commit 檔各最多列幾條，其餘寫「還有 N 個」
const MAX_ITEMS = 10

// 算測試的指令：常見測試工具、型別檢查、claude plugin test／validate。單獨的 test（shell 的 test -f）不算
const TEST_RE = /\b(?:(?:npm|pnpm|yarn|bun|deno|cargo|go|make|just|mix|dotnet|gradle|mvn|swift|zig)\s+(?:run\s+)?test|pytest|unittest|bats|jest|vitest|mocha|prove|rspec|phpunit|ctest|tox|tsc|claude\s+plugin\s+(?:test|validate))\b/

const receiptAtom = atom({ plugin: 'away-receipt', key: 'receipt' } as const, null as Receipt | null)

// 這次離開的紀錄
let since = 0 // 你上次送出訊息的時間（$.clock.now()）；0＝還沒開始算
let turns = 0 // 主對話跑完的輪數（子代理的不算）
let spent = 0 // 花費（USD）
let lastCost = 0 // 上次讀到的 session 累計花費
let isShown = false // 這次離開已經自動打開過
let hasSubmitted = false // 你送出過訊息；開了 Claude 還沒送出就放著，回來打字不算「離開回來」
const tests = new Map<string, Test>()
const tasks: Task[] = []
const roots: string[] = [] // 動過的 repo 根目錄（第一次碰到的順序）
// 目錄 → repo 根目錄；不是 repo 記 null，不重問 git（跨離開保留）
const rootOf = new Map<string, string | null>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // reload、/clear 都會重跑：已經在算就不重來
    if (since === 0) {
      since = await $.clock.now()
      await costDelta($)
    }
    // 名稱衝突會丟例外，包住免得中斷 hook
    try {
      await $.command.register({ name: 'receipt', description: 'away-receipt：打開離開期間的收據' })
    } catch (err) {
      $.ui.log(`[away-receipt] 註冊 /receipt 失敗：${String(err)}`)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      // 你自己送出：重新開始算
      since = await $.clock.now()
      await costDelta($)
      turns = 0
      spent = 0
      isShown = false
      hasSubmitted = true
      tests.clear()
      tasks.length = 0
      roots.length = 0
    } else if (e.origin.kind === 'task-notification') {
      // 一則通知可能帶好幾個背景工作，各自一個 <task-notification> 區塊
      for (const block of e.text.split('<task-notification>').slice(1)) {
        const status = /<status>([^<]*)<\/status>/.exec(block)?.[1]?.trim()
        if (!status) continue
        tasks.push({ status, summary: /<summary>([^<]*)<\/summary>/.exec(block)?.[1]?.trim() || status })
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      turns += 1
      spent += await costDelta($)
    }
    return result
  })

  // 主對話和子代理的工具都算
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      if (result.isError === true) return result
      const file = await absolute($, await $.session.cwd(), e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path)
      await track($, dirname(file))
    } else if (e.tool === 'Bash') {
      const cwd = await $.session.cwd()
      const dirs = commandDirs(e.command)
      // 沒有 cd／git -C 就跑 git：在工作目錄跑的
      if (/\bgit\b/.test(e.command) && !MOVE_RE.test(e.command)) dirs.push(cwd)
      for (const dir of dirs) await track($, await absolute($, cwd, dir))
      // 丟到背景跑的看不到結束；結束時的通知列在背景工作
      const isBackground = result.isError !== true && typeof (result.result as { backgroundTaskId?: unknown }).backgroundTaskId === 'string'
      if (TEST_RE.test(e.command) && !isBackground) {
        const cmd = e.command.trim().split('\n')[0] ?? ''
        const code = result.isError === true ? exitCode(result.text) : 0
        tests.set(cmd, { cmd, code, runs: (tests.get(cmd)?.runs ?? 0) + 1 })
      }
    }
    return result
  })

  // 你回來開始打字：草稿從空變成有字、距離上次送出超過 20 分鐘，這次離開還沒自動打開過。
  // 主動打開：終端機 ≥144 欄才畫（/receipt 開過一次後降到 110 欄），沒畫出來就跳 toast。
  // 不要焦點：你正在打字，鍵盤留在提示框
  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    if (!hasSubmitted || isShown || e.text !== '' || e.inputText === '') return result
    if ((await $.clock.now()) - since <= AWAY_MS) return result
    isShown = true
    const receipt = await snapshot($)
    try {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      if (!opened.isPlaced) $.ui.toast(`away-receipt：離開 ${duration(receipt.awayMs)}，終端機太窄沒畫出來，打 /receipt 看收據`, { timeoutMs: 8000 })
    } catch (err) {
      $.ui.log(`[away-receipt] 打開 pane 失敗：${String(err)}`)
    }
    return result
  })

  // 你打的指令＝asked：任何寬度都畫
  on('command.run', { command: 'receipt' }, async $ => {
    await snapshot($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: '[away-receipt] 已打開收據' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, receiptAtom)
    if (r === null) return <Box flexDirection="column"><Text color={LABEL}>還沒有收據，打 /receipt</Text></Box>
    const lines: RenderElement[] = []
    // 每行一個帶 key 的 Box：太長截斷
    const line = (key: string, ...parts: RenderElement[]) => lines.push(<Box key={key}><Text wrap="truncate-end">{parts}</Text></Box>)
    const gap = (key: string) => lines.push(<Box key={key}><Text>{' '}</Text></Box>)
    const more = (key: string, n: number, unit: string) => {
      if (n > MAX_ITEMS) line(key, <Text color={LABEL}>{`    還有 ${n - MAX_ITEMS} ${unit}`}</Text>)
    }

    line('head',
      <Text color={LABEL}>離開 </Text>, <Text color={VALUE} bold>{duration(r.awayMs)}</Text>,
      <Text color={LABEL}> · 跑了 </Text>, <Text color={VALUE} bold>{String(r.turns)}</Text>, <Text color={LABEL}> 輪 · </Text>,
      <Text color={VALUE} bold>{`$${r.usd.toFixed(2)}`}</Text>)

    r.repos.forEach((repo, i) => {
      gap(`repo-${i}-gap`)
      const isClean = repo.commits.length === 0 && repo.files.length === 0
      line(`repo-${i}`, <Text color={SKY} bold>{`${GIT} ${repo.name}`}</Text>, <Text color={VALUE}>{` (${repo.branch})`}</Text>,
        isClean ? <Text color={LABEL}>{' ✓ 沒有新 commit、沒有未 commit 檔'}</Text> : <Text>{''}</Text>)
      if (repo.commits.length > 0) line(`repo-${i}-commits`, <Text color={LABEL}>{`  新 commit ${repo.commits.length} 個`}</Text>)
      repo.commits.slice(0, MAX_ITEMS).forEach((c, j) => {
        const [hash = '', ...subject] = c.split(' ')
        line(`repo-${i}-c${j}`, <Text color={ORANGE}>{`    ${hash}`}</Text>, <Text color={VALUE}>{` ${subject.join(' ')}`}</Text>)
      })
      more(`repo-${i}-cmore`, repo.commits.length, '個')
      if (repo.files.length > 0) line(`repo-${i}-files`, <Text color={LABEL}>{`  未 commit ${repo.files.length} 檔`}</Text>)
      repo.files.slice(0, MAX_ITEMS).forEach((f, j) => line(`repo-${i}-f${j}`, <Text color={VALUE}>{`    ${f}`}</Text>))
      more(`repo-${i}-fmore`, repo.files.length, '檔')
      repo.worktrees.forEach((w, j) => line(`repo-${i}-w${j}`, <Text color={LABEL}>{`  ⎇ ${w}`}</Text>))
    })

    if (r.tests.length > 0) {
      gap('tests-gap')
      line('tests', <Text color={VALUE} bold>驗證</Text>)
      r.tests.forEach((t, j) => {
        const isOk = t.code === 0
        const runs = t.runs > 1 ? ` ×${t.runs}` : ''
        line(`test-${j}`, <Text color={isOk ? LABEL : RED}>{`  ${isOk ? '✔' : '✗'} exit ${t.code ?? '?'}${runs}  `}</Text>,
          <Text color={isOk ? VALUE : RED}>{t.cmd}</Text>)
      })
    }

    if (r.tasks.length > 0) {
      gap('tasks-gap')
      line('tasks', <Text color={VALUE} bold>背景工作</Text>)
      r.tasks.forEach((t, j) => {
        const isOk = t.status === 'completed'
        line(`task-${j}`, <Text color={isOk ? LABEL : RED}>{`  ${isOk ? '✔' : '✗'} `}</Text>,
          <Text color={isOk ? VALUE : RED}>{isOk ? t.summary : `${t.summary}（${t.status}）`}</Text>)
      })
    }

    if (r.repos.length === 0 && r.tests.length === 0 && r.tasks.length === 0) {
      gap('none-gap')
      line('none', <Text color={LABEL}>這段時間沒有動到 repo、沒跑測試、沒有背景工作</Text>)
    }

    return (
      <Box flexDirection="column">
        {lines}
        <Box marginTop={1}>
          <Button key="close" plain hotkey="q" label="關閉" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

// 算好打開當下的收據，存給 pane 畫
async function snapshot($: EngineInterface): Promise<Receipt> {
  spent += await costDelta($)
  const now = await $.clock.now()
  const repos: RepoPart[] = []
  for (const root of roots) {
    const part = await inspect($, root, since)
    if (part !== null) repos.push(part)
  }
  const receipt = { awayMs: now - since, turns, usd: spent, repos, tests: [...tests.values()], tasks: [...tasks] }
  await update($, receiptAtom, () => receipt)
  return receipt
}

// 從上次讀到現在花了多少。/clear 可能讓 session 累計重來：比上次少就當成從 0 起算
async function costDelta($: EngineInterface): Promise<number> {
  const usd = (await $.session.usage()).cost?.usd ?? 0
  const delta = usd >= lastCost ? usd - lastCost : usd
  lastCost = usd
  return delta
}

// Bash 回報錯誤時的文字開頭是「Exit code N」；看不出來回 null
function exitCode(text: string | undefined): number | null {
  const m = /Exit code (\d+)/.exec(text ?? '')
  return m ? Number(m[1]) : null
}

function duration(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`
}

// Bash 指令裡 cd／pushd／git -C 後面的路徑；帶 $ 或反引號的看不穿，不認（同 repo-ledger）
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

// 目錄所屬 repo 加進這次離開動過的清單
async function track($: EngineInterface, dir: string): Promise<void> {
  let root = rootOf.get(dir)
  if (root === undefined) {
    const run = await $.process.run(['git', '-C', dir, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    root = run.exitCode === 0 ? run.stdout.trim() || null : null
    rootOf.set(dir, root)
  }
  if (root !== null && !roots.includes(root)) roots.push(root)
}

// 一個 repo 的一段；git 失敗（repo 不見了）回 null。repo 自己設的 core.fsmonitor 一律關掉
async function inspect($: EngineInterface, root: string, from: number): Promise<RepoPart | null> {
  const git = (...args: string[]) => $.process.run(['git', '-C', root, '-c', 'core.fsmonitor=false', ...args], { timeoutMs: 10_000 })
  const status = await git('status', '--porcelain=v1', '--branch')
  if (status.exitCode !== 0) return null
  const [head = '', ...files] = status.stdout.split('\n')
  const log = await git('log', `--since=@${Math.floor(from / 1000)}`, '--format=%h %s')
  const worktrees = await git('worktree', 'list', '--porcelain')
  return {
    name: root.split('/').filter(Boolean).at(-1) ?? root,
    branch: branchOf(head),
    commits: log.exitCode === 0 ? log.stdout.split('\n').filter(l => l.trim() !== '') : [],
    files: files.filter(l => l.trim() !== ''),
    worktrees: worktrees.exitCode === 0 ? otherWorktrees(worktrees.stdout, root) : [],
  }
}

// `## master...origin/master [ahead 1]`、`## No commits yet on main`、`## HEAD (no branch)`（同 repo-ledger）
function branchOf(head: string): string {
  const text = head.replace(/^## /, '')
  const unborn = /^No commits yet on (\S+)/.exec(text)
  if (unborn) return unborn[1] ?? text
  return text.split(/\.\.\.| /)[0] ?? text
}

// `git worktree list --porcelain`：每個 worktree 一段，空行隔開；列出 root 以外的「路徑 (分支)」
function otherWorktrees(out: string, root: string): string[] {
  return out.split('\n\n').flatMap(block => {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined || path === root) return []
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? 'detached'
    return [`${path} (${branch})`]
  })
}
