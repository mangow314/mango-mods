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
  // fs.list 回報的修改時間（沒設＝0）
  mtimes: Map<string, number>
  // $.store
  store: Map<string, unknown>
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
  // Team／Enterprise 登入：內建守門 mod 讓 classic.* 跳過使用者裝的 mod，classic.Stop 不會送到本 mod
  guarded: boolean
  messages: { role: 'user' | 'assistant'; text: string }[]
  submitted: string[]
  failSubmit: boolean
  failWrite: boolean
  failGitStatus: boolean
  // mod 執行的 /clear 次數（你手動 clear 不算）
  cleared: number
  // 快取 TTL 判定讀的環境變數、設定，與 usage 的 rateLimits（非空＝訂閱）
  env: Record<string, string>
  settings: Record<string, unknown>
  rateLimits: { kind: string; percentUsed: number }[]
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
    mtimes: new Map(),
    store: new Map(),
    forkText: GOOD,
    forkPrompts: [],
    hold: null,
    corrupt: null,
    agents: [],
    background: [],
    crons: [],
    stopBlock: null,
    guarded: false,
    messages: [],
    submitted: [],
    failSubmit: false,
    failWrite: false,
    failGitStatus: false,
    cleared: 0,
    env: {},
    settings: {},
    rateLimits: [{ kind: 'five_hour', percentUsed: 5 }],
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
    return { value: { startedAt: 0, context: { tokens: w.tokens, window: w.window, ...breakdown }, rateLimits: w.rateLimits, cost: { usd: w.cost } } }
  })
  on('env.get', (_$, e) => ({ value: w.env[e.name] }))
  on('settings.read', () => ({ value: w.settings }))
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
  // 資料夾沒有自己的項目：底下有檔就算存在
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) || [...w.files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const p of w.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const cut = rest.indexOf('/')
      entries.set(cut === -1 ? rest : rest.slice(0, cut), cut === -1 ? 'file' : 'dir')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: w.mtimes.get(`${prefix}${name}`) ?? 0, isLink: false })) }
  })
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
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
      if (sub === 'rev-parse') return ok(e.argv.includes('--short') ? 'abc1234\n' : 'master\n')
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

async function turn($: Engine, w: World, tokens: number, extra: { answer?: string; agentId?: string; aborted?: boolean; cacheRead?: number } = {}) {
  w.tokens = tokens
  w.cost += 0.5
  // 照實測順序：主對話正常結束先跑 Stop、結束後才 turn.complete（子代理是 SubagentStop；中斷不跑 Stop）。
  // Stop 被擋下＝回合繼續，這次沒有 turn.complete
  if (!extra.agentId && !extra.aborted && !w.guarded) {
    const stop = await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: w.background.map(t => ({ ...t, status: 'running' })),
      session_crons: w.crons.map(c => ({ ...c, schedule: '0 9 * * *' })),
    })
    if (stop.block !== undefined) return
  }
  await $.turn.complete({
    answer: extra.answer ?? 'done',
    durationMs: 12_000,
    isAborted: extra.aborted === true,
    turnId: `t-${tokens}`,
    reason: extra.aborted ? 'aborted' : 'answer',
    usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: extra.cacheRead ?? 9_000, cache_creation_input_tokens: 9_990 - (extra.cacheRead ?? 9_000), model: 'claude-opus-5-5' },
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  })
}



// 同時掛著的 band 越多，每次重畫越慢，所以每次只留最新一個
let mounted: { unmount: () => Promise<void> } | null = null

// 交接倒數每秒重畫一次，測試時鐘一次 advance 最多處理 10000 次等待：長時間分段推進
// 推進前先卸下 band，否則每次重畫都要畫它
async function idle(clock: { advance: (ms: number) => Promise<unknown> }, ms: number) {
  await mounted?.unmount().catch(() => undefined)
  mounted = null
  for (let left = ms; left > 0; left -= 20 * 60_000) await clock.advance(Math.min(left, 20 * 60_000))
}

async function band($: Engine, bodyColumns = 160) {
  // 上一個測試掛的已隨測試結束，卸載會丟 this test has ended
  await mounted?.unmount().catch(() => undefined)
  const ui = await $.ui.mount({
    plugin: 'ctx-relay',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  mounted = ui
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  return { ui, text }
}

// 交接檔本身（.picked/ 底下的已接手標記不算）
function handoffFiles(w: World): [string, string][] {
  return [...w.files.entries()].filter(([p]) => p.startsWith(`${ROOT}/handoff/`) && !p.includes('/.picked/'))
}

test('band 平時不畫：沒越線、沒交接狀態時不佔畫面；用量與門檻看 /ctx-relay-status', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on)
  await start($)
  await turn($, w, 200_000)
  await turn($, w, 220_000)
  expect((await band($)).text).toBe('')
  // 引擎壓縮點 510400；交接線 ×85%＝433840
  expect(await status($)).toContain('context 220000; handoff line 433840')
})

test('非 1M：引擎回報的壓縮點低，交接線跟著變低', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { window: 200_000, fuse: 158_400 })
  await start($)
  await turn($, w, 100_000)
  expect(await status($)).toContain('handoff line 134640')
  // 158400×85%＝134640 → 140000 已越線
  await turn($, w, 140_000)
  expect((await band($)).text).toContain('at 135K')
})

test('handoffTokens：固定交接線，越過就自動交接', { options: { handoffTokens: 400_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 390_000)
  expect(await status($)).toContain('handoff line 400000')
  expect((await band($)).text).not.toContain('Handoff in')
  await turn($, w, 410_000)
  expect((await band($)).text).toContain('at 400K')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
})

test('handoffTokens 超過壓縮點的 85%：改用 85%，狀態說明原因', { options: { handoffTokens: 900_000 } }, async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('at 434K')
  const status = await $.command.run({ command: 'ctx-relay-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(status.text).toContain('handoff line 433840 (setting 900000 is above 85% of the compaction point; using that instead)')
})

test('越過交接線：倒數 60 秒後 fork 一次、寫交接檔（檔名帶來源 session 與批次號）、clear 一次、在新對話送出路徑', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on)
  await start($)
  await turn($, w, 420_000)
  expect((await band($)).text).not.toContain('Handoff in')
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff in')
  await clock.advance(59_000)
  expect(w.forkPrompts).toHaveLength(0)
  await clock.advance(1_000)
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.forkPrompts[0]).toContain(' M a.ts')
  expect(w.forkPrompts[0]).toContain('越過自動交接線')
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
  expect(w.submitted[0]).toContain('已越過自動交接線')
  expect(w.submitted[0]).toContain('先回報「交接檔可能過時」')
  // 用檔頭的 HEAD sha 比，不比時間（%ci 帶提交者時區，2026-10-09 實例會漏判）
  expect(w.submitted[0]).toContain('git log --oneline abc1234..HEAD')
  expect(content).toContain('- HEAD：`abc1234`')
  expect(content).toContain('由 ctx-relay mod 自動交接')
  await clock.advance(120_000)
  expect(w.cleared).toBe(1)
  expect(w.forkPrompts).toHaveLength(1)
})

test('預設 lite：fork 指示英文、照對話語言寫；交接檔四欄英文標題、不讀 INDEX、不記硬約束；接續訊息讀得懂', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, {
    forkText: ['SLUG: demo-task', '=== GOAL ===', 'ship the demo', '=== FILES ===', 'a.ts', '=== VERIFIED ===', '- Verified: unit tests pass', '- Gap: e2e not run', '=== NEXT ===', '- run e2e'].join('\n'),
  })
  w.files.set(`${ROOT}/progress/sid-1/INDEX.md`, '# 私人進度\nphase: 2')
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts[0]).toContain('in the language of this conversation')
  expect(w.forkPrompts[0]).not.toContain('CONSTRAINTS')
  // 接手方靠這兩個前綴分出已驗證與缺口
  expect(w.forkPrompts[0]).toContain('`Verified:`')
  expect(w.forkPrompts[0]).toContain('`Gap:`')
  expect(w.forkPrompts[0]).not.toContain('私人進度')
  const [path, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content.startsWith(`Read ${path} and continue from it;`)).toBe(true)
  expect(content).toContain('- how: auto')
  expect(content).toContain('## Goal\nship the demo\n\n## Files\na.ts\n\n## Verified\n')
  expect(content).toContain('## Next\n- run e2e')
  expect(content).not.toContain('thin:')
  expect(content).not.toContain('目標')
  expect(w.cleared).toBe(1)
  expect(w.submitted[0]).toContain(`Read ${path} and continue the task \`demo-task\``)
  expect(w.submitted[0]).toContain('wait for the user')
  expect(w.submitted[0]).toContain('the handoff file may be stale')
  // 用檔頭的 HEAD sha 比，不比時間（%ci 帶提交者時區，2026-10-09 實例會漏判）
  expect(w.submitted[0]).toContain('git log --oneline abc1234..HEAD')
  expect(content).toContain('- head: `abc1234`')
})

test('交接檔附使用者最近 3 則訊息原文（舊到新）；工具結果與系統插入的不算；fork 指示分已驗證／未確認／缺口／失敗', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  w.messages = [
    { role: 'user', text: '先做 A' },
    { role: 'assistant', text: '好' },
    { role: 'user', text: '改做 B\n## 不是標題' },
    { role: 'user', text: '<task-notification>done</task-notification>' },
    { role: 'user', text: 'B 做完跑測試<system-reminder>ignore</system-reminder>' },
    { role: 'user', text: '別 push' },
  ]
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain("- the user's last messages (verbatim, taken from the transcript by the mod, oldest first):\n> 改做 B\n> ## 不是標題\n>\n> B 做完跑測試\n>\n> 別 push\n")
  expect(content).not.toContain('先做 A')
  expect(content).not.toContain('task-notification')
  expect(content).not.toContain('ignore')
  for (const prefix of ['`Verified:`', '`Unconfirmed:`', '`Gap:`', '`Failed:`']) expect(w.forkPrompts[0]).toContain(prefix)
  expect(w.submitted[0]).toContain('Items marked `Unconfirmed:` or `Gap:` are not done')
})

test('lite：fork 漏寫 NEXT 卻多寫了別的分段：內容照附在 Next，但檔頭仍記 thin: Next', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, {
    forkText: ['SLUG: demo-task', '=== GOAL ===', 'ship', '=== FILES ===', 'a.ts', '=== VERIFIED ===', '- Gap: e2e', '=== NOTES ===', 'threshold 433840'].join('\n'),
  })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- thin: Next')
  expect(content).toContain('threshold 433840')
})

test('fork 指示：git 只能修正檔案與 commit 狀態，「已驗證」只寫看過結果的項目', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.forkPrompts[0]).toContain('git 只證明檔案與 commit 狀態，證明不了測試或檢查跑過')
  expect(w.forkPrompts[0]).toContain('「已驗證」只寫你在對話裡看過結果的項目，其餘列為缺口')
  expect(w.forkPrompts[0]).not.toContain('「已驗證 vs 驗證缺口」與你的對話記憶矛盾時以 git 真相為準')
  // 接手方靠這兩個前綴分出已驗證與缺口（同精簡版）
  expect(w.forkPrompts[0]).toContain('`Verified:`')
  expect(w.forkPrompts[0]).toContain('`Gap:`')
  expect(w.forkPrompts[0]).toContain('憑記憶寫的標「未核實」')
  expect(w.forkPrompts[0]).toContain('暫存，可能失效')
  expect(w.forkPrompts[0]).toContain('不寫「本檔取代前一份」')
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
  expect((await band($)).text).toContain('Auto handoff failed: the fork output has no recognised "=== KEY ===" section markers')
})

test('fork 分段順序亂、內文帶 ## 標題：mod 照固定順序寫八個標題，內文的 ## 降成 ###', { options: { handoffFormat: 'full' } }, async ($, on) => {
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

test('fork 輸出末尾附了 sitrep 的 ui-summary 區塊：交接檔不帶這個區塊', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: `${GOOD}\n\n\`\`\`ui-summary\n{"status":"done","outcome":"交接完成","items":[],"facets":[]}\n\`\`\`\n` })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('## 指標')
  expect(content).not.toContain('ui-summary')
  expect(content).not.toContain('交接完成')
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
  expect((await band($)).text).toContain('Auto handoff cancelled')
})

test('倒數中你親手送出訊息只延後：這輪結束還在線上就重新倒數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await $.prompt.submit({ text: '我還在', wait: false, origin: { kind: 'composer' } })
  await clock.advance(120_000)
  expect(w.submitted).toEqual(['我還在'])
  expect(w.cleared).toBe(0)
  expect((await band($)).text).not.toContain('Auto handoff cancelled')
  await turn($, w, 470_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
})

test('交接帳本：倒數、延後、交接完成（含 fork 用量與交接前 tokens）都記進 handoffs.jsonl，/ctx-relay-status 列筆數', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  expect(await status($)).toContain('handoff ledger: none recorded')
  await turn($, w, 450_000)
  await $.prompt.submit({ text: '我還在', wait: false, origin: { kind: 'composer' } })
  await turn($, w, 470_000)
  await clock.advance(60_000)
  await clock.settle()
  const events = (w.files.get(`${ROOT}/ctx-relay/handoffs.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(events.map(e => e.event)).toEqual(['countdown', 'postponed', 'countdown', 'handed-off'])
  expect(events[0]).toMatchObject({ trigger: 'handoff' })
  expect(events[3]).toMatchObject({ manual: false, tokens: 470_000, resumed: true, fork: { input: 10, cacheRead: 400_000, cacheWrite: 0, output: 900 } })
  expect(await status($)).toMatch(/handoff ledger since .*: 2 countdowns, 0 cancelled, 1 postponed, 1 handed off \(0 manual\), 0 failed/)
})

test('倒數中主對話壓縮了：倒數作廢、不交接，帳本記 postponed；預先計算（precompute）不算', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  const summary = { role: 'user' as const, text: '摘要', toolUses: [] }
  on('session.compact', () => ({ messages: [summary] }))
  await start($)
  await turn($, w, 450_000)
  await $.session.compact({ trigger: 'precompute', instructions: '', messages: [summary] })
  expect((await band($)).text).toContain('Handoff in')
  await $.session.compact({ trigger: 'auto', instructions: '', messages: [summary] })
  expect((await band($)).text).toBe('')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(0)
  const events = (w.files.get(`${ROOT}/ctx-relay/handoffs.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(events.at(-1)).toMatchObject({ event: 'postponed', detail: 'the conversation was compacted during countdown' })
})

test('交接帳本：按取消記 cancelled', async ($, on) => {
  mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await (await band($)).ui.press({ key: 'cancel' })
  const events = (w.files.get(`${ROOT}/ctx-relay/handoffs.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(events.map(e => e.event)).toEqual(['countdown', 'cancelled'])
  expect(events[1]).toMatchObject({ detail: 'you pressed Cancel' })
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
  expect((await band($)).text).toContain('Auto handoff failed: handoff fork failed: nothing-to-fork')
})

test('交接失敗記進 failures.jsonl（時間、自動／手動、token、離開多久、原因），/ctx-relay-status 列最近幾筆', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') })
  const w = world($, on, { forkText: null })
  await start($)
  expect(await status($)).toContain('handoff failures: none recorded')
  await $.prompt.submit({ text: '繼續', wait: false, origin: { kind: 'composer' } })
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const lines = (w.files.get(`${ROOT}/ctx-relay/failures.jsonl`) ?? '').trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ manual: false, tokens: 450_000, idleMin: 1, detail: 'handoff fork failed: nothing-to-fork' })
  const text = await status($)
  expect(text).toContain('handoff failures: 1 recorded')
  expect(text).toMatch(/2026-10-08T12:01:\d\d\.\d+Z auto ctx 450K, idle 1m: handoff fork failed: nothing-to-fork/)
})

test('fork 3 分鐘沒回：記失敗、不寫檔、不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { hold: new Promise<void>(() => {}) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.advance(179_000)
  expect((await band($)).text).toContain('Writing handoff file')
  await clock.advance(1_000)
  await clock.settle()
  expect(handoffFiles(w)).toHaveLength(0)
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('Auto handoff failed: handoff fork timed out')
})

test('交接檔讀回不完整：不 clear', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { corrupt: s => s.slice(0, 40) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(0)
  expect((await band($)).text).toContain('handoff file read-back incomplete')
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
  expect((await band($)).text).toContain('Handoff in')
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
  expect((await band($)).text).toContain('the conversation changed while preparing')
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
  expect(text).toContain('Cleared, but the resume message was blocked')
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
  expect((await band($)).text).toContain('Auto handoff failed')
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
  expect((await band($)).text).toContain('cannot read git state')
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
  expect(await status($)).toContain('context 30000')
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff in')
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
  expect((await $.command.run({ command: 'ctx-relay-status', args: '', ...asYou })).text).toContain('background work: none')
  await turn($, w, 30_000)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff in')
})

test('交接後你又手動 /clear：band 不再說「接續自」舊交接檔', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  await turn($, w, 30_000)
  expect((await band($)).text).toContain('Resumed from')
  await w.clear()
  await turn($, w, 20_000)
  expect((await band($)).text).not.toContain('Resumed from')
})

test('交接成功：band 寫「Resumed from …· next: 下一步」並跳 toast 附交接檔路徑；你一打字整行收掉', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const w = world($, on)
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  await turn($, w, 30_000)
  expect((await band($)).text).toMatch(/Resumed from \S+\.md · next: 跑 e2e/)
  expect(toasts.some(t => t.includes(`${ROOT}/handoff/`))).toBe(true)
  await $.prompt.submit({ text: '好', wait: false, origin: { kind: 'composer' } })
  expect((await band($)).text).toBe('')
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
  expect((await band($)).text).toContain('Handoff deferred: 3 background tasks still running')
  // 不設逾時作廢：13 小時後仍在跑就仍然延後
  await idle(clock, 13 * 60 * 60_000)
  await turn($, w, 452_000)
  expect((await band($)).text).toContain('Handoff deferred: 3 background tasks still running')
  expect(w.forkPrompts).toHaveLength(0)
  w.background = []
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('Handoff in')
})

test('背景工作一直不結束：到交接線與壓縮點的中點就強制倒數，交接檔寫明還在跑的工作', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { background: [{ id: 'bg42', type: 'shell', description: 'npm run dev' }] })
  await start($)
  // 交接線 433840、壓縮點 510400 → 上限 472120
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('forced at 472K')
  await turn($, w, 475_000)
  expect((await band($)).text).toContain('Handoff in')
  await clock.advance(60_000)
  await clock.settle()
  expect(w.cleared).toBe(1)
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('- 交接時仍在跑（完成通知可能收不到）：shell npm run dev')
  const events = (w.files.get(`${ROOT}/ctx-relay/handoffs.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(events.find(e => e.event === 'countdown')).toMatchObject({ trigger: 'cap' })
})

test('一次性排程會再叫醒這個 session：延後；循環排程不算', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { crons: [{ id: 'c1', recurring: false, prompt: '回來看 CI' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff deferred: 1 background task still running')
  w.crons = [{ id: 'c2', recurring: true, prompt: '/loop 巡檢' }]
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('Handoff in')
})

test('別的 Stop hook 擋下（回合其實沒結束）：不倒數，真正停下才判斷', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { stopBlock: '還有驗證沒跑' })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).not.toContain('Handoff in')
  w.stopBlock = null
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('Handoff in')
})

test('有子代理在跑：延後交接', async ($, on) => {
  mock.clock(on)
  const w = world($, on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff deferred')
})

test('Team 帳號（收不到 classic.Stop）：越過交接線照樣倒數；子代理在跑仍延後', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { guarded: true, agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 450_000)
  expect((await band($)).text).toContain('Handoff deferred')
  w.agents = []
  await turn($, w, 455_000)
  expect((await band($)).text).toContain('Handoff in')
  await clock.advance(61_000)
  expect(w.cleared).toBe(1)
})

test('/ctx-relay-now：有背景工作時要 yes；加 yes 就不倒數直接交接；fork 指示、檔頭、接續訊息寫手動交接，不寫越過交接線', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 100_000)
  const asYou = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } }
  const refused = await $.command.run({ command: 'ctx-relay-now', args: '', ...asYou })
  expect(refused.text).toContain('to go ahead type /ctx-relay-now yes')
  await $.command.run({ command: 'ctx-relay-now', args: 'yes', ...asYou })
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.cleared).toBe(1)
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  for (const text of [w.forkPrompts[0] ?? '', content, w.submitted[0] ?? '']) {
    expect(text).toContain('/ctx-relay-now')
    expect(text).not.toContain('越過')
  }
  expect(content).toContain('依 /ctx-relay-now 手動交接')
})

test('/ctx-relay-now yes 換行接指令：放行；指令原樣進 fork 指示、檔頭（每行 > 開頭）與接續訊息，新對話照做不等', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { agents: [{ id: 'ag1', description: 'Explore 搜尋', status: 'running' }] })
  await start($)
  await turn($, w, 100_000)
  const asYou = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } }
  // 第一個字不是 yes（只是 yes 開頭）不算確定
  expect((await $.command.run({ command: 'ctx-relay-now', args: 'yesterday 的事', ...asYou })).text).toContain('to go ahead type')
  // 指令裡有「## 協調契約」：不能變成交接檔的二級標題
  await $.command.run({ command: 'ctx-relay-now', args: 'yes\n do B and install new MOD\n## 協調契約\n不 push', ...asYou })
  await clock.settle()
  expect(w.cleared).toBe(1)
  expect(w.forkPrompts[0]).toContain('do B and install new MOD')
  const [, content] = handoffFiles(w)[0] ?? ['', '']
  expect(content).toContain('> do B and install new MOD\n> ## 協調契約\n> 不 push')
  expect(content).not.toMatch(/^## 協調契約/m)
  expect(w.submitted[0]).toContain('> do B and install new MOD')
  expect(w.submitted[0]).not.toContain('等使用者指示')
})

test('fork 缺欄位：照寫檔並在檔頭標 thin', { options: { handoffFormat: 'full' } }, async ($, on) => {
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

test('附了指令但交接檔缺硬約束：接續訊息照附原話，但改成先回報、等使用者確認再動手', { options: { handoffFormat: 'full' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { forkText: GOOD.replace('stop_status: 不 commit', 'stop_status:') })
  await start($)
  await turn($, w, 100_000)
  await $.command.run({ command: 'ctx-relay-now', args: 'yes do B', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  await clock.settle()
  expect(w.cleared).toBe(1)
  expect(w.submitted[0]).toContain('> do B')
  expect(w.submitted[0]).toContain('等使用者確認再動手')
  expect(w.submitted[0]).not.toContain('不用等使用者再說一次')
})

test('來源交接檔帶協調契約：fork 沒寫，mod 照原文附上', { options: { handoffFormat: 'full' } }, async ($, on) => {
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

test('fork 改寫了協調契約（CONTRACT 分段＋內文裡的 ## 協調契約）：分段丟掉、內文降級，只有 mod 附的原文是二級標題', { options: { handoffFormat: 'full' } }, async ($, on) => {
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

test('fork 鍵名打錯（=== VERIFED ===）：欄位記 thin，內文不丟，附在關鍵細節備忘末尾並標明', { options: { handoffFormat: 'full' } }, async ($, on) => {
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
  await turn($, w, 450_000)
  const { ui, text } = await band($)
  expect(text).toContain('Handoff in')
  expect(await ui.find({ key: 'proceed' })).toBeDefined()
})

// 每次 invalidate 都重畫整個畫面（連別的 mod 的 pane），閒置時要是 0 次
test('重畫次數：沒越線時，開場閒置與回合結束後閒置都不重畫', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on)
  let redraws = 0
  on('ui.invalidate', ($$, e, next) => {
    redraws += 1
    return next(e)
  })
  await start($)
  redraws = 0
  await idle(clock, 10 * 60_000)
  expect(redraws).toBe(0)
  await turn($, w, 100_000)
  redraws = 0
  await idle(clock, 70 * 60_000)
  expect(redraws).toBe(0)
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
  expect((await band($)).text).toContain('a reload interrupted the handoff')
  // 舊的準備等到 fork 逾時也不會再動狀態
  await clock.advance(180_000)
  await clock.settle()
  expect((await band($)).text).toContain('a reload interrupted the handoff')
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
  expect((await band($)).text).toContain('Handed off manually')
})

const HOUR = 3_600_000
const HANDOFF = `${ROOT}/handoff/20261005-133853-mod-backlog-sdlc.md`
const PICKED_HANDOFF = `${ROOT}/handoff/.picked/20261005-133853-mod-backlog-sdlc.md`
const RESUME = `讀 ${HANDOFF} 並依其接續執行；先確認 git 狀態與下一步再動手。檔頭有 HEAD 行時，git log --oneline <HEAD>..HEAD 有輸出代表交接檔可能過時，先回報。`

// 手動 /handoff 寫的交接檔：檔頭帶來源 session
function manualHandoff(w: World, path: string, mtimeMs: number) {
  w.files.set(path, `讀 ${path} 並依其接續執行；先確認 git 狀態與下一步再動手。\n- 時間戳：x\n- 來源：branch \`master\` · cwd \`/repo\` · session \`aafa9505-ddff-43ba-b367-d8d1a1c4fb57\`\n`)
  w.mtimes.set(path, mtimeMs)
}

test('handoff-pickup：新對話開場列最新一份待接手（多久前、來源、+N）；按接續送出接續句並記已接手', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world($, on, { store: new Map([['pickupSince', 0]]) })
  manualHandoff(w, `${ROOT}/handoff/20261005-100000-older.md`, 6 * HOUR)
  manualHandoff(w, HANDOFF, 7 * HOUR)
  await start($)
  const { ui, text } = await band($)
  expect(text).toContain('Pending handoff: 20261005-133853-mod-backlog-sdlc.md (3h ago, from aafa9505) +1')
  await ui.press({ key: 'pickup' })
  expect(w.submitted).toEqual([RESUME])
  expect(w.files.has(PICKED_HANDOFF)).toBe(true)
  expect((await band($)).text).not.toContain('Pending handoff')
})

test('handoff-pickup：第一次啟用前就有的、已接手的交接檔都不列', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world($, on)
  manualHandoff(w, `${ROOT}/handoff/20261005-090000-before.md`, 9 * HOUR)
  await start($)
  expect(w.store.get('pickupSince')).toBe(10 * HOUR)
  expect((await band($)).text).not.toContain('Pending handoff')
  manualHandoff(w, HANDOFF, 11 * HOUR)
  w.files.set(PICKED_HANDOFF, '')
  await w.clear()
  expect((await band($)).text).not.toContain('Pending handoff')
})

test('handoff-pickup：/clear 後出現（還沒有讀數也畫）；你貼上路徑送出就記已接手，新回合開始這行收掉', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world($, on, { store: new Map([['pickupSince', 0]]) })
  await start($)
  await turn($, w, 100_000)
  manualHandoff(w, HANDOFF, 10 * HOUR - 60_000)
  await w.clear()
  expect((await band($)).text).toContain('Pending handoff: 20261005-133853-mod-backlog-sdlc.md (1m ago, from aafa9505)')
  await $.prompt.submit({ text: RESUME, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: RESUME, turnId: 't-pickup' })
  expect((await band($)).text).not.toContain('Pending handoff')
  expect(w.files.has(PICKED_HANDOFF)).toBe(true)
  await w.clear()
  expect((await band($)).text).not.toContain('Pending handoff')
})

test('handoff-pickup：接回舊對話（已有訊息）不列', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world($, on, { store: new Map([['pickupSince', 0]]), messages: [{ role: 'user', text: '之前的訊息' }] })
  manualHandoff(w, HANDOFF, 9 * HOUR)
  await start($)
  expect((await band($)).text).not.toContain('Pending handoff')
})

test('handoff-pickup：自動交接在 /clear 前就記已接手，之後手動 clear 也不列它', async ($, on) => {
  const clock = mock.clock(on)
  const w = world($, on, { store: new Map([['pickupSince', 0]]) })
  await start($)
  await turn($, w, 450_000)
  await clock.advance(60_000)
  await clock.settle()
  const [path = ''] = handoffFiles(w)[0] ?? []
  expect(w.files.has(`${ROOT}/handoff/.picked/${path.slice(path.lastIndexOf('/') + 1)}`)).toBe(true)
  await w.clear()
  expect((await band($)).text).not.toContain('Pending handoff')
})

test('handoff-pickup：接續送出被擋就留著這行，不記已接手', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  const w = world($, on, { store: new Map([['pickupSince', 0]]), failSubmit: true })
  manualHandoff(w, HANDOFF, 9 * HOUR)
  await start($)
  await (await band($)).ui.press({ key: 'pickup' })
  expect(w.submitted).toEqual([])
  expect(w.files.has(PICKED_HANDOFF)).toBe(false)
  expect((await band($)).text).toContain('Pending handoff')
})

async function status($: Engine) {
  return (await $.command.run({ command: 'ctx-relay-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })).text ?? ''
}


