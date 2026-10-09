import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試裡的引擎：記下引擎拿到的回覆正文（mod 改寫後）與填進提示框的字
type World = { bodies: string[]; fills: string[] }

function world(on: On): World {
  const w: World = { bodies: [], fills: [] }
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
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

const SUMMARY = {
  status: 'done',
  outcome: '照 A 改好，測試全過',
  items: [
    { kind: 'decision', text: 'mod 放哪？', options: [{ key: 'A', label: '開新 mod' }, { key: 'B', label: '併進 your-turn' }], recommended: 'A' },
    { kind: 'decision', text: 'band 再精簡？', options: [{ key: 'A', label: '拿掉' }, { key: 'B', label: '保留' }] },
    { kind: 'user-next', text: '明天實機看 5 處' },
  ],
  facets: [{ label: '驗證', summary: '51 pass · tsc ✓', heading: '驗證' }],
}

const REPLY = ['## 結果', '照 A 改好。', '', '## 驗證', '- claude plugin test .：51 pass', '', '## 待你決定', '兩題。', '', '```ui-summary', JSON.stringify(SUMMARY), '```'].join('\n')

async function message($: Engine, text: string) {
  return $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
}

async function texts(ui: { findAll: Awaited<ReturnType<typeof message>>['findAll'] }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
}

test('系統提示尾端加上 ui-summary 的說明（session 那側）', async ($, on) => {
  world(on)
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(s => s.id)).toEqual(['intro', 'sitrep:summary'])
  expect(sections[1]?.scope).toBe('session')
  expect(sections[1]?.text).toContain('```ui-summary')
  // 使用者改問別的事時，沒答的題目要模型重列：送出訊息會清空待決列，mod 自己分不出是不是回答了
  expect(sections[1]?.text).toContain('that the user has not answered')
  // 提示是英文，但結論框的文字要跟回覆同語言
  expect(sections[1]?.text).toContain('in the language of your reply')
})

test('回覆：區塊藏起來、驗證段落收成一行、兩題畫進等你決定的框', async ($, on) => {
  const w = world(on)
  const ui = await message($, REPLY)
  const body = w.bodies.at(-1) ?? ''
  expect(body).not.toContain('ui-summary')
  expect(body).not.toContain('51 pass')
  // 有題目時「待你決定」段也收進框（列成利弊），題目不在正文再寫一次
  expect(body).not.toContain('## 待你決定')
  const text = await texts(ui)
  expect(text).toContain('驗證')
  expect(text).toContain('51 pass · tsc ✓')
  expect(text).toContain('利弊')
  expect(text).toContain('? 等你決定')
  expect(text).toContain('1. mod 放哪？')
  expect(text).toContain('開新 mod')
  expect(text).toContain('建議')
  expect(text).toContain('你要做  明天實機看 5 處')
  expect(text).not.toContain('點選項只填入提示框')
})

test('按選項：依題號把已選的答案填進提示框，不送出', async ($, on) => {
  const w = world(on)
  const ui = await message($, REPLY)
  await ui.press({ key: 'pick-1-B' })
  await ui.press({ key: 'pick-0-A' })
  expect(w.fills).toEqual(['2. B', '1. A  2. B'])
})

test('收合的段落按 ▸ 放回正文原位（不畫在框裡），再按收回；利弊段一樣', async ($, on) => {
  const w = world(on)
  const ui = await message($, REPLY)
  expect(w.bodies.at(-1)).not.toContain('claude plugin test')
  await ui.press({ key: 'toggle-0' })
  expect(w.bodies.at(-1)).toContain('## 驗證\n- claude plugin test .：51 pass')
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
  expect(await texts(ui)).toContain('已放回正文')
  await ui.press({ key: 'toggle-0' })
  expect(w.bodies.at(-1)).not.toContain('claude plugin test')
  await ui.press({ key: 'toggle-1' })
  expect(w.bodies.at(-1)).toContain('## 待你決定\n兩題。')
})

test('收合列的標籤補到同寬，摘要排成一直欄（中文字算 2 欄）', async ($, on) => {
  world(on)
  const facets = [{ label: '變更', summary: '改 README' }, { label: '殘留風險', summary: '巢狀清單' }]
  const ui = await message($, '好\n\n```ui-summary\n' + JSON.stringify({ status: 'done', outcome: '好', items: [], facets }) + '\n```')
  const labels = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => /變更|殘留風險/.test(t))
  expect(labels).toEqual([' 變更      ', ' 殘留風險  '])
})

test('正文行內提到 ```ui-summary 不當成區塊：照樣讀到尾端那個、行內文字保留', async ($, on) => {
  const w = world(on)
  const reply = '## 結果\nrecap 露出 ` ```ui-summary ` 原文，已修好。\n\n## 驗證\n- 32 pass\n\n```ui-summary\n' +
    JSON.stringify({ status: 'done', outcome: '修好了', items: [], facets: [] }) + '\n```'
  const text = await texts(await message($, reply))
  expect(text).toContain('✓ 完成')
  expect(text).not.toContain('讀不懂')
  expect(w.bodies.at(-1)).toContain('recap 露出 ` ```ui-summary ` 原文')
  expect(w.bodies.at(-1)).not.toContain('"status"')
})

test('沒有區塊的回覆照原樣交給引擎', async ($, on) => {
  const w = world(on)
  await message($, '## 結果\n普通回覆')
  expect(w.bodies.at(-1)).toBe('## 結果\n普通回覆')
})

test('串流中區塊還沒收尾：先藏起來，不畫結論框', async ($, on) => {
  const w = world(on)
  const ui = await message($, '## 結果\n照 A 改好。\n\n```ui-summary\n{"status":"do')
  expect(w.bodies.at(-1)).toBe('## 結果\n照 A 改好。')
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle !== undefined)).toHaveLength(0)
  // 開頭那行只傳到一半也藏；一般程式碼區塊收尾的 ``` 不動
  await message($, '照 A 改好。\n\n```ui-sum')
  expect(w.bodies.at(-1)).toBe('照 A 改好。')
  await message($, '```py\nprint(1)\n```')
  expect(w.bodies.at(-1)).toBe('```py\nprint(1)\n```')
})

test('區塊讀不懂：照樣藏起來，提示沒畫結論框', async ($, on) => {
  const w = world(on)
  const ui = await message($, '回覆\n\n```ui-summary\n{壞掉\n```')
  expect(w.bodies.at(-1)).toBe('回覆')
  expect(await texts(ui)).toContain('ui-summary 讀不懂')
})

test('結論條畫在回覆裡：狀態標籤＋結論；回合結束後補上耗時', async ($, on) => {
  world(on)
  const ui = await message($, REPLY)
  expect(await texts(ui)).toContain('等你決定')
  expect(await texts(ui)).toContain('照 A 改好，測試全過')
  expect(await texts(ui)).not.toContain('2m 41s')
  // 框寬固定：終端寬減 4、最寬 88；標題疊在上框線（框的後一個兄弟，absolute）
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(b => b.props.width !== undefined).map(b => b.props.width)).toEqual([88])
  expect(boxes.some(b => b.props.position === 'absolute' && b.props.top === 0)).toBe(true)
  await $.turn.complete({ answer: REPLY, durationMs: 161_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw()
  expect(await texts(ui)).toContain('2m 41s')
})

test('回合結束那列：有摘要的交給引擎原樣畫；沒附區塊的換成灰色提示；子代理的不算', async ($, on) => {
  world(on)
  await $.turn.complete({ answer: REPLY, durationMs: 161_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.complete({ answer: '子代理的回報', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await $.turn.complete({ answer: '沒附區塊', durationMs: 12_000, isAborted: false, turnId: 't3', reason: 'answer' })
  const row = async (durationMs: number) => {
    const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs } })
    return texts(ui)
  }
  expect(await row(161_000)).toContain('engine Baked')
  expect(await row(12_000)).toContain('– 本輪結束（無摘要）')
  // 耗時差幾百毫秒也對得回去
  expect(await row(12_600)).toContain('本輪結束')
  expect(await row(5_000)).toContain('engine Baked')
})

test('沒有題目但有你要做的事：框標成等你動手，你要做排在結論下面，之後我排最後', async ($, on) => {
  world(on)
  const only = { status: 'partial', outcome: '子代理在跑', items: [{ kind: 'agent-next', text: '等子代理回報' }, { kind: 'user-next', text: '重開終端' }], facets: [] }
  const ui = await message($, '已派子代理。\n\n```ui-summary\n' + JSON.stringify(only) + '\n```')
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(b => b.props.borderStyle !== undefined)).toHaveLength(1)
  const text = await texts(ui)
  expect(text).toContain('> 等你動手')
  expect(text).not.toContain('進行中')
  expect(text.indexOf('你要做  重開終端')).toBeGreaterThan(text.indexOf('子代理在跑'))
  expect(text.indexOf('之後我  等子代理回報')).toBeGreaterThan(text.indexOf('你要做  重開終端'))
  // 只有之後我、沒有你要做的才是進行中
  const later = { ...only, items: [{ kind: 'agent-next', text: '等子代理回報' }] }
  expect(await texts(await message($, '已派。\n\n```ui-summary\n' + JSON.stringify(later) + '\n```'))).toContain('~ 進行中')
  expect(text).not.toContain('待你決定')
})

test('子代理回報那列：收合時換成第一句，展開時照原樣', async ($, on) => {
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

test('背景工作通知列：完成灰 ✓、失敗紅 !，展開時照原樣', async ($, on) => {
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
  expect((await failed.findAll({ type: 'Text' })).find(t => t.text === '! ')?.props.color).toBe('#e0745a')
  expect(await texts(await row('completed', true))).toContain('engine Agent')
})

test('ASCII 圖：切出來畫在灰底區塊、上方標「圖」，前後段照舊交給引擎；一般程式碼區塊不動', async ($, on) => {
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

test('純 ASCII 圖（+--+ 方框、|-- 樹，沒有箭頭）也畫成灰底圖', async ($, on) => {
  world(on)
  const box = await message($, '```\n+-----+    +-----+\n| A   |    | B   |\n+-----+    +-----+\n```')
  expect(await texts(box)).toContain('圖')
  const tree = await message($, '```\nroot\n|-- a\n`-- b\n```')
  expect(await texts(tree)).toContain('圖')
})

const DOT = 'digraph { a -> b; b -> c [label="x"]; a -> c }'

test('dot 區塊：跟 ASCII 圖一樣畫灰底原文，標籤附粗算的節點與邊數；不跑任何指令', async ($, on) => {
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

test('結論框：這一輪派出的背景子代理列在框裡，跑的時候轉圈＋已跑時間，跑完換成 ✓ 和耗時', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  const agent = { id: 'a1', description: '摘要 ctx-relay README', type: 'Explore', status: 'running' as const }
  on('agent.list', () => ({ value: [agent] }))
  await $.turn.complete({ answer: REPLY, durationMs: 6_000, isAborted: false, turnId: 't1', reason: 'answer' })
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
function paneWorld(on: On, opts: { tmux?: boolean } = {}) {
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
    return { value: { isPlaced: true as const } }
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

test('pane 任務段：照結論框的 tasks 畫 ✓／▸／○ 與 完成數/總數', async ($, on) => {
  world(on)
  paneWorld(on)
  const withTasks = { ...SUMMARY, tasks: [{ text: '研究痛點', done: true }, { text: '版面定案', done: false }, { text: '實測 6 項', done: false }] }
  await $.turn.complete({ answer: '好\n\n```ui-summary\n' + JSON.stringify(withTasks) + '\n```', durationMs: 5_000, isAborted: false, turnId: 't', reason: 'answer' })
  const text = await texts(await pane($))
  expect(text).toContain('任務 1/3')
  expect(text).toContain('✓ ')
  expect(text).toContain('▸ ')
  expect(text).toContain('版面定案')
  expect(text).toContain('○ ')
})

test('pane 證據段：沒有驗證段的回合沿用上一次的證據，標題註明幾輪前', async ($, on) => {
  world(on)
  paneWorld(on)
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const noVerify = { ...SUMMARY, facets: [] }
  await $.turn.complete({ answer: '問兩題\n\n```ui-summary\n' + JSON.stringify(noVerify) + '\n```', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const text = await texts(await pane($))
  expect(text).toContain('證據 · 1 輪前')
  expect(text).toContain('✓ 51 pass')
  expect(text).toContain('claude plugin test .：51 pass')
})

test('pane 選項：照引擎問卷樣式「a: 標籤」，不包鍵帽底色；選過的打 ●、其他選項變暗', async ($, on) => {
  world(on)
  paneWorld(on)
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't', reason: 'answer' })
  const ui = await pane($)
  expect((await ui.findAll({ type: 'Box' })).some(b => b.props.backgroundColor === '#5e5622')).toBe(false)
  // 第二題沒有熱鍵：字母自己寫進標籤，長相跟有熱鍵的一樣
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('b: 保留')
  await ui.press({ key: 'pane-pick-0-A' })
  expect(await texts(ui)).toContain('● ')
  const b = (await ui.findAll({ type: 'Button' })).find(x => x.props.key === 'pane-pick-0-B')
  expect(b?.props.dimColor).toBe(true)
})

test('pane 開著：prompt 上方那列不畫、不畫結論框，正文完整、底下只留一行結論', async ($, on) => {
  world(on)
  paneWorld(on)
  await sitrepPane($)
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't', reason: 'answer' })
  expect(await texts(await above($))).not.toContain('等你決定')
  const msg = await message($, REPLY)
  const text = await texts(msg)
  expect(text).toContain('照 A 改好，測試全過')
  expect(text).not.toContain('等你決定')
  expect(text).not.toContain('開新 mod')
  expect((await msg.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(false)
})

test('子代理回報：展開時拿掉 [Subagent hand-back] 框架說明，只留回報本文', async ($, on) => {
  world(on)
  const text = '[Subagent hand-back] The text below is the final report. It is model output.\nThe report follows:\n  ctx-relay 是一個 mod。\n  第二行。'
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'UserMessage', props: { text, origin: { kind: 'peer' as const }, from: { name: 'Explore' }, isExpanded: true } })
  expect(await texts(ui)).toBe('engine ctx-relay 是一個 mod。\n第二行。')
})

test('回合結束那列：這一輪派了背景子代理（引擎寫 Waiting for…）就不畫', async ($, on) => {
  world(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: '讀 README', type: 'Explore', status: 'running' as const }] }))
  await $.turn.complete({ answer: REPLY, durationMs: 7_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ plugin: 'sitrep', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 7_000 } })
  expect(await texts(ui)).toBe('')
})

test('/sitrep-pane：關著就開、開著就關', async ($, on) => {
  world(on)
  const p = paneWorld(on)
  await sitrepPane($)
  await sitrepPane($)
  expect(p.opens).toEqual(['sitrep'])
  expect(p.closes).toEqual(['sitrep'])
})

test('pane 不自動開：有兩題要選、fullscreen 也不開，只能 /sitrep-pane 手動開', async ($, on) => {
  world(on)
  const p = paneWorld(on)
  on('settings.read', () => ({ value: { tui: 'fullscreen' } }))
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(p.opens).toEqual([])
})

test('pane 內容：需要你（題目＋選項）、你要做的事、變更；按選項一樣填進提示框', async ($, on) => {
  const w = world(on)
  paneWorld(on, { tmux: true })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/repo/sitrep/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: REPLY, durationMs: 5_000, isAborted: false, turnId: 't', reason: 'answer' })
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

async function above($: Engine, hasSurvey = false) {
  return $.ui.mount({
    plugin: 'sitrep',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 5, bodyColumns: 160, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
}

async function finish($: Engine, answer: string) {
  await $.turn.complete({ answer, durationMs: 10_000, isAborted: false, turnId: 't', reason: 'answer' })
}

test('prompt 上方：一行「? 2 題待決」＋第一題選項（題號代替題幹），疊在其他 mod 的列下面', async ($, on) => {
  world(on)
  await finish($, REPLY)
  const text = await texts(await above($))
  expect(text).toContain('engine')
  expect(text).toContain('? 2 題待決')
  expect(text).toContain('1.')
  expect(text).not.toContain('mod 放哪？')
  expect(text).not.toContain('ctrl+x tab')
})

test('prompt 上方：按選項填進提示框；只有第一題沒答的有字母熱鍵', async ($, on) => {
  const w = world(on)
  await finish($, REPLY)
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

test('舊回合的結論框收成一行，按 ▸ 畫回完整框；最新那張照畫完整框', async ($, on) => {
  world(on)
  await finish($, REPLY)
  const newer = '好\n\n```ui-summary\n' + JSON.stringify({ status: 'done', outcome: '下一輪', items: [], facets: [] }) + '\n```'
  await finish($, newer)
  const old = await message($, REPLY)
  expect((await old.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(false)
  expect(await texts(old)).toContain('照 A 改好，測試全過')
  await old.press({ key: 'box-open' })
  await old.redraw()
  expect((await old.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(true)
  const latest = await message($, newer)
  expect((await latest.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')).toBe(true)
})

test('狀態照模型標的走：完成、卡住附了你要做也不變黃；完成的你要做不在 prompt 上方催', async ($, on) => {
  world(on)
  const card = (status: string) => '```ui-summary\n' + JSON.stringify({ status, outcome: `狀態 ${status}`, items: [{ kind: 'user-next', text: '更新憑證' }], facets: [] }) + '\n```'
  const done = await texts(await message($, card('done')))
  expect(done).toContain('✓ 完成')
  expect(done).toContain('你要做  更新憑證')
  expect(await texts(await message($, card('blocked')))).toContain('! 卡住')
  await finish($, card('done'))
  expect(await texts(await above($))).not.toContain('等你動手')
  await finish($, card('blocked'))
  expect(await texts(await above($))).toContain('等你動手：')
})

test('prompt 上方：沒題目但有你要做的事時畫「等你動手：…」', async ($, on) => {
  world(on)
  await finish($, '```ui-summary\n' + JSON.stringify({ status: 'partial', outcome: '後端好了', items: [{ kind: 'user-next', text: '瀏覽器實機登入' }], facets: [] }) + '\n```')
  expect(await texts(await above($))).toContain('等你動手：')
  expect(await texts(await above($))).toContain('瀏覽器實機登入')
})

test('prompt 上方：你送出訊息後那列馬上消失，不等這一輪結束', async ($, on) => {
  world(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await finish($, '```ui-summary\n' + JSON.stringify({ status: 'blocked', outcome: '等核准', items: [{ kind: 'user-next', text: '看 spec 說核准' }], facets: [] }) + '\n```')
  expect(await texts(await above($))).toContain('等你動手：')
  // 背景通知送進來的不算你回應
  await $.prompt.submit({ text: '子代理回報', wait: false, origin: { kind: 'task-notification' } as never })
  expect(await texts(await above($))).toContain('等你動手：')
  await $.prompt.submit({ text: '核准', wait: false, origin: { kind: 'composer' } })
  expect(await texts(await above($))).not.toContain('等你動手')
})

test('prompt 上方：有 survey 時讓位', async ($, on) => {
  world(on)
  await finish($, REPLY)
  expect(await texts(await above($, true))).not.toContain('等你決定')
})

test('prompt 上方：全部答完、或新的結論框沒有題目時，那列消失', async ($, on) => {
  world(on)
  await finish($, REPLY)
  const ui = await above($)
  await ui.press({ key: 'above-pick-0-A' })
  await ui.redraw()
  await ui.press({ key: 'above-pick-1-B' })
  await ui.redraw()
  expect(await texts(ui)).not.toContain('等你決定')
  // 換一張有題目的新卡（id 不同）再來一張沒題目的：使用者自己打字回答的情形
  await finish($, '```ui-summary\n' + JSON.stringify({ ...SUMMARY, outcome: '另一輪' }) + '\n```')
  expect(await texts(await above($))).toContain('? 2 題待決')
  await finish($, '改好了\n\n```ui-summary\n' + JSON.stringify({ status: 'done', outcome: '好', items: [], facets: [] }) + '\n```')
  await finish($, '沒附區塊的回合')
  expect(await texts(await above($))).not.toContain('等你決定')
})
