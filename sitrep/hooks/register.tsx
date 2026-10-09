import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { AgentNote, ChangeNote, Evidence, Facet, Item, Summary, SummaryTask, TaskNote, TurnNote } from '../types'

// sitrep：
// 1. 在系統提示尾端加一段（prompt.compose），請模型在交還給使用者的最後一則回覆末尾附 ```ui-summary 區塊（一行 JSON）。
// 2. 畫回覆時（AssistantMessage）把區塊藏起來，正文下面畫一個圓角結論框：標題（狀態＋耗時）疊在上框線，
//    框裡是粗體結論、facets 指到的段落（從正文拿掉，一行摘要；展開時放回正文原位）、待你決定的題目（按選項把「題號. key」填進提示框，不送出）。
//    存下來的訊息不變；但 AssistantMessage 沒有 isExpanded，分不出 ctrl+o 畫面，那裡一樣畫成結論框。
// 3. 沒附區塊的回合，回合結束那列（TurnDuration，「Baked for 3s」）換成「– 本輪結束（無摘要）」，不假裝沒事；
//    那列沒有輪次編號，用耗時對回 turn.complete。
// 4. 子代理回報那列（UserMessage，收合時「Message from @…」）換成它回報的第一句，ctrl+o 照原樣展開。
// 5. 還有沒答的題目時，prompt 上方（AbovePrompt）一行「? N 項等你決定」，聚焦後按選項字母選答（一樣只填提示框）。
// 6. 背景工作結束的通知列開頭換成狀態符號（✓ 完成、! 失敗、– 中止）；那一輪派出的背景子代理也列在結論框裡，跑完自動更新。
// 7. 回覆裡的 ASCII 圖（含框線字元或箭頭的程式碼區塊）畫在灰底區塊、上方一行灰字「圖」，不被大量文字蓋過。
// 8. 回覆裡的 ```dot 區塊照 7 畫原文，標籤附粗算的節點與邊數。

const TAG = 'sitrep'
// 圍欄要在行首：正文裡行內提到 ` ```ui-summary ` 不算（實機：行內那個被當成開頭，把真的區塊吃掉，結論框讀不懂）
const FENCE_RE = /^```ui-summary[^\n]*\n([\s\S]*?)\n?^```[^\n]*\n?/gm
const KEEP_TURNS = 50
const KEEP_AGENTS = 50
const PANE = 'sitrep'
// 子代理在跑時的重畫計時器（模組層，同一時間只開一個）：每 250ms 一幀，轉圈字形與已跑時間跟著走
let tick: Timer | null = null
let frame = 0
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const spin = () => SPIN[frame % SPIN.length]
// 顏色只給「需要你」：黃＝等你決定；紅＝卡住；其餘灰階（第三輪設計稿的安靜版）
const YELLOW = '#F0E442'
const RED = '#e0745a'
const GREEN = '#3fc39a'
const DIM = '#7d8794'
const SOFT = '#9aa4b1'
// ASCII 圖的灰底（比終端底色亮一階，跟 DIM 同系）
const FIG_BG = '#2b3038'
const BRIGHT = '#f5f7fa'
// pane（設計稿駕駛艙版）：進行中的藍、需要你那塊的黃底、證據小標籤的框線
const BLUE = '#56B4E9'
const NEED_BG = '#29271a'
const LINE = '#3a414c'
// pane 選項的鍵帽底色：沒選的暗黃、選過的亮一階（比題目區塊的黃底明顯）
// 每輪結論框（學 your-turn 的圓角框，標題嵌在上框線）：框線用暗一階的狀態色，標題用亮的；只有「等你決定」是黃
const FRAMES: Record<string, { border: string; title: string; word: string }> = {
  '?': { border: '#8a8128', title: YELLOW, word: '等你決定' },
  '>': { border: '#8a8128', title: YELLOW, word: '等你動手' },
  '!': { border: '#8a4a3c', title: RED, word: '卡住' },
  '~': { border: '#3d5a72', title: '#56B4E9', word: '進行中' },
  '✓': { border: '#3d5a4c', title: GREEN, word: '完成' },
}
const DONE_FRAME = { border: '#3d5a4c', title: GREEN, word: '完成' }
const BOX_MAX = 88
// TurnDuration 的耗時和 turn.complete 的不一定分毫不差（實測 13s 對得上、42s 對不上）：取差距最小、在這範圍內的那筆
const MATCH_MS = 3000

const SECTION = [
  'sitrep：當你結束這一輪、把話交還給使用者時，在那則回覆的最末尾附一個 ```ui-summary 程式碼區塊，內容是一行 JSON：',
  '{"status":"done|blocked|partial","outcome":"一句話結果，40 字內","items":[...],"facets":[...],"tasks":[...]}',
  '- items 每項 {"kind":"decision|user-next|agent-next","text":"…","options":[{"key":"A","label":"12 字內"}],"recommended":"A"}。只有真的要使用者選擇才是 decision，並附 options；要使用者親手做的事是 user-next；你接著會做的是 agent-next。沒有就給空陣列。',
  '- 前幾輪問過、使用者還沒回答的 decision（使用者後來改問別的事，沒選選項也沒在文字裡回答），只要還適用，就在這一輪的 items 照原題目與選項再列一次；不要自己套預設答案就略過。已經不適用的，在正文用一句話說明再拿掉。',
  '- facets 每項 {"label":"變更","summary":"30 字內","heading":"回覆裡那一段標題的原文"}，只列回覆裡確實有、適合預設收合的段落（例如變更、驗證、殘留風險）。',
  '- tasks 只在多步驟的工作才給（否則省略）：整件事的步驟依序列出，每項 {"text":"20 字內","done":true|false}，最多 7 項，已做完的標 done。',
  '- 這個區塊只給介面讀，使用者看不到。正文照常寫完整，不要在正文提到它。工具呼叫之間的訊息不附。',
  '- 被要求寫 recap、session 摘要或其他不是回覆使用者的文字時，也不附。',
].join('\n')

const answersAtom = atom({ plugin: 'sitrep', key: 'answers' } as const, {} as Record<string, Record<number, string>>)
const openAtom = atom({ plugin: 'sitrep', key: 'open' } as const, {} as Record<string, boolean>)
const turnsAtom = atom({ plugin: 'sitrep', key: 'turns' } as const, [] as TurnNote[])
const agentsAtom = atom({ plugin: 'sitrep', key: 'agents' } as const, [] as AgentNote[])
const lastAtom = atom({ plugin: 'sitrep', key: 'last' } as const, null as { id: string; summary: Summary } | null)
const evidenceAtom = atom({ plugin: 'sitrep', key: 'evidence' } as const, null as Evidence | null)
const backgroundAtom = atom({ plugin: 'sitrep', key: 'background' } as const, [] as string[])
const tasksAtom = atom({ plugin: 'sitrep', key: 'tasks' } as const, [] as TaskNote[])
const changesAtom = atom({ plugin: 'sitrep', key: 'changes' } as const, [] as ChangeNote[])
const touchedAtom = atom({ plugin: 'sitrep', key: 'touched' } as const, [] as string[])
const paneOpenAtom = atom({ plugin: 'sitrep', key: 'paneOpen' } as const, false)
const pendingAtom = atom({ plugin: 'sitrep', key: 'pending' } as const, null as { id: string; decisions: Item[]; todo: string[] } | null)

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return { sections: [...result.sections, { id: `${TAG}:summary`, text: SECTION, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 名稱衝突會丟例外，包住免得中斷 hook
    try {
      await $.command.register({ name: 'sitrep-pane', description: 'sitrep：開關狀態 pane（需要你、進行中、任務、證據、變更）' })
    } catch (err) {
      $.ui.log(`${TAG} 註冊 /sitrep-pane 失敗：${String(err)}`)
    }
    return result
  })

  // pane 只能手動開關（2026-10-08 使用者：pane 視覺另案設計，平常只用安靜版，不再自動開）
  on('command.run', { command: 'sitrep-pane' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: `${TAG}：已關閉狀態 pane（/sitrep-pane 可再打開）` }
    }
    await openPane($)
    return { text: `${TAG}：已打開狀態 pane（實驗中；再打一次 /sitrep-pane 關閉）` }
  })

  // pane 關了：結論框與 prompt 上方那列回來
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    await update($, paneOpenAtom, () => false)
    return next(e)
  })

  // 記下這個 session 用工具改過的檔：pane 的「變更」段只逐檔列這些，其餘當成「不是這次改的」
  on('tool.call', async ($, e, next) => {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) {
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      const path = input.file_path ?? input.notebook_path
      if (typeof path === 'string') await update($, touchedAtom, list => (list.includes(path) ? list : [...list, path].slice(-200)))
    }
    return next(e)
  })

  // 主對話停下時引擎回報的背景工作（背景 shell、monitor、workflow；子代理另外從 $.agent.list() 拿）
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined) return result
    const work = (e.background_tasks ?? []).filter(t => t.type !== 'subagent').map(t => `${t.type} ${t.command ?? t.description}`)
    await update($, backgroundAtom, () => work)
    return result
  })

  on('classic.TaskCreated', async ($, e, next) => {
    const result = await next(e)
    await update($, tasksAtom, list => [...list.filter(t => t.id !== e.task_id), { id: e.task_id, subject: e.task_subject, done: false }].slice(-30))
    return result
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    const result = await next(e)
    await update($, tasksAtom, list => list.map(t => (t.id === e.task_id ? { ...t, done: true } : t)))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      // 背景子代理跑完：結論框裡它那一行改成完成（或中止）＋耗時
      const id = e.agentId
      await update($, agentsAtom, list => list.map(a => (a.id === id ? { ...a, status: e.isAborted ? 'killed' : 'completed', durationMs: e.durationMs } : a)))
      return result
    }
    const found = findSummary(e.answer)
    await trackAgents($, found?.id)
    // 有子代理在跑時每 250ms 重畫一次：轉圈字形和已跑時間證明它還活著（使用者 2026-10-08 選轉圈）；都跑完就停
    if (!tick && (await read($, agentsAtom)).some(a => !(a.status in TASK_MARKS))) {
      tick = $.clock.every(250, () => {
        void read($, agentsAtom).then(list => {
          if (list.some(a => !(a.status in TASK_MARKS))) {
            frame++
            return $.ui.invalidate('ui.render')
          }
          tick?.cancel()
          tick = null
        })
      })
    }
    const note: TurnNote = found?.summary
      ? { id: found.id, durationMs: e.durationMs, glyph: glyphOf(found.summary), outcome: found.summary.outcome }
      : { durationMs: e.durationMs, glyph: '–', outcome: '本輪結束（無摘要）' }
    await update($, turnsAtom, list => [...list, note].slice(-KEEP_TURNS))
    // 新的結論框沒有題目＝之前的題目已經處理過（例如使用者自己打字回答），那列跟著消失
    const summary = found?.summary
    if (found && summary) {
      // 完工回覆附的「你要做」多半是建議（例如手動再測一次），不在 prompt 上方催；卡住、做到一半才提示
      const todo = summary.status === 'done' ? [] : summary.items.filter(i => i.kind === 'user-next').map(i => i.text)
      await update($, pendingAtom, () => ({ id: found.id, decisions: decisionsOf(summary.items), todo }))
      await update($, lastAtom, () => ({ id: found.id, summary }))
      // 證據：沿用最近一輪有「驗證」段的結果，直到下一次驗證蓋過去（問題輪通常沒有驗證段，pane 卻正好開著）
      const verify = summary.facets.map((f, i) => ({ f, i })).filter(({ f }) => f.label.includes('驗證'))
      if (verify.length > 0) {
        // 細節：回覆裡「驗證」那段的前幾行（跑過的指令與結果），pane 的證據段畫在小標籤下面
        const { sections } = cutSections(found.rest, summary.facets, () => false)
        const chips = verify.flatMap(({ f }) => f.summary.split(/\s*[·、,，]\s*/)).filter(c => c !== '')
        const proof = verify.flatMap(({ i }) => (sections[i] ?? '').split('\n'))
          .map(l => l.replace(/^\s*[-*]\s+|`/g, '').trim()).filter(l => l !== '' && !l.startsWith('```'))
        await update($, evidenceAtom, () => ({ chips, proof, age: 0 }))
      } else {
        await update($, evidenceAtom, ev => (ev ? { ...ev, age: ev.age + 1 } : null))
      }
    }
    // pane 的「變更」段：這一輪結束時還沒 commit 的改動（git diff --numstat，路徑換成絕對路徑好跟 touched 比）；不在 git repo 就清空
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
    const stat = top?.exitCode === 0 ? await $.process.run(['git', 'diff', 'HEAD', '--numstat'], { timeoutMs: 5000 }).catch(() => null) : null
    const root = top?.stdout.trim() ?? ''
    await update($, changesAtom, () => (stat?.exitCode === 0 ? parseNumstat(stat.stdout, root) : []))
    return result
  })

  // 你自己送出訊息＝已回應上一輪的題目或待辦：那列馬上消失，不等這一輪結束（使用者實機：核准後「等你動手」一直掛著）
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    // 你打字（composer）、手機遙控（bridge），或其他 mod 代你送出（asUser，例如 ctx-relay 的接續鈕）才算；背景通知、別的 session 傳來的不算
    const o = e.origin
    if (o.kind === 'composer' || o.kind === 'bridge' || (o.kind === 'plugin' && o.asUser)) await update($, pendingAtom, () => null)
    return result
  })

  // prompt 上方一行：有沒答的題目時「? N 題待決」＋第一題的選項（題號代替題幹，題目本身在結論框裡），聚焦這列後按字母選答；
  // 沒題目但有要你親手做的事時「等你動手：…」。熱鍵只在 band／pane 有焦點時有效，所以選項留在這裡（結論框的按鈕按不到鍵盤）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const pending = await read($, pendingAtom)
    const answers = pending ? (await read($, answersAtom))[pending.id] ?? {} : {}
    const open = pending ? pending.decisions.map((d, n) => ({ d, n })).filter(({ n }) => answers[n] === undefined) : []
    const first = open[0]
    const todo = pending?.todo[0]
    // pane 開著時題目在 pane 裡選：這列不畫，alt+n（ctrl+x tab）才會直接跳到 pane
    if (!pending || (!first && todo === undefined) || (await read($, paneOpenAtom))) return next(e)
    // band 只有一個：先讓排在下面的 mod 畫（例如 ctx-relay 的交接列），自己這列疊在它下面
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    let line: RenderElement
    if (first) {
      const { d, n } = first
      const total = pending.decisions.length
      // hotkey 只收一個小寫字母；數字不給：空的提示框裡按數字會直接按到 band 的按鈕，也會撞 ctx-relay 的 "1"
      line = (
        <Box key="above-row" flexDirection="row">
          <Text color={YELLOW} bold>{`? ${open.length} 題待決`}</Text>
          <Text color={BRIGHT}>{total > 1 ? `   ${n + 1}.` : '  '}</Text>
          {(d.options ?? []).map(o => {
            const hotkey = /^[a-z]$/i.test(o.key) ? o.key.toLowerCase() : undefined
            return (
              <Box key={`above-opt-${o.key}`} flexDirection="row" marginLeft={2}>
                <Button key={`above-pick-${n}-${o.key}`} plain label={hotkey ? o.label : `${o.key} ${o.label}`} {...(hotkey ? { hotkey } : {})} onPress={() => pick($, pending.id, n, o.key, total)} />
                {d.recommended === o.key ? <Text color={YELLOW}>{' 建議'}</Text> : null}
              </Box>
            )
          })}
          <Text color={DIM} wrap="truncate-end">{'   · 聚焦後按字母，只填入輸入框'}</Text>
        </Box>
      )
    } else {
      line = (
        <Text key="above-todo" wrap="truncate-end">
          <Text color={YELLOW} bold>{'等你動手：'}</Text>
          <Text>{todo}</Text>
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {below}
        {line}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawPane($, e, e.props.bodyColumns)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // 正文交給引擎畫；ASCII 圖切出來畫在灰底區塊，前後段各自交回引擎（只有第一段帶回覆開頭的圓點）
    const draw = async (text: string) => {
      const parts = splitFigures(text)
      const [only] = parts
      if (parts.length === 1 && only?.kind === 'text') return next({ ...e, props: { ...e.props, text } })
      const { Box, Text } = $.ui.resolve(e)
      const out: RenderElement[] = []
      for (const [i, p] of parts.entries()) {
        if (p.kind === 'text') {
          // 圓點和它後面的縮排是引擎畫在第一段裡的；後面幾段沒有，自己補兩欄對齊（實機 2026-10-08）
          const indent = e.props.isFirstOfReply && i > 0 ? 2 : 0
          out.push(<Box key={`seg-${i}`} marginLeft={indent}>{await next({ ...e, props: { ...e.props, text: p.text, isFirstOfReply: e.props.isFirstOfReply && i === 0 } })}</Box>)
          continue
        }
        // dot 區塊跟 ASCII 圖一樣畫原文，標籤附粗算的節點與邊數（不畫成圖片：Claude Code 在 tmux 裡關掉圖片，使用者 2026-10-08 選不做）
        let label = '圖'
        if (p.kind === 'dot') {
          const c = countDot(p.text)
          label = `圖：${c.nodes} 個節點、${c.edges} 條邊（dot 原文）`
        }
        out.push(
          <Box key={`fig-${i}`} flexDirection="column" marginLeft={2} marginY={1} alignSelf="flex-start">
            <Text color={DIM}>{label}</Text>
            <Box flexDirection="column" backgroundColor={FIG_BG} paddingX={1}>
              {p.text.split('\n').map((l, j) => <Text key={`l-${j}`} color={BRIGHT} wrap="truncate-end">{l === '' ? ' ' : l}</Text>)}
            </Box>
          </Box>,
        )
      }
      return <Box flexDirection="column">{out}</Box>
    }
    const found = findSummary(e.props.text)
    if (found === null) {
      // 串流中區塊還沒收尾：先藏起來，不然 JSON 會先畫成程式碼、收尾時才被結論框換掉（實機看到會閃）
      return draw(cutOpenFence(e.props.text) ?? e.props.text)
    }
    // pane 開著＝駕駛艙模式：不畫安靜版的結論框，正文完整照畫，底下只留一行「✓ 結論  耗時」；需要你、證據、變更都在 pane
    if (found.summary !== null && (await read($, paneOpenAtom))) {
      const { Box, Text } = $.ui.resolve(e)
      const glyph = glyphOf(found.summary)
      const frame = FRAMES[glyph] ?? DONE_FRAME
      const turn = (await read($, turnsAtom)).findLast(t => t.id === found.id)
      return (
        <Box flexDirection="column">
          {await draw(found.rest)}
          <Box key="lens-line" flexDirection="row" marginTop={1}>
            <Text color={frame.title} bold>{`${glyph} `}</Text>
            <Text color={BRIGHT}>{found.summary.outcome}</Text>
            {turn ? <Text color={DIM}>{`  ${duration(turn.durationMs)}`}</Text> : null}
          </Box>
        </Box>
      )
    }
    const facets = withDecisionFacet(found.summary, found.rest)
    const open = await read($, openAtom)
    const { shown, sections } = cutSections(found.rest, facets, i => open[`${found.id}:${i}`] === true)
    const body = await draw(shown)
    const { Box, Text } = $.ui.resolve(e)
    if (found.summary === null) {
      return (
        <Box flexDirection="column">
          {body}
          <Text color={DIM}>{'  ? ui-summary 讀不懂，沒畫結論框'}</Text>
        </Box>
      )
    }
    // 結論框畫在帶區塊的那一段下面，不靠 TurnDuration：短回合、子代理回報觸發的回合，引擎不一定畫那列（實測 3s 那輪沒有）
    const glyph = glyphOf(found.summary)
    const frame = FRAMES[glyph] ?? DONE_FRAME
    const turns = await read($, turnsAtom)
    const turn = turns.findLast(t => t.id === found.id)
    // 舊回合（之後還有別張結論框）收成一行，點 ▸ 才畫完整框：同一畫面不堆好幾個框（實機 s5 三個框）。
    // 還沒進 turns 的（串流中、剛收尾）一律當最新，免得先畫一行再展開
    const at = turns.findIndex(t => t.id === found.id)
    const isOld = at >= 0 && turns.slice(at + 1).some(t => t.id !== undefined && t.id !== found.id)
    const boxKey = `${found.id}:box`
    const toggleBox = () => update($, openAtom, o => ({ ...o, [boxKey]: !o[boxKey] }))
    const { Button } = $.ui.resolve(e)
    if (isOld && open[boxKey] !== true) {
      return (
        <Box flexDirection="column">
          {body}
          <Box key="lens-line" flexDirection="row" marginTop={1}>
            <Button key="box-open" plain label="▸" onPress={toggleBox} />
            <Text color={frame.title} bold>{` ${glyph} `}</Text>
            <Text color={SOFT}>{found.summary.outcome}</Text>
            {turn ? <Text color={DIM}>{`  ${duration(turn.durationMs)}`}</Text> : null}
          </Box>
        </Box>
      )
    }
    const items = await itemRows($, e, found.id, found.summary.items)
    const rows = [
      <Text key="outcome" color={BRIGHT} bold>{found.summary.outcome}</Text>,
      ...items.todo,
      ...facetRows($, e, found.id, facets, sections, open),
      ...(await agentRows($, e, found.id)),
      ...items.questions,
      ...items.later,
    ]
    // 標題疊在上框線（2026-10-09 使用者要再試）：框自己的子元素會被框線蓋掉（your-turn 2026-10-05 實測），
    // 所以標題是框的「後一個兄弟」、absolute 疊上去。舊紀錄：框頂捲出畫面時標題曾疊到內容上（實機 opus/s2:1），這次重看
    // 框寬固定（不跟內容跳，實機 36～81 欄）：終端寬減 4，最寬 88
    const width = Math.min((e.viewport?.columns ?? 92) - 4, BOX_MAX)
    return (
      <Box flexDirection="column">
        {body}
        <Box key="lens-wrap" flexDirection="column" marginTop={1} width={width}>
          <Box key="lens" borderStyle="round" borderColor={frame.border} paddingX={1} flexDirection="column">
            {rows}
          </Box>
          <Box key="title" position="absolute" top={0} left={2} flexDirection="row">
            {isOld ? <Button key="box-close" plain label="▾" onPress={toggleBox} /> : null}
            <Text color={frame.title} bold>{` ${glyph} ${frame.word} `}</Text>
          </Box>
          {turn ? <Box key="time" position="absolute" top={0} right={2}><Text color={DIM}>{` ${duration(turn.durationMs)} `}</Text></Box> : null}
        </Box>
      </Box>
    )
  })

  // 結論已畫在回覆裡；這列只在「沒附區塊」的回合換成灰色提示，不假裝沒事
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const note = matchTurn(await read($, turnsAtom), e.props.durationMs)
    // 這一輪派了背景子代理：引擎這列會寫「Waiting for N background agents…」，結論框裡已經有子代理那一行，不畫
    if (note?.id && (await read($, agentsAtom)).some(a => a.card === note.id)) return $.ui.resolve(e).Box({})
    if (!note || note.glyph !== '–') return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color={DIM}>{`– ${note.outcome}  ${duration(e.props.durationMs)}`}</Text>
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    // 背景工作（子代理、背景 shell…）結束的通知列：沒有 from，開頭換成狀態符號，只有失敗用紅色
    const task = e.props.task
    if (task && !e.props.isExpanded) {
      const mark = TASK_MARKS[task.status ?? ''] ?? { glyph: '·', color: DIM }
      const { Text } = $.ui.resolve(e)
      return (
        <Text>
          <Text color={mark.color} bold>{`${mark.glyph} `}</Text>
          <Text>{clip(e.props.text.split('\n')[0] ?? '', 90)}</Text>
          {task.durationMs !== undefined ? <Text color={DIM}>{`  ${duration(task.durationMs)}`}</Text> : null}
        </Text>
      )
    }
    const from = e.props.from
    if (!from || e.props.origin.kind === 'composer') return next(e)
    // 子代理回報開頭那段給模型看的框架說明（[Subagent hand-back] … The report follows:）不畫，只留回報本文；存下來的訊息不動
    const report = stripHandback(e.props.text)
    if (e.props.isExpanded) return report === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text: report } })
    const first = firstSentence(stripSummary(report))
    if (first === '') return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color={DIM}>{'› '}</Text>
        <Text color={SOFT}>{`${from.name}  `}</Text>
        <Text>{clip(first, 90)}</Text>
        <Text color={DIM}>{'  (ctrl+o 看全文)'}</Text>
      </Text>
    )
  })
}

// 開 pane；真的畫出來（isPlaced）才把題目從 prompt 上方那列移過去，太窄等著時題目留在原處
async function openPane($: EngineInterface) {
  // 寬度照設計稿（520px ≈ 52 欄）；使用者自己拖過的寬度引擎會優先
  const opened = await $.ui.open({ id: PANE, title: 'sitrep', columns: 52 })
  await update($, paneOpenAtom, () => opened.isPlaced)
}

// pane 照設計稿「駕駛艙」版（spec R11）：需要你、進行中、任務、證據、變更；空的段不畫，超過上限最後一列換成「…還有 N 項」
async function drawPane($: EngineInterface, e: RenderEvent, width: number) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const last = await read($, lastAtom)
  const pending = await read($, pendingAtom)
  const answers = pending ? (await read($, answersAtom))[pending.id] ?? {} : {}
  const sections: { title: string; color: string; rows: RenderElement[]; max: number }[] = []

  // 需要你：每題一塊黃底，選項照引擎問卷樣式畫成「a: 標籤」（第一題沒答的有字母熱鍵），選過的整題變灰、選中的打 ●
  const need: RenderElement[] = []
  let left = 0
  if (pending) {
    const total = pending.decisions.length
    const firstOpen = pending.decisions.findIndex((_, n) => answers[n] === undefined)
    pending.decisions.forEach((d, n) => {
      const picked = answers[n]
      if (picked === undefined) left++
      need.push(
        <Box key={`need-${n}`} flexDirection="column" backgroundColor={picked === undefined ? NEED_BG : undefined} paddingX={1}>
          <Text color={picked === undefined ? BRIGHT : DIM}>{total > 1 ? `${n + 1}. ${d.text}` : d.text}</Text>
          <Box flexDirection="row">
            {(d.options ?? []).map(o => {
              const isLetter = /^[a-z]$/i.test(o.key)
              const letter = isLetter ? o.key.toLowerCase() : o.key
              const hotkey = n === firstOpen && isLetter ? letter : undefined
              return (
                // 有熱鍵時引擎自己畫「a: 標籤」（字母用強調色）；沒熱鍵的照同一個樣子把「a: 」寫進標籤
                <Box key={`pane-opt-${n}-${o.key}`} flexDirection="row" marginRight={3}>
                  {picked === o.key ? <Text color={BRIGHT} bold>{'● '}</Text> : null}
                  <Button key={`pane-pick-${n}-${o.key}`} plain label={hotkey ? o.label : `${letter}: ${o.label}`} {...(hotkey ? { hotkey } : {})} {...(picked !== undefined && picked !== o.key ? { dimColor: true } : {})} onPress={() => pick($, pending.id, n, o.key, total)} />
                  {d.recommended === o.key && picked === undefined ? <Text color={YELLOW}>{' 建議'}</Text> : null}
                </Box>
              )
            })}
          </Box>
        </Box>,
      )
    })
  }
  const userNext = (last?.summary.items ?? []).filter(x => x.kind === 'user-next')
  for (const [i, item] of userNext.entries()) {
    need.push(<Text key={`you-${i}`}><Text color={YELLOW} bold>{'> '}</Text>{clip(item.text, width - 2)}</Text>)
  }
  sections.push({ title: `需要你 · ${left + userNext.length}`, color: YELLOW, rows: need, max: 8 })

  // 進行中：轉圈字形＋子代理／背景 描述，已跑時間靠右
  const now = await $.clock.now().catch(() => null)
  const runningRow = (key: string, label: string, since: number | undefined) => (
    <Box key={key} flexDirection="row">
      <Text color={BLUE}>{`${spin()} `}</Text>
      <Text>{clip(label, width - 10)}</Text>
      <Box flexGrow={1} />
      <Text color={DIM}>{now !== null && since !== undefined ? duration(now - since) : ''}</Text>
    </Box>
  )
  const agents = (await read($, agentsAtom)).filter(a => !(a.status in TASK_MARKS))
  sections.push({
    title: '進行中',
    color: DIM,
    rows: [
      ...agents.map(a => runningRow(`run-${a.id}`, `子代理 ${a.description}`, a.startedAt)),
      ...(await read($, backgroundAtom)).map((b, i) => runningRow(`bg-${i}`, `背景 ${b}`, undefined)),
    ],
    max: 5,
  })

  // 任務 完成數/總數：✓ 完成（灰）、▸ 下一項（亮）、○ 還沒做（灰）。
  // 來源：最近一張結論框的 tasks（使用者環境沒有任務工具）；沒有才用引擎的 TaskCreated／TaskCompleted
  const fromSummary = (last?.summary.tasks ?? []).map((t, i) => ({ id: `s${i}`, subject: t.text, done: t.done }))
  const tasks = fromSummary.length > 0 ? fromSummary : await read($, tasksAtom)
  const current = tasks.findIndex(t => !t.done)
  sections.push({
    title: `任務 ${tasks.filter(t => t.done).length}/${tasks.length}`,
    color: DIM,
    rows: tasks.map((t, i) => (
      <Text key={`task-${t.id}`}>
        <Text color={t.done ? GREEN : i === current ? undefined : DIM}>{t.done ? '✓ ' : i === current ? '▸ ' : '○ '}</Text>
        <Text color={i === current ? BRIGHT : DIM}>{clip(t.subject, width - 2)}</Text>
      </Text>
    )),
    max: 7,
  })

  // 證據：最近一次「驗證」摘要拆成一顆顆有框的小標籤（51 pass · tsc ✓ → [✓ 51 pass] [✓ tsc]）；不是這一輪的，標題註明幾輪前
  const evidence = await read($, evidenceAtom)
  const chips = evidence?.chips ?? []
  const proof = evidence?.proof ?? []
  sections.push({
    title: evidence && evidence.age > 0 ? `證據 · ${evidence.age} 輪前` : '證據',
    color: DIM,
    rows: chips.length === 0 ? [] : [
      ...[
        <Box key="chips" flexDirection="row" flexWrap="wrap">
          {chips.map((c, i) => {
            const chip = chipOf(c)
            return (
              <Box key={`chip-${i}`} borderStyle="round" borderColor={LINE} paddingX={1} marginRight={1}>
                <Text><Text color={chip.color}>{chip.glyph}</Text>{` ${clip(chip.text, 24)}`}</Text>
              </Box>
            )
          })}
        </Box>,
      ],
      // 細節：回覆「驗證」段的前 4 行（指令與結果），超過的看結論框的 › 驗證
      ...proof.slice(0, 4).map((l, i) => <Text key={`proof-${i}`} color={SOFT}>{clip(l, width)}</Text>),
      ...(proof.length > 4 ? [<Text key="proof-more" color={DIM}>{`…還有 ${proof.length - 4} 行，點結論框的 › 驗證看全部`}</Text>] : []),
    ],
    max: 6,
  })

  // 變更 · 未 commit：這個 session 改過的檔逐檔列（+綠 −紅）；其餘依最上層目錄收成一行「（不是這次改的）N 檔」
  const changes = await read($, changesAtom)
  const touched = new Set(await read($, touchedAtom))
  const mine = changes.filter(c => touched.has(c.abs))
  const others = new Map<string, number>()
  for (const c of changes.filter(c => !touched.has(c.abs))) {
    const top = c.path.includes('/') ? c.path.slice(0, c.path.indexOf('/')) : c.path
    others.set(top, (others.get(top) ?? 0) + 1)
  }
  const pathWidth = Math.max(12, width - 14)
  sections.push({
    title: '變更 · 未 commit',
    color: DIM,
    rows: [
      ...mine.map((c, i) => (
        <Box key={`chg-${i}`} flexDirection="row">
          <Box width={pathWidth}><Text color={SOFT}>{clip(c.path, pathWidth - 1)}</Text></Box>
          <Box width={6}><Text color={GREEN}>{`+${c.add}`}</Text></Box>
          <Text color={RED}>{`−${c.del}`}</Text>
        </Box>
      )),
      ...[...others].map(([top, n]) => (
        <Box key={`other-${top}`} flexDirection="row">
          <Box width={pathWidth}><Text color={DIM}>{clip(`${top}（不是這次改的）`, pathWidth - 1)}</Text></Box>
          <Text color={DIM}>{`${n} 檔`}</Text>
        </Box>
      )),
    ],
    max: 6,
  })

  const shown = sections.filter(sec => sec.rows.length > 0)
  if (shown.length === 0) return <Text color={DIM}>{'目前沒有需要你或進行中的事'}</Text>
  return (
    <Box flexDirection="column">
      {shown.map(sec => (
        <Box key={`sec-${sec.title}`} flexDirection="column" marginBottom={1}>
          <Text color={sec.color} bold={sec.color === YELLOW}>{sec.title}</Text>
          {sec.rows.length > sec.max ? [...sec.rows.slice(0, sec.max - 1), <Text key="more" color={DIM}>{`…還有 ${sec.rows.length - sec.max + 1} 項`}</Text>] : sec.rows}
        </Box>
      ))}
    </Box>
  )
}

// 證據小標籤的符號：摘要裡已經有 ✓／✗／– 就拿來用；寫了「未」「沒」的當成還沒驗
function chipOf(text: string): { glyph: string; color: string; text: string } {
  const bare = text.replace(/[✓✔✗✘]/g, '').trim()
  if (/[✗✘]|fail|失敗/i.test(text)) return { glyph: '✗', color: RED, text: bare }
  if (/未|沒|–|待/.test(text) && !/[✓✔]/.test(text)) return { glyph: '○', color: DIM, text: bare }
  return { glyph: '✓', color: GREEN, text: bare }
}

// git diff HEAD --numstat：「加\t刪\t路徑」；二進位檔是「-\t-」，當成 0
function parseNumstat(out: string, root: string): ChangeNote[] {
  return out.split('\n').map(l => l.split('\t')).filter(f => f.length >= 3).map(([add, del, ...rest]) => {
    const path = rest.join('\t')
    return { path, abs: `${root}/${path}`, add: Number(add) || 0, del: Number(del) || 0 }
  })
}

// 主對話派的子代理：第一次看到時記到這一輪的結論框下；已知的更新狀態，跑完的不再倒回
async function trackAgents($: EngineInterface, card: string | undefined) {
  const list = await $.agent.list().catch(() => [])
  const now = await $.clock.now().catch(() => undefined)
  await update($, agentsAtom, notes => {
    const out = [...notes]
    for (const a of list) {
      if (a.parentId) continue
      const at = out.findIndex(n => n.id === a.id)
      const known = out[at]
      if (known) {
        if (!(known.status in TASK_MARKS)) out[at] = { ...known, status: a.status }
      } else {
        // 第一次看到＝這一輪派的（之前每輪都記過）；子代理可能在這輪結束前就跑完（實機），所以不限還在跑的。
        // 沒有結論框的回合記成 card ''，只為了之後不再被算到別張框
        out.push({ id: a.id, type: a.type, description: a.description, status: a.status, card: card ?? '', startedAt: now })
      }
    }
    return out.slice(-KEEP_AGENTS)
  })
}

// 結論框裡這一輪派出去的背景子代理：轉圈＋執行中 已跑時間；跑完照通知列的符號（✓ 完成、! 失敗、– 中止）
async function agentRows($: EngineInterface, e: RenderEvent, card: string) {
  const agents = (await read($, agentsAtom)).filter(a => a.card === card)
  const { Text } = $.ui.resolve(e)
  const now = await $.clock.now().catch(() => null)
  return agents.map(a => {
    const mark = TASK_MARKS[a.status] ?? { glyph: spin(), color: BLUE }
    const running = now !== null && a.startedAt !== undefined ? `執行中 ${duration(now - a.startedAt)}` : '執行中'
    const state = a.status === 'completed' ? (a.durationMs !== undefined ? duration(a.durationMs) : '完成') : a.status === 'failed' ? '失敗' : a.status === 'killed' ? '已中止' : running
    return (
      <Text key={`agent-${a.id}`}>
        <Text color={mark.color} bold>{`${mark.glyph} `}</Text>
        <Text color={SOFT}>{`${a.type}  `}</Text>
        <Text>{clip(a.description, 50)}</Text>
        <Text color={DIM}>{`  ${state}`}</Text>
      </Text>
    )
  })
}

// 背景工作結束的狀態：完成、中止灰；失敗紅（顏色只給需要你）
const TASK_MARKS: Record<string, { glyph: string; color: string }> = {
  completed: { glyph: '✓', color: DIM },
  failed: { glyph: '!', color: RED },
  killed: { glyph: '–', color: DIM },
}

// 耗時最接近的一筆；同樣接近時取較新的
function matchTurn(turns: TurnNote[], durationMs: number): TurnNote | undefined {
  let best: TurnNote | undefined
  for (const t of turns) {
    const d = Math.abs(t.durationMs - durationMs)
    if (d <= MATCH_MS && (!best || d <= Math.abs(best.durationMs - durationMs))) best = t
  }
  return best
}

// 回覆裡最後一個 ui-summary 區塊；沒有回 null。JSON 讀不懂時 summary 為 null（照樣把區塊藏起來）
function findSummary(text: string): { id: string; summary: Summary | null; rest: string } | null {
  const blocks = [...text.matchAll(FENCE_RE)]
  const last = blocks.at(-1)
  if (!last) return null
  const raw = (last[1] ?? '').trim()
  return { id: hash(raw), summary: parseSummary(raw), rest: text.replace(FENCE_RE, '').replace(/\s+$/, '') }
}

// 最後一個 ```ui-summary 後面還沒有收尾的 ```：回傳開頭之前的正文；沒有這種區塊回 null
function cutOpenFence(text: string): string | null {
  const at = [...text.matchAll(/^```ui-summary/gm)].at(-1)?.index ?? -1
  if (at >= 0 && text.indexOf('```', at + 3) < 0) return text.slice(0, at).replace(/\s+$/, '')
  // 開頭那行還沒傳完（```、```ui-sum）也藏：只在它是開新區塊時（前面的 ``` 行成對），收尾的 ``` 不動
  const nl = text.lastIndexOf('\n')
  const tail = text.slice(nl + 1)
  const before = text.slice(0, nl + 1)
  if (tail.length >= 3 && '```ui-summary'.startsWith(tail) && (before.match(/^```/gm)?.length ?? 0) % 2 === 0) return before.replace(/\s+$/, '')
  return null
}

// ASCII 圖：沒標語言（或 text）的程式碼區塊，內含框線字元或箭頭
// ```dot（或 graphviz）區塊也當成圖，標籤另附節點與邊數
const FIG_FENCE_RE = /^```([A-Za-z]*)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
// 純 ASCII 圖（output style 規定回覆裡的圖用 +--+、|--、`--）也要認得
const FIG_MARK_RE = /[─│┌┐└┘├┤┬┴┼╭╮╯╰═║]|[→←↑↓]|-->|<--|\+--|--\+|\|--|`--/

type Part = { kind: 'text' | 'figure' | 'dot'; text: string }

// 正文依圖切段；沒有圖時回一段原文
function splitFigures(text: string): Part[] {
  const parts: Part[] = []
  let at = 0
  for (const m of text.matchAll(FIG_FENCE_RE)) {
    const lang = (m[1] ?? '').toLowerCase()
    const body = m[2] ?? ''
    const kind = lang === 'dot' || lang === 'graphviz' ? 'dot' : ['', 'text', 'txt'].includes(lang) && FIG_MARK_RE.test(body) ? 'figure' : null
    if (kind === null) continue
    const before = text.slice(at, m.index).trim()
    if (before !== '') parts.push({ kind: 'text', text: before })
    parts.push({ kind, text: body })
    at = m.index + m[0].length
  }
  const rest = text.slice(at).trim()
  if (rest !== '' || parts.length === 0) parts.push({ kind: 'text', text: parts.length === 0 ? text : rest })
  return parts
}

// dot 原文粗算：-> 或 -- 算一條邊，出現在邊或節點宣告裡的名字算節點；屬性（[...]、a=b）不算
function countDot(source: string): { nodes: number; edges: number } {
  const body = source.replace(/\[[^\]]*\]/g, ' ').replace(/^[^{]*\{/, ' ').replace(/\b\w+\s*=\s*("[^"]*"|\S+)/g, ' ')
  const edges = (body.match(/->|--/g) ?? []).length
  const words = body.match(/"[^"]*"|\b[A-Za-z_][\w]*\b/g) ?? []
  const keywords = new Set(['graph', 'digraph', 'subgraph', 'node', 'edge', 'strict'])
  return { nodes: new Set(words.filter(w => !keywords.has(w.toLowerCase()))).size, edges }
}

// 子代理回報開頭的框架說明：從 [Subagent hand-back] 到 The report follows: 拿掉，回報本文去掉引擎加的縮排；沒有就原樣回傳
function stripHandback(text: string): string {
  const m = /^\s*\[Subagent hand-back\][\s\S]*?The report follows:[^\n]*\n/.exec(text)
  if (!m) return text
  const lines = text.slice(m[0].length).split('\n')
  const indent = Math.min(...lines.filter(l => l.trim() !== '').map(l => /^ */.exec(l)?.[0].length ?? 0))
  return lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim()
}

function stripSummary(text: string): string {
  return text.replace(FENCE_RE, '').trim()
}

function parseSummary(raw: string): Summary | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.outcome !== 'string') return null
  const items = Array.isArray(d.items) ? d.items.filter(isItem) : []
  const facets = Array.isArray(d.facets) ? d.facets.filter(isFacet) : []
  const status = d.status === 'blocked' || d.status === 'partial' || d.status === 'done' ? d.status : undefined
  const tasks = Array.isArray(d.tasks) ? d.tasks.filter((t): t is SummaryTask => typeof t?.text === 'string' && typeof t?.done === 'boolean') : []
  return { ...(status ? { status } : {}), outcome: d.outcome, items, facets, ...(tasks.length > 0 ? { tasks } : {}) }
}

function isItem(x: unknown): x is Item {
  if (typeof x !== 'object' || x === null) return false
  const i = x as Record<string, unknown>
  const kinds = ['decision', 'user-next', 'agent-next']
  const options = i.options === undefined || (Array.isArray(i.options) && i.options.every(o => typeof o?.key === 'string' && typeof o?.label === 'string'))
  return kinds.includes(String(i.kind)) && typeof i.text === 'string' && options
}

function isFacet(x: unknown): x is Facet {
  if (typeof x !== 'object' || x === null) return false
  const f = x as Record<string, unknown>
  return typeof f.label === 'string' && typeof f.summary === 'string' && (f.heading === undefined || typeof f.heading === 'string')
}

// 要使用者選的題目（有選項的 decision）；題號就是在這個陣列裡的位置
function decisionsOf(items: Item[]): Item[] {
  return items.filter(i => i.kind === 'decision' && (i.options?.length ?? 0) > 0)
}

// 等你決定＞卡住＞等你動手＞部分完成＞完成。照模型標的狀態走：完成、卡住不因附了「你要做」變黃（使用者實機：幾乎每個框都黃）；
// 只有做到一半停下來等你才是等你動手（實機 s3 原本標成進行中，兩個評審都誤判成還在跑）
function glyphOf(s: Summary): string {
  if (decisionsOf(s.items).length > 0) return '?'
  if (s.status === 'blocked') return '!'
  if (s.status !== 'done' && s.items.some(i => i.kind === 'user-next')) return '>'
  if (s.status === 'partial') return '~'
  return '✓'
}

// 把 facets 指到的段落（標題那行到下一個同級或更高的標題前）從正文拿掉；找不到標題的 facet 只畫摘要列。
// 展開中的段落留在正文原位：放進框裡的 Markdown 會照整個終端寬度排表格，被框線擠到跑版（實機截圖）
function cutSections(text: string, facets: Facet[], isOpen: (i: number) => boolean): { shown: string; sections: (string | null)[] } {
  let lines = text.split('\n')
  const sections = facets.map((f, n) => {
    if (!f.heading) return null
    const want = norm(f.heading)
    const start = lines.findIndex(l => {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
      return m !== null && norm(m[2] ?? '') === want
    })
    if (start < 0) return null
    const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 1
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s/.exec(lines[i] ?? '')
      if (m && (m[1]?.length ?? 7) <= level) {
        end = i
        break
      }
    }
    const section = lines.slice(start + 1, end).join('\n').trim()
    if (!isOpen(n)) lines = [...lines.slice(0, start), ...lines.slice(end)]
    return section
  })
  return { shown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), sections }
}

// 有題目時，正文裡標題含「決定」的那段（例如「## 待你決定」）也收進框，列成「利弊」：題目本身已畫在框裡，
// 正文再寫一次就是同一件事說兩次（實機 s2 三個模型都這樣）。沒有標題的寫法（直接列 1. 2.）抓不到，照原樣留在正文
function withDecisionFacet(summary: Summary | null, text: string): Facet[] {
  const facets = summary?.facets ?? []
  if (!summary || decisionsOf(summary.items).length === 0) return facets
  const taken = new Set(facets.map(f => norm(f.heading ?? '')))
  const heading = text.split('\n').map(l => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l)?.[1]).find(h => h !== undefined && h.includes('決定') && !taken.has(norm(h)))
  return heading === undefined ? facets : [...facets, { label: '利弊', summary: '各選項的說明與建議', heading }]
}

function norm(s: string): string {
  return s.replace(/[*_`]/g, '').trim()
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

function facetRows($: EngineInterface, e: RenderEvent, id: string, facets: Facet[], sections: (string | null)[], open: Record<string, boolean>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  // 標籤補到同寬，摘要排成一直欄（「變更」與「殘留風險」長度不同，摘要起點原本對不齊）
  const width = Math.max(0, ...facets.map(f => cols(f.label)))
  return facets.map((f, i) => {
    const key = `${id}:${i}`
    const isOpen = open[key] === true
    const section = sections[i]
    return (
      <Box key={`facet-${i}`} flexDirection="row">
        {section
          ? <Button key={`toggle-${i}`} plain label={isOpen ? '▾' : '▸'} onPress={() => update($, openAtom, o => ({ ...o, [key]: !isOpen }))} />
          : <Text color={DIM}>{'·'}</Text>}
        {/* 灰階分層（不加新顏色）：標籤亮一階加粗、內文用亮字，「之後我」維持最暗，兩者分得開（使用者實機：收合列太灰不顯眼） */}
        <Text color={SOFT} bold>{` ${f.label}${' '.repeat(width - cols(f.label))}  `}</Text>
        <Text color={BRIGHT}>{isOpen ? `${f.summary}（已放回正文）` : f.summary}</Text>
      </Box>
    )
  })
}

// 待你決定的題目（選項按鈕）、你要做的事（黃）、之後我接著做的事（灰）
async function itemRows($: EngineInterface, e: RenderEvent, id: string, items: Item[]) {
  const answers = (await read($, answersAtom))[id] ?? {}
  const { Box, Button, Text } = $.ui.resolve(e)
  const decisions = decisionsOf(items)
  const others = items.filter(i => !decisions.includes(i))
  const questions = decisions.map((d, n) => (
    <Box key={`q-${n}`} flexDirection="column" marginTop={n === 0 ? 1 : 0}>
      <Text>
        <Text color={YELLOW} bold>{'? '}</Text>
        <Text color={BRIGHT}>{decisions.length > 1 ? `${n + 1}. ${d.text}` : d.text}</Text>
      </Text>
      <Box flexDirection="row" marginLeft={2}>
        {(d.options ?? []).map(o => {
          const picked = answers[n] === o.key
          return (
            <Box key={`opt-${n}-${o.key}`} flexDirection="row" marginRight={3}>
              <Button key={`pick-${n}-${o.key}`} plain label={`${picked ? '●' : ' '}${o.key}`} onPress={() => pick($, id, n, o.key, decisions.length)} />
              <Text>{` ${o.label}`}</Text>
              {d.recommended === o.key ? <Text color={YELLOW}>{' 建議'}</Text> : null}
            </Box>
          )
        })}
      </Box>
    </Box>
  ))
  // 符號換成字（評審：> 和 ~ 第一次看不懂）；你要做的排在結論下第一行，之後我排最後
  const todo = others.filter(o => o.kind === 'user-next').map((o, i) => (
    <Text key={`todo-${i}`}>
      <Text color={YELLOW} bold>{'你要做  '}</Text>
      <Text>{o.text}</Text>
    </Text>
  ))
  const later = others.filter(o => o.kind !== 'user-next').map((o, i) => (
    <Text key={`later-${i}`} color={DIM}>{`之後我  ${o.text}`}</Text>
  ))
  return { todo, questions, later }
}

// 記下這題的答案，把這張卡已選的答案依題號排好填進提示框（取代草稿）
async function pick($: EngineInterface, id: string, n: number, key: string, total: number) {
  const all = await update($, answersAtom, a => ({ ...a, [id]: { ...(a[id] ?? {}), [n]: key } }))
  const mine = all[id] ?? {}
  const draft = Object.keys(mine).map(Number).sort((a, b) => a - b).map(i => (total > 1 ? `${i + 1}. ${mine[i]}` : `${mine[i]}`)).join('  ')
  const filled = await $.prompt.fill({ text: draft })
  if (!filled.isFilled) $.ui.toast(`${TAG}：沒填進提示框（${filled.refusal ?? '原因不明'}）`, { timeoutMs: 4000 })
}

function firstSentence(text: string): string {
  // 跳過標題行與 [Subagent hand-back] 這類方括號開頭的框架行，取第一行正文
  const line = text.split('\n').filter(l => !/^\s*#/.test(l) && !/^\s*\[[^\]]+\]/.test(l))
    .map(l => l.replace(/^[-*>]\s+|\*\*/g, '').trim()).find(l => l !== '' && !l.startsWith('```')) ?? ''
  // 全形句號後面不必有空白；半形的要接空白或行尾（1.5、v0.9.0 不算句尾）
  const m = /^(.+?(?:[。！？]|[.!?](?=\s|$)))/.exec(line)
  return (m?.[1] ?? line).trim()
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function hash(s: string): string {
  let h = 5381
  for (const ch of s) h = ((h * 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0
  return h.toString(36)
}

// 終端欄寬：CJK 與全形字佔 2 欄
function charCols(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1
}

function cols(s: string): number {
  let n = 0
  for (const ch of s) n += charCols(ch)
  return n
}

function clip(s: string, width: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = charCols(ch)
    if (used + w > width - 1) return `${out}…`
    out += ch
    used += w
  }
  return out
}
