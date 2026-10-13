import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試裡的引擎：記下引擎拿到的回覆正文（mod 改寫後）、填進提示框的字、挑編號模型收到的請求
// pick＝挑編號模型這次的回答：字串照回、{ fail } 回失敗原因
// hold＝設了就讓模型卡住，直到測試放行（模擬模型回答要幾秒）
type World = { bodies: string[]; fills: string[]; asks: { model: string; prompt: string }[]; pick: string | { fail: string }; hold: Promise<void> | null }

function world(on: On): World {
  const w: World = { bodies: [], fills: [], asks: [], pick: '{}', hold: null }
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('model.complete', async (_$, e) => {
    w.asks.push({ model: e.model, prompt: e.prompt })
    if (w.hold) await w.hold
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: typeof w.pick === 'string' ? { isAnswered: true as const, text: w.pick, usage } : { isAnswered: false as const, reason: w.pick.fail as 'empty-reply', usage } }
  })
  // 引擎自己的畫法：回覆畫正文、其餘畫一行「engine」，看得出 mod 有沒有換掉
  on('ui.render', { component: 'AssistantMessage' }, ($$, e) => {
    w.bodies.push(e.props.text)
    return $$.ui.resolve(e).Text({ children: e.props.text })
  })
  on('ui.render', { component: 'TurnDuration' }, ($$, e) => $$.ui.resolve(e).Text({ children: `engine ${e.props.word}` }))
  on('ui.render', { component: 'UserMessage' }, ($$, e) => $$.ui.resolve(e).Text({ children: `engine ${e.props.text}` }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => $$.ui.resolve(e).Text({ children: 'engine' }))
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  return w
}

// 既有測試照中文標籤寫（language 預設 en）
const ZH = { options: { language: 'zh-TW' } }

// 夠長才摘錄：每則測試回覆最後補一行 800 字
const PAD = '補'.repeat(800)
const long = (...lines: string[]) => [...lines, '', PAD].join('\n')

// 挑編號模型的回答用原句寫，這裡換成編號（同 mod 的編法：程式碼區塊外的非空白行，從 1 起）
type Picks = {
  status?: string
  outcome: string
  decisions?: { question: string; options: string[]; recommended?: string }[]
  todo?: string[]
  next?: string[]
  sections?: { heading: string; summary: string }[]
}
function picks(reply: string, p: Picks): string {
  const lines: string[] = []
  let inFence = false
  for (const raw of reply.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('```')) inFence = !inFence
    else if (!inFence && l !== '' && !/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(l)) lines.push(l)
  }
  const n = (line: string) => {
    const at = lines.indexOf(line)
    if (at < 0) throw new Error(`回覆裡沒有這行：${line}`)
    return at + 1
  }
  return JSON.stringify({
    status: p.status ?? 'done',
    outcome: n(p.outcome),
    decisions: (p.decisions ?? []).map(d => ({ question: n(d.question), options: d.options.map(n), ...(d.recommended ? { recommended: n(d.recommended) } : {}) })),
    todo: (p.todo ?? []).map(n),
    next: (p.next ?? []).map(n),
    sections: (p.sections ?? []).map(s => ({ heading: n(s.heading), summary: n(s.summary) })),
  })
}

const REPLY = long(
  '## 結果', '照 A 改好，測試全過。',
  '## 驗證', '- 51 pass · tsc ✓', '- claude plugin test .：51 pass',
  '## 待你決定', '1. mod 放哪？', '- 選項 A：開新 mod', '- 選項 B：併進 your-turn', '2. band 再精簡？', '- 選項 A：拿掉', '- 選項 B：保留', '- 明天實機看 5 處',
)
const PICKS = picks(REPLY, {
  outcome: '照 A 改好，測試全過。',
  decisions: [
    { question: '1. mod 放哪？', options: ['- 選項 A：開新 mod', '- 選項 B：併進 your-turn'], recommended: '- 選項 A：開新 mod' },
    { question: '2. band 再精簡？', options: ['- 選項 A：拿掉', '- 選項 B：保留'] },
  ],
  todo: ['- 明天實機看 5 處'],
  sections: [{ heading: '## 驗證', summary: '- 51 pass · tsc ✓' }],
})

// 同 REPLY 的行與編號，標題換成規則認不出的字：結論、題目、段落全照模型挑的
const RAW = REPLY.replace('## 結果', '## 現況').replace('## 驗證', '## 跑過的').replace('## 待你決定', '## 請你挑')
// 沒有標題的長回覆
const PLAIN = long('照 A 改好。', '細節如下。')

type Clock = ReturnType<typeof mock.clock>

// 主對話一輪結束、挑編號模型照 pick 回答，等摘錄寫回。照實測順序先跑 classic.Stop（個人帳號）；guarded＝Team 帳號收不到
async function say($: Engine, clock: Clock, w: World, answer: string, pick: World['pick'], durationMs = 10_000, guarded = false) {
  w.pick = pick
  if (!guarded) await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' }] })
  await $.turn.complete({ answer, durationMs, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(0)
  await clock.settle()
}

async function message($: Engine, text: string) {
  return $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
}

async function texts(ui: { findAll: Awaited<ReturnType<typeof message>>['findAll'] }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
}

test('不改系統提示：沒有 prompt.compose 的段落', ZH, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(s => s.id)).toEqual(['intro'])
})

test('長回覆：回合結束後請 haiku 挑編號（程式碼區塊不編號），框裡的字全是回覆原句', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 結果', '照 A 改好。', '```', 'code 不編號', '```')
  await $.turn.complete({ answer: reply, durationMs: 5_000, isAborted: false, turnId: 't', reason: 'answer' })
  // 模型還沒回：框的位置寫摘錄中
  expect(await texts(await message($, reply))).toContain('摘錄中')
  w.pick = picks(reply, { outcome: '照 A 改好。' })
  await clock.advance(0)
  await clock.settle()
  expect(w.asks.map(a => a.model)).toEqual(['haiku'])
  expect(w.asks[0]?.prompt).toContain('[2] 照 A 改好。')
  expect(w.asks[0]?.prompt).not.toContain('code 不編號')
  const text = await texts(await message($, reply))
  expect(text).toContain('✓ 完成')
  expect(text).toContain('摘錄')
  expect(text).toContain('照 A 改好。')
})

test('預設英文標籤：狀態、選項、你要做、待答列；英文的 Decisions 段一樣從正文拿掉', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  // 補長度的那行放在 Decisions 之前：Decisions 段的說明會攤在框裡
  const reply = [
    '## Result', 'greet() takes a name now.',
    '## Checks', '- 3 pass', '', PAD, '',
    '## Decisions', 'Which one next?', '- Option A: pytest', '- Option B: mypy', '- Re-run the demo by hand',
  ].join('\n')
  await say($, clock, w, reply, picks(reply, {
    status: 'blocked',
    outcome: 'greet() takes a name now.',
    decisions: [{ question: 'Which one next?', options: ['- Option A: pytest', '- Option B: mypy'], recommended: '- Option A: pytest' }],
    todo: ['- Re-run the demo by hand'],
    sections: [{ heading: '## Checks', summary: '- 3 pass' }],
  }))
  const text = await texts(await message($, reply))
  expect(text).toContain('? Your call')
  expect(text).toContain('excerpt')
  expect(text).toContain('? Which one next?')
  expect(text).toContain(' pytest')
  expect(text).toContain('recommended')
  expect(text).toContain('You do  Re-run the demo by hand')
  expect(w.bodies.at(-1)).not.toContain('## Decisions')
  expect(text).not.toMatch(/[\u4e00-\u9fff]/)
  expect(await texts(await above($))).toContain('? 1 open')
})

test('推薦標記：選項最後一行放不下就換到下一行，不讓引擎折行', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const full = 'x'.repeat(79)
  const reply = long('Pick one.', 'Which?', `- Option A: ${full}`, '- Option B: short')
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: 'Pick one.', decisions: [{ question: 'Which?', options: [`- Option A: ${full}`, '- Option B: short'], recommended: `- Option A: ${full}` }] }))
  const cells = (await (await message($, reply)).findAll({ type: 'Text' })).map(t => t.text)
  expect(cells).toContain(` ${full}`)
  expect(cells).toContain('  recommended')
})

test('預設英文標籤：短回覆寫 no excerpt，編號對不上寫 excerpt failed', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, 'Done.', '{}', 12_000)
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 12_000 } })
  expect(await texts(ui)).toContain('– turn ended (no excerpt)')
  await say($, clock, w, PLAIN, JSON.stringify({ status: 'done', outcome: 999 }))
  expect(await texts(await message($, PLAIN))).toContain('excerpt failed: line numbers did not match the reply')
})

test('短回覆不呼叫模型，回合結束那列寫無摘錄', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, '好，改了。', '{}', 12_000)
  expect(w.asks).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 12_000 } })
  expect(await texts(ui)).toContain('– 本輪結束（無摘錄）')
  expect(w.bodies.length).toBe(0)
  await message($, '好，改了。')
  expect(w.bodies.at(-1)).toBe('好，改了。')
})

test('短回覆但有 2 個以上標題（分段的完工報告）一樣摘錄', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = '## 結果\n改好了。\n\n## 驗證\n- 3 pass'
  await say($, clock, w, reply, picks(reply, { outcome: '改好了。', sections: [{ heading: '## 驗證', summary: '- 3 pass' }] }))
  expect(w.asks).toHaveLength(1)
  expect(await texts(await message($, reply))).toContain('✓ 完成')
})

test('編號超出範圍或結論指到標題：整份不收，框的位置寫摘錄失敗', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  // 沒有「結果」這類標題：結論全靠模型，指錯就整份不收
  await say($, clock, w, RAW, JSON.stringify({ status: 'done', outcome: 999 }))
  expect(await texts(await message($, RAW))).toContain('摘錄失敗：回傳的編號對不上原文')
  await say($, clock, w, RAW, JSON.stringify({ status: 'done', outcome: 1 }))
  expect(await texts(await message($, RAW))).toContain('摘錄失敗：回傳的編號對不上原文')
})

test('次要欄位指錯只丟那一項：你要做、段落、選項指錯時框照畫，其餘照常', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const bad = JSON.parse(PICKS) as { todo: number[]; sections: { heading: number; summary: number }[]; decisions: { options: number[] }[] }
  bad.todo = [999]
  bad.sections = [{ heading: 2, summary: 3 }]
  bad.decisions[1] = { ...bad.decisions[1], options: [10, 999] }
  await say($, clock, w, RAW, JSON.stringify(bad))
  const ui = await message($, RAW)
  // 標題認不出時沒有段落收進框，正文照原樣在；只看框裡的字（正文是一整塊多行的 Text）
  const box = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !t.includes('\n')).join(' ')
  expect(box).not.toContain('摘錄失敗')
  expect(box).toContain('照 A 改好，測試全過。')
  expect(box).toContain('開新 mod')
  expect(box).toContain('band 再精簡？')
  expect(box).not.toContain('拿掉')
  expect(box).not.toContain('明天實機看 5 處')
})

test('認得的標題照標題改寫模型挑錯的編號：結果段第一行當結論、待你決定段的 A／B 連號當選項、驗證段第一行當摘要', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  // 模型把結論挑成你要做那行、漏了題目與段落
  await say($, clock, w, REPLY, picks(REPLY, { outcome: '- 明天實機看 5 處' }))
  const text = await texts(await message($, REPLY))
  expect(text).not.toContain('摘錄失敗')
  expect(text).toContain('照 A 改好，測試全過。')
  expect(text).toContain('? 等你決定')
  expect(text).toContain('1. mod 放哪？')
  expect(text).toContain('併進 your-turn')
  expect(text).toContain('拿掉')
  expect(text).toContain('51 pass · tsc ✓')
  expect(w.bodies.at(-1) ?? '').not.toContain('51 pass')
})

test('標題規則的推薦：選項後面寫「建議」的那行標推薦；「e.g.」這類小寫開頭不當選項', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 結果', '研究完成。', '## 待你決定', '先修哪個？', '- A. 照標題解析', '- B. 標題上色', '我建議 A，判斷準了畫面才有意義。', '- e.g. 這行不是選項')
  await say($, clock, w, reply, picks(reply, { outcome: '研究完成。' }))
  const ui = await message($, reply)
  const text = await texts(ui)
  expect(text).toContain('先修哪個？')
  expect(text).toMatch(/照標題解析\s+建議/)
  expect(text).not.toMatch(/標題上色\s+建議/)
  // 不當選項＝沒有 C 鍵；這行是說明，攤在題目底下
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.props.label).trim())).not.toContain('C')
  expect(text).toContain('e.g. 這行不是選項')
})

test('推薦指到選項後面那句「I\'d pick A」：取那句第一個選項字母；認不出字母就不標推薦，框照畫', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('Pick one.', 'Which?', '- Option A: pytest', '- Option B: mypy', "- I'd pick A: faster now, add B later.")
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: 'Pick one.', decisions: [{ question: 'Which?', options: ['- Option A: pytest', '- Option B: mypy'], recommended: "- I'd pick A: faster now, add B later." }] }))
  const text = await texts(await message($, reply))
  expect(text).toContain('? Your call')
  expect(text).toMatch(/pytest.*recommended.*mypy/)
  const plain = long('Pick one.', 'Which?', '- Option A: pytest', '- Option B: mypy', '- Either works.')
  await say($, clock, w, plain, picks(plain, { status: 'blocked', outcome: 'Pick one.', decisions: [{ question: 'Which?', options: ['- Option A: pytest', '- Option B: mypy'], recommended: '- Either works.' }] }))
  const none = await texts(await message($, plain))
  expect(none).toContain('? Your call')
  expect(none).not.toContain('recommended')
})

test('模型沒回答：框的位置照實寫原因，回合結束那列也是', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, { fail: 'api-error' }, 20_000)
  expect(await texts(await message($, REPLY))).toContain('摘錄失敗：api-error')
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 20_000 } })
  expect(await texts(ui)).toContain('摘錄失敗：api-error')
})

test('摘錄回來前新一輪已開始：作廢，不畫框、不動待決題目', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.pick = PICKS
  let release = () => {}
  w.hold = new Promise(r => (release = r))
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(0)
  expect(w.asks).toHaveLength(1)
  await $.turn.start({ text: '下一題', turnId: 't2' })
  release()
  await clock.settle()
  const text = await texts(await message($, REPLY))
  expect(text).not.toContain('等你決定')
  expect(text).not.toContain('摘錄中')
  expect(await texts(await above($))).not.toContain('題待決')
})

test('回覆：驗證段落收成一行、兩題畫進等你決定的框', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await message($, REPLY)
  const body = w.bodies.at(-1) ?? ''
  expect(body).not.toContain('51 pass')
  // 有題目時「待你決定」段從正文拿掉，題目不在正文再寫一次
  expect(body).not.toContain('## 待你決定')
  const text = await texts(ui)
  expect(text).toContain('驗證')
  expect(text).toContain('51 pass · tsc ✓')
  expect(text).toContain('? 等你決定')
  expect(text).toContain('1. mod 放哪？')
  expect(text).toContain('開新 mod')
  expect(text).toContain('建議')
  expect(text).toContain('你要做  明天實機看 5 處')
})

test('選項指回題目那行或重複：當成開放題，只畫題目、沒有選項按鈕，框一樣標等你決定', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('計畫如上。', 'mods 現在怎麼啟用？要開旗標還是直接能載入？', '確認後我就開始做。')
  await say($, clock, w, reply, JSON.stringify({ status: 'blocked', outcome: 1, decisions: [{ question: 2, options: [2, 2] }], todo: [], next: [] }))
  const ui = await message($, reply)
  const text = await texts(ui)
  expect(text).toContain('? 等你決定')
  expect(text).toContain('? mods 現在怎麼啟用？')
  expect(text).not.toContain('之後我')
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.label).includes('mods'))).toHaveLength(0)
  expect(await texts(await above($))).not.toContain('題待決')
})

test('表格列：分隔列不編號，挑到的表格列去掉直線、格子用 · 接起來；跟結論同一句的不再列', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 計畫', '| 階段 | 內容 |', '|---|---|', '| 5 收尾 | push 由你做 |', '## 結果', '確認後開始。')
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: '確認後開始。', todo: ['| 5 收尾 | push 由你做 |'], next: ['確認後開始。'], sections: [{ heading: '## 計畫', summary: '| 階段 | 內容 |' }] }))
  const text = await texts(await message($, reply))
  expect(text).toContain('你要做  5 收尾 · push 由你做')
  expect(text).toContain('階段 · 內容')
  expect(text).not.toContain('|')
  expect(text).not.toContain('之後我')
})

test('選項一行一個、標籤不截斷；prompt 上方那列照舊截短', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const a = '- 選項 A：加 language 設定，預設英文，GIF 也用英文重錄'
  const reply = long('二選一。', '標籤怎麼處理？', a, '- 選項 B：維持中文，README 放對照表')
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: '二選一。', decisions: [{ question: '標籤怎麼處理？', options: [a, '- 選項 B：維持中文，README 放對照表'] }] }))
  // 正文本來就有這句，所以要找框裡選項那格的字
  const cells = (await (await message($, reply)).findAll({ type: 'Text' })).map(t => t.text)
  expect(cells).toContain(' 加 language 設定，預設英文，GIF 也用英文重錄')
  const labels = (await (await above($)).findAll({ type: 'Button' })).map(b => String(b.props.label))
  expect(labels.some(l => l.endsWith('…'))).toBe(true)
})

test('按選項：依題號把已選的答案填進提示框，不送出', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await message($, REPLY)
  await ui.press({ key: 'pick-1-B' })
  await ui.press({ key: 'pick-0-A' })
  expect(w.fills).toEqual(['2. B', '1. A  2. B'])
})

test('收合的段落按 ▸ 放回正文原位（不畫在框裡），再按收回；待你決定段沒有 ▸，一直不在正文', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await message($, REPLY)
  expect(w.bodies.at(-1)).not.toContain('claude plugin test')
  await ui.press({ key: 'toggle-0' })
  expect(w.bodies.at(-1)).toContain('## 驗證\n- 51 pass · tsc ✓\n- claude plugin test .：51 pass')
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
  expect(await texts(ui)).toContain('已放回正文')
  await ui.press({ key: 'toggle-0' })
  expect(w.bodies.at(-1)).not.toContain('claude plugin test')
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).not.toContain('toggle-1')
  expect(w.bodies.at(-1)).not.toContain('## 待你決定')
})

test('待你決定段的說明攤在框裡題目底下，不用按 ▸；題目、選項、你要做不重列', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 結果', '研究完成。', '## 待你決定', '先修哪個？', '- 選項 A：照標題解析', '- 選項 B：標題上色', '我建議 A：判斷準了，畫面才有意義。', '- 明天實機看一次')
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: '研究完成。', todo: ['- 明天實機看一次'] }))
  const ui = await message($, reply)
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !t.includes('\n'))
  expect(lines).toContain('  我建議 A：判斷準了，畫面才有意義。')
  // 說明行是「兩格縮排＋原句」；你要做、選項那幾行不再以說明列出
  expect(lines).not.toContain('  明天實機看一次')
  expect(lines).not.toContain('  選項 A：照標題解析')
  expect(w.bodies.at(-1)).not.toContain('我建議 A')
})

test('兩題各自的說明畫在自己的選項底下：第一題的「我建議」排在第二題題目之前', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 結果', '研究完成。', '## 待你決定', '1. 先修哪個？', '- 選項 A：照標題解析', '- 選項 B：標題上色', '我建議 A：判斷準了才有意義。',
    '2. 版本怎麼跳？', '- 選項 A：0.6.1', '- 選項 B：0.7.0', '我建議 B：對外行為變了。')
  await say($, clock, w, reply, picks(reply, { status: 'blocked', outcome: '研究完成。' }))
  const lines = (await (await message($, reply)).findAll({ type: 'Text' })).map(t => t.text).filter(t => !t.includes('\n'))
  const at = (s: string) => lines.findIndex(l => l.includes(s))
  expect(at('我建議 A：判斷準了')).toBeGreaterThan(at('標題上色'))
  expect(at('我建議 A：判斷準了')).toBeLessThan(at('版本怎麼跳？'))
  expect(at('我建議 B：對外行為變了')).toBeGreaterThan(at('0.7.0'))
})

test('你要做的原句自己以「你要做：」開頭：框裡不重複標籤', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('## 結果', '改好了。', '你要做：明天實機看一次')
  await say($, clock, w, reply, picks(reply, { status: 'partial', outcome: '改好了。', todo: ['你要做：明天實機看一次'] }))
  const text = await texts(await message($, reply))
  expect(text).toContain('你要做  明天實機看一次')
  expect(text).not.toContain('你要做  你要做')
})

test('收合列的標籤補到同寬，摘要排成一直欄（中文字算 2 欄）', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('好。', '## 變更', '改 README', '## 殘留風險', '巢狀清單')
  await say($, clock, w, reply, picks(reply, { outcome: '好。', sections: [{ heading: '## 變更', summary: '改 README' }, { heading: '## 殘留風險', summary: '巢狀清單' }] }))
  const labels = (await (await message($, reply)).findAll({ type: 'Text' })).map(t => t.text).filter(t => /變更|殘留風險/.test(t))
  expect(labels).toEqual([' 變更      ', ' 殘留風險  '])
})

test('沒有摘錄的回覆照原樣交給引擎', ZH, async ($, on) => {
  const w = world(on)
  await message($, '## 結果\n普通回覆')
  expect(w.bodies.at(-1)).toBe('## 結果\n普通回覆')
})

test('結論條畫在回覆裡：狀態標籤＋結論＋耗時；框寬固定、標題疊在上框線', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS, 161_000)
  const ui = await message($, REPLY)
  expect(await texts(ui)).toContain('等你決定')
  expect(await texts(ui)).toContain('照 A 改好，測試全過')
  expect(await texts(ui)).toContain('2m 41s')
  // 框寬固定：終端寬減 4、最寬 88；標題疊在上框線（框的後一個兄弟，absolute）
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(b => b.props.width !== undefined).map(b => b.props.width)).toEqual([88])
  expect(boxes.some(b => b.props.position === 'absolute' && b.props.top === 0)).toBe(true)
})

test('回合結束那列：有摘錄的交給引擎原樣畫；沒摘錄的換成灰色提示；子代理的不算', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS, 161_000)
  await $.turn.complete({ answer: '子代理的回報', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await say($, clock, w, '短回覆', '{}', 12_000)
  const row = async (durationMs: number) => {
    const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs } })
    return texts(ui)
  }
  expect(await row(161_000)).toContain('engine Baked')
  expect(await row(12_000)).toContain('– 本輪結束（無摘錄）')
  // 耗時差幾百毫秒也對得回去
  expect(await row(12_600)).toContain('本輪結束')
  expect(await row(5_000)).toContain('engine Baked')
})

test('沒有題目但有你要做的事：框標成等你動手，你要做排在結論下面，之後我排最後', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const reply = long('子代理在跑。', '- 等子代理回報', '- 重開終端')
  await say($, clock, w, reply, picks(reply, { status: 'partial', outcome: '子代理在跑。', next: ['- 等子代理回報'], todo: ['- 重開終端'] }))
  const ui = await message($, reply)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(b => b.props.borderStyle !== undefined)).toHaveLength(1)
  const text = await texts(ui)
  expect(text).toContain('> 等你動手')
  expect(text).not.toContain('進行中')
  expect(text.indexOf('你要做  重開終端')).toBeGreaterThan(text.indexOf('子代理在跑'))
  expect(text.indexOf('之後我  等子代理回報')).toBeGreaterThan(text.indexOf('你要做  重開終端'))
  // 只有之後我、沒有你要做的才是進行中
  const later = long('已派。', '- 等回報')
  await say($, clock, w, later, picks(later, { status: 'partial', outcome: '已派。', next: ['- 等回報'] }))
  expect(await texts(await message($, later))).toContain('~ 進行中')
})

test('子代理回報那列：收合時換成第一句，展開時照原樣', ZH, async ($, on) => {
  world(on)
  const props = { text: '## 結果\n找到 5 個可借做法。其餘見下。\n\n細節…', origin: { kind: 'peer' as const }, from: { name: 'general-purpose' } }
  const collapsed = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'UserMessage', props: { ...props, isExpanded: false } })
  const text = await texts(collapsed)
  expect(text).toContain('general-purpose')
  expect(text).toContain('找到 5 個可借做法。')
  expect(text).not.toContain('其餘見下')
  const expanded = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'UserMessage', props: { ...props, isExpanded: true } })
  expect(await texts(expanded)).not.toContain('ctrl+o 看全文')
})

test('背景工作通知列：完成灰 ✓、失敗紅 !，展開時照原樣', ZH, async ($, on) => {
  world(on)
  const row = (status: string, isExpanded = false) => $.ui.mount({
    plugin: 'sitrep',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'Agent "網路研究" completed', origin: { kind: 'task-notification' as const }, task: { id: 'a1', status, durationMs: 54_000 }, isExpanded },
  })
  const done = await row('completed')
  expect(await texts(done)).toContain('✓')
  expect(await texts(done)).toContain('54s')
  const failed = await row('failed')
  expect((await failed.findAll({ type: 'Text' })).find(t => t.text === '! ')?.props.color).toBe('error')
  expect(await texts(await row('completed', true))).toContain('engine Agent')
})

test('ASCII 圖：切出來畫在灰底區塊、上方標「圖」，前後段照舊交給引擎；一般程式碼區塊不動', ZH, async ($, on) => {
  const w = world(on)
  const fig = '┌───┐  →  ┌───┐\n│ A │     │ B │\n└───┘     └───┘'
  const ui = await message($, `前言\n\n\`\`\`\n${fig}\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |`)
  expect(w.bodies.slice(-2)).toEqual(['前言', '| a | b |\n|---|---|\n| 1 | 2 |'])
  expect(await texts(ui)).toContain('圖')
  expect(await texts(ui)).toContain('│ A │     │ B │')
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined)).toHaveLength(1)
  await message($, '```py\nprint("a -> b")\nx = 1\n```')
  expect(w.bodies.at(-1)).toBe('```py\nprint("a -> b")\nx = 1\n```')
})

test('純 ASCII 圖（+--+ 方框、|-- 樹，沒有箭頭）也畫成灰底圖', ZH, async ($, on) => {
  world(on)
  const box = await message($, '```\n+-----+    +-----+\n| A   |    | B   |\n+-----+    +-----+\n```')
  expect(await texts(box)).toContain('圖')
  const tree = await message($, '```\nroot\n|-- a\n`-- b\n```')
  expect(await texts(tree)).toContain('圖')
})

test('交接草稿這類文字區塊：句子裡有箭頭、清單有樹記號也不當成圖', ZH, async ($, on) => {
  const w = world(on)
  const draft = '# 修 sitrep 誤判\nphase: 2\n- 現狀：原本 → 收緊後\n- 下一步：跑測試 → 收尾\n- |-- 的樹在清單裡\n硬約束：不改 ctx-relay。'
  const ui = await message($, `交接：\n\n\`\`\`\n${draft}\n\`\`\``)
  expect(w.bodies.at(-1)).toContain('# 修 sitrep 誤判')
  expect(await texts(ui)).not.toContain('圖')
  // 只有一行帶記號的短區塊也不是圖
  await message($, '```\nA --> B\n```')
  expect(w.bodies.at(-1)).toBe('```\nA --> B\n```')
})

const DOT = 'digraph { a -> b; b -> c [label="x"]; a -> c }'

test('dot 區塊：跟 ASCII 圖一樣畫灰底原文，標籤附粗算的節點與邊數；不跑任何指令', ZH, async ($, on) => {
  const w = world(on)
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await message($, `看圖：\n\n\`\`\`dot\n${DOT}\n\`\`\`\n\n結尾。`)
  expect(await texts(ui)).toContain('圖：3 個節點、3 條邊（dot 原文）')
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined)).toHaveLength(1)
  expect(w.bodies.slice(-2)).toEqual(['看圖：', '結尾。'])
  expect(runs).toHaveLength(0)
})

test('結論框：這一輪派出的背景子代理列在框裡，跑的時候轉圈＋已跑時間，跑完換成 ✓ 和耗時', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const agent = { id: 'a1', description: '摘要 ctx-relay README', type: 'Explore', status: 'running' as const }
  on('agent.list', () => ({ value: [agent] }))
  await say($, clock, w, REPLY, PICKS, 6_000)
  const ui = await message($, REPLY)
  const row = async () => (await texts(ui)).match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])  Explore   摘要 ctx-relay README   執行中 (\d+s)/)
  const first = await row()
  expect(first?.[2]).toBe('0s')
  // 每 250ms 一幀：字形換下一個；3 秒後已跑時間跟著走
  await clock.advance(250)
  await ui.redraw()
  expect((await row())?.[1]).not.toBe(first?.[1])
  await clock.advance(2_750)
  await ui.redraw()
  expect((await row())?.[2]).toBe('3s')
  await $.turn.complete({ answer: '摘要', durationMs: 4_000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await ui.redraw()
  expect(await texts(ui)).toContain('✓  Explore   摘要 ctx-relay README   4s')
})

// pane 的假環境：記下開關；env 給 TMUX 與否；git diff --stat 回兩個檔
// placed: false＝開了但沒畫出來（這裡沒有能放 pane 的畫面）
function paneWorld(on: On, opts: { tmux?: boolean; placed?: boolean } = {}) {
  const p = { opens: [] as string[], closes: [] as string[], open: new Set<string>() }
  on('env.get', (_$, e) => ({ value: e.name === 'TMUX' && opts.tmux ? '/tmp/tmux-1000/default,1,0' : undefined }))
  // git：repo 在 /repo；未 commit 的是 sitrep/a.ts（這次改的）與 your-turn 兩個檔（不是這次改的）
  on('process.run', (_$, e) => {
    const stdout = e.argv[1] === 'rev-parse' ? '/repo\n' : e.argv[1] === 'diff' ? '3\t1\tsitrep/a.ts\n2\t0\tyour-turn/x.ts\n1\t1\tyour-turn/y.ts\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }) as never)
  on('ui.panes', () => ({ value: [...p.open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', (_$, e) => {
    p.opens.push(e.id)
    p.open.add(e.id)
    return { value: opts.placed === false ? { isPlaced: false as const, reason: 'no surface places panes' } : { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    p.closes.push(e.id)
    p.open.delete(e.id)
    return { value: undefined }
  })
  return p
}

async function pane($: Engine) {
  return $.ui.mount({
    plugin: 'sitrep',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sitrep',
    props: { title: 'sitrep', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

const sitrepPane = ($: Engine) => $.command.run({ command: 'sitrep-pane', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })

test('pane 證據段：沒有驗證段的回合沿用上一次的證據，標題註明幾輪前', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  await say($, clock, w, REPLY, PICKS)
  const ask = long('問兩題。')
  await say($, clock, w, ask, picks(ask, { outcome: '問兩題。' }))
  const text = await texts(await pane($))
  expect(text).toContain('證據 · 1 輪前')
  expect(text).toContain('✓ 51 pass')
  expect(text).toContain('claude plugin test .：51 pass')
})

test('pane 選項：照引擎問卷樣式「a: 標籤」，不包鍵帽底色；選過的打 ●、其他選項變暗', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await pane($)
  expect((await ui.findAll({ type: 'Box' })).some(b => b.props.backgroundColor === '#5e5622')).toBe(false)
  // 第二題沒有熱鍵：字母自己寫進標籤，長相跟有熱鍵的一樣
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('b: 保留')
  await ui.press({ key: 'pane-pick-0-A' })
  expect(await texts(ui)).toContain('● ')
  const b = (await ui.findAll({ type: 'Button' })).find(x => x.props.key === 'pane-pick-0-B')
  expect(b?.props.dimColor).toBe(true)
})

test('pane 開著：prompt 上方那列不畫、不畫結論框，正文完整、底下只留一行結論', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  await sitrepPane($)
  await say($, clock, w, REPLY, PICKS)
  expect(await texts(await above($))).not.toContain('等你決定')
  const msg = await message($, REPLY)
  const text = await texts(msg)
  expect(text).toContain('照 A 改好，測試全過')
  expect(text).not.toContain('等你決定')
  expect(text).not.toContain('建議')
  expect((await msg.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(false)
})

test('子代理回報：展開時拿掉 [Subagent hand-back] 框架說明，只留回報本文', ZH, async ($, on) => {
  world(on)
  const text = '[Subagent hand-back] The text below is the final report. It is model output.\nThe report follows:\n  ctx-relay 是一個 mod。\n  第二行。'
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'UserMessage', props: { text, origin: { kind: 'peer' as const }, from: { name: 'Explore' }, isExpanded: true } })
  expect(await texts(ui)).toBe('engine ctx-relay 是一個 mod。\n第二行。')
})

test('回合結束那列：這一輪派了背景子代理（引擎寫 Waiting for…）就不畫', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: '讀 README', type: 'Explore', status: 'running' as const }] }))
  await say($, clock, w, REPLY, PICKS, 7_000)
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 7_000 } })
  expect(await texts(ui)).toBe('')
})

test('pane 進行中：個人帳號列出背景 shell，不畫 Team 帳號的註明', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  await say($, clock, w, PLAIN, picks(PLAIN, { outcome: '照 A 改好。' }))
  const text = await texts(await pane($))
  expect(text).toContain('背景 shell npm run dev')
  expect(text).not.toContain('Team／Enterprise 帳號看不到')
})

test('pane 進行中：Team 帳號（收不到 classic.*）註明背景 shell、任務清單看不到', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  await say($, clock, w, PLAIN, picks(PLAIN, { outcome: '照 A 改好。' }), 10_000, true)
  expect(await texts(await pane($))).toContain('背景 shell、任務清單：Team／Enterprise 帳號看不到')
})

test('pane 任務：別的 hook 擋下的建立和完成不記（被擋的完成不算完成）', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on)
  on('classic.TaskCreated', (_$, e) => (e.task_id === 't2' ? { block: '不准建' } : {}))
  on('classic.TaskCompleted', () => ({ block: '測試還沒過' }))
  await $.classic.TaskCreated({ task_id: 't1', task_subject: '改 A' } as never)
  await $.classic.TaskCreated({ task_id: 't2', task_subject: '改 B' } as never)
  await $.classic.TaskCompleted({ task_id: 't1', task_subject: '改 A' } as never)
  await say($, clock, w, PLAIN, picks(PLAIN, { outcome: '照 A 改好。' }))
  const text = await texts(await pane($))
  expect(text).toContain('任務 0/1')
  expect(text).not.toContain('改 B')
})

test('/sitrep-pane：關著就開、開著就關', ZH, async ($, on) => {
  world(on)
  const p = paneWorld(on)
  await sitrepPane($)
  await sitrepPane($)
  expect(p.opens).toEqual(['sitrep'])
  expect(p.closes).toEqual(['sitrep'])
})

test('pane 不自動開：有兩題要選、fullscreen 也不開，只能 /sitrep-pane 手動開', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const p = paneWorld(on)
  on('settings.read', () => ({ value: { tui: 'fullscreen' } }))
  await say($, clock, w, REPLY, PICKS)
  expect(p.opens).toEqual([])
})

test('pane 內容：需要你（題目＋選項）、你要做的事、變更；按選項一樣填進提示框', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  paneWorld(on, { tmux: true })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/sitrep/a.ts', old_string: 'a', new_string: 'b' } as never)
  await say($, clock, w, REPLY, PICKS)
  const ui = await pane($)
  const text = await texts(ui)
  expect(text).toContain('需要你 · 3')
  expect(text).toContain('1. mod 放哪？')
  expect(text).toContain('明天實機看 5 處')
  expect(text).toContain('✓ 51 pass')
  // 證據細節：回覆「驗證」段的內容
  expect(text).toContain('claude plugin test .：51 pass')
  expect(text).toContain('變更 · 未 commit')
  expect(text).toContain('sitrep/a.ts')
  expect(text).toContain('+3')
  expect(text).toContain('your-turn（不是這次改的）')
  expect(text).toContain('2 檔')
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => [b.props.key, b.props.hotkey])
  expect(hotkeys.slice(0, 2)).toEqual([['pane-pick-0-A', 'a'], ['pane-pick-0-B', 'b']])
  await ui.press({ key: 'pane-pick-1-B' })
  expect(w.fills).toEqual(['2. B'])
})

async function above($: Engine, hasSurvey = false, isWorking = false) {
  return $.ui.mount({
    plugin: 'sitrep',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking, maxRows: 5, bodyColumns: 160, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
}

// 只有你要做的事、沒有題目的一則回覆
function chore(status: string, outcome: string, todo: string) {
  const reply = long(outcome, `- ${todo}`)
  return { reply, pick: picks(reply, { status, outcome, todo: [`- ${todo}`] }) }
}

test('prompt 上方：一行「? 2 題待決」＋第一題選項（題號代替題幹），疊在其他 mod 的列下面', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const text = await texts(await above($))
  expect(text).toContain('engine')
  expect(text).toContain('? 2 題待決')
  expect(text).toContain('1.')
  expect(text).not.toContain('mod 放哪？')
  expect(text).not.toContain('ctrl+x tab')
})

test('prompt 上方：按選項填進提示框；只有第一題沒答的有字母熱鍵', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await above($)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => [b.props.key, b.props.hotkey])).toEqual([['above-pick-0-A', 'a'], ['above-pick-0-B', 'b']])
  await ui.press({ key: 'above-pick-0-A' })
  expect(w.fills).toEqual(['1. A'])
  await ui.redraw()
  const text = await texts(ui)
  expect(text).toContain('? 1 題待決')
  expect(text).toContain('2.')
})

test('舊回合的結論框收成一行，按 ▸ 畫回完整框；最新那張照畫完整框', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const newer = long('下一輪。')
  await say($, clock, w, newer, picks(newer, { outcome: '下一輪。' }))
  const old = await message($, REPLY)
  expect((await old.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(false)
  expect(await texts(old)).toContain('照 A 改好，測試全過')
  await old.press({ key: 'box-open' })
  await old.redraw()
  expect((await old.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(true)
  const latest = await message($, newer)
  expect((await latest.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(true)
})

test('狀態照模型標的走：完成、卡住附了你要做也不變黃；完成的你要做不在 prompt 上方催', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const done = chore('done', '狀態完成。', '更新憑證')
  await say($, clock, w, done.reply, done.pick)
  const text = await texts(await message($, done.reply))
  expect(text).toContain('✓ 完成')
  expect(text).toContain('你要做  更新憑證')
  expect(await texts(await above($))).not.toContain('等你動手')
  const blocked = chore('blocked', '狀態卡住。', '更新憑證')
  await say($, clock, w, blocked.reply, blocked.pick)
  expect(await texts(await message($, blocked.reply))).toContain('! 卡住')
  expect(await texts(await above($))).toContain('等你動手：')
})

test('prompt 上方：沒題目但有你要做的事時畫「等你動手：…」', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const c = chore('partial', '後端好了。', '瀏覽器實機登入')
  await say($, clock, w, c.reply, c.pick)
  expect(await texts(await above($))).toContain('等你動手：')
  expect(await texts(await above($))).toContain('瀏覽器實機登入')
})

test('prompt 上方：你送出訊息後那列馬上消失，不等這一輪結束', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const c = chore('blocked', '等核准。', '看 spec 說核准')
  await say($, clock, w, c.reply, c.pick)
  expect(await texts(await above($))).toContain('等你動手：')
  // 背景通知送進來的不算你回應
  await $.prompt.submit({ text: '子代理回報', wait: false, origin: { kind: 'task-notification' } as never })
  expect(await texts(await above($))).toContain('等你動手：')
  await $.prompt.submit({ text: '核准', wait: false, origin: { kind: 'composer' } })
  expect(await texts(await above($))).not.toContain('等你動手')
})

test('prompt 上方：回合進行中一行「第 N 個工具 · 最近 …」，只算主對話；停下或新一輪歸零', ZH, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: {} }) as never)
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/repo/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'npm test\nnpm run lint' } as never)
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u3', pattern: 'x', agentId: 'a1' } as never)
  expect(await texts(await above($, false, true))).toContain('第 2 個工具 · 最近 Bash npm test')
  expect(await texts(await above($, false, true))).not.toContain('npm run lint')
  expect(await texts(await above($))).not.toContain('個工具')
  await $.turn.start({ turnId: 't2' } as never)
  expect(await texts(await above($, false, true))).not.toContain('個工具')
})

test('prompt 上方：有 survey 時讓位', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  expect(await texts(await above($, true))).not.toContain('等你決定')
})

test('prompt 上方：全部答完、或新的結論框沒有題目時，那列消失', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await say($, clock, w, REPLY, PICKS)
  const ui = await above($)
  await ui.press({ key: 'above-pick-0-A' })
  await ui.redraw()
  await ui.press({ key: 'above-pick-1-B' })
  await ui.redraw()
  expect(await texts(ui)).not.toContain('等你決定')
  // 換一張有題目的新卡（id 不同）再來一張沒題目的：使用者自己打字回答的情形
  const again = `${REPLY}\n另一輪`
  await say($, clock, w, again, PICKS)
  expect(await texts(await above($))).toContain('? 2 題待決')
  const plain = long('改好了。')
  await say($, clock, w, plain, picks(plain, { outcome: '改好了。' }))
  await say($, clock, w, '短回覆', '{}')
  expect(await texts(await above($))).not.toContain('等你決定')
})

// 假引擎啟動子代理 a1
function agentWorld(on: On) {
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
}

const SPAWN = { tool_use_id: 'tu1', prompt: '讀 README', description: '讀 README', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false }

test('子代理在跑時 prompt 上方不畫子代理那行（引擎在 status line 下方已列出）', ZH, async ($, on) => {
  mock.clock(on)
  world(on)
  agentWorld(on)
  await $.agent.spawn(SPAWN)
  expect(await texts(await above($))).not.toContain('子代理')
})

test('agent.spawn 先記下的子代理，這一輪結束時一樣掛到結論框', ZH, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  agentWorld(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: '讀 README', type: 'Explore', status: 'running' as const }] }))
  await $.agent.spawn(SPAWN)
  await say($, clock, w, REPLY, PICKS, 6_000)
  const ui = await message($, REPLY)
  expect(await texts(ui)).toMatch(/Explore   讀 README   執行中/)
})
