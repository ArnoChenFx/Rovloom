/** Herdr 窗口、pane 与 Agent 工作流的方法分类和原生成功类型；完整参数仍由安装 schema 校验。 */

/** 固定官方 0.9.5 分派的成功 result.type；数组保留原生方法具有多个成功形态的接口。 */
export const HERDR_RESPONSE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ping: Object.freeze(['pong']),
  'session.snapshot': Object.freeze(['session_snapshot']),
  'workspace.create': Object.freeze(['workspace_created']),
  'workspace.list': Object.freeze(['workspace_list']),
  'workspace.get': Object.freeze(['workspace_info']),
  'workspace.focus': Object.freeze(['workspace_info']),
  'workspace.rename': Object.freeze(['workspace_info']),
  'workspace.move': Object.freeze(['workspace_list']),
  'workspace.move_block': Object.freeze(['workspace_list']),
  'workspace.report_metadata': Object.freeze(['ok']),
  'workspace.close': Object.freeze(['ok']),
  'tab.create': Object.freeze(['tab_created']),
  'tab.list': Object.freeze(['tab_list']),
  'tab.get': Object.freeze(['tab_info']),
  'tab.focus': Object.freeze(['tab_info']),
  'tab.rename': Object.freeze(['tab_info']),
  'tab.move': Object.freeze(['tab_list']),
  'tab.close': Object.freeze(['ok']),
  'agent.list': Object.freeze(['agent_list']),
  'agent.get': Object.freeze(['agent_info']),
  'agent.read': Object.freeze(['pane_read']),
  'agent.explain': Object.freeze(['agent_explain']),
  'agent.send_keys': Object.freeze(['ok']),
  'agent.rename': Object.freeze(['agent_info']),
  'agent.view.set': Object.freeze(['agent_view']),
  'agent.view.clear': Object.freeze(['agent_view']),
  'agent.focus': Object.freeze(['agent_info']),
  'agent.start': Object.freeze(['agent_started']),
  'agent.prompt': Object.freeze(['agent_prompted']),
  'agent.wait': Object.freeze(['agent_info']),
  'pane.split': Object.freeze(['pane_info']),
  'pane.swap': Object.freeze(['pane_swap']),
  'pane.move': Object.freeze(['pane_move']),
  'pane.zoom': Object.freeze(['pane_zoom']),
  'pane.layout': Object.freeze(['pane_layout']),
  'pane.process_info': Object.freeze(['pane_process_info']),
  'pane.neighbor': Object.freeze(['pane_neighbor']),
  'pane.edges': Object.freeze(['pane_edges']),
  'pane.focus_direction': Object.freeze(['pane_focus_direction']),
  'pane.resize': Object.freeze(['pane_resize']),
  'pane.scroll': Object.freeze(['pane_info']),
  'pane.clear': Object.freeze(['ok']),
  'pane.edit_scrollback': Object.freeze(['ok']),
  'pane.selection.read': Object.freeze(['pane_selection']),
  'pane.copy_motion': Object.freeze(['pane_copy_motion']),
  'pane.copy_search': Object.freeze(['pane_copy_search']),
  'pane.list': Object.freeze(['pane_list']),
  'pane.current': Object.freeze(['pane_current']),
  'pane.get': Object.freeze(['pane_info']),
  'pane.focus': Object.freeze(['pane_info']),
  'pane.input.set': Object.freeze(['ok']),
  'pane.link.activate': Object.freeze(['pane_link_activated']),
  'pane.link.resolve': Object.freeze(['pane_link_resolved']),
  'pane.rename': Object.freeze(['pane_info']),
  'pane.send_text': Object.freeze(['ok']),
  'pane.send_keys': Object.freeze(['ok']),
  'pane.send_input': Object.freeze(['ok']),
  'pane.read': Object.freeze(['pane_read']),
  'pane.report_agent': Object.freeze(['ok']),
  'pane.report_agent_session': Object.freeze(['ok']),
  'pane.report_metadata': Object.freeze(['ok']),
  'pane.clear_agent_authority': Object.freeze(['ok']),
  'pane.release_agent': Object.freeze(['ok']),
  'pane.close': Object.freeze(['ok']),
  'pane.wait_for_output': Object.freeze(['output_matched'])
})

export const HERDR_WORKFLOW_METHODS = Object.freeze(Object.keys(HERDR_RESPONSE_TYPES))

/** Store 仅识别完整方法与参数记录；不在此复制或收窄官方参数规则。 */
export function reviewedHerdrRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    Object.keys(request).length === 2 &&
    Object.hasOwn(request, 'method') &&
    Object.hasOwn(request, 'params') &&
    typeof request.method === 'string' &&
    Object.hasOwn(HERDR_RESPONSE_TYPES, request.method) &&
    request.params !== null &&
    typeof request.params === 'object' &&
    !Array.isArray(request.params)
  )
}

/** 只约束对应方法的原生成功类型，不推断修改应用、Agent 就绪或本轮对话完成。 */
export function herdrResponseRule(method: string): readonly string[] | undefined {
  return Object.hasOwn(HERDR_RESPONSE_TYPES, method) ? HERDR_RESPONSE_TYPES[method] : undefined
}
