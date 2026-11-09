import { contextBridge, ipcRenderer } from 'electron'

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  getState: invoke('state:get'),
  updateSettings: invoke('settings:update'),
  pickFolder: invoke('dialog:pickFolder'),
  inspectProject: invoke('project:inspect'),
  addProject: invoke('project:add'),
  updateProject: invoke('project:update'),
  removeProject: invoke('project:remove'),
  createTask: invoke('task:create'),
  updateTask: invoke('task:update'),
  removeTask: invoke('task:remove'),
  runTask: invoke('task:run'),
  stopTask: invoke('task:stop'),
  mergeTask: invoke('task:merge'),
  cleanupTask: invoke('task:cleanup'),
  getLog: invoke('task:log'),
  openPath: invoke('path:open'),
  generateReleaseNotes: invoke('version:releaseNotes'),
  onTaskUpdated: (fn) => on('task:updated', fn),
  onTaskLog: (fn) => on('task:log', fn),
  onProjectUpdated: (fn) => on('project:updated', fn)
})
