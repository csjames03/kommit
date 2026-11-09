// The task pipeline: plan -> build -> review -> test -> docs -> update -> done.
// Review failures, test failures and merge conflicts send the task back to build,
// up to maxAttempts times. A task can span several repos (one Claude session sees
// them all) and can target a version, whose branch each task branch starts from.
import fs from 'node:fs'
import path from 'node:path'
import * as realGit from './git.js'
import { runClaude as realRunClaude } from './claude.js'
import { runShell as realRunShell } from './proc.js'
import * as P from './prompts.js'

export const STAGES = ['plan', 'build', 'review', 'test', 'docs', 'update']

// Branch name for a repo in a version: per-repo override, else the pattern (default release/{version}).
export function branchFor(version, repo) {
  const override = version.branches?.[repo.id]?.trim()
  if (override) return override
  const name = version.name.trim().replace(/^v(?=\d)/i, '')
  return (version.branchPattern?.trim() || 'release/{version}').replace('{version}', name)
}

function refPart(s) {
  return (
    String(s)
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '') || 'x'
  )
}

export function scopeRepos(task, project) {
  const picked = task.repoIds?.length ? project.repos.filter((r) => task.repoIds.includes(r.id)) : []
  return picked.length ? picked : project.repos
}

export function createPipeline({ store, emit, worktreeRoot, deps = {} }) {
  const runClaude = deps.runClaude || realRunClaude
  const runShell = deps.runShell || realRunShell
  const git = deps.git || realGit

  const queue = []
  const running = new Map() // taskId -> { stop() }

  // Tasks that were mid-run when the app closed can't continue: mark them stopped.
  for (const t of store.listTasks()) {
    if (t.status === 'running' || t.status === 'queued') {
      store.updateTask(t.id, { status: 'stopped', error: 'Interrupted: the app was closed while this task was running.' })
    }
  }

  function update(taskId, patch) {
    const task = store.updateTask(taskId, patch)
    emit('task:updated', task)
    return task
  }

  function log(taskId, stage, kind, text) {
    const entry = { t: Date.now(), stage, kind, text }
    store.appendLog(taskId, entry)
    emit('task:log', taskId, entry)
  }

  function enqueue(taskId, { fromStart = false } = {}) {
    const task = store.getTask(taskId)
    if (!task || running.has(taskId) || queue.includes(taskId)) return
    if (task.status === 'done' && !fromStart) return
    // A manual retry gets a fresh set of fix attempts.
    const patch = { status: 'queued', error: null, attempts: 0 }
    if (fromStart || !task.stage || task.status === 'done') {
      Object.assign(patch, {
        stage: null,
        outputs: {},
        sessionId: null,
        sessionCostUsd: 0,
        feedback: null,
        costUsd: 0,
        affected: null,
        merged: false,
        resetWorkspace: Object.keys(task.repos || {}).length > 0
      })
      store.clearLog(taskId)
    }
    update(taskId, patch)
    queue.push(taskId)
    pump()
  }

  function stop(taskId) {
    const qi = queue.indexOf(taskId)
    if (qi >= 0) {
      queue.splice(qi, 1)
      update(taskId, { status: 'stopped' })
    }
    running.get(taskId)?.stop()
  }

  function pump() {
    const limit = Math.max(1, Number(store.settings().concurrency) || 1)
    while (running.size < limit && queue.length) {
      const taskId = queue.shift()
      const ctrl = {
        current: null,
        stopped: false,
        stop() {
          this.stopped = true
          this.current?.stop()
        }
      }
      running.set(taskId, ctrl)
      runTask(taskId, ctrl).finally(() => {
        running.delete(taskId)
        pump()
      })
    }
  }

  // Context the prompts need: which repos, their folders, the version.
  function context(task, project) {
    const scope = scopeRepos(task, project)
    return {
      multi: scope.length > 1,
      version: project.versions?.find((v) => v.id === task.versionId) || null,
      repos: scope.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        folder: task.repos?.[r.id]?.dir ? path.basename(task.repos[r.id].dir) : refPart(r.name),
        base: task.repos?.[r.id]?.base,
        testCommand: task.testCommands?.[r.id] || null // set up by Claude in this task
      }))
    }
  }

  // Remove a task's worktrees. With deleteBranches the work is discarded and the repo
  // entry dropped; otherwise the branch and commit info are kept. Never deletes a linked original repo.
  async function cleanupWorkspace(task, project, { deleteBranches = false, onlyIds = null } = {}) {
    const repos = { ...(task.repos || {}) }
    for (const [id, r] of Object.entries(repos)) {
      if (onlyIds && !onlyIds.includes(id)) continue
      const repo = project?.repos.find((x) => x.id === id)
      if (r.git && repo && r.dir && r.dir !== repo.path) {
        await git.removeWorktree(repo.path, r.dir)
      } else if (r.linked && r.dir) {
        try {
          if (fs.lstatSync(r.dir).isSymbolicLink()) fs.unlinkSync(r.dir)
        } catch {
          // already gone
        }
      }
      if (deleteBranches) {
        if (r.git && repo && r.branch) await git.deleteBranch(repo.path, r.branch, { force: true })
        delete repos[id]
      } else {
        repos[id] = { ...r, dir: null, cleaned: true }
      }
    }
    if (task.folder && Object.values(repos).every((r) => !r.dir || !r.dir.startsWith(task.folder))) {
      try {
        fs.rmdirSync(task.folder) // only succeeds when empty
      } catch {
        // leave it
      }
    }
    return repos
  }

  // Create the task folder: one worktree per repo in scope, on a task branch from the version branch.
  async function prepareWorkspace(task, project, say) {
    const scope = scopeRepos(task, project)
    const have = task.repos || {}
    if (task.cwd && scope.every((r) => have[r.id] && fs.existsSync(have[r.id].dir))) return task

    const version = project.versions?.find((v) => v.id === task.versionId) || null
    const slug = `task-${task.number}-${git.slugify(task.title)}`
    const branch = version ? `kommit/${refPart(version.name)}/${slug}` : `kommit/${slug}`
    const folder = path.join(worktreeRoot, project.id, slug)
    const repos = { ...have }
    const used = new Set()

    for (const repo of scope) {
      let name = refPart(repo.name)
      while (used.has(name.toLowerCase())) name += '-2'
      used.add(name.toLowerCase())
      if (repos[repo.id] && fs.existsSync(repos[repo.id].dir)) continue

      if (!repo.path || !fs.existsSync(repo.path)) throw new Error(`Repository "${repo.name}" not found at ${repo.path}`)
      const dir = path.join(folder, name)
      if (await git.isGitRepo(repo.path)) {
        let base
        if (version) {
          const b = await git.ensureBranch(repo.path, branchFor(version, repo), version.createFrom || 'main')
          if (b.created) say('info', `${repo.name}: created ${b.branch} from ${b.from}`)
          base = b.branch
        } else {
          base = await git.currentBranch(repo.path)
        }
        say('info', `${repo.name}: worktree on ${branch} (from ${base})`)
        await git.ensureWorktree({ repoPath: repo.path, dir, branch, base })
        repos[repo.id] = { dir, branch, base, git: true, setupDone: false }
      } else if (scope.length === 1) {
        say('warn', `${repo.name} isn't a git repo, so Claude edits it directly (no branch or commit).`)
        repos[repo.id] = { dir: repo.path, branch: null, base: null, git: false, setupDone: true }
      } else {
        say('warn', `${repo.name} isn't a git repo, so it's linked into the task folder and edited directly.`)
        fs.mkdirSync(folder, { recursive: true })
        fs.symlinkSync(repo.path, dir, process.platform === 'win32' ? 'junction' : 'dir')
        repos[repo.id] = { dir, branch: null, base: null, git: false, linked: true, setupDone: true }
      }
    }
    const cwd = scope.length === 1 ? repos[scope[0].id].dir : folder
    return update(task.id, { repos, folder, cwd })
  }

  async function runTask(taskId, ctrl) {
    let task = store.getTask(taskId)
    const project = store.getProject(task.projectId)
    let stage = task.stage || 'plan'
    update(taskId, { status: 'running', stage, startedAt: task.startedAt || new Date().toISOString(), finishedAt: null })

    // Wrap a stoppable step so the Stop button can kill it.
    const step = async (handle) => {
      if (ctrl.stopped) {
        handle.stop()
        throw Object.assign(new Error('Stopped'), { stopped: true })
      }
      ctrl.current = handle
      try {
        return await handle.promise
      } finally {
        ctrl.current = null
      }
    }

    const claude = async (opts) => {
      const res = await step(
        runClaude({
          cwd: task.cwd,
          claudePath: store.settings().claudePath || 'claude',
          model: project.model || undefined,
          systemPrompt: P.SYSTEM_PROMPT,
          onLog: (e) => log(taskId, stage, e.kind, e.text),
          ...opts
        })
      )
      // A resumed session reports its running total, so only add what's new.
      let added = res.costUsd
      if (opts.resume) {
        const prev = task.sessionCostUsd || 0
        added = res.costUsd >= prev ? res.costUsd - prev : res.costUsd
      }
      const sessionPatch = opts.resume || opts.trackSession ? { sessionCostUsd: res.costUsd } : {}
      task = update(taskId, { costUsd: (task.costUsd || 0) + added, ...sessionPatch })
      if (res.isError) throw new Error(`Claude couldn't finish the ${stage} stage (${res.subtype}). ${res.text || ''}`.trim())
      if (opts.schema && !res.output) throw new Error(`Claude didn't return the expected ${stage} output.`)
      return res
    }

    const saveOutput = (key, value, extra = {}) => {
      task = update(taskId, { outputs: { ...task.outputs, [key]: value }, ...extra })
    }

    const retryOrFail = (reason, feedback) => {
      const attempts = (task.attempts || 0) + 1
      if (attempts > (Number(project.maxAttempts) || 3)) {
        throw new Error(`${reason} Gave up after ${attempts - 1} fix attempt(s).`)
      }
      log(taskId, stage, 'warn', `${reason} Sending it back to build (attempt ${attempts}).`)
      task = update(taskId, { attempts, feedback })
      return 'build'
    }

    const repoName = (id) => project.repos.find((r) => r.id === id)?.name || id

    // Repos the plan named, plus any repo that actually changed.
    async function currentAffected() {
      const ids = new Set(task.affected || [])
      for (const [id, r] of Object.entries(task.repos)) {
        if (r.git && (await git.changedFromBase(r.dir, r.base))) ids.add(id)
      }
      return [...ids].filter((id) => task.repos[id])
    }

    try {
      if (task.resetWorkspace) {
        log(taskId, stage, 'info', 'Discarding the previous attempt (worktrees and task branches).')
        const repos = await cleanupWorkspace(task, project, { deleteBranches: true })
        task = update(taskId, { repos, cwd: null, folder: null, resetWorkspace: false })
      }
      task = await prepareWorkspace(task, project, (kind, text) => log(taskId, stage, kind, text))
      let ctx = context(task, project)

      while (stage !== 'done') {
        task = update(taskId, { stage })
        log(taskId, stage, 'stage', `Stage: ${stage}`)

        if (stage === 'plan') {
          const res = await claude({
            prompt: P.planPrompt(task, project, ctx),
            allowedTools: P.READ_ONLY_TOOLS,
            schema: P.SCHEMAS.plan,
            trackSession: true
          })
          const wanted = (res.output.repos || []).map((s) => s.toLowerCase().replace(/\/$/, ''))
          let affected = ctx.repos.filter((r) => wanted.includes(r.name.toLowerCase()) || wanted.includes(r.folder.toLowerCase())).map((r) => r.id)
          if (!affected.length) affected = ctx.repos.map((r) => r.id)
          saveOutput('plan', res.output, { sessionId: res.sessionId, affected })
          if (ctx.multi) log(taskId, stage, 'info', `Repositories to change: ${affected.map(repoName).join(', ')}`)
          stage = 'build'
        } else if (stage === 'build') {
          const res = await claude({
            prompt: P.buildPrompt(task, project, ctx, task.feedback),
            allowedTools: P.parseToolList(project.allowedTools || P.DEFAULT_BUILD_TOOLS),
            schema: P.SCHEMAS.build,
            resume: task.sessionId || undefined,
            trackSession: true
          })
          // Test commands Claude set up for repos that had none.
          const testCommands = { ...(task.testCommands || {}) }
          for (const tc of res.output.testCommands || []) {
            const key = String(tc.repo || '').toLowerCase().replace(/\/$/, '')
            const r = ctx.repos.find((x) => x.name.toLowerCase() === key || x.folder.toLowerCase() === key) || (!ctx.multi ? ctx.repos[0] : null)
            const repo = r && project.repos.find((x) => x.id === r.id)
            if (repo && !repo.testCommand?.trim() && tc.command?.trim()) {
              testCommands[r.id] = tc.command.trim()
              log(taskId, stage, 'info', `${repo.name}: tests set up, run with \`${tc.command.trim()}\``)
            }
          }
          saveOutput('build', res.output, { sessionId: res.sessionId, feedback: null, testCommands })
          stage = 'review'
        } else if (stage === 'review') {
          const diffs = []
          for (const r of ctx.repos) {
            const w = task.repos[r.id]
            if (!w?.git) continue
            const d = await git.diffFromBase(w.dir, w.base)
            if (d.patch) diffs.push({ name: r.name, folder: r.folder, ...d })
          }
          // Fresh session on purpose: the reviewer shouldn't grade its own work.
          const res = await claude({
            prompt: P.reviewPrompt(task, project, ctx, diffs),
            allowedTools: P.READ_ONLY_TOOLS,
            schema: P.SCHEMAS.review
          })
          saveOutput('review', res.output)
          stage =
            res.output.verdict === 'changes_requested'
              ? retryOrFail('Review requested changes.', P.formatReviewFeedback(res.output))
              : 'test'
        } else if (stage === 'test') {
          stage = await runTests()
        } else if (stage === 'docs') {
          const res = await claude({
            prompt: P.docsPrompt(task, project, ctx),
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
            schema: P.SCHEMAS.docs,
            resume: task.sessionId || undefined
          })
          saveOutput('docs', res.output, { sessionId: res.sessionId })
          stage = 'update'
        } else if (stage === 'update') {
          const res = await claude({
            prompt: P.updatePrompt(task, project, ctx),
            allowedTools: [],
            schema: P.SCHEMAS.update,
            resume: task.sessionId || undefined
          })
          // One commit per changed repo, on top of the base it was last synced with.
          const repos = { ...task.repos }
          const unchanged = []
          for (const [id, r] of Object.entries(repos)) {
            if (!r.git) continue
            const sha = await git.squashCommit(r.dir, r.base, res.output.commitMessage)
            repos[id] = { ...r, commit: sha }
            if (sha) log(taskId, stage, 'info', `${repoName(id)}: committed ${sha} on ${r.branch}`)
            else unchanged.push(id)
          }
          task = update(taskId, { repos })
          if (unchanged.length) {
            // Repos that were only read: drop their worktree and empty task branch.
            const left = await cleanupWorkspace(task, project, { deleteBranches: true, onlyIds: unchanged })
            task = update(taskId, { repos: left })
            if (ctx.multi) log(taskId, stage, 'info', `No changes in ${unchanged.map(repoName).join(', ')}`)
          }
          saveOutput('update', res.output)
          stage = 'done'
        }
        ctx = context(task, project)
      }

      update(taskId, { status: 'done', stage: 'done', finishedAt: new Date().toISOString() })
      log(taskId, 'done', 'success', `Task completed · total $${(task.costUsd || 0).toFixed(2)}`)

      if (ctx.version?.autoMerge) {
        try {
          await mergeTask(taskId, { fromPipeline: true })
        } catch (err) {
          log(taskId, 'merge', 'warn', `Auto-merge skipped: ${err.message}`)
          update(taskId, { error: err.message })
        }
      }
    } catch (err) {
      if (err.stopped || ctrl.stopped) {
        update(taskId, { status: 'stopped', stage })
        log(taskId, stage, 'warn', 'Stopped by you.')
      } else {
        update(taskId, { status: 'failed', stage, error: err.message })
        log(taskId, stage, 'error', err.message)
      }
    }

    async function runTests() {
      const ctx = context(task, project)
      const affected = await currentAffected()
      task = update(taskId, { affected })

      // 1. Save the work so far and bring in the latest base branch, so tests cover both.
      const conflicts = []
      for (const id of affected) {
        const r = task.repos[id]
        if (!r.git) continue
        await git.checkpoint(r.dir, `WIP: task #${task.number}`)
        const res = await git.syncWithBase(r.dir, r.base)
        if (res.updated) log(taskId, 'test', 'info', `${repoName(id)}: brought in the latest ${r.base}`)
        if (!res.ok) conflicts.push({ name: repoName(id), folder: path.basename(r.dir), base: r.base, files: res.files })
      }
      if (conflicts.length) {
        for (const c of conflicts) log(taskId, 'test', 'warn', `${c.name}: conflicts with ${c.base} in ${c.files.join(', ')}`)
        return retryOrFail('Merge conflicts with the base branch.', P.formatConflictFeedback(conflicts, ctx.multi))
      }

      // 2. Every changed repo needs a way to run tests: configured, or set up by Claude.
      if (!affected.length) log(taskId, 'test', 'warn', 'No repository was changed.')
      const commandFor = (id) => {
        const repo = project.repos.find((r) => r.id === id)
        return (repo?.testCommand || task.testCommands?.[id] || '').trim()
      }
      const missing = affected.filter((id) => !project.repos.find((r) => r.id === id)?.skipTests && !commandFor(id))
      if (missing.length) {
        const names = missing.map(repoName)
        log(taskId, 'test', 'error', `No tests to run in ${names.join(', ')}`)
        return retryOrFail('Tests are missing.', P.formatMissingTestsFeedback(names, ctx.multi))
      }

      // 3. Run each changed repo's tests.
      const results = []
      for (const id of affected) {
        const repo = project.repos.find((r) => r.id === id)
        const r = task.repos[id]
        const command = commandFor(id)
        if (repo.skipTests) {
          log(taskId, 'test', 'warn', `${repo.name}: tests are turned off for this repo.`)
          results.push({ repoId: id, name: repo.name, skipped: true, passed: true })
          continue
        }
        if (!r.setupDone && repo.setupCommand?.trim()) {
          log(taskId, 'test', 'tool', `${repo.name}: setup: ${repo.setupCommand}`)
          const setup = await step(runShell(repo.setupCommand, { cwd: r.dir }))
          if (setup.code !== 0) throw new Error(`${repo.name}: setup command failed (exit ${setup.code}):\n${setup.output.slice(-2000)}`)
          task = update(taskId, { repos: { ...task.repos, [id]: { ...r, setupDone: true } } })
        }
        log(taskId, 'test', 'tool', `${repo.name}: ${command}`)
        const res = await step(runShell(command, { cwd: r.dir }))
        const passed = res.code === 0
        results.push({ repoId: id, name: repo.name, command, code: res.code, passed, timedOut: res.timedOut, output: res.output.slice(-20000) })
        log(taskId, 'test', passed ? 'success' : 'error', `${repo.name}: tests ${passed ? 'passed' : `failed (exit ${res.code}${res.timedOut ? ', timed out' : ''})`}`)
      }
      const passed = results.every((r) => r.passed)
      saveOutput('test', { passed, skipped: results.length > 0 && results.every((r) => r.skipped), repos: results })
      if (passed) return 'docs'
      return retryOrFail('Tests failed.', P.formatTestFeedback(results.filter((r) => !r.passed), ctx.multi))
    }
  }

  /**
   * Merge a completed task's branches into their base (version) branches, all or nothing.
   * A conflict marks the task "needs attention"; resuming it re-syncs and lets Claude resolve it.
   */
  async function mergeTask(taskId, { fromPipeline = false } = {}) {
    if (running.has(taskId) && !fromPipeline) throw new Error('This task is still running.')
    let task = store.getTask(taskId)
    const project = store.getProject(task.projectId)
    const repoName = (id) => project.repos.find((r) => r.id === id)?.name || id
    const targets = Object.entries(task.repos || {})
      .filter(([, r]) => r.git && r.commit && r.base && r.branch && !r.merged)
      .map(([id, r]) => ({ id, r, repo: project.repos.find((x) => x.id === id) }))
    if (!targets.length) return task

    for (const { r, repo } of targets) {
      if (/^[0-9a-f]{40}$/.test(r.base)) throw new Error(`${repo.name}: the task started from a detached commit, so there's no branch to merge into.`)
    }
    const conflicts = []
    for (const { r, repo } of targets) {
      const c = await git.canMerge(repo.path, r.base, r.branch)
      if (!c.ok) conflicts.push(`${repo.name} (${r.base}): ${c.files.join(', ') || 'conflicts'}`)
    }
    if (conflicts.length) {
      const msg = `The base branch has changed since this task was tested and now conflicts with it:\n${conflicts.join('\n')}\nPress Resume to bring in the latest changes, let Claude resolve the conflicts, and test again.`
      log(taskId, 'merge', 'warn', msg)
      return update(taskId, { status: 'needs_attention', stage: 'test', error: msg })
    }

    const repos = { ...task.repos }
    for (const { id, r, repo } of targets) {
      const res = await git.mergeInto({
        repoPath: repo.path,
        target: r.base,
        source: r.branch,
        tmpRoot: path.join(worktreeRoot, '.merge')
      })
      if (!res.ok) {
        const msg = `${repo.name}: merging into ${r.base} conflicted in ${res.files.join(', ')}. Press Resume to update the task and retry.`
        log(taskId, 'merge', 'warn', msg)
        return update(taskId, { repos, status: 'needs_attention', stage: 'test', error: msg })
      }
      repos[id] = { ...r, merged: res.sha }
      log(taskId, 'merge', 'success', `${repo.name}: merged into ${r.base} (${res.sha})`)
    }
    task = update(taskId, { repos, merged: true, mergedAt: new Date().toISOString(), error: null })

    // Test setups Claude created are in the base branch now: remember their commands for future tasks.
    const learned = Object.entries(task.testCommands || {}).filter(([id]) => {
      const repo = project.repos.find((r) => r.id === id)
      return repo && !repo.testCommand?.trim() && targets.some((t) => t.id === id)
    })
    if (learned.length) {
      const fresh = store.getProject(project.id)
      store.updateProject(project.id, {
        repos: fresh.repos.map((r) => {
          const hit = learned.find(([id]) => id === r.id)
          return hit && !r.testCommand?.trim() ? { ...r, testCommand: hit[1] } : r
        })
      })
      for (const [id, cmd] of learned) log(taskId, 'merge', 'info', `${repoName(id)}: saved \`${cmd}\` as its test command`)
      emit('project:updated', store.getProject(project.id))
    }

    // The work is in the version branch now: free the worktrees and drop the merged task branches.
    for (const { id, r, repo } of targets) {
      if (r.dir) await git.removeWorktree(repo.path, r.dir)
      // Force is safe: the merge into the version branch just succeeded. (-d would
      // refuse, since it only checks the repo's checked-out branch.)
      await git.deleteBranch(repo.path, r.branch, { force: true })
      repos[id] = { ...repos[id], dir: null, cleaned: true }
    }
    return update(taskId, { repos, cwd: null })
  }

  async function cleanupTask(taskId, opts = {}) {
    const task = store.getTask(taskId)
    if (!task) return null
    const project = store.getProject(task.projectId)
    const repos = await cleanupWorkspace(task, project, opts)
    return update(taskId, { repos, cwd: null })
  }

  return { enqueue, stop, mergeTask, cleanupTask, isRunning: (id) => running.has(id) }
}
