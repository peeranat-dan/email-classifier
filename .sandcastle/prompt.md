# TASK

Implement GitHub issue #{{ISSUE_NUMBER}}.

You are on branch `{{BRANCH}}`, already created from the base branch.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

This is a pnpm workspace. The Firebase Cloud Functions code lives in `functions/`.
Read `README.md` for the project overview, then explore the relevant source files
and tests before editing.

# EXECUTION

1. Write a failing test where a test seam already exists.
2. Implement the smallest correct change.
3. Refactor if needed.

Before committing, make sure all of these pass from the repo root:

- `pnpm lint`
- `pnpm format:check` (run `pnpm format` to fix)
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

# COMMIT

Make one or more commits on `{{BRANCH}}` using Conventional Commits
(e.g. `feat: ...`, `fix: ...`), since commitlint enforces them.

Do not push the branch.
Do not close the issue.
Do not edit labels.
Do not create or edit pull requests.

When complete, output `<promise>COMPLETE</promise>`.
