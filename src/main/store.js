// Tiny JSON-file store. Projects and tasks live in data.json; each task's
// activity log is an append-only .jsonl file so data.json stays small.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Older data had one repo per project (repoPath, testCommand…). Convert it to a
// workspace with a repos list, and give old tasks the per-repo worktree shape.
export function migrate(data) {
  for (const p of data.projects) {
    if (!p.repos) {
      p.repos = [
        {
          id: crypto.randomUUID(),
          name: path.basename(p.repoPath || p.name || 'repo'),
          path: p.repoPath,
          role: '',
          testCommand: p.testCommand || '',
          setupCommand: p.setupCommand || ''
        }
      ]
      delete p.repoPath
      delete p.testCommand
      delete p.setupCommand
      delete p.useWorktree
      delete p.autoCommit
    }
    p.versions ||= []
  }
  for (const t of data.tasks) {
    if (t.repos) continue
    const p = data.projects.find((x) => x.id === t.projectId)
    const repo = p?.repos[0]
    t.repos = {}
    if (repo && t.workdir) {
      t.repos[repo.id] = { dir: t.workdir, branch: t.branch || null, base: null, git: !!t.branch, setupDone: !!t.setupDone }
      if (t.outputs?.update?.commit) t.repos[repo.id].commit = t.outputs.update.commit
    }
    t.cwd = t.workdir || null
    t.versionId ||= null
    t.repoIds ||= []
    delete t.workdir
    delete t.branch
    delete t.setupDone
  }
  return data
}

export function createStore(dir) {
  const dataFile = path.join(dir, 'data.json')
  const logDir = path.join(dir, 'logs')
  fs.mkdirSync(logDir, { recursive: true })

  let data = { projects: [], tasks: [], settings: { concurrency: 1 } }
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }
  } catch {
    // first run or unreadable file: start empty
  }
  migrate(data)

  let saveTimer = null
  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 150)
  }
  function flush() {
    clearTimeout(saveTimer)
    const tmp = dataFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, dataFile)
  }

  const now = () => new Date().toISOString()
  const id = () => crypto.randomUUID()

  return {
    flush,
    settings: () => data.settings,
    updateSettings(patch) {
      Object.assign(data.settings, patch)
      save()
      return data.settings
    },

    listProjects: () => data.projects,
    getProject: (pid) => data.projects.find((p) => p.id === pid),
    addProject(input) {
      const project = { id: id(), createdAt: now(), ...input }
      data.projects.push(project)
      save()
      return project
    },
    updateProject(pid, patch) {
      const p = data.projects.find((x) => x.id === pid)
      if (!p) throw new Error('Project not found')
      Object.assign(p, patch)
      save()
      return p
    },
    removeProject(pid) {
      data.projects = data.projects.filter((p) => p.id !== pid)
      data.tasks = data.tasks.filter((t) => t.projectId !== pid)
      save()
    },

    listTasks: () => data.tasks,
    getTask: (tid) => data.tasks.find((t) => t.id === tid),
    addTask(input) {
      const projectTasks = data.tasks.filter((t) => t.projectId === input.projectId)
      const number = projectTasks.reduce((n, t) => Math.max(n, t.number || 0), 0) + 1
      const task = {
        id: id(),
        number,
        status: 'todo',
        stage: null,
        attempts: 0,
        outputs: {},
        costUsd: 0,
        createdAt: now(),
        updatedAt: now(),
        ...input
      }
      data.tasks.push(task)
      save()
      return task
    },
    updateTask(tid, patch) {
      const t = data.tasks.find((x) => x.id === tid)
      if (!t) throw new Error('Task not found')
      Object.assign(t, patch, { updatedAt: now() })
      save()
      return t
    },
    removeTask(tid) {
      data.tasks = data.tasks.filter((t) => t.id !== tid)
      fs.rmSync(path.join(logDir, tid + '.jsonl'), { force: true })
      save()
    },

    appendLog(tid, entry) {
      fs.appendFileSync(path.join(logDir, tid + '.jsonl'), JSON.stringify(entry) + '\n')
    },
    readLog(tid) {
      try {
        return fs
          .readFileSync(path.join(logDir, tid + '.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    clearLog(tid) {
      fs.rmSync(path.join(logDir, tid + '.jsonl'), { force: true })
    }
  }
}
