import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/xv'
const NOW = 1_791_606_000_000

// 測試裡的檔案系統：路徑 → 內容與 mtime；tail 呼叫記下來
type World = { files: Map<string, { text: string; mtimeMs: number }>; tails: string[] }

function world(on: On): World {
  const w: World = { files: new Map(), tails: [] }
  // 引擎自己在 band 不畫任何東西
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => $$.ui.resolve(e).Box({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'XV_DATA' ? ROOT : undefined }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const names = new Set<string>()
    for (const p of w.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest.includes('/')) names.add(rest.slice(0, rest.indexOf('/')))
    }
    if (names.size === 0) throw new Error('ENOENT')
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: new TextEncoder().encode(f.text).length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const f = w.files.get(e.path)
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  })
  on('process.run', (_$, e) => {
    const [cmd, , n = '0', path = ''] = e.argv
    if (cmd !== 'tail') return { value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    w.tails.push(path)
    const text = w.files.get(path)?.text ?? ''
    return { value: { exitCode: 0, stdout: text.slice(-Number(n)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

type MetaIn = { vendor: string; round: number; status: string; secs?: number | null; round_started?: number; profile?: string | null }

function job(w: World, id: string, meta: MetaIn, ageMs: number, events: string[] = []) {
  w.files.set(`${ROOT}/jobs/${id}/meta.json`, { text: JSON.stringify(meta), mtimeMs: NOW - ageMs })
  w.files.set(`${ROOT}/jobs/${id}/round-${meta.round}/events.jsonl`, { text: events.join('\n'), mtimeMs: NOW - ageMs })
}

const codexCmd = (command: string) => JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command } })
const codexMsg = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })
const agyTool = (tool_name: string) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name } })
const agyText = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'x' } })

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  await clock.settle()
  return clock
}

async function band($: Engine, bodyColumns = 120): Promise<string[]> {
  const ui = await $.ui.mount({
    plugin: 'xv-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  // 每行是一個外層 Text，裡面的上色片段也是 Text：只留含「尾碼 r輪次」的整行與收合行
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(s => /\w{4} r\d+ {2}/.test(s) || s.startsWith('  另有'))
  await ui.unmount()
  return lines
}

test('執行中的 codex 顯示轉圈、中文狀態、耗時與拆掉 bash -lc 的指令；結束的 agy 顯示 secs，欄位對齊', async ($, on) => {
  const w = world(on)
  job(w, '20261010T040000Z-agy-d266', { vendor: 'agy', round: 2, status: 'done', secs: 31 }, 60_000)
  job(w, '20261010T041615Z-codex-4553', { vendor: 'codex', round: 1, status: 'running', round_started: NOW / 1000 - 723, profile: null }, 5_000, [
    codexMsg('先看看'),
    codexCmd("/bin/bash -lc 'rg -n foo src'"),
  ])
  await start($, on)
  expect(await band($)).toEqual([
    '/ codex  4553 r1  跑中   12m03s  執行 rg -n foo src',
    '  agy    d266 r2  完成   31s',
  ])
})

test('profile 接在廠商後並決定對齊寬度；agy 最新事件是 agent_response 時顯示撰寫回答，否則顯示工具名', async ($, on) => {
  const w = world(on)
  job(w, 'a-agy-0001', { vendor: 'agy', round: 1, status: 'running', round_started: NOW / 1000 - 45 }, 1_000, [agyTool('view_file'), agyText])
  job(w, 'b-agy-0002', { vendor: 'agy', round: 3, status: 'running', round_started: NOW / 1000 - 5 }, 2_000, [agyText, agyTool('grep_search')])
  job(w, 'c-codex-0003', { vendor: 'codex', round: 2, status: 'failed', secs: 6, profile: 'local' }, 3_000)
  await start($, on)
  expect(await band($)).toEqual([
    '- agy          0001 r1  跑中   45s     撰寫回答',
    '- agy          0002 r3  跑中   5s      工具 grep_search',
    '  codex:local  0003 r2  失敗   6s',
  ])
})

test('結束超過 10 分鐘的 job 不畫；沒有可畫的 job 時整條 band 交給下面', async ($, on) => {
  const w = world(on)
  job(w, 'old-codex-aaaa', { vendor: 'codex', round: 1, status: 'done', secs: 4 }, 10 * 60_000 + 1)
  job(w, 'old-agy-bbbb', { vendor: 'agy', round: 1, status: 'stopped', secs: 9 }, 11 * 60_000)
  await start($, on)
  expect(await band($)).toEqual([])
})

test('9 分 59 秒前結束的還在；過了 10 分鐘的下一輪刷新就消失', async ($, on) => {
  const w = world(on)
  job(w, 'x-codex-cccc', { vendor: 'codex', round: 1, status: 'timeout', secs: 1200 }, 9 * 60_000 + 59_000)
  const clock = await start($, on)
  expect(await band($)).toEqual(['  codex  cccc r1  逾時   20m00s'])
  await clock.advance(2_000)
  await clock.settle()
  expect(await band($)).toEqual([])
})

test('寫到一半的最後一行略過，改顯示前一個事件；只有第一行 agent_message 會顯示', async ($, on) => {
  const w = world(on)
  job(w, 'p-codex-dddd', { vendor: 'codex', round: 1, status: 'running', round_started: NOW / 1000 - 3 }, 1_000, [
    codexCmd('ls'),
    codexMsg('第一行結論\n第二行'),
    '{"type":"item.started","item":{"type":"command_exe',
  ])
  await start($, on)
  expect(await band($)).toEqual(['/ codex  dddd r1  跑中   3s      回報 第一行結論'])
})

test('events.jsonl 超過 16KB 時用 tail 只讀尾端，切斷的第一行不算', async ($, on) => {
  const w = world(on)
  const filler = Array.from({ length: 400 }, (_, i) => codexCmd(`echo ${'x'.repeat(40)} ${i}`))
  job(w, 'big-codex-eeee', { vendor: 'codex', round: 2, status: 'running', round_started: NOW / 1000 }, 1_000, [...filler, codexCmd('cargo test')])
  await start($, on)
  expect(w.tails).toEqual([`${ROOT}/jobs/big-codex-eeee/round-2/events.jsonl`])
  expect(await band($)).toEqual(['| codex  eeee r2  跑中   0s      執行 cargo test'])
})

test('執行中優先；結束的只畫最新 2 個，其餘收成一行；壞掉的 meta 跳過', async ($, on) => {
  const w = world(on)
  for (let i = 0; i < 5; i++) job(w, `d${i}-codex-f00${i}`, { vendor: 'codex', round: 1, status: 'done', secs: i }, (i + 1) * 1_000)
  job(w, 'r-codex-0r01', { vendor: 'codex', round: 1, status: 'running', round_started: NOW / 1000 - 1 }, 30_000)
  job(w, 'r-agy-0r02', { vendor: 'agy', round: 1, status: 'running', round_started: NOW / 1000 - 2 }, 20_000)
  w.files.set(`${ROOT}/jobs/broken-codex-9999/meta.json`, { text: '{"vendor":', mtimeMs: NOW })
  await start($, on)
  const lines = await band($)
  expect(lines.slice(0, 4).map(l => /(\w{4}) r\d/.exec(l)?.[1])).toEqual(['0r02', '0r01', 'f000', 'f001'])
  expect(lines.slice(4)).toEqual(['  另有 3 個已完成（xv list）'])
})

test('窄寬度時截斷最近動作，整行不超過寬度', async ($, on) => {
  const w = world(on)
  job(w, 'n-codex-1234', { vendor: 'codex', round: 1, status: 'running', round_started: NOW / 1000 - 7 }, 1_000, [codexCmd('x'.repeat(200))])
  await start($, on)
  const [line = ''] = await band($, 50)
  expect(line.length).toBeLessThanOrEqual(50)
  expect(line.startsWith('\\ codex  1234 r1  跑中   7s      執行 xxx')).toBe(true)
  expect(line.endsWith('...')).toBe(true)
})
