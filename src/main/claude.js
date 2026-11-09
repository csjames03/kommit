// Runs the Claude Code CLI headless (`claude -p`) and turns its stream-json
// output into simple log entries. Uses whatever login `claude` already has.
import { spawn } from 'node:child_process'
import { killTree } from './proc.js'

function shorten(s, n = 160) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Show paths relative to the working folder (before shortening, or the prefix gets cut off).
function relative(s, cwd) {
  if (!cwd) return s
  const prefix = cwd.replace(/[\\/]+$/, '')
  const re = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]?', process.platform === 'win32' ? 'gi' : 'g')
  return String(s).replace(re, '') || '.'
}

// One-line description of a tool call for the activity log.
export function describeTool(name, input = {}, cwd) {
  const target =
    input.file_path || input.path || input.command || input.pattern || input.url || input.description || ''
  return target ? `${name}: ${shorten(relative(target, cwd), 140)}` : name
}

// Convert one stream-json message into zero or more log entries.
// `hidden` collects ids of internal tool calls (structured output) whose results we don't show.
export function toLogEntries(msg, hidden = new Set(), cwd) {
  const out = []
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text.trim()) out.push({ kind: 'text', text: block.text.trim() })
      if (block.type === 'tool_use') {
        if (block.name === 'StructuredOutput') {
          hidden.add(block.id)
          continue
        }
        out.push({ kind: 'tool', text: describeTool(block.name, block.input, cwd) })
      }
    }
  } else if (msg.type === 'user') {
    for (const block of msg.message?.content || []) {
      if (block.type === 'tool_result' && block.is_error && !hidden.has(block.tool_use_id)) {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text || '').join(' ')
          : block.content
        out.push({ kind: 'error', text: shorten(relative(text, cwd), 300) })
      }
    }
  } else if (msg.type === 'result') {
    const cost = msg.total_cost_usd != null ? ` · $${msg.total_cost_usd.toFixed(3)}` : ''
    const secs = msg.duration_ms != null ? ` · ${Math.round(msg.duration_ms / 1000)}s` : ''
    out.push({
      kind: msg.is_error ? 'error' : 'info',
      text: `Stage finished (${msg.subtype}${secs}${cost})`
    })
  }
  return out
}

/**
 * Run one Claude Code session.
 * @returns {{ promise: Promise<{sessionId, output, text, costUsd, isError, subtype}>, stop: () => void }}
 */
export function runClaude({
  cwd,
  prompt,
  claudePath = 'claude',
  allowedTools = [],
  permissionMode = 'dontAsk',
  schema,
  systemPrompt,
  resume,
  model,
  maxTurns,
  onLog = () => {}
}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode]
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools)
  if (schema) args.push('--json-schema', JSON.stringify(schema))
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
  if (resume) args.push('--resume', resume)
  if (model) args.push('--model', model)
  if (maxTurns) args.push('--max-turns', String(maxTurns))

  // Don't let the child think it's nested inside another Claude Code session.
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

  const child = spawn(claudePath, args, { cwd, env, windowsHide: true })
  let stopped = false

  const promise = new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    let sessionId = resume || null
    let result = null
    const hidden = new Set()

    child.on('error', (err) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(`Couldn't find the Claude Code CLI ("${claudePath}"). Set its path in Settings.`)
          : err
      )
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.session_id) sessionId = msg.session_id
        if (msg.type === 'result') result = msg
        for (const entry of toLogEntries(msg, hidden, cwd)) onLog(entry)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => (stderr += c))

    child.on('close', (code) => {
      if (stopped) return reject(Object.assign(new Error('Stopped'), { stopped: true }))
      if (!result) {
        return reject(new Error(`Claude exited (code ${code}) without a result. ${shorten(stderr, 600)}`))
      }
      resolve({
        sessionId,
        output: result.structured_output ?? null,
        text: result.result ?? '',
        costUsd: result.total_cost_usd || 0,
        isError: !!result.is_error,
        subtype: result.subtype
      })
    })

    child.stdin.end(prompt)
  })

  return {
    promise,
    stop() {
      stopped = true
      killTree(child)
    }
  }
}
