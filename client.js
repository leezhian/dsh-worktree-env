/**
 * dsh-worktree-env Web client:
 * - Native DSH `--dsw-alias-*` design system (light & dark mode, macOS clearance)
 * - Main "Worktrees" panel: Settings (creation & cleanup synced with DSH's
 *   built-in worktree module + collapsible managed worktrees list) and a tabbed
 *   visual `environment.toml` editor with per-platform script switcher and live
 *   SSE setup logs
 * - Right-sidebar tab ("Worktree env") with quick actions & live logs
 * - Session menu items (`sidebar.workspaces.session.menu.item`) for /worktree
 */
window.__ModuleLoader__.load({
  id: 'dsh-worktree-env',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React
    let NativePrimitives = null
    try { NativePrimitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

    const NS = 'dshWorktreeEnv'
    const API = '/api/dsh-worktree-env'

    const zh = {
      'panel.title': 'Worktrees',
      'panel.subtitle': '管理工作树目录、自动清理策略、托管工作树与本地环境初始化脚本',
      'panel.tab.settings': '设置',
      'panel.tab.environments': '环境',
      'settings.group': '创建与清理',
      'settings.worktreeDir.label': '工作树目录（项目内相对路径）',
      'settings.worktreeDir.desc': '留空默认使用 .agents/worktrees；修改后会同步生效于 DSH 内置「新建工作树」',
      'settings.fetch.label': '创建工作树前获取远程更新',
      'settings.fetch.desc': '创建工作树前，检查远程仓库是否有更新的提交',
      'settings.keepCount.label': '保留的工作树数量',
      'settings.keepCount.desc': '较旧的工作树会自动清理。已置顶或进行中的聊天所用的工作树会保留。',
      'settings.confirmDelete.label': '删除工作树前询问',
      'settings.confirmDelete.desc': '适用于你手动删除的工作树',
      'settings.saved': '设置已保存',
      'settings.managed.title': '托管的工作树',
      'settings.managed.refresh': '刷新工作树列表',
      'settings.managed.count': '{count} 个工作树',
      'settings.managed.empty': '暂无托管的工作树',
      'settings.managed.newChat': '在此工作树中新建会话',
      'settings.managed.delete': '删除工作树',
      'settings.managed.deleteTitle': '删除工作树',
      'settings.managed.deleteDesc': '将移除「{branch}」的本地工作树目录；如有未提交更改会先保存一份恢复快照。',
      'settings.managed.deleteSubmit': '删除',
      'panel.refresh': '刷新',
      'panel.setup.none': '待初始化',
      'panel.setup.running': 'Setup 运行中',
      'panel.setup.succeeded': 'Setup 就绪',
      'panel.setup.failed': 'Setup 失败',
      'panel.setup.not-configured': '无环境配置',
      'panel.act.setup': '运行 Setup',
      'panel.act.apply': '回流主目录',
      'panel.act.archive': '快照归档',
      'panel.act.busy': '处理中…',
      'panel.act.error': '失败',
      'modal.cancel': '取消',
      'modal.confirm': '确认',
      'modal.apply.title': '应用改动到主目录',
      'modal.apply.desc': '将 worktree「{branch}」的改动通过 git apply --3way 合并回源主目录，冲突时会中止而不静默覆盖。',
      'modal.apply.modeLabel': '回流范围',
      'modal.apply.modeBranch': '分支全部改动（已提交 + 未提交）',
      'modal.apply.modeUncommitted': '仅未提交改动（相对当前 HEAD）',
      'modal.apply.checking': '正在预检补丁冲突…',
      'modal.apply.noChanges': '当前范围没有可应用的改动。',
      'modal.apply.ready': '预检通过：将应用 {count} 个文件的改动，无冲突。',
      'modal.apply.conflict': '检测到冲突，无法自动应用：',
      'modal.apply.submit': '确认应用改动',
      'modal.archive.title': '快照归档 Worktree',
      'modal.archive.desc': '归档「{branch}」将执行 cleanup 脚本并移除检出目录以释放磁盘。若有未提交改动会自动保存隐藏快照，随时可无损恢复，分支本身保留。',
      'modal.archive.submit': '确认归档',
      'env.selectProject': '选择项目',
      'env.addProject': '添加项目',
      'env.addProjectTitle': '添加项目目录',
      'env.addProjectDesc': '输入本地项目目录路径以在环境列表中管理其 environment.toml 配置。',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': '添加',
      'env.addEnvTo': '为 {name} 新建环境配置',
      'env.noProjects': '暂无项目，点击右上角「添加项目」或在侧边栏打开工作区。',
      'env.back': '返回',
      'env.backToProjects': '选择项目',
      'env.edit': '编辑',
      'env.editTitle': '编辑环境',
      'env.createTitle': '新建本地环境',
      'env.cancel': '取消',
      'env.saveChanges': '保存更改',
      'env.saving': '保存中…',
      'env.saved': '已保存',
      'env.name': '环境名称',
      'env.setupTitle': '设置脚本',
      'env.setupDesc': '此脚本会在创建工作树时运行',
      'env.cleanupTitle': '清理脚本',
      'env.cleanupDesc': '清理工作树之前在项目根目录下运行',
      'env.actionsTitle': '操作',
      'env.actionsDesc': '以下操作可运行任意命令，并显示在侧边栏中',
      'env.varsBtn': '变量',
      'env.vars.source': '源仓库根目录路径',
      'env.vars.worktree': '当前工作树目录路径',
      'env.vars.branch': '当前工作树分支名',
      'env.platform.top': '默认',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': '未设置平台覆盖，使用默认脚本',
      'env.noScript': '未配置脚本',
      'env.noPlatformScript': '此平台未配置脚本',
      'env.noActions': '未配置操作',
      'env.copy': '复制',
      'env.copied': '已复制',
      'env.actionNameLabel': '名称',
      'env.actionName': '名称（如 dev）',
      'env.actionScriptLabel': '操作脚本',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': '平台',
      'env.actionPlatformAll': '所有平台',
      'env.actionIconLabel': '选择操作图标',
      'env.icon.tool': '工具',
      'env.icon.run': '运行',
      'env.icon.debug': '调试',
      'env.icon.test': '测试',
      'env.addAction': '添加操作',
      'env.removeAction': '删除操作',
      'env.parseError': '配置文件解析失败',
      'tab.title': 'Worktree 环境',
      'tab.empty': '当前没有活跃的 Worktree。',
      'tab.emptyHint': '创建或切入 Worktree 后，可在此一键运行快捷 Actions、重跑 Setup 或回流主目录。',
      'tab.refresh': '刷新',
      'menu.handoff': '带改动转入 Worktree',
      'menu.apply': '应用改动到主目录',
      'menu.archive': '快照归档 Worktree',
      'menu.sending': '已发送 /worktree 指令',
      'menu.sendFailed': '指令发送失败',
      'logs.title': '运行日志',
      'logs.copy': '复制',
      'logs.copied': '已复制',
      'logs.close': '关闭',
      'logs.cancel': '停止',
      'logs.empty': '等待输出…',
      'logs.status.running': '运行中',
      'logs.status.succeeded': '成功',
      'logs.status.failed': '失败',
      'logs.status.cancelled': '已取消',
    }

    const en = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Manage worktree directory, cleanup settings, active checkouts, and local environment scripts',
      'panel.tab.settings': 'Settings',
      'panel.tab.environments': 'Environments',
      'settings.group': 'Creation & cleanup',
      'settings.worktreeDir.label': 'Worktree directory (project-relative)',
      'settings.worktreeDir.desc': 'Leave empty for .agents/worktrees; synced directly with DSH built-in worktree creation',
      'settings.fetch.label': 'Fetch before creating worktrees',
      'settings.fetch.desc': 'Check the remote for newer commits before creating a worktree',
      'settings.keepCount.label': 'Worktrees to keep',
      'settings.keepCount.desc': 'Older worktrees are cleaned up automatically. Worktrees for pinned or active chats are kept.',
      'settings.confirmDelete.label': 'Ask before deleting worktrees',
      'settings.confirmDelete.desc': 'Applies to worktrees you delete yourself',
      'settings.saved': 'Settings saved',
      'settings.managed.title': 'Managed worktrees',
      'settings.managed.refresh': 'Refresh worktrees',
      'settings.managed.count': '{count} worktree(s)',
      'settings.managed.empty': 'No managed worktrees',
      'settings.managed.newChat': 'New chat in this worktree',
      'settings.managed.delete': 'Delete worktree',
      'settings.managed.deleteTitle': 'Delete worktree',
      'settings.managed.deleteDesc': 'Removes the local worktree checkout for "{branch}". Uncommitted changes are snapshotted first.',
      'settings.managed.deleteSubmit': 'Delete',
      'panel.refresh': 'Refresh',
      'panel.setup.none': 'Setup pending',
      'panel.setup.running': 'Setup running',
      'panel.setup.succeeded': 'Setup ready',
      'panel.setup.failed': 'Setup failed',
      'panel.setup.not-configured': 'No env config',
      'panel.act.setup': 'Run setup',
      'panel.act.apply': 'Apply to source',
      'panel.act.archive': 'Archive',
      'panel.act.busy': 'Working…',
      'panel.act.error': 'Failed',
      'modal.cancel': 'Cancel',
      'modal.confirm': 'Confirm',
      'modal.apply.title': 'Apply changes to source checkout',
      'modal.apply.desc': 'Merge changes from "{branch}" back onto the source checkout using git apply --3way. Conflicts abort cleanly without overwriting.',
      'modal.apply.modeLabel': 'Scope',
      'modal.apply.modeBranch': 'Full branch diff (committed + uncommitted)',
      'modal.apply.modeUncommitted': 'Uncommitted changes only (vs HEAD)',
      'modal.apply.checking': 'Checking for patch conflicts…',
      'modal.apply.noChanges': 'No changes to apply in this scope.',
      'modal.apply.ready': 'Precheck passed: {count} file(s) will apply cleanly.',
      'modal.apply.conflict': 'Conflicts prevent a clean apply:',
      'modal.apply.submit': 'Apply changes',
      'modal.archive.title': 'Archive worktree',
      'modal.archive.desc': 'Archiving "{branch}" runs the cleanup script and removes the checkout directory. Uncommitted work is saved to a hidden Git snapshot so it can be restored losslessly.',
      'modal.archive.submit': 'Archive worktree',
      'env.selectProject': 'Select a project',
      'env.addProject': 'Add project',
      'env.addProjectTitle': 'Add project folder',
      'env.addProjectDesc': 'Enter a local project folder path to manage its environment.toml files.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Add',
      'env.addEnvTo': 'Add environment to {name}',
      'env.noProjects': 'No projects yet. Click "Add project" or open a workspace in the sidebar.',
      'env.back': 'Back',
      'env.backToProjects': 'Select a project',
      'env.edit': 'Edit',
      'env.editTitle': 'Edit environment',
      'env.createTitle': 'Create local environment',
      'env.cancel': 'Cancel',
      'env.saveChanges': 'Save changes',
      'env.saving': 'Saving…',
      'env.saved': 'Saved',
      'env.name': 'Name',
      'env.setupTitle': 'Setup script',
      'env.setupDesc': 'This script runs on worktree creation',
      'env.cleanupTitle': 'Cleanup script',
      'env.cleanupDesc': 'Runs in the project root before cleaning up a worktree',
      'env.actionsTitle': 'Actions',
      'env.actionsDesc': 'Actions run custom commands and appear in the sidebar',
      'env.varsBtn': 'Variables',
      'env.vars.source': 'Source repository root path',
      'env.vars.worktree': 'Current worktree directory path',
      'env.vars.branch': 'Current worktree branch name',
      'env.platform.top': 'Default',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'No platform override. Using the default script',
      'env.noScript': 'No script configured',
      'env.noPlatformScript': 'No script configured for this platform',
      'env.noActions': 'No actions configured',
      'env.copy': 'Copy',
      'env.copied': 'Copied',
      'env.actionNameLabel': 'Name',
      'env.actionName': 'Name (e.g. dev)',
      'env.actionScriptLabel': 'Action script',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Platform',
      'env.actionPlatformAll': 'All platforms',
      'env.actionIconLabel': 'Choose action icon',
      'env.icon.tool': 'Tool',
      'env.icon.run': 'Run',
      'env.icon.debug': 'Debug',
      'env.icon.test': 'Test',
      'env.addAction': 'Add action',
      'env.removeAction': 'Delete action',
      'env.parseError': 'Failed to parse config file',
      'tab.title': 'Worktree env',
      'tab.empty': 'No active worktrees.',
      'tab.emptyHint': 'Create or enter a worktree to run quick actions, re-run setup, or apply changes back to source here.',
      'tab.refresh': 'Refresh',
      'menu.handoff': 'Move into worktree with changes',
      'menu.apply': 'Apply changes to source',
      'menu.archive': 'Archive worktree',
      'menu.sending': 'Sent the /worktree command',
      'menu.sendFailed': 'Failed to send the command',
      'logs.title': 'Operation logs',
      'logs.copy': 'Copy',
      'logs.copied': 'Copied',
      'logs.close': 'Close',
      'logs.cancel': 'Stop',
      'logs.empty': 'Waiting for output…',
      'logs.status.running': 'Running',
      'logs.status.succeeded': 'Succeeded',
      'logs.status.failed': 'Failed',
      'logs.status.cancelled': 'Cancelled',
    }

    /** ---- tiny API layer ---- */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let value = null
      try { value = text.length > 0 ? JSON.parse(text) : null } catch { value = { error: text } }
      if (!response.ok) throw new Error(value?.error ?? `${response.status} ${response.statusText}`)
      return value
    }
    const enc = encodeURIComponent

    /** ---- native DSH styles (`--dsw-alias-*` tokens) ---- */
    const CSS = `
.dshwt-page { box-sizing: border-box; position: relative; height: 100%; overflow: auto; scrollbar-gutter: stable; container-type: inline-size; padding: 28px clamp(20px, 4vw, 44px) 0; color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-bg-base, transparent); font-size: 13px; line-height: 20px; }
[data-platform='darwin'] .dshwt-page { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dshwt-col { max-width: 960px; margin: 0 auto; padding-bottom: 56px; display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.dshwt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
.dshwt-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshwt-title-row { display: flex; align-items: center; gap: 8px; }
.dshwt-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); letter-spacing: -0.01em; }
.dshwt-subtitle { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshwt-spacer { flex: 1; }

/* Tabs */
.dshwt-tabs { display: flex; align-items: center; gap: 22px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }
.dshwt-tab { position: relative; appearance: none; border: 0; background: none; padding: 8px 1px 10px; cursor: pointer; font: inherit; font-size: 13px; line-height: 20px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #656d76); display: inline-flex; align-items: center; gap: 6px; transition: color 120ms ease; }
@media (hover: hover) { .dshwt-tab:hover { color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dshwt-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -0.5px; height: 2px; border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary, inherit); }
.dshwt-tab:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; border-radius: 2px; }

/* Segmented control */
.dshwt-seg { display: inline-flex; align-items: center; gap: 2px; padding: 3px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dshwt-seg-btn { appearance: none; border: 0; background: transparent; padding: 4px 10px; border-radius: var(--dsw-radius-sm, 8px); font: inherit; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary, #57606a); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-seg-btn:hover { color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-seg-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, inherit); box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(0,0,0,.08)); }
.dshwt-seg-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: -2px; }
.dshwt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-primary, inherit); flex: none; }

.dshwt-input::placeholder, .dshwt-textarea::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption, #8a8f98)); }
.dshwt-input:focus, .dshwt-input:focus-visible, .dshwt-textarea:focus, .dshwt-textarea:focus-visible, .dshwt-select:focus, .dshwt-select:focus-visible { outline: none; }

/* Buttons */
.dshwt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 14px; border-radius: var(--dsw-radius-md, 12px); border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.22)); background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px; line-height: 20px; font-weight: 400; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease; }
@media (hover: hover) { .dshwt-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); } }
.dshwt-btn:disabled { opacity: 0.4; cursor: default; }
.dshwt-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-btn-sm { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 8px); font-size: 12px; line-height: 18px; }
.dshwt-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115)); color: var(--dsw-alias-label-primary-foreground, #fff); }
@media (hover: hover) { .dshwt-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #43454a)); } }
.dshwt-btn-ghost { border-color: transparent; }
.dshwt-btn-danger { color: var(--dsw-alias-state-error-primary, #cf222e); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 35%, transparent); }
@media (hover: hover) { .dshwt-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 8%, transparent)); } }
.dshwt-btn-danger-fill { border-color: transparent; background: var(--dsw-alias-state-error-primary, #cf222e); color: #fff; }
@media (hover: hover) { .dshwt-btn-danger-fill:hover:not(:disabled) { opacity: 0.9; } }
.dshwt-spin svg { animation: dshwt-spin 0.9s linear infinite; }
@keyframes dshwt-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Badges / Tags */
.dshwt-tag { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; }
.dshwt-tag[data-tone="ok"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 12%, transparent); color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshwt-tag[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 14%, transparent); color: var(--dsw-alias-state-warn-primary, #9a6700); }
.dshwt-tag[data-tone="err"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 12%, transparent); color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-tag[data-tone="info"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 12%, transparent); color: var(--dsw-alias-brand-primary, #247bbf); }
.dshwt-tag[data-tone="off"] { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.12)); color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-tag-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: dshwt-pulse 1.2s ease-in-out infinite; }
@keyframes dshwt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* Shared path / branch / action pill styles */
.dshwt-group-path { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-caption, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-branch { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-card-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshwt-action-pill { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 120ms ease; }
@media (hover: hover) { .dshwt-action-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); } }
.dshwt-action-pill:disabled { opacity: 0.45; cursor: not-allowed; }

/* Banners & Notices */
.dshwt-banner { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere; }
.dshwt-banner[data-tone="ok"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a7f37) 10%, transparent); color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshwt-banner[data-tone="warn"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 12%, transparent); color: var(--dsw-alias-state-warn-primary, #9a6700); }
.dshwt-banner[data-tone="err"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 10%, transparent); color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-banner[data-tone="info"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 10%, transparent); color: var(--dsw-alias-label-primary, inherit); }

/* Empty state */
.dshwt-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 20px; text-align: center; border: 0.5px dashed var(--dsw-alias-border-l3, rgba(128,128,128,.3)); border-radius: 16px; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-empty-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.dshwt-empty-hint { max-width: 440px; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-tertiary, #656d76); }

/* Form / Environment editor */
.dshwt-section-card { display: flex; flex-direction: column; gap: 14px; padding: 18px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, transparent); }
.dshwt-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshwt-section-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshwt-label { font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-secondary, #57606a); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshwt-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption, #8a8f98); }
.dshwt-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2)); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px; outline: none; }
.dshwt-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-select { box-sizing: border-box; width: 100%; height: 34px; padding: 0 28px 0 12px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2)); border-radius: var(--dsw-radius-md, 12px); color: var(--dsw-alias-label-primary, inherit); background-color: var(--dsw-alias-bg-layer-1, transparent); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238a8f98' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; background-size: 14px 14px; appearance: none; -webkit-appearance: none; font: inherit; font-size: 13px; cursor: pointer; outline: none; }
.dshwt-textarea { box-sizing: border-box; width: 100%; min-height: 120px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2)); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.06)); color: var(--dsw-alias-label-primary, inherit); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; line-height: 18px; white-space: pre; resize: vertical; outline: none; }
.dshwt-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshwt-var-chip { appearance: none; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); color: var(--dsw-alias-label-secondary, inherit); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 11px; padding: 2px 7px; border-radius: 6px; cursor: pointer; }
@media (hover: hover) { .dshwt-var-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-action-grid { display: grid; grid-template-columns: 150px 1fr 110px auto; gap: 8px; align-items: center; }
.dshwt-savebar { position: sticky; bottom: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 16px; margin: 0 -4px; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.12)); }

/* Native Modal */
.dshwt-backdrop { position: fixed; inset: 0; z-index: 1000; background: var(--dsw-alias-bg-overlay, rgba(0,0,0,.45)); display: flex; align-items: center; justify-content: center; padding: 20px; }
.dshwt-modal { width: min(480px, 100%); max-height: 85vh; overflow: auto; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.22)); padding: 20px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.dshwt-modal-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #57606a); }
.dshwt-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.dshwt-radio-card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.22)); cursor: pointer; font-size: 13px; }
.dshwt-radio-card[data-selected="true"] { border-color: var(--dsw-alias-border-selected, var(--dsw-alias-border-l4)); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); }

/* Operation Log Drawer */
.dshwt-drawer { position: fixed; right: 20px; bottom: 20px; z-index: 900; width: min(640px, calc(100vw - 40px)); height: min(380px, 55vh); display: flex; flex-direction: column; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.22)); overflow: hidden; }
.dshwt-drawer-inline { position: relative; right: auto; bottom: auto; width: 100%; height: 240px; box-shadow: none; }
.dshwt-drawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); flex: none; }
.dshwt-drawer-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px; background: var(--dsw-alias-bg-module-platform, rgba(0,0,0,.04)); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 11.5px; line-height: 17px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dshwt-drawer-body span[data-stream="stderr"] { color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-drawer-body span[data-stream="meta"] { color: var(--dsw-alias-label-caption, #8a8f98); }

/* Right-sidebar pane */
.dshwt-pane { box-sizing: border-box; display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 12px; overflow: auto; font-size: 12.5px; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-pane-head { display: flex; align-items: center; gap: 8px; flex: none; }
.dshwt-pane-card { border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.dshwt-menuitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; font-size: 13px; text-align: left; background: none; border: none; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); }
@media (hover: hover) { .dshwt-menuitem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); } }
.dshwt-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }

/* Settings section (matches native DSH GeneralSection / FontSizeRow / Switch) */
.dshwt-settings-stack { display: flex; flex-direction: column; gap: 28px; width: 100%; }
.dshwt-settings-section { display: flex; flex-direction: column; width: 100%; }
.dshwt-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 22px; padding-bottom: 4px; }
.dshwt-settings-group-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-settings-saved { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); }

/* Managed worktrees accordion under Settings */
.dshwt-managed-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14)); }
.dshwt-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary, #57606a); cursor: pointer; flex: none; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); } }
@media (hover: hover) { .dshwt-icon-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.06)); color: var(--dsw-alias-state-error-primary, #cf222e); } }
.dshwt-icon-btn:disabled { opacity: 0.4; cursor: default; }
.dshwt-icon-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-managed-group { border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14)); }
.dshwt-managed-group:last-child { border-bottom: 0; }
.dshwt-managed-repo { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; text-align: left; cursor: pointer; }
.dshwt-managed-repo:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; border-radius: var(--dsw-radius-sm, 8px); }
.dshwt-managed-repo-name { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-managed-repo-meta { display: inline-flex; align-items: center; gap: 8px; flex: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #656d76); font-variant-numeric: tabular-nums; }
.dshwt-managed-chevron { display: inline-flex; color: var(--dsw-alias-label-secondary, #57606a); transition: transform 140ms ease; }
.dshwt-managed-repo[aria-expanded="false"] .dshwt-managed-chevron { transform: rotate(-90deg); }
.dshwt-managed-items { display: flex; flex-direction: column; margin-left: 12px; border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); }
.dshwt-managed-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.08)); }
.dshwt-managed-item:last-child { border-bottom: 0; }
.dshwt-managed-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dshwt-managed-name { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-managed-path { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-managed-acts { display: flex; align-items: center; gap: 4px; flex: none; }
.dshwt-managed-empty { padding: 16px 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-settings-list { display: flex; flex-direction: column; width: 100%; }
.dshwt-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14)); }
.dshwt-setting-row:last-child { border-bottom: 0; }
.dshwt-setting-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }
.dshwt-setting-title { font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-setting-desc { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-setting-err { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-setting-ctrl { flex: none; display: flex; align-items: center; }
.dshwt-setting-input { box-sizing: border-box; width: 240px; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2)); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 13px; line-height: 20px; outline: none; }
.dshwt-setting-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption, #8a8f98)); }
.dshwt-setting-input:focus, .dshwt-setting-input:focus-visible { outline: none; }
.dshwt-setting-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary, #cf222e); }

/* Native DSH-style Switch fallback (matches @deepseek-ai/dsh-client-ui-primitives Switch) */
.dshwt-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3, rgba(128,128,128,.24)); cursor: pointer; }
.dshwt-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #0f1115); }
.dshwt-switch:disabled { opacity: 0.5; cursor: default; }
.dshwt-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; pointer-events: none; }
.dshwt-switch[aria-checked="false"] .dshwt-switch-thumb { background: var(--dsw-alias-switch-thumb, #fff); }
.dshwt-switch[aria-checked="true"] .dshwt-switch-thumb { transform: translateX(16px); }

/* Native DSH-style Stepper pill (matches FontSizeRow stepper: borderless, no focus ring) */
.dshwt-stepper { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 84px; height: 36px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); }
.dshwt-stepper-input { box-sizing: border-box; width: 100%; height: 100%; padding: 0 24px; border: 0; outline: none; background: transparent; text-align: center; font: inherit; font-size: 14px; line-height: 22px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-stepper-input:focus, .dshwt-stepper-input:focus-visible { outline: none; }
.dshwt-stepper-input:disabled { opacity: 0.5; cursor: default; }
.dshwt-stepper-arrows { position: absolute; right: 6px; display: flex; flex-direction: column; gap: 2px; opacity: 0; transition: opacity 120ms ease; }
@media (hover: hover) { .dshwt-stepper:hover .dshwt-stepper-arrows { opacity: 1; } }
.dshwt-stepper:focus-within .dshwt-stepper-arrows { opacity: 1; }
@media (hover: none) { .dshwt-stepper-arrows { opacity: 1; } }
.dshwt-stepper-arrow { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 12px; padding: 0; border: 0; outline: none; border-radius: var(--dsw-radius-xs, 4px); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #fff) 75%, transparent); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }
@media (hover: hover) { .dshwt-stepper-arrow:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, #fff); } }
.dshwt-stepper-arrow:disabled { color: var(--dsw-alias-label-caption, #8a8f98); cursor: default; }

/* Environments: Project list + Detail preview + Editor (native DSH monochrome flat style) */
.dshwt-env-stack { display: flex; flex-direction: column; gap: 24px; width: 100%; }
.dshwt-env-list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14)); }
.dshwt-pill-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px; line-height: 20px; font-weight: 400; cursor: pointer; white-space: nowrap; transition: background 120ms ease, opacity 120ms ease; }
@media (hover: hover) { .dshwt-pill-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); } }
.dshwt-pill-btn:disabled { opacity: 0.4; cursor: default; }
.dshwt-pill-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-pill-btn-icon { width: 30px; padding: 0; border-radius: var(--dsw-radius-sm, 8px); }
.dshwt-env-projects { display: flex; flex-direction: column; width: 100%; }
.dshwt-env-project { display: flex; flex-direction: column; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.12)); }
.dshwt-env-project:last-child { border-bottom: 0; }
.dshwt-env-proj-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; }
.dshwt-env-proj-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0; border: 0; background: transparent; text-align: left; font: inherit; color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }
.dshwt-env-proj-main:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; border-radius: var(--dsw-radius-sm, 8px); }
.dshwt-env-proj-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: var(--dsw-alias-label-secondary, #57606a); }
.dshwt-env-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshwt-env-name { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-env-sub { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-env-children { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); }
.dshwt-env-child-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 2px; border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.08)); background: transparent; text-align: left; font: inherit; cursor: pointer; border-radius: var(--dsw-radius-sm, 8px); transition: background 120ms ease; }
.dshwt-env-child-row:last-child { border-bottom: 0; }
@media (hover: hover) { .dshwt-env-child-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); } }
.dshwt-env-child-row:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-env-chevron-right { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary, #656d76); }

/* Detail preview & Editor header */
.dshwt-env-top { display: flex; flex-direction: column; gap: 8px; }
.dshwt-back-btn { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 2px 0; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #656d76); font: inherit; font-size: 12.5px; line-height: 18px; cursor: pointer; }
@media (hover: hover) { .dshwt-back-btn:hover { color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-back-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; border-radius: 4px; }
.dshwt-env-hero { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dshwt-env-hero-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); letter-spacing: -0.01em; }
.dshwt-env-block { display: flex; flex-direction: column; gap: 12px; }
.dshwt-env-block-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.14)); }
.dshwt-env-block-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshwt-env-block-title { margin: 0; font-size: 14.5px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-env-block-desc { margin: 0; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-plat-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dshwt-plat-btn { appearance: none; border: 0; background: transparent; height: 28px; padding: 0 11px; border-radius: var(--dsw-radius-sm, 8px); font: inherit; font-size: 13px; line-height: 20px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #656d76); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-plat-btn:hover { color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-plat-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dshwt-plat-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-code-card { border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.07)); overflow: hidden; }
.dshwt-code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 4px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #57606a); }
.dshwt-code-lang { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-code-pre { margin: 0; padding: 8px 16px 14px; max-height: 224px; overflow: auto; font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-primary, inherit); white-space: pre-wrap; word-break: break-word; }
.dshwt-env-empty-bar { padding: 12px 16px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.07)); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-vars-panel { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.07)); }
.dshwt-var-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
.dshwt-var-name { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12px; color: var(--dsw-alias-label-primary, inherit); }
.dshwt-var-desc { font-size: 12px; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-env-action-list { display: flex; flex-direction: column; }
.dshwt-env-action-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); }
.dshwt-env-action-row:last-child { border-bottom: 0; }
.dshwt-env-action-icon { flex: none; width: 24px; height: 24px; color: var(--dsw-alias-label-secondary, #57606a); display: inline-flex; align-items: center; justify-content: center; }
.dshwt-env-action-cmd { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); white-space: pre-wrap; word-break: break-all; }
.dshwt-action-cards { display: flex; flex-direction: column; gap: 12px; }
.dshwt-action-card { display: flex; flex-direction: column; gap: 14px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.22)); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-layer-1, transparent); }
.dshwt-action-field { display: flex; flex-direction: column; gap: 6px; }
.dshwt-action-field-label { font-size: 12.5px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #656d76); }
.dshwt-action-name-row { display: flex; align-items: center; gap: 10px; }
.dshwt-action-textarea { box-sizing: border-box; width: 100%; min-height: 92px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.22)); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 13px; line-height: 20px; white-space: pre-wrap; resize: vertical; outline: none; }
.dshwt-action-textarea::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption, #8a8f98)); }
.dshwt-action-textarea:focus, .dshwt-action-textarea:focus-visible { outline: none; }
.dshwt-action-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dshwt-icon-picker { position: relative; flex: none; }
.dshwt-icon-picker-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; transition: background 120ms ease; }
@media (hover: hover) { .dshwt-icon-picker-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); } }
.dshwt-icon-picker-btn:disabled { opacity: 0.45; cursor: default; }
.dshwt-icon-picker-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-icon-menu { position: absolute; left: 0; top: calc(100% + 6px); z-index: 40; min-width: 152px; padding: 6px; border-radius: var(--dsw-radius-lg, 16px); border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.2)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,.14)); display: flex; flex-direction: column; gap: 2px; }
.dshwt-icon-menu-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13.5px; line-height: 20px; text-align: left; cursor: pointer; }
@media (hover: hover) { .dshwt-icon-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); } }
.dshwt-icon-menu-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: -2px; }
.dshwt-icon-menu-left { display: inline-flex; align-items: center; gap: 10px; }
.dshwt-action-plat-badge { font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1)); color: var(--dsw-alias-label-tertiary, #656d76); font-weight: 400; }

@container (max-width: 640px) {
  .dshwt-action-grid { grid-template-columns: 1fr; }
  .dshwt-setting-row { flex-direction: column; align-items: stretch; gap: 10px; }
  .dshwt-setting-copy { padding-right: 0; }
  .dshwt-setting-input { width: 100%; }
}
`

    /** ---- crisp inline SVG icons ---- */
    function BranchIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flexShrink: 0 },
      },
      h('circle', { cx: 6, cy: 6, r: 2.5 }),
      h('circle', { cx: 6, cy: 18, r: 2.5 }),
      h('circle', { cx: 18, cy: 8, r: 2.5 }),
      h('path', { d: 'M6 8.5v7M18 10.5c0 4-3 5.5-12 5.5' }))
    }
    function RefreshIcon({ size = 14 }) {
      return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
          h('polyline', { points: '21 3 21 9 15 9' })))
    }
    function ProjectIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 5, y: 3.5, width: 14, height: 17, rx: 2.5 }),
      h('path', { d: 'M9 8h6M9 12h6M9 16h4M3.5 8h2M3.5 12h2M3.5 16h2' }))
    }
    function PlusIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M12 5v14M5 12h14' }))
    }
    function EditIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M12 20h9' }),
      h('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' }))
    }
    function CodeIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('polyline', { points: '8 7 3 12 8 17' }),
      h('polyline', { points: '16 7 21 12 16 17' }),
      h('line', { x1: 13.5, y1: 5, x2: 10.5, y2: 19 }))
    }
    function CopyIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }),
      h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }))
    }
    function ChevronRightIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('polyline', { points: '9 6 15 12 9 18' }))
    }
    function ChevronLeftIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('polyline', { points: '15 6 9 12 15 18' }))
    }
    function ActionIcon({ kind, size = 18, outline = true }) {
      const svgBase = { viewBox: '0 0 24 24', width: size, height: size, style: { display: 'block' } }
      if (kind === 'test') {
        return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
          h('svg', { ...svgBase, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M9 3h6' }),
            h('path', { d: 'M10 3v5.6L4.7 18a2 2 0 0 0 1.7 3h11.2a2 2 0 0 0 1.7-3L14 8.6V3' }),
            h('path', { d: 'M7.5 15h9' })))
      }
      if (kind === 'debug') {
        return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
          h('svg', { ...svgBase, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M8 7a4 4 0 0 1 8 0' }),
            h('path', { d: 'M6 12a6 6 0 0 0 12 0v-2a6 6 0 0 0-12 0Z' }),
            h('path', { d: 'M12 10v8M10 4 8.5 2.5M14 4l1.5-1.5M6 10H3M21 10h-3M6 14H3M21 14h-3M7 17l-2.5 2M17 17l2.5 2' })))
      }
      if (kind === 'tool') {
        return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
          h('svg', { ...svgBase, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('circle', { cx: 12, cy: 12, r: 3 }),
            h('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z' })))
      }
      return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
        h('svg', {
          ...svgBase,
          fill: outline ? 'none' : 'currentColor',
          stroke: outline ? 'currentColor' : 'none',
          strokeWidth: outline ? 1.8 : 0,
          strokeLinejoin: 'round',
        },
        h('polygon', { points: '7 5 19 12 7 19 7 5' })))
    }
    function CheckIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('polyline', { points: '20 6 9 17 4 12' }))
    }

    function shortRepo(root) {
      if (typeof root !== 'string') return ''
      const parts = root.split(/[\\/]/).filter(Boolean)
      return parts.slice(-2).join('/')
    }
    function repoName(root) {
      if (typeof root !== 'string') return ''
      const parts = root.split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] ?? root
    }
    function setupTone(state) {
      if (state === 'succeeded') return 'ok'
      if (state === 'failed') return 'err'
      if (state === 'running') return 'warn'
      return 'off'
    }
    function copyText(text) {
      try { void navigator.clipboard?.writeText?.(text) } catch { /* ignore */ }
    }

    /** ---- shared hooks ---- */
    function useWorktrees() {
      const [items, setItems] = useState(null)
      const [repositories, setRepositories] = useState({})
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          const value = await api('/worktrees')
          setItems(value.items ?? [])
          setRepositories(value.repositories ?? {})
          setError(null)
        } catch (e) {
          setError(e.message)
        } finally {
          setLoading(false)
        }
      }, [])
      useEffect(() => { void refresh() }, [refresh])
      return { items, repositories, loading, error, refresh }
    }

    function usePluginConfig() {
      const [config, setConfig] = useState({
        worktreeDirectory: '',
        defaultWorktreeDirectory: '.agents/worktrees',
        nativeSynced: false,
        upstreamRefreshMode: 'never',
        keepCount: 15,
        confirmBeforeDelete: true,
      })
      const refresh = useCallback(async () => {
        try {
          const value = await api('/config')
          if (value !== null) setConfig(value)
        } catch { /* ignore */ }
      }, [])
      useEffect(() => { void refresh() }, [refresh])
      const update = useCallback(async (patch) => {
        const value = await api('/config', { method: 'PUT', body: JSON.stringify(patch) })
        if (value !== null) setConfig(value)
        return value
      }, [])
      return { config, update, refresh }
    }

    /** ---- Live SSE operation log drawer ---- */
    function LogDrawer({ operationId, label, inline = false, onClose, onSettled, t }) {
      const [lines, setLines] = useState([])
      const [status, setStatus] = useState('running')
      const [opLabel, setOpLabel] = useState(label ?? '')
      const [copied, setCopied] = useState(false)
      const boxRef = useRef(null)
      const settledRef = useRef(onSettled)
      settledRef.current = onSettled

      useEffect(() => {
        setLines([])
        setStatus('running')
        const source = new EventSource(`${API}/operations/${enc(operationId)}/stream`)
        source.onmessage = (event) => {
          try {
            const entry = JSON.parse(event.data)
            setLines(prev => [...prev, entry])
          } catch { /* ignore */ }
        }
        source.addEventListener('snapshot', (event) => {
          try {
            const snap = JSON.parse(event.data)
            setLines(snap.logs ?? [])
            setStatus(snap.status ?? 'running')
            if (snap.label) setOpLabel(snap.label)
          } catch { /* ignore */ }
        })
        source.addEventListener('end', (event) => {
          try { setStatus(JSON.parse(event.data).status ?? 'succeeded') } catch { setStatus('succeeded') }
          source.close()
          settledRef.current?.()
        })
        source.onerror = () => { /* EventSource retries until end */ }
        return () => source.close()
      }, [operationId])

      useEffect(() => {
        boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
      }, [lines])

      const tone = status === 'succeeded' ? 'ok' : status === 'failed' ? 'err' : status === 'running' ? 'warn' : 'off'
      const copyAll = () => {
        copyText(lines.map(l => l.text).join(''))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }

      return h('div', { className: inline ? 'dshwt-drawer dshwt-drawer-inline' : 'dshwt-drawer', role: 'region', 'aria-label': t('logs.title') },
        h('div', { className: 'dshwt-drawer-head' },
          h('span', { className: 'dshwt-drawer-title', title: opLabel }, opLabel || t('logs.title')),
          h('span', { className: 'dshwt-tag', 'data-tone': tone },
            status === 'running' ? h('span', { className: 'dshwt-tag-pulse' }) : null,
            t(`logs.status.${status}`) || status),
          h('span', { className: 'dshwt-spacer' }),
          h('button', { className: 'dshwt-btn dshwt-btn-sm dshwt-btn-ghost', onClick: copyAll }, copied ? t('logs.copied') : t('logs.copy')),
          status === 'running'
            ? h('button', { className: 'dshwt-btn dshwt-btn-sm dshwt-btn-danger', onClick: () => void api(`/operations/${enc(operationId)}/cancel`, { method: 'POST' }) }, t('logs.cancel'))
            : null,
          h('button', { className: 'dshwt-btn dshwt-btn-sm dshwt-btn-ghost', onClick: onClose }, t('logs.close'))),
        h('div', { className: 'dshwt-drawer-body', ref: boxRef },
          lines.length === 0
            ? h('span', { 'data-stream': 'meta' }, t('logs.empty'))
            : lines.map((entry, idx) => h('span', { key: idx, 'data-stream': entry.stream }, entry.text))))
    }

    /** ---- Native DSH Modals ---- */
    function ModalShell({ title, onClose, children }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'dshwt-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'dshwt-modal', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('h3', { className: 'dshwt-modal-title' }, title),
          children))
    }

    function ApplyPatchModal({ item, t, onClose, onApplied }) {
      const [mode, setMode] = useState('branch')
      const [precheck, setPrecheck] = useState({ loading: true, result: null, error: null })
      const [applying, setApplying] = useState(false)

      useEffect(() => {
        let cancelled = false
        setPrecheck({ loading: true, result: null, error: null })
        void api(`/worktrees/${enc(item.id)}/apply-patch`, {
          method: 'POST',
          body: JSON.stringify({ mode, dryRun: true }),
        }).then(
          (result) => { if (!cancelled) setPrecheck({ loading: false, result, error: null }) },
          (err) => { if (!cancelled) setPrecheck({ loading: false, result: null, error: err.message }) },
        )
        return () => { cancelled = true }
      }, [item.id, mode])

      const submit = async () => {
        setApplying(true)
        try {
          const result = await api(`/worktrees/${enc(item.id)}/apply-patch`, {
            method: 'POST',
            body: JSON.stringify({ mode, dryRun: false }),
          })
          onApplied(result)
          onClose()
        } catch (err) {
          setPrecheck(prev => ({ ...prev, error: err.message }))
        } finally {
          setApplying(false)
        }
      }

      const conflicts = precheck.result?.conflicts ?? []
      const fileCount = precheck.result?.fileCount ?? 0
      const canApply = !precheck.loading && !applying && precheck.error === null && conflicts.length === 0 && fileCount > 0

      return h(ModalShell, { title: t('modal.apply.title'), onClose },
        h('p', { className: 'dshwt-modal-desc' }, t('modal.apply.desc', { branch: item.branch })),
        h('div', { className: 'dshwt-field' },
          h('span', { className: 'dshwt-label' }, t('modal.apply.modeLabel')),
          h('label', { className: 'dshwt-radio-card', 'data-selected': mode === 'branch' },
            h('input', { type: 'radio', name: 'applyMode', checked: mode === 'branch', onChange: () => setMode('branch') }),
            h('span', null, t('modal.apply.modeBranch'))),
          h('label', { className: 'dshwt-radio-card', 'data-selected': mode === 'uncommitted' },
            h('input', { type: 'radio', name: 'applyMode', checked: mode === 'uncommitted', onChange: () => setMode('uncommitted') }),
            h('span', null, t('modal.apply.modeUncommitted')))),
        precheck.loading
          ? h('div', { className: 'dshwt-banner', 'data-tone': 'info' }, t('modal.apply.checking'))
          : precheck.error !== null
            ? h('div', { className: 'dshwt-banner', 'data-tone': 'err' }, precheck.error)
            : conflicts.length > 0
              ? h('div', { className: 'dshwt-banner', 'data-tone': 'err' },
                h('div', null,
                  h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('modal.apply.conflict')),
                  conflicts.map((c, i) => h('div', { key: i, style: { fontFamily: 'var(--ds-font-family-code, Menlo, monospace)', fontSize: 11.5 } }, `• ${c}`))))
              : fileCount === 0
                ? h('div', { className: 'dshwt-banner', 'data-tone': 'warn' }, t('modal.apply.noChanges'))
                : h('div', { className: 'dshwt-banner', 'data-tone': 'ok' }, t('modal.apply.ready', { count: fileCount })),
        h('div', { className: 'dshwt-modal-foot' },
          h('button', { className: 'dshwt-btn', onClick: onClose }, t('modal.cancel')),
          h('button', { className: 'dshwt-btn dshwt-btn-primary', disabled: !canApply, onClick: () => void submit() },
            applying ? t('panel.act.busy') : t('modal.apply.submit'))))
    }

    function ConfirmModal({ title, desc, submitLabel, danger = false, onClose, onConfirm, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const go = async () => {
        setBusy(true)
        setError(null)
        try {
          await onConfirm()
          onClose()
        } catch (err) {
          setError(err.message)
          setBusy(false)
        }
      }
      return h(ModalShell, { title, onClose },
        h('p', { className: 'dshwt-modal-desc' }, desc),
        error !== null ? h('div', { className: 'dshwt-banner', 'data-tone': 'err' }, error) : null,
        h('div', { className: 'dshwt-modal-foot' },
          h('button', { className: 'dshwt-btn', disabled: busy, onClick: onClose }, t('modal.cancel')),
          h('button', { className: `dshwt-btn ${danger ? 'dshwt-btn-danger-fill' : 'dshwt-btn-primary'}`, disabled: busy, onClick: () => void go() },
            busy ? t('panel.act.busy') : submitLabel)))
    }

    /** ---- Environments Tab (Project list -> Detail preview -> Editor) ---- */
    const PLATFORMS = ['top', 'darwin', 'linux', 'win32']
    const ENV_VAR_SPECS = [
      { name: '$DSH_SOURCE_TREE_PATH', key: 'env.vars.source' },
      { name: '$DSH_WORKTREE_PATH', key: 'env.vars.worktree' },
      { name: '$DSH_WORKTREE_BRANCH', key: 'env.vars.branch' },
    ]

    async function pickProjectDirectory() {
      const desktop = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : undefined
      if (typeof desktop?.pick === 'function') return await desktop.pick()
      const uiWorkspace = NS_STATE.ctx?.get?.('uiWorkspace')
      if (typeof uiWorkspace?.pickDirectory === 'function') return await uiWorkspace.pickDirectory()
      return undefined
    }

    async function registerProjectWorkspace(path) {
      const workspaces = NS_STATE.ctx?.get?.('workspaces')
      if (typeof workspaces?.create === 'function') {
        await workspaces.create({ path })
        return true
      }
      return false
    }

    function EnvVariablesPanel({ t }) {
      const [copied, setCopied] = useState(null)
      return h('div', { className: 'dshwt-vars-panel' },
        ENV_VAR_SPECS.map(spec => h('div', { key: spec.name, className: 'dshwt-var-row' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
            h('span', { className: 'dshwt-var-name' }, spec.name),
            h('span', { className: 'dshwt-var-desc' }, t(spec.key))),
          h('button', {
            type: 'button',
            className: 'dshwt-pill-btn',
            style: { height: 26, fontSize: 12, padding: '0 10px' },
            onClick: () => { copyText(spec.name); setCopied(spec.name); setTimeout(() => setCopied(null), 1200) },
          }, copied === spec.name ? t('env.copied') : t('env.copy')))))
    }

    function EnvScriptPreview({ t, title, desc, scripts, showVarsButton = false }) {
      const [platform, setPlatform] = useState('top')
      const [showVars, setShowVars] = useState(false)
      const [copied, setCopied] = useState(false)

      const rawDefault = (scripts?.top ?? '').trim()
      const hasAny = rawDefault.length > 0 || ['darwin', 'linux', 'win32'].some(p => (scripts?.[p] ?? '').trim().length > 0)
      const platformRaw = platform === 'top' ? null : (scripts?.[platform] ?? '').trim()
      const usesDefault = platform !== 'top' && platformRaw === '' && rawDefault.length > 0
      const shown = platform === 'top' || usesDefault ? rawDefault : (platformRaw ?? '')

      const doCopy = () => {
        if (shown.length === 0) return
        copyText(shown)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }

      return h('section', { className: 'dshwt-env-block' },
        h('div', { className: 'dshwt-env-block-head' },
          h('div', { className: 'dshwt-env-block-copy' },
            h('h3', { className: 'dshwt-env-block-title' }, title),
            h('p', { className: 'dshwt-env-block-desc' }, desc)),
          showVarsButton
            ? h('button', {
              type: 'button',
              className: 'dshwt-pill-btn',
              'aria-expanded': showVars,
              onClick: () => setShowVars(v => !v),
            }, t('env.varsBtn'))
            : null),
        showVars ? h(EnvVariablesPanel, { t }) : null,
        hasAny
          ? h('div', { className: 'dshwt-plat-bar', role: 'group' },
            PLATFORMS.map(p => h('button', {
              key: p, type: 'button', className: 'dshwt-plat-btn', 'aria-pressed': platform === p,
              onClick: () => setPlatform(p),
            }, t(`env.platform.${p}`))))
          : null,
        usesDefault ? h('div', { className: 'dshwt-env-block-desc' }, t('env.platformUsesDefault')) : null,
        shown.length > 0
          ? h('div', { className: 'dshwt-code-card' },
            h('div', { className: 'dshwt-code-head' },
              h('span', { className: 'dshwt-code-lang' },
                h(CodeIcon, { size: 14 }),
                platform === 'win32' ? 'text' : 'bash'),
              h('button', {
                type: 'button',
                className: 'dshwt-icon-btn',
                title: copied ? t('env.copied') : t('env.copy'),
                'aria-label': copied ? t('env.copied') : t('env.copy'),
                onClick: doCopy,
              }, copied ? h('span', { style: { fontSize: 12 } }, '✓') : h(CopyIcon, { size: 14 }))),
            h('pre', { className: 'dshwt-code-pre' }, h('code', null, shown)))
          : h('div', { className: 'dshwt-env-empty-bar' },
            platform !== 'top' && hasAny ? t('env.noPlatformScript') : t('env.noScript')))
    }

    const ACTION_ICON_OPTIONS = ['tool', 'run', 'debug', 'test']
    const ACTION_PLATFORM_OPTIONS = [null, 'darwin', 'linux', 'win32']

    function ActionIconPicker({ value, disabled, t, onChange }) {
      const [open, setOpen] = useState(false)
      const wrapRef = useRef(null)
      const current = ACTION_ICON_OPTIONS.includes(value) ? value : 'tool'

      useEffect(() => {
        if (!open) return
        const onPointerDown = (e) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(e.target)) setOpen(false)
        }
        const onKeyDown = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      return h('div', { className: 'dshwt-icon-picker', ref: wrapRef },
        h('button', {
          type: 'button',
          className: 'dshwt-icon-picker-btn',
          disabled,
          title: t('env.actionIconLabel'),
          'aria-label': t('env.actionIconLabel'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen(v => !v),
        }, h(ActionIcon, { kind: current, size: 18, outline: true })),
        open
          ? h('div', { className: 'dshwt-icon-menu', role: 'menu', 'aria-label': t('env.actionIconLabel') },
            ACTION_ICON_OPTIONS.map(opt => h('button', {
              key: opt,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': current === opt,
              className: 'dshwt-icon-menu-item',
              onClick: () => { onChange(opt); setOpen(false) },
            },
            h('span', { className: 'dshwt-icon-menu-left' },
              h(ActionIcon, { kind: opt, size: 18, outline: true }),
              h('span', null, t(`env.icon.${opt}`))),
            current === opt ? h(CheckIcon, { size: 14 }) : null)))
          : null)
    }

    function ActionEditorCard({ action, disabled, t, onChange, onRemove }) {
      const platformValue = action.platform ?? null
      return h('div', { className: 'dshwt-action-card' },
        h('div', { className: 'dshwt-action-field' },
          h('span', { className: 'dshwt-action-field-label' }, t('env.actionNameLabel')),
          h('div', { className: 'dshwt-action-name-row' },
            h(ActionIconPicker, {
              value: action.icon,
              disabled,
              t,
              onChange: icon => onChange({ ...action, icon }),
            }),
            h('input', {
              className: 'dshwt-input',
              style: { flex: 1 },
              placeholder: t('env.actionName'),
              value: action.name,
              disabled,
              onChange: e => onChange({ ...action, name: e.target.value }),
            }))),
        h('div', { className: 'dshwt-action-field' },
          h('span', { className: 'dshwt-action-field-label' }, t('env.actionScriptLabel')),
          h('textarea', {
            className: 'dshwt-action-textarea',
            placeholder: t('env.actionCommand'),
            value: action.command,
            disabled,
            spellCheck: false,
            onChange: e => onChange({ ...action, command: e.target.value }),
          })),
        h('div', { className: 'dshwt-action-foot' },
          h('div', { className: 'dshwt-action-field' },
            h('span', { className: 'dshwt-action-field-label' }, t('env.actionPlatformLabel')),
            h('div', { className: 'dshwt-plat-bar', role: 'group' },
              ACTION_PLATFORM_OPTIONS.map(opt => h('button', {
                key: opt ?? 'all',
                type: 'button',
                className: 'dshwt-plat-btn',
                'aria-pressed': platformValue === opt,
                disabled,
                onClick: () => onChange({ ...action, platform: opt }),
              }, opt === null ? t('env.actionPlatformAll') : t(`env.platform.${opt}`))))),
          h('button', {
            type: 'button',
            className: 'dshwt-icon-btn dshwt-icon-btn-danger',
            title: t('env.removeAction'),
            'aria-label': t('env.removeAction'),
            disabled,
            onClick: onRemove,
          }, h(TrashIcon, { size: 15 }))))
    }

    function EnvActionReadRow({ action, t }) {
      const [expanded, setExpanded] = useState(false)
      const lines = (action.command ?? '').trimEnd().split(/\r?\n/)
      const multiline = lines.length > 1
      return h('div', { className: 'dshwt-env-action-row' },
        h('span', { className: 'dshwt-env-action-icon' }, h(ActionIcon, { kind: action.icon ?? 'tool', size: 19, outline: true })),
        h('div', { className: 'dshwt-env-copy' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { className: 'dshwt-env-name' }, action.name),
            action.platform ? h('span', { className: 'dshwt-action-plat-badge' }, t(`env.platform.${action.platform}`)) : null),
          h('div', { className: 'dshwt-env-action-cmd' }, multiline && !expanded ? `${lines[0]} …` : action.command)),
        multiline
          ? h('button', {
            type: 'button',
            className: 'dshwt-icon-btn',
            'aria-expanded': expanded,
            onClick: () => setExpanded(v => !v),
          }, h(ChevronIcon, { dir: expanded ? 'up' : 'down', size: 11 }))
          : null)
    }

    function EnvDetailView({ t, projectRoot, configPath, envEntry, onBack, onEdit }) {
      const [detail, setDetail] = useState(() => (envEntry?.valid && envEntry.environment ? envEntry.environment : null))
      const [loading, setLoading] = useState(detail === null)
      const [error, setError] = useState(envEntry?.valid === false ? envEntry.error : null)

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        void api(`/environments?root=${enc(projectRoot)}&configPath=${enc(configPath)}`).then(
          (res) => { if (!cancelled) { setDetail(res.environment); setLoading(false) } },
          (err) => { if (!cancelled) { setError(err.message); setLoading(false) } },
        )
        return () => { cancelled = true }
      }, [projectRoot, configPath])

      const title = detail?.name || envEntry?.name || repoName(projectRoot)
      const actions = detail?.allActions ?? detail?.actions ?? []

      return h('div', { className: 'dshwt-env-stack' },
        h('div', { className: 'dshwt-env-top' },
          h('button', { type: 'button', className: 'dshwt-back-btn', onClick: onBack },
            h(ChevronLeftIcon, { size: 14 }),
            t('env.backToProjects')),
          h('div', { className: 'dshwt-env-hero' },
            h('h2', { className: 'dshwt-env-hero-title' }, title),
            h('button', {
              type: 'button',
              className: 'dshwt-pill-btn',
              disabled: loading,
              onClick: () => onEdit(detail),
            }, h(EditIcon, { size: 13 }), t('env.edit')))),

        error ? h('div', { className: 'dshwt-setting-err', role: 'alert' }, error) : null,

        loading && detail === null
          ? h('div', { className: 'dshwt-managed-empty' }, '…')
          : detail !== null
            ? h(React.Fragment, null,
              h(EnvScriptPreview, {
                t,
                title: t('env.setupTitle'),
                desc: t('env.setupDesc'),
                scripts: detail.setupScripts ?? {},
                showVarsButton: true,
              }),
              h(EnvScriptPreview, {
                t,
                title: t('env.cleanupTitle'),
                desc: t('env.cleanupDesc'),
                scripts: detail.cleanupScripts ?? (detail.cleanup?.script ? { top: detail.cleanup.script } : {}),
              }),
              h('section', { className: 'dshwt-env-block' },
                h('div', { className: 'dshwt-env-block-head' },
                  h('div', { className: 'dshwt-env-block-copy' },
                    h('h3', { className: 'dshwt-env-block-title' }, t('env.actionsTitle')),
                    h('p', { className: 'dshwt-env-block-desc' }, t('env.actionsDesc')))),
                actions.length === 0
                  ? h('div', { className: 'dshwt-env-empty-bar' }, t('env.noActions'))
                  : h('div', { className: 'dshwt-env-action-list' },
                    actions.map((action, idx) => h(EnvActionReadRow, { key: `${action.name}-${idx}`, action, t })))))
            : null)
    }

    function EnvEditorView({ t, projectRoot, projectName, configPath, isNew, initialEnv, onCancel, onSaved }) {
      const [draft, setDraft] = useState(() => ({
        name: initialEnv?.name || projectName || repoName(projectRoot),
        setupScripts: { ...(initialEnv?.setupScripts ?? {}) },
        cleanupScripts: { ...(initialEnv?.cleanupScripts ?? (initialEnv?.cleanup?.script ? { top: initialEnv.cleanup.script } : {})) },
        actions: (initialEnv?.allActions ?? initialEnv?.actions ?? []).map(a => ({
          name: a.name,
          command: a.command,
          icon: ACTION_ICON_OPTIONS.includes(a.icon) ? a.icon : 'tool',
          platform: a.platform ?? null,
        })),
      }))
      const [setupTab, setSetupTab] = useState('top')
      const [cleanupTab, setCleanupTab] = useState('top')
      const [showVars, setShowVars] = useState(false)
      const [dirty, setDirty] = useState(isNew)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)

      const patch = (fields) => {
        setDirty(true)
        setDraft(prev => ({ ...prev, ...fields }))
      }

      const save = async () => {
        setSaving(true)
        setError(null)
        try {
          const setupScripts = {}
          for (const [p, script] of Object.entries(draft.setupScripts)) {
            if (typeof script === 'string' && script.trim().length > 0) setupScripts[p] = script
          }
          const cleanupScripts = {}
          for (const [p, script] of Object.entries(draft.cleanupScripts)) {
            if (typeof script === 'string' && script.trim().length > 0) cleanupScripts[p] = script
          }
          const res = await api('/environments', {
            method: 'PUT',
            body: JSON.stringify({
              root: projectRoot,
              configPath,
              definition: {
                name: draft.name.trim().length > 0 ? draft.name.trim() : undefined,
                setupScripts: Object.keys(setupScripts).length > 0 ? setupScripts : undefined,
                cleanupScripts: Object.keys(cleanupScripts).length > 0 ? cleanupScripts : undefined,
                actions: draft.actions
                  .filter(a => a.name.trim().length > 0 && a.command.trim().length > 0)
                  .map(a => ({
                    name: a.name.trim(),
                    command: a.command,
                    icon: ACTION_ICON_OPTIONS.includes(a.icon) ? a.icon : 'tool',
                    platform: a.platform || null,
                  })),
              },
            }),
          })
          onSaved(res.writtenTo ?? configPath)
        } catch (err) {
          setError(err.message)
        } finally {
          setSaving(false)
        }
      }

      return h('div', { className: 'dshwt-env-stack' },
        h('div', { className: 'dshwt-env-top' },
          h('button', { type: 'button', className: 'dshwt-back-btn', onClick: onCancel },
            h(ChevronLeftIcon, { size: 14 }),
            t('env.back')),
          h('div', { className: 'dshwt-env-hero' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
              h('h2', { className: 'dshwt-env-hero-title' }, isNew ? t('env.createTitle') : t('env.editTitle')),
              h('span', { className: 'dshwt-group-path', title: configPath }, configPath)),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('button', { type: 'button', className: 'dshwt-btn', disabled: saving, onClick: onCancel }, t('env.cancel')),
              h('button', { type: 'button', className: 'dshwt-btn dshwt-btn-primary', disabled: saving || !dirty, onClick: () => void save() },
                saving ? t('env.saving') : t('env.saveChanges'))))),

        error ? h('div', { className: 'dshwt-setting-err', role: 'alert' }, error) : null,

        h('div', { className: 'dshwt-field' },
          h('label', { className: 'dshwt-env-block-title' }, t('env.name')),
          h('input', {
            className: 'dshwt-input',
            style: { maxWidth: 360 },
            value: draft.name,
            disabled: saving,
            onChange: e => patch({ name: e.target.value }),
          })),

        h('section', { className: 'dshwt-env-block' },
          h('div', { className: 'dshwt-env-block-head' },
            h('div', { className: 'dshwt-env-block-copy' },
              h('h3', { className: 'dshwt-env-block-title' }, t('env.setupTitle')),
              h('p', { className: 'dshwt-env-block-desc' }, t('env.setupDesc'))),
            h('button', {
              type: 'button', className: 'dshwt-pill-btn', 'aria-expanded': showVars,
              onClick: () => setShowVars(v => !v),
            }, t('env.varsBtn'))),
          showVars ? h(EnvVariablesPanel, { t }) : null,
          h('div', { className: 'dshwt-plat-bar', role: 'group' },
            PLATFORMS.map(p => h('button', {
              key: p, type: 'button', className: 'dshwt-plat-btn', 'aria-pressed': setupTab === p,
              onClick: () => setSetupTab(p),
            },
            t(`env.platform.${p}`),
            (draft.setupScripts[p] ?? '').trim().length > 0 ? h('span', { className: 'dshwt-dot' }) : null))),
          h('textarea', {
            className: 'dshwt-textarea',
            placeholder: '# npm install',
            value: draft.setupScripts[setupTab] ?? '',
            disabled: saving,
            onChange: e => patch({ setupScripts: { ...draft.setupScripts, [setupTab]: e.target.value } }),
          })),

        h('section', { className: 'dshwt-env-block' },
          h('div', { className: 'dshwt-env-block-head' },
            h('div', { className: 'dshwt-env-block-copy' },
              h('h3', { className: 'dshwt-env-block-title' }, t('env.cleanupTitle')),
              h('p', { className: 'dshwt-env-block-desc' }, t('env.cleanupDesc')))),
          h('div', { className: 'dshwt-plat-bar', role: 'group' },
            PLATFORMS.map(p => h('button', {
              key: p, type: 'button', className: 'dshwt-plat-btn', 'aria-pressed': cleanupTab === p,
              onClick: () => setCleanupTab(p),
            },
            t(`env.platform.${p}`),
            (draft.cleanupScripts[p] ?? '').trim().length > 0 ? h('span', { className: 'dshwt-dot' }) : null))),
          h('textarea', {
            className: 'dshwt-textarea',
            style: { minHeight: 88 },
            placeholder: '# docker compose down --remove-orphans || true',
            value: draft.cleanupScripts[cleanupTab] ?? '',
            disabled: saving,
            onChange: e => patch({ cleanupScripts: { ...draft.cleanupScripts, [cleanupTab]: e.target.value } }),
          })),

        h('section', { className: 'dshwt-env-block' },
          h('div', { className: 'dshwt-env-block-head' },
            h('div', { className: 'dshwt-env-block-copy' },
              h('h3', { className: 'dshwt-env-block-title' }, t('env.actionsTitle')),
              h('p', { className: 'dshwt-env-block-desc' }, t('env.actionsDesc'))),
            h('button', {
              type: 'button', className: 'dshwt-pill-btn',
              disabled: saving,
              onClick: () => patch({ actions: [...draft.actions, { name: '', command: '', icon: 'run', platform: null }] }),
            }, t('env.addAction'))),
          draft.actions.length === 0
            ? h('div', { className: 'dshwt-env-empty-bar' }, t('env.noActions'))
            : h('div', { className: 'dshwt-action-cards' },
              draft.actions.map((action, index) => h(ActionEditorCard, {
                key: index,
                action,
                disabled: saving,
                t,
                onChange: updated => {
                  const next = [...draft.actions]
                  next[index] = updated
                  patch({ actions: next })
                },
                onRemove: () => patch({ actions: draft.actions.filter((_, i) => i !== index) }),
              })))))
    }

    function AddProjectModal({ t, onClose, onAdd }) {
      const [pathDraft, setPathDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const submit = async () => {
        const trimmed = pathDraft.trim()
        if (trimmed.length === 0) return
        setBusy(true)
        setError(null)
        try {
          await onAdd(trimmed)
          onClose()
        } catch (err) {
          setError(err.message)
          setBusy(false)
        }
      }

      return h(ModalShell, { title: t('env.addProjectTitle'), onClose },
        h('p', { className: 'dshwt-modal-desc' }, t('env.addProjectDesc')),
        h('input', {
          className: 'dshwt-input',
          style: { fontFamily: 'var(--ds-font-family-code, Menlo, monospace)', fontSize: 12.5 },
          placeholder: t('env.addProjectPlaceholder'),
          value: pathDraft,
          disabled: busy,
          autoFocus: true,
          onChange: e => setPathDraft(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') void submit() },
        }),
        error ? h('div', { className: 'dshwt-setting-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshwt-modal-foot' },
          h('button', { type: 'button', className: 'dshwt-btn', disabled: busy, onClick: onClose }, t('modal.cancel')),
          h('button', { type: 'button', className: 'dshwt-btn dshwt-btn-primary', disabled: busy || pathDraft.trim().length === 0, onClick: () => void submit() },
            busy ? t('panel.act.busy') : t('env.addProjectSubmit'))))
    }

    function EnvironmentsTab({ t, data }) {
      const [projects, setProjects] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [view, setView] = useState({ mode: 'list' })
      const [showAddModal, setShowAddModal] = useState(false)

      const loadProjects = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const res = await api('/environments')
          setProjects(res?.projects ?? [])
        } catch (err) {
          setError(err.message)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void loadProjects() }, [loadProjects])

      const handleAddProject = async () => {
        setError(null)
        try {
          const picked = await pickProjectDirectory()
          if (picked === undefined) {
            setShowAddModal(true)
            return
          }
          if (picked === null) return
          await registerProjectWorkspace(picked)
          await loadProjects()
          void data.refresh()
        } catch (err) {
          setError(err.message)
        }
      }

      const handleAddPathManual = async (path) => {
        const registered = await registerProjectWorkspace(path)
        if (registered) {
          await loadProjects()
          void data.refresh()
          return
        }
        // Fallback when workspace service is unavailable: open editor directly for the path
        const res = await api(`/environments?root=${enc(path)}`)
        setView({
          mode: 'edit',
          projectRoot: res.repository?.root ?? path,
          projectName: repoName(res.repository?.root ?? path),
          configPath: res.writablePath,
          isNew: res.environment?.sourcePath === null,
          initialEnv: res.environment,
        })
      }

      if (view.mode === 'detail') {
        const project = (projects ?? []).find(p => p.root === view.projectRoot)
        const envEntry = project?.environments?.find(e => e.configPath === view.configPath) ?? null
        return h(EnvDetailView, {
          t,
          projectRoot: view.projectRoot,
          configPath: view.configPath,
          envEntry,
          onBack: () => { setView({ mode: 'list' }); void loadProjects() },
          onEdit: (loadedEnv) => setView({
            mode: 'edit',
            projectRoot: view.projectRoot,
            projectName: project?.name ?? repoName(view.projectRoot),
            configPath: view.configPath,
            isNew: false,
            initialEnv: loadedEnv,
          }),
        })
      }

      if (view.mode === 'edit') {
        return h(EnvEditorView, {
          t,
          projectRoot: view.projectRoot,
          projectName: view.projectName,
          configPath: view.configPath,
          isNew: view.isNew,
          initialEnv: view.initialEnv,
          onCancel: () => {
            if (view.isNew) setView({ mode: 'list' })
            else setView({ mode: 'detail', projectRoot: view.projectRoot, configPath: view.configPath })
          },
          onSaved: (writtenPath) => {
            void loadProjects()
            void data.refresh()
            setView({ mode: 'detail', projectRoot: view.projectRoot, configPath: writtenPath })
          },
        })
      }

      return h('div', { className: 'dshwt-settings-section' },
        h('div', { className: 'dshwt-env-list-head' },
          h('h3', { className: 'dshwt-settings-group-title' }, t('env.selectProject')),
          h('button', { type: 'button', className: 'dshwt-pill-btn', onClick: () => void handleAddProject() },
            t('env.addProject'))),

        error ? h('div', { className: 'dshwt-setting-err', role: 'alert', style: { paddingTop: 10 } }, error) : null,

        loading && projects === null
          ? h('div', { className: 'dshwt-managed-empty' }, '…')
          : (projects ?? []).length === 0
            ? h('div', { className: 'dshwt-managed-empty' }, t('env.noProjects'))
            : h('div', { className: 'dshwt-env-projects', role: 'list' },
              (projects ?? []).map(project => h('div', { key: project.root, className: 'dshwt-env-project', role: 'listitem' },
                h('div', { className: 'dshwt-env-proj-row' },
                  h('button', {
                    type: 'button',
                    className: 'dshwt-env-proj-main',
                    title: project.root,
                    onClick: () => {
                      if (project.environments.length > 0) {
                        setView({ mode: 'detail', projectRoot: project.root, configPath: project.environments[0].configPath })
                      } else {
                        setView({
                          mode: 'edit',
                          projectRoot: project.root,
                          projectName: project.name,
                          configPath: project.nextConfigPath,
                          isNew: true,
                          initialEnv: null,
                        })
                      }
                    },
                  },
                    h('span', { className: 'dshwt-env-proj-icon' }, h(ProjectIcon, { size: 17 })),
                    h('span', { className: 'dshwt-env-copy' },
                      h('span', { className: 'dshwt-env-name' }, project.name),
                      project.owner ? h('span', { className: 'dshwt-env-sub' }, project.owner) : null)),
                  h('button', {
                    type: 'button',
                    className: 'dshwt-pill-btn dshwt-pill-btn-icon',
                    title: t('env.addEnvTo', { name: project.name }),
                    'aria-label': t('env.addEnvTo', { name: project.name }),
                    onClick: () => setView({
                      mode: 'edit',
                      projectRoot: project.root,
                      projectName: project.name,
                      configPath: project.nextConfigPath,
                      isNew: true,
                      initialEnv: null,
                    }),
                  }, h(PlusIcon, { size: 14 }))),
                project.environments.length > 0
                  ? h('div', { className: 'dshwt-env-children' },
                    project.environments.map(env => {
                      const label = env.valid ? (env.name || env.fileName) : t('env.parseError')
                      const subtitle = env.valid
                        ? (env.fileName !== label ? env.fileName : env.fileName)
                        : env.fileName
                      return h('button', {
                        key: env.configPath,
                        type: 'button',
                        className: 'dshwt-env-child-row',
                        title: env.relativePath,
                        onClick: () => setView({ mode: 'detail', projectRoot: project.root, configPath: env.configPath }),
                      },
                        h('span', { className: 'dshwt-env-copy' },
                          h('span', { className: 'dshwt-env-name', style: env.valid ? undefined : { color: 'var(--dsw-alias-state-error-primary)' } }, label),
                          h('span', { className: 'dshwt-env-sub' }, subtitle)),
                        h('span', { className: 'dshwt-env-chevron-right' }, h(ChevronRightIcon, { size: 15 })))
                    }))
                  : null))),

        showAddModal
          ? h(AddProjectModal, { t, onClose: () => setShowAddModal(false), onAdd: handleAddPathManual })
          : null)
    }

    /** ---- Settings Tab (Creation & Cleanup — native DSH style) ---- */
    function SwitchControl({ checked, disabled, onChange, label }) {
      if (typeof NativePrimitives?.Switch === 'function') {
        return h(NativePrimitives.Switch, { checked, disabled, label, onChange })
      }
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        className: 'dshwt-switch',
        disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dshwt-switch-thumb' }))
    }

    function ChevronIcon({ dir, size = 9 }) {
      return h('svg', {
        viewBox: '0 0 12 12', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: dir === 'up' ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5' }))
    }

    function ChatPlusIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 20.5l1.5-5.2A8.5 8.5 0 1 1 21 11.5Z' }),
      h('path', { d: 'M12 8.5v6M9 11.5h6' }))
    }

    function TrashIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3 6h18' }),
      h('path', { d: 'M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6' }),
      h('path', { d: 'M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
      h('path', { d: 'M10 11v6M14 11v6' }))
    }

    async function openWorktreeSession(item) {
      const ctx = NS_STATE.ctx
      const sessions = ctx?.get?.('sessions')
      const uiWorkspace = ctx?.get?.('uiWorkspace')
      if (sessions === undefined || typeof sessions.create !== 'function') {
        throw new Error('session service unavailable')
      }
      const sessionId = await sessions.create({ cwd: item.path })
      if (typeof uiWorkspace?.openSession === 'function') {
        uiWorkspace.openSession(sessionId)
      }
      return sessionId
    }

    function NumberStepper({ value, draft, min = 1, disabled, label, onDraftChange, onCommit, onStep }) {
      const numeric = Math.max(min, Math.floor(Number(value) || min))
      return h('div', { className: 'dshwt-stepper' },
        h('input', {
          type: 'text',
          inputMode: 'numeric',
          className: 'dshwt-stepper-input',
          'aria-label': label,
          value: draft,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: e => onDraftChange(e.target.value.replace(/[^\d]/g, '')),
          onBlur: onCommit,
          onKeyDown: e => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
            if (e.key === 'Enter') { e.currentTarget.blur(); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); onStep(1) }
            if (e.key === 'ArrowDown') { e.preventDefault(); onStep(-1) }
          },
        }),
        h('span', { className: 'dshwt-stepper-arrows' },
          h('button', {
            type: 'button',
            className: 'dshwt-stepper-arrow',
            'aria-label': '+',
            disabled,
            onMouseDown: e => e.preventDefault(),
            onClick: () => onStep(1),
          }, h(ChevronIcon, { dir: 'up' })),
          h('button', {
            type: 'button',
            className: 'dshwt-stepper-arrow',
            'aria-label': '-',
            disabled: disabled || numeric <= min,
            onMouseDown: e => e.preventDefault(),
            onClick: () => onStep(-1),
          }, h(ChevronIcon, { dir: 'down' }))))
    }

    function ManagedWorktreesSection({ t, data, confirmBeforeDelete }) {
      const { items, loading, refresh } = data
      const [collapsed, setCollapsed] = useState(() => new Set())
      const [busyId, setBusyId] = useState(null)
      const [error, setError] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)

      const grouped = useMemo(() => {
        const active = (items ?? []).filter(i => i.status === 'active' && i.exists)
        const map = new Map()
        for (const item of active) {
          const list = map.get(item.repositoryRoot) ?? []
          list.push(item)
          map.set(item.repositoryRoot, list)
        }
        return [...map.entries()]
      }, [items])

      const toggleRepo = (repoRoot) => {
        setCollapsed(prev => {
          const next = new Set(prev)
          if (next.has(repoRoot)) next.delete(repoRoot)
          else next.add(repoRoot)
          return next
        })
      }

      const startChat = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          await openWorktreeSession(item)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusyId(null)
        }
      }

      const removeWorktree = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          await api(`/worktrees/${enc(item.id)}/archive`, { method: 'POST', body: JSON.stringify({}) })
          await refresh()
        } catch (err) {
          setError(err.message)
          throw err
        } finally {
          setBusyId(null)
        }
      }

      return h('div', { className: 'dshwt-settings-section' },
        h('div', { className: 'dshwt-managed-head' },
          h('h3', { className: 'dshwt-settings-group-title' }, t('settings.managed.title')),
          h('button', {
            type: 'button',
            className: `dshwt-icon-btn ${loading ? 'dshwt-spin' : ''}`,
            disabled: loading,
            title: t('settings.managed.refresh'),
            'aria-label': t('settings.managed.refresh'),
            onClick: () => void refresh(),
          }, h(RefreshIcon, { size: 15 }))),
        error ? h('div', { className: 'dshwt-setting-err', role: 'alert', style: { paddingTop: 8 } }, error) : null,
        grouped.length === 0
          ? h('div', { className: 'dshwt-managed-empty' }, t('settings.managed.empty'))
          : grouped.map(([repoRoot, list]) => {
            const expanded = !collapsed.has(repoRoot)
            return h('div', { key: repoRoot, className: 'dshwt-managed-group' },
              h('button', {
                type: 'button',
                className: 'dshwt-managed-repo',
                'aria-expanded': expanded,
                onClick: () => toggleRepo(repoRoot),
              },
                h('span', { className: 'dshwt-managed-repo-name', title: repoRoot }, repoName(repoRoot)),
                h('span', { className: 'dshwt-managed-repo-meta' },
                  h('span', null, t('settings.managed.count', { count: list.length })),
                  h('span', { className: 'dshwt-managed-chevron' }, h(ChevronIcon, { dir: 'down', size: 12 })))),
              expanded
                ? h('div', { className: 'dshwt-managed-items' },
                  list.map(item => {
                    const rowBusy = busyId === item.id
                    return h('div', { key: item.id, className: 'dshwt-managed-item' },
                      h('div', { className: 'dshwt-managed-copy' },
                        h('div', { className: 'dshwt-managed-name' }, item.branch),
                        h('div', { className: 'dshwt-managed-path', title: item.path }, item.path)),
                      h('div', { className: 'dshwt-managed-acts' },
                        h('button', {
                          type: 'button',
                          className: 'dshwt-icon-btn',
                          disabled: rowBusy,
                          title: t('settings.managed.newChat'),
                          'aria-label': t('settings.managed.newChat'),
                          onClick: () => void startChat(item),
                        }, h(ChatPlusIcon, { size: 16 })),
                        h('button', {
                          type: 'button',
                          className: 'dshwt-icon-btn dshwt-icon-btn-danger',
                          disabled: rowBusy,
                          title: t('settings.managed.delete'),
                          'aria-label': t('settings.managed.delete'),
                          onClick: () => {
                            if (confirmBeforeDelete) setPendingDelete(item)
                            else void removeWorktree(item).catch(() => {})
                          },
                        }, h(TrashIcon, { size: 15 }))))
                  }))
                : null)
          }),
        pendingDelete !== null
          ? h(ConfirmModal, {
            title: t('settings.managed.deleteTitle'),
            desc: t('settings.managed.deleteDesc', { branch: pendingDelete.branch }),
            submitLabel: t('settings.managed.deleteSubmit'),
            danger: true,
            onClose: () => setPendingDelete(null),
            onConfirm: () => removeWorktree(pendingDelete),
            t,
          })
          : null)
    }

    function SettingsTab({ t, configState, data }) {
      const { config, update } = configState
      const [dirDraft, setDirDraft] = useState(config.worktreeDirectory ?? '')
      const [keepDraft, setKeepDraft] = useState(String(config.keepCount ?? 15))
      const [busy, setBusy] = useState(false)
      const [savedVisible, setSavedVisible] = useState(false)
      const [dirError, setDirError] = useState(null)
      const [generalError, setGeneralError] = useState(null)
      const savedTimerRef = useRef(null)

      useEffect(() => { setDirDraft(config.worktreeDirectory ?? '') }, [config.worktreeDirectory])
      useEffect(() => { setKeepDraft(String(config.keepCount ?? 15)) }, [config.keepCount])
      useEffect(() => () => { if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current) }, [])

      const flashSaved = () => {
        setSavedVisible(true)
        if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => { setSavedVisible(false); savedTimerRef.current = null }, 1800)
      }

      const save = async (patch, target = 'general') => {
        setBusy(true)
        if (target === 'dir') setDirError(null)
        else setGeneralError(null)
        try {
          await update(patch)
          flashSaved()
        } catch (err) {
          if (target === 'dir') setDirError(err.message)
          else setGeneralError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const commitDir = () => {
        const next = dirDraft.trim().replace(/\/+$/, '')
        setDirError(null)
        if (next === (config.worktreeDirectory ?? '')) return
        void save({ worktreeDirectory: next }, 'dir')
      }

      const commitKeepCount = () => {
        const parsed = Math.max(1, Math.floor(Number(keepDraft) || 15))
        setKeepDraft(String(parsed))
        if (parsed === config.keepCount) return
        void save({ keepCount: parsed })
      }

      const stepKeepCount = (delta) => {
        const base = Math.max(1, Math.floor(Number(keepDraft) || config.keepCount || 15))
        const next = Math.max(1, base + delta)
        setKeepDraft(String(next))
        if (next === config.keepCount) return
        void save({ keepCount: next })
      }

      return h('div', { className: 'dshwt-settings-stack' },
        h('div', { className: 'dshwt-settings-section' },
          h('div', { className: 'dshwt-settings-head' },
            h('h3', { className: 'dshwt-settings-group-title' }, t('settings.group')),
            savedVisible ? h('span', { className: 'dshwt-settings-saved', role: 'status' }, t('settings.saved')) : null),
          generalError ? h('div', { className: 'dshwt-setting-err', role: 'alert', style: { paddingBottom: 8 } }, generalError) : null,
          h('div', { className: 'dshwt-settings-list' },
            h('div', { className: 'dshwt-setting-row' },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.worktreeDir.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.worktreeDir.desc')),
                dirError ? h('div', { className: 'dshwt-setting-err', role: 'alert' }, dirError) : null),
              h('div', { className: 'dshwt-setting-ctrl' },
                h('input', {
                  className: 'dshwt-setting-input',
                  placeholder: config.defaultWorktreeDirectory || '.agents/worktrees',
                  'aria-label': t('settings.worktreeDir.label'),
                  'aria-invalid': dirError ? true : undefined,
                  spellCheck: false,
                  autoComplete: 'off',
                  value: dirDraft,
                  disabled: busy,
                  onChange: e => { setDirDraft(e.target.value); if (dirError) setDirError(null) },
                  onBlur: commitDir,
                  onKeyDown: e => {
                    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                    if (e.key === 'Enter') e.currentTarget.blur()
                  },
                }))),
            h('div', { className: 'dshwt-setting-row' },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.fetch.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.fetch.desc'))),
              h('div', { className: 'dshwt-setting-ctrl' },
                h(SwitchControl, {
                  checked: config.upstreamRefreshMode === 'best-effort',
                  disabled: busy,
                  label: t('settings.fetch.label'),
                  onChange: next => void save({ upstreamRefreshMode: next ? 'best-effort' : 'never' }),
                }))),
            h('div', { className: 'dshwt-setting-row' },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.keepCount.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.keepCount.desc'))),
              h('div', { className: 'dshwt-setting-ctrl' },
                h(NumberStepper, {
                  value: config.keepCount ?? 15,
                  draft: keepDraft,
                  min: 1,
                  disabled: busy,
                  label: t('settings.keepCount.label'),
                  onDraftChange: setKeepDraft,
                  onCommit: commitKeepCount,
                  onStep: stepKeepCount,
                }))),
            h('div', { className: 'dshwt-setting-row' },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.confirmDelete.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.confirmDelete.desc'))),
              h('div', { className: 'dshwt-setting-ctrl' },
                h(SwitchControl, {
                  checked: config.confirmBeforeDelete !== false,
                  disabled: busy,
                  label: t('settings.confirmDelete.label'),
                  onChange: next => void save({ confirmBeforeDelete: next }),
                }))))),
        h(ManagedWorktreesSection, { t, data, confirmBeforeDelete: config.confirmBeforeDelete !== false }))
    }

    /** ---- Main Panel ---- */
    function WorktreePanel() {
      const { t } = useLocale()
      const data = useWorktrees()
      const configState = usePluginConfig()
      const [tab, setTab] = useState('settings')

      return h('div', { className: 'dshwt-page' },
        h(StyleTag),
        h('div', { className: 'dshwt-col' },
          h('header', { className: 'dshwt-head' },
            h('div', { className: 'dshwt-head-main' },
              h('h1', { className: 'dshwt-title' }, t('panel.title')),
              h('p', { className: 'dshwt-subtitle' }, t('panel.subtitle')))),

          h('nav', { className: 'dshwt-tabs', role: 'tablist' },
            h('button', { type: 'button', role: 'tab', className: 'dshwt-tab', 'aria-selected': tab === 'settings', onClick: () => setTab('settings') },
              t('panel.tab.settings')),
            h('button', { type: 'button', role: 'tab', className: 'dshwt-tab', 'aria-selected': tab === 'environments', onClick: () => setTab('environments') },
              t('panel.tab.environments'))),

          tab === 'settings'
            ? h(SettingsTab, { t, configState, data })
            : h(EnvironmentsTab, { t, data })))
    }

    /** ---- Right-sidebar tab body ---- */
    function RightPane() {
      const { t } = useLocale()
      const { items, loading, refresh } = useWorktrees()
      const { config } = usePluginConfig()
      const [modal, setModal] = useState(null)
      const [logOp, setLogOp] = useState(null)
      const active = (items ?? []).filter(item => item.status === 'active' && item.exists)

      return h('div', { className: 'dshwt-pane' },
        h(StyleTag),
        h('div', { className: 'dshwt-pane-head' },
          h(BranchIcon, { size: 15 }),
          h('strong', { style: { fontSize: 13 } }, t('tab.title')),
          h('span', { className: 'dshwt-spacer' }),
          h('button', { className: `dshwt-btn dshwt-btn-sm dshwt-btn-ghost ${loading ? 'dshwt-spin' : ''}`, onClick: () => void refresh(), title: t('tab.refresh') },
            h(RefreshIcon, { size: 13 }))),
        active.length === 0
          ? h('div', { className: 'dshwt-empty', style: { padding: '28px 14px' } },
            h('div', { className: 'dshwt-empty-title' }, t('tab.empty')),
            h('div', { className: 'dshwt-empty-hint' }, t('tab.emptyHint')))
          : active.map(item => h(RightCard, {
            key: item.id, item, t, refresh,
            confirmBeforeDelete: config.confirmBeforeDelete !== false,
            onOpenLog: (id, label) => setLogOp({ id, label }),
            onModal: setModal,
          })),
        logOp !== null
          ? h(LogDrawer, {
            operationId: logOp.id,
            label: logOp.label,
            inline: true,
            onClose: () => setLogOp(null),
            onSettled: () => void refresh(),
            t,
          })
          : null,
        modal?.kind === 'apply'
          ? h(ApplyPatchModal, { item: modal.item, t, onClose: () => setModal(null), onApplied: () => void refresh() })
          : null,
        modal?.kind === 'archive'
          ? h(ConfirmModal, {
            title: t('modal.archive.title'),
            desc: t('modal.archive.desc', { branch: modal.item.branch }),
            submitLabel: t('modal.archive.submit'),
            onClose: () => setModal(null),
            onConfirm: async () => {
              await api(`/worktrees/${enc(modal.item.id)}/archive`, { method: 'POST', body: JSON.stringify({}) })
              await refresh()
            },
            t,
          })
          : null)
    }

    function RightCard({ item, t, refresh, confirmBeforeDelete, onOpenLog, onModal }) {
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)

      const startAction = async (name) => {
        setBusy(true)
        setNote(null)
        try {
          const result = await api(`/worktrees/${enc(item.id)}/actions/${enc(name)}/run`, { method: 'POST' })
          if (result?.operationId) onOpenLog(result.operationId, `${item.branch} · ${name}`)
        } catch (e) {
          setNote({ tone: 'err', text: e.message })
        } finally {
          setBusy(false)
        }
      }

      const startSetup = async () => {
        setBusy(true)
        setNote(null)
        try {
          const result = await api(`/worktrees/${enc(item.id)}/setup?async=1`, { method: 'POST', body: JSON.stringify({ async: true }) })
          if (result?.operationId) onOpenLog(result.operationId, `${item.branch} · setup`)
          await refresh()
        } catch (e) {
          setNote({ tone: 'err', text: e.message })
        } finally {
          setBusy(false)
        }
      }

      const setupLabel = t(`panel.setup.${item.setupState ?? 'not-configured'}`) || item.setupState

      return h('div', { className: 'dshwt-pane-card' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { className: 'dshwt-branch' }, item.branch),
          h('span', { className: 'dshwt-spacer' }),
          item.setupState && item.setupState !== 'not-configured'
            ? h('span', { className: 'dshwt-tag', 'data-tone': setupTone(item.setupState) }, setupLabel)
            : null),
        h('div', { className: 'dshwt-group-path', title: item.path }, shortRepo(item.repositoryRoot)),
        (item.actions?.length ?? 0) > 0
          ? h('div', { className: 'dshwt-chips' },
            item.actions.map(action => h('button', {
              key: action.name, className: 'dshwt-action-pill', disabled: busy, title: action.command,
              onClick: () => void startAction(action.name),
            }, h(ActionIcon, { kind: action.icon }), action.name)))
          : null,
        h('div', { className: 'dshwt-card-ops' },
          h('button', { className: 'dshwt-btn dshwt-btn-sm', disabled: busy, onClick: () => void startSetup() }, t('panel.act.setup')),
          h('button', { className: 'dshwt-btn dshwt-btn-sm', disabled: busy, onClick: () => onModal({ kind: 'apply', item }) }, t('panel.act.apply')),
          h('button', {
            className: 'dshwt-btn dshwt-btn-sm', disabled: busy,
            onClick: () => {
              if (confirmBeforeDelete) onModal({ kind: 'archive', item })
              else void api(`/worktrees/${enc(item.id)}/archive`, { method: 'POST', body: JSON.stringify({}) }).then(refresh, e => setNote({ tone: 'err', text: e.message }))
            },
          }, t('panel.act.archive'))),
        note ? h('div', { className: 'dshwt-banner', 'data-tone': note.tone }, note.text) : null)
    }

    /** ---- session menu rows ---- */
    async function sendToSession(ctx, sessionId, text) {
      const sessions = ctx.get('sessions')
      const binding = sessions?.binding?.(sessionId)
      if (typeof binding?.prompt === 'function') {
        return await binding.prompt(text)
      }
      const scope = sessions?.scope?.(sessionId)
      const conversation = scope?.get?.('conversation')
      if (typeof conversation?.send === 'function') {
        return await conversation.send(text)
      }
      const remoteSession = ctx.get('remote.session')
      if (typeof remoteSession?.prompt === 'function') {
        return await remoteSession.prompt({ sessionId, prompt: text })
      }
      throw new Error('session conversation unavailable')
    }

    function sessionCwdOf(ctx, sessionId) {
      const summary = ctx.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]
      if (summary === undefined || summary === null) return null
      const projected = summary.projections?.workingDirectory
      if (typeof projected === 'string' && projected.length > 0) return projected
      if (typeof summary.cwd === 'string' && summary.cwd.length > 0) return summary.cwd
      return null
    }

    function SessionMenuRows(ctx, t) {
      return function MenuRow(props) {
        const [sent, setSent] = useState(null)
        const [inManagedWorktree, setInManagedWorktree] = useState(() => {
          const cwd = props.cwd ?? sessionCwdOf(ctx, props.sessionId ?? props.id)
          return typeof cwd === 'string' && cwd.includes('/.agents/worktrees/')
        })
        const menuState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
        const sessionId = props.sessionId ?? props.id
        useEffect(() => {
          if (typeof sessionId !== 'string') return
          let cancelled = false
          void api('/worktrees').then((value) => {
            if (cancelled) return
            const cwd = sessionCwdOf(ctx, sessionId)
            const matched = (value?.items ?? []).some(item =>
              (item.sessions ?? []).some(s => s.sessionId === sessionId)
              || (typeof cwd === 'string' && item.status === 'active' && (cwd === item.path || cwd.startsWith(`${item.path}/`))),
            )
            setInManagedWorktree(matched || (typeof cwd === 'string' && cwd.includes('/.agents/worktrees/')))
          }).catch(() => {})
          return () => { cancelled = true }
        }, [sessionId])
        const close = () => {
          if (typeof menuState?.[1] === 'function') menuState[1](false)
          else props.hookContext?.[1]?.(false)
        }
        const send = (command, noteOk) => {
          if (typeof sessionId !== 'string') return
          void sendToSession(ctx, sessionId, command).then(
            () => { setSent(noteOk); close() },
            () => setSent(t('menu.sendFailed')),
          )
        }
        const rows = []
        if (!inManagedWorktree) {
          rows.push({ key: 'handoff', label: t('menu.handoff'), command: '/worktree handoff' })
        } else {
          rows.push({ key: 'apply', label: t('menu.apply'), command: '/worktree apply-patch' })
          rows.push({ key: 'archive', label: t('menu.archive'), command: '/worktree archive' })
        }
        return h(React.Fragment, null,
          rows.map(row => h('button', {
            key: row.key, className: 'dshwt-menuitem', type: 'button', role: 'menuitem',
            onClick: () => send(row.command, t('menu.sending')),
          }, h(BranchIcon, { size: 14 }), row.label)),
          sent !== null ? h('div', { style: { padding: '4px 10px', fontSize: 12, color: 'var(--dsw-alias-label-caption, gray)' } }, sent) : null)
      }
    }

    /** ---- locale plumbing ---- */
    const NS_STATE = { dicts: { zh, en }, listeners: new Set() }
    function detectLang() {
      if (typeof navigator !== 'undefined') {
        const preferred = navigator.language?.toLowerCase() ?? 'en'
        if (preferred.startsWith('zh')) return 'zh'
      }
      return 'en'
    }
    function useLocale() {
      const [lang, setLang] = useState(detectLang)
      useEffect(() => {
        NS_STATE.listeners.add(setLang)
        return () => { NS_STATE.listeners.delete(setLang) }
      }, [])
      const t = useCallback((key, params) => {
        const dict = NS_STATE.dicts[lang] ?? NS_STATE.dicts.en ?? {}
        let text = dict[key] ?? (NS_STATE.dicts.en ?? {})[key] ?? key
        if (params !== undefined) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
        return text
      }, [lang])
      return { lang, t }
    }

    function registerDictionaries(ctx) {
      const locale = ctx.get('locale')
      if (locale === undefined) return () => {}
      const dispose = []
      for (const [id, dict] of Object.entries(NS_STATE.dicts)) {
        try {
          dispose.push(locale.register(NS, id, dict))
        } catch {
          // keep fallback dictionaries
        }
      }
      NS_STATE.ctxLocale = locale
      return () => { for (const d of dispose) d() }
    }

    function mountStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      let el = document.getElementById('dshwt-styles')
      if (el !== null) {
        el.textContent = CSS
        return () => {}
      }
      el = document.createElement('style')
      el.id = 'dshwt-styles'
      el.textContent = CSS
      document.head.appendChild(el)
      return () => { el.remove() }
    }

    function StyleTag() {
      return null
    }

    /** ---- plugin entry ---- */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        NS_STATE.ctx = ctx
        const disposeStyles = ctx.effect(() => mountStyles(), 'dsh-worktree-env: styles')
        const disposeDictionaries = registerDictionaries(ctx)
        const disposers = [() => { if (NS_STATE.ctx === ctx) NS_STATE.ctx = null }, disposeStyles, disposeDictionaries]

        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'dsh-worktree-env', order: 25,
          label: () => (ctx.locale?.bind?.(NS)?.('panel.title') ?? zh['panel.title']),
        }, function PanelIconButton(props) {
          return h(BranchIcon, { size: props?.size ?? 18 })
        })), 'dsh-worktree-env: panel icon'))

        disposers.push(ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'dsh-worktree-env',
          label: () => (ctx.locale?.bind?.(NS)?.('panel.title') ?? zh['panel.title']),
        }, WorktreePanel)), 'dsh-worktree-env: main panel'))

        disposers.push(ctx.effect(() => {
          const tabs = ctx.get('sidebarRightTabs')
          if (tabs === undefined || typeof tabs.register !== 'function') return () => {}
          const disposeTab = tabs.register({
            id: 'dsh-worktree-env',
            kind: 'dsh-worktree-env',
            priority: 'plugin',
            title: () => (ctx.locale?.bind?.(NS)?.('tab.title') ?? zh['tab.title']),
          })
          const disposePane = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: 'dsh-worktree-env',
          }, RightPane))
          return () => { disposePane(); disposeTab() }
        }, 'dsh-worktree-env: right tab'))

        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: 'dsh-worktree-env-menu', order: 350,
        }, SessionMenuRows(ctx, useLocaleProxy()))), 'dsh-worktree-env: session menu'))

        return () => { for (const dispose of disposers) dispose() }
      },
    }

    function useLocaleProxy() {
      return (key) => {
        const lang = detectLang()
        return (NS_STATE.dicts[lang] ?? NS_STATE.dicts.en)[key] ?? key
      }
    }
  },
})
