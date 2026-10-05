import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentStatus, On, SessionContextBreakdown } from 'claude-code'

const ROOT = '/repo/.git/harness'

// 8 欄齊全、硬約束四鍵有值的 fork 輸出：fork 只寫 ASCII 鍵名分段，中文標題由 mod 補
const GOOD = [
  'SLUG: demo-task',
  '=== GOAL ===', '做 demo',
  '=== FILES ===', 'a.ts',
  '=== VERIFIED ===', '單元測試過；e2e 未跑',
  '=== DIRTY ===', '無',
  '=== NEXT ===', '跑 e2e',
  '=== NOTES ===', '門檻 433840',
  '=== CONSTRAINTS ===', '```yaml', 'stop_status: 不 commit', 'unresolved_prerequisite: none', 'responsible_authority: 使用者', 'admissible_fallback: none', '```',
  '=== POINTERS ===', '~/.claude/plans/x.md',
].join('\n')

// 測試裡的「引擎」：usage、git、檔案、fork、clear 都由這裡回答
type World = {
  tokens: number
  window: number
  // 引擎回報的壓縮點（breakdown.autoCompactThreshold）
  fuse: number
  cost: number
  sessionId: string
  files: Map<string, string>
  forkText: string | null
  forkPrompts: string[]
  // 設了就讓 fork 卡住，直到測試放行（模擬準備期間的等待）
  hold: Promise<void> | null
  // 寫檔時改寫內容（模擬寫壞）
  corrupt: ((s: string) => string) | null
  agents: { id: string; description: string; status: AgentStatus }[]
  // 主對話停下時 classic.Stop 回報的背景工作與排程
  background: { id: string; type: string; description: string }[]
  crons: { id: string; recurring: boolean; prompt: string }[]
  // 設了就讓 settings 的 Stop hook 擋下（回合其實沒結束）
  stopBlock: string | null
  messages: { role: 'user' | 'assistant'; text: string }[]
  submitted: string[]
  failSubmit: boolean
  failWrite: boolean
  failGitStatus: boolean
  // mod 執行的 /clear 次數（你手動 clear 不算）
  cleared: number
  // 照實測模擬一次 /clear：發 session.end、$.state 歸零、換 session id；session.start 不重跑、模組變數保留
  clear: () => Promise<void>
}

function world($: Engine, on: On, patch: Partial<World> = {}): World {
  // $.state 由測試自己保管，clear 才能把它歸零（引擎實測行為）
  const state = new Map<string, { value: unknown; version: number }>()
  const w: World = {
    tokens: 0,
    window: 1_000_000,
    // ×85%＝433840，沿用舊版 lib 推算的交接線，下面的數字都以它為準
    fuse: 510_400,
    cost: 0,
    sessionId: 'sid-1',
    files: new Map(),
    forkText: GOOD,
    forkPrompts: [],
    hold: null,
    corrupt: null,
    agents: [],
    background: [],
    crons: [],
    stopBlock: null,
    messages: [],
    submitted: [],
    failSubmit: false,
    failWrite: false,
    failGitStatus: false,
    cleared: 0,
    clear: async () => {
      await $.session.end({ reason: 'clear', sessionId: w.sessionId, resume: { id: w.sessionId } })
      state.clear()
      w.sessionId = `${w.sessionId}+`
    },
    ...patch,
  }
  on('state.get', (_$, e) => {
    const s = state.get(`${e.plugin}/${e.key}`)
    return { value: { value: s?.value, version: s?.version ?? 0 } }
  })
  on('state.set', (_$, e) => {
    const k = `${e.plugin}/${e.key}`
    const version = state.get(k)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state.set(k, { value: e.value, version: version + 1 })
    return { value: { isSet: true, version: version + 1 } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => (w.stopBlock === null ? {} : { block: w.stopBlock }))
  // 引擎自己在 band 不畫任何東西：回一個空 Box（hook 必須回 tree，不能回 null）
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => $$.ui.resolve(e).Box({}))
  on('session.usage', (_$, e) => {
    // 只填 mod 會讀的欄位
    const breakdown = e.breakdown ? { breakdown: { autoCompactThreshold: w.fuse } as SessionContextBreakdown } : {}
    return { value: { startedAt: 0, context: { tokens: w.tokens, window: w.window, ...breakdown }, rateLimits: [], cost: { usd: w.cost } } }
  })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: w.messages.map(m => ({ ...m, toolUses: [] })) }))
  on('agent.list', () => ({ value: w.agents.map(a => ({ ...a, type: 'general-purpose' })) }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', async (_$, e) => {
    if (e.command === 'clear') {
      w.cleared += 1
      await w.clear()
    }
    return {}
  })
  on('prompt.submit', (_$, e) => {
    if (w.failSubmit && e.origin.kind !== 'composer') return { drop: 'settings hook 擋下' }
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('model.fork', async (_$, e) => {
    w.forkPrompts.push(e.prompt)
    if (w.hold) await w.hold
    return w.forkText === null
      ? { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
      : { value: { isAnswered: true as const, text: w.forkText, usage: { input_tokens: 10, output_tokens: 900, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } } }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    if (w.failWrite) throw new Error('EACCES')
    const text = String(e.text)
    w.files.set(e.path, w.corrupt ? w.corrupt(text) : text)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [cmd, , script = ''] = e.argv
    if (cmd === 'bash' && script.includes('--git-common-dir')) return ok(`${ROOT}\n`)
    if (cmd === 'mkdir') return ok('')
    if (cmd === 'git') {
      const sub = e.argv[3]
      if (sub === 'rev-parse') return ok('master\n')
      if (sub === 'status') return w.failGitStatus ? ok('', 128) : ok(' M a.ts\n')
      if (sub === 'log') return ok('abc123 init\n')
      return ok('')
    }
    return ok('', 127)
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

async function turn($: Engine, w: World, tokens: number, extra: { answer?: string; agentId?: string; aborted?: boolean } = {}) {
  w.tokens = tokens
  w.cost += 0.5
  await $.turn.complete({
    answer: extra.answer ?? 'done',
    durationMs: 12_000,
    isAborted: extra.aborted === true,
    turnId: `t-${tokens}`,
    reason: extra.aborted ? 'aborted' : 'answer',
    usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 990, model: 'claude-opus-5-5' },
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  })
  // 主對話正常結束才有 Stop（子代理是 SubagentStop；中斷不跑 Stop）
  if (extra.agentId || extra.aborted) return
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: w.background.map(t => ({ ...t, status: 'running' })),
    session_crons: w.crons.map(c => ({ ...c, schedule: '0 9 * * *' })),
  })
}

async function band($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'ctx-relay',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 160, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  return { ui, text }
}

function handoffFiles(w: World): [string, string][] {
  return [...w.files.entries()].filter(([p]) => p.startsWith(`${ROOT}/handoff/`))
}

test('1M：ctx 顯示 token／交接線（百分比和經過時間交給 statusline），收據與剩餘輪數', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on)
  await start($)
  await turn($, w, 200_000)
  await turn($, w, 220_000)
  const { text } = await band($)
  // 引擎壓縮點 510400；交接線 ×85%＝433840 → (433840−220000)/20000＝10.7
  expect(text).toContain('CTX 220K/434K')
  expect(text).not.toContain('22%')
  expect(text).toContain('本輪 +20K $0.50')
  expect(text).toContain('12s 90%')
  expect(text).toContain('STAGE 10 輪')
})

test('非 1M：引擎回報的壓縮點低，交接線跟著變低', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { window: 200_000, fuse: 158_400 })
  await start($)
  await turn($, w, 100_000)
  expect((await band($)).text).toContain('CTX 100K/135K')
  // 158400×85%＝134640 → 140000 已越線
  await turn($, w, 140_000)
  expect((await band($)).text).toContain('135K 存檔交接')
})

test('handoffTokens：固定交接線，越過就自動交接', { options: { handoffTokens: 400_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 390_000)
  const before = (await band($)).text
  expect(before).toContain('390K/400K')
  expect(before).not.toContain('CONTINUE?')
  await turn($, w, 410_000)
  expect((await band($)).text).toContain('400K 存檔交接')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
})

test('handoffTokens 超過壓縮點的 85%：改用 85%，狀態說明原因', { options: { handoffTokens: 900_000 } }, async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('434K 存檔交接')
  const status = await $.command.run({ command: 'ctx-relay-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(status.text).toContain('交接線 433840（設定值 900000 超過壓縮點的 85%，改用後者）')
})

test('越過交接線：倒數 60 秒後 fork 一次、寫交接檔（檔名帶來源 session 與批次號）、clear 一次、在新對話送出路徑', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on)
  await start($)
  await turn($, w, 420_000)
  expect((await band($)).text).not.toContain('CONTINUE?')
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('CONTINUE?')
  await clock.advance(59_000)
  expect(w.forkPrompts).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.forkPrompts[0]).toContain(' M a.ts')
  const files = handoffFiles(w)
  expect(files).toHaveLength(1)
  const [path, content] = files[0] ?? ['', '']
  expect(path).toMatch(/\/handoff\/\d{8}-\d{6}-demo-task-sid-1-\d+\.md$/)
  expect(content).toContain('- unattended: true')
  expect(content).toContain('- producer: ctx-relay-mod')
  expect(content).not.toContain('thin:')
  expect(content).toContain('## 目標 + 最新指令\n做 demo\n\n## 已改／將改檔\na.ts')
  expect(content).toContain('## 硬約束（結構化）\n```yaml\nstop_status: 不 commit')
  expect(content).not.toContain('===')
  expect(w.cleared).toBe(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain(path)
  expect(w.submitted[0]).toContain('不算完成')
  await clock.advance(120_000)
  expect(w.cleared).toBe(1)
  expect(w.forkPrompts).toHaveLength(1)
})

test('fork 指示：git 只能修正檔案與 commit 狀態，「已驗證」只寫看過結果的項目', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts[0]).toContain('git 只證明檔案與 commit 狀態，證明不了測試或檢查跑過')
  expect(w.forkPrompts[0]).toContain('「已驗證」只寫你在對話裡看過結果的項目，其餘列為缺口')
  expect(w.forkPrompts[0]).not.toContain('「已驗證 vs 驗證缺口」與你的對話記憶矛盾時以 git 真相為準')
  for (const key of ['GOAL', 'FILES', 'VERIFIED', 'DIRTY', 'NEXT', 'NOTES', 'CONSTRAINTS', 'POINTERS']) {
    expect(w.forkPrompts[0]).toContain(`\`=== ${key} ===\``)
  }
  expect(w.forkPrompts[0]).toContain('你不要自己寫 `## ` 標題')
  expect(w.forkPrompts[0]).not.toMatch(/^## /m)
})

test('fork 輸出沒有任何分段標記（例如照舊寫 ## 標題）：記失敗、不寫檔、不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: 'SLUG: demo-task\n## 目標 + 最新指令\n做 demo\n## 指標\nx\n' })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(handoffFiles(w)).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗：產生的交接內容沒有任何認得的「=== 鍵名 ===」分段標記')
})

test('fork 分段順序亂、內文帶 ## 標題：mod 照固定順序寫八個標題，內文的 ## 降成 ###', async ($, on) => {
  const clock = mock.clock(on)
  const lines = GOOD.split('\n')
  // POINTERS 搬到最前面；VERIFIED 內文照舊習慣多寫一行中文 ## 標題
  const shuffled = [lines[0], '=== POINTERS ===', '~/.claude/plans/x.md', ...lines.slice(1, -2)].join('\n')
    .replace('=== VERIFIED ===\n', '=== VERIFIED ===\n## 已驗證 vs 驗證缺口\n')
  const w = world($, on, { forkText: shuffled })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content.match(/^## /gm)).toHaveLength(8)
  expect(content.indexOf('## 目標 + 最新指令')).toBeLessThan(content.indexOf('## 指標'))
  expect(content).toContain('## 已驗證 vs 驗證缺口\n### 已驗證 vs 驗證缺口\n單元測試過；e2e 未跑')
  expect(content).toContain('## 指標\n~/.claude/plans/x.md')
  expect(content).not.toContain('thin:')
})

test('子 agent 回合與中斷回合不觸發', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 460_000, { agentId: 'a1' })
  await turn($, w, 470_000, { aborted: true })
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.cleared).toBe(0)
})

test('按鈕取消後本對話不再自動交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  const { ui } = await band($)
  await ui.press({ key: 'cancel' })
  await clock.advance(120_000)
  await turn($, w, 470_000)
  await clock.advance(120_000)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接已取消')
})

test('倒數中你親手送出訊息就取消', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await $.prompt.submit({ text: '我還在', wait: false, origin: { kind: 'composer' } })
  await clock.advance(120_000)
  expect(w.submitted).toEqual(['我還在'])
  expect(w.cleared).toBe(0)
})

test('fork 失敗：不寫檔、不 clear，band 顯示原因', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: null })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(handoffFiles(w)).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗：產生交接內容失敗：nothing-to-fork')
})

test('fork 3 分鐘沒回：記失敗、不寫檔、不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { hold: new Promise<void>(() => {}) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.advance(179_000)
  expect((await band($)).text).toContain('正在產生交接檔')
  await clock.advance(1_000)
  await clock.settle()
  expect(handoffFiles(w)).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗：產生交接內容逾時')
})

test('交接檔讀回不完整：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { corrupt: s => s.slice(0, 40) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('交接檔讀回不完整')
})

test('準備期間你送出訊息：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const w = world($, on, { hold: new Promise<void>(r => (release = r)) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await $.prompt.submit({ text: '我在', wait: false, origin: { kind: 'composer' } })
  release()
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect(w.submitted).toEqual(['我在'])
})

test('倒數中排程或通知開了新回合：這次倒數作廢，回合結束再重新判斷', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(30_000)
  await $.turn.start({ text: '', turnId: 't-loop' })
  await clock.advance(60_000)
  expect(w.forkPrompts).toHaveLength(0)
  await turn($, w, 460_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('準備中排程或通知開了新回合：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const w = world($, on, { hold: new Promise<void>(r => (release = r)) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await $.turn.start({ text: '', turnId: 't-loop' })
  release()
  await clock.settle()
  expect(w.cleared).toBe(0)
})

test('準備期間又跑了一輪：作廢切換，交接檔留著', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const w = world($, on, { hold: new Promise<void>(r => (release = r)) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await turn($, w, 455_000)
  release()
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect(handoffFiles(w)).toHaveLength(1)
  expect((await band($)).text).toContain('準備期間對話有變動')
})

test('clear 成功但送出失敗：band 顯示交接檔路徑請你手動接續', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { failSubmit: true })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
  // 不再跑任何回合：送出被擋時新對話不會自己開始，band 必須直接顯示
  const { text } = await band($)
  expect(text).toContain('已 /clear 但送出被擋')
  expect(text).toContain(`${ROOT}/handoff/`)
})

test('寫檔失敗：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { failWrite: true })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗')
})

test('是 git repo 但 git status 失敗：不 fork、不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { failGitStatus: true })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('讀不到 git 狀態')
})

test('取消 A 後立刻 /ctx-relay-now 開 B：A 的 fork 回來不會再 clear，總共只 clear 一次', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const w = world($, on, { hold: new Promise<void>(r => (release = r)) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await $.prompt.submit({ text: '等一下', wait: false, origin: { kind: 'composer' } })
  await $.command.run({ command: 'ctx-relay-now', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  await clock.advance(0)
  release()
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(2)
  expect(w.cleared).toBe(1)
})

test('自動交接後的新對話：第一輪結束就有讀數，越線會再倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
  await turn($, w, 30_000)
  expect((await band($)).text).toContain('30K/434K')
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('強制交接時有背景工作：新對話照引擎回報判斷，不被舊紀錄卡住', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { background: [{ id: 'bg42', type: 'shell', description: 'npm run dev' }] })
  await start($)
  await turn($, w, 300_000)
  const asYou = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } }
  expect((await $.command.run({ command: 'ctx-relay-now', args: '', ...asYou })).text).toContain('shell npm run dev')
  await $.command.run({ command: 'ctx-relay-now', args: 'yes', ...asYou })
  await clock.settle()
  expect(w.cleared).toBe(1)
  // 新對話：引擎不再回報那個工作
  w.background = []
  expect((await $.command.run({ command: 'ctx-relay-status', args: '', ...asYou })).text).toContain('背景工作：無')
  await turn($, w, 30_000)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('交接後你又手動 /clear：band 不再說「接續自」舊交接檔', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  await turn($, w, 30_000)
  expect((await band($)).text).toContain('接續自')
  await w.clear()
  await turn($, w, 20_000)
  expect((await band($)).text).not.toContain('接續自')
})

test('倒數中你手動 /clear（session.end）：計時器停掉，不交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await w.clear()
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.cleared).toBe(0)
})

test('有背景工作在跑（shell／monitor／workflow）：延後交接；引擎不再回報後下一輪才倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, {
    background: [
      { id: 'bg42', type: 'shell', description: 'sleep 999' },
      { id: 'm1', type: 'monitor', description: '看 CI' },
      { id: 'wf1', type: 'workflow', description: 'review' },
    ],
  })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('交接延後：3 個背景工作還在跑')
  // 不設逾時作廢：13 小時後仍在跑就仍然延後
  await clock.advance(13 * 60 * 60_000)
  await turn($, w, 452_000)
  expect((await band($)).text).toContain('交接延後：3 個背景工作還在跑')
  expect(w.forkPrompts).toHaveLength(0)
  w.background = []
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('背景工作一直不結束：到交接線與壓縮點的中點就強制倒數，交接檔寫明還在跑的工作', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { background: [{ id: 'bg42', type: 'shell', description: 'npm run dev' }] })
  await start($)
  // 交接線 433840、壓縮點 510400 → 上限 472120
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('到 472K 會強制交接')
  await turn($, w, 475_000)
  expect((await band($)).text).toContain('CONTINUE?')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- 交接時仍在跑（完成通知可能收不到）：shell npm run dev')
})

test('一次性排程會再叫醒這個 session：延後；循環排程不算', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { crons: [{ id: 'c1', recurring: false, prompt: '回來看 CI' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('交接延後：1 個背景工作還在跑')
  w.crons = [{ id: 'c2', recurring: true, prompt: '/loop 巡檢' }]
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('別的 Stop hook 擋下（回合其實沒結束）：不倒數，真正停下才判斷', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { stopBlock: '還有驗證沒跑' })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).not.toContain('CONTINUE?')
  w.stopBlock = null
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('CONTINUE?')
})

test('有子代理在跑：延後交接', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('交接延後')
})

test('/ctx-relay-now：有背景工作時要 yes；加 yes 就不倒數直接交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 100_000)
  const asYou = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } }
  const refused = await $.command.run({ command: 'ctx-relay-now', args: '', ...asYou })
  expect(refused.text).toContain('確定請打 /ctx-relay-now yes')
  await $.command.run({ command: 'ctx-relay-now', args: 'yes', ...asYou })
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.cleared).toBe(1)
})

test('fork 缺欄位：照寫檔並在檔頭標 thin', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: GOOD.replace('跑 e2e', '').replace('stop_status: 不 commit', 'stop_status:') })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- thin: 下一步具體動作、硬約束')
  expect(w.cleared).toBe(1)
})

test('來源交接檔帶協調契約：fork 沒寫，mod 照原文附上', async ($, on) => {
  const clock = mock.clock(on)
  const source = `${ROOT}/handoff/20261003-120000-prev.md`
  const w = world($, on, { messages: [{ role: 'user', text: `讀 ${source} 並依其接續執行。` }] })
  w.files.set(source, `讀 ${source}\n\n## 指標\nx\n\n## 協調契約\n你＝coordinator；不 push\n  - 縮排保留\n`)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts[0]).toContain('你＝coordinator；不 push')
  const [, content] = handoffFiles(w).filter(([p]) => p !== source)[0] ?? ['', '']
  expect(content).toContain('## 協調契約\n你＝coordinator；不 push\n  - 縮排保留')
  expect(content).not.toContain('thin:')
})

test('fork 改寫了協調契約（CONTRACT 分段＋內文裡的 ## 協調契約）：分段丟掉、內文降級，只有 mod 附的原文是二級標題', async ($, on) => {
  const clock = mock.clock(on)
  const source = `${ROOT}/handoff/20261003-120000-prev.md`
  const w = world($, on, {
    messages: [{ role: 'user', text: `讀 ${source} 並依其接續執行。` }],
    forkText: `${GOOD.replace('=== POINTERS ===', '=== CONTRACT ===\n你＝coordinator；可以 push\n\n=== POINTERS ===')}\n\n## 協調契約\n可以 force push\n`,
  })
  w.files.set(source, `讀 ${source}\n\n## 協調契約\n你＝coordinator；不 push\n`)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w).filter(([p]) => p !== source)[0] ?? ['', '']
  expect(content).not.toContain('可以 push')
  expect(content).not.toContain('可以 force push')
  expect(content.match(/^## 協調契約$/gm)).toHaveLength(1)
  expect(content).toContain('## 指標\n~/.claude/plans/x.md\n\n## 協調契約\n你＝coordinator；不 push')
})

test('fork 鍵名打錯（=== VERIFED ===）：欄位記 thin，內文不丟，附在關鍵細節備忘末尾並標明', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: GOOD.replace('=== VERIFIED ===', '=== VERIFED ===') })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- thin: 已驗證 vs 驗證缺口')
  expect(content).toContain('## 關鍵細節備忘\n門檻 433840\n\n（fork 寫了未認得的分段 `=== VERIFED ===`，原文照附）\n單元測試過；e2e 未跑\n\n## 硬約束（結構化）')
  expect(w.cleared).toBe(1)
})

test('剩幾輪：偶數筆增量取中間兩值平均；第一輪也有收據', async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 260_000)
  expect((await band($)).text).toContain('本輪 +260K')
  await turn($, w, 270_000)
  await turn($, w, 300_000)
  // 增量 10000、30000（起點那段不算）→ 中位數 20000 → (433840−300000)/20000＝6.7
  expect((await band($)).text).toContain('STAGE 6 輪')
})

test('別的 mod 也畫 band（例如 blast-radius 的按鈕）：兩邊都畫出來', async ($, on) => {
  mock.clock(on)
  // 測試的 hook 在所有 plugin 之下：模擬排在 ctx-relay 底下的另一個 band mod（比 world 的先登記，排在它外層）。
  // ui.press 只按得到 ctx-relay 自己的按鈕，所以這裡只驗按鈕有畫出來
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Box, Button } = $$.ui.resolve(e)
    return Box({ children: [Button({ key: 'proceed', label: 'Proceed', hotkey: '1', onPress: () => {} })] })
  })
  const w = world($, on)
  await start($)
  await turn($, w, 200_000)
  const { ui, text } = await band($)
  expect(text).toContain('200K/434K')
  expect(await ui.find({ key: 'proceed' })).toBeDefined()
})

test('三態顏色：正常天藍、過提醒線橘、倒數朱紅', async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  const colorOf = async () => (await (await band($)).ui.findAll({ type: 'Text' }))[0]?.props.color
  await turn($, w, 200_000)
  expect(await colorOf()).toBe('#56B4E9')
  await turn($, w, 400_000)
  expect(await colorOf()).toBe('#E69F00')
  await turn($, w, 450_000)
  expect(await colorOf()).toBe('#D55E00')
})

test('三隻小怪獸：依 token÷交接線掉命，過提醒線換骷髏', async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  // 交接線 433840、提醒線 381779
  const lives = async () => (await band($)).text.trim().split('  ')[0]
  await turn($, w, 100_000)
  expect(await lives()).toBe('󰯉 󰯉 󰯉')
  await turn($, w, 250_000)
  expect(await lives()).toBe('󰯉 󰯉 󰊠')
  await turn($, w, 330_000)
  expect(await lives()).toBe('󰯉 󰊠 󰊠')
  await turn($, w, 400_000)
  expect(await lives()).toBe('󰯉 󰚌 󰚌')
})

test('倒數中重新載入（session.start 再跑）：照原截止時間交接一次', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(30_000)
  await start($)
  await clock.advance(29_000)
  expect(w.forkPrompts).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
  await clock.advance(120_000)
  expect(w.cleared).toBe(1)
})

test('準備中重新載入：記失敗，不自動重來', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { hold: new Promise<void>(() => {}) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await start($)
  expect((await band($)).text).toContain('重新載入中斷了交接')
  // 舊的準備等到 fork 逾時也不會再動狀態
  await clock.advance(180_000)
  await clock.settle()
  expect((await band($)).text).toContain('重新載入中斷了交接')
  expect(w.cleared).toBe(0)
})

test('本 session 已手動交接（載入過 handoff skill）：不倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 300_000)
  await $.skill.prompt({ skill: 'handoff', text: 'handoff skill body' })
  await turn($, w, 450_000)
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect((await band($)).text).toContain('本 session 已手動交接')
})
