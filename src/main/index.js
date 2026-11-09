import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createStore } from './store.js'
import { createPipeline } from './pipeline.js'
import { isGitRepo } from './git.js'
import { runClaude } from './claude.js'
import { DEFAULT_BUILD_TOOLS, SCHEMAS, releaseNotesPrompt } from './prompts.js'

let win = null
let store
let pipeline

function emit(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  if (channel === 'task:updated') notify(args[0])
}

const lastStatus = new Map()
function notify(task) {
  const prev = lastStatus.get(task.id)
  lastStatus.set(task.id, task.status)
  if (prev === task.status || !Notification.isSupported()) return
  if (task.status === 'done') new Notification({ title: 'Task completed', body: `#${task.number} ${task.title}` }).show()
  if (task.status === 'failed') new Notification({ title: 'Task failed', body: `#${task.number} ${task.title}` }).show()
  if (task.status === 'needs_attention') new Notification({ title: 'Task needs attention', body: `#${task.number} ${task.title}` }).show()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'Kommit',
    backgroundColor: '#111214',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

function registerIpc() {
  handle('state:get', () => ({ projects: store.listProjects(), tasks: store.listTasks(), settings: store.settings() }))
  handle('settings:update', (patch) => store.updateSettings(patch))

  handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // Suggest sensible project defaults from what's in the folder.
  handle('project:inspect', async (repoPath) => {
    const git = await isGitRepo(repoPath)
    let testCommand = ''
    let setupCommand = ''
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'))
      const pm = fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(repoPath, 'yarn.lock'))
          ? 'yarn'
          : 'npm'
      setupCommand = pm === 'npm' ? 'npm install' : `${pm} install`
      const script = ['test:unit', 'test'].find((s) => pkg.scripts?.[s] && !/no test specified/.test(pkg.scripts[s]))
      if (script) testCommand = pm === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : `${pm} ${script}`
    } catch {
      // not a Node project
    }
    return { git, testCommand, setupCommand, name: path.basename(repoPath) }
  })

  handle('project:add', (input) =>
    store.addProject({ maxAttempts: 3, allowedTools: DEFAULT_BUILD_TOOLS, repos: [], versions: [], ...input })
  )
  handle('project:update', (id, patch) => store.updateProject(id, patch))
  handle('project:remove', (id) => {
    for (const t of store.listTasks().filter((t) => t.projectId === id)) pipeline.stop(t.id)
    store.removeProject(id)
  })

  handle('task:create', (input) => {
    const { autoStart, ...rest } = input
    const task = store.addTask({ repos: {}, repoIds: [], versionId: null, ...rest })
    if (autoStart) pipeline.enqueue(task.id)
    return store.getTask(task.id)
  })
  handle('task:update', (id, patch) => store.updateTask(id, patch))
  handle('task:remove', async (id) => {
    pipeline.stop(id)
    await pipeline.cleanupTask(id) // removes worktrees; task branches stay in the repos
    store.removeTask(id)
  })
  handle('task:run', (id, opts) => pipeline.enqueue(id, opts))
  handle('task:stop', (id) => pipeline.stop(id))
  handle('task:merge', (id) => pipeline.mergeTask(id))
  handle('task:cleanup', (id) => pipeline.cleanupTask(id))
  handle('task:log', (id) => store.readLog(id))
  handle('path:open', (dir) => {
    if (dir && fs.existsSync(dir)) shell.openPath(dir)
  })

  handle('version:releaseNotes', async (projectId, versionId) => {
    const project = store.getProject(projectId)
    const version = project?.versions.find((v) => v.id === versionId)
    if (!version) throw new Error('Version not found')
    const done = store.listTasks().filter((t) => t.projectId === projectId && t.versionId === versionId && t.status === 'done')
    if (!done.length) throw new Error('No completed tasks in this version yet.')
    const { promise } = runClaude({
      cwd: project.repos.find((r) => r.path && fs.existsSync(r.path))?.path || app.getPath('home'),
      prompt: releaseNotesPrompt(project, version, done),
      claudePath: store.settings().claudePath || 'claude',
      model: project.model || undefined,
      allowedTools: [],
      schema: SCHEMAS.releaseNotes
    })
    const res = await promise
    if (!res.output?.notes) throw new Error("Claude didn't return release notes.")
    const versions = project.versions.map((v) =>
      v.id === versionId ? { ...v, releaseNotes: res.output.notes, releaseNotesAt: new Date().toISOString() } : v
    )
    return store.updateProject(projectId, { versions })
  })
}

// The app used to be called "Commitment Issues". On first launch as Kommit, copy its
// workspaces, tasks and logs across. Old task folders stay where they are; tasks
// keep pointing at them by absolute path.
function carryOverOldData(dataDir) {
  const oldDir = path.join(app.getPath('appData'), 'commitment-issues')
  if (fs.existsSync(path.join(dataDir, 'data.json')) || !fs.existsSync(path.join(oldDir, 'data.json'))) return
  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(path.join(oldDir, 'data.json'), path.join(dataDir, 'data.json'))
  if (fs.existsSync(path.join(oldDir, 'logs'))) fs.cpSync(path.join(oldDir, 'logs'), path.join(dataDir, 'logs'), { recursive: true })
}

app.whenReady().then(() => {
  app.setAppUserModelId('dev.kommit.app')
  const dataDir = app.getPath('userData')
  try {
    carryOverOldData(dataDir)
  } catch (err) {
    console.error('Could not carry over data from Commitment Issues:', err)
  }
  store = createStore(dataDir)
  pipeline = createPipeline({ store, emit, worktreeRoot: path.join(dataDir, 'worktrees') })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
