import { appActionDisplay } from './app-action-display'

/**
 * The words of the small line above a step's name in its settings panel (#2765;
 * settled in docs/design/app-action-panel-heading.html). An App Action step reads
 * its service and action as its card names them ("Gmail, Send an email"), the
 * service alone while no action is chosen, and App action with no service, so the
 * panel never names a step differently from its card. Every other step keeps its
 * type word, as it always has. The line's own style draws it in capitals.
 */
export function panelHeadingOf(type: string, config: Record<string, unknown>): string {
  if (type !== 'app_action') return type
  const { service, action } = appActionDisplay(config)
  return action === null ? service : `${service}, ${action}`
}
