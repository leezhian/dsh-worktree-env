# Worktree enhancements

This bundle enhances the built-in Git worktree support (the `create_worktree`
tool, the new-session worktree toggle, and the Forge diff/review panel) with
the capabilities the built-in service does not provide. It never replaces
those entry points; it layers on top of them and keeps working, with reduced
functionality, even when the experimental worktree service is disabled.

## What it adds

- **Local environments** — reads `.dsh/environments/environment.toml` (or
  `.codex/environments/environment.toml`, 100% schema compatible) with
  per-platform `[setup]`/`[cleanup]` scripts and `[[actions]]` quick commands.
  When a worktree is created, `setup` runs automatically (configurable), with
  live streaming logs, and the environment-variable delta it produces is
  captured and injected into later action runs.
- **Handoff with uncommitted changes** — packages the current checkout's
  staged, unstaged, and untracked changes (through a temporary Git index, so
  the source checkout is never touched), creates the worktree, applies the
  changes inside it, and runs `setup`. Optionally refreshes the upstream first
  (`upstreamRefreshMode: best-effort`).
- **Patch backflow** — computes the worktree's changes (committed plus
  uncommitted, or uncommitted only) and applies them back onto the source
  checkout with `git apply --3way`, with a dry-run precheck that reports
  potential conflicts.
- **Snapshot archiving** — before a worktree with uncommitted changes is
  archived or quota-cleaned, writes a hidden snapshot ref
  (`refs/dsh-worktree-env/snapshots/…`) so the directory can be released while the
  uncommitted work stays recoverable. Directories containing initialized
  submodules or nested repositories are never auto-destroyed.
- **Quota cleanup** — keeps at most `keepCount` (default 15) unarchived
  worktrees per repository, oldest-accessed first, skipping worktrees referenced
  by live sessions or with running setup/action processes.
- **Shell environment** — inside a managed worktree, model shell commands
  receive `DSH_WORKTREE_SOURCE_ROOT`, `DSH_WORKTREE_PATH`,
  `DSH_WORKTREE_BRANCH`, and `DSH_WORKTREE_ENV_FILE`.
- **Agent tools** — `worktree_handoff`, `worktree_setup`, `worktree_actions`,
  `worktree_apply_patch`, `worktree_archive`, `worktree_restore`.
- **Web panel** — a sidebar panel (“Worktrees”) with a cross-project worktree
  list and a visual `environment.toml` editor, a right-sidebar tab with quick
  actions and setup status for worktree sessions, and session menu entries for
  handoff / backflow / archiving.

## Configuration

Application-level configuration lives in this plugin row's `config`:
`autoRunSetup`, `autoRunCleanup`, `setupTimeoutMs`, `upstreamRefreshMode`,
`defaultCreationPreference`, `repositoryPreferences`, `snapshotOnArchive`,
`autoCleanupEnabled`, `keepCount`, `confirmBeforeDelete`.

Per-repository environment definitions live in the repository itself, under
`.dsh/environments/environment.toml` or `.codex/environments/environment.toml`;
a repository-local Git config `dsh.localEnvironmentConfigPath` (or
`codex.localEnvironmentConfigPath`) can point somewhere else, or disable the
feature with `__none__`.

## Limits

- Environment-variable delta capture requires a POSIX shell (`env -0`); on
  Windows the scripts still run, but nothing is captured.
- Backflow applies patches against the source checkout's working tree; a
  conflict is reported, never silently overwritten.
- Snapshot refs live in the repository's object store; `git gc` keeps them as
  long as the refs exist. Deleting a snapshot (from the panel) drops that
  recovery path.
