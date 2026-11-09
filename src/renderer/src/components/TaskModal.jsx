import { useState } from 'react'
import Modal, { Field } from './Modal.jsx'

export default function TaskModal({ task, project, defaultVersionId, onSave, onClose }) {
  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const [versionId, setVersionId] = useState(task ? task.versionId || '' : defaultVersionId || '')
  const [repoIds, setRepoIds] = useState(task?.repoIds || [])
  const [autoStart, setAutoStart] = useState(false)
  const started = task && task.status !== 'todo'
  const valid = title.trim().length > 0
  const repos = project?.repos || []
  const versions = (project?.versions || []).filter((v) => v.status !== 'released' || v.id === task?.versionId)

  const toggleRepo = (id) => setRepoIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const submit = (e) => {
    e?.preventDefault()
    if (!valid) return
    const input = { title: title.trim(), description: description.trim() }
    if (!started) Object.assign(input, { versionId: versionId || null, repoIds })
    if (!task) input.autoStart = autoStart
    onSave(input, task?.id)
  }

  return (
    <Modal
      title={task ? `Edit task #${task.number}` : 'New task'}
      onClose={onClose}
      wide
      footer={
        <>
          {!task && (
            <label className="check">
              <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
              Start right away
            </label>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={submit}>
            {task ? 'Save' : 'Create task'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Title">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a wishlist to product pages" />
        </Field>
        <Field label="Description" hint="Be specific: what should happen, where, acceptance criteria, edge cases. This is all Claude gets.">
          <textarea
            rows={8}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && submit(e)}
            placeholder={'- Heart button on product cards and the product page\n- Saved per user via a new API endpoint\n- Wishlist page lists saved items'}
          />
        </Field>

        <div className="grid-2">
          <Field label="Version" hint={started ? "Can't change after the task has started." : versionId ? 'The task branches from this version and merges back into it.' : "Branches from each repo's current branch."}>
            <select className="select" value={versionId} disabled={started} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">No version</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          {repos.length > 1 && (
            <div className="field">
              <span className="field-label">Repositories</span>
              <div className="chip-picker" role="group" aria-label="Repositories">
                <button type="button" className={`pick ${repoIds.length === 0 ? 'on' : ''}`} disabled={started} onClick={() => setRepoIds([])}>
                  Auto
                </button>
                {repos.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className={`pick ${repoIds.includes(r.id) ? 'on' : ''}`}
                    disabled={started}
                    aria-pressed={repoIds.includes(r.id)}
                    onClick={() => toggleRepo(r.id)}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
              <span className="field-hint">{repoIds.length ? 'Only these repos are in scope.' : 'The planner decides which repos to change.'}</span>
            </div>
          )}
        </div>
      </form>
    </Modal>
  )
}
