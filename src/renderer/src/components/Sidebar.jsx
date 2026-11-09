import Icon from './Icon.jsx'

// Stable hue per workspace so each gets its own avatar color.
function hue(s) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export default function Sidebar({ projects, tasks, activeId, onSelect, onAdd, onSettings }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo-mark" aria-hidden="true">
          <Icon name="merge" size={18} />
        </div>
        <div className="brand-text">
          <div className="brand-name">Kommit</div>
          <div className="brand-tag">Tasks in, commits out</div>
        </div>
      </div>

      <nav className="sidebar-section" aria-label="Workspaces">
        <div className="sidebar-label">Workspaces</div>
        {projects.map((p) => {
          const mine = tasks.filter((t) => t.projectId === p.id)
          const live = mine.some((t) => t.status === 'running' || t.status === 'queued')
          const attention = mine.some((t) => t.status === 'needs_attention' || t.status === 'failed')
          const open = mine.filter((t) => t.status !== 'done').length
          return (
            <button
              key={p.id}
              className={`project-item ${p.id === activeId ? 'active' : ''}`}
              aria-current={p.id === activeId ? 'page' : undefined}
              onClick={() => onSelect(p.id)}
            >
              <span className="avatar" style={{ '--h': hue(p.name) }} aria-hidden="true">
                {p.name.slice(0, 1).toUpperCase()}
                {(live || attention) && <span className={`avatar-dot ${live ? 'live' : 'warn'}`} />}
              </span>
              <span className="project-name">
                <span className="project-title">{p.name}</span>
                <span className="project-sub">
                  {p.repos.length} repo{p.repos.length === 1 ? '' : 's'}
                  {live ? ' · working' : attention ? ' · needs you' : ''}
                </span>
              </span>
              {open > 0 && <span className="count">{open}</span>}
            </button>
          )
        })}
        <button className="project-item add" onClick={onAdd}>
          <span className="avatar ghost" aria-hidden="true">
            <Icon name="plus" size={14} />
          </span>
          New workspace
        </button>
      </nav>

      <div className="sidebar-foot">
        <button className="btn ghost sm" onClick={onSettings}>
          <Icon name="sliders" /> Settings
        </button>
      </div>
    </aside>
  )
}
