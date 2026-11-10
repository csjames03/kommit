import { spawn, execFile } from 'node:child_process'

// Kill a child and everything it started (npm test spawns its own children).
export function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/**
 * Run a shell command (e.g. "npm test") and collect its output.
 * @returns {{ promise: Promise<{code, output, timedOut}>, stop: () => void }}
 */
export function runShell(command, { cwd, env = {}, timeoutMs = 10 * 60 * 1000, onData = () => {} } = {}) {
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0', ...env }
  })
  let stopped = false
  const promise = new Promise((resolve, reject) => {
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const collect = (chunk) => {
      const s = chunk.toString()
      output += s
      if (output.length > 200_000) output = output.slice(-200_000)
      onData(s)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stopped) return reject(Object.assign(new Error('Stopped'), { stopped: true }))
      resolve({ code: timedOut ? -1 : code, output, timedOut })
    })
  })
  return {
    promise,
    stop() {
      stopped = true
      killTree(child)
    }
  }
}
