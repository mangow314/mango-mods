import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Step } from '../types'

// your-turn：主對話每輪結束時，從最後一則回覆（turn.complete 的 answer）抽出要你親手跑的指令：
// 程式碼區塊裡 sudo 開頭的行（行尾 \ 接下一行）、`! <cmd>`（行內 code 或區塊裡的行）；
// 前一句有「你／手動／自己／親手／在終端機／另開」的 shell 區塊，整塊每行都算。
// 清單照回覆裡出現的順序編號，不重排；連續在同一處跑的指令同一框，換地方跑就開新框。
// 每段指令（一個程式碼區塊，或一行裡的行內 `! cmd`）上方帶回覆裡的前一句當說明（等多久、等什麼再跑）。
// 抽到指令就重算清單、打開對話旁的 pane（主動打開：終端機 ≥144 欄才畫，你用 /your-turn 開過一次後降到 110 欄；
// 沒畫出來就跳 toast 提示打 /your-turn；提示框是空的才拿得到焦點）。
// pane 有焦點時按數字鍵勾完成、按 q 關掉；按 y 再按編號，把那條指令複製到剪貼簿（指令太長、pane 顯示不完時用）。
// 全部勾完出現「回報」，按下替你送出「N/N 完成了」。mod 只整理清單，不代跑任何指令。

const PANE = 'your-turn'
const TITLE = '要你跑的指令'
// Button 的 hotkey 只收一個數字或小寫字母：前 9 條有數字鍵，第 10 條起只能用滑鼠點
const MAX_KEYS = 9

// TUI 面板樣式（學 lazygit／btop）：連續在同一處跑的指令一個圓角框，標題嵌在上框線；底部是進度條加 lazygit 式按鍵列。
// 框線自己用 Text 畫：Box 的 border 會蓋在子元素上面，標題疊不上去（2026-10-05 實測）
// 配色和終端機一致，用 Gruvbox Dark Hard（morhetz/gruvbox）的 bright 色：黃＝在終端機跑、水綠＝在提示框打、綠＝完成。
// 框裡還有沒做完的指令時框線用該組顏色，全做完變深灰；做完的指令刪除線＋淡色
const YELLOW = '#fabd2f'
const AQUA = '#8ec07c'
const GREEN = '#b8bb26'
const GRAY = '#928374'
const DARK_GRAY = '#504945'
const TRACK = '━' // U+2501 進度條：做完的塗綠、其餘塗深灰
// 每列：「│ 」與「 │」4 欄＋引擎畫的「1: 」3 欄＋○／✔＋空白＋「$ 」2 欄
const ROW_FIXED = 11
// 進度條最長 16 格；同一行另有「進度 」和「 10/10」，約 12 欄
const TRACK_MAX = 16
const FOOT_FIXED = 12
// 說明行：「│ 」與「 │」4 欄＋縮排 2 欄
const NOTE_FIXED = 6
// 分組：sudo 和其他要你另開終端機的指令在終端機跑；! 開頭的在 Claude 的提示框打
const GROUPS = [
  { icon: '', color: YELLOW, title: '在終端機跑', has: (cmd: string) => !cmd.startsWith('!') }, // nf-fa-terminal
  { icon: '', color: AQUA, title: '在提示框打', has: (cmd: string) => cmd.startsWith('!') }, // nf-fa-comment
] as const

const stepsAtom = atom({ plugin: 'your-turn', key: 'steps' } as const, [] as Step[])
// 按了 y、等你按編號：這時按編號是複製，不是勾選（像 vim 的 y3）
const yankAtom = atom({ plugin: 'your-turn', key: 'yank' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 名稱衝突會丟例外，包住免得中斷 hook
    try {
      await $.command.register({ name: 'your-turn', description: 'your-turn：打開要你親手跑的指令清單' })
    } catch (err) {
      $.ui.log(`[your-turn] 註冊 /your-turn 失敗：${String(err)}`)
    }
    return result
  })

  // 你打的指令＝asked：任何寬度都畫
  on('command.run', { command: 'your-turn' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: '[your-turn] 已打開清單' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      return result
    }
    const cmds = extractCommands(e.answer)
    // 這則回覆沒有新指令：清單不動
    if (cmds.length === 0) {
      return result
    }
    // 照回覆裡出現的順序編號，不按分組重排：前後常有依賴（先裝套件才能啟動服務）
    await update($, stepsAtom, () => cmds.map(c => ({ ...c, isDone: false })))
    await update($, yankAtom, () => false)
    try {
      const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
      if (!opened.isPlaced) $.ui.toast(`your-turn：${cmds.length} 條要你親手跑的指令，終端機太窄沒畫出來，打 /your-turn 打開`, { timeoutMs: 8000 })
    } catch (err) {
      $.ui.log(`[your-turn] 打開 pane 失敗：${String(err)}`)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const steps = await read($, stepsAtom)
    const isYanking = await read($, yankAtom)
    // 和 away-receipt 一樣按 q 關；引擎內建的 ctrl+x x 要按兩個鍵。清單空的時候也要有，不然 q 沒作用
    const close = <Button key="close" plain hotkey="q" label="關閉" onPress={() => $.ui.close({ id: PANE })} />
    // 標題是一般文字，不用色塊
    const header = (
      <Text>
        <Text bold>your-turn</Text>
        <Text color={GRAY}>{`  ${steps.length === 0 ? '沒有要你跑的指令' : `${steps.length} 條指令待你親手跑`}`}</Text>
      </Text>
    )
    if (steps.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Box marginTop={1}>{close}</Box>
        </Box>
      )
    }
    const width = e.props.bodyColumns
    const room = Math.max(10, width - ROW_FIXED)
    const done = steps.filter(s => s.isDone).length
    const isAllDone = done === steps.length
    // 按鈕只放編號與 ○／✔（按鈕文字不能加刪除線、也不能上色）；$／!、指令另用 Text 畫，做完的指令加刪除線。
    // 右框線前補空白，讓每列剛好 pane 寬
    const row = (s: Step, i: number, color: string, frame: string) => {
      const isBang = s.cmd.startsWith('!')
      const body = clip(isBang ? s.cmd.slice(1).trimStart() : s.cmd, room)
      const mark = s.isDone ? '✔' : '○'
      const label = i < MAX_KEYS ? mark : `${i + 1}: ${mark}`
      const keyCols = i < MAX_KEYS ? 3 : 0
      const pad = Math.max(0, width - 7 - keyCols - cols(label) - cols(body))
      const press = (p: UiPressArgument) => (isYanking ? yank($, s.cmd, i, p) : toggle($, i))
      return (
        <Box key={`row-${i + 1}`} flexDirection="row">
          <Text color={frame}>{'│ '}</Text>
          {i < MAX_KEYS
            ? <Button key={`step-${i + 1}`} plain hotkey={String(i + 1)} label={label} dimColor={s.isDone} onPress={press} />
            : <Button key={`step-${i + 1}`} plain label={label} dimColor={s.isDone} onPress={press} />}
          <Text color={color} bold dimColor={s.isDone}>{isBang ? ' ! ' : ' $ '}</Text>
          <Text dimColor={s.isDone} strikethrough={s.isDone}>{body}</Text>
          <Text color={frame}>{`${' '.repeat(pad)} │`}</Text>
        </Box>
      )
    }
    // 說明行：回覆裡這段指令的前一句，淡灰色、縮排 2 欄，太長截斷
    const noteLine = (note: string, i: number, frame: string) => {
      const body = clip(note, Math.max(10, width - NOTE_FIXED))
      return (
        <Box key={`note-${i + 1}`} flexDirection="row">
          <Text color={frame}>{'│   '}</Text>
          <Text color={GRAY}>{body}</Text>
          <Text color={frame}>{`${' '.repeat(Math.max(0, width - NOTE_FIXED - cols(body)))} │`}</Text>
        </Box>
      )
    }
    // 照清單順序切框：連續在同一處跑的指令放同一框，換地方跑就開新框，所以同一組可能出現兩個框。
    // 每框上方空一行，標題嵌在上框線；框裡還有沒做完的指令時框線用該組顏色
    const runs: { g: (typeof GROUPS)[number]; members: { s: Step; i: number }[] }[] = []
    steps.forEach((s, i) => {
      const g = GROUPS.find(x => x.has(s.cmd)) ?? GROUPS[0]
      const last = runs.at(-1)
      if (last?.g === g) last.members.push({ s, i })
      else runs.push({ g, members: [{ s, i }] })
    })
    const groups = runs.map(({ g, members }, n) => {
      const frame = members.some(m => !m.s.isDone) ? g.color : DARK_GRAY
      const title = ` ${g.icon} ${g.title} `
      return (
        <Box key={`box-${n}`} flexDirection="column" marginTop={1}>
          <Text>
            <Text color={frame}>{'╭─'}</Text>
            <Text color={g.color} bold>{title}</Text>
            <Text color={frame}>{`${'─'.repeat(Math.max(0, width - 3 - cols(title)))}╮`}</Text>
          </Text>
          {members.flatMap(m => [...(m.s.note ? [noteLine(m.s.note, m.i, frame)] : []), row(m.s, m.i, g.color, frame)])}
          <Text color={frame}>{`╰${'─'.repeat(Math.max(0, width - 2))}╯`}</Text>
        </Box>
      )
    })
    // 進度條跟著 pane 寬度縮，最長 16 格
    const track = Math.max(4, Math.min(TRACK_MAX, width - FOOT_FIXED))
    const filled = Math.round((done / steps.length) * track)
    // lazygit 式按鍵列：按鍵塗綠、說明用預設字色、項目之間用深灰 │ 隔開
    const key = (s: string) => <Text color={GREEN} bold>{s}</Text>
    const sep = <Text color={DARK_GRAY}>{' │ '}</Text>
    const range = `1–${Math.min(MAX_KEYS, steps.length)}`
    const keys = isYanking
      ? [key(range), ' 按編號複製那條指令']
      : isAllDone
        ? [key('回報'), ' 告訴 Claude 全部完成']
        : e.props.isFocused
          ? [key(range), ' 勾選', sep, key('再按一次'), ' 取消']
          : [key('ctrl+x tab'), ' 切過來', sep, key(range), ' 勾選']
    // 再按一次 y 取消複製模式
    const yankButton = <Button key="yank" plain hotkey="y" label={isYanking ? '取消複製' : '複製'} onPress={() => update($, yankAtom, v => !v)} />
    return (
      <Box flexDirection="column">
        {header}
        {groups}
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={GRAY}>進度 </Text>
            <Text color={GREEN}>{TRACK.repeat(filled)}</Text>
            <Text color={DARK_GRAY}>{TRACK.repeat(track - filled)}</Text>
            <Text color={isAllDone ? GREEN : GRAY}>{` ${done}/${steps.length}`}</Text>
          </Text>
          {/* 複製、關閉鈕接在按鍵列尾：引擎畫成「y: 複製」「q: 關閉」 */}
          <Box flexDirection="row">
            <Text>{keys}{sep}</Text>
            {yankButton}
            <Text>{sep}</Text>
            {close}
          </Box>
        </Box>
        {isAllDone && (
          <Button key="report" variant="primary" label={`回報 ${steps.length}/${steps.length} 完成`} onPress={() => report($, steps.length)} />
        )}
      </Box>
    )
  })
}

// 前一句有這些字的 shell 區塊，整塊每行都是要你跑的指令；
// 前一句以「我」開頭的不算（「我自己試了一下：」「我在終端機跑了：」是 Claude 說它做了什麼）
const HINT_RE = /你|手動|自己|親手|在終端機|另開/
const SELF_RE = /^(?:[-*]\s+|\d+\.\s+)?我/
// shell 區塊：``` 後面沒有語言標記，或是這幾種
const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console'])

// 回覆裡要你親手跑的指令，照出現順序；每段（一個程式碼區塊，或一行裡的行內 `! cmd`）的第一條帶前一句當 note。
// 同一條在後面的步驟再出現就再列一次（例如最後再 sudo -k 一次）；
// 緊接著重複的只留一條（「打 `! whoami`，看 `! whoami` 印出誰」）
function extractCommands(text: string): { cmd: string; note: string }[] {
  const found: { cmd: string; note: string }[] = []
  let inBlock = false
  let isHinted = false
  // 前一句：區塊外最近一行非空白的字；區塊結束就清掉，連續兩個區塊之間沒有字就不帶
  let lead = ''
  // 這一段還沒掛上的說明；和上一條掛出去的一樣就不重複（行內 `! cmd` 那行接著就是程式碼區塊時）
  let note = ''
  let lastNote = ''
  const startSegment = (s: string) => {
    note = s !== lastNote ? s : ''
  }
  const push = (cmd: string) => {
    found.push({ cmd, note })
    if (note !== '') lastNote = note
    note = ''
  }
  // 區塊裡行尾 \ 的指令：先接起來，到沒有 \ 的那行才收
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const fence = /^(?:```|~~~)\s*(\S*)/.exec(line)
    if (fence) {
      if (inBlock) {
        lead = ''
      } else {
        isHinted = SHELL_LANGS.has((fence[1] ?? '').toLowerCase()) && HINT_RE.test(lead) && !SELF_RE.test(lead)
        startSegment(lead)
      }
      inBlock = !inBlock
      pending = ''
      continue
    }
    if (inBlock) {
      if (pending !== '') {
        pending = `${pending} ${line.replace(/\\$/, '').trim()}`
        if (!line.endsWith('\\')) {
          push(pending)
          pending = ''
        }
        continue
      }
      // 照抄提示字元的寫法（$ sudo …）也算；有提示字的區塊每行都算，空行與 # 註解除外
      const cmd = isHinted
        ? (line === '' || line.startsWith('#') ? undefined : line.replace(/^\$\s+/, ''))
        : /^(?:\$\s+)?(sudo\s.+|!\s+\S.*)$/.exec(line)?.[1]
      if (cmd === undefined || (cmd.startsWith('!') && isPlaceholder(cmd))) continue
      if (cmd.endsWith('\\')) pending = cmd.slice(0, -1).trim()
      else push(cmd)
      continue
    }
    if (line === '') continue
    const plain = line.replace(/`|\*\*/g, '')
    // `!` 後面要有空白：`!e.agentId`、`!==` 這類程式碼不算
    const inline = [...line.matchAll(/`(!\s+[^`]+)`/g)].map(m => (m[1] ?? '').trim()).filter(cmd => !isPlaceholder(cmd))
    if (inline.length > 0) {
      startSegment(plain)
      for (const cmd of inline) push(cmd)
    }
    lead = plain
  }
  return found.filter((f, i) => f.cmd !== found[i - 1]?.cmd)
}

// 說明用的佔位寫法（`! <cmd>`）不是真的指令；sudo 區塊裡的 <佔位> 仍算（要你填好再跑）
function isPlaceholder(cmd: string): boolean {
  return /<[^>]+>/.test(cmd)
}

async function toggle($: EngineInterface, i: number) {
  await update($, stepsAtom, list => list.map((s, j) => (j === i ? { ...s, isDone: !s.isDone } : s)))
}

// 複製後回到勾選模式；複製本身看不到，用 toast 告訴你複製了哪條。! 開頭的連 ! 一起複製，貼到提示框就能跑
async function yank($: EngineInterface, cmd: string, i: number, p: UiPressArgument) {
  await update($, yankAtom, () => false)
  const copied = await $.ui.copy({ text: cmd, surface: p.surface })
  $.ui.toast(copied.isCopied ? `your-turn：已複製第 ${i + 1} 條` : `your-turn：沒有複製到（${copied.reason}）`, { timeoutMs: 4000 })
}

async function report($: EngineInterface, total: number) {
  try {
    const sent = await $.prompt.submit({ text: `${total}/${total} 完成了`, asUser: true })
    if (sent.drop !== undefined) $.ui.log(`[your-turn] 回報被擋：${sent.drop}`)
  } catch (err) {
    $.ui.log(`[your-turn] 回報送出失敗：${String(err)}`)
  }
}

// 超過 width 欄就截斷，最後一欄換成 …
function clip(s: string, width: number): string {
  if (cols(s) <= width) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = cols(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

// 終端機上的欄寬：中日韓字與全形字 2 欄，其他（含 Nerd Font 圖示、○、✔）1 欄
function cols(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const isWide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    n += isWide ? 2 : 1
  }
  return n
}
