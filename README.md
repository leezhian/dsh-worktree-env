# dsh-worktree-env

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/dsh-worktree-env)](https://www.npmjs.com/package/dsh-worktree-env) [![npm downloads](https://img.shields.io/npm/dm/dsh-worktree-env?style=flat-square&color=orange)](https://www.npmjs.com/package/dsh-worktree-env) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leezhian/dsh-worktree-env)

English | [简体中文](README.zh.md)

Native worktree enhancement plugin for **DeepSeek Harness (DSH)**, adding local environment orchestration and full lifecycle management on top of DSH's built-in Git worktree support.

## Features

- **Local Environment Orchestration** — Reads per-repository `.agents/environments/*.toml` files (stored alongside DSH's `.agents/worktrees`, completely isolated from `.codex/`), supporting per-platform `[setup]` / `[cleanup]` scripts (`default` / `macOS` / `Linux` / `Windows`), live SSE log streaming, and POSIX environment-variable delta capture.
- **Quick Actions** — Configure custom actions with name, icon (`tool` / `run` / `debug` / `test`), multi-line scripts, and platform filters; run them with one click from the **conversation top bar** — prefers DSH's native interactive terminal when enabled, and falls back to an on-demand right-sidebar log tab (or floating log drawer).
- **Handoff & Three-Way Patch Backflow** — Losslessly package staged, unstaged, and untracked changes into a new worktree (with optional `git fetch`), and merge worktree changes back to the source checkout (on the current branch, another local branch, or a newly created branch) using `git apply --3way` with zero-side-effect conflict precheck and dirty-source protection.
- **Lossless Snapshot Archiving & Auto-Restore** — Save uncommitted changes to a hidden Git snapshot ref (`refs/dsh-worktree-env/snapshots/…`) before archiving or automatic cleanup, block destruction of nested repos/initialized submodules, auto-surface a session-scoped floating **Restore worktree** banner above the composer when reopening archived sessions, and clean up consumed snapshot refs after lossless restore.
- **Settings & Managed Worktrees** — Sync the project-relative worktree directory (default `.agents/worktrees`) directly with official `@deepseek-ai/dsh-experimental-worktree`, auto-clean old checkouts beyond `keepCount` while protecting pinned/active chats, and scan only DSH-created worktrees.
- **Multilingual UI** — Follows DSH's active UI language in real time across all 8 built-in DSH languages (`en`, `zh`, `ja`, `es`, `fr`, `de`, `ru`, `pt`).
- **Native DSH Integration** — 6 agent tools, `systemPrompt` context, `shellEnv` variable injection, sidebar **Worktrees** panel (Settings & Environments), conversation top-bar quick actions, session-scoped floating **Restore worktree** dock banner (`conversation.input.dock`), and session menu modals (Handoff, Apply-to-branch, Restore).

## Environment Config (`.agents/environments/environment.toml`)

```toml
version = 1
name = "my-app"

[setup]
script = """
npm install
"""

[setup.darwin]
script = """
pnpm install
"""

[cleanup]
script = """
docker compose down --remove-orphans || true
"""

[[actions]]
name = "dev"
icon = "run"
command = "npm run dev"
```

You can also point a repository to a custom file path (or disable local environments with `__none__`) via Git config:

```bash
git config --local dsh.localEnvironmentConfigPath .agents/environments/custom.toml
# or disable:
git config --local dsh.localEnvironmentConfigPath __none__
```

## Installation & Local Development

```bash
# Install from npm
dsh plugin --profile web add dsh-worktree-env

# Or install directly from GitHub
dsh plugin --profile web add github:leezhian/dsh-worktree-env

# Run all unit tests (zero external dependencies)
node --test tests/*.test.js

# Load into a local DSH Web profile for debugging
dsh web --patch ./cordis.patch.yml

# Install from a local checkout
dsh plugin --profile web add .
```

## Documentation

- Plugin detail reference: [docs/DETAIL.md](docs/DETAIL.md) | [docs/DETAIL.zh.md](docs/DETAIL.zh.md)
- Design & architecture notes: [docs/chatgpt-worktree-research.md](docs/chatgpt-worktree-research.md)
