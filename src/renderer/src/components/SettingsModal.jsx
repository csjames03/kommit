import { useState } from 'react'
import Modal, { Field } from './Modal.jsx'
import Icon from './Icon.jsx'
import { applyTheme, getTheme } from '../theme.js'

const THEMES = [
  ['system', 'System', 'monitor'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon']
]

export default function SettingsModal({ settings, onSave, onClose }) {
  const [claudePath, setClaudePath] = useState(settings.claudePath || '')
  const [concurrency, setConcurrency] = useState(settings.concurrency || 1)
  const [theme, setTheme] = useState(getTheme())

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave({ claudePath: claudePath.trim(), concurrency: Number(concurrency) || 1 })}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Appearance</span>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEMES.map(([key, label, icon]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={theme === key}
              className={theme === key ? 'on' : ''}
              onClick={() => {
                setTheme(key)
                applyTheme(key) // applies right away
              }}
            >
              <Icon name={icon} /> {label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Claude Code CLI path" hint="Leave blank to use `claude` from your PATH.">
        <input className="mono" value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder="claude" />
      </Field>
      <Field label="Tasks running at once" hint="Each running task is its own Claude session, so more means faster and pricier.">
        <input type="number" min={1} max={6} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
      </Field>
    </Modal>
  )
}
