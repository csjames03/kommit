// Prompts and output schemas for each pipeline stage.

export const SYSTEM_PROMPT = [
  'You are running inside "Kommit", an autonomous task pipeline.',
  'No human is watching this session, so never ask questions: make sensible decisions and state any assumptions in your summary.',
  'Stay inside the current working directory.',
  'Never commit, push, merge, create branches or change git config. The app handles git.'
].join(' ')

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(ls *)']

export const DEFAULT_BUILD_TOOLS =
  'Read Edit Write Glob Grep Bash(cd *) Bash(npm *) Bash(npx *) Bash(node *) Bash(pnpm *) Bash(yarn *) Bash(git status *) Bash(git diff *) Bash(git log *) Bash(ls *)'

// Split "Read Edit Bash(npm *)" into ["Read", "Edit", "Bash(npm *)"], keeping parentheses intact.
export function parseToolList(s) {
  return (String(s || '').match(/[A-Za-z_]+(\([^)]*\))?/g) || []).filter(Boolean)
}

const str = { type: 'string' }
const strList = { type: 'array', items: { type: 'string' } }

export const SCHEMAS = {
  plan: {
    type: 'object',
    properties: {
      summary: { ...str, description: 'One or two sentences: what will be done.' },
      repos: { ...strList, description: 'Names of the repositories this task must change, exactly as listed.' },
      contract: {
        ...str,
        description:
          'When more than one repository changes: the exact interface between them (endpoints, request and response shapes, shared types, events). Empty string otherwise.'
      },
      steps: { ...strList, description: 'Ordered, concrete implementation steps. Prefix each with its repository name when there are several.' },
      files: { ...strList, description: 'Files likely to be created or changed.' },
      risks: { ...strList, description: 'Risks, open questions and assumptions.' }
    },
    required: ['summary', 'repos', 'contract', 'steps', 'files', 'risks']
  },
  build: {
    type: 'object',
    properties: {
      summary: { ...str, description: 'What you changed and why, including which tests you added.' },
      files: { ...strList, description: 'Files you created or changed.' },
      testCommands: {
        type: 'array',
        description:
          'For each changed repository that had no test command configured: the shell command that runs its tests, run from inside that repository folder (e.g. "npm test"). Empty array if every changed repository already had one.',
        items: {
          type: 'object',
          properties: { repo: { ...str, description: 'Repository name, exactly as listed.' }, command: str },
          required: ['repo', 'command']
        }
      }
    },
    required: ['summary', 'files', 'testCommands']
  },
  review: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
      summary: str,
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
            file: str,
            description: str
          },
          required: ['severity', 'description']
        }
      }
    },
    required: ['verdict', 'summary', 'issues']
  },
  docs: {
    type: 'object',
    properties: {
      summary: { ...str, description: 'Docs you changed, or why none were needed.' },
      files: strList
    },
    required: ['summary', 'files']
  },
  update: {
    type: 'object',
    properties: {
      updateMessage: {
        ...str,
        description: 'A short status update for a teammate or standup, in Markdown: what changed (per repository if several), why, and how it was tested.'
      },
      commitMessage: {
        ...str,
        description: 'A git commit message: a subject line under 72 characters, a blank line, then a short body.'
      }
    },
    required: ['updateMessage', 'commitMessage']
  },
  releaseNotes: {
    type: 'object',
    properties: { notes: { ...str, description: 'Release notes in Markdown.' } },
    required: ['notes']
  }
}

/**
 * ctx: { multi, version, repos: [{ name, folder, role, affected, base }] }
 */
function header(task, project, ctx) {
  let s = `# Task #${task.number}: ${task.title}\n\n${task.description || '(no description)'}\n`
  if (ctx.version) s += `\nTarget version: ${ctx.version.name}\n`
  if (project.notes) s += `\n## Workspace notes\n${project.notes}\n`
  if (ctx.multi) {
    s += '\n## Repositories\nYour working directory has one folder per repository:\n'
    for (const r of ctx.repos) s += `- \`${r.folder}/\` (repository "${r.name}")${r.role ? `: ${r.role}` : ''}\n`
    s +=
      'Each repository may have its own CLAUDE.md with rules. Read it before changing that repository.\n' +
      'To run a command in one repository, point the tool at its folder (e.g. `npm --prefix backend test`). Chained commands like `cd x && …` may be blocked, and file edits should use the Edit and Write tools.\n'
  }
  return s
}

function planBlock(plan, ctx) {
  if (!plan) return ''
  const parts = ['\n## Plan', plan.summary]
  if (ctx.multi && plan.repos?.length) parts.push(`\nRepositories to change: ${plan.repos.join(', ')}`)
  if (plan.contract?.trim()) parts.push(`\n### Contract between repositories (both sides must match this exactly)\n${plan.contract}`)
  parts.push('', ...plan.steps.map((s, i) => `${i + 1}. ${s}`))
  if (plan.risks?.length) parts.push('\nRisks/assumptions:\n' + plan.risks.map((r) => `- ${r}`).join('\n'))
  return parts.join('\n')
}

export function planPrompt(task, project, ctx) {
  const which = ctx.multi
    ? `Decide which repositories this task needs to change${task.repoIds?.length ? ' (only the repositories listed above are in scope)' : ''}, and only list those in "repos". When more than one repository changes, define the contract between them precisely so each side can be built to match.`
    : `Put "${ctx.repos[0]?.name}" in "repos" and leave "contract" empty.`
  return `${header(task, project, ctx)}
You are in the PLANNING stage. Explore the code to understand how it is organized and how this task fits in.
${which}
Do not modify any files. Produce a concrete, step-by-step implementation plan that a developer could follow.
Include the tests to write as steps: which kinds (unit, API, security, UI, accessibility) and what they check. If a repository you'll change has no test setup, include setting one up.`
}

export function formatMissingTestsFeedback(names, multi) {
  return `${multi ? `These repositories have` : 'This repository has'} no way to run tests: ${names.join(', ')}.
Set up a test setup that fits the stack, write tests for this change, and report the command in "testCommands".`
}

// What kinds of tests fit which work. Shared by the build and review prompts.
const TESTING_GUIDE = `Write tests that fit the work. Pick what applies:
- Unit tests for new or changed logic, including edge cases and error paths.
- API / backend tests for endpoints: status codes, response shapes, validation errors.
- Security tests where input, auth or data access is involved: rejected bad input, injection attempts, unauthorized access, no leaked secrets or internal errors.
- UI tests for components and screens: rendering, user interaction, states (loading, empty, error).
- Accessibility and usability checks for UI: labels, roles, keyboard use.
- End-to-end tests (e.g. Playwright) only when the task is a user flow across pages and the repository already has, or clearly needs, that setup.
Tests must exercise the real behavior and fail if the feature breaks.`

function testSetupLines(project, ctx) {
  const lines = []
  for (const r of ctx.repos) {
    const repo = project.repos.find((x) => x.id === r.id)
    const where = ctx.multi ? `"${r.name}"` : 'This repository'
    if (repo?.skipTests) continue
    if (repo?.testCommand?.trim()) lines.push(`- ${where}: tests run with \`${repo.testCommand}\`. Add or update tests there for your change.`)
    else if (r.testCommand) lines.push(`- ${where}: tests run with \`${r.testCommand}\` (set up in an earlier attempt). Add or update tests there for your change.`)
    else
      lines.push(
        `- ${where}: has NO test command configured. If you change it: use its existing test setup if it has one; otherwise set one up that fits its stack, preferring lightweight tools (e.g. Vitest + Testing Library for Vite/Vue/React, node:test or Vitest with supertest for Node APIs, pytest for Python). Install dev dependencies with the package manager, add a "test" script, write the tests, and report the command in "testCommands".`
      )
  }
  return (lines.length ? `\n## Tests\n${lines.join('\n')}\n\n${TESTING_GUIDE}\n` : '') + integrationLines(project, ctx)
}

// Tell Claude about the workspace's end-to-end suite, if there is one.
function integrationLines(project, ctx) {
  const integ = project.integration
  if (!integ?.command?.trim()) return ''
  const where = integ.cwd && integ.cwd !== 'task' ? `from the "${project.repos.find((r) => r.id === integ.cwd)?.name}" repository` : 'from the task folder'
  let s = `\n## Integration tests\nAfter every changed repository's own tests pass, the app runs the workspace integration tests ${where}: \`${integ.command}\`${
    integ.beforeCommand?.trim() ? ` (after \`${integ.beforeCommand}\`)` : ''
  }. They exercise the repositories together, and the task only completes if they pass.\n`
  const home = project.repos.find((r) => r.id === integ.testsRepoId)
  if (home) {
    const inScope = ctx.repos.some((r) => r.id === home.id)
    s += inScope
      ? `End-to-end tests live in "${home.name}". When this task changes behavior that crosses repositories or a user flow, add or update end-to-end tests there.\n`
      : `End-to-end tests live in "${home.name}", which is not part of this task, so don't edit it.\n`
  }
  return s
}

// Readable exit codes. Windows reports crashes as big NTSTATUS values (e.g. 3221226505 = 0xC0000409).
export function exitLabel(code) {
  if (typeof code === 'number' && code >= 0xc0000000) return `0x${code.toString(16).toUpperCase()} (the process crashed)`
  return String(code)
}

export function formatIntegrationFeedback(result) {
  const failedStep = result.beforeFailed ? `The command that prepares them (\`${result.beforeCommand}\`)` : `The command \`${result.command}\``
  return `The workspace integration tests failed. ${failedStep} exited with code ${exitLabel(result.code)}${result.timedOut ? ' (timed out)' : ''}. Output (last part):

\`\`\`
${(result.output || '').slice(-6000)}
\`\`\`

Find the cause in the repositories you changed and fix it. If an end-to-end test needs to change because the behavior intentionally changed, update it.`
}

export function buildPrompt(task, project, ctx, feedback) {
  const base = `${header(task, project, ctx)}${planBlock(task.outputs.plan, ctx)}\n${testSetupLines(project, ctx)}`
  if (!feedback) {
    return `${base}
You are in the BUILD stage. Implement the plan above and its tests. Follow each repository's existing code style and conventions.
You may run builds, linters or tests to check your work. The app runs the test commands itself after review, and the task only completes if they pass.`
  }
  return `${base}
You are in the BUILD stage again because the previous attempt had problems. Fix them:

${feedback}

Change only what is needed to fix these problems, and keep the rest of the work intact.`
}

const MAX_DIFF = 60000

export function reviewPrompt(task, project, ctx, diffs) {
  let diffText = ''
  for (const d of diffs) {
    const label = ctx.multi ? `Repository "${d.name}" (folder \`${d.folder}/\`)` : 'Changes'
    diffText += `\n### ${label}\n${d.stat}\n\n\`\`\`diff\n${d.patch}\n\`\`\`\n`
  }
  if (diffText.length > MAX_DIFF) diffText = diffText.slice(0, MAX_DIFF) + '\n…(diff truncated; read the changed files for the rest)\n'
  if (!diffs.length) diffText = `\nThe developer reported changing: ${(task.outputs.build?.files || []).join(', ') || '(nothing)'}. Read those files.\n`
  return `${header(task, project, ctx)}${planBlock(task.outputs.plan, ctx)}

Developer's summary: ${task.outputs.build?.summary || '(none)'}

## The change
${diffText}
You are the CODE REVIEWER for this change. You did not write it. Read surrounding code where you need context.
Check that it does what the task asks, has no bugs, does not break existing behavior, and has no security problems.
Check that new or changed behavior is covered by meaningful tests of the right kind (unit, API, security, UI, accessibility, as fits the change). Missing tests for new behavior, or tests that can't fail, are a "major" issue.${
    project.integration?.testsRepoId && ctx.repos.some((r) => r.id === project.integration.testsRepoId) && ctx.multi
      ? `\nBehavior that crosses repositories or forms a user flow should have an end-to-end test in "${project.repos.find((r) => r.id === project.integration.testsRepoId)?.name}" when practical. Missing one is a "minor" issue, unless the task is mainly that flow, in which case it is "major".`
      : ''
  }${
    ctx.multi ? '\nCheck that every repository matches the contract: the same routes, field names, types and error shapes on both sides.' : ''
  }
Use verdict "changes_requested" only for blocker or major problems. Style nits are "minor" and should not block.
Do not modify any files.`
}

export function docsPrompt(task, project, ctx) {
  return `${header(task, project, ctx)}
Changes made: ${task.outputs.build?.summary || ''}

The change passed review and tests. You are in the DOCS stage.
Update documentation affected by this change in each changed repository: README, docs folders, code comments, and CHANGELOG.md where one exists.
Keep it proportional. If nothing needs documenting, change nothing and say so.
Do not change application code in this stage.`
}

export function updatePrompt(task, project, ctx) {
  const review = task.outputs.review
  const test = task.outputs.test
  const tests = !test
    ? 'n/a'
    : test.repos?.length
      ? test.repos.map((r) => `${r.name}: ${r.skipped ? 'no test command' : r.passed ? `passed (${r.command})` : 'failed'}`).join('; ')
      : 'no repositories changed'
  return `${header(task, project, ctx)}
Changes: ${task.outputs.build?.summary || ''}
Docs: ${task.outputs.docs?.summary || ''}
Review: ${review ? `${review.verdict} - ${review.summary}` : 'n/a'}
Tests: ${tests}

You are in the UPDATE stage. Do not use any tools. Write the status update and the commit message for this work.`
}

export function releaseNotesPrompt(project, version, tasks) {
  const items = tasks
    .map((t) => `## #${t.number} ${t.title}\n${t.outputs?.update?.updateMessage || t.outputs?.build?.summary || t.description || ''}`)
    .join('\n\n')
  return `Write release notes for version ${version.name} of "${project.name}".
They are for the team and stakeholders: group changes under headings such as Features, Fixes and Improvements, one short bullet per change, in plain language.
Mention which part of the product (${project.repos.map((r) => r.name).join(', ')}) a change affects when it helps.
Do not use any tools.

Completed tasks in this version:

${items}`
}

export function formatReviewFeedback(review) {
  const lines = (review.issues || [])
    .filter((i) => i.severity !== 'minor')
    .map((i) => `- [${i.severity}] ${i.file ? i.file + ': ' : ''}${i.description}`)
  return `Code review requested changes: ${review.summary}\n${lines.join('\n')}`
}

export function formatTestFeedback(failed, multi) {
  return failed
    .map(
      (r) =>
        `${multi ? `Repository "${r.name}": ` : ''}the test command \`${r.command}\` failed (exit code ${exitLabel(r.code)}). Output (last part):\n\n\`\`\`\n${r.output.slice(-6000)}\n\`\`\``
    )
    .join('\n\n')
}

export function formatConflictFeedback(conflicts, multi) {
  const list = conflicts
    .map((c) => `${multi ? `Repository "${c.name}" (folder \`${c.folder}/\`), ` : ''}merging \`${c.base}\`:\n${c.files.map((f) => `- ${f}`).join('\n')}`)
    .join('\n\n')
  return `The latest changes from the base branch were merged into this task and caused conflicts:

${list}

Open each file, resolve every conflict marker (<<<<<<<, =======, >>>>>>>) so the result keeps the intent of both sides, and make sure nothing else breaks.
Do not run git commands to abort or finish the merge. Just edit the files.`
}
