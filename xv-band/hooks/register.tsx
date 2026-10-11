import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Band, Row } from '../types'

// xv 的 job 目錄：${XV_DATA:-$HOME/.local/share/xvendor}/jobs/<job-id>/（唯讀，這個 mod 從不寫那裡）
const TICK_MS = 2000
// 結束後還留在 band 上的時間（看 meta.json 的 mtime）
const RECENT_MS = 10 * 60_000
const MAX_ROWS = 5
// 結束的 job 最多畫幾行，其餘收成「另有 N 個已完成」
const MAX_FINISHED = 2
// 只讀 events.jsonl 最後這麼多 bytes
const TAIL_BYTES = 16 * 1024

const bandAtom = atom({ plugin: 'xv-band', key: 'band' } as const, { rows: [], more: 0 } as Band)

const STATUS_LABEL: Record<string, string> = { running: '跑中', done: '完成', failed: '失敗', timeout: '逾時', stopped: '已停止' }
const STATUS_COLOR: Record<string, string> = { running: 'warning', failed: 'error', timeout: 'error', stopped: 'inactive' }
const VENDOR_COLOR: Record<string, string> = { codex: 'success', agy: 'suggestion' }
const SPINNER = ['|', '/', '-', '\\']

type Meta = {
  vendor?: unknown
  round?: unknown
  status?: unknown
  secs?: unknown
  round_started?: unknown
  profile?: unknown
}

// 模組變數：reload 會歸零，只是快取
let timer: Timer | null = null
let isBusy = false
let lastJson = '[]'
const metaCache = new Map<string, { mtimeMs: number; meta: Meta }>()
const eventsCache = new Map<string, { size: number; mtimeMs: number; activity: string }>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    timer?.cancel()
    const root = await dataRoot($)
    $.clock.after(0, () => void refresh($, root))
    timer = $.clock.every(TICK_MS, () => void refresh($, root))
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { rows, more } = await read($, bandAtom)
    if (rows.length === 0 && more === 0) return next(e)
    // band 只有一個：先讓排在下面的 mod 畫，自己疊在它下面
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns)
    const whoWidth = Math.max(0, ...rows.map(r => width(who(r))))
    return (
      <Box flexDirection="column">
        {below}
        {rows.map(row => {
          const p = rowParts(row, columns, whoWidth)
          return (
            <Text key={`row-${row.id}`} dimColor={row.status === 'done'}>
              {p.spin} <Text color={VENDOR_COLOR[row.vendor]} bold>{p.who}</Text>  {p.id}  <Text color={STATUS_COLOR[row.status]}>{p.status}</Text> {p.elapsed}
              {p.activity ? <Text dimColor>  {p.activity}</Text> : null}
            </Text>
          )
        })}
        {more > 0 ? <Text key="more" dimColor>  另有 {more} 個已完成（xv list）</Text> : null}
      </Box>
    )
  })
}

async function dataRoot($: EngineInterface): Promise<string> {
  const custom = await $.env.get('XV_DATA')
  if (custom) return custom.replace(/\/+$/, '')
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.local/share/xvendor`
}

async function refresh($: EngineInterface, root: string): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const band = await scan($, root)
    const json = JSON.stringify(band)
    if (json === lastJson) return
    lastJson = json
    await update($, bandAtom, () => band)
  } catch {
    // 永不丟出：下一輪再試
  } finally {
    isBusy = false
  }
}

async function scan($: EngineInterface, root: string): Promise<Band> {
  const jobsDir = `${root}/jobs`
  const entries = await $.fs.list(jobsDir).catch(() => [])
  const now = await $.clock.now()
  const found: { row: Row; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const job = await jobRow($, `${jobsDir}/${entry.name}`, entry.name, now).catch(() => null)
    if (job) found.push(job)
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const running = found.filter(f => f.row.status === 'running').slice(0, MAX_ROWS).map(f => f.row)
  const finished = found.filter(f => f.row.status !== 'running').map(f => f.row)
  const shown = finished.slice(0, Math.min(MAX_FINISHED, MAX_ROWS - running.length))
  return { rows: [...running, ...shown], more: finished.length - shown.length }
}

async function jobRow($: EngineInterface, dir: string, id: string, now: number): Promise<{ row: Row; mtimeMs: number } | null> {
  const metaPath = `${dir}/meta.json`
  const st = await $.fs.stat(metaPath)
  let cached = metaCache.get(id)
  if (!cached || cached.mtimeMs !== st.mtimeMs) {
    const parsed: unknown = JSON.parse(await $.fs.read(metaPath))
    if (!parsed || typeof parsed !== 'object') return null
    cached = { mtimeMs: st.mtimeMs, meta: parsed as Meta }
    metaCache.set(id, cached)
  }
  const meta = cached.meta
  const status = typeof meta.status === 'string' ? meta.status : ''
  const round = typeof meta.round === 'number' ? meta.round : 0
  const vendor = typeof meta.vendor === 'string' ? meta.vendor : '?'
  if (!status) return null
  const isRunning = status === 'running'
  if (!isRunning && now - st.mtimeMs > RECENT_MS) return null
  let elapsed: number | null = null
  let activity = ''
  if (isRunning) {
    if (typeof meta.round_started === 'number') elapsed = Math.max(0, Math.floor(now / 1000 - meta.round_started))
    activity = await lastActivity($, `${dir}/round-${round}/events.jsonl`, vendor).catch(() => '')
  } else if (typeof meta.secs === 'number') {
    elapsed = meta.secs
  }
  const profile = typeof meta.profile === 'string' && meta.profile ? meta.profile : null
  return { row: { id, vendor, profile, round, status, elapsed, activity }, mtimeMs: st.mtimeMs }
}

async function lastActivity($: EngineInterface, path: string, vendor: string): Promise<string> {
  const st = await $.fs.stat(path)
  const cached = eventsCache.get(path)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.activity
  let text: string
  let isCut = false
  if (st.size <= TAIL_BYTES) {
    text = await $.fs.read(path)
  } else {
    // $.fs.read 沒有 offset：用 tail 只讀尾端，不把整個檔案搬進來
    const out = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 5000 })
    if (out.exitCode !== 0) return ''
    text = out.stdout
    isCut = true
  }
  const activity = activityOf(vendor, text, isCut)
  eventsCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, activity })
  return activity
}

// 從尾端往回找最近一個有意義的事件；寫到一半的最後一行、讀尾端切斷的第一行都會 parse 失敗而略過
export function activityOf(vendor: string, text: string, isCut: boolean): string {
  const lines = text.split('\n')
  if (isCut) lines.shift()
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(lines[i] ?? '')
      if (!parsed || typeof parsed !== 'object') continue
      ev = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (vendor === 'agy') {
      const step = ev.event === 'step_update' ? (ev.step_update as Record<string, unknown> | undefined) : undefined
      if (!step || typeof step !== 'object') continue
      if (step.step_type === 'tool' && typeof step.tool_name === 'string') return `工具 ${oneLine(step.tool_name)}`
      if (step.step_type === 'agent_response') return '撰寫回答'
      continue
    }
    const item = ev.item as Record<string, unknown> | undefined
    if (!item || typeof item !== 'object') continue
    if (item.type === 'command_execution' && typeof item.command === 'string') return `執行 ${unwrapShell(oneLine(item.command))}`
    if (item.type === 'agent_message' && ev.type === 'item.completed' && typeof item.text === 'string') {
      return `回報 ${oneLine(item.text.trim().split('\n')[0] ?? '')}`
    }
  }
  return ''
}

function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function formatElapsed(secs: number | null): string {
  if (secs === null) return '-'
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m${String(s).padStart(2, '0')}s`
}

// codex 的指令包在 /bin/bash -lc '…' 裡，只留裡面那段
function unwrapShell(s: string): string {
  const m = /^\/bin\/(?:ba)?sh -lc (['"])(.*?)\1?$/.exec(s)
  return m ? (m[2] ?? s) : s
}

function who(row: Row): string {
  return row.profile ? `${row.vendor}:${row.profile}` : row.vendor
}

// 一行拆成幾段（各自上色）；欄位對齊：廠商補到 whoWidth、狀態補到 6 欄、耗時補到 6 欄，
// 最近動作吃剩下的寬度，放不下就不畫
export function rowParts(row: Row, columns: number, whoWidth: number) {
  const spin = row.status === 'running' ? (SPINNER[Math.floor((row.elapsed ?? 0) / 2) % SPINNER.length] ?? '|') : ' '
  const parts = {
    spin,
    who: pad(who(row), whoWidth),
    id: `${row.id.slice(-4)} r${row.round}`,
    status: pad(STATUS_LABEL[row.status] ?? row.status, 6),
    elapsed: pad(formatElapsed(row.elapsed), 6),
    activity: '',
  }
  const used = width(`${parts.spin} ${parts.who}  ${parts.id}  ${parts.status} ${parts.elapsed}  `)
  if (row.activity && columns - used >= 4) parts.activity = fit(row.activity, columns - used)
  // 沒有動作接在後面時不補空白，行尾不留空格
  if (!parts.activity) parts.elapsed = formatElapsed(row.elapsed)
  return parts
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - width(s)))
}

// 終端機欄寬：中日韓全形算 2 欄
function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
  return isWide ? 2 : 1
}

function width(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

function fit(s: string, max: number): string {
  if (width(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > max - 3) break
    out += ch
    w += cw
  }
  return `${out}...`
}
