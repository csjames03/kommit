// Pipeline tests against real git repos in a temp folder. Only Claude is faked:
// the fake "build" writes files the way Claude would.
import { test as baseTest } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createStore, migrate } from '../src/main/store.js'
import { createPipeline, branchFor, envName, maxAttempts } from '../src/main/pipeline.js'
import { parseToolList, exitLabel } from '../src/main/prompts.js'
import { toLogEntries } from '../src/main/claude.js'

// Each test uses its own temp repos, so they can run in parallel (git is slow on Windows).
const cases = []
const test = (name, fn) => cases.push([name, fn])
setImmediate(() => baseTest('pipeline', { concurrency: true }, (t) => Promise.all(cases.map(([n, f]) => t.test(n, f)))))
const PASS ='node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function mkRepo(root, name, files = { 'README.md': `# ${name}\n` }) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.name', 'Test')
  g(dir, 'config', 'user.email', 'test@example.com')
  g(dir, 'config', 'core.autocrlf', 'false')
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c)
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function commitOn(repo, branch, file, content) {
  const wt = path.join(path.dirname(repo), `.edit-${Math.random().toString(36).slice(2)}`)
  g(repo, 'worktree', 'add', '-q', wt, branch)
  fs.writeFileSync(path.join(wt, file), content)
  g(wt, 'add', '-A')
  g(wt, 'commit', '-q', '-m', `edit ${file}`)
  g(repo, 'worktree', 'remove', '--force', wt)
}

const OUT = {
  build: { summary: 'did it', files: [], testCommands: [] },
  approve: { verdict: 'approve', summary: 'lgtm', issues: [] },
  reject: { verdict: 'changes_requested', summary: 'bug', issues: [{ severity: 'blocker', description: 'off by one' }] },
  docs: { summary: 'none needed', files: [] },
  update: { updateMessage: 'Shipped it', commitMessage: 'feat: the thing' }
}

function stageOf(prompt) {
  if (/PLANNING stage/.test(prompt)) return 'plan'
  if (/BUILD stage/.test(prompt)) return 'build'
  if (/CODE REVIEWER/.test(prompt)) return 'review'
  if (/DOCS stage/.test(prompt)) return 'docs'
  return 'update'
}

/**
 * repos: [{ name, test, files }]; planRepos: names the planner picks;
 * build(cwd, n, prompt): writes files; beforeReview(n): hook; reviews: verdict queue.
 */
function setup({
  repos = [{ name: 'app', test: PASS }],
  planRepos,
  build = (cwd) => fs.writeFileSync(path.join(cwd, 'feature.txt'), 'feature\n'),
  beforeReview = () => {},
  reviews = [],
  maxAttempts = 3,
  task: taskInput = {},
  versions = [],
  integration
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-'))
  const store = createStore(path.join(root, 'data'))
  const repoDefs = repos.map((r) => ({
    id: r.name + '-id',
    name: r.name,
    path: mkRepo(root, r.name, r.files),
    role: '',
    testCommand: r.test ?? PASS,
    setupCommand: '',
    skipTests: !!r.skipTests
  }))
  const calls = []
  let sessionTotal = 0
  let builds = 0
  let reviewsSeen = 0
  const project = store.addProject({
    name: 'ws',
    repos: repoDefs,
    versions,
    maxAttempts,
    integration: typeof integration === 'function' ? integration(root.replace(/\\/g, '/')) : integration
  })
  const deps = {
    runClaude(opts) {
      const stage = stageOf(opts.prompt)
      calls.push({ stage, opts, folders: fs.readdirSync(opts.cwd) })
      let output = OUT[stage]
      if (stage === 'plan') output = { summary: 's', repos: planRepos || repoDefs.map((r) => r.name), contract: '', steps: ['x'], files: [], risks: [] }
      if (stage === 'build') {
        const extra = build(opts.cwd, ++builds, opts.prompt)
        if (extra && typeof extra === 'object') output = { ...OUT.build, ...extra }
      }
      if (stage === 'review') {
        beforeReview(++reviewsSeen)
        output = OUT[reviews.shift() || 'approve']
      }
      // Like the real CLI: a resumed session reports its running total cost.
      let costUsd = 0.1
      if (stage !== 'review') costUsd = sessionTotal = opts.resume ? sessionTotal + 0.1 : 0.1
      return { stop() {}, promise: Promise.resolve({ sessionId: stage === 'review' ? 'r' : 's1', output, text: '', costUsd, isError: false, subtype: 'success' }) }
    }
  }
  const task = store.addTask({ projectId: project.id, title: 'Add X', description: 'please', repoIds: [], versionId: null, repos: {}, ...taskInput })
  const pipeline = createPipeline({ store, emit() {}, worktreeRoot: path.join(root, 'wt'), deps })
  const repo = (name) => repoDefs.find((r) => r.name === name)

  const finished = () =>
    new Promise((resolve) => {
      const tick = () => {
        const t = store.getTask(task.id)
        if (!pipeline.isRunning(task.id) && ['done', 'failed', 'stopped', 'needs_attention'].includes(t.status)) resolve(t)
        else setTimeout(tick, 10)
      }
      tick()
    })
  const run = async (opts) => {
    pipeline.enqueue(task.id, opts)
    return finished()
  }
  return { store, pipeline, task, project, calls, repo, run, root }
}

test('single repo: every stage runs, one squashed commit on the task branch', async () => {
  const { run, calls, repo } = setup()
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.deepEqual(
    calls.map((c) => c.stage),
    ['plan', 'build', 'review', 'docs', 'update']
  )
  const r = t.repos['app-id']
  assert.equal(r.branch, 'kommit/task-1-add-x')
  assert.equal(r.base, 'main')
  assert.equal(t.cwd, r.dir) // single repo: Claude works inside the repo itself
  assert.equal(g(repo('app').path, 'rev-list', '--count', 'main..kommit/task-1-add-x'), '1')
  assert.equal(g(repo('app').path, 'log', '-1', '--format=%s', 'kommit/task-1-add-x'), 'feat: the thing')
  assert.ok(Math.abs(t.costUsd - 0.5) < 1e-9)
})

test('reviewer gets a fresh session and sees the real diff', async () => {
  const { run, calls } = setup()
  await run()
  const review = calls.find((c) => c.stage === 'review').opts
  assert.equal(review.resume, undefined)
  assert.match(review.prompt, /\+feature/)
  assert.equal(calls.find((c) => c.stage === 'build').opts.resume, 's1')
})

test('multi repo: one session over a task folder, only changed repos are tested and committed', async () => {
  const { run, calls, repo } = setup({
    repos: [
      { name: 'client', test: PASS },
      { name: 'backend', test: PASS },
      { name: 'platform', test: FAIL } // would fail if it were tested
    ],
    planRepos: ['backend', 'client'],
    build: (cwd) => {
      fs.writeFileSync(path.join(cwd, 'backend', 'route.js'), 'GET /wishlist\n')
      fs.writeFileSync(path.join(cwd, 'client', 'Wishlist.vue'), '<template/>\n')
    }
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.deepEqual(t.affected.sort(), ['backend-id', 'client-id'])
  assert.deepEqual(t.outputs.test.repos.map((r) => r.name).sort(), ['backend', 'client'])
  assert.ok(t.repos['backend-id'].commit && t.repos['client-id'].commit)
  assert.equal(t.repos['platform-id'], undefined) // read-only repo: worktree and branch removed
  assert.equal(g(repo('platform').path, 'branch', '--list', 'kommit/*'), '')
  const plan = calls.find((c) => c.stage === 'plan')
  assert.match(plan.opts.prompt, /`backend\/`/)
  assert.deepEqual(plan.folders.sort(), ['backend', 'client', 'platform']) // planner could see every repo
})

test('picking repos limits the task to them', async () => {
  const { run, calls } = setup({
    repos: [{ name: 'client' }, { name: 'backend' }, { name: 'platform' }],
    task: { repoIds: ['client-id', 'backend-id'] },
    build: (cwd) => fs.writeFileSync(path.join(cwd, 'client', 'a.txt'), 'a\n')
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.ok(!fs.existsSync(path.join(calls[0].opts.cwd, 'platform')))
  assert.deepEqual(Object.keys(t.repos), ['client-id'])
})

test('a repo the planner skipped but Claude changed anyway still gets tested and committed', async () => {
  const { run } = setup({
    repos: [{ name: 'client' }, { name: 'backend' }],
    planRepos: ['client'],
    build: (cwd) => {
      fs.writeFileSync(path.join(cwd, 'client', 'a.txt'), 'a\n')
      fs.writeFileSync(path.join(cwd, 'backend', 'b.txt'), 'b\n')
    }
  })
  const t = await run()
  assert.ok(t.repos['backend-id'].commit)
  assert.equal(t.outputs.test.repos.length, 2)
})

test('version: branches from release/<version>, created from main, and merges back into it', async () => {
  const version = { id: 'v1', name: 'v2.3', status: 'active', branchPattern: 'release/{version}', createFrom: 'main', branches: {} }
  const { run, repo, pipeline, task, store } = setup({ versions: [version], task: { versionId: 'v1' } })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  const r = t.repos['app-id']
  assert.equal(r.base, 'release/2.3')
  assert.equal(r.branch, 'kommit/v2.3/task-1-add-x')
  const app = repo('app').path
  assert.equal(g(app, 'rev-parse', 'release/2.3'), g(app, 'rev-parse', 'main')) // created from main, untouched so far

  await pipeline.mergeTask(task.id)
  const after = store.getTask(task.id)
  assert.equal(after.merged, true)
  assert.equal(g(app, 'show', 'release/2.3:feature.txt'), 'feature')
  assert.throws(() => g(app, 'show', 'main:feature.txt')) // main untouched
  assert.equal(g(app, 'branch', '--list', 'kommit/*'), '') // merged task branch cleaned up
  assert.ok(!fs.existsSync(r.dir))
})

test('version branch override per repo', () => {
  const v = { name: 'v5.1', branchPattern: 'release/{version}', branches: { b: 'client-release/5.1' } }
  assert.equal(branchFor(v, { id: 'a' }), 'release/5.1')
  assert.equal(branchFor(v, { id: 'b' }), 'client-release/5.1')
})

test('conflict with an updated version branch goes back to build, then lands on top of it', async () => {
  const version = { id: 'v1', name: '1.0', createFrom: 'main', branches: {} }
  let appPath
  const { run, repo, calls } = setup({
    versions: [version],
    task: { versionId: 'v1' },
    repos: [{ name: 'app', files: { 'config.txt': 'base\n' } }],
    build: (cwd, n) => fs.writeFileSync(path.join(cwd, 'config.txt'), n === 1 ? 'mine\n' : 'mine+theirs\n'),
    // Someone else's task lands on release/1.0 while ours is in review.
    beforeReview: (n) => n === 1 && commitOn(appPath, 'release/1.0', 'config.txt', 'theirs\n')
  })
  appPath = repo('app').path
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.equal(t.attempts, 1)
  const fix = calls.filter((c) => c.stage === 'build')[1].opts.prompt
  assert.match(fix, /config\.txt/)
  assert.match(fix, /conflict marker/)
  // Squashed onto the latest release/1.0, so merging is a fast-forward.
  assert.equal(g(appPath, 'merge-base', 'release/1.0', t.repos['app-id'].branch), g(appPath, 'rev-parse', 'release/1.0'))
  assert.equal(g(appPath, 'rev-list', '--count', `release/1.0..${t.repos['app-id'].branch}`), '1')
})

test('merge conflict after completion needs attention; resuming resolves and merges', async () => {
  const version = { id: 'v1', name: '1.0', createFrom: 'main', branches: {} }
  const { run, repo, pipeline, task, store } = setup({
    versions: [version],
    task: { versionId: 'v1' },
    repos: [{ name: 'app', files: { 'config.txt': 'base\n' } }],
    build: (cwd, n) => fs.writeFileSync(path.join(cwd, 'config.txt'), n === 1 ? 'mine\n' : 'resolved\n')
  })
  const app = repo('app').path
  assert.equal((await run()).status, 'done')
  commitOn(app, 'release/1.0', 'config.txt', 'theirs\n')

  await pipeline.mergeTask(task.id)
  const stuck = store.getTask(task.id)
  assert.equal(stuck.status, 'needs_attention')
  assert.equal(stuck.stage, 'test')
  assert.equal(g(app, 'show', 'release/1.0:config.txt'), 'theirs') // nothing merged

  const t = await run()
  assert.equal(t.status, 'done', t.error)
  await pipeline.mergeTask(task.id)
  assert.equal(g(app, 'show', 'release/1.0:config.txt'), 'resolved')
})

test('auto-merge version merges as soon as the task completes', async () => {
  const version = { id: 'v1', name: '1.0', createFrom: 'main', branches: {}, autoMerge: true }
  const { run, repo, store, task } = setup({ versions: [version], task: { versionId: 'v1' } })
  await run()
  assert.equal(store.getTask(task.id).merged, true)
  assert.equal(g(repo('app').path, 'show', 'release/1.0:feature.txt'), 'feature')
})

test('repo without tests: Claude is told to set them up, its command runs, and is saved on merge', async () => {
  const version = { id: 'v1', name: '1.0', createFrom: 'main', branches: {} }
  const { run, calls, pipeline, task, store, project } = setup({
    repos: [{ name: 'app', test: '' }],
    versions: [version],
    task: { versionId: 'v1' },
    build: (cwd) => {
      fs.writeFileSync(path.join(cwd, 'feature.test.js'), 'test\n')
      return { testCommands: [{ repo: 'app', command: PASS }] }
    }
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  const build = calls.find((c) => c.stage === 'build').opts.prompt
  assert.match(build, /NO test command configured/)
  assert.match(build, /Security tests/)
  assert.deepEqual(t.outputs.test.repos.map((r) => [r.command, r.passed]), [[PASS, true]])
  assert.match(calls.find((c) => c.stage === 'review').opts.prompt, /Missing tests for new behavior/)

  await pipeline.mergeTask(task.id)
  assert.equal(store.getProject(project.id).repos[0].testCommand, PASS)
})

test("repo without tests where Claude doesn't set any up: back to build, then fails", async () => {
  const { run, calls } = setup({ repos: [{ name: 'app', test: '' }], maxAttempts: 1 })
  const t = await run()
  assert.equal(t.status, 'failed')
  assert.match(t.error, /Tests are missing/)
  assert.match(calls.filter((c) => c.stage === 'build')[1].opts.prompt, /no way to run tests/)
})

test('a repo with tests turned off is skipped, not failed', async () => {
  const { run } = setup({ repos: [{ name: 'docs', test: '', skipTests: true }] })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.equal(t.outputs.test.repos[0].skipped, true)
})

// Integration commands are small node scripts; markers record that before/after ran.
const node = (js) => `node -e "${js}"`
const mark = (file) => node(`require('fs').appendFileSync('${file}','x')`)
const markCount = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0)
const twoRepos = [{ name: 'backend' }, { name: 'client-view' }]
const buildBoth = (cwd) => {
  fs.writeFileSync(path.join(cwd, 'backend', 'route.js'), 'GET /x\n')
  fs.writeFileSync(path.join(cwd, 'client-view', 'call.js'), 'fetch(x)\n')
}

test('integration tests run after repo tests, see every repo, and before/after wrap them', async () => {
  let root
  const { run, calls } = setup({
    repos: twoRepos,
    build: buildBoth,
    integration: (r) => {
      root = r
      return {
        command: node(
          "const e=process.env,fs=require('fs');process.exit(fs.existsSync(e.KOMMIT_REPO_BACKEND+'/route.js')&&fs.existsSync(e.KOMMIT_REPO_CLIENT_VIEW+'/call.js')&&e.KOMMIT_CHANGED_REPOS.split(',').length===2?0:1)"
        ),
        beforeCommand: mark(`${r}/before.txt`),
        afterCommand: mark(`${r}/after.txt`),
        testsRepoId: 'client-view-id'
      }
    }
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.equal(t.outputs.test.integration.passed, true)
  assert.equal(markCount(`${root}/before.txt`), 1)
  assert.equal(markCount(`${root}/after.txt`), 1)
  const build = calls.find((c) => c.stage === 'build').opts.prompt
  assert.match(build, /## Integration tests/)
  assert.match(build, /End-to-end tests live in "client-view"/)
})

test('failing integration tests go back to build, cleanup always runs, then it passes', async () => {
  let root
  const { run, calls } = setup({
    repos: twoRepos,
    build: (cwd, n) => {
      buildBoth(cwd)
      if (n === 2) fs.writeFileSync(path.join(cwd, 'backend', 'fixed.txt'), 'ok\n')
    },
    integration: (r) => {
      root = r
      return {
        command: node("process.exit(require('fs').existsSync(process.env.KOMMIT_REPO_BACKEND+'/fixed.txt')?0:3)"),
        afterCommand: mark(`${r}/after.txt`)
      }
    }
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.equal(t.attempts, 1)
  assert.match(calls.filter((c) => c.stage === 'build')[1].opts.prompt, /integration tests failed[\s\S]*exited with code 3/)
  assert.equal(markCount(`${root}/after.txt`), 2) // cleanup ran after the failure too
})

test('a failing "before" command counts as an integration failure and still cleans up', async () => {
  let root
  const { run, calls } = setup({
    repos: twoRepos,
    build: buildBoth,
    maxAttempts: 0,
    integration: (r) => {
      root = r
      return { command: PASS, beforeCommand: node('process.exit(7)'), afterCommand: mark(`${r}/after.txt`) }
    }
  })
  const t = await run()
  assert.equal(t.status, 'failed')
  assert.match(t.error, /Integration tests failed/)
  assert.equal(t.outputs.test.integration.beforeFailed, true)
  assert.equal(markCount(`${root}/after.txt`), 1)
  assert.equal(calls.filter((c) => c.stage === 'build').length, 1)
})

test('"only when 2+ repos change" skips integration for a one-repo change', async () => {
  const { run } = setup({
    repos: twoRepos,
    planRepos: ['backend'],
    build: (cwd) => fs.writeFileSync(path.join(cwd, 'backend', 'route.js'), 'x\n'),
    integration: { command: node('process.exit(1)'), runWhen: 'multi' }
  })
  const t = await run()
  assert.equal(t.status, 'done', t.error)
  assert.equal(t.outputs.test.integration.skipped, true)
})

test('max fix attempts: 0 means no retries, missing means 3', () => {
  assert.equal(maxAttempts({ maxAttempts: 0 }), 0)
  assert.equal(maxAttempts({ maxAttempts: '2' }), 2)
  assert.equal(maxAttempts({}), 3)
  assert.equal(maxAttempts({ maxAttempts: 'abc' }), 3)
})

test('Windows crash exit codes are shown readably', () => {
  assert.equal(exitLabel(1), '1')
  assert.equal(exitLabel(3221226505), '0xC0000409 (the process crashed)')
})

test('envName turns repo names into env-var-safe names', () => {
  assert.equal(envName('client-view'), 'CLIENT_VIEW')
  assert.equal(envName('my repo.v2'), 'MY_REPO_V2')
})

test('requested changes send the task back to build with the feedback', async () => {
  const { run, calls } = setup({ reviews: ['reject', 'approve'] })
  const t = await run()
  assert.equal(t.status, 'done')
  assert.equal(t.attempts, 1)
  assert.match(calls.filter((c) => c.stage === 'build')[1].opts.prompt, /off by one/)
})

test('failing tests retry, then fail the task after maxAttempts', async () => {
  const { run, calls } = setup({ repos: [{ name: 'app', test: FAIL }], maxAttempts: 2 })
  const t = await run()
  assert.equal(t.status, 'failed')
  assert.equal(t.stage, 'test')
  assert.match(t.error, /Gave up after 2/)
  assert.equal(calls.filter((c) => c.stage === 'build').length, 3)
})

test('restart from scratch discards the old branch and starts clean', async () => {
  const { run, repo } = setup({ repos: [{ name: 'app', test: FAIL }], maxAttempts: 0 })
  const first = await run()
  assert.equal(first.status, 'failed')
  const t = await run({ fromStart: true })
  assert.equal(t.status, 'failed')
  assert.equal(g(repo('app').path, 'rev-list', '--count', 'main..kommit/task-1-add-x'), '1') // one WIP commit, not two
})

test('migrate converts old single-repo projects and tasks', () => {
  const data = {
    projects: [{ id: 'p', name: 'old', repoPath: 'D:/x/web', testCommand: 'npm test', setupCommand: 'npm i', useWorktree: true }],
    tasks: [{ id: 't', projectId: 'p', workdir: 'D:/wt/t', branch: 'ci/task-1', outputs: { update: { commit: 'abc' } } }]
  }
  migrate(data)
  const p = data.projects[0]
  assert.equal(p.repos.length, 1)
  assert.equal(p.repos[0].path, 'D:/x/web')
  assert.equal(p.repos[0].testCommand, 'npm test')
  assert.deepEqual(p.versions, [])
  const t = data.tasks[0]
  assert.equal(t.repos[p.repos[0].id].branch, 'ci/task-1')
  assert.equal(t.repos[p.repos[0].id].commit, 'abc')
  assert.equal(t.cwd, 'D:/wt/t')
})

test('structured-output retries are hidden from the activity log', () => {
  const hidden = new Set()
  const a = toLogEntries(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'so1', name: 'StructuredOutput', input: {} }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.js' } }] } },
    hidden
  )
  assert.deepEqual(a, [{ kind: 'tool', text: 'Read: a.js' }])
  const u = toLogEntries(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'so1', is_error: true, content: 'bad json' }, { type: 'tool_result', tool_use_id: 'r1', is_error: true, content: 'no such file' }] } },
    hidden
  )
  assert.deepEqual(u, [{ kind: 'error', text: 'no such file' }])
})

test('log shows long paths relative to the working folder', () => {
  const cwd = 'C:\\Users\\me\\AppData\\Local\\Temp\\some\\very\\long\\worktree\\folder\\task-12-add-wishlist'
  const [e] = toLogEntries({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: cwd + '\\backend\\routes.js' } }] } }, new Set(), cwd)
  assert.equal(e.text, 'Read: backend\\routes.js')
})

test('parseToolList keeps rules with spaces together', () => {
  assert.deepEqual(parseToolList('Read Edit Bash(npm *) Bash(git diff *)'), ['Read', 'Edit', 'Bash(npm *)', 'Bash(git diff *)'])
})
