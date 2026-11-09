import { useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import Board from './components/Board.jsx'
import TaskDetail from './components/TaskDetail.jsx'
import TaskModal from './components/TaskModal.jsx'
import WorkspaceModal from './components/WorkspaceModal.jsx'
import VersionsModal from './components/VersionsModal.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import Icon from './components/Icon.jsx'

const api = window.api

export default function App() {
  const [projects, setProjects] = useState([])
  const [tasks, setTasks] = useState([])
  const [settings, setSettings] = useState({})
  const [loaded, setLoaded] = useState(false)
  const [projectId, setProjectId] = useState(null)
  const [versionFilter, setVersionFilter] = useState('all') // 'all' | 'none' | version id
  const [taskId, setTaskId] = useState(null)
  const [modal, setModal] = useState(null) // { type, item? }

  useEffect(() => {
    api.getState().then((s) => {
      setProjects(s.projects)
      setTasks(s.tasks)
      setSettings(s.settings)
      setProjectId((cur) => cur || s.projects[0]?.id || null)
      setLoaded(true)
    })
    const offTask = api.onTaskUpdated((task) => upsertTask(task))
    const offProject = api.onProjectUpdated((p) => setProjects((list) => list.map((x) => (x.id === p.id ? p : x))))
    return () => {
      offTask()
      offProject()
    }
  }, [])

  const project = projects.find((p) => p.id === projectId) || null
  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === projectId), [tasks, projectId])
  const visibleTasks = useMemo(
    () =>
      versionFilter === 'all'
        ? projectTasks
        : projectTasks.filter((t) => (versionFilter === 'none' ? !t.versionId : t.versionId === versionFilter)),
    [projectTasks, versionFilter]
  )
  const task = tasks.find((t) => t.id === taskId) || null

  function upsertTask(t) {
    setTasks((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]))
  }
  const replaceProject = (p) => setProjects((list) => list.map((x) => (x.id === p.id ? p : x)))

  async function saveProject(input, id) {
    if (id) replaceProject(await api.updateProject(id, input))
    else {
      const p = await api.addProject(input)
      setProjects((list) => [...list, p])
      selectProject(p.id)
    }
    setModal(null)
  }

  async function removeProject(id) {
    await api.removeProject(id)
    setProjects((list) => list.filter((p) => p.id !== id))
    setTasks((list) => list.filter((t) => t.projectId !== id))
    if (projectId === id) selectProject(projects.find((p) => p.id !== id)?.id || null)
    setModal(null)
  }

  function selectProject(id) {
    setProjectId(id)
    setTaskId(null)
    setVersionFilter('all')
  }

  async function saveTask(input, id) {
    const t = id ? await api.updateTask(id, input) : await api.createTask({ ...input, projectId })
    upsertTask(t)
    setModal(null)
  }

  async function removeTask(id) {
    await api.removeTask(id)
    setTasks((list) => list.filter((t) => t.id !== id))
    setTaskId(null)
  }

  async function runAll() {
    for (const t of visibleTasks.filter((t) => t.status === 'todo')) await api.runTask(t.id)
  }

  if (!loaded) return <div className="splash">Loading…</div>

  const versions = project?.versions || []
  const defaultVersion = versionFilter !== 'all' && versionFilter !== 'none' ? versionFilter : null

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        tasks={tasks}
        activeId={projectId}
        onSelect={selectProject}
        onAdd={() => setModal({ type: 'workspace' })}
        onSettings={() => setModal({ type: 'settings' })}
      />

      <main className="main">
        {project ? (
          <>
            <header className="topbar">
              <div className="topbar-title">
                <h1>{project.name}</h1>
                <div className="repo-line">
                  {project.repos.map((r) => (
                    <span key={r.id} className="repo-chip" title={r.path}>
                      <Icon name="repo" size={11} />
                      {r.name}
                    </span>
                  ))}
                  {!project.repos.length && <span className="muted small">No repos yet. Add one in Workspace settings.</span>}
                </div>
              </div>
              <div className="topbar-actions">
                <label className="select-wrap" title="Filter by version">
                  <Icon name="tag" />
                  <select value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)} aria-label="Filter by version">
                    <option value="all">All versions</option>
                    <option value="none">No version</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                        {v.status === 'released' ? ' (released)' : ''}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevronDown" size={14} className="select-caret" />
                </label>
                <div className="btn-group">
                  <button className="btn ghost" onClick={() => setModal({ type: 'versions' })} aria-label="Versions" title="Versions">
                    <Icon name="tag" /> <span className="btn-label">Versions</span>
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => setModal({ type: 'workspace', item: project })}
                    aria-label="Workspace settings"
                    title="Workspace settings"
                  >
                    <Icon name="sliders" /> <span className="btn-label">Workspace</span>
                  </button>
                </div>
                <button
                  className="btn"
                  onClick={runAll}
                  disabled={!visibleTasks.some((t) => t.status === 'todo')}
                  aria-label="Run all to-dos"
                  title="Queue every task in To do"
                >
                  <Icon name="bolt" /> <span className="btn-label">Run all</span>
                </button>
                <button className="btn primary" disabled={!project.repos.length} onClick={() => setModal({ type: 'task' })}>
                  <Icon name="plus" /> New task
                </button>
              </div>
            </header>
            <Board
              tasks={visibleTasks}
              project={project}
              selectedId={taskId}
              onOpen={setTaskId}
              onNew={project.repos.length ? () => setModal({ type: 'task' }) : null}
            />
          </>
        ) : (
          <div className="empty-hero">
            <div className="logo-mark big" aria-hidden="true">
              <Icon name="merge" size={34} />
            </div>
            <h1>Kommit</h1>
            <p>Write the task. Claude ships the commit.</p>
            <ol className="hero-steps">
              <li>
                <span>1</span>Add a workspace with your repos
              </li>
              <li>
                <span>2</span>Write tasks, optionally for a version
              </li>
              <li>
                <span>3</span>Claude plans, builds, reviews, tests and commits
              </li>
            </ol>
            <button className="btn primary lg" onClick={() => setModal({ type: 'workspace' })}>
              <Icon name="plus" /> Create your first workspace
            </button>
          </div>
        )}
      </main>

      {task && (
        <TaskDetail
          key={task.id}
          task={task}
          project={projects.find((p) => p.id === task.projectId)}
          onClose={() => setTaskId(null)}
          onEdit={() => setModal({ type: 'task', item: task })}
          onRemove={removeTask}
          onTaskChange={upsertTask}
        />
      )}

      {modal?.type === 'task' && (
        <TaskModal task={modal.item} project={project} defaultVersionId={defaultVersion} onSave={saveTask} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'workspace' && (
        <WorkspaceModal project={modal.item} onSave={saveProject} onRemove={removeProject} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'versions' && project && (
        <VersionsModal project={project} tasks={projectTasks} onProjectChange={replaceProject} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'settings' && (
        <SettingsModal
          settings={settings}
          onSave={async (patch) => {
            setSettings(await api.updateSettings(patch))
            setModal(null)
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
