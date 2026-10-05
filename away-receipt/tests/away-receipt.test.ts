import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput } from 'claude-code'

const RED = '#D55E00'
const HOME = '/home/u'
const CWD = '/work/app'
const MIN = 60_000

// 測試裡的 git：每個 repo 的分支、未 commit 檔、新 commit、別的 worktree
type Repo = { branch: string; files: string[]; commits: string[]; worktrees: string[] }
// placed＝false 模擬終端機太窄、pane 沒畫出來
type World = { cost: number; placed: boolean; opens: { id: string; focus?: boolean }[]; closes: string[]; toasts: string[]; gitCalls: string[][] }

function world(on: On, repos: Record<string, Partial<Repo>> = {}): World {
  const w: World = { cost: 0, placed: true, opens: [], closes: [], toasts: [], gitCalls: [] }
  const all = new Map(Object.entries(repos).map(([root, r]) => [root, { branch: 'main', files: [], commits: [], worktrees: [], ...r }]))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.edit', (_$, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200_000 }, rateLimits: [], cost: { usd: w.cost } } }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: HOME }))
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, focus: e.focus })
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'below 144 columns' } }
  })
  on('ui.close', (_$, e) => {
    w.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  // 指令含 FAIL 的回報錯誤（Bash 錯誤文字開頭是 Exit code N）；含 BG 的丟到背景
  on('tool.call', (_$, e) => {
    const s = JSON.stringify(e)
    if (s.includes('FAIL')) return { result: {}, isError: true, text: 'Exit code 2\nboom' } as never
    return { result: { stdout: '', stderr: '', interrupted: false, ...(s.includes('BG') ? { backgroundTaskId: 'b1' } : {}) } } as never
  })
  on('process.run', (_$, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // -c key=value 不影響假 git 的回答，比對前拿掉
    const [cmd, , dir = '', sub, ...rest] = e.argv.filter((a, i, argv) => a !== '-c' && argv[i - 1] !== '-c')
    if (cmd !== 'git') return ok('', 127)
    w.gitCalls.push([...e.argv])
    const root = [...all.keys()].find(r => dir === r || dir.startsWith(`${r}/`))
    const repo = root === undefined ? undefined : all.get(root)
    if (root === undefined || repo === undefined) return ok('', 128)
    if (sub === 'rev-parse') return ok(`${root}\n`)
    if (sub === 'status') return ok([`## ${repo.branch}...origin/${repo.branch}`, ...repo.files, ''].join('\n'))
    if (sub === 'log') return ok(repo.commits.map(c => `${c}\n`).join(''))
    if (sub === 'worktree' && rest[0] === 'list') {
      return ok([root, ...repo.worktrees].map((p, i) => `worktree ${p}\nHEAD abc\nbranch refs/heads/${i === 0 ? repo.branch : `wt${i}`}\n`).join('\n'))
    }
    return ok('', 1)
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function say($: Engine, text = '去做吧') {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

// 你在提示框打字：draft＝打之前的草稿，typed＝這次打進去的字。
// 測試引擎執行時有 $.prompt.edit，但型別（Claude Code 2.1.289）的 EventCalls 沒列，只好轉型
async function type($: Engine, draft: string, typed: string) {
  const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }
  await prompt.edit({ origin: { kind: 'composer' }, text: draft, cursor: draft.length, start: draft.length, end: draft.length, inputText: typed })
}

async function endTurn($: Engine, agentId?: string) {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

async function receipt($: Engine) {
  return $.command.run({ command: 'receipt', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

// 同一個 pane id 只能掛一次：每個測試掛一次，之後用 view() 讀當下畫面
async function mount($: Engine) {
  return $.ui.mount({
    plugin: 'away-receipt',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'away-receipt',
    props: { title: '離開期間', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

type Pane = Awaited<ReturnType<typeof mount>>

// lines＝每行文字（有 key 的 Box，空行不算）；red＝紅色的字
async function view(ui: Pane) {
  const texts = await ui.findAll({ type: 'Text' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key !== undefined && b.key !== null)
  return {
    lines: rows.map(b => b.text).filter(t => t.trim() !== ''),
    red: texts.filter(t => t.props.color === RED).map(t => t.text.trim()),
  }
}

test('/receipt：第一行是離開多久、跑了幾輪、花多少，從你上次送出算起；plugin 代送的不算你回來；子代理回合不算', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on, { now: 1_000 * MIN })
  await start($)
  w.cost = 0.5
  await endTurn($)
  // 你送出：從這裡重算，之前的 $0.50 和那一輪不算
  w.cost = 1
  await say($)
  w.cost = 2
  await endTurn($)
  await endTurn($, 'agent-1')
  await $.prompt.submit({ text: '接續', wait: false, origin: { kind: 'plugin', name: 'ctx-relay', asUser: true } })
  w.cost = 5.1
  await endTurn($)
  await clock.advance(7 * 60 * MIN + 12 * MIN)
  const run = await receipt($)
  expect(run.text).toBe('[away-receipt] 已打開收據')
  expect(w.opens).toEqual([{ id: 'away-receipt', focus: true }])
  const v = await view(await mount($))
  expect(v.lines[0]).toBe('離開 7h12m · 跑了 2 輪 · $4.10')
  expect(v.lines).toContain('這段時間沒有動到 repo、沒跑測試、沒有背景工作')
})

test('repo 段：動過的 repo 列分支、新 commit、未 commit 檔、別的 worktree，超過 10 條寫還有 N 個；git 一律關掉 fsmonitor、commit 從你送出時算', async ($, on) => {
  const w = world(on, {
    [CWD]: { branch: 'main', files: [' M src/x.ts', '?? new.ts'], commits: ['4a94b5c 加功能', '9ce1434 修 bug'], worktrees: ['/work/app-wt1'] },
    '/srv/lib': {},
    '/srv/other': { files: [' M y'] },
    '/srv/big': { commits: Array.from({ length: 12 }, (_, i) => `c${i} 第 ${i} 個`) },
  })
  mock.clock(on, { now: 1_000 * MIN })
  await start($)
  await say($)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/x.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'cd /srv/lib && ls' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /srv/big log -1' })
  await receipt($)
  const v = await view(await mount($))
  // 新 commit 超過 10 個：列前 10 個，其餘寫「還有 N 個」
  expect(v.lines.slice(-3)).toEqual(['    c8 第 8 個', '    c9 第 9 個', '    還有 2 個'])
  expect(v.lines.slice(1, -13)).toEqual([
    '󰊢 app (main)',
    '  新 commit 2 個',
    '    4a94b5c 加功能',
    '    9ce1434 修 bug',
    '  未 commit 2 檔',
    '     M src/x.ts',
    '    ?? new.ts',
    '  ⎇ /work/app-wt1 (wt1)',
    '󰊢 lib (main) ✓ 沒有新 commit、沒有未 commit 檔',
  ])
  // 沒動過的 /srv/other 不列；每個 git 都帶 -c core.fsmonitor=false
  expect(w.gitCalls.every(a => a.includes('core.fsmonitor=false'))).toBe(true)
  expect(w.gitCalls.find(a => a.includes('log'))).toContain(`--since=@${60_000}`)
})

test('驗證段：測試指令與 exit code，失敗的紅色；重跑記次數；shell 的 test -f、一般指令、丟背景的不算', async ($, on) => {
  world(on)
  mock.clock(on)
  await start($)
  await say($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npx tsc -p . # FAIL' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'test -f a.txt && echo yes' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q # BG' })
  await receipt($)
  const v = await view(await mount($))
  expect(v.lines.slice(1)).toEqual(['驗證', '  ✔ exit 0 ×2  npm test', '  ✗ exit 2  npx tsc -p . # FAIL'])
  expect(v.red).toEqual(['✗ exit 2', 'npx tsc -p . # FAIL'])
})

test('背景工作：通知裡做完和失敗的子代理、shell，失敗的紅色；你送出後重算', async ($, on) => {
  world(on)
  mock.clock(on)
  await start($)
  await $.prompt.submit({ text: '<task-notification><status>completed</status><summary>舊的</summary></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  await say($)
  await $.prompt.submit({
    text: [
      '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "研究 API" finished</summary>\n</task-notification>',
      '<task-notification>\n<task-id>b2</task-id>\n<status>failed</status>\n<summary>Background command "npm run build" failed (exit code 1)</summary>\n</task-notification>',
    ].join('\n'),
    wait: false,
    origin: { kind: 'task-notification' },
  })
  await receipt($)
  const v = await view(await mount($))
  expect(v.lines.slice(1)).toEqual([
    '背景工作',
    '  ✔ Agent "研究 API" finished',
    '  ✗ Background command "npm run build" failed (exit code 1)（failed）',
  ])
  expect(v.red).toContain('Background command "npm run build" failed (exit code 1)（failed）')
})

test('回來打字自動打開：送出過、離開超過 20 分鐘、草稿從空變有字才開，不要焦點；同一次離開只開一次；你送出後重算', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await start($)
  // 開了 Claude 還沒送出過：放再久，回來打字也不開
  await clock.advance(25 * MIN)
  await type($, '', 'h')
  expect(w.opens).toEqual([])
  await say($)
  await clock.advance(19 * MIN)
  await type($, '', 'h')
  expect(w.opens).toEqual([])
  await clock.advance(2 * MIN)
  // 草稿本來就有字：不是「開始打字」
  await type($, 'h', 'i')
  expect(w.opens).toEqual([])
  await type($, '', 'h')
  expect(w.opens).toEqual([{ id: 'away-receipt', focus: undefined }])
  expect((await view(await mount($))).lines[0]).toBe('離開 21m · 跑了 0 輪 · $0.00')
  // 同一次離開：清掉重打不再開
  await type($, '', 'x')
  expect(w.opens).toHaveLength(1)
  // 你送出後重新算，下次離開超過 20 分鐘再開
  await say($)
  await clock.advance(21 * MIN)
  await type($, '', 'h')
  expect(w.opens).toHaveLength(2)
  expect(w.toasts).toEqual([])
})

test('自動打開時終端機太窄沒畫出來：跳 toast 提示打 /receipt', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await start($)
  await say($)
  w.placed = false
  await clock.advance(63 * MIN)
  await type($, '', 'h')
  expect(w.toasts).toEqual(['away-receipt：離開 1h3m，終端機太窄沒畫出來，打 /receipt 看收據'])
})

test('按 q（關閉）關掉 pane', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await start($)
  await receipt($)
  const ui = await mount($)
  await ui.press({ key: 'close' })
  expect(w.closes).toEqual(['away-receipt'])
})
