import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Run git and return { code, stdout, stderr } without throwing.
export function gitRaw(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

// Run git and return stdout, throwing on failure.
export async function git(cwd, args) {
  const r = await gitRaw(cwd, args)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

export async function isGitRepo(dir) {
  return (await gitRaw(dir, ['rev-parse', '--is-inside-work-tree'])).stdout === 'true'
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  )
}

const refExists = async (cwd, ref) => (await gitRaw(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).code === 0
export const branchExists = (cwd, branch) => refExists(cwd, `refs/heads/${branch}`)

// The branch the repo has checked out (or the commit, if detached).
export async function currentBranch(repoPath) {
  const sym = await gitRaw(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return sym.code === 0 && sym.stdout ? sym.stdout : git(repoPath, ['rev-parse', 'HEAD'])
}

/**
 * Make sure a version branch exists. Uses the local branch, else origin/<branch>,
 * else creates it from `createFrom` (falling back to origin/<createFrom>, then HEAD).
 * @returns {{ branch, created: boolean, from?: string }}
 */
export async function ensureBranch(repoPath, branch, createFrom = 'main') {
  if (await branchExists(repoPath, branch)) return { branch, created: false }
  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    await git(repoPath, ['branch', branch, `origin/${branch}`])
    return { branch, created: true, from: `origin/${branch}` }
  }
  for (const from of [createFrom, `origin/${createFrom}`, 'HEAD']) {
    if (from && (await refExists(repoPath, from))) {
      await git(repoPath, ['branch', branch, from])
      return { branch, created: true, from }
    }
  }
  throw new Error(`Couldn't create ${branch}: the repo has no commits yet.`)
}

// Create (or reuse) a worktree at `dir` on `branch`, starting from `base` if the branch is new.
export async function ensureWorktree({ repoPath, dir, branch, base }) {
  if (fs.existsSync(path.join(dir, '.git'))) return dir
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  if (await branchExists(repoPath, branch)) await git(repoPath, ['worktree', 'add', dir, branch])
  else await git(repoPath, ['worktree', 'add', '-b', branch, dir, base])
  return dir
}

export async function removeWorktree(repoPath, dir) {
  const r = await gitRaw(repoPath, ['worktree', 'remove', '--force', dir])
  if (r.code !== 0 && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  await gitRaw(repoPath, ['worktree', 'prune'])
}

export async function deleteBranch(repoPath, branch, { force = false } = {}) {
  return (await gitRaw(repoPath, ['branch', force ? '-D' : '-d', branch])).code === 0
}

export const isMerging = async (dir) => (await gitRaw(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0

// What the task's changes are measured against: the incoming base during a merge, else the merge-base.
async function baseRef(dir, base) {
  if (await isMerging(dir)) return 'MERGE_HEAD'
  return git(dir, ['merge-base', 'HEAD', base])
}

// Commit whatever is in the worktree (finishing a merge if one is in progress).
export async function checkpoint(dir, message) {
  await git(dir, ['add', '-A'])
  if (await isMerging(dir)) {
    await git(dir, ['commit', '--no-edit'])
    return true
  }
  if ((await gitRaw(dir, ['diff', '--cached', '--quiet'])).code === 0) return false
  await git(dir, ['commit', '-m', message])
  return true
}

/**
 * Merge the latest base branch into the task branch. On conflict the merge is left
 * in progress so the conflict markers can be resolved.
 * @returns {{ ok: boolean, updated: boolean, files: string[] }}
 */
export async function syncWithBase(dir, base) {
  const before = await git(dir, ['rev-parse', 'HEAD'])
  const r = await gitRaw(dir, ['merge', '--no-edit', base])
  if (r.code === 0) return { ok: true, updated: before !== (await git(dir, ['rev-parse', 'HEAD'])), files: [] }
  const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
  if (!files.length) throw new Error(`Couldn't merge ${base}: ${r.stderr || r.stdout}`)
  return { ok: false, updated: false, files }
}

// Has this worktree changed anything compared with its base?
export async function changedFromBase(dir, base) {
  await git(dir, ['add', '-A'])
  return (await gitRaw(dir, ['diff', '--cached', '--quiet', await baseRef(dir, base)])).code !== 0
}

// The task's full diff against its base (committed and uncommitted).
export async function diffFromBase(dir, base) {
  await git(dir, ['add', '-A'])
  const ref = await baseRef(dir, base)
  return {
    stat: await git(dir, ['diff', '--cached', '--stat', ref]),
    patch: await git(dir, ['diff', '--cached', ref])
  }
}

// Squash everything since the base into one commit. Returns the short sha, or null if nothing changed.
export async function squashCommit(dir, base, message) {
  await checkpoint(dir, message)
  const mb = await git(dir, ['merge-base', 'HEAD', base])
  if ((await gitRaw(dir, ['diff', '--quiet', mb, 'HEAD'])).code === 0) return null
  await git(dir, ['reset', '--soft', mb])
  await git(dir, ['commit', '-m', message])
  return git(dir, ['rev-parse', '--short', 'HEAD'])
}

// Would merging `source` into `target` conflict? Touches nothing.
export async function canMerge(repoPath, target, source) {
  const r = await gitRaw(repoPath, ['merge-tree', '--write-tree', '--name-only', target, source])
  if (r.code === 0) return { ok: true, files: [] }
  if (r.code === 1) {
    const [, ...rest] = r.stdout.split('\n')
    const end = rest.indexOf('')
    return { ok: false, files: (end >= 0 ? rest.slice(0, end) : rest).filter(Boolean) }
  }
  throw new Error(`git merge-tree failed: ${r.stderr || r.stdout}`)
}

async function worktreeFor(repoPath, branch) {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  for (const block of out.split(/\n\s*\n/)) {
    const dir = block.match(/^worktree (.+)$/m)?.[1]
    if (dir && block.split('\n').some((l) => l.trim() === `branch refs/heads/${branch}`)) return dir
  }
  return null
}

/**
 * Merge `source` into `target`. Uses the worktree that has `target` checked out
 * (refusing if it has uncommitted changes), or a temporary worktree otherwise.
 * @returns {{ ok: boolean, sha?: string, files: string[] }}
 */
export async function mergeInto({ repoPath, target, source, message, tmpRoot }) {
  let dir = await worktreeFor(repoPath, target)
  let temp = null
  if (dir) {
    const dirty = await git(dir, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty) throw new Error(`${path.basename(repoPath)} has uncommitted changes on ${target}. Commit or stash them, then merge again.`)
  } else {
    temp = dir = path.join(tmpRoot, 'merge-' + crypto.randomBytes(4).toString('hex'))
    fs.mkdirSync(tmpRoot, { recursive: true })
    await git(repoPath, ['worktree', 'add', dir, target])
  }
  try {
    const args = ['merge', '--no-edit']
    if (message) args.push('-m', message)
    const r = await gitRaw(dir, [...args, source])
    if (r.code !== 0) {
      const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
      await gitRaw(dir, ['merge', '--abort'])
      return { ok: false, files }
    }
    return { ok: true, sha: await git(dir, ['rev-parse', '--short', 'HEAD']), files: [] }
  } finally {
    if (temp) await removeWorktree(repoPath, temp)
  }
}
