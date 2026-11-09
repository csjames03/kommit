// Theme preference: 'system' | 'light' | 'dark'. A per-machine convenience, so localStorage is fine.
const KEY = 'kommit-theme'

export function getTheme() {
  try {
    return localStorage.getItem(KEY) || 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // storage unavailable: theme still applies for this session
  }
}
