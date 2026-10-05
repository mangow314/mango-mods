import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試裡的引擎：記下打開 pane、toast 與替使用者送出的訊息；placed＝false 模擬終端機太窄、pane 沒畫出來
type World = { opens: { id: string; focus?: true }[]; toasts: string[]; submitted: string[]; placed: boolean }

function world(on: On): World {
  const w: World = { opens: [], toasts: [], submitted: [], placed: true }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', (_$, e) => {
    w.opens.push({ id: e.id, focus: e.focus })
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'below 144 columns' } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  return w
}

async function reply($: Engine, answer: string, agentId?: string) {
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

// 同一個 pane id 只能掛一次：每個測試掛一次，之後用 view() 讀當下畫面
async function mount($: Engine, bodyColumns = 60) {
  return $.ui.mount({
    plugin: 'your-turn',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'your-turn',
    props: { title: '要你跑的指令', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
}

type Pane = Awaited<ReturnType<typeof mount>>

// labels＝按鈕文字（每列的 ○／✔ 與回報）；rows＝每列框線內的字（○ $ 指令）；lines＝每列連框線的原樣；
// struck＝加了刪除線的指令；filled＝進度條塗綠的格數；bottoms＝各組下框線；borders＝各組框線顏色
async function view(ui: Pane) {
  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  const texts = await ui.findAll({ type: 'Text' })
  const lines = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-')).map(b => b.text)
  const bottoms = texts.filter(t => t.text.startsWith('╰'))
  return {
    labels,
    lines,
    rows: lines.map(l => l.replace(/^│ /, '').replace(/ *│$/, '')),
    struck: texts.filter(t => t.props.strikethrough === true).map(t => t.text),
    filled: texts.find(t => t.props.color === '#b8bb26' && /^━+$/.test(t.text))?.text.length ?? 0,
    bottoms: bottoms.map(t => t.text),
    borders: bottoms.map(t => t.props.color),
    text: texts.map(t => t.text).join(' '),
  }
}

const TWO = ['```bash', 'sudo pacman -S foo', 'sudo systemctl enable --now foo.service', '```'].join('\n')

test('抽指令：sudo 區塊每行一條（$ 前綴、行尾 \\ 續行）、! 指令（行內與區塊）；一般指令與 ! <佔位> 不算；照回覆順序編號，換地方跑就開新框；打開 pane 並要焦點', async ($, on) => {
  const w = world(on)
  await reply($, [
    '先在提示框打 `! whoami` 確認身分，再裝套件：',
    '```bash',
    'sudo pacman -S foo',
    '$ sudo systemctl enable --now foo.service',
    'sudo cp a.conf \\',
    '  /etc/a.conf',
    'ls -la',
    '```',
    '裝好後在提示框打 `! claude plugin list`；說明寫法是 `! <cmd>`。程式碼裡的 `!e.agentId`、`!important` 不算。',
    '```',
    '! gcloud auth login',
    '```',
  ].join('\n'))
  expect(w.opens).toEqual([{ id: 'your-turn', focus: true }])
  const ui = await mount($)
  const v = await view(ui)
  expect(v.text).toContain('your-turn  6 條指令待你親手跑')
  // 編號照回覆順序，不按分組重排
  expect(v.rows).toEqual([
    '○ ! whoami',
    '○ $ sudo pacman -S foo',
    '○ $ sudo systemctl enable --now foo.service',
    '○ $ sudo cp a.conf /etc/a.conf',
    '○ ! claude plugin list',
    '○ ! gcloud auth login',
  ])
  // 連續在同一處跑的同一框：提示框（1）、終端機（2–4）、提示框（5–6）三個框
  expect(v.borders).toEqual(['#8ec07c', '#fabd2f', '#8ec07c'])
  // 框線右緣對齊：每列加上引擎畫的「1: 」3 欄、每條下框線，都剛好 pane 寬 60 欄
  expect(v.lines.map(l => l.length + 3)).toEqual([60, 60, 60, 60, 60, 60])
  expect(v.bottoms.map(b => b.length)).toEqual([60, 60, 60])
  // 只有勾完的那框變深灰，同組的另一框維持原色
  for (const key of ['step-2', 'step-3', 'step-4']) await ui.press({ key })
  expect((await view(ui)).borders).toEqual(['#8ec07c', '#504945', '#8ec07c'])
})

test('同一條指令在後面的步驟再出現就再列一次；緊接著重複提到的只列一次', async ($, on) => {
  world(on)
  const ui = await mount($)
  await reply($, [
    '先在提示框打 `! whoami`，看 `! whoami` 印出誰，再跑：',
    '```bash',
    'sudo -k',
    'sudo true',
    '```',
    '接著打 `! date`，最後再清一次：',
    '```bash',
    'sudo -k',
    '```',
  ].join('\n'))
  const v = await view(ui)
  expect(v.rows).toEqual(['○ ! whoami', '○ $ sudo -k', '○ $ sudo true', '○ ! date', '○ $ sudo -k'])
  expect(v.borders).toEqual(['#8ec07c', '#fabd2f', '#8ec07c', '#fabd2f'])
})

test('數字鍵勾選、再按取消；全部勾完出現回報，按下送出「N/N 完成了」', async ($, on) => {
  const w = world(on)
  await reply($, TWO)
  const ui = await mount($)
  expect((await view(ui)).labels).not.toContain('回報 2/2 完成')
  const start = await view(ui)
  expect(start.text).toContain('進度 ')
  expect(start.text).toContain(' 0/2')
  expect(start.text).toContain('1–2 勾選 │ 再按一次 取消')
  // 組裡還有沒做完的：框線用該組顏色（終端機組＝黃）
  expect(start.borders).toEqual(['#fabd2f'])
  await ui.press({ key: 'step-1' })
  // 進度條：60 欄時 16 格，勾了 1/2 塗 8 格
  expect((await view(ui)).filled).toBe(8)
  await ui.press({ key: 'step-2' })
  const done = await view(ui)
  expect(done.rows.map(r => r[0])).toEqual(['✔', '✔'])
  expect(done.struck).toEqual(['sudo pacman -S foo', 'sudo systemctl enable --now foo.service'])
  expect(done.labels).toContain('回報 2/2 完成')
  expect(done.text).toContain(' 2/2')
  expect(done.text).toContain('回報 告訴 Claude 全部完成')
  expect(done.filled).toBe(16)
  // 全做完：框線變深灰
  expect(done.borders).toEqual(['#504945'])
  await ui.press({ key: 'step-2' })
  expect((await view(ui)).labels).not.toContain('回報 2/2 完成')
  await ui.press({ key: 'step-2' })
  await ui.press({ key: 'report' })
  expect(w.submitted).toEqual(['2/2 完成了'])
})

test('沒有新指令的回覆不動清單、不再打開；子代理回合不算；帶新指令就重算', async ($, on) => {
  const w = world(on)
  await reply($, TWO)
  const ui = await mount($)
  await ui.press({ key: 'step-1' })
  await reply($, '裝好了就跟我說。')
  await reply($, '```\nsudo rm /tmp/x\n```', 'agent-1')
  expect(w.opens).toHaveLength(1)
  expect((await view(ui)).struck).toEqual(['sudo pacman -S foo'])
  await reply($, '```\nsudo systemctl restart bar\n```')
  expect(w.opens).toHaveLength(2)
  const after = await view(ui)
  expect(after.rows).toEqual(['○ $ sudo systemctl restart bar'])
  expect(after.struck).toEqual([])
})

test('終端機太窄沒畫出來：跳 toast 提示打 /your-turn；/your-turn 打開清單', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  w.placed = false
  await reply($, TWO)
  expect(w.toasts).toEqual(['your-turn：2 條要你親手跑的指令，終端機太窄沒畫出來，打 /your-turn 打開'])
  w.placed = true
  const run = await $.command.run({ command: 'your-turn', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 141 } })
  expect(run.text).toBe('[your-turn] 已打開清單')
  expect(w.opens).toEqual([{ id: 'your-turn', focus: true }, { id: 'your-turn', focus: true }])
  expect(w.toasts).toHaveLength(1)
})

test('指令太長就截斷；還沒有指令時 pane 顯示提示', async ($, on) => {
  world(on)
  const ui = await mount($, 40)
  expect((await view(ui)).text).toContain('沒有要你跑的指令')
  const long = `sudo pacman -S ${'pkg '.repeat(30)}`.trim()
  await reply($, `\`\`\`\n${long}\n\`\`\``)
  // 40 欄扣掉每列固定的 11 欄（框線與內距 4 欄、編號與 ○ 與 $ 7 欄），指令剩 29 欄
  expect((await view(ui)).rows[0]).toBe(`○ $ ${long.slice(0, 28)}…`)
})
