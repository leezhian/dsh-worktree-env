# Worktree enhancements

This bundle enhances DSH's built-in Git worktree support (the `create_worktree`
tool, the new-session worktree toggle, and the Forge diff/review panel) with
local environment orchestration and full lifecycle management. It layers on top
of the built-in service without replacing its entry points, and degrades cleanly
to direct Git commands if the experimental worktree service is disabled.

## What it adds

- **Local environments** — reads `.agents/environments/*.toml` inside each
  repository (alongside DSH's `.agents/worktrees`, isolated from `.codex/`),
  supporting per-platform `[setup]`/`[cleanup]` scripts (`default` / `darwin` /
  `linux` / `win32`) and `[[actions]]` quick commands with custom icons
  (`tool` / `run` / `debug` / `test`). When a worktree is created, `setup` runs
  automatically (configurable) with live streaming logs, and its POSIX
  environment-variable delta is captured and injected into subsequent action
  runs.
- **Handoff with uncommitted changes** — packages staged, unstaged, and
  untracked changes through a temporary Git index (without modifying the source
  checkout), creates the worktree, applies the changes inside it, and runs
  `setup`. Optionally runs `git fetch` first (`upstreamRefreshMode: best-effort`).
- **Patch backflow** — computes the worktree's changes (committed plus
  uncommitted, or uncommitted only) and merges them back onto the source
  checkout with `git apply --3way`, with a dry-run precheck that reports
  conflicts before writing.
- **Snapshot archiving** — before a worktree with uncommitted changes is
  archived or quota-cleaned, writes a hidden snapshot ref
  (`refs/dsh-worktree-env/snapshots/…`) so the checkout can be removed while
  keeping uncommitted work losslessly recoverable. Directories containing
  initialized submodules or nested repositories are never auto-destroyed.
- **Quota cleanup** — keeps at most `keepCount` (default `15`) active worktrees
  per repository, oldest-accessed first, while protecting worktrees used by
  pinned sessions, active sessions, or running setup/action processes.
- **Shell environment** — inside a managed worktree, model shell commands
  receive `DSH_WORKTREE_SOURCE_ROOT`, `DSH_WORKTREE_PATH`,
  `DSH_WORKTREE_BRANCH`, and `DSH_WORKTREE_ENV_FILE`.
- **Agent tools** — `worktree_handoff`, `worktree_setup`, `worktree_actions`,
  `worktree_apply_patch`, `worktree_archive`, `worktree_restore`.
- **Web UI** — a sidebar **Worktrees** panel with **Settings** (relative
  worktree directory synced with `@deepseek-ai/dsh-experimental-worktree`, fetch
  toggle, `keepCount`, delete confirmation, and a collapsible DSH-only managed
  worktrees list) and **Environments** (project list, read-only preview with
  available variables, and visual `.toml` editor), plus a right-sidebar quick
  actions tab and session menu items. All UI copy follows DSH's active language
  in real time.

## Configuration

Application-level settings are editable from the **Worktrees → Settings** tab
(and persisted under `$DSH_HOME/plugins/dsh-worktree-env/config.json`):
`worktreeDirectory` (synced to built-in `@deepseek-ai/dsh-experimental-worktree`),
`upstreamRefreshMode`, `keepCount`, and `confirmBeforeDelete`, alongside
advanced plugin config fields (`autoRunSetup`, `autoRunCleanup`,
`setupTimeoutMs`, `defaultCreationPreference`, `repositoryPreferences`,
`snapshotOnArchive`, `autoCleanupEnabled`).

Per-repository environment definitions live under `.agents/environments/*.toml`.
Set a repository-local Git config `dsh.localEnvironmentConfigPath` to point to
a custom file path, or set it to `__none__` to disable local environments for
that repository.

## Limits

- Environment-variable delta capture requires a POSIX shell (`env -0`); on
  Windows the scripts still run, but no delta is captured.
- Backflow applies patches against the source checkout's working tree; conflicts
  abort cleanly and are never silently overwritten.
- Snapshot refs live in the repository's object store; `git gc` retains them
  while the refs exist.
