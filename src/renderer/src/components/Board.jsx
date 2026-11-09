import { COLUMNS, STAGES, columnOf, STATUS_LABEL, money, taskRepoNames } from '../constants.js'
import Icon from './Icon.jsx'

const EMPTY = {
  todo: 'Nothing queued up',
  plan: 'No tasks planning',
  build: 'No tasks building',
  review: 'Nothing in review',
  test: 'Nothing testing',
  wrap: 'Nothing wrapping up',
  done: 'Completed tasks land here'
}

export default function Board({ tasks, project, selectedId, onOpen, onNew }) {
  const byColumn = Object.fromEntries(COLUMNS.map((c) => [c.key, []]))
  for (const t of [...tasks].sort((a, b) => a.number - b.number)) byColumn[columnOf(t)].push(t)

  return (
    <div className="board">
      {COLUMNS.map((col) => (
        <section key={col.key} className={`column col-${col.key}`} aria-label={col.title}>
          <header className="column-head">
            <span className="column-dot" aria-hidden="true" />
            <span className="column-title">{col.title}</span>
            <span className="count">{byColumn[col.key].length}</span>
          </header>
          <div className="column-body">
            {byColumn[col.key].map((t) => (
              <TaskCard key={t.id} task={t} project={project} selected={t.id === selectedId} onClick={() => onOpen(t.id)} />
            ))}
            {col.key === 'todo' && onNew && (
              <button className="add-card" onClick={onNew}>
                <Icon name="plus" /> New task
              </button>
            )}
            {!byColumn[col.key].length && col.key !== 'todo' && <div className="column-empty">{EMPTY[col.key]}</div>}
          </div>
        </section>
      ))}
    </div>
  )
}

// Six segments, one per stage: done, current (animated while running), pending.
function MiniProgress({ task }) {
  const idx = task.status === 'done' ? STAGES.length : task.stage ? STAGES.findIndex((s) => s.key === task.stage) : -1
  if (idx < 0) return null
  return (
    <div className="mini-progress" aria-hidden="true">
      {STAGES.map((s, i) => (
        <span key={s.key} className={i < idx ? 'done' : i === idx ? `now ${task.status}` : ''} />
      ))}
    </div>
  )
}

function TaskCard({ task, project, selected, onClick }) {
  const version = project?.versions?.find((v) => v.id === task.versionId)
  const repos = taskRepoNames(task, project)
  const stageLabel = STAGES.find((s) => s.key === task.stage)?.label
  return (
    <button
      className={`card status-${task.status} ${selected ? 'selected' : ''}`}
      onClick={onClick}
      aria-label={`Task ${task.number}: ${task.title}. ${STATUS_LABEL[task.status]}${stageLabel && task.status !== 'done' ? `, ${stageLabel}` : ''}`}
    >
      <div className="card-top">
        <span className="card-num">#{task.number}</span>
        {version && (
          <span className="version-chip">
            <Icon name="tag" size={11} />
            {version.name}
          </span>
        )}
        <span className="spacer" />
        {task.merged ? (
          <span className="badge merged">
            <Icon name="merge" size={11} /> Merged
          </span>
        ) : (
          task.status !== 'todo' && <span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span>
        )}
      </div>
      <div className="card-title">{task.title}</div>
      {task.description && <div className="card-desc">{task.description}</div>}
      {repos.length > 0 && (
        <div className="card-repos">
          {repos.map((n) => (
            <span key={n} className="repo-chip sm">
              {n}
            </span>
          ))}
        </div>
      )}
      <MiniProgress task={task} />
      {(task.attempts > 0 || task.costUsd > 0) && (
        <div className="card-meta">
          {task.attempts > 0 && (
            <span title="Fix attempts after review, test or merge problems">
              <Icon name="retry" size={12} /> {task.attempts}
            </span>
          )}
          <span className="spacer" />
          {task.costUsd > 0 && <span className="num">{money(task.costUsd)}</span>}
        </div>
      )}
    </button>
  )
}
