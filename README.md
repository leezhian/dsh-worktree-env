# dsh-worktree-env

English | [简体中文](README.zh.md)

Native worktree enhancement plugin for **DeepSeek Harness (DSH)**, adding local environment orchestration and full lifecycle management on top of DSH's built-in Git worktree support.

## Features

- **Local Environment Orchestration** — Reads per-repository `.agents/environments/*.toml` files (stored alongside DSH's `.agents/worktrees`, completely isolated from `.codex/`), supporting per-platform `[setup]` / `[cleanup]` scripts (`default` / `macOS` / `Linux` / `Windows`), live SSE log streaming, and POSIX environment-variable delta capture.
- **Quick Actions** — Configure custom actions with name, icon (`tool` / `run` / `debug` / `test`), multi-line scripts, and platform filters; trigger them with one click from the right sidebar.
- **Handoff & Three-Way Patch Backflow** — Losslessly package staged, unstaged, and untracked changes into a new worktree (with optional `git fetch`), and merge worktree changes back to the source checkout using `git apply --3way` with conflict precheck.
- **Lossless Snapshot Archiving & Restore** — Save uncommitted changes to a hidden Git snapshot ref (`refs/dsh-worktree-env/snapshots/…`) before archiving, block destruction of nested repos/submodules, and restore uncommitted work with optional setup re-run.
- **Settings & Managed Worktrees** — Sync the project-relative worktree directory (default `.agents/worktrees`) directly with official `@deepseek-ai/dsh-experimental-worktree`, auto-clean old checkouts beyond `keepCount` while protecting pinned/active chats, and scan only DSH-created worktrees.
- **Multilingual UI** — Follows DSH's active UI language in real time across all 8 built-in DSH languages (`en`, `zh`, `ja`, `es`, `fr`, `de`, `ru`, `pt`).
- **Native DSH Integration** — 6 agent tools, `systemPrompt` context, `shellEnv` variable injection, `/worktree` command, sidebar **Worktrees** panel (Settings & Environments), right-sidebar tab, and session menu entries.

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

## Local Development & Installation

```bash
# Run all unit tests (zero external dependencies)
node --test tests/*.test.js

# Load into a local DSH Web profile for debugging
dsh web --patch ./cordis.patch.yml

# Install into a DSH profile
dsh plugin --profile web add .
```

## Documentation

- Plugin detail reference: [docs/DETAIL.md](docs/DETAIL.md) | [docs/DETAIL.zh.md](docs/DETAIL.zh.md)
- Design & architecture notes: [docs/chatgpt-worktree-research.md](docs/chatgpt-worktree-research.md)
