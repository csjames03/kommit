import { useEffect, useRef, useState } from 'react'
import { STAGES, STATUS_LABEL, money } from '../constants.js'
import Markdown from './Markdown.jsx'
import Icon from './Icon.jsx'

const api = window.api
const exitLabel = (c) => (typeof c === 'number' && c >= 0xc0000000 ? `0x${c.toString(16).toUpperCase()}, crashed` : c)
const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function TaskDetail({ task, project, onClose, onEdit, onRemove, onTaskChange }) {
  const [tab, setTab] = useState('activity')
  const [log, setLog] = useState([])
  const [confirm, setConfirm] = useState(null) // 'delete' | 'restart'
  const [busy, setBusy] = useState(null) // 'merge' | 'cleanup'
  const [actionError, setActionError] = useState(null)

  useEffect(() => {
    let alive = true
    api.getLog(task.id).then((entries) => alive && setLog(entries))
    const off = api.onTaskLog((id, entry) => {
      if (id === task.id) setLog((l) => [...l, entry])
    })
    return () => {
      alive = false
      off()
    }
  }, [task.id])

  // A restart clears the log on disk; mirror that here.
  useEffect(() => {
    if (task.status === 'queued' && !task.stage) setLog([])
  }, [task.status, task.stage])

  const running = task.status === 'running' || task.status === 'queued'
  const o = task.outputs || {}
  const version = project?.versions?.find((v) => v.id === task.versionId)
  const repoEntries = Object.entries(task.repos || {}).map(([id, r]) => ({ id, ...r, name: project?.repos.find((x) => x.id === id)?.name || id }))
  const mergeable = repoEntries.filter((r) => r.git && r.commit && r.base && !r.merged)
  const mergeTargets = [...new Set(mergeable.map((r) => r.base))]
  const hasWorktrees = repoEntries.some((r) => r.git && r.dir)

  async function act(kind, fn) {
    setBusy(kind)
    setActionError(null)
    try {
      const t = await fn()
      if (t) onTaskChange(t)
    } catch (e) {
      setActionError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <span className="card-num">
            #{task.number}
            {version && <span className="version-chip">{version.name}</span>}
          </span>
          <h2>{task.title}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close task details">
          <Icon name="x" size={18} />
        </button>
      </header>

      <div className="detail-sub">
        <span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span>
        {task.merged && <span className="badge merged"><Icon name="merge" size={11} /> Merged into {[...new Set(repoEntries.map((r) => r.base))].join(', ')}</span>}
        {task.costUsd > 0 && <span className="chip">{money(task.costUsd)}</span>}
        {task.attempts > 0 && <span className="chip">{task.attempts} fix attempt(s)</span>}
      </div>

      <Stepper task={task} />

      {task.error && task.status === 'failed' && <div className="alert error">{task.error}</div>}
      {task.error && task.status === 'needs_attention' && <div className="alert warn">{task.error}</div>}
      {task.error && task.status === 'done' && <div className="alert warn">{task.error}</div>}
      {actionError && <div className="alert error">{actionError}</div>}

      <div className="detail-actions">
        {task.status === 'todo' && (
          <button className="btn primary" onClick={() => api.runTask(task.id)}>
            <Icon name="play" /> Start
          </button>
        )}
        {running && (
          <button className="btn danger" onClick={() => api.stopTask(task.id)}>
            <Icon name="stop" /> Stop
          </button>
        )}
        {(task.status === 'failed' || task.status === 'stopped') && (
          <button className="btn primary" onClick={() => api.runTask(task.id)}>
            <Icon name="retry" /> Resume from {task.stage}
          </button>
        )}
        {task.status === 'needs_attention' && (
          <button className="btn primary" onClick={() => api.runTask(task.id)} title="Bring in the latest base branch, let Claude resolve conflicts, and test again">
            <Icon name="refresh" /> Update &amp; retest
          </button>
        )}
        {task.status === 'done' && mergeable.length > 0 && (
          <button className="btn primary" disabled={!!busy} onClick={() => act('merge', () => api.mergeTask(task.id))}>
            <Icon name="merge" /> {busy === 'merge' ? 'Merging…' : `Merge into ${mergeTargets.join(', ')}`}
          </button>
        )}
        {!running && task.status !== 'todo' && (
          confirm === 'restart' ? (
            <span className="confirm">
              Discard this task's changes and start over?
              <button
                className="btn danger sm"
                onClick={() => {
                  setConfirm(null)
                  api.runTask(task.id, { fromStart: true })
                }}
              >
                Restart
              </button>
              <button className="btn ghost sm" onClick={() => setConfirm(null)}>
                No
              </button>
            </span>
          ) : (
            <button className="btn ghost" onClick={() => setConfirm('restart')}>
              <Icon name="retry" /> Restart
            </button>
          )
        )}
        {!running && (
          <button className="btn ghost" onClick={onEdit}>
            <Icon name="edit" /> Edit
          </button>
        )}
        {task.cwd && (
          <button className="btn ghost" onClick={() => api.openPath(task.cwd)}>
            <Icon name="folder" /> Open folder
          </button>
        )}
        {!running && task.status === 'done' && hasWorktrees && (
          <button
            className="btn ghost"
            disabled={!!busy}
            title="Deletes the task folders. The branches and their commits stay in your repos."
            onClick={() => act('cleanup', () => api.cleanupTask(task.id))}
          >
            <Icon name="archive" /> {busy === 'cleanup' ? 'Cleaning…' : 'Clean up'}
          </button>
        )}
        {!running &&
          (confirm === 'delete' ? (
            <span className="confirm">
              Delete task? Its branches stay in your repos.
              <button className="btn danger sm" onClick={() => onRemove(task.id)}>
                Delete
              </button>
              <button className="btn ghost sm" onClick={() => setConfirm(null)}>
                No
              </button>
            </span>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirm('delete')}>
              <Icon name="trash" /> Delete
            </button>
          ))}
      </div>

      <nav className="tabs">
        {[
          ['activity', 'Activity'],
          ['plan', 'Plan', o.plan],
          ['review', 'Review', o.review],
          ['test', 'Tests', o.test],
          ['update', 'Update', o.update || o.docs],
          ['task', 'Task']
        ].map(([key, label, has]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
            {has && <span className="tab-dot" />}
          </button>
        ))}
      </nav>

      <div className="detail-body">
        {tab === 'activity' && <Activity log={log} running={task.status === 'running'} />}
        {tab === 'plan' && <PlanView plan={o.plan} multi={project?.repos.length > 1} />}
        {tab === 'review' && <ReviewView review={o.review} />}
        {tab === 'test' && <TestView test={o.test} />}
        {tab === 'update' && <UpdateView update={o.update} docs={o.docs} build={o.build} />}
        {tab === 'task' && <TaskInfo task={task} project={project} repos={repoEntries} />}
      </div>
    </aside>
  )
}

function Stepper({ task }) {
  const idx = task.status === 'done' ? STAGES.length : STAGES.findIndex((s) => s.key === task.stage)
  return (
    <ol className="stepper">
      {STAGES.map((s, i) => {
        let state = 'pending'
        if (i < idx) state = 'complete'
        else if (i === idx)
          state =
            task.status === 'running'
              ? 'active'
              : task.status === 'failed'
                ? 'failed'
                : task.status === 'stopped' || task.status === 'needs_attention'
                  ? 'paused'
                  : 'current'
        return (
          <li key={s.key} className={`step ${state}`}>
            <span className="step-dot">{state === 'complete' ? <Icon name="check" size={13} /> : state === 'failed' ? <Icon name="alert" size={13} /> : i + 1}</span>
            <span className="step-label">{s.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Activity({ log, running }) {
  const ref = useRef(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log])
  if (!log.length) return <Empty text={running ? 'Starting up…' : 'Nothing yet. Start the task to see Claude at work.'} />
  return (
    <div
      className="log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {log.map((e, i) =>
        e.kind === 'stage' ? (
          <div key={i} className="log-stage">
            {e.text}
          </div>
        ) : (
          <div key={i} className={`log-row ${e.kind}`}>
            <span className="log-time">{new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="log-text">{e.text}</span>
          </div>
        )
      )}
      {running && <div className="log-row thinking">Working…</div>}
    </div>
  )
}

const Empty = ({ text }) => <div className="empty">{text}</div>

function List({ title, items }) {
  if (!items?.length) return null
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  )
}

function PlanView({ plan, multi }) {
  if (!plan) return <Empty text="No plan yet." />
  return (
    <div className="prose">
      <p className="lead">{plan.summary}</p>
      {multi && plan.repos?.length > 0 && (
        <p>
          {plan.repos.map((r) => (
            <span key={r} className="repo-chip">
              {r}
            </span>
          ))}
        </p>
      )}
      {plan.contract?.trim() && (
        <>
          <h3>Contract between repos</h3>
          <pre className="output">{plan.contract}</pre>
        </>
      )}
      <h3>Steps</h3>
      <ol>
        {plan.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <List title="Files" items={plan.files} />
      <List title="Risks & assumptions" items={plan.risks} />
    </div>
  )
}

function ReviewView({ review }) {
  if (!review) return <Empty text="Not reviewed yet." />
  return (
    <div className="prose">
      <p>
        <span className={`badge ${review.verdict === 'approve' ? 'done' : 'failed'}`}>{review.verdict === 'approve' ? 'Approved' : 'Changes requested'}</span>
      </p>
      <p className="lead">{review.summary}</p>
      {review.issues?.length > 0 && (
        <div className="issues">
          {review.issues.map((i, k) => (
            <div key={k} className={`issue ${i.severity}`}>
              <span className="sev">{i.severity}</span>
              <div>
                {i.file && <div className="mono small">{i.file}</div>}
                <div>{i.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TestView({ test }) {
  if (!test) return <Empty text="Tests haven't run yet." />
  // Older single-repo results had the fields at the top level.
  const results = test.repos || (test.skipped ? [] : [{ name: 'Tests', ...test }])
  if (!results.length) return <Empty text="No repository was changed, so there was nothing to test." />
  return (
    <div className="prose">
      {results.map((r, i) => (
        <section key={i} className="test-repo">
          <div className="row-between">
            <h3>{r.name}</h3>
            <span className={`badge ${r.skipped ? 'stopped' : r.passed ? 'done' : 'failed'}`}>
              {r.skipped ? 'Skipped' : r.passed ? 'Passed' : `Failed (exit ${exitLabel(r.code)})`}
            </span>
          </div>
          {r.skipped ? (
            <p className="muted">Tests are turned off for this repo in Workspace settings.</p>
          ) : (
            <>
              <p className="mono small muted">{r.command}</p>
              <pre className="output">{r.output || '(no output)'}</pre>
            </>
          )}
        </section>
      ))}
      {test.integration && <IntegrationResult r={test.integration} />}
    </div>
  )
}

function IntegrationResult({ r }) {
  const secs = r.durationMs ? ` · ${Math.round(r.durationMs / 1000)}s` : ''
  const label = r.skipped ? 'Skipped' : r.passed ? 'Passed' : r.beforeFailed ? `Setup failed (exit ${exitLabel(r.code)})` : `Failed (exit ${exitLabel(r.code)}${r.timedOut ? ', timed out' : ''})`
  return (
    <section className="test-repo integration-result">
      <div className="row-between">
        <h3>
          <Icon name="grid" size={13} /> Integration tests
        </h3>
        <span className={`badge ${r.skipped ? 'stopped' : r.passed ? 'done' : 'failed'}`}>{label}</span>
      </div>
      {r.skipped ? (
        <p className="muted">Only runs when 2 or more repos change. This task changed one.</p>
      ) : (
        <>
          <p className="mono small muted">
            {r.beforeCommand ? `${r.beforeCommand}  →  ` : ''}
            {r.command}
            {secs}
          </p>
          <pre className="output">{r.output || '(no output)'}</pre>
        </>
      )}
    </section>
  )
}

function UpdateView({ update, docs, build }) {
  const [copied, setCopied] = useState(false)
  if (!update && !docs && !build) return <Empty text="No update yet." />
  return (
    <div className="prose">
      {update && (
        <>
          <div className="row-between">
            <h3>Status update</h3>
            <button
              className="btn ghost sm"
              onClick={() => {
                navigator.clipboard.writeText(update.updateMessage)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="card-block">
            <Markdown text={update.updateMessage} />
          </div>
          <h3>Commit message</h3>
          <pre className="output">{update.commitMessage}</pre>
        </>
      )}
      {build && (
        <>
          <h3>What changed</h3>
          <p className="pre">{build.summary}</p>
          <List title="Files" items={build.files} />
        </>
      )}
      {docs && (
        <>
          <h3>Docs</h3>
          <p className="pre">{docs.summary}</p>
        </>
      )}
    </div>
  )
}

function TaskInfo({ task, project, repos }) {
  const picked = (task.repoIds || []).map((id) => project?.repos.find((r) => r.id === id)?.name).filter(Boolean)
  return (
    <div className="prose">
      <h3>Description</h3>
      <p className="pre">{task.description || 'No description.'}</p>
      {project?.repos.length > 1 && (
        <>
          <h3>Scope</h3>
          <p>{picked.length ? `Picked: ${picked.join(', ')}` : 'Auto: the planner decides which repos to change.'}</p>
        </>
      )}
      {repos.length > 0 && (
        <>
          <h3>Branches</h3>
          <div className="repo-table">
            {repos.map((r) => (
              <div key={r.id} className="repo-table-row">
                <div className="repo-table-main">
                  <strong>{r.name}</strong>
                  {r.git ? (
                    <span className="mono small muted branch-line">
                      <Icon name="branch" size={12} /> {r.branch} <span className="arrow">from</span> {r.base}
                    </span>
                  ) : (
                    <span className="small muted">not a git repo: edited in place</span>
                  )}
                </div>
                <div className="repo-table-side">
                  {r.merged ? (
                    <span className="badge merged">merged {r.merged}</span>
                  ) : r.commit ? (
                    <span className="badge done mono">{r.commit}</span>
                  ) : null}
                  {r.dir && (
                    <button className="btn ghost sm" onClick={() => api.openPath(r.dir)} aria-label={`Open ${r.name} folder`}>
                      <Icon name="folder" size={14} /> Open
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
