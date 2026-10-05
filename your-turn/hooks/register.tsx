import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Step } from '../types'

// your-turn：主對話每輪結束時，從最後一則回覆（turn.complete 的 answer）抽出要你親手跑的指令：
// 程式碼區塊裡 sudo 開頭的行（行尾 \ 接下一行）、`! <cmd>`（行內 code 或區塊裡的行）。
// 抽到指令就重算清單、打開對話旁的 pane（主動打開：終端機 ≥144 欄才畫，你用 /your-turn 開過一次後降到 110 欄；
// 沒畫出來就跳 toast 提示打 /your-turn；提示框是空的才拿得到焦點）。
// pane 有焦點時按數字鍵勾完成；全部勾完出現「回報」，按下替你送出「N/N 完成了」。mod 只整理清單，不代跑任何指令。

const PANE = 'your-turn'
const TITLE = '要你跑的指令'
// Button 的 hotkey 只收一個數字：前 9 條有數字鍵，第 10 條起只能用滑鼠點
const MAX_KEYS = 9

// powerline 樣式：標題、分組、底部狀態都是色塊段，段與段之間用  接起來；指令列前有 $ 或 !。
// 用 ctx-relay 沒用到的兩個色盲友善色（Okabe-Ito）：紫紅＝強調、藍綠＝提示字元與完成；做完的指令刪除線＋淡色
const PURPLE = '#CC79A7'
const GREEN = '#009E73'
const SLATE = '#3a3f4b'
const DARK = '#1d1f21'
const LIGHT = '#f5f7fa'
const SEP = '' // Nerd Font powerline 實心右三角
// 每列：引擎畫的「1: 」3 欄＋○／✔＋空白＋「$ 」2 欄
const ROW_FIXED = 7
// 分組：sudo 要密碼，在終端機跑；! 開頭的在 Claude 的提示框打
const GROUPS = [
  { icon: '', title: '在終端機跑（要密碼）', has: (cmd: string) => !cmd.startsWith('!') }, // nf-fa-terminal
  { icon: '', title: '在提示框打', has: (cmd: string) => cmd.startsWith('!') }, // nf-fa-comment
] as const

// powerline 的一段：底色、字色、字
type Seg = { bg: string; fg: string; text: string }

const stepsAtom = atom({ plugin: 'your-turn', key: 'steps' } as const, [] as Step[])

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
    // 照分組排：編號就是畫面由上而下的順序，同組內照回覆裡出現的順序
    const ordered = GROUPS.flatMap(g => cmds.filter(g.has))
    await update($, stepsAtom, () => ordered.map(cmd => ({ cmd, isDone: false })))
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
    // 一行 powerline：每段 ` 字 ` 塗底色，段尾的  字色＝這段底色、底色＝下一段底色（最後一段後面不塗底）
    const powerline = (segs: Seg[]) => (
      <Text>
        {segs.flatMap((s, i) => [
          <Text color={s.fg} backgroundColor={s.bg} bold>{` ${s.text} `}</Text>,
          <Text color={s.bg} backgroundColor={segs[i + 1]?.bg}>{SEP}</Text>,
        ])}
      </Text>
    )
    const header = powerline([
      { bg: PURPLE, fg: DARK, text: 'your-turn' },
      { bg: SLATE, fg: LIGHT, text: steps.length === 0 ? '沒有要你跑的指令' : `${steps.length} 條指令待你親手跑` },
    ])
    if (steps.length === 0) {
      return <Box flexDirection="column">{header}</Box>
    }
    const room = Math.max(10, e.props.bodyColumns - ROW_FIXED)
    const done = steps.filter(s => s.isDone).length
    const isAllDone = done === steps.length
    // 按鈕只放編號與 ○／✔（按鈕文字不能加刪除線）；指令另用 Text 畫，做完加刪除線
    const row = (s: Step, i: number) => {
      const isBang = s.cmd.startsWith('!')
      const body = clip(isBang ? s.cmd.slice(1).trimStart() : s.cmd, room)
      const mark = s.isDone ? '✔' : '○'
      const press = () => toggle($, i)
      return (
        <Box key={`row-${i + 1}`} flexDirection="row">
          {i < MAX_KEYS
            ? <Button key={`step-${i + 1}`} plain hotkey={String(i + 1)} label={mark} dimColor={s.isDone} onPress={press} />
            : <Button key={`step-${i + 1}`} plain label={`${i + 1}: ${mark}`} dimColor={s.isDone} onPress={press} />}
          <Text color={GREEN} dimColor={s.isDone}>{isBang ? ' ! ' : ' $ '}</Text>
          <Text dimColor={s.isDone} strikethrough={s.isDone}>{body}</Text>
        </Box>
      )
    }
    // 每組一段 powerline 標題接該組的列；沒有指令的組不畫
    const groups = GROUPS.flatMap(g => {
      const members = steps.flatMap((s, i) => (g.has(s.cmd) ? [row(s, i)] : []))
      return members.length === 0 ? [] : [powerline([{ bg: SLATE, fg: LIGHT, text: `${g.icon} ${g.title}` }]), ...members]
    })
    const hint = isAllDone
      ? '全部完成，按「回報」告訴 Claude'
      : e.props.isFocused ? `按 1–${Math.min(MAX_KEYS, steps.length)} 勾選，再按一次取消` : 'ctrl+x tab 切過來再按數字鍵'
    return (
      <Box flexDirection="column">
        {header}
        {groups}
        {powerline([
          { bg: isAllDone ? GREEN : PURPLE, fg: isAllDone ? LIGHT : DARK, text: `${done}/${steps.length} 完成` },
          { bg: SLATE, fg: LIGHT, text: hint },
        ])}
        {isAllDone && (
          <Button key="report" variant="primary" label={`回報 ${steps.length}/${steps.length} 完成`} onPress={() => report($, steps.length)} />
        )}
      </Box>
    )
  })
}

// 回覆裡要你親手跑的指令，照出現順序、去重複
function extractCommands(text: string): string[] {
  const cmds: string[] = []
  let inBlock = false
  // 區塊裡行尾 \ 的指令：先接起來，到沒有 \ 的那行才收
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inBlock = !inBlock
      pending = ''
      continue
    }
    if (inBlock) {
      if (pending !== '') {
        pending = `${pending} ${line.replace(/\\$/, '').trim()}`
        if (!line.endsWith('\\')) {
          cmds.push(pending)
          pending = ''
        }
        continue
      }
      // 照抄提示字元的寫法（$ sudo …）也算
      const cmd = /^(?:\$\s+)?(sudo\s.+|!\s+\S.*)$/.exec(line)?.[1]
      if (cmd === undefined || (cmd.startsWith('!') && isPlaceholder(cmd))) continue
      if (cmd.endsWith('\\')) pending = cmd.slice(0, -1).trim()
      else cmds.push(cmd)
      continue
    }
    // `!` 後面要有空白：`!e.agentId`、`!==` 這類程式碼不算
    for (const m of line.matchAll(/`(!\s+[^`]+)`/g)) {
      const cmd = (m[1] ?? '').trim()
      if (!isPlaceholder(cmd)) cmds.push(cmd)
    }
  }
  return [...new Set(cmds)]
}

// 說明用的佔位寫法（`! <cmd>`）不是真的指令；sudo 區塊裡的 <佔位> 仍算（要你填好再跑）
function isPlaceholder(cmd: string): boolean {
  return /<[^>]+>/.test(cmd)
}

async function toggle($: EngineInterface, i: number) {
  await update($, stepsAtom, list => list.map((s, j) => (j === i ? { ...s, isDone: !s.isDone } : s)))
}

async function report($: EngineInterface, total: number) {
  try {
    const sent = await $.prompt.submit({ text: `${total}/${total} 完成了`, asUser: true })
    if (sent.drop !== undefined) $.ui.log(`[your-turn] 回報被擋：${sent.drop}`)
  } catch (err) {
    $.ui.log(`[your-turn] 回報送出失敗：${String(err)}`)
  }
}

function clip(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`
}
