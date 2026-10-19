// 消费验收传入的真实原生 RPC，只检查本轮空白实例的稳定对象选择；不启动模型或重放失败请求。
import assert from 'node:assert/strict'

/** 官方 proxy 的 exit 1 只可携带原生 error；其它非零退出不能借完整 JSON 冒充已完成响应。 */
export function readStableProxyReply(bytes, id, exitCode) {
  assert(exitCode === 0 || exitCode === 1, 'stable_native_proxy_failed')
  const response = JSON.parse(bytes.toString('utf8'))
  assert.equal(response.id, id)
  assert(exitCode === 0 || response.error, 'stable_native_proxy_failed')
  return response
}

/** 稳定 ID 选择不附加可选全局 CAS；旧 revision 另作一次明确负例，不更新并重发失败变更。 */
export async function verifyStableLuvusSelection(rpc, paths) {
  const checks = []
  let nativeRpc = 0
  /** 原生错误仍交给调用方逐项核验，不更新 revision 或再次发送。 */
  async function frame(method, params = {}) {
    nativeRpc++
    return rpc(method, params)
  }
  /** 仅成功原生结果可继续发现对象，不将错误或终端文本当成成功。 */
  async function result(method, params = {}) {
    const response = await frame(method, params)
    assert.equal(response.error, undefined)
    return response.result
  }
  let listed = await result('workspace.list')
  if (!listed.workspaces.length) {
    await result('workspace.open', { path: paths.project })
  }
  const before = (await result('workspace.list')).workspaces[0]
  await result('workspace.open', { path: paths.projectA })
  listed = await result('workspace.list')
  const a = listed.workspaces.find(
    /** 只选本轮刚打开的确切路径，随后立即固定原生 ID。 */ (row) => row.cwd === paths.projectA
  )
  assert(a)
  checks.push('workspace_discovered_with_stable_id')
  const workspaceIndex = a.workspace
  const staleWorkspaceRevision = listed.revision
  await result('workspace.close', { workspace_id: before.workspace_id })
  let current = await result('workspace.get', { workspace_id: a.workspace_id })
  assert.notEqual(current.workspace, workspaceIndex)
  assert(current.revision > staleWorkspaceRevision)
  checks.push('workspace_position_moves_but_id_remains')
  const workspaceConflict = await frame('workspace.rename', {
    workspace_id: a.workspace_id,
    name: 'stale',
    if_revision: staleWorkspaceRevision
  })
  assert.equal(workspaceConflict.error?.code, 'revision_conflict')
  assert.equal(workspaceConflict.error.expected, staleWorkspaceRevision)
  assert(workspaceConflict.error.actual >= current.revision)
  checks.push('workspace_stale_revision_is_native_conflict')
  const afterWorkspaceConflict = await result('workspace.get', { workspace_id: a.workspace_id })
  assert.equal(afterWorkspaceConflict.workspace_id, a.workspace_id)
  assert.equal(afterWorkspaceConflict.name, current.name)
  checks.push('workspace_stale_revision_does_not_mutate_selected_id')
  await result('workspace.rename', { workspace_id: a.workspace_id, name: 'stable A' })
  current = await result('workspace.get', { workspace_id: a.workspace_id })
  assert.equal(current.name, 'stable A')
  checks.push('workspace_rename_keeps_selected_id')
  await result('workspace.focus', { workspace_id: a.workspace_id })
  const tabs = await result('tab.list')
  const preceding = tabs.tabs[0]
  assert(preceding)
  await result('tab.new')
  let selected = await result('tab.get')
  assert.equal(selected.workspace_id, a.workspace_id)
  const tabA = selected.tab_id
  const tabIndex = selected.tab
  await result('tab.new')
  let tabB = await result('tab.get')
  assert.equal(tabB.workspace_id, a.workspace_id)
  const tabBId = tabB.tab_id
  const staleTabRevision = tabB.revision
  await result('tab.close', { tab_id: preceding.tab_id })
  selected = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  assert.notEqual(selected.tab, tabIndex)
  assert(selected.revision > staleTabRevision)
  checks.push('tab_position_moves_but_id_remains')
  const tabConflict = await frame('tab.rename', { tab_id: tabA, name: 'stale', if_revision: staleTabRevision })
  assert.equal(tabConflict.error?.code, 'revision_conflict')
  assert.equal(tabConflict.error.expected, staleTabRevision)
  assert(tabConflict.error.actual >= selected.revision)
  checks.push('tab_stale_revision_is_native_conflict')
  const afterTabConflict = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  assert.equal(afterTabConflict.tab_id, tabA)
  assert.equal(afterTabConflict.name, selected.name)
  checks.push('tab_stale_revision_does_not_mutate_selected_id')
  await result('tab.rename', { tab_id: tabA, name: 'stable tab A' })
  selected = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  assert.equal(selected.name, 'stable tab A')
  checks.push('tab_rename_keeps_selected_id')
  await result('workspace.open', { path: paths.projectC, focus: true })
  const c = await result('workspace.get')
  const cTab = await result('tab.get')
  selected = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  assert.equal(selected.tab_id, tabA)
  assert.equal(selected.workspace_id, a.workspace_id)
  checks.push('tab_get_selects_other_workspace_by_id')
  assert.equal((await frame('tab.rename', { tab_id: tabA, name: 'wrong workspace' })).error?.code, 'not_found')
  checks.push('foreign_tab_rename_is_native_not_found')
  const cCurrent = await result('tab.get', { workspace_id: c.workspace_id, tab_id: cTab.tab_id })
  assert.equal(cCurrent.name, cTab.name)
  checks.push('foreign_tab_rename_preserves_current_tab')
  assert.equal((await frame('tab.close', { tab_id: tabA })).error?.code, 'not_found')
  checks.push('foreign_tab_close_is_native_not_found')
  const stillCurrent = await result('tab.get')
  assert.equal(stillCurrent.workspace_id, c.workspace_id)
  assert.equal(stillCurrent.tab_id, cTab.tab_id)
  assert.equal(stillCurrent.name, cTab.name)
  checks.push('foreign_tab_writes_do_not_focus_or_change_current_tab')
  const stillA = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  assert.equal(stillA.tab_id, tabA)
  assert.equal(stillA.name, 'stable tab A')
  checks.push('foreign_tab_writes_do_not_change_selected_other_tab')
  const snapshot = await result('session.snapshot')
  listed = await result('workspace.list')
  const observedSequence = { snapshot: snapshot.event_sequence, list: listed.revision }
  assert(listed.revision >= snapshot.event_sequence)
  assert.equal(snapshot.workspaces.length, listed.workspaces.length)
  checks.push('snapshot_and_list_have_monotonic_session_sequence')
  for (let i = 0; i < snapshot.workspaces.length; i++) {
    const workspace = snapshot.workspaces[i]
    assert.equal(workspace.index, i + 1)
    assert.equal(typeof workspace.index, 'number')
    assert.equal(listed.workspaces[i].workspace, String(i))
    assert.equal(typeof listed.workspaces[i].workspace, 'string')
    assert.equal(listed.workspaces[i].cwd, workspace.cwd)
    checks.push('snapshot_workspace_number_1_based_vs_list_string_0_based')
    for (let j = 0; j < workspace.tabs.length; j++) {
      assert.equal(workspace.tabs[j].index, j + 1)
      assert.equal(typeof workspace.tabs[j].index, 'number')
      checks.push('snapshot_tab_number_1_based')
    }
  }
  const snapshotA = snapshot.workspaces.find(
    /** 只在同次 snapshot 中找到本轮明确路径。 */ (row) => row.cwd === paths.projectA
  )
  assert(snapshotA)
  const observedPane = snapshotA.tabs
    .flatMap(/** 展开实际返回 pane，不把 snapshot tab index 当稳定 ID。 */ (tab) => tab.panes)
    .find(/** view 的 pane_id 是占位符，只允许真实 terminal pane 进入 pane.get。 */ (pane) => pane.kind === 'terminal')
  assert(observedPane)
  assert.equal(typeof observedPane.pane_id, 'string')
  const pane = await result('pane.get', { pane: observedPane.pane_id })
  assert.equal(pane.workspace_id, a.workspace_id)
  assert.equal(typeof pane.workspace, 'string')
  assert.equal(typeof pane.tab, 'string')
  assert.match(pane.tab, /^[1-9][0-9]*$/)
  checks.push('snapshot_terminal_pane_resolves_stable_ids')
  const stableTab = await result('tab.get', { workspace_id: pane.workspace_id, tab_id: pane.tab_id })
  assert.equal(stableTab.workspace_id, a.workspace_id)
  assert.equal(stableTab.tab_id, pane.tab_id)
  checks.push('snapshot_terminal_tab_uses_stable_id')
  await result('workspace.rename', {
    workspace_id: pane.workspace_id,
    name: 'snapshot selected A'
  })
  current = await result('workspace.get', { workspace_id: a.workspace_id })
  assert.equal(current.name, 'snapshot selected A')
  checks.push('snapshot_selected_workspace_rename_keeps_id')
  await result('workspace.focus', { workspace_id: a.workspace_id })
  selected = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })
  await result('tab.close', { tab_id: tabA })
  assert.equal((await frame('tab.get', { workspace_id: a.workspace_id, tab_id: tabA })).error?.code, 'not_found')
  checks.push('only_selected_tab_was_closed')
  tabB = await result('tab.get', { workspace_id: a.workspace_id, tab_id: tabBId })
  assert.equal(tabB.tab_id, tabBId)
  checks.push('other_tab_still_exists')
  current = await result('workspace.get', { workspace_id: c.workspace_id })
  await result('workspace.focus', { workspace_id: c.workspace_id })
  current = await result('workspace.get', { workspace_id: a.workspace_id })
  await result('workspace.close', { workspace_id: a.workspace_id })
  listed = await result('workspace.list')
  assert.equal(
    listed.workspaces.some(/** 已关闭的确切 ID 不能再出现。 */ (row) => row.workspace_id === a.workspace_id),
    false
  )
  assert.equal(
    listed.workspaces.some(/** 另一个确切 workspace 仍存在。 */ (row) => row.workspace_id === c.workspace_id),
    true
  )
  checks.push('only_selected_workspace_was_closed')
  return Object.freeze({
    checks,
    native_rpc: nativeRpc,
    observed_sequence: observedSequence,
    stale_cas: [
      { object: 'workspace_A', expected: workspaceConflict.error.expected, actual: workspaceConflict.error.actual },
      { object: 'tab_A', expected: tabConflict.error.expected, actual: tabConflict.error.actual }
    ],
    model_requests: 0,
    tokens_issued: 0
  })
}
