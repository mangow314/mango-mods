import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ORANGE = '#E69F00'
const HOME = '/home/u'
const CWD = '/work/app'

// 測試裡的 git：每個 repo 的分支、未 commit 檔、未 push 數、別的 worktree 數
type Repo = { branch: string; files: string[]; ahead: number; worktrees: number }
type World = { repos: Map<string, Repo>; gitCalls: string[][] }

function world(on: On, repos: Record<string, Partial<Repo>>): World {
  const w: World = {
    repos: new Map(Object.entries(repos).map(([root, r]) => [root, { branch: 'master', files: [], ahead: 0, worktrees: 0, ...r }])),
    gitCalls: [],
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // 引擎自己在 band 不畫任何東西：回一個空 Box
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => $$.ui.resolve(e).Box({}))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: HOME }))
  // 工具本身照常跑完；路徑含 FAIL 的回報錯誤
  on('tool.call', (_$, e) =>
    (JSON.stringify(e).includes('FAIL') ? { result: {}, isError: true, text: 'boom' } : { result: {} }) as never)
  on('process.run', (_$, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [cmd, , dir = '', sub, ...rest] = e.argv
    if (cmd !== 'git') return ok('', 127)
    w.gitCalls.push([dir, sub ?? '', ...rest])
    const root = [...w.repos.keys()].find(r => dir === r || dir.startsWith(`${r}/`))
    const repo = root === undefined ? undefined : w.repos.get(root)
    if (root === undefined || repo === undefined) return ok('', 128)
    if (sub === 'rev-parse') return ok(`${root}\n`)
    if (sub === 'status') {
      const ahead = repo.ahead > 0 ? ` [ahead ${repo.ahead}]` : ''
      return ok([`## ${repo.branch}...origin/${repo.branch}${ahead}`, ...repo.files, ''].join('\n'))
    }
    if (sub === 'worktree') {
      const paths = [root, ...Array.from({ length: repo.worktrees }, (_, i) => `${root}-wt${i}`)]
      return ok(paths.map(p => `worktree ${p}\nHEAD abc\nbranch refs/heads/x\n`).join('\n'))
    }
    return ok('', 1)
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

async function endTurn($: Engine) {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

async function band($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'repo-ledger',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 160, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  })
  const texts = await ui.findAll({ type: 'Text' })
  // 最外層那個 Text 是整行
  const line = texts.map(t => t.text).sort((a, b) => b.length - a.length)[0] ?? ''
  return { ui, line }
}

test('乾淨的 repo、本輪也沒改檔：整行不畫', async ($, on) => {
  world(on, { [CWD]: {} })
  await start($)
  expect((await band($)).line).toBe('')
})

test('工作目錄原有的改動，對話動到它之前不列；沒 cd 就跑 git 之後才列，檔數橘色', async ($, on) => {
  world(on, { [CWD]: { files: [' M a.ts', '?? b.ts'] } })
  await start($)
  expect((await band($)).line).toBe('')
  await $.tool.call({ tool: 'Bash', command: 'git status --short' })
  const { ui, line } = await band($)
  expect(line).toContain('app(master) 2')
  expect((await ui.find({ type: 'Text', text: /^ 2$/ }))?.props.color).toBe(ORANGE)
})

test('只剩未 push 的 commit：整行不畫；有未 commit 的檔時才一起顯示 ↑', async ($, on) => {
  const w = world(on, { [CWD]: { ahead: 2 } })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline -3' })
  expect((await band($)).line).toBe('')
  const repo = w.repos.get(CWD)
  if (repo) repo.files = [' M a.ts']
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' })
  await endTurn($)
  expect((await band($)).line).toContain('app(master) 1 ↑2')
})

test('Edit 別的 repo：加進帳本，未 push 顯示 ↑、別的 worktree 顯示 ⎇、本輪檔數；工作目錄沒動到就不列', async ($, on) => {
  const chezmoi = `${HOME}/.local/share/chezmoi`
  world(on, { [CWD]: {}, [chezmoi]: { branch: 'main', files: [' M dot_x'], ahead: 1, worktrees: 2 } })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${chezmoi}/dot_x`, old_string: 'a', new_string: 'b' })
  const { line } = await band($)
  expect(line).toContain('chezmoi(main) 1 ↑1 ⎇2 · 本輪 1 檔')
  expect(line).not.toContain('app(')
})

test('Bash 的 cd／git -C 字面路徑會追蹤，帶 $ 的不認；跑過 git 指令就重算', async ($, on) => {
  const notes = `${HOME}/notes`
  const w = world(on, { [CWD]: {}, [notes]: { files: [' M n.md'] }, '/srv/x': { files: [' M y'] } })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'cd ~/notes && git status --short' })
  await $.tool.call({ tool: 'Bash', command: 'S=/srv/x; git -C "$S" log -1' })
  let { line } = await band($)
  expect(line).toContain('notes(master) 1')
  // 看不穿的 git -C "$S" 不猜：不追蹤 /srv/x，也不當成在工作目錄跑
  expect(line).not.toContain('x(master)')
  expect(line).not.toContain('app(')
  // 乾淨的 repo 打勾
  await $.tool.call({ tool: 'Bash', command: `git -C ${CWD} status` })
  ;({ line } = await band($))
  expect(line).toContain('notes(master) 1 · app(master) ✓')

  // commit 之後 notes 乾淨了，全部乾淨、本輪沒改檔 → 整行不畫
  const repo = w.repos.get(notes)
  if (repo) repo.files = []
  await $.tool.call({ tool: 'Bash', command: `git -C ${notes} commit -m done` })
  ;({ line } = await band($))
  expect(line).toBe('')
})

test('本輪超過 5 檔變橘色；送出新訊息歸零', async ($, on) => {
  world(on, { [CWD]: { files: [' M f0', ' M f1', ' M f2', ' M f3', ' M f4', ' M f5'] } })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let i = 0; i < 6; i += 1) {
    await $.tool.call({ tool: 'Write', file_path: `${CWD}/f${i}`, content: 'x' })
  }
  await endTurn($)
  let { ui, line } = await band($)
  expect(line).toContain('本輪 6 檔')
  expect((await ui.find({ type: 'Text', text: /^6$/ }))?.props.color).toBe(ORANGE)

  await $.turn.start({ text: 'next', turnId: 't2' })
  ;({ line } = await band($))
  expect(line).not.toContain('本輪')
  expect(line).toContain('app(master) 6')
})

test('repo 外的檔案（scratchpad）和失敗的 Edit 都不算', async ($, on) => {
  const w = world(on, { [CWD]: {}, '/srv/other': {} })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/claude-1000/x/scratchpad/a.md', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/srv/other/FAIL.ts', old_string: 'a', new_string: 'b' })
  expect((await band($)).line).toBe('')
  expect(w.gitCalls.some(c => c[0] === '/srv/other')).toBe(false)
})
