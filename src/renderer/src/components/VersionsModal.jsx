import { useState } from 'react'
import Modal, { Field } from './Modal.jsx'
import Markdown from './Markdown.jsx'
import { VERSION_STATUS, branchFor, uid } from '../constants.js'
import Icon from './Icon.jsx'

const api = window.api

export default function VersionsModal({ project, tasks, onProjectChange, onClose }) {
  const [editing, setEditing] = useState(null) // version object being edited
  const versions = project.versions || []

  async function saveVersions(next) {
    onProjectChange(await api.updateProject(project.id, { versions: next }))
  }

  if (editing) {
    return (
      <VersionEditor
        project={project}
        version={editing}
        tasks={tasks.filter((t) => t.versionId === editing.id)}
        onBack={() => setEditing(null)}
        onClose={onClose}
        onSave={async (v) => {
          await saveVersions(versions.some((x) => x.id === v.id) ? versions.map((x) => (x.id === v.id ? v : x)) : [...versions, v])
          setEditing(null)
        }}
        onDelete={async (id) => {
          await saveVersions(versions.filter((x) => x.id !== id))
          setEditing(null)
        }}
        onProjectChange={onProjectChange}
      />
    )
  }

  return (
    <Modal
      title="Versions"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="field-hint">Each version has a branch in every repo. Task branches start from it and merge back into it.</span>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={() => setEditing({ id: uid(), name: '', status: 'active', branchPattern: 'release/{version}', createFrom: 'main', branches: {}, autoMerge: false, isNew: true })}
          >
            <Icon name="plus" /> New version
          </button>
        </>
      }
    >
      {!versions.length && <div className="empty">No versions yet. Create one to group tasks by release.</div>}
      <div className="version-list">
        {versions.map((v) => {
          const mine = tasks.filter((t) => t.versionId === v.id)
          const done = mine.filter((t) => t.status === 'done').length
          const merged = mine.filter((t) => t.merged).length
          return (
            <button key={v.id} className="version-item" onClick={() => setEditing(v)}>
              <div className="version-item-top">
                <Icon name="tag" />
                <strong>{v.name}</strong>
                <span className={`badge v-${v.status}`}>{VERSION_STATUS[v.status]}</span>
                {v.autoMerge && <span className="chip">auto-merge</span>}
                <span className="spacer" />
                <span className="muted small">
                  {done}/{mine.length} done · {merged} merged
                </span>
              </div>
              <div className="progress">
                <span style={{ width: mine.length ? `${(done / mine.length) * 100}%` : 0 }} />
              </div>
              <div className="version-branches">
                {project.repos.map((r) => (
                  <span key={r.id} className="mono small muted branch-line">
                    <Icon name="branch" size={12} /> {r.name}: {branchFor(v, r)}
                  </span>
                ))}
              </div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

function VersionEditor({ project, version, tasks, onBack, onClose, onSave, onDelete, onProjectChange }) {
  const [v, setV] = useState({ ...version, branches: { ...(version.branches || {}) } })
  const [confirm, setConfirm] = useState(false)
  const [notesState, setNotesState] = useState({ busy: false, error: null })
  const [copied, setCopied] = useState(false)
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const nameTaken = project.versions.some((x) => x.id !== v.id && x.name.trim().toLowerCase() === v.name.trim().toLowerCase())
  const valid = v.name.trim() && !nameTaken
  const done = tasks.filter((t) => t.status === 'done')
  const saved = project.versions.find((x) => x.id === v.id)

  async function generate() {
    setNotesState({ busy: true, error: null })
    try {
      const p = await api.generateReleaseNotes(project.id, v.id)
      onProjectChange(p)
      const fresh = p.versions.find((x) => x.id === v.id)
      setV((x) => ({ ...x, releaseNotes: fresh.releaseNotes, releaseNotesAt: fresh.releaseNotesAt }))
      setNotesState({ busy: false, error: null })
    } catch (e) {
      setNotesState({ busy: false, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    }
  }

  return (
    <Modal
      title={v.isNew ? 'New version' : `Version ${version.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          {!v.isNew &&
            (confirm ? (
              <span className="confirm">
                Delete version? Tasks keep their branches.
                <button className="btn danger sm" onClick={() => onDelete(v.id)}>
                  Delete
                </button>
                <button className="btn ghost sm" onClick={() => setConfirm(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="btn ghost danger-text" onClick={() => setConfirm(true)}>
                Delete version
              </button>
            ))}
          <span className="spacer" />
          <button className="btn ghost" onClick={onBack}>
            <Icon name="chevronLeft" /> Back
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => {
              const { isNew, ...rest } = v
              onSave({ ...rest, name: v.name.trim() })
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Version">
          <input autoFocus={v.isNew} value={v.name} onChange={set('name')} placeholder="v2.3" />
        </Field>
        <Field label="Status">
          <select className="select" value={v.status} onChange={set('status')}>
            {Object.entries(VERSION_STATUS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {nameTaken && <div className="alert error">There's already a version with this name.</div>}

      <div className="grid-2">
        <Field label="Branch pattern" hint="{version} is replaced by the version without a leading v (v2.3 → 2.3).">
          <input className="mono" value={v.branchPattern} onChange={set('branchPattern')} placeholder="release/{version}" />
        </Field>
        <Field label="Create missing branches from" hint="Used when a repo doesn't have the version branch yet.">
          <input className="mono" value={v.createFrom} onChange={set('createFrom')} placeholder="main" />
        </Field>
      </div>

      <div className="section-head">
        <span className="field-label">Branch in each repo</span>
        <span className="field-hint">Leave blank to use the pattern. Override when a repo is versioned differently.</span>
      </div>
      <div className="branch-table">
        {project.repos.map((r) => (
          <label key={r.id} className="branch-row">
            <span className="branch-repo">{r.name}</span>
            <input
              className="mono"
              value={v.branches[r.id] || ''}
              placeholder={branchFor({ ...v, branches: {} }, r)}
              onChange={(e) => setV((x) => ({ ...x, branches: { ...x.branches, [r.id]: e.target.value } }))}
            />
          </label>
        ))}
      </div>

      <label className="check">
        <input type="checkbox" checked={!!v.autoMerge} onChange={set('autoMerge')} />
        Merge tasks into this version automatically when they complete (never pushes)
      </label>

      {saved && (
        <>
          <div className="section-head notes-head">
            <span className="field-label">Release notes</span>
            <span className="spacer" />
            {v.releaseNotes && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  navigator.clipboard.writeText(v.releaseNotes)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            <button className="btn sm" disabled={notesState.busy || !done.length} onClick={generate}>
              {notesState.busy ? 'Writing…' : v.releaseNotes ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          <div className="field-hint">
            {done.length
              ? `Written by Claude from the ${done.length} completed task${done.length === 1 ? '' : 's'} in this version.`
              : 'Complete some tasks in this version first.'}
          </div>
          {notesState.error && <div className="alert error">{notesState.error}</div>}
          {v.releaseNotes && (
            <div className="card-block notes">
              <Markdown text={v.releaseNotes} />
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
