import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { AgentNote, ChangeNote, Evidence, Excerpt, Facet, Item, Option, Summary, TaskNote, TurnNote } from '../types'

// sitrep：
// 1. 主對話回覆夠長時，回合結束後（turn.complete）把回覆切成編號行，請小模型（$.model.complete）只回編號：
//    哪行是結論、哪些是待決題目與選項、你要做的事、之後我做的事、哪幾段是可收合的細節。mod 檢查編號、用回覆原句組成結論框，
//    模型寫不出回覆裡沒有的字；編號對不上、逾時、API 錯都在框的位置寫「摘錄失敗：原因」。不改系統提示。
// 2. 畫回覆時（AssistantMessage）用正文雜湊找摘錄，正文下面畫一個圓角結論框：標題（狀態＋耗時）疊在上框線，
//    框裡是粗體結論、細節段落（從正文拿掉，一行摘要；展開時放回正文原位）、待你決定的題目（按選項把「題號. key」填進提示框，不送出）。
//    AssistantMessage 沒有 isExpanded，分不出 ctrl+o 畫面，那裡一樣畫成結論框。
// 3. 沒摘錄的回合（短回覆、摘錄作廢），回合結束那列（TurnDuration，「Baked for 3s」）換成「– 本輪結束（無摘錄）」，不假裝沒事；
//    那列沒有輪次編號，用耗時對回 turn.complete。
// 4. 子代理回報那列（UserMessage，收合時「Message from @…」）換成它回報的第一句，ctrl+o 照原樣展開。
// 5. 還有沒答的題目時，prompt 上方（AbovePrompt）一行「? N 項等你決定」，聚焦後按選項字母選答（一樣只填提示框）。
// 6. 背景工作結束的通知列開頭換成狀態符號（✓ 完成、! 失敗、– 中止）；那一輪派出的背景子代理也列在結論框裡，跑完自動更新。
// 7. 回覆裡的 ASCII 圖（含框線字元或箭頭的程式碼區塊）畫在灰底區塊、上方一行灰字「圖」，不被大量文字蓋過。
// 8. 回覆裡的 ```dot 區塊照 7 畫原文，標籤附粗算的節點與邊數。

const TAG = 'sitrep'

// 畫面上的字：userConfig language 選 en（預設）或 zh-TW；回覆內容照對話語言，不在這裡
const ZH = {
  status: { '?': '等你決定', '>': '等你動手', '!': '卡住', '~': '進行中', '✓': '完成' } as Record<string, string>,
  cmdPane: 'sitrep：開關狀態 pane（需要你、進行中、任務、證據、變更）',
  registerFailed: (name: string, err: string) => `${TAG} 註冊 /${name} 失敗：${err}`,
  logFailed: (what: string, err: string) => `${TAG} ${what}失敗：${err}`,
  logSpawn: '記錄子代理啟動',
  paneClosed: `${TAG}：已關閉狀態 pane（/sitrep-pane 可再打開）`,
  paneOpened: `${TAG}：已打開狀態 pane（實驗中；再打一次 /sitrep-pane 關閉）`,
  excerpting: '摘錄中',
  noExcerpt: '本輪結束（無摘錄）',
  openCount: (n: number) => `? ${n} 題待決`,
  recommended: ' 建議',
  recShort: ' 建議',
  rowHint: '   · 聚焦後按字母，只填入輸入框',
  yourMove: '等你動手：',
  figure: '圖',
  dotFigure: (nodes: number, edges: number) => `圖：${nodes} 個節點、${edges} 條邊（dot 原文）`,
  excerptFailed: (reason: string) => `摘錄失敗：${reason}`,
  excerptTag: '摘錄 ',
  fullText: '  (ctrl+o 看全文)',
  timedOut: (s: number) => `逾時或中止（${s}s）`,
  mismatch: '回傳的編號對不上原文',
  superseded: '本輪結束（新一輪已開始，摘錄作廢）',
  needsYou: (n: number) => `需要你 · ${n}`,
  running: '進行中',
  subagent: (d: string) => `子代理 ${d}`,
  background: (b: string) => `背景 ${b}`,
  tasks: (done: number, all: number) => `任務 ${done}/${all}`,
  evidence: '證據',
  evidenceAge: (n: number) => `證據 · ${n} 輪前`,
  moreProof: (n: number) => `…還有 ${n} 行，點結論框的 › 驗證看全部`,
  changes: '變更 · 未 commit',
  notThisTime: '（不是這次改的）',
  files: (n: number) => `${n} 檔`,
  nothing: '目前沒有需要你或進行中的事',
  more: (n: number) => `…還有 ${n} 項`,
  stateRunning: '執行中',
  stateDone: '完成',
  stateFailed: '失敗',
  stateKilled: '已中止',
  optionsLabel: '利弊',
  optionsSummary: '各選項的說明與建議',
  backInReply: '（已放回正文）',
  youDo: '你要做  ',
  thenI: '之後我  ',
  notFilled: (why: string | undefined) => `${TAG}：沒填進提示框（${why ?? '原因不明'}）`,
}
type Texts = typeof ZH
const EN: Texts = {
  status: { '?': 'Your call', '>': 'Your move', '!': 'Blocked', '~': 'In progress', '✓': 'Done' },
  cmdPane: 'sitrep: toggle the status pane (needs you, running, tasks, evidence, changes)',
  registerFailed: (name, err) => `${TAG} could not register /${name}: ${err}`,
  logFailed: (what, err) => `${TAG} ${what} failed: ${err}`,
  logSpawn: 'recording a subagent start',
  paneClosed: `${TAG}: closed the status pane (/sitrep-pane opens it again)`,
  paneOpened: `${TAG}: opened the status pane (experimental; /sitrep-pane again closes it)`,
  excerpting: 'excerpting',
  noExcerpt: 'turn ended (no excerpt)',
  openCount: n => `? ${n} open`,
  recommended: ' recommended',
  recShort: ' rec',
  rowHint: '   · focus, then press a letter; only fills the prompt',
  yourMove: 'Your move: ',
  figure: 'figure',
  dotFigure: (nodes, edges) => `figure: ${nodes} nodes, ${edges} edges (dot source)`,
  excerptFailed: reason => `excerpt failed: ${reason}`,
  excerptTag: 'excerpt ',
  fullText: '  (ctrl+o for the full text)',
  timedOut: s => `timed out or aborted (${s}s)`,
  mismatch: 'line numbers did not match the reply',
  superseded: 'turn ended (a new turn started; excerpt dropped)',
  needsYou: n => `Needs you · ${n}`,
  running: 'Running',
  subagent: d => `subagent ${d}`,
  background: b => `background ${b}`,
  tasks: (done, all) => `Tasks ${done}/${all}`,
  evidence: 'Evidence',
  evidenceAge: n => `Evidence · ${n} turn${n === 1 ? '' : 's'} ago`,
  moreProof: n => `…${n} more lines; open the checks row in the box to see all`,
  changes: 'Changes · uncommitted',
  notThisTime: ' (not changed this turn)',
  files: n => `${n} file${n === 1 ? '' : 's'}`,
  nothing: 'Nothing needs you and nothing is running',
  more: n => `…${n} more`,
  stateRunning: 'running',
  stateDone: 'done',
  stateFailed: 'failed',
  stateKilled: 'killed',
  optionsLabel: 'Options',
  optionsSummary: 'what each option means, and the pick',
  backInReply: ' (back in the reply)',
  youDo: 'You do  ',
  thenI: 'Then I  ',
  notFilled: why => `${TAG}: could not fill the prompt (${why ?? 'unknown reason'})`,
}
let T: Texts = EN
const KEEP_TURNS = 50
const KEEP_AGENTS = 50
const PANE = 'sitrep'
// 子代理在跑時的重畫計時器（模組層，同一時間只開一個）：每 250ms 一幀，轉圈字形與已跑時間跟著走
let tick: Timer | null = null
let frame = 0
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const spin = () => SPIN[frame % SPIN.length]
// 顏色只給「需要你」：黃＝等你決定；紅＝卡住；其餘灰階（第三輪設計稿的安靜版）。
// 一律用引擎的主題色名稱，跟著使用者的 Claude Code 主題（含淺色、daltonized）走；深色主題預設值：
// warning 琥珀、error 粉紅、success 綠（daltonized 是藍）、inactive 153 灰、subtle 80 灰、text 白
const YELLOW = 'warning'
const RED = 'error'
const GREEN = 'success'
const DIM = 'inactive'
const SOFT = 'inactive'
// ASCII 圖的灰底：用你的訊息底色（深色 55 灰、淺色 240 灰），淺色主題下字才看得到
const FIG_BG = 'userMessageBackground'
const BRIGHT = 'text'
// pane（設計稿駕駛艙版）：進行中的藍、需要你那塊的底、證據小標籤的框線
const BLUE = 'suggestion'
const NEED_BG = 'userMessageBackground'
const LINE = 'subtle'
// 每輪結論框（學 your-turn 的圓角框，標題嵌在上框線）：框線是暗一階的狀態色（borderDimColor），標題用亮的；只有「等你決定」是黃
const FRAMES: Record<string, { title: string }> = {
  '?': { title: YELLOW },
  '>': { title: YELLOW },
  '!': { title: RED },
  '~': { title: BLUE },
  '✓': { title: GREEN },
}
const DONE_FRAME = { title: GREEN }
const BOX_MAX = 88
// TurnDuration 的耗時和 turn.complete 的不一定分毫不差（實測 13s 對得上、42s 對不上）：取差距最小、在這範圍內的那筆
const MATCH_MS = 3000

// 摘錄：回覆（不算程式碼區塊）至少這麼長，或有這麼多個標題才摘（分段的短完工報告也要框；實測 310 則回覆裡 16% 是這種）；
// 挑編號用的模型與時限
const EXCERPT_MIN = 800
const EXCERPT_HEADINGS = 2
const EXCERPT_MODEL = 'haiku'
const EXCERPT_TIMEOUT_MS = 20_000
const KEEP_EXCERPTS = 50
// 主對話每開始一輪 +1：摘錄回來時已經換輪就作廢，待決題目不能蓋掉新一輪的
let turnGen = 0

// 給挑編號模型的規則：只回編號，文字一律由 mod 從回覆原句取
const PICK_RULES = [
  'You index an assistant reply for a terminal UI. The reply is given as numbered lines "[n] text". Return ONLY one line of JSON, no prose:',
  '{"status":"done|blocked|partial","outcome":n,"decisions":[{"question":n,"options":[n,n],"recommended":n}],"todo":[n],"next":[n],"sections":[{"heading":n,"summary":n}]}',
  '- Every value except status is a line number from the reply. Never write text of your own.',
  '- outcome: the one line that best states the result or answer.',
  '- status: done when the work or answer is complete; blocked when it waits on the user or an obstacle; partial when only part is done.',
  '- decisions: only questions the reply explicitly asks the user. question is the line asking; options are the lines of each listed choice (2 or more, never the question line itself), or [] when the reply lists no choices; recommended is the option line the reply recommends, or omit it.',
  '- todo: lines naming something the user must do by hand. next: lines naming what the assistant will do next. Use [] when there are none.',
  '- sections: for each heading line ("#" lines) whose section holds details the user can expand later (changes, verification, risks, evidence), the heading line and the one line inside that section that best summarizes it. Skip the section holding the main result.',
].join('\n')

const answersAtom = atom({ plugin: 'sitrep', key: 'answers' } as const, {} as Record<string, Record<number, string>>)
const openAtom = atom({ plugin: 'sitrep', key: 'open' } as const, {} as Record<string, boolean>)
const turnsAtom = atom({ plugin: 'sitrep', key: 'turns' } as const, [] as TurnNote[])
const agentsAtom = atom({ plugin: 'sitrep', key: 'agents' } as const, [] as AgentNote[])
const excerptsAtom = atom({ plugin: 'sitrep', key: 'excerpts' } as const, {} as Record<string, Excerpt>)
const lastAtom = atom({ plugin: 'sitrep', key: 'last' } as const, null as { id: string; summary: Summary } | null)
const evidenceAtom = atom({ plugin: 'sitrep', key: 'evidence' } as const, null as Evidence | null)
const backgroundAtom = atom({ plugin: 'sitrep', key: 'background' } as const, [] as string[])
const tasksAtom = atom({ plugin: 'sitrep', key: 'tasks' } as const, [] as TaskNote[])
const changesAtom = atom({ plugin: 'sitrep', key: 'changes' } as const, [] as ChangeNote[])
const touchedAtom = atom({ plugin: 'sitrep', key: 'touched' } as const, [] as string[])
const paneOpenAtom = atom({ plugin: 'sitrep', key: 'paneOpen' } as const, false)
const pendingAtom = atom({ plugin: 'sitrep', key: 'pending' } as const, null as { id: string; decisions: Item[]; todo: string[] } | null)

export const register: Register = (on, options) => {
  T = options.language === 'zh-TW' ? ZH : EN
  on('turn.start', async ($, e, next) => {
    turnGen++
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 名稱衝突會丟例外，包住免得中斷 hook
    try {
      await $.command.register({ name: 'sitrep-pane', description: T.cmdPane })
    } catch (err) {
      $.ui.log(T.registerFailed('sitrep-pane', String(err)))
    }
    return result
  })

  // 子代理一啟動就記下：開始時間是真的。主對話派的等這一輪結束由 trackAgents 補上結論框；
  // 子代理再派的、workflow 的不屬於任何結論框（card ''），只在狀態 pane 列出。寫 state 失敗不能擋住子代理啟動
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    try {
      const at = await $.clock.now()
      const nested = e.parentAgentId !== undefined || e.workflow !== undefined
      const note: AgentNote = { id, type: e.subagentType, description: e.description, status: 'running', startedAt: at, ...(nested ? { card: '' } : {}) }
      await update($, agentsAtom, list => [...list.filter(a => a.id !== id), note].slice(-KEEP_AGENTS))
      startTick($)
    } catch (err) {
      $.ui.log(T.logFailed(T.logSpawn, String(err)))
    }
    return started
  }).catch(($, e, next) => next(e)) // 這個 hook 本身出錯也照常啟動子代理（next 已呼叫過就回放那次結果，不會啟動兩次）

  // pane 只能手動開關（2026-10-08 使用者：pane 視覺另案設計，平常只用安靜版，不再自動開）
  on('command.run', { command: 'sitrep-pane' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: T.paneClosed }
    }
    await openPane($)
    return { text: T.paneOpened }
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
    const lines = numberLines(e.answer)
    const isLong = lines.join('').length >= EXCERPT_MIN || lines.filter(l => HEADING_RE.test(l)).length >= EXCERPT_HEADINGS
    const id = isLong ? keyOf(e.answer) : undefined
    await trackAgents($, id)
    // 有子代理在跑時每 250ms 重畫一次：轉圈字形和已跑時間證明它還活著（使用者 2026-10-08 選轉圈）；都跑完就停
    if ((await read($, agentsAtom)).some(a => !(a.status in TASK_MARKS))) startTick($)
    const note: TurnNote = id
      ? { id, durationMs: e.durationMs, glyph: '…', outcome: T.excerpting }
      : { durationMs: e.durationMs, glyph: '–', outcome: T.noExcerpt }
    await update($, turnsAtom, list => [...list, note].slice(-KEEP_TURNS))
    if (id) {
      // 不在這裡等模型：回合結束不能被摘錄拖住，回來後再補畫
      await update($, excerptsAtom, all => keepLast({ ...all, [id]: { state: 'pending' } }))
      const gen = turnGen
      $.clock.after(0, () => void excerpt($, id, e.answer, lines, gen))
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
    const hasAsk = !!pending && (!!first || todo !== undefined) && !(await read($, paneOpenAtom))
    if (!hasAsk) return next(e)
    // band 只有一個：先讓排在下面的 mod 畫（例如 ctx-relay 的交接列），自己這列疊在它下面
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    let line: RenderElement | null = null
    if (pending && first) {
      const { d, n } = first
      const total = pending.decisions.length
      // hotkey 只收一個小寫字母；數字不給：空的提示框裡按數字會直接按到 band 的按鈕，也會撞 ctx-relay 的 "1"
      line = (
        <Box key="above-row" flexDirection="row">
          {/* 計數和選項不縮：英文較長時會被擠成兩行（實機），只讓最後的說明截斷 */}
          <Box flexShrink={0}>
            <Text color={YELLOW} bold>{T.openCount(open.length)}</Text>
            <Text color={BRIGHT}>{total > 1 ? `   ${n + 1}.` : '  '}</Text>
          </Box>
          {(d.options ?? []).map(o => {
            const hotkey = /^[a-z]$/i.test(o.key) ? o.key.toLowerCase() : undefined
            return (
              <Box key={`above-opt-${o.key}`} flexDirection="row" marginLeft={2} flexShrink={0}>
                <Button key={`above-pick-${n}-${o.key}`} plain label={clip(hotkey ? o.label : `${o.key} ${o.label}`, 24)} {...(hotkey ? { hotkey } : {})} onPress={() => pick($, pending.id, n, o.key, total)} />
                {d.recommended === o.key ? <Text color={YELLOW}>{T.recShort}</Text> : null}
              </Box>
            )
          })}
          <Text color={DIM} wrap="truncate-end">{T.rowHint}</Text>
        </Box>
      )
    } else {
      line = (
        <Text key="above-todo" wrap="truncate-end">
          <Text color={YELLOW} bold>{T.yourMove}</Text>
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
        let label = T.figure
        if (p.kind === 'dot') {
          const c = countDot(p.text)
          label = T.dotFigure(c.nodes, c.edges)
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
    const id = keyOf(e.props.text)
    const ex = (await read($, excerptsAtom))[id]
    if (ex === undefined) return draw(e.props.text)
    if (ex.state !== 'ready') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {await draw(e.props.text)}
          <Text key="excerpt-note" color={DIM}>{ex.state === 'pending' ? `  … ${T.excerpting}` : `  – ${T.excerptFailed(ex.reason)}`}</Text>
        </Box>
      )
    }
    const found = { id, summary: ex.summary, rest: e.props.text }
    // pane 開著＝駕駛艙模式：不畫安靜版的結論框，正文完整照畫，底下只留一行「✓ 結論  耗時」；需要你、證據、變更都在 pane
    if (await read($, paneOpenAtom)) {
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
    // 框寬固定（不跟內容跳，實機 36～81 欄）：終端寬減 4，最寬 88
    const width = Math.min((e.viewport?.columns ?? 92) - 4, BOX_MAX)
    // 選項標籤可用的欄數：框線 2、內距 2、縮排 2、選項鍵 2、空一格
    const items = await itemRows($, e, found.id, found.summary.items, width - 9)
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
    return (
      <Box flexDirection="column">
        {body}
        <Box key="lens-wrap" flexDirection="column" marginTop={1} width={width}>
          <Box key="lens" borderStyle="round" borderColor={frame.title} borderDimColor paddingX={1} flexDirection="column">
            {rows}
          </Box>
          <Box key="title" position="absolute" top={0} left={2} flexDirection="row">
            {isOld ? <Button key="box-close" plain label="▾" onPress={toggleBox} /> : null}
            <Text color={frame.title} bold>{` ${glyph} ${T.status[glyph] ?? T.status['✓']} `}</Text>
            <Text color={DIM}>{T.excerptTag}</Text>
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
    const first = firstSentence(report)
    if (first === '') return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color={DIM}>{'› '}</Text>
        <Text color={SOFT}>{`${from.name}  `}</Text>
        <Text>{clip(first, 90)}</Text>
        <Text color={DIM}>{T.fullText}</Text>
      </Text>
    )
  })
}

// 請小模型挑編號、組成結論框。換輪了就作廢（待決題目不能蓋掉新一輪的）；失敗照實記下原因，框的位置會寫出來
async function excerpt($: EngineInterface, id: string, answer: string, lines: string[], gen: number) {
  const prompt = lines.map((l, i) => `[${i + 1}] ${l}`).join('\n')
  const r = await $.model.complete({ model: EXCERPT_MODEL, system: PICK_RULES, prompt, effort: 'low', maxTokens: 600, timeoutMs: EXCERPT_TIMEOUT_MS })
    .catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
  let result: Excerpt
  if (!r.isAnswered) result = { state: 'failed', reason: r.reason === 'aborted' ? T.timedOut(EXCERPT_TIMEOUT_MS / 1000) : r.reason }
  else {
    const summary = buildSummary(lines, r.text)
    result = summary ? { state: 'ready', summary } : { state: 'failed', reason: T.mismatch }
  }
  if (gen !== turnGen) {
    await update($, excerptsAtom, all => {
      const { [id]: _, ...rest } = all
      return rest
    })
    await update($, turnsAtom, list => list.map(t => (t.id === id ? { durationMs: t.durationMs, glyph: '–', outcome: T.superseded } : t)))
    $.ui.invalidate('ui.render')
    return
  }
  await update($, excerptsAtom, all => keepLast({ ...all, [id]: result }))
  if (result.state === 'failed') {
    await update($, turnsAtom, list => list.map(t => (t.id === id ? { ...t, glyph: '–', outcome: T.excerptFailed(result.reason) } : t)))
    $.ui.invalidate('ui.render')
    return
  }
  const summary = result.summary
  await update($, turnsAtom, list => list.map(t => (t.id === id ? { ...t, glyph: glyphOf(summary), outcome: summary.outcome } : t)))
  // 新的結論框沒有題目＝之前的題目已經處理過（例如使用者自己打字回答），那列跟著消失
  // 完工回覆的「你要做」多半是建議（例如手動再測一次），不在 prompt 上方催；卡住、做到一半才提示
  const todo = summary.status === 'done' ? [] : summary.items.filter(i => i.kind === 'user-next').map(i => i.text)
  await update($, pendingAtom, () => ({ id, decisions: decisionsOf(summary.items), todo }))
  await update($, lastAtom, () => ({ id, summary }))
  // 證據：沿用最近一輪有「驗證」段的結果，直到下一次驗證蓋過去（問題輪通常沒有驗證段，pane 卻正好開著）
  const verify = summary.facets.map((f, i) => ({ f, i })).filter(({ f }) => /驗證|verif|check|test/i.test(f.label))
  if (verify.length > 0) {
    // 細節：回覆裡「驗證」那段的前幾行（跑過的指令與結果），pane 的證據段畫在小標籤下面
    const { sections } = cutSections(answer, summary.facets, () => false)
    const chips = verify.flatMap(({ f }) => f.summary.split(/\s*[·、,，]\s*/)).filter(c => c !== '')
    const proof = verify.flatMap(({ i }) => (sections[i] ?? '').split('\n'))
      .map(l => l.replace(/^\s*[-*]\s+|`/g, '').trim()).filter(l => l !== '' && !l.startsWith('```'))
    await update($, evidenceAtom, () => ({ chips, proof, age: 0 }))
  } else {
    await update($, evidenceAtom, ev => (ev ? { ...ev, age: ev.age + 1 } : null))
  }
  $.ui.invalidate('ui.render')
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
                  <Button key={`pane-pick-${n}-${o.key}`} plain label={clip(hotkey ? o.label : `${letter}: ${o.label}`, 24)} {...(hotkey ? { hotkey } : {})} {...(picked !== undefined && picked !== o.key ? { dimColor: true } : {})} onPress={() => pick($, pending.id, n, o.key, total)} />
                  {d.recommended === o.key && picked === undefined ? <Text color={YELLOW}>{T.recommended}</Text> : null}
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
  sections.push({ title: T.needsYou(left + userNext.length), color: YELLOW, rows: need, max: 8 })

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
    title: T.running,
    color: DIM,
    rows: [
      ...agents.map(a => runningRow(`run-${a.id}`, T.subagent(a.description), a.startedAt)),
      ...(await read($, backgroundAtom)).map((b, i) => runningRow(`bg-${i}`, T.background(b), undefined)),
    ],
    max: 5,
  })

  // 任務 完成數/總數：✓ 完成（灰）、▸ 下一項（亮）、○ 還沒做（灰）。
  // 來源：引擎的 TaskCreated／TaskCompleted（摘錄只取回覆原句，沒有步驟清單）
  const tasks = await read($, tasksAtom)
  const current = tasks.findIndex(t => !t.done)
  sections.push({
    title: T.tasks(tasks.filter(t => t.done).length, tasks.length),
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
    title: evidence && evidence.age > 0 ? T.evidenceAge(evidence.age) : T.evidence,
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
      ...(proof.length > 4 ? [<Text key="proof-more" color={DIM}>{T.moreProof(proof.length - 4)}</Text>] : []),
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
    title: T.changes,
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
          <Box width={pathWidth}><Text color={DIM}>{clip(`${top}${T.notThisTime}`, pathWidth - 1)}</Text></Box>
          <Text color={DIM}>{T.files(n)}</Text>
        </Box>
      )),
    ],
    max: 6,
  })

  const shown = sections.filter(sec => sec.rows.length > 0)
  if (shown.length === 0) return <Text color={DIM}>{T.nothing}</Text>
  return (
    <Box flexDirection="column">
      {shown.map(sec => (
        <Box key={`sec-${sec.title}`} flexDirection="column" marginBottom={1}>
          <Text color={sec.color} bold={sec.color === YELLOW}>{sec.title}</Text>
          {sec.rows.length > sec.max ? [...sec.rows.slice(0, sec.max - 1), <Text key="more" color={DIM}>{T.more(sec.rows.length - sec.max + 1)}</Text>] : sec.rows}
        </Box>
      ))}
    </Box>
  )
}

// 證據小標籤的符號：摘要裡已經有 ✓／✗／– 就拿來用；寫了「未」「沒」的當成還沒驗
function chipOf(text: string): { glyph: string; color: string; text: string } {
  const bare = text.replace(/[✓✔✗✘]/g, '').trim()
  if (/[✗✘]|fail|失敗/i.test(text)) return { glyph: '✗', color: RED, text: bare }
  if (/未|沒|–|待|\bnot\b|pending|skipped/i.test(text) && !/[✓✔]/.test(text)) return { glyph: '○', color: DIM, text: bare }
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
        // agent.spawn 先記下的還沒有結論框：補上這一輪的
        out[at] = { ...known, ...(known.status in TASK_MARKS ? {} : { status: a.status }), ...(known.card === undefined ? { card: card ?? '' } : {}) }
      } else {
        // 第一次看到＝這一輪派的（之前每輪都記過）；子代理可能在這輪結束前就跑完（實機），所以不限還在跑的。
        // 沒有結論框的回合記成 card ''，只為了之後不再被算到別張框
        out.push({ id: a.id, type: a.type, description: a.description, status: a.status, card: card ?? '', startedAt: now })
      }
    }
    return out.slice(-KEEP_AGENTS)
  })
}

// 有子代理在跑時每 250ms 重畫一次：轉圈字形和已跑時間證明它還活著（使用者 2026-10-08 選轉圈）；都跑完就停
function startTick($: EngineInterface) {
  if (tick) return
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

// 結論框裡這一輪派出去的背景子代理：轉圈＋執行中 已跑時間；跑完照通知列的符號（✓ 完成、! 失敗、– 中止）
async function agentRows($: EngineInterface, e: RenderEvent, card: string) {
  const agents = (await read($, agentsAtom)).filter(a => a.card === card)
  const { Text } = $.ui.resolve(e)
  const now = await $.clock.now().catch(() => null)
  return agents.map(a => {
    const mark = TASK_MARKS[a.status] ?? { glyph: spin(), color: BLUE }
    const running = now !== null && a.startedAt !== undefined ? `${T.stateRunning} ${duration(now - a.startedAt)}` : T.stateRunning
    const state = a.status === 'completed' ? (a.durationMs !== undefined ? duration(a.durationMs) : T.stateDone) : a.status === 'failed' ? T.stateFailed : a.status === 'killed' ? T.stateKilled : running
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

// ASCII 圖：沒標語言（或 text）的程式碼區塊，內含框線字元或箭頭
// ```dot（或 graphviz）區塊也當成圖，標籤另附節點與邊數
const FIG_FENCE_RE = /^```([A-Za-z]*)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
// 純 ASCII 圖（output style 規定回覆裡的圖用 +--+、|--、`--）也要認得
const FIG_MARK_RE = /[─│┌┐└┘├┤┬┴┼╭╮╯╰═║]|[→←↑↓]|-->|<--|\+--|--\+|\|--|`--/
// 文字行：中文句讀或 Markdown 清單開頭。交接草稿這類文字常寫「A → B」，箭頭出現在句子裡不算圖（實機：整份草稿被畫成灰底圖）
const PROSE_RE = /[，。；！？]|^\s*(?:[-*]|\d+\.)\s/

// 至少 2 行帶圖記號、且占非空白行三成以上才算圖；文字行裡的記號不算
function isFigure(body: string): boolean {
  const lines = body.split('\n').filter(l => l.trim() !== '')
  const marked = lines.filter(l => FIG_MARK_RE.test(l) && !PROSE_RE.test(l)).length
  return marked >= 2 && marked * 10 >= lines.length * 3
}

type Part = { kind: 'text' | 'figure' | 'dot'; text: string }

// 正文依圖切段；沒有圖時回一段原文
function splitFigures(text: string): Part[] {
  const parts: Part[] = []
  let at = 0
  for (const m of text.matchAll(FIG_FENCE_RE)) {
    const lang = (m[1] ?? '').toLowerCase()
    const body = m[2] ?? ''
    const kind = lang === 'dot' || lang === 'graphviz' ? 'dot' : ['', 'text', 'txt'].includes(lang) && isFigure(body) ? 'figure' : null
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

// 表格的分隔列（|---|:--:|）：不是內容，不編號
const TABLE_RULE_RE = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/

// 摘錄的候選行：程式碼區塊外的非空白行（去掉前後空白），編號從 1 起；表格分隔列不算
function numberLines(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence && l !== '' && !TABLE_RULE_RE.test(l)) out.push(l)
  }
  return out
}

// 一則回覆的 key：正文去掉前後空白後的雜湊（turn.complete 的 answer 與 AssistantMessage 的 text 對得上）
function keyOf(text: string): string {
  return hash(text.trim())
}

function keepLast(all: Record<string, Excerpt>): Record<string, Excerpt> {
  return Object.fromEntries(Object.entries(all).slice(-KEEP_EXCERPTS))
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/

// 顯示用：拿掉清單符號、粗體、行內程式碼的反引號；表格列（| a | b |）的格子用 · 接起來，不留直線（實機：框裡出現整列 | 1 | … |）
function cleanLine(l: string): string {
  const row = /^\|(.*)\|$/.exec(l)
  const text = row ? (row[1] ?? '').split('|').map(c => c.trim()).filter(c => c !== '').join(' · ') : l
  return text.replace(/^(?:[-*>]|\d+\.)\s+/, '').replace(/\*\*|`/g, '').trim()
}

// 選項行：「選項 A：…」「A. …」「**A**）…」→ key＋標籤；認不出字母就照順序給 A、B…
function optionOf(line: string, n: number): Option {
  const text = cleanLine(line)
  const m = /^(?:選項\s*|option\s+)?([A-Za-z])\s*[.)）:：、]\s*(.+)$/i.exec(text)
  return m ? { key: (m[1] ?? '').toUpperCase(), label: m[2] ?? '' } : { key: String.fromCharCode(65 + n), label: text }
}

// 模型回的編號 → 結論框。結論、題目指錯（超出範圍、結論指到標題）才整份不收，回 null；
// 選項、推薦、你要做、之後我、段落指錯只丟那一項，框照畫（使用者 2026-10-12 選逐欄降級）
function buildSummary(lines: string[], raw: string): Summary | null {
  let d: Record<string, unknown>
  try {
    const json = /\{[\s\S]*\}/.exec(raw)?.[0] ?? ''
    d = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const at = (n: unknown): string | null => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= lines.length ? lines[n - 1] ?? null : null)
  const isHeading = (n: unknown) => HEADING_RE.test(at(n) ?? '')
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
  const outcome = at(d.outcome)
  if (outcome === null || isHeading(d.outcome)) return null
  const status = d.status === 'blocked' || d.status === 'partial' || d.status === 'done' ? d.status : undefined
  const items: Item[] = []
  for (const x of list(d.decisions)) {
    const q = x as Record<string, unknown>
    const question = at(q?.question)
    if (question === null) return null
    const opts = list(q?.options)
    // 選項有指錯的、指回題目那行、重複、或只有一個：當成沒列選項的開放題，只畫題目（實機：兩個選項都是題目那行，框裡 A、B 一模一樣）
    const choices = opts.length >= 2 && opts.every(o => at(o) !== null) && new Set(opts).size === opts.length && !opts.includes(q.question) ? opts : []
    const options = choices.map((o, i) => optionOf(at(o) ?? '', i))
    // 推薦常指到選項後面那句「我建議 A：…」（實測 haiku 約三成）：取那句第一個提到的選項字母；指到別行又認不出就不標推薦，不整份作廢
    let recommended: string | undefined
    if (q.recommended !== undefined && choices.length > 0) {
      const rec = choices.indexOf(q.recommended)
      if (rec >= 0) recommended = options[rec]?.key
      else {
        const keys = new Set(options.map(o => o.key))
        recommended = [...cleanLine(at(q.recommended) ?? '').matchAll(/(?<![A-Za-z])([A-Z])(?![A-Za-z])/g)].map(m => m[1] ?? '').find(k => keys.has(k))
      }
    }
    items.push({ kind: 'decision', text: cleanLine(question), options, ...(recommended !== undefined ? { recommended } : {}) })
  }
  for (const [field, kind] of [['todo', 'user-next'], ['next', 'agent-next']] as const) {
    // 跟結論或前面的項目同一句就不再列（實機：之後我把結論那句又列一次）
    for (const n of list(d[field])) {
      const line = at(n)
      if (line === null) continue
      const text = cleanLine(line)
      if (text !== cleanLine(outcome) && !items.some(i => i.text === text)) items.push({ kind, text })
    }
  }
  const facets: Facet[] = []
  for (const x of list(d.sections)) {
    const sec = x as Record<string, unknown>
    const h = typeof sec?.heading === 'number' ? sec.heading : -1
    const m = HEADING_RE.exec(at(h) ?? '')
    if (!m) continue
    // 摘要行要在這段裡：標題之後、下一個同級或更高的標題之前，本身不是標題
    const level = m[1]?.length ?? 1
    let end = lines.length
    for (let i = h; i < lines.length; i++) {
      const next = HEADING_RE.exec(lines[i] ?? '')
      if (next && (next[1]?.length ?? 7) <= level) {
        end = i
        break
      }
    }
    const s = sec.summary
    if (typeof s !== 'number' || s <= h || s > end || isHeading(s)) continue
    const heading = m[2] ?? ''
    facets.push({ label: clip(norm(heading), 16), summary: clip(cleanLine(at(s) ?? ''), 60), heading })
  }
  return { ...(status ? { status } : {}), outcome: clip(cleanLine(outcome), 80), items, facets }
}

// 要使用者選的題目（有選項的 decision）；題號就是在這個陣列裡的位置
function decisionsOf(items: Item[]): Item[] {
  return items.filter(i => i.kind === 'decision' && (i.options?.length ?? 0) > 0)
}

// 等你決定＞卡住＞等你動手＞部分完成＞完成。照模型標的狀態走：完成、卡住不因附了「你要做」變黃（使用者實機：幾乎每個框都黃）；
// 只有做到一半停下來等你才是等你動手（實機 s3 原本標成進行中，兩個評審都誤判成還在跑）
function glyphOf(s: Summary): string {
  if (s.items.some(i => i.kind === 'decision')) return '?'
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
  const heading = text.split('\n').map(l => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l)?.[1]).find(h => h !== undefined && /決定|decision|choose|choice/i.test(h) && !taken.has(norm(h)))
  return heading === undefined ? facets : [...facets, { label: T.optionsLabel, summary: T.optionsSummary, heading }]
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
        <Text color={BRIGHT}>{isOpen ? `${f.summary}${T.backInReply}` : f.summary}</Text>
      </Box>
    )
  })
}

// 待你決定的題目（選項按鈕）、你要做的事（黃）、之後我接著做的事（灰）
async function itemRows($: EngineInterface, e: RenderEvent, id: string, items: Item[], room: number) {
  const answers = (await read($, answersAtom))[id] ?? {}
  const { Box, Button, Text } = $.ui.resolve(e)
  const decisions = decisionsOf(items)
  const asks = items.filter(i => i.kind === 'decision' && !decisions.includes(i))
  const others = items.filter(i => i.kind !== 'decision')
  const questions = decisions.map((d, n) => (
    <Box key={`q-${n}`} flexDirection="column" marginTop={n === 0 ? 1 : 0}>
      <Text>
        <Text color={YELLOW} bold>{'? '}</Text>
        <Text color={BRIGHT}>{decisions.length > 1 ? `${n + 1}. ${d.text}` : d.text}</Text>
      </Text>
      {/* 一個選項一行、標籤不截斷，長的照框寬換行（實機：並排時每個選項只剩十來個字） */}
      <Box flexDirection="column" marginLeft={2}>
        {(d.options ?? []).map(o => {
          const picked = answers[n] === o.key
          return (
            <Box key={`opt-${n}-${o.key}`} flexDirection="row">
              <Button key={`pick-${n}-${o.key}`} plain label={`${picked ? '●' : ' '}${o.key}`} onPress={() => pick($, id, n, o.key, decisions.length)} />
              {/* 自己按欄寬斷行：引擎只在空白處換行，中文長句會整段跳到下一行（實機） */}
              <Box flexDirection="column">
                {wrapCols(o.label, room).flatMap((l, i, all) =>
                  // 推薦標記接在最後一行；那行放不下就自己換一行
                  d.recommended === o.key && i === all.length - 1 && cols(l) + cols(T.recommended) > room ? [l, ''] : [l],
                ).map((l, i, all) => (
                  <Text key={`opt-${n}-${o.key}-${i}`}>
                    {` ${l}`}
                    {d.recommended === o.key && i === all.length - 1 ? <Text color={YELLOW}>{T.recommended}</Text> : null}
                  </Text>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  ))
  // 沒列選項的開放題：只畫題目，回答直接打字
  for (const [i, a] of asks.entries()) {
    questions.push(
      <Box key={`ask-${i}`} marginTop={questions.length === 0 ? 1 : 0}>
        <Text>
          <Text color={YELLOW} bold>{'? '}</Text>
          <Text color={BRIGHT}>{a.text}</Text>
        </Text>
      </Box>,
    )
  }
  // 符號換成字（評審：> 和 ~ 第一次看不懂）；你要做的排在結論下第一行，之後我排最後
  const todo = others.filter(o => o.kind === 'user-next').map((o, i) => (
    <Text key={`todo-${i}`}>
      <Text color={YELLOW} bold>{T.youDo}</Text>
      <Text>{o.text}</Text>
    </Text>
  ))
  const later = others.filter(o => o.kind !== 'user-next').map((o, i) => (
    <Text key={`later-${i}`} color={DIM}>{`${T.thenI}${o.text}`}</Text>
  ))
  return { todo, questions, later }
}

// 記下這題的答案，把這張卡已選的答案依題號排好填進提示框（取代草稿）
async function pick($: EngineInterface, id: string, n: number, key: string, total: number) {
  const all = await update($, answersAtom, a => ({ ...a, [id]: { ...(a[id] ?? {}), [n]: key } }))
  const mine = all[id] ?? {}
  const draft = Object.keys(mine).map(Number).sort((a, b) => a - b).map(i => (total > 1 ? `${i + 1}. ${mine[i]}` : `${mine[i]}`)).join('  ')
  const filled = await $.prompt.fill({ text: draft })
  if (!filled.isFilled) $.ui.toast(T.notFilled(filled.refusal), { timeoutMs: 4000 })
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

// 終端欄寬：中日韓字與全形字 2 欄，其他 1 欄（範圍同 your-turn）
function charCols(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
  return isWide ? 2 : 1
}

function cols(s: string): number {
  let n = 0
  for (const ch of s) n += charCols(ch)
  return n
}

// 按顯示欄寬（中文算 2）切成多行，不管空白在哪
function wrapCols(s: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let used = 0
  for (const ch of s) {
    const w = charCols(ch)
    if (used + w > width && line !== '') {
      lines.push(line)
      line = ''
      used = 0
    }
    line += ch
    used += w
  }
  return [...lines, line]
}

// 超過 width 欄才截斷，最後一欄換成 …；剛好放得下的照原樣
function clip(s: string, width: number): string {
  if (cols(s) <= width) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = charCols(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}
