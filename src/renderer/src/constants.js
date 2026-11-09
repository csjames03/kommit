export const STAGES = [
  { key: 'plan', label: 'Plan' },
  { key: 'build', label: 'Build' },
  { key: 'review', label: 'Review' },
  { key: 'test', label: 'Test' },
  { key: 'docs', label: 'Docs' },
  { key: 'update', label: 'Update' }
]

export const COLUMNS = [
  { key: 'todo', title: 'To do' },
  { key: 'plan', title: 'Planning' },
  { key: 'build', title: 'Building' },
  { key: 'review', title: 'Code review' },
  { key: 'test', title: 'Testing' },
  { key: 'wrap', title: 'Docs & update' },
  { key: 'done', title: 'Completed' }
]

export function columnOf(task) {
  if (task.status === 'done') return 'done'
  if (!task.stage) return 'todo'
  if (task.stage === 'docs' || task.stage === 'update') return 'wrap'
  return task.stage
}

export const STATUS_LABEL = {
  todo: 'To do',
  queued: 'Queued',
  running: 'Running',
  done: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  needs_attention: 'Needs attention'
}

export const VERSION_STATUS = { planned: 'Planned', active: 'Active', released: 'Released' }

export const money = (n) => (n ? `$${n.toFixed(2)}` : '')

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))

// Same rule as the main process: per-repo override, else the pattern with {version}.
export function branchFor(version, repo) {
  const override = version.branches?.[repo.id]?.trim()
  if (override) return override
  const name = (version.name || '').trim().replace(/^v(?=\d)/i, '')
  return (version.branchPattern?.trim() || 'release/{version}').replace('{version}', name || '…')
}

// Repo names a task touches: what it changed, else what the planner picked, else what you picked.
export function taskRepoNames(task, project) {
  if (!project || project.repos.length < 2) return []
  const ids = task.affected?.length ? task.affected : task.repoIds?.length ? task.repoIds : []
  return ids.map((id) => project.repos.find((r) => r.id === id)?.name).filter(Boolean)
}
