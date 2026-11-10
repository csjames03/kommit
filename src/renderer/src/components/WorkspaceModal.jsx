import { useState } from 'react'
import Modal, { Field } from './Modal.jsx'
import { uid } from '../constants.js'
import Icon from './Icon.jsx'

const api = window.api
const blankRepo = () => ({ id: uid(), name: '', path: '', role: '', testCommand: '', setupCommand: '', isGit: null })

export default function WorkspaceModal({ project, onSave, onRemove, onClose }) {
  const [f, setF] = useState(() =>
    project
      ? { ...project, repos: project.repos.map((r) => ({ ...r })) }
      : { name: '', notes: '', model: '', maxAttempts: 3, repos: [blankRepo()] }
  )
  const [advanced, setAdvanced] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const setRepo = (id, patch) => setF((x) => ({ ...x, repos: x.repos.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))

  async function pick(id) {
    const dir = await api.pickFolder()
    if (!dir) return
    const info = await api.inspectProject(dir)
    setF((x) => ({
      ...x,
      name: x.name || (x.repos.length === 1 ? info.name : x.name),
      repos: x.repos.map((r) =>
        r.id === id
          ? {
              ...r,
              path: dir,
              isGit: info.git,
              name: r.name || info.name,
              testCommand: r.testCommand || info.testCommand,
              setupCommand: r.setupCommand || info.setupCommand
            }
          : r
      )
    }))
  }

  const repos = f.repos.filter((r) => r.path)
  const names = repos.map((r) => r.name.trim().toLowerCase())
  const dupName = names.some((n, i) => names.indexOf(n) !== i)
  const paths = repos.map((r) => r.path.replace(/[\\/]+$/, '').toLowerCase())
  const dupPath = paths.some((p, i) => paths.indexOf(p) !== i)
  const valid = f.name.trim() && repos.length > 0 && repos.every((r) => r.name.trim()) && !dupName && !dupPath

  function save() {
    if (!valid) return
    onSave(
      {
        ...f,
        name: f.name.trim(),
        maxAttempts: f.maxAttempts === '' || !Number.isFinite(Number(f.maxAttempts)) ? 3 : Math.max(0, Math.floor(Number(f.maxAttempts))),
        repos: repos.map(({ isGit, ...r }) => ({ ...r, name: r.name.trim() })),
        integration: cleanIntegration(f.integration, repos)
      },
      project?.id
    )
  }

  return (
    <Modal
      title={project ? 'Workspace settings' : 'New workspace'}
      onClose={onClose}
      wide
      footer={
        <>
          {project &&
            (confirm ? (
              <span className="confirm">
                Remove workspace and its tasks?
                <button className="btn danger sm" onClick={() => onRemove(project.id)}>
                  Remove
                </button>
                <button className="btn ghost sm" onClick={() => setConfirm(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="btn ghost danger-text" onClick={() => setConfirm(true)}>
                Remove workspace
              </button>
            ))}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            {project ? 'Save' : 'Create workspace'}
          </button>
        </>
      }
    >
      <Field label="Workspace name">
        <input autoFocus={!project} value={f.name} onChange={set('name')} placeholder="Storefront" />
      </Field>

      <div className="section-head">
        <span className="field-label">Repositories</span>
        <span className="field-hint">A task can change several repos at once. Claude sees them all in one session.</span>
      </div>
      <div className="repo-rows">
        {f.repos.map((r, i) => (
          <div key={r.id} className="repo-row">
            <div className="repo-row-head">
              <span className="repo-index">{i + 1}</span>
              <div className="input-row grow">
                <input value={r.path} readOnly placeholder="Choose a repo folder" onClick={() => pick(r.id)} />
                <button className="btn" onClick={() => pick(r.id)}>
                  <Icon name="folder" /> Browse…
                </button>
              </div>
              {f.repos.length > 1 && (
                <button className="icon-btn" aria-label={`Remove repo ${r.name || i + 1}`} onClick={() => setF((x) => ({ ...x, repos: x.repos.filter((y) => y.id !== r.id) }))}>
                  <Icon name="x" />
                </button>
              )}
            </div>
            {r.isGit === false && <div className="alert warn">Not a git repo: Claude edits it directly, with no branch, commit or version.</div>}
            <div className="grid-3">
              <Field label="Name">
                <input value={r.name} onChange={(e) => setRepo(r.id, { name: e.target.value })} placeholder="backend" />
              </Field>
              <Field label="What it is">
                <input value={r.role} onChange={(e) => setRepo(r.id, { role: e.target.value })} placeholder="Express API" />
              </Field>
              <Field label="Test command">
                <input
                  className="mono"
                  value={r.testCommand}
                  disabled={r.skipTests}
                  onChange={(e) => setRepo(r.id, { testCommand: e.target.value })}
                  placeholder={r.skipTests ? 'tests off' : 'blank: Claude sets up tests'}
                />
              </Field>
            </div>
            {!r.testCommand?.trim() && !r.skipTests && (
              <p className="field-hint repo-note">
                No tests yet: the first task that changes this repo sets up a test setup that fits its stack, and its command is saved here once
                that task is merged.
              </p>
            )}
            {advanced && (
              <>
                <Field label="Setup command" hint="Runs once in a new task worktree before tests, e.g. installing dependencies.">
                  <input className="mono" value={r.setupCommand} onChange={(e) => setRepo(r.id, { setupCommand: e.target.value })} placeholder="npm install" />
                </Field>
                <label className="check repo-skip">
                  <input type="checkbox" checked={!!r.skipTests} onChange={(e) => setRepo(r.id, { skipTests: e.target.checked })} />
                  Skip tests for this repo (e.g. docs or config only)
                </label>
              </>
            )}
          </div>
        ))}
      </div>
      {dupName && <div className="alert error">Each repo needs a different name.</div>}
      {dupPath && <div className="alert error">The same folder is added twice. Each repo needs its own folder.</div>}
      <button className="btn ghost small add-repo" onClick={() => setF((x) => ({ ...x, repos: [...x.repos, blankRepo()] }))}>
        <Icon name="plus" /> Add another repo
      </button>

      <Field label="Workspace notes for Claude" hint="Stack, conventions, how the repos fit together, things to never touch. Sent with every task.">
        <textarea rows={3} value={f.notes || ''} onChange={set('notes')} placeholder="client-view calls backend's REST API. platform holds shared types. Never edit .env files." />
      </Field>

      <IntegrationSection
        value={f.integration || {}}
        repos={repos}
        onChange={(patch) => setF((x) => ({ ...x, integration: { ...(x.integration || {}), ...patch } }))}
      />

      <button className="link" onClick={() => setAdvanced((a) => !a)}>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} /> Advanced
      </button>
      {advanced && (
        <>
          <div className="grid-2">
            <Field label="Max fix attempts" hint="Times a task can go back to Build after a failed review, test run or merge.">
              <input type="number" min={0} max={10} value={f.maxAttempts} onChange={set('maxAttempts')} />
            </Field>
            <Field label="Model" hint="Optional. Blank uses your Claude Code default (e.g. sonnet, opus).">
              <input className="mono" value={f.model || ''} onChange={set('model')} placeholder="default" />
            </Field>
          </div>
          <Field label="Tools Claude may use while building" hint="Space separated. Anything not listed is denied.">
            <textarea className="mono" rows={3} value={f.allowedTools || ''} onChange={set('allowedTools')} placeholder="(default)" />
          </Field>
        </>
      )}
    </Modal>
  )
}

// Drop references to repos that were removed, and trim the commands.
function cleanIntegration(integ = {}, repos) {
  const ids = new Set(repos.map((r) => r.id))
  const t = (s) => (s || '').trim()
  return {
    command: t(integ.command),
    beforeCommand: t(integ.beforeCommand),
    afterCommand: t(integ.afterCommand),
    cwd: integ.cwd && integ.cwd !== 'task' && ids.has(integ.cwd) ? integ.cwd : 'task',
    testsRepoId: ids.has(integ.testsRepoId) ? integ.testsRepoId : '',
    runWhen: integ.runWhen === 'multi' ? 'multi' : 'always',
    timeoutMinutes: Math.min(120, Math.max(1, Number(integ.timeoutMinutes) || 20))
  }
}

const envName = (name) => String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'REPO'

function IntegrationSection({ value: v, repos, onChange }) {
  const [open, setOpen] = useState(!!v.command)
  const set = (k) => (e) => onChange({ [k]: e.target.value })
  const on = !!v.command?.trim()
  return (
    <div className={`integration ${open ? 'open' : ''}`}>
      <button type="button" className="integration-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        <span className="field-label">Integration tests</span>
        <span className={`badge ${on ? 'done' : ''}`}>{on ? 'On' : 'Off'}</span>
        <span className="field-hint grow">End-to-end tests across repos, after each repo's own tests pass.</span>
      </button>
      {open && (
        <div className="integration-body">
          <Field label="Command" hint="Leave blank to turn integration tests off. Must exit 0 for a task to complete.">
            <input className="mono" value={v.command || ''} onChange={set('command')} placeholder="npx playwright test" />
          </Field>
          <div className="grid-2">
            <Field label="Before" hint="Optional. Runs first, every time (start services, build).">
              <input className="mono" value={v.beforeCommand || ''} onChange={set('beforeCommand')} placeholder="docker compose up -d --build" />
            </Field>
            <Field label="After" hint="Optional. Always runs, even if tests fail (clean up).">
              <input className="mono" value={v.afterCommand || ''} onChange={set('afterCommand')} placeholder="docker compose down" />
            </Field>
          </div>
          <div className="grid-3">
            <Field label="Run from">
              <select className="select" value={v.cwd || 'task'} onChange={set('cwd')}>
                <option value="task">Task folder (all repos)</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || 'unnamed'} repo
                  </option>
                ))}
              </select>
            </Field>
            <Field label="End-to-end tests live in">
              <select className="select" value={v.testsRepoId || ''} onChange={set('testsRepoId')}>
                <option value="">Not specified</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || 'unnamed'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Run">
              <select className="select" value={v.runWhen || 'always'} onChange={set('runWhen')}>
                <option value="always">For every task</option>
                <option value="multi">Only when 2+ repos change</option>
              </select>
            </Field>
          </div>
          <Field label="Timeout (minutes)">
            <input type="number" min={1} max={120} value={v.timeoutMinutes ?? 20} onChange={set('timeoutMinutes')} className="narrow" />
          </Field>
          <div className="env-help">
            <span className="field-label">Available to these commands</span>
            <code>KOMMIT_TASK_DIR</code> task folder · <code>KOMMIT_CHANGED_REPOS</code> changed repo names ·{' '}
            <code>KOMMIT_VERSION</code> · <code>KOMMIT_TASK_NUMBER</code>
            {repos.map((r) => (
              <span key={r.id}>
                {' · '}
                <code>KOMMIT_REPO_{envName(r.name || 'repo')}</code>
              </span>
            ))}
            <span className="field-hint">Each KOMMIT_REPO_* points at that repo's folder for the task (its worktree), so compose files and scripts can find every repo.</span>
          </div>
        </div>
      )}
    </div>
  )
}
