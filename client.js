/**
 * dsh-worktree-env Web client:
 * - Native DSH `--dsw-alias-*` design system (light & dark mode, macOS clearance)
 * - Main "Worktrees" panel: Settings (creation & cleanup synced with DSH's
 *   built-in worktree module + collapsible managed worktrees list) and a visual
 *   `environment.toml` editor with per-platform script switcher
 * - Session top-bar quick actions (`conversation.session.header.utilities`)
 *   with portaled menu and floating live SSE log drawer
 * - Session menu items (`sidebar.workspaces.session.menu.item`) for /worktree
 */
window.__ModuleLoader__.load({
  id: 'dsh-worktree-env',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch {}
    let NativePrimitives = null
    try { NativePrimitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

    const hasNativeTooltip = typeof NativePrimitives?.Tooltip === 'function'
    function Hint({ label, side = 'bottom', align, delayMs = 250, children }) {
      if (!hasNativeTooltip || typeof label !== 'string' || label.length === 0) return children
      return h(NativePrimitives.Tooltip, { label, side, align, delayMs, portal: true }, children)
    }

    function portalToBody(node) {
      if (node === null || node === undefined) return null
      if (typeof ReactDOM?.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
        return ReactDOM.createPortal(node, document.body)
      }
      return node
    }

    const NS = 'dshWorktreeEnv'
    const API = '/api/dsh-worktree-env'
    const LOG_TAB_ID = 'dsh-worktree-env-logs'
    const LOG_TAB_KIND = 'dsh-worktree-env-logs'
    const GLOBAL_SESSION_KEY = '__global__'
    const NEW_BRANCH_SENTINEL = '__new__'

    const zh = {
      'panel.title': 'Worktrees',
      'panel.subtitle': '管理工作树目录、自动清理策略、托管工作树与本地环境初始化脚本',
      'panel.tab.settings': '设置',
      'panel.tab.environments': '环境',
      'settings.group': '创建与清理',
      'settings.worktreeDir.label': '工作树目录（项目内相对路径）',
      'settings.worktreeDir.desc': '留空默认使用 .agents/worktrees；修改后会同步生效于 DSH 内置「新建工作树」',
      'settings.worktreeDir.invalid': '工作树目录必须是项目内的相对路径，不能以 / 开头或包含 . / .. / \\ / :（例如 .agents/worktrees 或 .worktrees）',
      'settings.fetch.label': '创建工作树前获取远程更新',
      'settings.fetch.desc': '创建工作树前，检查远程仓库是否有更新的提交',
      'settings.autoCleanup.label': '自动删除旧工作树',
      'settings.autoCleanup.desc': '先保存一份恢复快照',
      'settings.autoCleanup.info': '自动清理或手动删除工作树前，会将未提交的改动保存在项目 .git/refs/dsh-worktree-env/snapshots/ 下；重新打开对应会话时可直接一键恢复。',
      'settings.keepCount.label': '保留的工作树数量',
      'settings.keepCount.desc': '较旧的工作树会自动清理。已置顶或进行中的聊天所用的工作树会保留。',
      'settings.keepCount.increase': '增加保留数量',
      'settings.keepCount.decrease': '减少保留数量',
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
      'settings.archived.title': '已归档的工作树',
      'settings.archived.snapshot': '含快照',
      'settings.archived.restore': '恢复工作树',
      'settings.archived.purge': '彻底删除',
      'settings.archived.purgeTitle': '彻底删除归档记录',
      'settings.archived.purgeDesc': '将永久移除「{branch}」的归档记录及关联的恢复快照，操作无法撤销。',
      'error.sessionUnavailable': '当前会话服务不可用',
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
      'modal.done': '完成',
      'modal.apply.title': '应用改动到主目录',
      'modal.apply.desc': '将 worktree「{branch}」的改动通过 git apply --3way 合并回源主目录，冲突时会中止而不静默覆盖。',
      'modal.apply.branchLabel': '目标分支',
      'modal.apply.branchCurrent': '{branch}（当前）',
      'modal.apply.branchNewOption': '+ 新建分支…',
      'modal.apply.branchNewPlaceholder': '输入新分支名称（如 feat/login）',
      'modal.apply.switchNote': '主目录将自动从「{from}」切换到「{to}」后再应用改动（不会自动提交）。',
      'modal.apply.dirtyBlocked': '主目录当前在「{branch}」且有 {count} 个未提交改动，无法切换分支。请先提交或暂存主目录改动，或直接应用到当前分支。',
      'modal.apply.invalidBranch': '分支名称不合法，请重新输入。',
      'modal.apply.branchExists': '分支「{branch}」已存在，请直接从下拉列表中选择或更换名称。',
      'modal.apply.modeLabel': '回流范围',
      'modal.apply.modeBranch': '分支全部改动（已提交 + 未提交）',
      'modal.apply.modeUncommitted': '仅未提交改动（相对当前 HEAD）',
      'modal.apply.checking': '正在预检补丁冲突…',
      'modal.apply.noChanges': '当前范围没有可应用的改动。',
      'modal.apply.ready': '预检通过：将应用 {count} 个文件的改动，无冲突。',
      'modal.apply.readyBranch': '预检通过：将把 {count} 个文件的改动应用到「{branch}」，无冲突。',
      'modal.apply.conflict': '检测到冲突，无法自动应用：',
      'modal.apply.submit': '确认应用改动',
      'modal.apply.submitTo': '应用到 {branch}',
      'modal.apply.done': '已将 {count} 个文件的改动应用到主目录分支「{branch}」。',
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
      'env.actionsDesc': '以下操作可运行任意命令，并显示在顶部栏中',
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
      'header.actions.run': '运行 {name}',
      'header.actions.menu': '快捷操作',
      'header.actions.viewLogs': '查看运行日志',
      'header.actions.running': '运行中',
      'header.actions.focusTerminal': '切换到 {name} 终端',
      'header.actions.runNewTerminal': '在新终端中运行',
      'header.restore.label': '恢复工作树',
      'header.restore.restoring': '恢复中…',
      'header.restore.tipSnapshot': '工作树「{branch}」已归档（含恢复快照），点击一键恢复目录与未提交改动',
      'header.restore.tipPlain': '工作树「{branch}」已归档，点击重新检出目录',
      'menu.handoff': '带改动转入 Worktree',
      'menu.apply': '应用改动到主目录',
      'menu.restore': '恢复工作树',
      'menu.sending': '已发送 /worktree 指令',
      'menu.sendFailed': '指令发送失败',
      'logs.title': '运行日志',
      'logs.copy': '复制',
      'logs.copied': '已复制',
      'logs.close': '关闭',
      'logs.cancel': '停止',
      'logs.minimize': '收起',
      'logs.expand': '展开',
      'logs.rerun': '重新运行',
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
      'settings.worktreeDir.invalid': 'Worktree directory must be a project-relative path without leading "/", ".", "..", "\\", or ":" (e.g. .agents/worktrees or .worktrees)',
      'settings.fetch.label': 'Fetch before creating worktrees',
      'settings.fetch.desc': 'Check the remote for newer commits before creating a worktree',
      'settings.autoCleanup.label': 'Automatically delete old worktrees',
      'settings.autoCleanup.desc': 'Saves a recovery snapshot first',
      'settings.autoCleanup.info': 'Before automatically cleaning up or deleting a worktree, uncommitted changes are saved under .git/refs/dsh-worktree-env/snapshots/ and can be restored with one click when reopening the chat.',
      'settings.keepCount.label': 'Worktrees to keep',
      'settings.keepCount.desc': 'Older worktrees are cleaned up automatically. Worktrees for pinned or active chats are kept.',
      'settings.keepCount.increase': 'Increase worktrees to keep',
      'settings.keepCount.decrease': 'Decrease worktrees to keep',
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
      'settings.archived.title': 'Archived worktrees',
      'settings.archived.snapshot': 'Snapshot',
      'settings.archived.restore': 'Restore worktree',
      'settings.archived.purge': 'Delete permanently',
      'settings.archived.purgeTitle': 'Delete archived record',
      'settings.archived.purgeDesc': 'Permanently removes the archived record and recovery snapshot for "{branch}". This cannot be undone.',
      'error.sessionUnavailable': 'Session service unavailable',
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
      'modal.done': 'Done',
      'modal.apply.title': 'Apply changes to source checkout',
      'modal.apply.desc': 'Merge changes from "{branch}" back onto the source checkout using git apply --3way. Conflicts abort cleanly without overwriting.',
      'modal.apply.branchLabel': 'Target branch',
      'modal.apply.branchCurrent': '{branch} (current)',
      'modal.apply.branchNewOption': '+ Create new branch…',
      'modal.apply.branchNewPlaceholder': 'Enter new branch name (e.g. feat/login)',
      'modal.apply.switchNote': 'Source checkout will switch from "{from}" to "{to}" before applying changes (not committed automatically).',
      'modal.apply.dirtyBlocked': 'Source checkout is on "{branch}" with {count} uncommitted change(s), so it cannot switch branches. Commit/stash them first, or apply onto the current branch.',
      'modal.apply.invalidBranch': 'Invalid branch name. Please enter a valid Git branch name.',
      'modal.apply.branchExists': 'Branch "{branch}" already exists. Select it from the list or choose another name.',
      'modal.apply.modeLabel': 'Scope',
      'modal.apply.modeBranch': 'Full branch diff (committed + uncommitted)',
      'modal.apply.modeUncommitted': 'Uncommitted changes only (vs HEAD)',
      'modal.apply.checking': 'Checking for patch conflicts…',
      'modal.apply.noChanges': 'No changes to apply in this scope.',
      'modal.apply.ready': 'Precheck passed: {count} file(s) will apply cleanly.',
      'modal.apply.readyBranch': 'Precheck passed: {count} file(s) will apply cleanly onto "{branch}".',
      'modal.apply.conflict': 'Conflicts prevent a clean apply:',
      'modal.apply.submit': 'Apply changes',
      'modal.apply.submitTo': 'Apply to {branch}',
      'modal.apply.done': 'Applied {count} file(s) onto "{branch}" in the source checkout.',
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
      'env.actionsDesc': 'Actions run custom commands and appear in the top bar',
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
      'header.actions.run': 'Run {name}',
      'header.actions.menu': 'Quick actions',
      'header.actions.viewLogs': 'View operation logs',
      'header.actions.running': 'Running',
      'header.actions.focusTerminal': 'Focus {name} terminal',
      'header.actions.runNewTerminal': 'Run in a new terminal',
      'header.restore.label': 'Restore worktree',
      'header.restore.restoring': 'Restoring…',
      'header.restore.tipSnapshot': 'Worktree "{branch}" was archived with a recovery snapshot. Click to restore the directory and uncommitted changes.',
      'header.restore.tipPlain': 'Worktree "{branch}" was archived. Click to check out the directory again.',
      'menu.handoff': 'Move into worktree with changes',
      'menu.apply': 'Apply changes to source',
      'menu.restore': 'Restore worktree',
      'menu.sending': 'Sent the /worktree command',
      'menu.sendFailed': 'Failed to send the command',
      'logs.title': 'Operation logs',
      'logs.copy': 'Copy',
      'logs.copied': 'Copied',
      'logs.close': 'Close',
      'logs.cancel': 'Stop',
      'logs.minimize': 'Minimize',
      'logs.expand': 'Expand',
      'logs.rerun': 'Re-run',
      'logs.empty': 'Waiting for output…',
      'logs.status.running': 'Running',
      'logs.status.succeeded': 'Succeeded',
      'logs.status.failed': 'Failed',
      'logs.status.cancelled': 'Cancelled',
    }

    const ja = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'ワークツリーディレクトリ、自動クリーンアップ設定、管理対象ワークツリー、ローカル環境スクリプトを管理します',
      'panel.tab.settings': '設定',
      'panel.tab.environments': '環境',
      'settings.group': '作成とクリーンアップ',
      'settings.worktreeDir.label': 'ワークツリーディレクトリ（プロジェクト内相対パス）',
      'settings.worktreeDir.desc': '空の場合は .agents/worktrees を使用します。変更は DSH 組み込みのワークツリー作成と同期されます',
      'settings.worktreeDir.invalid': 'ワークツリーディレクトリはプロジェクト内の相対パスである必要があります（先頭の "/"、"."、".."、"\\"、":" は使用不可。例: .agents/worktrees）',
      'settings.fetch.label': 'ワークツリー作成前にリモートを取得',
      'settings.fetch.desc': 'ワークツリーを作成する前にリモートの最新コミットを確認します',
      'settings.autoCleanup.label': '古いワークツリーを自動削除',
      'settings.autoCleanup.desc': '最初に復元スナップショットを保存',
      'settings.autoCleanup.info': '自動クリーンアップや削除の前に、未コミットの変更を .git/refs/dsh-worktree-env/snapshots/ に保存します。対応するチャットを再度開くとワンクリックで復元できます。',
      'settings.keepCount.label': '保持するワークツリー数',
      'settings.keepCount.desc': '古いワークツリーは自動的にクリーンアップされます。ピン留めやアクティブなチャットで使用中のワークツリーは保持されます。',
      'settings.keepCount.increase': '保持数を増やす',
      'settings.keepCount.decrease': '保持数を減らす',
      'settings.confirmDelete.label': 'ワークツリー削除前に確認する',
      'settings.confirmDelete.desc': '手動で削除するワークツリーに適用されます',
      'settings.saved': '設定を保存しました',
      'settings.managed.title': '管理中のワークツリー',
      'settings.managed.refresh': 'ワークツリー一覧を更新',
      'settings.managed.count': '{count} 件のワークツリー',
      'settings.managed.empty': '管理中のワークツリーはありません',
      'settings.managed.newChat': 'このワークツリーで新規チャットを開始',
      'settings.managed.delete': 'ワークツリーを削除',
      'settings.managed.deleteTitle': 'ワークツリーを削除',
      'settings.managed.deleteDesc': '「{branch}」のローカルワークツリーを削除します。未コミットの変更がある場合は先に復元スナップショットを保存します。',
      'settings.managed.deleteSubmit': '削除',
      'settings.archived.title': 'アーカイブ済みのワークツリー',
      'settings.archived.snapshot': 'スナップショット',
      'settings.archived.restore': 'ワークツリーを復元',
      'settings.archived.purge': '完全に削除',
      'settings.archived.purgeTitle': 'アーカイブ記録を削除',
      'settings.archived.purgeDesc': '「{branch}」のアーカイブ記録と復元スナップショットを完全に削除します。この操作は元に戻せません。',
      'error.sessionUnavailable': 'セッションサービスが利用できません',
      'panel.refresh': '更新',
      'panel.setup.none': 'Setup 未実行',
      'panel.setup.running': 'Setup 実行中',
      'panel.setup.succeeded': 'Setup 完了',
      'panel.setup.failed': 'Setup 失敗',
      'panel.setup.not-configured': '環境未設定',
      'panel.act.setup': 'Setup を実行',
      'panel.act.apply': '元ディレクトリに適用',
      'panel.act.archive': 'アーカイブ',
      'panel.act.busy': '処理中…',
      'panel.act.error': '失敗',
      'modal.cancel': 'キャンセル',
      'modal.confirm': '確認',
      'modal.done': '完了',
      'modal.apply.title': '元のチェックアウトに変更を適用',
      'modal.apply.desc': '「{branch}」の変更を git apply --3way で元のディレクトリに統合します。競合がある場合は上書きせず中止します。',
      'modal.apply.branchLabel': '適用先ブランチ',
      'modal.apply.branchCurrent': '{branch}（現在）',
      'modal.apply.branchNewOption': '+ 新しいブランチを作成…',
      'modal.apply.branchNewPlaceholder': '新しいブランチ名を入力（例: feat/login）',
      'modal.apply.switchNote': '変更適用前に元ディレクトリを「{from}」から「{to}」へ切り替えます（自動コミットはしません）。',
      'modal.apply.dirtyBlocked': '元ディレクトリは「{branch}」にあり未コミット変更が {count} 件あるためブランチを切り替えられません。先にコミット／退避するか、現在のブランチへ適用してください。',
      'modal.apply.invalidBranch': 'ブランチ名が無効です。有効な Git ブランチ名を入力してください。',
      'modal.apply.branchExists': 'ブランチ「{branch}」は既に存在します。一覧から選択するか別の名前を指定してください。',
      'modal.apply.modeLabel': '適用範囲',
      'modal.apply.modeBranch': 'ブランチ全体の差分（コミット済み + 未コミット）',
      'modal.apply.modeUncommitted': '未コミットの変更のみ（HEAD との差分）',
      'modal.apply.checking': 'パッチ競合を事前チェック中…',
      'modal.apply.noChanges': 'この範囲には適用する変更がありません。',
      'modal.apply.ready': '事前チェック完了：{count} 件のファイルを競合なしで適用できます。',
      'modal.apply.readyBranch': '事前チェック完了：{count} 件のファイルを「{branch}」へ競合なしで適用できます。',
      'modal.apply.conflict': '競合が検出されたため自動適用できません：',
      'modal.apply.submit': '変更を適用',
      'modal.apply.submitTo': '{branch} に適用',
      'modal.apply.done': '{count} 件の変更を元ディレクトリの「{branch}」に適用しました。',
      'modal.archive.title': 'ワークツリーをアーカイブ',
      'modal.archive.desc': '「{branch}」をアーカイブすると cleanup スクリプトを実行しディレクトリを削除します。未コミットの変更は非表示の Git スナップショットに保存され復元可能です。',
      'modal.archive.submit': 'アーカイブする',
      'env.selectProject': 'プロジェクトを選択',
      'env.addProject': 'プロジェクトを追加',
      'env.addProjectTitle': 'プロジェクトフォルダを追加',
      'env.addProjectDesc': 'environment.toml を管理するローカルプロジェクトのパスを入力してください。',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': '追加',
      'env.addEnvTo': '{name} に環境設定を追加',
      'env.noProjects': 'プロジェクトがありません。「プロジェクトを追加」をクリックするか、サイドバーでワークスペースを開いてください。',
      'env.back': '戻る',
      'env.backToProjects': 'プロジェクトを選択',
      'env.edit': '編集',
      'env.editTitle': '環境を編集',
      'env.createTitle': 'ローカル環境を作成',
      'env.cancel': 'キャンセル',
      'env.saveChanges': '変更を保存',
      'env.saving': '保存中…',
      'env.saved': '保存しました',
      'env.name': '名前',
      'env.setupTitle': 'セットアップスクリプト',
      'env.setupDesc': 'ワークツリー作成時に実行されます',
      'env.cleanupTitle': 'クリーンアップスクリプト',
      'env.cleanupDesc': 'ワークツリー削除前にプロジェクトルートで実行されます',
      'env.actionsTitle': 'アクション',
      'env.actionsDesc': '任意のコマンドを実行でき、トップバーに表示されます',
      'env.varsBtn': '変数',
      'env.vars.source': '元リポジトリのルートパス',
      'env.vars.worktree': '現在のワークツリーディレクトリパス',
      'env.vars.branch': '現在のワークツリーブランチ名',
      'env.platform.top': 'デフォルト',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'プラットフォーム上書きなし。デフォルトスクリプトを使用します',
      'env.noScript': 'スクリプト未設定',
      'env.noPlatformScript': 'このプラットフォーム用のスクリプトは未設定です',
      'env.noActions': 'アクション未設定',
      'env.copy': 'コピー',
      'env.copied': 'コピーしました',
      'env.actionNameLabel': '名前',
      'env.actionName': '名前（例: dev）',
      'env.actionScriptLabel': 'アクションスクリプト',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'プラットフォーム',
      'env.actionPlatformAll': 'すべてのプラットフォーム',
      'env.actionIconLabel': 'アクションアイコンを選択',
      'env.icon.tool': 'ツール',
      'env.icon.run': '実行',
      'env.icon.debug': 'デバッグ',
      'env.icon.test': 'テスト',
      'env.addAction': 'アクションを追加',
      'env.removeAction': 'アクションを削除',
      'env.parseError': '設定ファイルの解析に失敗しました',
      'header.actions.run': '{name} を実行',
      'header.actions.menu': 'クイックアクション',
      'header.actions.viewLogs': '実行ログを表示',
      'header.actions.running': '実行中',
      'header.actions.focusTerminal': '{name} のターミナルを表示',
      'header.actions.runNewTerminal': '新しいターミナルで実行',
      'header.restore.label': 'ワークツリーを復元',
      'header.restore.restoring': '復元中…',
      'header.restore.tipSnapshot': 'ワークツリー「{branch}」は復元スナップショット付きでアーカイブされています。クリックしてディレクトリと未コミットの変更を復元します。',
      'header.restore.tipPlain': 'ワークツリー「{branch}」はアーカイブされています。クリックしてディレクトリを再チェックアウトします。',
      'menu.handoff': '変更を引き継いで Worktree へ移動',
      'menu.apply': '変更を元ディレクトリに適用',
      'menu.restore': 'ワークツリーを復元',
      'menu.sending': '/worktree コマンドを送信しました',
      'menu.sendFailed': 'コマンドの送信に失敗しました',
      'logs.title': '実行ログ',
      'logs.copy': 'コピー',
      'logs.copied': 'コピーしました',
      'logs.close': '閉じる',
      'logs.cancel': '停止',
      'logs.minimize': '折りたたむ',
      'logs.expand': '展開',
      'logs.rerun': '再実行',
      'logs.empty': '出力を待機中…',
      'logs.status.running': '実行中',
      'logs.status.succeeded': '成功',
      'logs.status.failed': '失敗',
      'logs.status.cancelled': 'キャンセル済み',
    }

    const es = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Administra el directorio de worktrees, la limpieza automática, los worktrees activos y los scripts de entorno local',
      'panel.tab.settings': 'Configuración',
      'panel.tab.environments': 'Entornos',
      'settings.group': 'Creación y limpieza',
      'settings.worktreeDir.label': 'Directorio de worktrees (relativo al proyecto)',
      'settings.worktreeDir.desc': 'Déjalo vacío para usar .agents/worktrees; se sincroniza con la creación integrada de DSH',
      'settings.worktreeDir.invalid': 'El directorio debe ser una ruta relativa al proyecto sin "/", ".", "..", "\\" ni ":" al inicio (p. ej., .agents/worktrees)',
      'settings.fetch.label': 'Obtener cambios remotos antes de crear worktrees',
      'settings.fetch.desc': 'Comprueba si hay commits nuevos en el remoto antes de crear un worktree',
      'settings.autoCleanup.label': 'Eliminar automáticamente worktrees antiguos',
      'settings.autoCleanup.desc': 'Guarda primero una instantánea de recuperación',
      'settings.autoCleanup.info': 'Antes de limpiar o eliminar un worktree, los cambios sin confirmar se guardan en .git/refs/dsh-worktree-env/snapshots/ y pueden restaurarse con un clic al reabrir el chat.',
      'settings.keepCount.label': 'Worktrees a conservar',
      'settings.keepCount.desc': 'Los worktrees más antiguos se limpian automáticamente. Los fijados o con chats activos se conservan.',
      'settings.keepCount.increase': 'Aumentar worktrees a conservar',
      'settings.keepCount.decrease': 'Reducir worktrees a conservar',
      'settings.confirmDelete.label': 'Preguntar antes de eliminar worktrees',
      'settings.confirmDelete.desc': 'Se aplica a los worktrees que elimines manualmente',
      'settings.saved': 'Configuración guardada',
      'settings.managed.title': 'Worktrees administrados',
      'settings.managed.refresh': 'Actualizar worktrees',
      'settings.managed.count': '{count} worktree(s)',
      'settings.managed.empty': 'No hay worktrees administrados',
      'settings.managed.newChat': 'Nuevo chat en este worktree',
      'settings.managed.delete': 'Eliminar worktree',
      'settings.managed.deleteTitle': 'Eliminar worktree',
      'settings.managed.deleteDesc': 'Elimina el directorio local de "{branch}". Los cambios sin confirmar se guardan primero en una instantánea.',
      'settings.managed.deleteSubmit': 'Eliminar',
      'settings.archived.title': 'Worktrees archivados',
      'settings.archived.snapshot': 'Instantánea',
      'settings.archived.restore': 'Restaurar worktree',
      'settings.archived.purge': 'Eliminar permanentemente',
      'settings.archived.purgeTitle': 'Eliminar registro archivado',
      'settings.archived.purgeDesc': 'Elimina permanentemente el registro archivado y la instantánea de recuperación de "{branch}". No se puede deshacer.',
      'error.sessionUnavailable': 'Servicio de sesiones no disponible',
      'panel.refresh': 'Actualizar',
      'panel.setup.none': 'Setup pendiente',
      'panel.setup.running': 'Ejecutando setup',
      'panel.setup.succeeded': 'Setup listo',
      'panel.setup.failed': 'Setup fallido',
      'panel.setup.not-configured': 'Sin entorno',
      'panel.act.setup': 'Ejecutar setup',
      'panel.act.apply': 'Aplicar al origen',
      'panel.act.archive': 'Archivar',
      'panel.act.busy': 'Procesando…',
      'panel.act.error': 'Error',
      'modal.cancel': 'Cancelar',
      'modal.confirm': 'Confirmar',
      'modal.done': 'Listo',
      'modal.apply.title': 'Aplicar cambios al directorio de origen',
      'modal.apply.desc': 'Fusiona los cambios de "{branch}" en el directorio origen con git apply --3way. Si hay conflictos, se cancela sin sobrescribir.',
      'modal.apply.branchLabel': 'Rama de destino',
      'modal.apply.branchCurrent': '{branch} (actual)',
      'modal.apply.branchNewOption': '+ Crear nueva rama…',
      'modal.apply.branchNewPlaceholder': 'Introduce el nombre de la nueva rama (p. ej., feat/login)',
      'modal.apply.switchNote': 'El directorio origen cambiará de "{from}" a "{to}" antes de aplicar los cambios (sin confirmar automáticamente).',
      'modal.apply.dirtyBlocked': 'El directorio origen está en "{branch}" con {count} cambio(s) sin confirmar y no puede cambiar de rama. Confírmalos/guárdalos o aplica en la rama actual.',
      'modal.apply.invalidBranch': 'Nombre de rama no válido. Introduce un nombre de rama de Git válido.',
      'modal.apply.branchExists': 'La rama "{branch}" ya existe. Selecciónala de la lista o elige otro nombre.',
      'modal.apply.modeLabel': 'Alcance',
      'modal.apply.modeBranch': 'Todos los cambios de la rama (confirmados + sin confirmar)',
      'modal.apply.modeUncommitted': 'Solo cambios sin confirmar (vs HEAD)',
      'modal.apply.checking': 'Comprobando conflictos del parche…',
      'modal.apply.noChanges': 'No hay cambios para aplicar en este alcance.',
      'modal.apply.ready': 'Comprobación superada: se aplicarán {count} archivo(s) sin conflictos.',
      'modal.apply.readyBranch': 'Comprobación superada: {count} archivo(s) se aplicarán sin conflictos en "{branch}".',
      'modal.apply.conflict': 'Los conflictos impiden aplicar los cambios:',
      'modal.apply.submit': 'Aplicar cambios',
      'modal.apply.submitTo': 'Aplicar a {branch}',
      'modal.apply.done': 'Se aplicaron {count} archivo(s) en "{branch}" del directorio origen.',
      'modal.archive.title': 'Archivar worktree',
      'modal.archive.desc': 'Archivar "{branch}" ejecuta el script de limpieza y elimina el directorio. Los cambios sin confirmar se guardan en una instantánea oculta de Git.',
      'modal.archive.submit': 'Archivar worktree',
      'env.selectProject': 'Seleccionar un proyecto',
      'env.addProject': 'Añadir proyecto',
      'env.addProjectTitle': 'Añadir carpeta de proyecto',
      'env.addProjectDesc': 'Introduce la ruta local del proyecto para gestionar sus archivos environment.toml.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Añadir',
      'env.addEnvTo': 'Añadir entorno a {name}',
      'env.noProjects': 'Aún no hay proyectos. Haz clic en "Añadir proyecto" o abre un espacio de trabajo.',
      'env.back': 'Atrás',
      'env.backToProjects': 'Seleccionar un proyecto',
      'env.edit': 'Editar',
      'env.editTitle': 'Editar entorno',
      'env.createTitle': 'Crear entorno local',
      'env.cancel': 'Cancelar',
      'env.saveChanges': 'Guardar cambios',
      'env.saving': 'Guardando…',
      'env.saved': 'Guardado',
      'env.name': 'Nombre',
      'env.setupTitle': 'Script de configuración',
      'env.setupDesc': 'Este script se ejecuta al crear el worktree',
      'env.cleanupTitle': 'Script de limpieza',
      'env.cleanupDesc': 'Se ejecuta en la raíz del proyecto antes de limpiar un worktree',
      'env.actionsTitle': 'Acciones',
      'env.actionsDesc': 'Las acciones ejecutan comandos personalizados y aparecen en la barra superior',
      'env.varsBtn': 'Variables',
      'env.vars.source': 'Ruta raíz del repositorio origen',
      'env.vars.worktree': 'Ruta del directorio del worktree actual',
      'env.vars.branch': 'Nombre de la rama del worktree actual',
      'env.platform.top': 'Predeterminado',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'Sin configuración específica; usando el script predeterminado',
      'env.noScript': 'Sin script configurado',
      'env.noPlatformScript': 'Sin script configurado para esta plataforma',
      'env.noActions': 'Sin acciones configuradas',
      'env.copy': 'Copiar',
      'env.copied': 'Copiado',
      'env.actionNameLabel': 'Nombre',
      'env.actionName': 'Nombre (p. ej., dev)',
      'env.actionScriptLabel': 'Script de acción',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Plataforma',
      'env.actionPlatformAll': 'Todas las plataformas',
      'env.actionIconLabel': 'Elegir icono de acción',
      'env.icon.tool': 'Herramienta',
      'env.icon.run': 'Ejecutar',
      'env.icon.debug': 'Depurar',
      'env.icon.test': 'Probar',
      'env.addAction': 'Añadir acción',
      'env.removeAction': 'Eliminar acción',
      'env.parseError': 'Error al analizar el archivo de configuración',
      'header.actions.run': 'Ejecutar {name}',
      'header.actions.menu': 'Acciones rápidas',
      'header.actions.viewLogs': 'Ver registros de operación',
      'header.actions.running': 'En ejecución',
      'header.actions.focusTerminal': 'Ir al terminal de {name}',
      'header.actions.runNewTerminal': 'Ejecutar en un nuevo terminal',
      'header.restore.label': 'Restaurar worktree',
      'header.restore.restoring': 'Restaurando…',
      'header.restore.tipSnapshot': 'El worktree "{branch}" se archivó con una instantánea de recuperación. Haz clic para restaurar el directorio y los cambios sin confirmar.',
      'header.restore.tipPlain': 'El worktree "{branch}" está archivado. Haz clic para volver a extraer el directorio.',
      'menu.handoff': 'Mover a worktree con cambios',
      'menu.apply': 'Aplicar cambios al origen',
      'menu.restore': 'Restaurar worktree',
      'menu.sending': 'Comando /worktree enviado',
      'menu.sendFailed': 'No se pudo enviar el comando',
      'logs.title': 'Registros de operación',
      'logs.copy': 'Copiar',
      'logs.copied': 'Copiado',
      'logs.close': 'Cerrar',
      'logs.cancel': 'Detener',
      'logs.minimize': 'Minimizar',
      'logs.expand': 'Expandir',
      'logs.rerun': 'Volver a ejecutar',
      'logs.empty': 'Esperando salida…',
      'logs.status.running': 'En ejecución',
      'logs.status.succeeded': 'Completado',
      'logs.status.failed': 'Fallido',
      'logs.status.cancelled': 'Cancelado',
    }

    const fr = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Gérer le dossier des worktrees, le nettoyage automatique, les worktrees actifs et les scripts d’environnement local',
      'panel.tab.settings': 'Paramètres',
      'panel.tab.environments': 'Environnements',
      'settings.group': 'Création et nettoyage',
      'settings.worktreeDir.label': 'Dossier des worktrees (relatif au projet)',
      'settings.worktreeDir.desc': 'Laissez vide pour .agents/worktrees ; synchronisé avec la création intégrée de DSH',
      'settings.worktreeDir.invalid': 'Le dossier doit être un chemin relatif au projet sans "/", ".", "..", "\\" ni ":" (ex. .agents/worktrees)',
      'settings.fetch.label': 'Récupérer le dépôt distant avant de créer un worktree',
      'settings.fetch.desc': 'Vérifier les nouveaux commits distants avant la création d’un worktree',
      'settings.autoCleanup.label': 'Supprimer automatiquement les anciens worktrees',
      'settings.autoCleanup.desc': 'Enregistre d’abord un instantané de récupération',
      'settings.autoCleanup.info': 'Avant de nettoyer ou supprimer un worktree, les modifications non validées sont enregistrées dans .git/refs/dsh-worktree-env/snapshots/ et restaurables en un clic en rouvrant la discussion.',
      'settings.keepCount.label': 'Worktrees à conserver',
      'settings.keepCount.desc': 'Les anciens worktrees sont nettoyés automatiquement. Ceux des discussions épinglées ou actives sont conservés.',
      'settings.keepCount.increase': 'Augmenter le nombre à conserver',
      'settings.keepCount.decrease': 'Diminuer le nombre à conserver',
      'settings.confirmDelete.label': 'Demander avant de supprimer un worktree',
      'settings.confirmDelete.desc': 'S’applique aux worktrees que vous supprimez manuellement',
      'settings.saved': 'Paramètres enregistrés',
      'settings.managed.title': 'Worktrees gérés',
      'settings.managed.refresh': 'Actualiser les worktrees',
      'settings.managed.count': '{count} worktree(s)',
      'settings.managed.empty': 'Aucun worktree géré',
      'settings.managed.newChat': 'Nouvelle discussion dans ce worktree',
      'settings.managed.delete': 'Supprimer le worktree',
      'settings.managed.deleteTitle': 'Supprimer le worktree',
      'settings.managed.deleteDesc': 'Supprime le dossier local de « {branch} ». Les modifications non validées sont d’abord enregistrées dans un instantané.',
      'settings.managed.deleteSubmit': 'Supprimer',
      'settings.archived.title': 'Worktrees archivés',
      'settings.archived.snapshot': 'Instantané',
      'settings.archived.restore': 'Restaurer le worktree',
      'settings.archived.purge': 'Supprimer définitivement',
      'settings.archived.purgeTitle': 'Supprimer l’archive',
      'settings.archived.purgeDesc': 'Supprime définitivement l’archive et l’instantané de récupération de « {branch} ». Cette action est irréversible.',
      'error.sessionUnavailable': 'Service de session indisponible',
      'panel.refresh': 'Actualiser',
      'panel.setup.none': 'Setup en attente',
      'panel.setup.running': 'Setup en cours',
      'panel.setup.succeeded': 'Setup prêt',
      'panel.setup.failed': 'Échec du setup',
      'panel.setup.not-configured': 'Aucun environnement',
      'panel.act.setup': 'Exécuter setup',
      'panel.act.apply': 'Appliquer à la source',
      'panel.act.archive': 'Archiver',
      'panel.act.busy': 'En cours…',
      'panel.act.error': 'Échec',
      'modal.cancel': 'Annuler',
      'modal.confirm': 'Confirmer',
      'modal.done': 'Terminé',
      'modal.apply.title': 'Appliquer les modifications à la source',
      'modal.apply.desc': 'Fusionne les modifications de « {branch} » vers le répertoire source avec git apply --3way. Les conflits annulent proprement l’opération.',
      'modal.apply.branchLabel': 'Branche cible',
      'modal.apply.branchCurrent': '{branch} (actuelle)',
      'modal.apply.branchNewOption': '+ Créer une nouvelle branche…',
      'modal.apply.branchNewPlaceholder': 'Nom de la nouvelle branche (ex. feat/login)',
      'modal.apply.switchNote': 'Le répertoire source passera de « {from} » à « {to} » avant d’appliquer les modifications (sans commit automatique).',
      'modal.apply.dirtyBlocked': 'Le répertoire source est sur « {branch} » avec {count} modification(s) non validée(s) et ne peut pas changer de branche. Validez/remisez-les ou appliquez sur la branche actuelle.',
      'modal.apply.invalidBranch': 'Nom de branche invalide. Saisissez un nom de branche Git valide.',
      'modal.apply.branchExists': 'La branche « {branch} » existe déjà. Sélectionnez-la dans la liste ou choisissez un autre nom.',
      'modal.apply.modeLabel': 'Portée',
      'modal.apply.modeBranch': 'Toutes les modifications de la branche (validées + non validées)',
      'modal.apply.modeUncommitted': 'Modifications non validées uniquement (vs HEAD)',
      'modal.apply.checking': 'Vérification des conflits du patch…',
      'modal.apply.noChanges': 'Aucune modification à appliquer dans cette portée.',
      'modal.apply.ready': 'Vérification réussie : {count} fichier(s) seront appliqués sans conflit.',
      'modal.apply.readyBranch': 'Vérification réussie : {count} fichier(s) seront appliqués sans conflit sur « {branch} ».',
      'modal.apply.conflict': 'Des conflits empêchent l’application :',
      'modal.apply.submit': 'Appliquer les modifications',
      'modal.apply.submitTo': 'Appliquer sur {branch}',
      'modal.apply.done': '{count} fichier(s) appliqué(s) sur « {branch} » dans le répertoire source.',
      'modal.archive.title': 'Archiver le worktree',
      'modal.archive.desc': 'L’archivage de « {branch} » exécute le script de nettoyage et supprime le répertoire. Les modifications non validées sont conservées dans un instantané Git masqué.',
      'modal.archive.submit': 'Archiver le worktree',
      'env.selectProject': 'Sélectionner un projet',
      'env.addProject': 'Ajouter un projet',
      'env.addProjectTitle': 'Ajouter un dossier de projet',
      'env.addProjectDesc': 'Saisissez le chemin d’un dossier local pour gérer ses fichiers environment.toml.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Ajouter',
      'env.addEnvTo': 'Ajouter un environnement à {name}',
      'env.noProjects': 'Aucun projet. Cliquez sur « Ajouter un projet » ou ouvrez un espace de travail.',
      'env.back': 'Retour',
      'env.backToProjects': 'Sélectionner un projet',
      'env.edit': 'Modifier',
      'env.editTitle': 'Modifier l’environnement',
      'env.createTitle': 'Créer un environnement local',
      'env.cancel': 'Annuler',
      'env.saveChanges': 'Enregistrer',
      'env.saving': 'Enregistrement…',
      'env.saved': 'Enregistré',
      'env.name': 'Nom',
      'env.setupTitle': 'Script d’initialisation',
      'env.setupDesc': 'Exécuté lors de la création d’un worktree',
      'env.cleanupTitle': 'Script de nettoyage',
      'env.cleanupDesc': 'Exécuté à la racine du projet avant la suppression d’un worktree',
      'env.actionsTitle': 'Actions',
      'env.actionsDesc': 'Les actions exécutent des commandes personnalisées et apparaissent dans la barre supérieure',
      'env.varsBtn': 'Variables',
      'env.vars.source': 'Chemin racine du dépôt source',
      'env.vars.worktree': 'Chemin du worktree courant',
      'env.vars.branch': 'Nom de la branche du worktree courant',
      'env.platform.top': 'Par défaut',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'Aucune surcharge de plateforme ; script par défaut utilisé',
      'env.noScript': 'Aucun script configuré',
      'env.noPlatformScript': 'Aucun script configuré pour cette plateforme',
      'env.noActions': 'Aucune action configurée',
      'env.copy': 'Copier',
      'env.copied': 'Copié',
      'env.actionNameLabel': 'Nom',
      'env.actionName': 'Nom (ex. dev)',
      'env.actionScriptLabel': 'Script d’action',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Plateforme',
      'env.actionPlatformAll': 'Toutes les plateformes',
      'env.actionIconLabel': 'Choisir l’icône de l’action',
      'env.icon.tool': 'Outil',
      'env.icon.run': 'Exécuter',
      'env.icon.debug': 'Déboguer',
      'env.icon.test': 'Tester',
      'env.addAction': 'Ajouter une action',
      'env.removeAction': 'Supprimer l’action',
      'env.parseError': 'Échec de l’analyse du fichier de configuration',
      'header.actions.run': 'Exécuter {name}',
      'header.actions.menu': 'Actions rapides',
      'header.actions.viewLogs': 'Voir les journaux',
      'header.actions.running': 'En cours',
      'header.actions.focusTerminal': 'Afficher le terminal {name}',
      'header.actions.runNewTerminal': 'Exécuter dans un nouveau terminal',
      'header.restore.label': 'Restaurer le worktree',
      'header.restore.restoring': 'Restauration…',
      'header.restore.tipSnapshot': 'Le worktree « {branch} » a été archivé avec un instantané. Cliquez pour restaurer le dossier et les modifications non validées.',
      'header.restore.tipPlain': 'Le worktree « {branch} » est archivé. Cliquez pour recréer le dossier.',
      'menu.handoff': 'Basculer dans un worktree avec les modifications',
      'menu.apply': 'Appliquer les modifications à la source',
      'menu.restore': 'Restaurer le worktree',
      'menu.sending': 'Commande /worktree envoyée',
      'menu.sendFailed': 'Échec de l’envoi de la commande',
      'logs.title': 'Journaux d’opération',
      'logs.copy': 'Copier',
      'logs.copied': 'Copié',
      'logs.close': 'Fermer',
      'logs.cancel': 'Arrêter',
      'logs.minimize': 'Réduire',
      'logs.expand': 'Développer',
      'logs.rerun': 'Relancer',
      'logs.empty': 'En attente de sortie…',
      'logs.status.running': 'En cours',
      'logs.status.succeeded': 'Réussi',
      'logs.status.failed': 'Échoué',
      'logs.status.cancelled': 'Annulé',
    }

    const de = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Worktree-Verzeichnis, automatische Bereinigung, verwaltete Worktrees und lokale Umgebungsskripte verwalten',
      'panel.tab.settings': 'Einstellungen',
      'panel.tab.environments': 'Umgebungen',
      'settings.group': 'Erstellung & Bereinigung',
      'settings.worktreeDir.label': 'Worktree-Verzeichnis (relativ zum Projekt)',
      'settings.worktreeDir.desc': 'Leer lassen für .agents/worktrees; wird direkt mit der integrierten DSH-Worktree-Erstellung synchronisiert',
      'settings.worktreeDir.invalid': 'Das Verzeichnis muss ein projektrelativer Pfad ohne führendes "/", ".", "..", "\\" oder ":" sein (z. B. .agents/worktrees)',
      'settings.fetch.label': 'Vor dem Erstellen von Worktrees abrufen (git fetch)',
      'settings.fetch.desc': 'Vor dem Erstellen eines Worktrees prüfen, ob neuere Commits im Remote vorhanden sind',
      'settings.autoCleanup.label': 'Alte Worktrees automatisch löschen',
      'settings.autoCleanup.desc': 'Speichert zuerst einen Wiederherstellungs-Snapshot',
      'settings.autoCleanup.info': 'Vor dem Bereinigen oder Löschen eines Worktrees werden nicht committete Änderungen unter .git/refs/dsh-worktree-env/snapshots/ gespeichert und lassen sich beim erneuten Öffnen des Chats mit einem Klick wiederherstellen.',
      'settings.keepCount.label': 'Zu behaltende Worktrees',
      'settings.keepCount.desc': 'Ältere Worktrees werden automatisch bereinigt. Worktrees angepinnter oder aktiver Chats bleiben erhalten.',
      'settings.keepCount.increase': 'Anzahl erhöhen',
      'settings.keepCount.decrease': 'Anzahl verringern',
      'settings.confirmDelete.label': 'Vor dem Löschen von Worktrees nachfragen',
      'settings.confirmDelete.desc': 'Gilt für Worktrees, die Sie selbst löschen',
      'settings.saved': 'Einstellungen gespeichert',
      'settings.managed.title': 'Verwaltete Worktrees',
      'settings.managed.refresh': 'Worktrees aktualisieren',
      'settings.managed.count': '{count} Worktree(s)',
      'settings.managed.empty': 'Keine verwalteten Worktrees',
      'settings.managed.newChat': 'Neuer Chat in diesem Worktree',
      'settings.managed.delete': 'Worktree löschen',
      'settings.managed.deleteTitle': 'Worktree löschen',
      'settings.managed.deleteDesc': 'Entfernt das lokale Worktree-Verzeichnis für „{branch}“. Nicht committete Änderungen werden zuerst als Snapshot gesichert.',
      'settings.managed.deleteSubmit': 'Löschen',
      'settings.archived.title': 'Archivierte Worktrees',
      'settings.archived.snapshot': 'Snapshot',
      'settings.archived.restore': 'Worktree wiederherstellen',
      'settings.archived.purge': 'Endgültig löschen',
      'settings.archived.purgeTitle': 'Archivierten Eintrag löschen',
      'settings.archived.purgeDesc': 'Entfernt den archivierten Eintrag und den Wiederherstellungs-Snapshot für „{branch}“ endgültig. Dies kann nicht rückgängig gemacht werden.',
      'error.sessionUnavailable': 'Sitzungsdienst nicht verfügbar',
      'panel.refresh': 'Aktualisieren',
      'panel.setup.none': 'Setup ausstehend',
      'panel.setup.running': 'Setup läuft',
      'panel.setup.succeeded': 'Setup bereit',
      'panel.setup.failed': 'Setup fehlgeschlagen',
      'panel.setup.not-configured': 'Keine Umgebung',
      'panel.act.setup': 'Setup ausführen',
      'panel.act.apply': 'Auf Quelle anwenden',
      'panel.act.archive': 'Archivieren',
      'panel.act.busy': 'Wird verarbeitet…',
      'panel.act.error': 'Fehlgeschlagen',
      'modal.cancel': 'Abbrechen',
      'modal.confirm': 'Bestätigen',
      'modal.done': 'Fertig',
      'modal.apply.title': 'Änderungen auf Quellverzeichnis anwenden',
      'modal.apply.desc': 'Überträgt Änderungen aus „{branch}“ per git apply --3way in das Quellverzeichnis. Bei Konflikten wird sauber abgebrochen.',
      'modal.apply.branchLabel': 'Ziel-Branch',
      'modal.apply.branchCurrent': '{branch} (aktuell)',
      'modal.apply.branchNewOption': '+ Neuen Branch erstellen…',
      'modal.apply.branchNewPlaceholder': 'Neuen Branch-Namen eingeben (z. B. feat/login)',
      'modal.apply.switchNote': 'Das Quellverzeichnis wechselt vor dem Anwenden von „{from}“ zu „{to}“ (kein automatischer Commit).',
      'modal.apply.dirtyBlocked': 'Das Quellverzeichnis befindet sich auf „{branch}“ mit {count} nicht committeten Änderung(en) und kann den Branch nicht wechseln. Erst committen/stashen oder auf den aktuellen Branch anwenden.',
      'modal.apply.invalidBranch': 'Ungültiger Branch-Name. Bitte geben Sie einen gültigen Git-Branch-Namen ein.',
      'modal.apply.branchExists': 'Branch „{branch}“ existiert bereits. Wählen Sie ihn aus der Liste oder verwenden Sie einen anderen Namen.',
      'modal.apply.modeLabel': 'Umfang',
      'modal.apply.modeBranch': 'Gesamter Branch-Diff (committet + nicht committet)',
      'modal.apply.modeUncommitted': 'Nur nicht committete Änderungen (vs. HEAD)',
      'modal.apply.checking': 'Patch-Konflikte werden geprüft…',
      'modal.apply.noChanges': 'Keine Änderungen in diesem Umfang vorhanden.',
      'modal.apply.ready': 'Vorprüfung bestanden: {count} Datei(en) lassen sich konfliktfrei anwenden.',
      'modal.apply.readyBranch': 'Vorprüfung bestanden: {count} Datei(en) lassen sich konfliktfrei auf „{branch}“ anwenden.',
      'modal.apply.conflict': 'Konflikte verhindern das automatische Anwenden:',
      'modal.apply.submit': 'Änderungen anwenden',
      'modal.apply.submitTo': 'Auf {branch} anwenden',
      'modal.apply.done': '{count} Datei(en) auf „{branch}“ im Quellverzeichnis angewendet.',
      'modal.archive.title': 'Worktree archivieren',
      'modal.archive.desc': 'Beim Archivieren von „{branch}“ wird das Cleanup-Skript ausgeführt und das Verzeichnis entfernt. Nicht committete Änderungen werden als versteckter Git-Snapshot gesichert.',
      'modal.archive.submit': 'Worktree archivieren',
      'env.selectProject': 'Projekt auswählen',
      'env.addProject': 'Projekt hinzufügen',
      'env.addProjectTitle': 'Projektordner hinzufügen',
      'env.addProjectDesc': 'Geben Sie einen lokalen Projektpfad ein, um dessen environment.toml-Dateien zu verwalten.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Hinzufügen',
      'env.addEnvTo': 'Umgebung zu {name} hinzufügen',
      'env.noProjects': 'Noch keine Projekte. Klicken Sie auf „Projekt hinzufügen“ oder öffnen Sie einen Arbeitsbereich.',
      'env.back': 'Zurück',
      'env.backToProjects': 'Projekt auswählen',
      'env.edit': 'Bearbeiten',
      'env.editTitle': 'Umgebung bearbeiten',
      'env.createTitle': 'Lokale Umgebung erstellen',
      'env.cancel': 'Abbrechen',
      'env.saveChanges': 'Änderungen speichern',
      'env.saving': 'Wird gespeichert…',
      'env.saved': 'Gespeichert',
      'env.name': 'Name',
      'env.setupTitle': 'Setup-Skript',
      'env.setupDesc': 'Dieses Skript wird beim Erstellen eines Worktrees ausgeführt',
      'env.cleanupTitle': 'Cleanup-Skript',
      'env.cleanupDesc': 'Wird vor dem Bereinigen eines Worktrees im Projektstamm ausgeführt',
      'env.actionsTitle': 'Aktionen',
      'env.actionsDesc': 'Aktionen führen benutzerdefinierte Befehle aus und erscheinen in der oberen Leiste',
      'env.varsBtn': 'Variablen',
      'env.vars.source': 'Stammpfad des Quell-Repositorys',
      'env.vars.worktree': 'Pfad des aktuellen Worktree-Verzeichnisses',
      'env.vars.branch': 'Branch-Name des aktuellen Worktrees',
      'env.platform.top': 'Standard',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'Keine Plattform-Überschreibung; Standard-Skript wird verwendet',
      'env.noScript': 'Kein Skript konfiguriert',
      'env.noPlatformScript': 'Kein Skript für diese Plattform konfiguriert',
      'env.noActions': 'Keine Aktionen konfiguriert',
      'env.copy': 'Kopieren',
      'env.copied': 'Kopiert',
      'env.actionNameLabel': 'Name',
      'env.actionName': 'Name (z. B. dev)',
      'env.actionScriptLabel': 'Aktionsskript',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Plattform',
      'env.actionPlatformAll': 'Alle Plattformen',
      'env.actionIconLabel': 'Aktionssymbol wählen',
      'env.icon.tool': 'Werkzeug',
      'env.icon.run': 'Ausführen',
      'env.icon.debug': 'Debuggen',
      'env.icon.test': 'Testen',
      'env.addAction': 'Aktion hinzufügen',
      'env.removeAction': 'Aktion löschen',
      'env.parseError': 'Konfigurationsdatei konnte nicht geparst werden',
      'header.actions.run': '{name} ausführen',
      'header.actions.menu': 'Schnellaktionen',
      'header.actions.viewLogs': 'Ausführungsprotokolle anzeigen',
      'header.actions.running': 'Läuft',
      'header.actions.focusTerminal': 'Zum Terminal „{name}“ wechseln',
      'header.actions.runNewTerminal': 'In neuem Terminal ausführen',
      'header.restore.label': 'Worktree wiederherstellen',
      'header.restore.restoring': 'Wird wiederhergestellt…',
      'header.restore.tipSnapshot': 'Worktree „{branch}“ wurde mit einem Wiederherstellungs-Snapshot archiviert. Klicken, um Verzeichnis und uncommittete Änderungen wiederherzustellen.',
      'header.restore.tipPlain': 'Worktree „{branch}“ wurde archiviert. Klicken, um das Verzeichnis erneut auszuchecken.',
      'menu.handoff': 'Mit Änderungen in Worktree wechseln',
      'menu.apply': 'Änderungen auf Quelle anwenden',
      'menu.restore': 'Worktree wiederherstellen',
      'menu.sending': 'Befehl /worktree gesendet',
      'menu.sendFailed': 'Befehl konnte nicht gesendet werden',
      'logs.title': 'Ausführungsprotokolle',
      'logs.copy': 'Kopieren',
      'logs.copied': 'Kopiert',
      'logs.close': 'Schließen',
      'logs.cancel': 'Stoppen',
      'logs.minimize': 'Minimieren',
      'logs.expand': 'Erweitern',
      'logs.rerun': 'Erneut ausführen',
      'logs.empty': 'Warte auf Ausgabe…',
      'logs.status.running': 'Läuft',
      'logs.status.succeeded': 'Erfolgreich',
      'logs.status.failed': 'Fehlgeschlagen',
      'logs.status.cancelled': 'Abgebrochen',
    }

    const ru = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Управление каталогом worktree, автоочисткой, активными worktree и скриптами локального окружения',
      'panel.tab.settings': 'Настройки',
      'panel.tab.environments': 'Окружения',
      'settings.group': 'Создание и очистка',
      'settings.worktreeDir.label': 'Каталог worktree (относительно проекта)',
      'settings.worktreeDir.desc': 'Оставьте пустым для .agents/worktrees; синхронизируется со встроенным созданием worktree в DSH',
      'settings.worktreeDir.invalid': 'Каталог должен быть относительным путём внутри проекта без начального "/", ".", "..", "\\" и ":" (напр. .agents/worktrees)',
      'settings.fetch.label': 'Выполнять git fetch перед созданием worktree',
      'settings.fetch.desc': 'Проверять наличие новых коммитов в удалённом репозитории перед созданием worktree',
      'settings.autoCleanup.label': 'Автоматически удалять старые worktree',
      'settings.autoCleanup.desc': 'Сначала сохраняет снимок для восстановления',
      'settings.autoCleanup.info': 'Перед очисткой или удалением worktree незакоммиченные изменения сохраняются в .git/refs/dsh-worktree-env/snapshots/ и восстанавливаются в один клик при повторном открытии чата.',
      'settings.keepCount.label': 'Количество сохраняемых worktree',
      'settings.keepCount.desc': 'Более старые worktree очищаются автоматически. Worktree закреплённых и активных чатов сохраняются.',
      'settings.keepCount.increase': 'Увеличить количество',
      'settings.keepCount.decrease': 'Уменьшить количество',
      'settings.confirmDelete.label': 'Спрашивать перед удалением worktree',
      'settings.confirmDelete.desc': 'Применяется к worktree, которые вы удаляете вручную',
      'settings.saved': 'Настройки сохранены',
      'settings.managed.title': 'Управляемые worktree',
      'settings.managed.refresh': 'Обновить список worktree',
      'settings.managed.count': 'Worktree: {count}',
      'settings.managed.empty': 'Нет управляемых worktree',
      'settings.managed.newChat': 'Новый чат в этом worktree',
      'settings.managed.delete': 'Удалить worktree',
      'settings.managed.deleteTitle': 'Удалить worktree',
      'settings.managed.deleteDesc': 'Удалит локальный каталог worktree «{branch}». Незакоммиченные изменения сначала сохраняются в снимок.',
      'settings.managed.deleteSubmit': 'Удалить',
      'settings.archived.title': 'Архивированные worktree',
      'settings.archived.snapshot': 'Снимок',
      'settings.archived.restore': 'Восстановить worktree',
      'settings.archived.purge': 'Удалить навсегда',
      'settings.archived.purgeTitle': 'Удалить архивную запись',
      'settings.archived.purgeDesc': 'Навсегда удалит архивную запись и снимок восстановления для «{branch}». Действие необратимо.',
      'error.sessionUnavailable': 'Сервис сеансов недоступен',
      'panel.refresh': 'Обновить',
      'panel.setup.none': 'Ожидает setup',
      'panel.setup.running': 'Выполняется setup',
      'panel.setup.succeeded': 'Setup готов',
      'panel.setup.failed': 'Ошибка setup',
      'panel.setup.not-configured': 'Нет окружения',
      'panel.act.setup': 'Запустить setup',
      'panel.act.apply': 'Применить в источник',
      'panel.act.archive': 'Архивировать',
      'panel.act.busy': 'Выполняется…',
      'panel.act.error': 'Ошибка',
      'modal.cancel': 'Отмена',
      'modal.confirm': 'Подтвердить',
      'modal.done': 'Готово',
      'modal.apply.title': 'Применить изменения в исходный каталог',
      'modal.apply.desc': 'Переносит изменения из «{branch}» в исходный каталог через git apply --3way. При конфликтах операция отменяется без перезаписи.',
      'modal.apply.branchLabel': 'Целевая ветка',
      'modal.apply.branchCurrent': '{branch} (текущая)',
      'modal.apply.branchNewOption': '+ Создать новую ветку…',
      'modal.apply.branchNewPlaceholder': 'Введите имя новой ветки (напр. feat/login)',
      'modal.apply.switchNote': 'Исходный каталог переключится с «{from}» на «{to}» перед применением изменений (без автокоммита).',
      'modal.apply.dirtyBlocked': 'Исходный каталог на ветке «{branch}» содержит незакоммиченные изменения ({count}), поэтому переключение невозможно. Закоммитьте/спрячьте их или примените в текущую ветку.',
      'modal.apply.invalidBranch': 'Недопустимое имя ветки. Введите корректное имя ветки Git.',
      'modal.apply.branchExists': 'Ветка «{branch}» уже существует. Выберите её из списка или укажите другое имя.',
      'modal.apply.modeLabel': 'Область',
      'modal.apply.modeBranch': 'Все изменения ветки (коммиты + незакоммиченные)',
      'modal.apply.modeUncommitted': 'Только незакоммиченные изменения (относительно HEAD)',
      'modal.apply.checking': 'Проверка конфликтов патча…',
      'modal.apply.noChanges': 'В выбранной области нет изменений для применения.',
      'modal.apply.ready': 'Проверка пройдена: будет применено файлов: {count}, без конфликтов.',
      'modal.apply.readyBranch': 'Проверка пройдена: файлов для применения в «{branch}» без конфликтов: {count}.',
      'modal.apply.conflict': 'Конфликты не позволяют применить изменения:',
      'modal.apply.submit': 'Применить изменения',
      'modal.apply.submitTo': 'Применить в {branch}',
      'modal.apply.done': 'Применено файлов: {count} в ветку «{branch}» исходного каталога.',
      'modal.archive.title': 'Архивировать worktree',
      'modal.archive.desc': 'Архивация «{branch}» выполнит скрипт cleanup и удалит каталог. Незакоммиченные изменения сохраняются в скрытый Git-снимок для восстановления.',
      'modal.archive.submit': 'Архивировать',
      'env.selectProject': 'Выберите проект',
      'env.addProject': 'Добавить проект',
      'env.addProjectTitle': 'Добавить папку проекта',
      'env.addProjectDesc': 'Введите путь к локальной папке проекта для управления файлами environment.toml.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Добавить',
      'env.addEnvTo': 'Добавить окружение для {name}',
      'env.noProjects': 'Проектов пока нет. Нажмите «Добавить проект» или откройте рабочую область.',
      'env.back': 'Назад',
      'env.backToProjects': 'Выберите проект',
      'env.edit': 'Редактировать',
      'env.editTitle': 'Редактировать окружение',
      'env.createTitle': 'Создать локальное окружение',
      'env.cancel': 'Отмена',
      'env.saveChanges': 'Сохранить изменения',
      'env.saving': 'Сохранение…',
      'env.saved': 'Сохранено',
      'env.name': 'Название',
      'env.setupTitle': 'Скрипт настройки',
      'env.setupDesc': 'Запускается при создании worktree',
      'env.cleanupTitle': 'Скрипт очистки',
      'env.cleanupDesc': 'Запускается в корне проекта перед очисткой worktree',
      'env.actionsTitle': 'Действия',
      'env.actionsDesc': 'Действия запускают произвольные команды и отображаются на верхней панели',
      'env.varsBtn': 'Переменные',
      'env.vars.source': 'Корневой путь исходного репозитория',
      'env.vars.worktree': 'Путь текущего каталога worktree',
      'env.vars.branch': 'Имя ветки текущего worktree',
      'env.platform.top': 'По умолчанию',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'Переопределение для платформы не задано; используется скрипт по умолчанию',
      'env.noScript': 'Скрипт не настроен',
      'env.noPlatformScript': 'Для этой платформы скрипт не настроен',
      'env.noActions': 'Действия не настроены',
      'env.copy': 'Копировать',
      'env.copied': 'Скопировано',
      'env.actionNameLabel': 'Название',
      'env.actionName': 'Название (напр. dev)',
      'env.actionScriptLabel': 'Скрипт действия',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Платформа',
      'env.actionPlatformAll': 'Все платформы',
      'env.actionIconLabel': 'Выбрать значок действия',
      'env.icon.tool': 'Инструмент',
      'env.icon.run': 'Запуск',
      'env.icon.debug': 'Отладка',
      'env.icon.test': 'Тест',
      'env.addAction': 'Добавить действие',
      'env.removeAction': 'Удалить действие',
      'env.parseError': 'Не удалось разобрать файл конфигурации',
      'header.actions.run': 'Запустить {name}',
      'header.actions.menu': 'Быстрые действия',
      'header.actions.viewLogs': 'Показать журнал операций',
      'header.actions.running': 'Выполняется',
      'header.actions.focusTerminal': 'Перейти в терминал {name}',
      'header.actions.runNewTerminal': 'Запустить в новом терминале',
      'header.restore.label': 'Восстановить worktree',
      'header.restore.restoring': 'Восстановление…',
      'header.restore.tipSnapshot': 'Worktree «{branch}» был архивирован со снимком восстановления. Нажмите, чтобы восстановить каталог и незакоммиченные изменения.',
      'header.restore.tipPlain': 'Worktree «{branch}» архивирован. Нажмите, чтобы снова развернуть каталог.',
      'menu.handoff': 'Перенести с изменениями в Worktree',
      'menu.apply': 'Применить изменения в источник',
      'menu.restore': 'Восстановить worktree',
      'menu.sending': 'Команда /worktree отправлена',
      'menu.sendFailed': 'Не удалось отправить команду',
      'logs.title': 'Журнал операций',
      'logs.copy': 'Копировать',
      'logs.copied': 'Скопировано',
      'logs.close': 'Закрыть',
      'logs.cancel': 'Остановить',
      'logs.minimize': 'Свернуть',
      'logs.expand': 'Развернуть',
      'logs.rerun': 'Перезапустить',
      'logs.empty': 'Ожидание вывода…',
      'logs.status.running': 'Выполняется',
      'logs.status.succeeded': 'Успешно',
      'logs.status.failed': 'Ошибка',
      'logs.status.cancelled': 'Отменено',
    }

    const pt = {
      'panel.title': 'Worktrees',
      'panel.subtitle': 'Gerencie o diretório de worktrees, limpeza automática, worktrees ativos e scripts de ambiente local',
      'panel.tab.settings': 'Configurações',
      'panel.tab.environments': 'Ambientes',
      'settings.group': 'Criação e limpeza',
      'settings.worktreeDir.label': 'Diretório de worktrees (relativo ao projeto)',
      'settings.worktreeDir.desc': 'Deixe vazio para .agents/worktrees; sincronizado com a criação integrada do DSH',
      'settings.worktreeDir.invalid': 'O diretório deve ser um caminho relativo ao projeto sem "/", ".", "..", "\\" ou ":" (ex.: .agents/worktrees)',
      'settings.fetch.label': 'Buscar atualizações remotas antes de criar worktrees',
      'settings.fetch.desc': 'Verifica novos commits no repositório remoto antes de criar um worktree',
      'settings.autoCleanup.label': 'Excluir automaticamente worktrees antigos',
      'settings.autoCleanup.desc': 'Salva primeiro um snapshot de recuperação',
      'settings.autoCleanup.info': 'Antes de limpar ou excluir um worktree, as alterações não confirmadas são salvas em .git/refs/dsh-worktree-env/snapshots/ e podem ser restauradas com um clique ao reabrir o chat.',
      'settings.keepCount.label': 'Worktrees a manter',
      'settings.keepCount.desc': 'Worktrees mais antigos são limpos automaticamente. Worktrees de chats fixados ou ativos são mantidos.',
      'settings.keepCount.increase': 'Aumentar quantidade mantida',
      'settings.keepCount.decrease': 'Diminuir quantidade mantida',
      'settings.confirmDelete.label': 'Perguntar antes de excluir worktrees',
      'settings.confirmDelete.desc': 'Aplica-se a worktrees que você excluir manualmente',
      'settings.saved': 'Configurações salvas',
      'settings.managed.title': 'Worktrees gerenciados',
      'settings.managed.refresh': 'Atualizar worktrees',
      'settings.managed.count': '{count} worktree(s)',
      'settings.managed.empty': 'Nenhum worktree gerenciado',
      'settings.managed.newChat': 'Novo chat neste worktree',
      'settings.managed.delete': 'Excluir worktree',
      'settings.managed.deleteTitle': 'Excluir worktree',
      'settings.managed.deleteDesc': 'Remove o diretório local de "{branch}". Alterações não confirmadas são salvas antes em um snapshot.',
      'settings.managed.deleteSubmit': 'Excluir',
      'settings.archived.title': 'Worktrees arquivados',
      'settings.archived.snapshot': 'Snapshot',
      'settings.archived.restore': 'Restaurar worktree',
      'settings.archived.purge': 'Excluir permanentemente',
      'settings.archived.purgeTitle': 'Excluir registro arquivado',
      'settings.archived.purgeDesc': 'Remove permanentemente o registro arquivado e o snapshot de recuperação de "{branch}". Esta ação não pode ser desfeita.',
      'error.sessionUnavailable': 'Serviço de sessão indisponível',
      'panel.refresh': 'Atualizar',
      'panel.setup.none': 'Setup pendente',
      'panel.setup.running': 'Setup em execução',
      'panel.setup.succeeded': 'Setup pronto',
      'panel.setup.failed': 'Falha no setup',
      'panel.setup.not-configured': 'Sem ambiente',
      'panel.act.setup': 'Executar setup',
      'panel.act.apply': 'Aplicar na origem',
      'panel.act.archive': 'Arquivar',
      'panel.act.busy': 'Processando…',
      'panel.act.error': 'Falha',
      'modal.cancel': 'Cancelar',
      'modal.confirm': 'Confirmar',
      'modal.done': 'Concluído',
      'modal.apply.title': 'Aplicar alterações ao diretório de origem',
      'modal.apply.desc': 'Mescla as alterações de "{branch}" de volta ao diretório de origem via git apply --3way. Conflitos abortam sem sobrescrever.',
      'modal.apply.branchLabel': 'Branch de destino',
      'modal.apply.branchCurrent': '{branch} (atual)',
      'modal.apply.branchNewOption': '+ Criar nova branch…',
      'modal.apply.branchNewPlaceholder': 'Digite o nome da nova branch (ex.: feat/login)',
      'modal.apply.switchNote': 'O diretório de origem trocará de "{from}" para "{to}" antes de aplicar as alterações (sem commit automático).',
      'modal.apply.dirtyBlocked': 'O diretório de origem está em "{branch}" com {count} alteração(ões) não confirmada(s) e não pode trocar de branch. Faça commit/stash ou aplique na branch atual.',
      'modal.apply.invalidBranch': 'Nome de branch inválido. Informe um nome de branch Git válido.',
      'modal.apply.branchExists': 'A branch "{branch}" já existe. Selecione-a na lista ou escolha outro nome.',
      'modal.apply.modeLabel': 'Escopo',
      'modal.apply.modeBranch': 'Todas as alterações da branch (confirmadas + não confirmadas)',
      'modal.apply.modeUncommitted': 'Somente alterações não confirmadas (vs HEAD)',
      'modal.apply.checking': 'Verificando conflitos de patch…',
      'modal.apply.noChanges': 'Nenhuma alteração para aplicar neste escopo.',
      'modal.apply.ready': 'Pré-verificação aprovada: {count} arquivo(s) serão aplicados sem conflitos.',
      'modal.apply.readyBranch': 'Pré-verificação aprovada: {count} arquivo(s) serão aplicados sem conflitos em "{branch}".',
      'modal.apply.conflict': 'Conflitos impedem a aplicação limpa:',
      'modal.apply.submit': 'Aplicar alterações',
      'modal.apply.submitTo': 'Aplicar em {branch}',
      'modal.apply.done': '{count} arquivo(s) aplicado(s) em "{branch}" no diretório de origem.',
      'modal.archive.title': 'Arquivar worktree',
      'modal.archive.desc': 'Arquivar "{branch}" executa o script de limpeza e remove o diretório. Alterações não confirmadas são salvas em um snapshot oculto do Git.',
      'modal.archive.submit': 'Arquivar worktree',
      'env.selectProject': 'Selecionar um projeto',
      'env.addProject': 'Adicionar projeto',
      'env.addProjectTitle': 'Adicionar pasta do projeto',
      'env.addProjectDesc': 'Informe o caminho de uma pasta local para gerenciar seus arquivos environment.toml.',
      'env.addProjectPlaceholder': '/path/to/project',
      'env.addProjectSubmit': 'Adicionar',
      'env.addEnvTo': 'Adicionar ambiente a {name}',
      'env.noProjects': 'Nenhum projeto ainda. Clique em "Adicionar projeto" ou abra um espaço de trabalho.',
      'env.back': 'Voltar',
      'env.backToProjects': 'Selecionar um projeto',
      'env.edit': 'Editar',
      'env.editTitle': 'Editar ambiente',
      'env.createTitle': 'Criar ambiente local',
      'env.cancel': 'Cancelar',
      'env.saveChanges': 'Salvar alterações',
      'env.saving': 'Salvando…',
      'env.saved': 'Salvo',
      'env.name': 'Nome',
      'env.setupTitle': 'Script de setup',
      'env.setupDesc': 'Este script é executado ao criar um worktree',
      'env.cleanupTitle': 'Script de limpeza',
      'env.cleanupDesc': 'Executado na raiz do projeto antes de limpar um worktree',
      'env.actionsTitle': 'Ações',
      'env.actionsDesc': 'As ações executam comandos personalizados e aparecem na barra superior',
      'env.varsBtn': 'Variáveis',
      'env.vars.source': 'Caminho raiz do repositório de origem',
      'env.vars.worktree': 'Caminho do diretório do worktree atual',
      'env.vars.branch': 'Nome da branch do worktree atual',
      'env.platform.top': 'Padrão',
      'env.platform.darwin': 'macOS',
      'env.platform.linux': 'Linux',
      'env.platform.win32': 'Windows',
      'env.platformUsesDefault': 'Sem substituição de plataforma; usando o script padrão',
      'env.noScript': 'Nenhum script configurado',
      'env.noPlatformScript': 'Nenhum script configurado para esta plataforma',
      'env.noActions': 'Nenhuma ação configurada',
      'env.copy': 'Copiar',
      'env.copied': 'Copiado',
      'env.actionNameLabel': 'Nome',
      'env.actionName': 'Nome (ex.: dev)',
      'env.actionScriptLabel': 'Script da ação',
      'env.actionCommand': 'npm run dev',
      'env.actionPlatformLabel': 'Plataforma',
      'env.actionPlatformAll': 'Todas as plataformas',
      'env.actionIconLabel': 'Escolher ícone da ação',
      'env.icon.tool': 'Ferramenta',
      'env.icon.run': 'Executar',
      'env.icon.debug': 'Depurar',
      'env.icon.test': 'Testar',
      'env.addAction': 'Adicionar ação',
      'env.removeAction': 'Excluir ação',
      'env.parseError': 'Falha ao analisar o arquivo de configuração',
      'header.actions.run': 'Executar {name}',
      'header.actions.menu': 'Ações rápidas',
      'header.actions.viewLogs': 'Ver logs de operação',
      'header.actions.running': 'Em execução',
      'header.actions.focusTerminal': 'Ir para o terminal de {name}',
      'header.actions.runNewTerminal': 'Executar em um novo terminal',
      'header.restore.label': 'Restaurar worktree',
      'header.restore.restoring': 'Restaurando…',
      'header.restore.tipSnapshot': 'O worktree "{branch}" foi arquivado com um snapshot de recuperação. Clique para restaurar o diretório e as alterações não confirmadas.',
      'header.restore.tipPlain': 'O worktree "{branch}" foi arquivado. Clique para recriar o diretório.',
      'menu.handoff': 'Mover para worktree com alterações',
      'menu.apply': 'Aplicar alterações na origem',
      'menu.restore': 'Restaurar worktree',
      'menu.sending': 'Comando /worktree enviado',
      'menu.sendFailed': 'Falha ao enviar o comando',
      'logs.title': 'Logs de operação',
      'logs.copy': 'Copiar',
      'logs.copied': 'Copiado',
      'logs.close': 'Fechar',
      'logs.cancel': 'Parar',
      'logs.minimize': 'Minimizar',
      'logs.expand': 'Expandir',
      'logs.rerun': 'Executar novamente',
      'logs.empty': 'Aguardando saída…',
      'logs.status.running': 'Em execução',
      'logs.status.succeeded': 'Concluído',
      'logs.status.failed': 'Falhou',
      'logs.status.cancelled': 'Cancelado',
    }

    const DICTS = { zh, en, ja, es, fr, de, ru, pt }

    /** ---- tiny API layer ---- */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let value = null
      try { value = text.length > 0 ? JSON.parse(text) : null } catch { value = { error: text } }
      if (!response.ok) {
        const err = new Error(value?.error ?? `${response.status} ${response.statusText}`)
        if (typeof value?.code === 'string') err.code = value.code
        throw err
      }
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

/* Native Modal (matches DSH Modal primitive: --dsw-alias-bg-mask-1 + --dsw-mask-blur + --dsw-radius-panel) */
@keyframes dshwt-modal-in { from { opacity: 0; } to { opacity: 1; } }
.dshwt-backdrop { pointer-events: auto; position: fixed; inset: var(--dsh-frame-chrome-top, 0px) 0 0; z-index: 1000; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .24)); backdrop-filter: var(--dsw-mask-blur, blur(4px)); display: flex; align-items: center; justify-content: center; padding: 20px; animation: dshwt-modal-in var(--ds-transition-duration, 150ms) var(--ds-ease-in-out, ease); }
.dshwt-modal { box-sizing: border-box; width: min(460px, 100%); max-height: 85vh; overflow: auto; border-radius: var(--dsw-radius-panel, 20px); border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.22)); padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); font-family: var(--dsw-font-family, inherit); }
.dshwt-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.dshwt-modal-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #57606a); }
.dshwt-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.dshwt-radio-card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.22)); cursor: pointer; font-size: 13px; }
.dshwt-radio-card[data-selected="true"] { border-color: var(--dsw-alias-border-selected, var(--dsw-alias-border-l4)); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); }

/* Operation Log Drawer (DSH native floating surface & code-block tokens, anchored top-right below header so it never blocks the composer) */
.dshwt-drawer { pointer-events: auto; position: fixed; top: calc(var(--dsh-frame-top-clearance, 0px) + 84px); right: 20px; z-index: 950; width: min(560px, calc(100vw - 40px)); height: min(360px, calc(100vh - 220px)); display: flex; flex-direction: column; border-radius: var(--dsw-radius-xl, 18px); border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff))); backdrop-filter: var(--dsw-menu-backdrop-filter, none); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent, 0 12px 36px rgba(0,0,0,.16)); color: var(--dsw-alias-label-primary, inherit); font-family: var(--dsw-font-family, inherit); overflow: hidden; }
.dshwt-drawer-min { width: auto; min-width: 220px; max-width: min(360px, calc(100vw - 40px)); height: auto; }
.dshwt-drawer-head { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 8px 0 14px; flex: none; }
.dshwt-drawer-main { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
.dshwt-drawer-min .dshwt-drawer-main { cursor: pointer; }
.dshwt-drawer-main:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; border-radius: var(--dsw-radius-sm, 8px); }
.dshwt-drawer-title { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-drawer-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #656d76); white-space: nowrap; flex: none; }
.dshwt-drawer-status[data-status="failed"] { color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-drawer-sep { width: 2px; height: 2px; border-radius: 50%; background: var(--dsw-alias-label-caption, #8a8f98); flex: none; }
.dshwt-drawer-acts { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.dshwt-log-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-caption, #8a8f98); }
.dshwt-log-dot[data-status="running"] { background: var(--dsw-alias-state-success-primary, #1a7f37); animation: dshwt-pulse 1.2s ease-in-out infinite; }
.dshwt-log-dot[data-status="succeeded"] { background: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshwt-log-dot[data-status="failed"] { background: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-drawer-body-wrap { flex: 1; min-height: 0; padding: 0 10px 10px; display: flex; }
.dshwt-drawer-body { --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); border: 0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-module-platform, rgba(128,128,128,.05))); color: var(--dsw-alias-label-primary, inherit); font: var(--dsw-font-markdown-code-block-small, 12px/19px var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)); white-space: pre-wrap; overflow-wrap: anywhere; }
.dshwt-drawer-body span[data-stream="stderr"] { color: var(--dsw-alias-state-error-primary, #cf222e); }
.dshwt-drawer-body span[data-stream="meta"] { color: var(--dsw-alias-label-tertiary, #656d76); }

/* Right-sidebar Action Log tab (full-height native DSH pane) */
.dshwt-rlog { box-sizing: border-box; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, inherit); font-family: var(--dsw-font-family, inherit); font-size: var(--dsh-content-font-size-secondary, 13px); }
.dshwt-rlog-head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 8px 14px; flex: none; }
.dshwt-rlog-runs { display: flex; align-items: center; gap: 4px; padding: 0 12px 8px; overflow-x: auto; flex: none; }
.dshwt-rlog-run { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-tertiary, #656d76); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-rlog-run:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-rlog-run[aria-selected="true"] { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dshwt-rlog-run:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-rlog-body-wrap { flex: 1; min-height: 0; padding: 0 12px 12px; display: flex; }
.dshwt-rlog-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary, #656d76); font-size: 13px; }
.dshwt-rtab-title { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dshwt-rtab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Session top-bar quick actions (native DSH header utility style) */
.dshwt-hdr-wrap { position: relative; display: inline-flex; align-items: center; flex: none; }
.dshwt-hdr-split { display: inline-flex; align-items: center; height: 28px; border-radius: var(--dsw-radius-sm, 8px); overflow: hidden; transition: background 120ms ease; }
@media (hover: hover) { .dshwt-hdr-split:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); } }
.dshwt-hdr-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary, #57606a); font: inherit; font-size: 12.5px; line-height: 18px; font-weight: 450; cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-hdr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-hdr-split .dshwt-hdr-btn { border-radius: 0; padding: 0 7px 0 8px; }
.dshwt-hdr-btn:disabled, .dshwt-hdr-caret:disabled { opacity: 0.45; cursor: default; }
.dshwt-hdr-btn:focus-visible, .dshwt-hdr-caret:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: 2px; }
.dshwt-hdr-restore { background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08)); color: var(--dsw-alias-label-primary, inherit); padding: 0 9px; }
@media (hover: hover) { .dshwt-hdr-restore:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); } }
.dshwt-hdr-label { max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-hdr-caret { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 22px; height: 28px; padding: 0 5px; border: 0; border-left: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16)); background: transparent; color: var(--dsw-alias-label-tertiary, #656d76); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-hdr-caret:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-hdr-caret[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, inherit); }
.dshwt-hdr-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #1a7f37); flex: none; animation: dshwt-pulse 1.2s ease-in-out infinite; }
.dshwt-hdr-menu { position: fixed; z-index: 1050; min-width: 210px; max-width: 300px; padding: 6px; border-radius: var(--dsw-radius-lg, 16px); border: 0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.2)); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff)); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.16)); color: var(--dsw-alias-label-primary, inherit); display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.dshwt-hdr-menu-row { display: flex; align-items: center; gap: 2px; width: 100%; }
.dshwt-hdr-menu-row .dshwt-hdr-menu-item { flex: 1; min-width: 0; width: auto; }
.dshwt-hdr-menu-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 10px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; text-align: left; cursor: pointer; transition: background 120ms ease; }
@media (hover: hover) { .dshwt-hdr-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); } }
.dshwt-hdr-menu-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: -2px; }
.dshwt-hdr-menu-new { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-tertiary, #656d76); cursor: pointer; flex: none; transition: background 120ms ease, color 120ms ease; }
@media (hover: hover) { .dshwt-hdr-menu-new:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-hdr-menu-new:disabled { opacity: 0.4; cursor: default; }
.dshwt-hdr-menu-new:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, transparent); outline-offset: -2px; }
.dshwt-hdr-menu-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.dshwt-hdr-menu-name { font-size: 13px; line-height: 18px; font-weight: 450; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-hdr-menu-cmd { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #656d76); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwt-hdr-menu-sep { height: 0.5px; margin: 4px 6px; background: var(--dsw-alias-border-l2, rgba(128,128,128,.16)); }
.dshwt-hdr-menu-err { padding: 6px 10px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-state-error-primary, #cf222e); overflow-wrap: anywhere; }
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
.dshwt-setting-desc-row { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dshwt-info-badge { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary, #656d76); cursor: help; flex: none; transition: color 120ms ease; }
@media (hover: hover) { .dshwt-info-badge:hover { color: var(--dsw-alias-label-primary, inherit); } }
.dshwt-managed-name-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dshwt-snap-pill { display: inline-flex; align-items: center; padding: 0 6px; height: 18px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.1)); color: var(--dsw-alias-label-secondary, #57606a); font-size: 11px; line-height: 16px; font-weight: 450; flex: none; }
.dshwt-archived-block { margin-top: 16px; }
.dshwt-setting-row-dim { opacity: 0.55; }
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
    function BranchIcon({ size = 16 }) {
      if (typeof NativePrimitives?.IconBranchOutlineRegular === 'function') {
        return h(NativePrimitives.IconBranchOutlineRegular, { size })
      }
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flexShrink: 0 },
      },
      h('circle', { cx: 7, cy: 6, r: 2.25 }),
      h('circle', { cx: 7, cy: 18, r: 2.25 }),
      h('circle', { cx: 17, cy: 7, r: 2.25 }),
      h('path', { d: 'M7 8.25v7.5M17 9.25V10c0 2.75-2.25 4.75-5 4.75H7' }))
    }
    function RefreshIcon({ size = 14 }) {
      return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
          h('polyline', { points: '21 3 21 9 15 9' })))
    }
    function RestoreIcon({ size = 15 }) {
      return h('span', { className: 'dshwt-icon', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }),
          h('polyline', { points: '3 3 3 8 8 8' })))
    }
    function InfoIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 9.5 }),
      h('line', { x1: 12, y1: 11, x2: 12, y2: 16 }),
      h('circle', { cx: 12, cy: 7.75, r: 0.75, fill: 'currentColor', stroke: 'none' }))
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
    function StopIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('rect', { x: 4.5, y: 4.5, width: 15, height: 15, rx: 3 }))
    }
    function CloseIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.85, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('line', { x1: 5.5, y1: 5.5, x2: 18.5, y2: 18.5 }),
      h('line', { x1: 18.5, y1: 5.5, x2: 5.5, y2: 18.5 }))
    }
    function CollapseIcon({ dir = 'down', size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.85, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('polyline', { points: dir === 'up' ? '6 15 12 9 18 15' : '6 9 12 15 18 9' }))
    }

    function stripAnsi(text) {
      if (typeof text !== 'string') return ''
      return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g, '')
    }

    function repoName(root) {
      if (typeof root !== 'string') return ''
      const parts = root.split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] ?? root
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
        autoCleanupEnabled: true,
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

    /** ---- Shared SSE operation stream hook ---- */
    function useOperationStream(operationId, label, onSettled) {
      const [lines, setLines] = useState([])
      const [status, setStatus] = useState('running')
      const [opLabel, setOpLabel] = useState(label ?? '')
      const settledRef = useRef(onSettled)
      settledRef.current = onSettled

      useEffect(() => {
        if (!operationId) {
          setLines([])
          setStatus('succeeded')
          setOpLabel(label ?? '')
          return
        }
        setLines([])
        setStatus('running')
        setOpLabel(label ?? '')
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

      return { lines, status, opLabel }
    }

    function useAutoScrollLog(operationId, lines, active = true) {
      const [copied, setCopied] = useState(false)
      const boxRef = useRef(null)
      const stickRef = useRef(true)

      useEffect(() => { stickRef.current = true }, [operationId])
      useEffect(() => {
        if (!active || !stickRef.current) return
        const el = boxRef.current
        if (el) el.scrollTo({ top: el.scrollHeight })
      }, [lines, active])

      const onScroll = () => {
        const el = boxRef.current
        if (!el) return
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }

      const copyAll = () => {
        copyText(lines.map(l => stripAnsi(l.text)).join(''))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }

      return { copied, boxRef, onScroll, copyAll }
    }

    function renderLogOutput(lines, boxRef, onScroll, t) {
      return h('div', { className: 'dshwt-drawer-body', ref: boxRef, onScroll },
        lines.length === 0
          ? h('span', { 'data-stream': 'meta' }, t('logs.empty'))
          : lines.map((entry, idx) => h('span', { key: idx, 'data-stream': entry.stream }, stripAnsi(entry.text))))
    }

    /** ---- Live SSE operation log drawer (fallback overlay when right sidebar is absent) ---- */
    function LogDrawer({ operationId, label, icon, minimized = false, onToggleMinimize, onClose, onSettled, t }) {
      const { lines, status, opLabel } = useOperationStream(operationId, label, onSettled)
      const { copied, boxRef, onScroll, copyAll } = useAutoScrollLog(operationId, lines, !minimized)
      const statusText = t(`logs.status.${status}`) || status

      return h('div', {
        className: minimized ? 'dshwt-drawer dshwt-drawer-min' : 'dshwt-drawer',
        role: 'region',
        'aria-label': opLabel || t('logs.title'),
      },
      h('div', { className: 'dshwt-drawer-head' },
        h('button', {
          type: 'button',
          className: 'dshwt-drawer-main',
          title: minimized ? t('logs.expand') : (opLabel || t('logs.title')),
          onClick: () => { if (minimized && onToggleMinimize) onToggleMinimize() },
        },
        h('span', { className: 'dshwt-log-dot', 'data-status': status, 'aria-hidden': true }),
        icon ? h('span', { style: { color: 'var(--dsw-alias-label-secondary, #57606a)', display: 'inline-flex', flex: 'none' } },
          h(ActionIcon, { kind: icon, size: 15, outline: true })) : null,
        h('span', { className: 'dshwt-drawer-title' }, opLabel || t('logs.title')),
        h('span', { className: 'dshwt-drawer-sep', 'aria-hidden': true }),
        h('span', { className: 'dshwt-drawer-status', 'data-status': status }, statusText)),
        h('div', { className: 'dshwt-drawer-acts' },
          status === 'running'
            ? h(Hint, { label: t('logs.cancel'), side: 'bottom' },
              h('button', {
                type: 'button',
                className: 'dshwt-icon-btn dshwt-icon-btn-danger',
                title: hasNativeTooltip ? undefined : t('logs.cancel'),
                'aria-label': t('logs.cancel'),
                onClick: () => void api(`/operations/${enc(operationId)}/cancel`, { method: 'POST' }),
              }, h(StopIcon, { size: 15 })))
            : null,
          !minimized
            ? h(Hint, { label: copied ? t('logs.copied') : t('logs.copy'), side: 'bottom' },
              h('button', {
                type: 'button',
                className: 'dshwt-icon-btn',
                title: hasNativeTooltip ? undefined : (copied ? t('logs.copied') : t('logs.copy')),
                'aria-label': copied ? t('logs.copied') : t('logs.copy'),
                onClick: copyAll,
              }, copied ? h(CheckIcon, { size: 15 }) : h(CopyIcon, { size: 15 })))
            : null,
          onToggleMinimize
            ? h(Hint, { label: minimized ? t('logs.expand') : t('logs.minimize'), side: 'bottom' },
              h('button', {
                type: 'button',
                className: 'dshwt-icon-btn',
                title: hasNativeTooltip ? undefined : (minimized ? t('logs.expand') : t('logs.minimize')),
                'aria-label': minimized ? t('logs.expand') : t('logs.minimize'),
                'aria-expanded': !minimized,
                onClick: onToggleMinimize,
              }, h(CollapseIcon, { dir: minimized ? 'down' : 'up', size: 16 })))
            : null,
          h(Hint, { label: t('logs.close'), side: 'bottom' },
            h('button', {
              type: 'button',
              className: 'dshwt-icon-btn',
              title: hasNativeTooltip ? undefined : t('logs.close'),
              'aria-label': t('logs.close'),
              onClick: onClose,
            }, h(CloseIcon, { size: 15 }))))),
      !minimized
        ? h('div', { className: 'dshwt-drawer-body-wrap' }, renderLogOutput(lines, boxRef, onScroll, t))
        : null)
    }

    function ApplyBackflowModal({ target, onClose, t }) {
      const [meta, setMeta] = useState(null)
      const [loadingMeta, setLoadingMeta] = useState(true)
      const [metaError, setMetaError] = useState(null)
      const [mode, setMode] = useState('branch')
      const [branchChoice, setBranchChoice] = useState('')
      const [newBranchName, setNewBranchName] = useState('')
      const [checking, setChecking] = useState(false)
      const [precheck, setPrecheck] = useState(null)
      const [precheckError, setPrecheckError] = useState(null)
      const [submitting, setSubmitting] = useState(false)
      const [submitError, setSubmitError] = useState(null)
      const [appliedResult, setAppliedResult] = useState(null)

      useEffect(() => {
        let cancelled = false
        setLoadingMeta(true)
        setMetaError(null)
        setAppliedResult(null)
        setSubmitError(null)
        void api(`/worktrees/${enc(target.id)}/backflow-info`).then(
          (value) => {
            if (cancelled) return
            setMeta(value)
            const initial = value?.currentBranch ?? value?.branches?.[0] ?? NEW_BRANCH_SENTINEL
            setBranchChoice(initial)
            setNewBranchName('')
            setLoadingMeta(false)
          },
          (err) => {
            if (cancelled) return
            setMetaError(err.message)
            setLoadingMeta(false)
          },
        )
        return () => { cancelled = true }
      }, [target.id])

      const isCreating = branchChoice === NEW_BRANCH_SENTINEL
      const effectiveBranch = isCreating ? newBranchName.trim() : (branchChoice || meta?.currentBranch || '')
      const willSwitch = meta !== null && (isCreating || (effectiveBranch.length > 0 && effectiveBranch !== meta.currentBranch))

      useEffect(() => {
        if (meta === null || appliedResult !== null) return
        if (isCreating && effectiveBranch.length === 0) {
          setPrecheck(null)
          setPrecheckError(null)
          setChecking(false)
          return
        }
        let cancelled = false
        setChecking(true)
        setPrecheckError(null)
        const timer = setTimeout(() => {
          void api(`/worktrees/${enc(target.id)}/apply-patch`, {
            method: 'POST',
            body: JSON.stringify({
              mode,
              dryRun: true,
              targetBranch: effectiveBranch || undefined,
              createBranch: isCreating,
            }),
          }).then(
            (res) => {
              if (cancelled) return
              setPrecheck(res)
              setChecking(false)
            },
            (err) => {
              if (cancelled) return
              setPrecheck(null)
              setPrecheckError(err.message)
              setChecking(false)
            },
          )
        }, isCreating ? 220 : 0)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [meta, target.id, mode, branchChoice, newBranchName, isCreating, effectiveBranch, appliedResult])

      const submit = async () => {
        if (submitting || meta === null) return
        setSubmitting(true)
        setSubmitError(null)
        try {
          const res = await api(`/worktrees/${enc(target.id)}/apply-patch`, {
            method: 'POST',
            body: JSON.stringify({
              mode,
              dryRun: false,
              targetBranch: effectiveBranch || undefined,
              createBranch: isCreating,
            }),
          })
          if (res?.applied) {
            setAppliedResult(res)
            notifyEnvChanged()
          } else {
            setPrecheck(res)
            if (res?.message) setSubmitError(res.message)
          }
        } catch (err) {
          setSubmitError(err.message)
        } finally {
          setSubmitting(false)
        }
      }

      const worktreeBranch = meta?.worktreeBranch || target.branch || ''
      const canSubmit = !loadingMeta
        && !checking
        && !submitting
        && meta !== null
        && appliedResult === null
        && (!isCreating || effectiveBranch.length > 0)
        && precheck !== null
        && !precheck.blockedReason
        && precheck.fileCount > 0
        && (precheck.conflicts?.length ?? 0) === 0

      let statusBanner = null
      if (appliedResult !== null) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'ok', role: 'status' },
          t('modal.apply.done', { count: appliedResult.fileCount, branch: appliedResult.targetBranch || meta?.currentBranch || 'HEAD' }))
      } else if (metaError !== null) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, metaError)
      } else if (submitError !== null) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, submitError)
      } else if (precheckError !== null) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, precheckError)
      } else if (loadingMeta || checking) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'info' }, t('modal.apply.checking'))
      } else if (precheck?.blockedReason === 'SOURCE_DIRTY_CANNOT_SWITCH') {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'warn', role: 'alert' },
          t('modal.apply.dirtyBlocked', { branch: precheck.currentBranch || meta?.currentBranch || 'HEAD', count: precheck.sourceDirtyCount ?? meta?.sourceDirtyCount ?? 1 }))
      } else if (precheck?.blockedReason === 'INVALID_BRANCH_NAME') {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, t('modal.apply.invalidBranch'))
      } else if (precheck?.blockedReason === 'BRANCH_ALREADY_EXISTS') {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, t('modal.apply.branchExists', { branch: effectiveBranch }))
      } else if (precheck?.blockedReason) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert' }, precheck.message || precheck.blockedReason)
      } else if (precheck !== null && precheck.fileCount === 0) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'info' }, t('modal.apply.noChanges'))
      } else if (precheck !== null && (precheck.conflicts?.length ?? 0) > 0) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'err', role: 'alert', style: { flexDirection: 'column', gap: 4 } },
          h('div', null, t('modal.apply.conflict')),
          h('div', { style: { fontFamily: 'var(--ds-font-family-code, Menlo, monospace)', fontSize: 11.5 } }, precheck.conflicts.join('\n')))
      } else if (precheck !== null && precheck.fileCount > 0) {
        statusBanner = h('div', { className: 'dshwt-banner', 'data-tone': 'ok' },
          effectiveBranch.length > 0
            ? t('modal.apply.readyBranch', { count: precheck.fileCount, branch: effectiveBranch })
            : t('modal.apply.ready', { count: precheck.fileCount }))
      }

      const submitLabel = effectiveBranch.length > 0
        ? t('modal.apply.submitTo', { branch: effectiveBranch })
        : t('modal.apply.submit')

      return h(ModalShell, { title: t('modal.apply.title'), onClose },
        h('p', { className: 'dshwt-modal-desc' }, t('modal.apply.desc', { branch: worktreeBranch })),
        meta !== null && appliedResult === null
          ? h(React.Fragment, null,
            h('div', { className: 'dshwt-field' },
              h('label', { className: 'dshwt-label' }, t('modal.apply.branchLabel')),
              h('select', {
                className: 'dshwt-select',
                value: branchChoice,
                disabled: submitting,
                'aria-label': t('modal.apply.branchLabel'),
                onChange: e => { setBranchChoice(e.target.value); setSubmitError(null) },
              },
              (meta.branches ?? []).map(branch => h('option', { key: branch, value: branch },
                branch === meta.currentBranch ? t('modal.apply.branchCurrent', { branch }) : branch)),
              h('option', { value: NEW_BRANCH_SENTINEL }, t('modal.apply.branchNewOption'))),
              isCreating
                ? h('input', {
                  className: 'dshwt-input',
                  placeholder: t('modal.apply.branchNewPlaceholder'),
                  value: newBranchName,
                  disabled: submitting,
                  spellCheck: false,
                  autoComplete: 'off',
                  autoFocus: true,
                  onChange: e => { setNewBranchName(e.target.value); setSubmitError(null) },
                })
                : null,
              willSwitch && !meta.sourceDirty && effectiveBranch.length > 0 && !precheck?.blockedReason
                ? h('p', { className: 'dshwt-hint' }, t('modal.apply.switchNote', { from: meta.currentBranch || 'HEAD', to: effectiveBranch }))
                : null),
            h('div', { className: 'dshwt-field' },
              h('span', { className: 'dshwt-label' }, t('modal.apply.modeLabel')),
              h('label', { className: 'dshwt-radio-card', 'data-selected': mode === 'branch' },
                h('input', { type: 'radio', name: 'dshwt-apply-mode', checked: mode === 'branch', disabled: submitting, onChange: () => setMode('branch') }),
                h('span', null, t('modal.apply.modeBranch'))),
              h('label', { className: 'dshwt-radio-card', 'data-selected': mode === 'uncommitted' },
                h('input', { type: 'radio', name: 'dshwt-apply-mode', checked: mode === 'uncommitted', disabled: submitting, onChange: () => setMode('uncommitted') }),
                h('span', null, t('modal.apply.modeUncommitted')))))
          : null,
        statusBanner,
        h('div', { className: 'dshwt-modal-foot' },
          appliedResult !== null
            ? h('button', { type: 'button', className: 'dshwt-btn dshwt-btn-primary', onClick: onClose }, t('modal.done'))
            : h(React.Fragment, null,
              h('button', { type: 'button', className: 'dshwt-btn', disabled: submitting, onClick: onClose }, t('modal.cancel')),
              h('button', { type: 'button', className: 'dshwt-btn dshwt-btn-primary', disabled: !canSubmit, onClick: () => void submit() },
                submitting ? t('panel.act.busy') : submitLabel))))
    }

    function LogDrawerOverlay() {
      const { t } = useLocale()
      const drawer = useLogDrawerState()
      const applyTarget = useApplyModalState()
      const showDrawer = drawer.open && drawer.op !== null
      if (!showDrawer && applyTarget === null) return null
      return h(React.Fragment, null,
        showDrawer
          ? h(LogDrawer, {
            operationId: drawer.op.id,
            label: drawer.op.label,
            icon: drawer.op.icon,
            minimized: drawer.minimized,
            onToggleMinimize: toggleMinimizeLogDrawer,
            onClose: closeLogDrawer,
            onSettled: () => notifyEnvChanged(),
            t,
          })
          : null,
        applyTarget !== null
          ? h(ApplyBackflowModal, { target: applyTarget, onClose: closeApplyModal, t })
          : null)
    }

    /** ---- Right-sidebar Action Log tab (`sidebar.right.pane.tab`, opened on demand from top bar) ---- */
    function ActionLogTabTitle(props) {
      const { t } = useLocale()
      const sessionId = props?.sessionId ?? GLOBAL_SESSION_KEY
      const bucket = useSessionLogs(sessionId)
      const current = bucket.ops.find(o => o.id === bucket.activeId) ?? bucket.ops[0] ?? null
      const title = current?.actionName || current?.label || t('logs.title')
      return h('span', { className: 'dshwt-rtab-title' },
        current?.icon
          ? h(ActionIcon, { kind: current.icon, size: 15, outline: true })
          : h(CodeIcon, { size: 15 }),
        h('span', { className: 'dshwt-rtab-label' }, title))
    }

    function ActionLogPane(ctx) {
      return function LogTabBody(props) {
        const { t } = useLocale()
        const sessionId = props?.sessionId ?? GLOBAL_SESSION_KEY
        const bucket = useSessionLogs(sessionId)
        const current = bucket.ops.find(o => o.id === bucket.activeId) ?? bucket.ops[0] ?? null
        const [rerunning, setRerunning] = useState(false)

        // Hydrate running backend ops if the tab survived a page reload
        useEffect(() => {
          if (bucket.ops.length > 0 || sessionId === GLOBAL_SESSION_KEY) return
          const cwd = extractSummaryCwd(sessionSummaryOf(ctx, sessionId))
          const params = [`sessionId=${enc(sessionId)}`]
          if (typeof cwd === 'string' && cwd.length > 0) params.push(`cwd=${enc(cwd)}`)
          void api(`/session-actions?${params.join('&')}`).then((value) => {
            const running = value?.activeOperations ?? []
            const actions = value?.actions ?? []
            for (const op of running) {
              const matched = actions.find(a => a.name === op.actionName)
              recordSessionOp(sessionId, {
                id: op.id,
                label: op.label,
                actionName: op.actionName ?? null,
                icon: matched?.icon ?? 'tool',
                cwd: value?.cwd ?? cwd ?? null,
              })
            }
          }).catch(() => {})
        }, [sessionId, bucket.ops.length])

        const { lines, status, opLabel } = useOperationStream(
          current?.id ?? null,
          current?.label ?? '',
          () => notifyEnvChanged(),
        )
        const { copied, boxRef, onScroll, copyAll } = useAutoScrollLog(current?.id ?? null, lines, true)

        const rerun = async () => {
          if (!current?.actionName || rerunning) return
          setRerunning(true)
          try {
            const result = await api('/actions/run', {
              method: 'POST',
              body: JSON.stringify({
                sessionId: sessionId !== GLOBAL_SESSION_KEY ? sessionId : undefined,
                cwd: current.cwd ?? undefined,
                action: current.actionName,
              }),
            })
            if (result?.operationId) {
              recordSessionOp(sessionId, {
                id: result.operationId,
                label: current.label,
                actionName: current.actionName,
                icon: current.icon,
                cwd: current.cwd,
              })
              notifyEnvChanged()
            }
          } catch {
            // ignore transient rerun errors
          } finally {
            setRerunning(false)
          }
        }

        if (current === null) {
          return h('div', { className: 'dshwt-rlog' },
            h('div', { className: 'dshwt-rlog-empty' }, t('logs.empty')))
        }

        const statusText = t(`logs.status.${status}`) || status

        return h('div', { className: 'dshwt-rlog', role: 'region', 'aria-label': opLabel || t('logs.title') },
          h('div', { className: 'dshwt-rlog-head' },
            h('div', { className: 'dshwt-drawer-main', title: opLabel || t('logs.title') },
              h('span', { className: 'dshwt-log-dot', 'data-status': status, 'aria-hidden': true }),
              current.icon
                ? h('span', { style: { color: 'var(--dsw-alias-label-secondary, #57606a)', display: 'inline-flex', flex: 'none' } },
                  h(ActionIcon, { kind: current.icon, size: 15, outline: true }))
                : null,
              h('span', { className: 'dshwt-drawer-title' }, opLabel || t('logs.title')),
              h('span', { className: 'dshwt-drawer-sep', 'aria-hidden': true }),
              h('span', { className: 'dshwt-drawer-status', 'data-status': status }, statusText)),
            h('div', { className: 'dshwt-drawer-acts' },
              status === 'running'
                ? h(Hint, { label: t('logs.cancel'), side: 'bottom' },
                  h('button', {
                    type: 'button',
                    className: 'dshwt-icon-btn dshwt-icon-btn-danger',
                    title: hasNativeTooltip ? undefined : t('logs.cancel'),
                    'aria-label': t('logs.cancel'),
                    onClick: () => void api(`/operations/${enc(current.id)}/cancel`, { method: 'POST' }),
                  }, h(StopIcon, { size: 15 })))
                : current.actionName
                  ? h(Hint, { label: t('logs.rerun'), side: 'bottom' },
                    h('button', {
                      type: 'button',
                      className: `dshwt-icon-btn ${rerunning ? 'dshwt-spin' : ''}`,
                      disabled: rerunning,
                      title: hasNativeTooltip ? undefined : t('logs.rerun'),
                      'aria-label': t('logs.rerun'),
                      onClick: () => void rerun(),
                    }, h(RefreshIcon, { size: 15 })))
                  : null,
              h(Hint, { label: copied ? t('logs.copied') : t('logs.copy'), side: 'bottom' },
                h('button', {
                  type: 'button',
                  className: 'dshwt-icon-btn',
                  title: hasNativeTooltip ? undefined : (copied ? t('logs.copied') : t('logs.copy')),
                  'aria-label': copied ? t('logs.copied') : t('logs.copy'),
                  onClick: copyAll,
                }, copied ? h(CheckIcon, { size: 15 }) : h(CopyIcon, { size: 15 }))))),
          bucket.ops.length > 1
            ? h('div', { className: 'dshwt-rlog-runs', role: 'tablist' },
              bucket.ops.map(op => h('button', {
                key: op.id,
                type: 'button',
                role: 'tab',
                className: 'dshwt-rlog-run',
                'aria-selected': op.id === current.id,
                title: op.label,
                onClick: () => selectSessionOp(sessionId, op.id),
              },
              op.icon ? h(ActionIcon, { kind: op.icon, size: 13, outline: true }) : null,
              h('span', null, op.actionName || op.label))))
            : null,
          h('div', { className: 'dshwt-rlog-body-wrap' }, renderLogOutput(lines, boxRef, onScroll, t)))
      }
    }

    /** ---- Native DSH Modals ---- */
    function ModalShell({ title, onClose, children }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return portalToBody(h('div', { className: 'dshwt-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'dshwt-modal', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('h3', { className: 'dshwt-modal-title' }, title),
          children)))
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
      const uiWorkspace = CLIENT_STATE.ctx?.get?.('uiWorkspace')
      if (typeof uiWorkspace?.pickDirectory === 'function') return await uiWorkspace.pickDirectory()
      return undefined
    }

    async function registerProjectWorkspace(path) {
      const workspaces = CLIENT_STATE.ctx?.get?.('workspaces')
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
              h(Hint, { label: copied ? t('env.copied') : t('env.copy'), side: 'top' },
                h('button', {
                  type: 'button',
                  className: 'dshwt-icon-btn',
                  title: hasNativeTooltip ? undefined : (copied ? t('env.copied') : t('env.copy')),
                  'aria-label': copied ? t('env.copied') : t('env.copy'),
                  onClick: doCopy,
                }, copied ? h(CheckIcon, { size: 14 }) : h(CopyIcon, { size: 14 })))),
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
          h(Hint, { label: t('env.removeAction'), side: 'top' },
            h('button', {
              type: 'button',
              className: 'dshwt-icon-btn dshwt-icon-btn-danger',
              title: hasNativeTooltip ? undefined : t('env.removeAction'),
              'aria-label': t('env.removeAction'),
              disabled,
              onClick: onRemove,
            }, h(TrashIcon, { size: 15 })))))
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
            notifyEnvChanged()
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
                  h(Hint, { label: t('env.addEnvTo', { name: project.name }), side: 'top' },
                    h('button', {
                      type: 'button',
                      className: 'dshwt-pill-btn dshwt-pill-btn-icon',
                      title: hasNativeTooltip ? undefined : t('env.addEnvTo', { name: project.name }),
                      'aria-label': t('env.addEnvTo', { name: project.name }),
                      onClick: () => setView({
                        mode: 'edit',
                        projectRoot: project.root,
                        projectName: project.name,
                        configPath: project.nextConfigPath,
                        isNew: true,
                        initialEnv: null,
                      }),
                    }, h(PlusIcon, { size: 14 })))),
                project.environments.length > 0
                  ? h('div', { className: 'dshwt-env-children' },
                    project.environments.map(env => {
                      const label = env.valid ? (env.name || env.fileName) : t('env.parseError')
                      const subtitle = env.fileName
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
      const ctx = CLIENT_STATE.ctx
      const sessions = ctx?.get?.('sessions')
      const uiWorkspace = ctx?.get?.('uiWorkspace')
      if (sessions === undefined || typeof sessions.create !== 'function') {
        const err = new Error('session service unavailable')
        err.code = 'SESSION_SERVICE_UNAVAILABLE'
        throw err
      }
      const sessionId = await sessions.create({ cwd: item.path })
      if (typeof uiWorkspace?.openSession === 'function') {
        uiWorkspace.openSession(sessionId)
      }
      return sessionId
    }

    function NumberStepper({ value, draft, min = 1, disabled, label, increaseLabel, decreaseLabel, onDraftChange, onCommit, onStep }) {
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
            'aria-label': increaseLabel ?? '+',
            disabled,
            onMouseDown: e => e.preventDefault(),
            onClick: () => onStep(1),
          }, h(ChevronIcon, { dir: 'up' })),
          h('button', {
            type: 'button',
            className: 'dshwt-stepper-arrow',
            'aria-label': decreaseLabel ?? '-',
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
      const [pendingPurge, setPendingPurge] = useState(null)

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

      const archivedGrouped = useMemo(() => {
        const archived = (items ?? []).filter(i => i.status === 'archived')
        const map = new Map()
        for (const item of archived) {
          const list = map.get(item.repositoryRoot) ?? []
          list.push(item)
          map.set(item.repositoryRoot, list)
        }
        return [...map.entries()]
      }, [items])

      const toggleRepo = (repoKey) => {
        setCollapsed(prev => {
          const next = new Set(prev)
          if (next.has(repoKey)) next.delete(repoKey)
          else next.add(repoKey)
          return next
        })
      }

      const startChat = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          await openWorktreeSession(item)
        } catch (err) {
          setError(err?.code === 'SESSION_SERVICE_UNAVAILABLE' ? { code: err.code } : { message: err.message })
        } finally {
          setBusyId(null)
        }
      }

      const runSetup = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          const res = await api(`/worktrees/${enc(item.id)}/setup?async=1`, { method: 'POST', body: JSON.stringify({ async: true }) })
          if (res?.operationId) {
            openLogDrawer({ id: res.operationId, label: `${item.branch} · setup`, icon: 'tool' })
          }
          await refresh()
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
          notifyEnvChanged()
        } catch (err) {
          setError(err.message)
          throw err
        } finally {
          setBusyId(null)
        }
      }

      const restoreWorktree = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          await api(`/worktrees/${enc(item.id)}/restore`, { method: 'POST', body: JSON.stringify({}) })
          await refresh()
          notifyEnvChanged()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusyId(null)
        }
      }

      const purgeWorktree = async (item) => {
        setBusyId(item.id)
        setError(null)
        try {
          await api(`/worktrees/${enc(item.id)}`, { method: 'DELETE', body: JSON.stringify({ deleteSnapshot: true }) })
          await refresh()
          notifyEnvChanged()
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
          h(Hint, { label: t('settings.managed.refresh'), side: 'top' },
            h('button', {
              type: 'button',
              className: `dshwt-icon-btn ${loading ? 'dshwt-spin' : ''}`,
              disabled: loading,
              title: hasNativeTooltip ? undefined : t('settings.managed.refresh'),
              'aria-label': t('settings.managed.refresh'),
              onClick: () => void refresh(),
            }, h(RefreshIcon, { size: 15 })))),
        error ? h('div', { className: 'dshwt-setting-err', role: 'alert', style: { paddingTop: 8 } },
          typeof error === 'object' && error.code === 'SESSION_SERVICE_UNAVAILABLE' ? t('error.sessionUnavailable') : (error.message ?? error)) : null,
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
                        item.envSourcePath !== null || item.setupState !== 'not-configured'
                          ? h(Hint, { label: t('panel.act.setup'), side: 'top' },
                            h('button', {
                              type: 'button',
                              className: 'dshwt-icon-btn',
                              disabled: rowBusy,
                              title: hasNativeTooltip ? undefined : t('panel.act.setup'),
                              'aria-label': t('panel.act.setup'),
                              onClick: () => void runSetup(item),
                            }, h(ActionIcon, { kind: 'tool', size: 15, outline: true })))
                          : null,
                        h(Hint, { label: t('settings.managed.newChat'), side: 'top' },
                          h('button', {
                            type: 'button',
                            className: 'dshwt-icon-btn',
                            disabled: rowBusy,
                            title: hasNativeTooltip ? undefined : t('settings.managed.newChat'),
                            'aria-label': t('settings.managed.newChat'),
                            onClick: () => void startChat(item),
                          }, h(ChatPlusIcon, { size: 16 }))),
                        h(Hint, { label: t('settings.managed.delete'), side: 'top' },
                          h('button', {
                            type: 'button',
                            className: 'dshwt-icon-btn dshwt-icon-btn-danger',
                            disabled: rowBusy,
                            title: hasNativeTooltip ? undefined : t('settings.managed.delete'),
                            'aria-label': t('settings.managed.delete'),
                            onClick: () => {
                              if (confirmBeforeDelete) setPendingDelete(item)
                              else void removeWorktree(item).catch(() => {})
                            },
                          }, h(TrashIcon, { size: 15 })))))
                  }))
                : null)
          }),
        archivedGrouped.length > 0
          ? h('div', { className: 'dshwt-archived-block' },
            h('div', { className: 'dshwt-managed-head' },
              h('h3', { className: 'dshwt-settings-group-title' }, t('settings.archived.title'))),
            archivedGrouped.map(([repoRoot, list]) => {
              const key = `archived:${repoRoot}`
              const expanded = !collapsed.has(key)
              return h('div', { key, className: 'dshwt-managed-group' },
                h('button', {
                  type: 'button',
                  className: 'dshwt-managed-repo',
                  'aria-expanded': expanded,
                  onClick: () => toggleRepo(key),
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
                          h('div', { className: 'dshwt-managed-name-row' },
                            h('span', { className: 'dshwt-managed-name' }, item.branch),
                            item.snapshotRef ? h('span', { className: 'dshwt-snap-pill' }, t('settings.archived.snapshot')) : null),
                          h('div', { className: 'dshwt-managed-path', title: item.path }, item.path)),
                        h('div', { className: 'dshwt-managed-acts' },
                          h(Hint, { label: t('settings.archived.restore'), side: 'top' },
                            h('button', {
                              type: 'button',
                              className: `dshwt-icon-btn ${rowBusy ? 'dshwt-spin' : ''}`,
                              disabled: rowBusy,
                              title: hasNativeTooltip ? undefined : t('settings.archived.restore'),
                              'aria-label': t('settings.archived.restore'),
                              onClick: () => void restoreWorktree(item),
                            }, h(RestoreIcon, { size: 15 }))),
                          h(Hint, { label: t('settings.archived.purge'), side: 'top' },
                            h('button', {
                              type: 'button',
                              className: 'dshwt-icon-btn dshwt-icon-btn-danger',
                              disabled: rowBusy,
                              title: hasNativeTooltip ? undefined : t('settings.archived.purge'),
                              'aria-label': t('settings.archived.purge'),
                              onClick: () => {
                                if (confirmBeforeDelete) setPendingPurge(item)
                                else void purgeWorktree(item).catch(() => {})
                              },
                            }, h(TrashIcon, { size: 15 })))))
                    }))
                  : null)
            }))
          : null,
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
          : null,
        pendingPurge !== null
          ? h(ConfirmModal, {
            title: t('settings.archived.purgeTitle'),
            desc: t('settings.archived.purgeDesc', { branch: pendingPurge.branch }),
            submitLabel: t('settings.archived.purge'),
            danger: true,
            onClose: () => setPendingPurge(null),
            onConfirm: () => purgeWorktree(pendingPurge),
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
          const payload = err?.code === 'INVALID_WORKTREE_DIRECTORY'
            ? { code: 'INVALID_WORKTREE_DIRECTORY' }
            : { message: err.message }
          if (target === 'dir') setDirError(payload)
          else setGeneralError(payload)
        } finally {
          setBusy(false)
        }
      }

      const formatSettingError = (err) => {
        if (err === null || err === undefined) return null
        if (typeof err === 'object' && err.code === 'INVALID_WORKTREE_DIRECTORY') return t('settings.worktreeDir.invalid')
        return typeof err === 'object' ? err.message : String(err)
      }
      const dirErrorText = formatSettingError(dirError)
      const generalErrorText = formatSettingError(generalError)

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
          generalErrorText ? h('div', { className: 'dshwt-setting-err', role: 'alert', style: { paddingBottom: 8 } }, generalErrorText) : null,
          h('div', { className: 'dshwt-settings-list' },
            h('div', { className: 'dshwt-setting-row' },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.worktreeDir.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.worktreeDir.desc')),
                dirErrorText ? h('div', { className: 'dshwt-setting-err', role: 'alert' }, dirErrorText) : null),
              h('div', { className: 'dshwt-setting-ctrl' },
                h('input', {
                  className: 'dshwt-setting-input',
                  placeholder: config.defaultWorktreeDirectory || '.agents/worktrees',
                  'aria-label': t('settings.worktreeDir.label'),
                  'aria-invalid': dirErrorText ? true : undefined,
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
                h('div', { className: 'dshwt-setting-title' }, t('settings.autoCleanup.label')),
                h('div', { className: 'dshwt-setting-desc dshwt-setting-desc-row' },
                  h('span', null, t('settings.autoCleanup.desc')),
                  h(Hint, { label: t('settings.autoCleanup.info'), side: 'top' },
                    h('span', {
                      className: 'dshwt-info-badge',
                      tabIndex: 0,
                      role: 'note',
                      title: hasNativeTooltip ? undefined : t('settings.autoCleanup.info'),
                      'aria-label': t('settings.autoCleanup.info'),
                    }, h(InfoIcon, { size: 14 }))))),
              h('div', { className: 'dshwt-setting-ctrl' },
                h(SwitchControl, {
                  checked: config.autoCleanupEnabled !== false,
                  disabled: busy,
                  label: t('settings.autoCleanup.label'),
                  onChange: next => void save({ autoCleanupEnabled: next }),
                }))),
            h('div', { className: `dshwt-setting-row ${config.autoCleanupEnabled === false ? 'dshwt-setting-row-dim' : ''}` },
              h('div', { className: 'dshwt-setting-copy' },
                h('div', { className: 'dshwt-setting-title' }, t('settings.keepCount.label')),
                h('div', { className: 'dshwt-setting-desc' }, t('settings.keepCount.desc'))),
              h('div', { className: 'dshwt-setting-ctrl' },
                h(NumberStepper, {
                  value: config.keepCount ?? 15,
                  draft: keepDraft,
                  min: 1,
                  disabled: busy || config.autoCleanupEnabled === false,
                  label: t('settings.keepCount.label'),
                  increaseLabel: t('settings.keepCount.increase'),
                  decreaseLabel: t('settings.keepCount.decrease'),
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

    /** ---- Session top-bar quick actions (`conversation.session.header.utilities`) ---- */
    function extractDirPath(value) {
      if (typeof value === 'string' && value.length > 0) return value
      if (value && typeof value === 'object') {
        if (typeof value.path === 'string' && value.path.length > 0) return value.path
        if (typeof value.cwd === 'string' && value.cwd.length > 0) return value.cwd
      }
      return null
    }

    function extractSummaryCwd(summary) {
      if (summary === undefined || summary === null) return null
      return extractDirPath(summary.projectionValues?.workingDirectory)
        ?? extractDirPath(summary.projectionValues?.forgeWorktree)
        ?? extractDirPath(summary.projections?.workingDirectory)
        ?? extractDirPath(summary.cwd)
        ?? extractDirPath(summary.workspacePath)
    }

    /** ---- Native DSH terminal launcher (preferred runner when persistent terminal is enabled) ---- */
    function posixQuote(value) {
      return `'${String(value).replace(/'/g, `'\\''`)}'`
    }

    function psQuote(value) {
      return `'${String(value).replace(/'/g, `''`)}'`
    }

    function buildTerminalCommand(command, info, termCwd, shellName = '') {
      const cmd = String(command ?? '').replace(/\r\n/g, '\n').trimEnd()
      const lowerShell = String(shellName).toLowerCase()
      const isPowerShell = lowerShell.includes('powershell') || lowerShell.includes('pwsh')
      const isCmd = lowerShell === 'cmd' || lowerShell.endsWith('cmd.exe')
      const needsEnvVars = /\bDSH_(?:SOURCE_TREE_PATH|WORKTREE_PATH|WORKTREE_BRANCH)\b/.test(cmd)
      const targetCwd = typeof info?.cwd === 'string' && info.cwd.length > 0 ? info.cwd : null
      const needsCd = targetCwd !== null && typeof termCwd === 'string' && termCwd.length > 0 && termCwd !== targetCwd
      const sourceRoot = info?.repositoryRoot ?? targetCwd ?? ''
      const worktreePath = targetCwd ?? ''
      const branch = info?.branch ?? ''
      const prefixes = []

      if (isPowerShell) {
        if (needsCd) prefixes.push(`Set-Location -LiteralPath ${psQuote(targetCwd)}`)
        if (needsEnvVars) {
          prefixes.push(`$env:DSH_SOURCE_TREE_PATH=${psQuote(sourceRoot)}; $env:DSH_WORKTREE_PATH=${psQuote(worktreePath)}; $env:DSH_WORKTREE_BRANCH=${psQuote(branch)}`)
        }
        return prefixes.length > 0 ? `${prefixes.join('; ')}; ${cmd}` : cmd
      }

      if (isCmd) {
        if (needsCd) prefixes.push(`cd /d "${targetCwd}"`)
        if (needsEnvVars) {
          prefixes.push(`set "DSH_SOURCE_TREE_PATH=${sourceRoot}" && set "DSH_WORKTREE_PATH=${worktreePath}" && set "DSH_WORKTREE_BRANCH=${branch}"`)
        }
        return prefixes.length > 0 ? `${prefixes.join(' && ')} && ${cmd}` : cmd
      }

      // POSIX shells (zsh / bash / sh / fish-compatible basic export)
      if (needsCd) prefixes.push(`cd ${posixQuote(targetCwd)}`)
      if (typeof info?.envFile === 'string' && info.envFile.length > 0) {
        prefixes.push(`. ${posixQuote(info.envFile)}`)
      }
      if (needsEnvVars) {
        prefixes.push(`export DSH_SOURCE_TREE_PATH=${posixQuote(sourceRoot)} DSH_WORKTREE_PATH=${posixQuote(worktreePath)} DSH_WORKTREE_BRANCH=${posixQuote(branch)}`)
      }
      if (prefixes.length === 0) return cmd
      return cmd.includes('\n') ? `${prefixes.join(' && ')}\n${cmd}` : `${prefixes.join(' && ')} && ${cmd}`
    }

    function resolveTerminalContentId(sidebarRight, sessionId, opened) {
      const occ = sidebarRight?.tabDomain?.occurrence?.(sessionId, { id: opened.id })
      const address = occ?.navigation?.getSnapshot?.()?.address
      return address ?? opened.contentId
    }

    function sessionSummaryOf(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      return ctx?.get?.('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]
    }

    function canUseNativeTerminal(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      const sidebarRight = ctx?.get?.('sidebarRight')
      const sidebarRightTabs = ctx?.get?.('sidebarRightTabs')
      const webTerminals = ctx?.get?.('webTerminals')
      return sidebarRight !== undefined
        && typeof sidebarRight.tabsIn === 'function'
        && (typeof sidebarRight.openTabIn === 'function' || typeof sidebarRight.openTab === 'function')
        && typeof sidebarRightTabs?.get === 'function'
        && sidebarRightTabs.get('terminal') !== undefined
        && webTerminals !== undefined
        && typeof webTerminals.view === 'function'
    }

    async function runActionInNativeTerminal(ctx, sessionId, info, action) {
      if (!canUseNativeTerminal(ctx, sessionId)) return false
      const sidebarRight = ctx.get('sidebarRight')
      const webTerminals = ctx.get('webTerminals')
      const before = new Set((sidebarRight.tabsIn(sessionId) ?? []).map(tab => tab.id))
      try {
        if (typeof sidebarRight.openTabIn === 'function') sidebarRight.openTabIn(sessionId, 'terminal')
        else sidebarRight.openTab('terminal')
      } catch {
        return false
      }
      const opened = (sidebarRight.tabsIn(sessionId) ?? []).find(tab => tab.kind === 'terminal' && !before.has(tab.id))
      if (opened === undefined) return false

      const contentId = resolveTerminalContentId(sidebarRight, sessionId, opened)
      const termView = webTerminals.view(sessionId, opened.id, contentId)
      if (termView === undefined || typeof termView.write !== 'function') return false

      const ready = await new Promise((resolve) => {
        const inspect = () => {
          const st = termView.state?.getSnapshot?.()
          if (!st) return null
          if (st.phase === 'connected' && st.writable) return { ok: true, state: st }
          if (st.phase === 'failed' || st.phase === 'closed') return { ok: false, state: st }
          return null
        }
        const now = inspect()
        if (now !== null) { resolve(now); return }
        let settled = false
        const finish = (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { unsub?.() } catch {}
          resolve(result)
        }
        const unsub = termView.state?.subscribe?.(() => {
          const next = inspect()
          if (next !== null) finish(next)
        })
        const timer = setTimeout(() => finish({ ok: false, state: termView.state?.getSnapshot?.() }), 15000)
      })

      if (!ready.ok) {
        try { sidebarRight.closeIn?.(sessionId, opened.id) } catch {}
        return false
      }

      if (typeof termView.rename === 'function' && typeof action.name === 'string' && action.name.trim().length > 0) {
        void Promise.resolve(termView.rename(action.name.trim())).catch(() => {})
      }
      trackNativeTerminal(ctx, sessionId, action.name, opened.id, contentId, termView)
      const shellName = ready.state?.info?.shell?.name ?? ''
      const payload = buildTerminalCommand(action.command ?? '', info, ready.state?.info?.cwd, shellName)
      await new Promise(r => setTimeout(r, 140))
      termView.write(`${payload}\r`, false)
      return true
    }

    function SessionHeaderActions(ctx) {
      return function HeaderActions(props) {
        const { t } = useLocale()
        const sessionId = props?.sessionId ?? props?.id ?? null
        const sessionLogs = useSessionLogs(sessionId ?? GLOBAL_SESSION_KEY)
        const nativeRunning = useNativeTerminalActions(ctx, sessionId)
        const summary = typeof props?.useSessions === 'function'
          ? props.useSessions(state => (sessionId ? state?.byId?.[sessionId] : undefined))
          : sessionSummaryOf(ctx, sessionId)
        const cwd = props?.cwd ?? extractSummaryCwd(summary)

        const [info, setInfo] = useState(null)
        const [selectedName, setSelectedName] = useState(null)
        const [menuOpen, setMenuOpen] = useState(false)
        const [menuPos, setMenuPos] = useState(null)
        const [starting, setStarting] = useState(false)
        const [restoring, setRestoring] = useState(false)
        const [error, setError] = useState(null)
        const [envTick, setEnvTick] = useState(0)

        const wrapRef = useRef(null)
        const menuRef = useRef(null)

        useEffect(() => {
          const bump = () => {
            reconcileNativeTerminals(ctx)
            setEnvTick(n => n + 1)
          }
          CLIENT_STATE.envListeners.add(bump)
          if (typeof window !== 'undefined') window.addEventListener('focus', bump)
          return () => {
            CLIENT_STATE.envListeners.delete(bump)
            if (typeof window !== 'undefined') window.removeEventListener('focus', bump)
          }
        }, [])

        const refresh = useCallback(async () => {
          if (!sessionId && !cwd) {
            setInfo(null)
            return
          }
          const params = []
          if (typeof sessionId === 'string' && sessionId.length > 0) params.push(`sessionId=${enc(sessionId)}`)
          if (typeof cwd === 'string' && cwd.length > 0) params.push(`cwd=${enc(cwd)}`)
          try {
            const value = await api(`/session-actions?${params.join('&')}`)
            setInfo(value)
          } catch {
            // keep last known state on transient failure
          }
        }, [sessionId, cwd])

        // Reset transient menu/error only when switching sessions — never on window focus or refresh!
        useEffect(() => {
          setMenuOpen(false)
          setError(null)
        }, [sessionId])

        useEffect(() => {
          void refresh()
        }, [refresh, envTick])

        useEffect(() => {
          if (!menuOpen) return
          const updatePos = () => {
            const rect = wrapRef.current?.getBoundingClientRect?.()
            if (!rect) return
            const width = typeof window !== 'undefined' ? window.innerWidth : 1200
            const right = Math.max(12, width - rect.right)
            setMenuPos({ top: rect.bottom + 6, right })
          }
          updatePos()
          const onPointerDown = (e) => {
            if (wrapRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
            setMenuOpen(false)
          }
          const onKeyDown = (e) => {
            if (e.key === 'Escape') setMenuOpen(false)
          }
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          window.addEventListener('resize', updatePos)
          return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('resize', updatePos)
          }
        }, [menuOpen])

        const actions = info?.actions ?? []
        const activeOps = info?.activeOperations ?? []
        const archivedWorktree = info?.archivedWorktree ?? null
        const primary = actions.find(a => a.name === selectedName) ?? actions[0] ?? null
        const runningOp = activeOps.find(op => op.status === 'running') ?? null

        if (archivedWorktree !== null) {
          const restoreTip = error !== null
            ? error
            : archivedWorktree.hasSnapshot
              ? t('header.restore.tipSnapshot', { branch: archivedWorktree.branch })
              : t('header.restore.tipPlain', { branch: archivedWorktree.branch })
          const doRestore = async () => {
            if (restoring) return
            setRestoring(true)
            setError(null)
            try {
              await api(`/worktrees/${enc(archivedWorktree.id)}/restore`, { method: 'POST', body: JSON.stringify({}) })
              notifyEnvChanged()
              await refresh()
            } catch (err) {
              setError(err.message)
            } finally {
              setRestoring(false)
            }
          }
          return h('div', { className: 'dshwt-hdr-wrap', ref: wrapRef },
            h(Hint, { label: restoreTip, side: 'bottom' },
              h('button', {
                type: 'button',
                className: `dshwt-hdr-btn dshwt-hdr-restore ${restoring ? 'dshwt-spin' : ''}`,
                disabled: restoring,
                title: hasNativeTooltip ? undefined : restoreTip,
                'aria-label': restoreTip,
                onClick: () => void doRestore(),
              },
              h(RestoreIcon, { size: 15 }),
              h('span', { className: 'dshwt-hdr-label' }, restoring ? t('header.restore.restoring') : t('header.restore.label')))))
        }

        if (actions.length === 0) return null

        const runAction = async (action, opts = {}) => {
          if (!action) return
          const forceNew = opts?.forceNew === true
          setSelectedName(action.name)
          setMenuOpen(false)
          if (!forceNew && focusNativeTerminal(ctx, sessionId, action.name)) {
            return
          }
          const existing = activeOps.find(op => op.actionName === action.name && op.status === 'running')
          if (!forceNew && existing) {
            openActionLog(ctx, sessionId, {
              id: existing.id,
              label: existing.label,
              actionName: action.name,
              icon: action.icon ?? 'tool',
              cwd: info?.cwd ?? cwd ?? null,
            })
            return
          }
          setStarting(true)
          setError(null)
          try {
            // Tier 1: prefer DSH's native interactive terminal when enabled
            const ranInTerminal = await runActionInNativeTerminal(ctx, sessionId, info, action)
            if (ranInTerminal) return

            // Tier 2/3 fallback: run via plugin EnvRunner and stream to right-sidebar log tab (or overlay drawer)
            const result = await api('/actions/run', {
              method: 'POST',
              body: JSON.stringify({
                sessionId: sessionId ?? undefined,
                cwd: info?.cwd ?? cwd ?? undefined,
                action: action.name,
              }),
            })
            if (result?.operationId) {
              const scope = info?.branch || repoName(info?.cwd ?? cwd ?? '')
              openActionLog(ctx, sessionId, {
                id: result.operationId,
                label: scope ? `${scope} · ${action.name}` : action.name,
                actionName: action.name,
                icon: action.icon ?? 'tool',
                cwd: info?.cwd ?? cwd ?? null,
              })
            }
            void refresh()
          } catch (err) {
            setError(err.message)
            setMenuOpen(true)
          } finally {
            setStarting(false)
          }
        }

        const primaryNativeRunning = primary !== null && nativeRunning.has(primary.name)
        const primaryFallbackRunning = primary !== null && activeOps.some(op => op.actionName === primary.name && op.status === 'running')
        const primaryRunning = primaryNativeRunning || primaryFallbackRunning
        const anyRunning = runningOp !== null || nativeRunning.size > 0
        const otherRunning = !primaryRunning && anyRunning
        const primaryTitle = primary
          ? (primaryNativeRunning
            ? t('header.actions.focusTerminal', { name: primary.name })
            : primaryFallbackRunning
              ? t('header.actions.viewLogs')
              : `${t('header.actions.run', { name: primary.name })} — ${primary.command}`)
          : t('header.actions.menu')

        const canShowLogsItem = runningOp !== null || sessionLogs.ops.length > 0

        const menuPortal = menuOpen && menuPos !== null
          ? portalToBody(h('div', {
            ref: menuRef,
            className: 'dshwt-hdr-menu',
            role: 'menu',
            'aria-label': t('header.actions.menu'),
            style: { top: menuPos.top, right: menuPos.right },
          },
          actions.map((action, idx) => {
            const isNativeRunning = nativeRunning.has(action.name)
            const isFallbackRunning = activeOps.some(op => op.actionName === action.name && op.status === 'running')
            const isRunning = isNativeRunning || isFallbackRunning
            const firstLine = (action.command ?? '').trim().split(/\r?\n/)[0] ?? ''
            return h('div', { key: `${action.name}-${idx}`, className: 'dshwt-hdr-menu-row' },
              h('button', {
                type: 'button',
                role: 'menuitem',
                className: 'dshwt-hdr-menu-item',
                disabled: starting,
                title: isNativeRunning ? t('header.actions.focusTerminal', { name: action.name }) : undefined,
                onClick: () => void runAction(action),
              },
              h(ActionIcon, { kind: action.icon ?? 'tool', size: 16, outline: true }),
              h('span', { className: 'dshwt-hdr-menu-copy' },
                h('span', { className: 'dshwt-hdr-menu-name' }, action.name),
                firstLine.length > 0 ? h('span', { className: 'dshwt-hdr-menu-cmd', title: action.command }, firstLine) : null),
              isRunning ? h('span', { className: 'dshwt-hdr-dot', title: t('header.actions.running') }) : null),
              isNativeRunning
                ? h(Hint, { label: t('header.actions.runNewTerminal'), side: 'top' },
                  h('button', {
                    type: 'button',
                    className: 'dshwt-hdr-menu-new',
                    disabled: starting,
                    title: hasNativeTooltip ? undefined : t('header.actions.runNewTerminal'),
                    'aria-label': t('header.actions.runNewTerminal'),
                    onClick: (e) => {
                      e.stopPropagation()
                      void runAction(action, { forceNew: true })
                    },
                  }, h(PlusIcon, { size: 13 })))
                : null)
          }),
          canShowLogsItem
            ? h(React.Fragment, null,
              h('div', { className: 'dshwt-hdr-menu-sep' }),
              h('button', {
                type: 'button',
                role: 'menuitem',
                className: 'dshwt-hdr-menu-item',
                onClick: () => {
                  if (runningOp !== null) {
                    const matched = actions.find(a => a.name === runningOp.actionName)
                    openActionLog(ctx, sessionId, {
                      id: runningOp.id,
                      label: runningOp.label,
                      actionName: runningOp.actionName ?? null,
                      icon: matched?.icon ?? 'tool',
                      cwd: info?.cwd ?? cwd ?? null,
                    })
                  } else if (sessionLogs.ops.length > 0) {
                    const target = sessionLogs.ops.find(o => o.id === sessionLogs.activeId) ?? sessionLogs.ops[0]
                    openActionLog(ctx, sessionId, target)
                  }
                  setMenuOpen(false)
                },
              },
              h(CodeIcon, { size: 15 }),
              h('span', { className: 'dshwt-hdr-menu-name' }, t('header.actions.viewLogs'))))
            : null,
          error !== null ? h('div', { className: 'dshwt-hdr-menu-err', role: 'alert' }, error) : null))
          : null

        const primaryButton = primary !== null
          ? h(Hint, { label: primaryTitle, side: 'bottom' },
            h('button', {
              type: 'button',
              className: 'dshwt-hdr-btn',
              disabled: starting,
              title: hasNativeTooltip ? undefined : primaryTitle,
              'aria-label': primaryTitle,
              onClick: () => void runAction(primary),
            },
            h(ActionIcon, { kind: primary.icon ?? 'tool', size: 15, outline: true }),
            h('span', { className: 'dshwt-hdr-label' }, primary.name),
            primaryRunning ? h('span', { className: 'dshwt-hdr-dot', title: t('header.actions.running') }) : null))
          : null

        return h('div', { className: 'dshwt-hdr-wrap', ref: wrapRef },
          actions.length === 1
            ? primaryButton
            : primaryButton !== null
              ? h('div', { className: 'dshwt-hdr-split' },
                primaryButton,
                h(Hint, { label: t('header.actions.menu'), side: 'bottom' },
                  h('button', {
                    type: 'button',
                    className: 'dshwt-hdr-caret',
                    disabled: starting,
                    title: hasNativeTooltip ? undefined : t('header.actions.menu'),
                    'aria-label': t('header.actions.menu'),
                    'aria-haspopup': 'menu',
                    'aria-expanded': menuOpen,
                    onClick: () => {
                      reconcileNativeTerminals(ctx)
                      setMenuOpen(v => !v)
                    },
                  },
                  otherRunning ? h('span', { className: 'dshwt-hdr-dot', title: t('header.actions.running') }) : null,
                  h(ChevronIcon, { dir: menuOpen ? 'up' : 'down', size: 10 }))))
              : null,
          menuPortal)
      }
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
      return extractSummaryCwd(sessionSummaryOf(ctx, sessionId))
    }

    function SessionMenuRows(ctx) {
      return function MenuRow(props) {
        const { t } = useLocale()
        const [sent, setSent] = useState(null)
        const [worktreeState, setWorktreeState] = useState(() => {
          const cwd = props.cwd ?? sessionCwdOf(ctx, props.sessionId ?? props.id)
          return typeof cwd === 'string' && cwd.includes('/.agents/worktrees/') ? 'active' : 'none'
        })
        const [activeWorktree, setActiveWorktree] = useState(() => {
          const cwd = props.cwd ?? sessionCwdOf(ctx, props.sessionId ?? props.id)
          return typeof cwd === 'string' && cwd.includes('/.agents/worktrees/') ? { id: cwd, branch: null } : null
        })
        const [archivedId, setArchivedId] = useState(null)
        const [envTick, setEnvTick] = useState(0)
        const menuState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
        const sessionId = props.sessionId ?? props.id
        useEffect(() => {
          const bump = () => setEnvTick(n => n + 1)
          CLIENT_STATE.envListeners.add(bump)
          return () => { CLIENT_STATE.envListeners.delete(bump) }
        }, [])
        useEffect(() => {
          if (typeof sessionId !== 'string') return
          let cancelled = false
          void api('/worktrees').then((value) => {
            if (cancelled) return
            const cwd = sessionCwdOf(ctx, sessionId)
            const items = value?.items ?? []
            const activeMatch = items.find(item =>
              item.status === 'active' && (
                (item.sessions ?? []).some(s => s.sessionId === sessionId)
                || (typeof cwd === 'string' && (cwd === item.path || cwd.startsWith(`${item.path}/`)))
              ),
            )
            if (activeMatch) {
              setWorktreeState('active')
              setActiveWorktree({ id: activeMatch.id, branch: activeMatch.branch })
              setArchivedId(null)
              return
            }
            const archivedMatch = items.find(item =>
              item.status === 'archived' && (
                item.createdSessionId === sessionId
                || (typeof cwd === 'string' && (cwd === item.path || cwd.startsWith(`${item.path}/`)))
              ),
            )
            if (archivedMatch) {
              setWorktreeState('archived')
              setActiveWorktree(null)
              setArchivedId(archivedMatch.id)
              return
            }
            const isFallbackWt = typeof cwd === 'string' && cwd.includes('/.agents/worktrees/')
            setWorktreeState(isFallbackWt ? 'active' : 'none')
            setActiveWorktree(isFallbackWt ? { id: cwd, branch: null } : null)
            setArchivedId(null)
          }).catch(() => {})
          return () => { cancelled = true }
        }, [sessionId, envTick])
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
        const openApply = () => {
          const target = activeWorktree ?? (() => {
            const cwd = props.cwd ?? sessionCwdOf(ctx, sessionId)
            return typeof cwd === 'string' && cwd.length > 0 ? { id: cwd, branch: null } : null
          })()
          if (target !== null) {
            close()
            openApplyModal(target)
            return
          }
          send('/worktree apply-patch', t('menu.sending'))
        }
        const restoreArchived = () => {
          if (typeof archivedId !== 'string') return
          void api(`/worktrees/${enc(archivedId)}/restore`, { method: 'POST', body: JSON.stringify({}) }).then(
            () => { notifyEnvChanged(); close() },
            () => setSent(t('menu.sendFailed')),
          )
        }
        const rows = []
        if (worktreeState === 'none') {
          rows.push({ key: 'handoff', label: t('menu.handoff'), onClick: () => send('/worktree handoff', t('menu.sending')) })
        } else if (worktreeState === 'active') {
          rows.push({ key: 'apply', label: t('menu.apply'), onClick: openApply })
        } else if (worktreeState === 'archived' && archivedId !== null) {
          rows.push({ key: 'restore', label: t('menu.restore'), onClick: restoreArchived })
        }
        return h(React.Fragment, null,
          rows.map(row => h('button', {
            key: row.key, className: 'dshwt-menuitem', type: 'button', role: 'menuitem',
            onClick: row.onClick,
          }, row.key === 'restore' ? h(RestoreIcon, { size: 14 }) : h(BranchIcon, { size: 14 }), row.label)),
          sent !== null ? h('div', { style: { padding: '4px 10px', fontSize: 12, color: 'var(--dsw-alias-label-caption, gray)' } }, sent) : null)
      }
    }

    /** ---- locale & shared log state plumbing ---- */
    const CLIENT_STATE = {
      dicts: DICTS,
      ctx: null,
      ctxLocale: null,
      boundTranslate: null,
      listeners: new Set(),
      envListeners: new Set(),
      drawer: { op: null, open: false, minimized: false },
      drawerListeners: new Set(),
      applyModal: null,
      applyModalListeners: new Set(),
      sessionLogs: new Map(),
      rightLogTabRegistered: false,
      nativeTerminals: new Map(),
      terminalListeners: new Set(),
    }

    function notifyNativeTerminalsChanged() {
      for (const listener of [...CLIENT_STATE.terminalListeners]) {
        try { listener() } catch { /* ignore */ }
      }
    }

    function isTerminalEntryAlive(sidebarRight, sessionId, entry) {
      if (!sidebarRight || typeof sidebarRight.tabsIn !== 'function') return false
      const tabs = sidebarRight.tabsIn(sessionId) ?? []
      const stillOpen = tabs.some(tab => tab.id === entry.tabId && tab.kind === 'terminal')
      if (!stillOpen) return false
      const st = entry.view?.state?.getSnapshot?.()
      if (st) {
        if (st.phase === 'closed' || st.phase === 'failed') return false
        if (st.info?.state === 'exited' || st.info?.state === 'failed') return false
      }
      return true
    }

    function reconcileNativeTerminals(ctx) {
      const sidebarRight = ctx?.get?.('sidebarRight')
      let changed = false
      for (const [sid, actionMap] of [...CLIENT_STATE.nativeTerminals.entries()]) {
        for (const [actionName, entries] of [...actionMap.entries()]) {
          const alive = []
          for (const entry of entries) {
            if (isTerminalEntryAlive(sidebarRight, sid, entry)) {
              alive.push(entry)
            } else {
              try { entry.unsub?.() } catch { /* ignore */ }
              changed = true
            }
          }
          if (alive.length === 0) actionMap.delete(actionName)
          else if (alive.length !== entries.length) actionMap.set(actionName, alive)
        }
        if (actionMap.size === 0) CLIENT_STATE.nativeTerminals.delete(sid)
      }
      if (changed) notifyNativeTerminalsChanged()
    }

    function trackNativeTerminal(ctx, sessionId, actionName, tabId, contentId, termView) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (typeof actionName !== 'string' || actionName.length === 0) return
      let actionMap = CLIENT_STATE.nativeTerminals.get(sessionId)
      if (!actionMap) {
        actionMap = new Map()
        CLIENT_STATE.nativeTerminals.set(sessionId, actionMap)
      }
      const list = actionMap.get(actionName) ?? []
      const unsub = termView?.state?.subscribe?.(() => reconcileNativeTerminals(ctx))
      list.push({ tabId, contentId, view: termView, unsub })
      actionMap.set(actionName, list)
      notifyNativeTerminalsChanged()
    }

    function focusNativeTerminal(ctx, sessionId, actionName) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      if (typeof actionName !== 'string' || actionName.length === 0) return false
      reconcileNativeTerminals(ctx)
      const entries = CLIENT_STATE.nativeTerminals.get(sessionId)?.get(actionName)
      if (!entries || entries.length === 0) return false
      const entry = entries[entries.length - 1]
      const sidebarRight = ctx?.get?.('sidebarRight')
      if (!isTerminalEntryAlive(sidebarRight, sessionId, entry)) {
        reconcileNativeTerminals(ctx)
        return false
      }
      try {
        if (typeof sidebarRight.isExpanded === 'function' && !sidebarRight.isExpanded()) {
          sidebarRight.toggleExpanded?.()
        }
        if (typeof sidebarRight.focusIn === 'function') {
          sidebarRight.focusIn(sessionId, entry.tabId)
          return true
        }
        if (typeof sidebarRight.focus === 'function') {
          sidebarRight.focus(entry.tabId)
          return true
        }
      } catch {
        return false
      }
      return false
    }

    function clearAllNativeTerminals() {
      for (const actionMap of CLIENT_STATE.nativeTerminals.values()) {
        for (const entries of actionMap.values()) {
          for (const entry of entries) {
            try { entry.unsub?.() } catch { /* ignore */ }
          }
        }
      }
      CLIENT_STATE.nativeTerminals.clear()
      notifyNativeTerminalsChanged()
    }

    function snapshotNativeTerminals(ctx, sessionId) {
      const map = new Map()
      if (typeof sessionId !== 'string' || sessionId.length === 0) return map
      const actionMap = CLIENT_STATE.nativeTerminals.get(sessionId)
      if (!actionMap || actionMap.size === 0) return map
      const sidebarRight = ctx?.get?.('sidebarRight')
      for (const [actionName, entries] of actionMap.entries()) {
        const alive = entries.filter(entry => isTerminalEntryAlive(sidebarRight, sessionId, entry))
        if (alive.length > 0) map.set(actionName, alive)
      }
      return map
    }

    function useNativeTerminalActions(ctx, sessionId) {
      const [running, setRunning] = useState(() => snapshotNativeTerminals(ctx, sessionId))
      useEffect(() => {
        setRunning(snapshotNativeTerminals(ctx, sessionId))
        const onUpdate = () => setRunning(snapshotNativeTerminals(ctx, sessionId))
        CLIENT_STATE.terminalListeners.add(onUpdate)
        return () => { CLIENT_STATE.terminalListeners.delete(onUpdate) }
      }, [ctx, sessionId])
      return running
    }

    function notifyEnvChanged() {
      for (const listener of [...CLIENT_STATE.envListeners]) {
        try { listener() } catch { /* ignore */ }
      }
    }

    function notifyDrawerChanged() {
      const snap = { ...CLIENT_STATE.drawer }
      for (const listener of [...CLIENT_STATE.drawerListeners]) {
        try { listener(snap) } catch { /* ignore */ }
      }
    }

    function readSessionLogs(sessionId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : GLOBAL_SESSION_KEY
      const bucket = CLIENT_STATE.sessionLogs.get(key)
      return bucket ? { ops: [...bucket.ops], activeId: bucket.activeId } : { ops: [], activeId: null }
    }

    function recordSessionOp(sessionId, op) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : GLOBAL_SESSION_KEY
      const prev = CLIENT_STATE.sessionLogs.get(key) ?? { ops: [], activeId: null }
      const filtered = prev.ops.filter(item => item.id !== op.id)
      const ops = [op, ...filtered].slice(0, 10)
      CLIENT_STATE.sessionLogs.set(key, { ops, activeId: op.id })
      notifyDrawerChanged()
    }

    function selectSessionOp(sessionId, opId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : GLOBAL_SESSION_KEY
      const prev = CLIENT_STATE.sessionLogs.get(key)
      if (!prev) return
      CLIENT_STATE.sessionLogs.set(key, { ops: prev.ops, activeId: opId })
      notifyDrawerChanged()
    }

    function useSessionLogs(sessionId) {
      const [bucket, setBucket] = useState(() => readSessionLogs(sessionId))
      useEffect(() => {
        setBucket(readSessionLogs(sessionId))
        const onUpdate = () => setBucket(readSessionLogs(sessionId))
        CLIENT_STATE.drawerListeners.add(onUpdate)
        return () => { CLIENT_STATE.drawerListeners.delete(onUpdate) }
      }, [sessionId])
      return bucket
    }

    function openActionLog(ctx, sessionId, op) {
      recordSessionOp(sessionId, op)
      const sidebarRight = ctx?.get?.('sidebarRight')
      if (CLIENT_STATE.rightLogTabRegistered && typeof sidebarRight?.openTab === 'function') {
        try {
          sidebarRight.openTab(LOG_TAB_KIND)
          // Ensure fallback floating drawer stays closed when docked inside the right sidebar
          if (CLIENT_STATE.drawer.open) closeLogDrawer()
          return
        } catch {
          // fall through to overlay fallback when sidebarRight cannot open for this surface
        }
      }
      openLogDrawer(op)
    }

    function openLogDrawer(op) {
      CLIENT_STATE.drawer = { op, open: true, minimized: false }
      notifyDrawerChanged()
    }

    function closeLogDrawer() {
      CLIENT_STATE.drawer = { ...CLIENT_STATE.drawer, open: false, minimized: false }
      notifyDrawerChanged()
    }

    function toggleMinimizeLogDrawer() {
      CLIENT_STATE.drawer = { ...CLIENT_STATE.drawer, minimized: !CLIENT_STATE.drawer.minimized }
      notifyDrawerChanged()
    }

    function useLogDrawerState() {
      const [state, setState] = useState(() => ({ ...CLIENT_STATE.drawer }))
      useEffect(() => {
        setState({ ...CLIENT_STATE.drawer })
        CLIENT_STATE.drawerListeners.add(setState)
        return () => { CLIENT_STATE.drawerListeners.delete(setState) }
      }, [])
      return state
    }

    function openApplyModal(target) {
      CLIENT_STATE.applyModal = target ? { id: target.id, branch: target.branch ?? null } : null
      for (const listener of [...CLIENT_STATE.applyModalListeners]) {
        try { listener(CLIENT_STATE.applyModal) } catch { /* ignore */ }
      }
    }

    function closeApplyModal() {
      openApplyModal(null)
    }

    function useApplyModalState() {
      const [state, setState] = useState(() => CLIENT_STATE.applyModal)
      useEffect(() => {
        setState(CLIENT_STATE.applyModal)
        CLIENT_STATE.applyModalListeners.add(setState)
        return () => { CLIENT_STATE.applyModalListeners.delete(setState) }
      }, [])
      return state
    }

    function normalizeLang(tag) {
      if (typeof tag !== 'string' || tag.trim().length === 0) return null
      const lower = tag.trim().toLowerCase()
      if (CLIENT_STATE.dicts[lower] !== undefined) return lower
      const primary = lower.split('-')[0]
      if (CLIENT_STATE.dicts[primary] !== undefined) return primary
      return null
    }

    function detectBrowserLang() {
      if (typeof document !== 'undefined') {
        const docLang = normalizeLang(document.documentElement?.lang)
        if (docLang !== null) return docLang
      }
      if (typeof navigator !== 'undefined') {
        const candidates = [
          ...(Array.isArray(navigator.languages) ? navigator.languages : []),
          navigator.language,
        ]
        for (const tag of candidates) {
          const matched = normalizeLang(tag)
          if (matched !== null) return matched
        }
      }
      return 'en'
    }

    function readLocaleState() {
      const snap = CLIENT_STATE.ctxLocale?.getSnapshot?.() ?? CLIENT_STATE.ctxLocale?.getLocale?.()
      if (snap && typeof snap.active === 'string' && snap.active.length > 0) {
        return { active: snap.active, revision: typeof snap.revision === 'number' ? snap.revision : 0 }
      }
      return { active: detectBrowserLang(), revision: 0 }
    }

    function formatTemplate(template, params) {
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function translateKey(key, params) {
      if (typeof CLIENT_STATE.boundTranslate === 'function') {
        const value = CLIENT_STATE.boundTranslate(key, params)
        if (typeof value === 'string' && value !== key) return value
      }
      const lang = normalizeLang(readLocaleState().active) ?? 'en'
      const dict = CLIENT_STATE.dicts[lang] ?? CLIENT_STATE.dicts.en ?? {}
      const template = dict[key] ?? CLIENT_STATE.dicts.en?.[key] ?? key
      return formatTemplate(template, params)
    }

    function notifyLocaleListeners() {
      const next = readLocaleState()
      for (const listener of [...CLIENT_STATE.listeners]) {
        try { listener(next) } catch { /* ignore */ }
      }
    }

    function useLocale() {
      const [state, setState] = useState(readLocaleState)
      useEffect(() => {
        setState(readLocaleState())
        CLIENT_STATE.listeners.add(setState)
        const onLangChange = () => setState(readLocaleState())
        if (typeof window !== 'undefined') window.addEventListener('languagechange', onLangChange)
        return () => {
          CLIENT_STATE.listeners.delete(setState)
          if (typeof window !== 'undefined') window.removeEventListener('languagechange', onLangChange)
        }
      }, [])
      const t = useCallback((key, params) => translateKey(key, params), [state.active, state.revision])
      return { lang: normalizeLang(state.active) ?? 'en', active: state.active, t }
    }

    function registerDictionaries(ctx) {
      const locale = ctx.get?.('locale') ?? ctx.locale
      if (locale === undefined) return () => {}
      const dispose = []
      let registered = false
      try {
        const d = locale.register(NS, CLIENT_STATE.dicts)
        if (typeof d === 'function') dispose.push(d)
        registered = true
      } catch {
        // fallback for single-locale register(ns, id, dict) signatures
      }
      if (!registered) {
        for (const [id, dict] of Object.entries(CLIENT_STATE.dicts)) {
          try {
            const d = locale.register(NS, id, dict)
            if (typeof d === 'function') dispose.push(d)
          } catch {
            // keep fallback dictionaries
          }
        }
      }
      CLIENT_STATE.ctxLocale = locale
      CLIENT_STATE.boundTranslate = typeof locale.bind === 'function' ? locale.bind(NS) : null
      if (typeof locale.subscribe === 'function') {
        const unsub = locale.subscribe(() => notifyLocaleListeners())
        if (typeof unsub === 'function') dispose.push(unsub)
      }
      if (typeof ctx.on === 'function') {
        const off = ctx.on('locale/change', () => notifyLocaleListeners())
        if (typeof off === 'function') dispose.push(off)
      }
      notifyLocaleListeners()
      return () => {
        for (const d of dispose) {
          try { d() } catch { /* ignore */ }
        }
        if (CLIENT_STATE.ctxLocale === locale) {
          CLIENT_STATE.ctxLocale = null
          CLIENT_STATE.boundTranslate = null
        }
      }
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

    /** ---- plugin entry ---- */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        CLIENT_STATE.ctx = ctx
        const disposeStyles = ctx.effect(() => mountStyles(), 'dsh-worktree-env: styles')
        const disposeDictionaries = registerDictionaries(ctx)
        const disposers = [() => { if (CLIENT_STATE.ctx === ctx) CLIENT_STATE.ctx = null }, disposeStyles, disposeDictionaries]

        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'dsh-worktree-env', order: 25, locale: NS,
          label: () => translateKey('panel.title'),
        }, function PanelIconButton(props) {
          return h(BranchIcon, { size: props?.size ?? 18 })
        })), 'dsh-worktree-env: panel icon'))

        disposers.push(ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'dsh-worktree-env', locale: NS,
          label: () => translateKey('panel.title'),
        }, WorktreePanel)), 'dsh-worktree-env: main panel'))

        disposers.push(ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-worktree-env-actions',
          order: -9,
          locale: NS,
        }, SessionHeaderActions(ctx))), 'dsh-worktree-env: header actions'))

        // On-demand right-sidebar log tab: omits `guide` so it stays off the sidebar launcher
        // and only opens when the user runs an action (or views logs) from the top bar.
        const mountRightLogTab = (scope) => {
          const tabs = scope.get?.('sidebarRightTabs') ?? scope.sidebarRightTabs
          if (tabs === undefined || typeof tabs.register !== 'function') return () => {}
          const disposeTab = tabs.register({
            id: LOG_TAB_ID,
            kind: LOG_TAB_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => translateKey('logs.title'),
          })
          const disposePane = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: LOG_TAB_ID,
            locale: NS,
          }, ActionLogPane(ctx)))
          const disposeTitle = scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: LOG_TAB_ID,
            locale: NS,
          }, ActionLogTabTitle))
          CLIENT_STATE.rightLogTabRegistered = true
          return () => {
            CLIENT_STATE.rightLogTabRegistered = false
            disposeTitle()
            disposePane()
            disposeTab()
          }
        }
        if (typeof ctx.inject === 'function') {
          const scope = ctx.inject(['sidebarRightTabs'], (child) => {
            child.effect(() => mountRightLogTab(child), 'dsh-worktree-env: right log tab')
          })
          if (typeof scope?.dispose === 'function') disposers.push(() => scope.dispose())
        } else {
          disposers.push(ctx.effect(() => mountRightLogTab(ctx), 'dsh-worktree-env: right log tab'))
        }

        const watchSidebarTerminals = (scope) => {
          const sidebarRight = scope.get?.('sidebarRight') ?? scope.sidebarRight
          const unsub = sidebarRight?.openTabs?.subscribe?.(() => reconcileNativeTerminals(ctx))
          return () => {
            try { unsub?.() } catch { /* ignore */ }
          }
        }
        if (typeof ctx.inject === 'function') {
          const scope = ctx.inject(['sidebarRight'], (child) => {
            child.effect(() => watchSidebarTerminals(child), 'dsh-worktree-env: terminal tabs')
          })
          if (typeof scope?.dispose === 'function') disposers.push(() => scope.dispose())
        } else {
          disposers.push(ctx.effect(() => watchSidebarTerminals(ctx), 'dsh-worktree-env: terminal tabs'))
        }
        disposers.push(() => clearAllNativeTerminals())
        disposers.push(() => closeApplyModal())

        disposers.push(ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-worktree-env-logs',
          order: 60,
          locale: NS,
        }, LogDrawerOverlay)), 'dsh-worktree-env: log overlay'))

        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: 'dsh-worktree-env-menu', order: 350, locale: NS,
        }, SessionMenuRows(ctx))), 'dsh-worktree-env: session menu'))

        return () => { for (const dispose of disposers) dispose() }
      },
    }
  },
})
