import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

const ROOT = '/repo/.git/harness'

// 8 欄位齊全、硬約束四鍵有值的 fork 輸出
const GOOD = [
  'SLUG: demo-task',
  '## 目標 + 最新指令', '做 demo',
  '## 已改／將改檔', 'a.ts',
  '## 已驗證 vs 驗證缺口', '單元測試過；e2e 未跑',
  '## dirty 無關項', '無',
  '## 下一步具體動作', '跑 e2e',
  '## 關鍵細節備忘', '門檻 433840',
  '## 硬約束（結構化）', '```yaml', 'stop_status: 不 commit', 'unresolved_prerequisite: none', 'responsible_authority: 使用者', 'admissible_fallback: none', '```',
  '## 指標', '~/.claude/plans/x.md',
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
  agents: { id: string; description: string; status: string }[]
  messages: { role: 'user' | 'assistant'; text: string }[]
  submitted: string[]
  failSubmit: boolean
  failWrite: boolean
  failGitStatus: boolean
  cleared: number
}

function world(on: On, patch: Partial<World> = {}): World {
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
    messages: [],
    submitted: [],
    failSubmit: false,
    failWrite: false,
    failGitStatus: false,
    cleared: 0,
    ...patch,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
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
  on('command.run', (_$, e) => {
    if (e.command === 'clear') {
      w.cleared += 1
      w.sessionId = `sid-${w.cleared + 1}`
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

test('1M：ctx 顯示佔模型窗百分比，收據與剩餘輪數', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turn($, w, 200_000)
  await turn($, w, 220_000)
  const { text } = await band($)
  // 引擎壓縮點 510400；交接線 ×85%＝433840 → (433840−220000)/20000＝10.7
  expect(text).toContain('ctx 22%')
  expect(text).toContain('220K/434K')
  expect(text).toContain('本輪 +20K $0.50')
  expect(text).toContain('cache 90%')
  expect(text).toContain('剩約 10 輪到交接線')
})

test('非 1M：引擎回報的壓縮點低，交接線跟著變低', async ($, on) => {
  mock.clock(on)
  const w = world(on, { window: 200_000, fuse: 158_400 })
  await start($)
  await turn($, w, 100_000)
  expect((await band($)).text).toContain('ctx 50%')
  // 158400×85%＝134640 → 140000 已越線
  await turn($, w, 140_000)
  expect((await band($)).text).toContain('越過自動交接線 135K')
})

test('handoffTokens：固定交接線，越過就自動交接', { options: { handoffTokens: 400_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 390_000)
  const before = (await band($)).text
  expect(before).toContain('390K/400K')
  expect(before).not.toContain('秒後產生交接檔')
  await turn($, w, 410_000)
  expect((await band($)).text).toContain('越過自動交接線 400K')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
})

test('handoffTokens 超過壓縮點的 85%：改用 85%，狀態說明原因', { options: { handoffTokens: 900_000 } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('越過自動交接線 434K')
  const status = await $.command.run({ command: 'ctx-relay-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(status.text).toContain('交接線 433840（設定值 900000 超過壓縮點的 85%，改用後者）')
})

test('越過交接線：倒數 60 秒後 fork 一次、寫交接檔、clear 一次、在新對話送出路徑', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turn($, w, 420_000)
  expect((await band($)).text).not.toContain('秒後產生交接檔')
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('秒後產生交接檔')
  await clock.advance(59_000)
  expect(w.forkPrompts).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.forkPrompts[0]).toContain(' M a.ts')
  const files = handoffFiles(w)
  expect(files).toHaveLength(1)
  const [path, content] = files[0] ?? ['', '']
  expect(path).toMatch(/\/handoff\/\d{8}-\d{6}-demo-task\.md$/)
  expect(content).toContain('- unattended: true')
  expect(content).toContain('- producer: ctx-relay-mod')
  expect(content).not.toContain('thin:')
  expect(w.cleared).toBe(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain(path)
  expect(w.submitted[0]).toContain('不算完成')
  await clock.advance(120_000)
  expect(w.cleared).toBe(1)
  expect(w.forkPrompts).toHaveLength(1)
})

test('子 agent 回合與中斷回合不觸發', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 460_000, { agentId: 'a1' })
  await turn($, w, 470_000, { aborted: true })
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.cleared).toBe(0)
})

test('按鈕取消後本對話不再自動交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
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
  const w = world(on)
  await start($)
  await turn($, w, 450_000)
  await $.prompt.submit({ text: '我還在', wait: false, origin: { kind: 'composer' } })
  await clock.advance(120_000)
  expect(w.submitted).toEqual(['我還在'])
  expect(w.cleared).toBe(0)
})

test('fork 失敗：不寫檔、不 clear，band 顯示原因', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { forkText: null })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(handoffFiles(w)).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗：產生交接內容失敗：nothing-to-fork')
})

test('交接檔讀回不完整：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { corrupt: s => s.slice(0, 40) })
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
  const w = world(on, { hold: new Promise<void>(r => (release = r)) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await $.prompt.submit({ text: '我在', wait: false, origin: { kind: 'composer' } })
  release()
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect(w.submitted).toEqual(['我在'])
})

test('準備期間又跑了一輪：作廢切換，交接檔留著', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  const w = world(on, { hold: new Promise<void>(r => (release = r)) })
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
  const w = world(on, { failSubmit: true })
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
  const w = world(on, { failWrite: true })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('自動交接失敗')
})

test('是 git repo 但 git status 失敗：不 fork、不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { failGitStatus: true })
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
  const w = world(on, { hold: new Promise<void>(r => (release = r)) })
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

test('倒數中你手動 /clear（session.end）：計時器停掉，不交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 450_000)
  await $.session.end({ reason: 'clear', sessionId: w.sessionId, resume: { id: w.sessionId } })
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect(w.cleared).toBe(0)
})

test('有背景 Bash 在跑：延後交接；完成通知後下一輪才倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg42' } }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sleep 999', run_in_background: true })
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('交接延後：1 個背景工作還在跑')
  // 不設逾時作廢：13 小時後仍在跑就仍然延後
  await clock.advance(13 * 60 * 60_000)
  await turn($, w, 452_000)
  expect((await band($)).text).toContain('交接延後：1 個背景工作還在跑')
  expect(w.forkPrompts).toHaveLength(0)
  await $.prompt.submit({ text: 'task bg42 completed', wait: false, origin: { kind: 'task-notification' } })
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('秒後產生交接檔')
})

test('有子代理在跑：延後交接', async ($, on) => {
  mock.clock(on)
  const w = world(on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('交接延後')
})

test('/ctx-relay-now：有背景工作時要 yes；加 yes 就不倒數直接交接', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
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
  const w = world(on, { forkText: GOOD.replace('跑 e2e', '').replace('stop_status: 不 commit', 'stop_status:') })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- thin: 下一步具體動作、硬約束')
  expect(w.cleared).toBe(1)
})

test('來源交接檔帶協調契約：fork prompt 附上原文；輸出漏掉就標 thin', async ($, on) => {
  const clock = mock.clock(on)
  const source = `${ROOT}/handoff/20261003-120000-prev.md`
  const w = world(on, { messages: [{ role: 'user', text: `讀 ${source} 並依其接續執行。` }] })
  w.files.set(source, `讀 ${source}\n\n## 指標\nx\n\n## 協調契約\n你＝coordinator；不 push\n`)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts[0]).toContain('你＝coordinator；不 push')
  const files = handoffFiles(w).filter(([p]) => p !== source)
  expect(files[0]?.[1]).toContain('thin: 協調契約')
})

test('協調契約被改寫：標「未原樣續傳」', async ($, on) => {
  const clock = mock.clock(on)
  const source = `${ROOT}/handoff/20261003-120000-prev.md`
  const w = world(on, {
    messages: [{ role: 'user', text: `讀 ${source} 並依其接續執行。` }],
    forkText: `${GOOD}\n## 協調契約\n你＝coordinator；可以 push`,
  })
  w.files.set(source, `讀 ${source}\n\n## 協調契約\n你＝coordinator；不 push\n`)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const files = handoffFiles(w).filter(([p]) => p !== source)
  expect(files[0]?.[1]).toContain('協調契約（未原樣續傳）')
})

test('剩幾輪：偶數筆增量取中間兩值平均；第一輪也有收據', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 260_000)
  expect((await band($)).text).toContain('本輪 +260K')
  await turn($, w, 270_000)
  await turn($, w, 300_000)
  // 增量 10000、30000（起點那段不算）→ 中位數 20000 → (433840−300000)/20000＝6.7
  expect((await band($)).text).toContain('剩約 6 輪到交接線')
})

test('三態顏色：正常天藍、過提醒線橘、倒數朱紅', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await start($)
  const colorOf = async () => (await (await band($)).ui.findAll({ type: 'Text' }))[0]?.props.color
  await turn($, w, 200_000)
  expect(await colorOf()).toBe('#56B4E9')
  await turn($, w, 400_000)
  expect(await colorOf()).toBe('#E69F00')
  await turn($, w, 450_000)
  expect(await colorOf()).toBe('#D55E00')
})

test('倒數中重新載入（session.start 再跑）：照原截止時間交接一次', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
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
  const w = world(on, { hold: new Promise<void>(() => {}) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await start($)
  expect((await band($)).text).toContain('重新載入中斷了交接')
  expect(w.cleared).toBe(0)
})

test('本 session 已手動交接（載入過 handoff skill）：不倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await turn($, w, 300_000)
  await $.skill.prompt({ skill: 'handoff', text: 'handoff skill body' })
  await turn($, w, 450_000)
  await clock.advance(120_000)
  expect(w.forkPrompts).toHaveLength(0)
  expect((await band($)).text).toContain('本 session 已手動交接')
})
