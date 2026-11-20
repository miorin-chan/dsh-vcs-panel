/**
 * Browser half of `dsh-vcs-panel`.
 *
 * Registers the version control page in the right Sidebar: its tab type, guide
 * card, localized chip, and body, plus the per-turn entry in
 * `conversation.chat.turnTail`, the eight UI dictionaries, one stylesheet, the
 * Session fold that decides whether a Turn changed files, and the
 * application-wide shortcut. Reads and writes go through the authenticated
 * `/api/vcs.*` routes; writes only happen from explicit header, branch,
 * remote-branch, tag, or commit actions.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: the browser half declares the `connection/reset`
// event this entry subscribes to through `ctx.on`.
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SidebarRightTabDefinition, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SlotComponent, Translate } from '@deepseek-ai/dsh-client-ui-slots'

import shellStyles from './styles.css'
import diffStyles from './diff/FileDiff.css'
import graphStyles from './history/graph.css'
import { DICTIONARIES } from './locales.js'
import { SHORTCUT_DEFAULTS, SHORTCUT_ID, mainSessionId } from './shortcuts.js'
import type { SessionListSnapshot } from './shortcuts.js'
import { createTurnChangesDefinition, turnChangedFiles, turnChanges } from './turn.js'
import type { TrackedTurn } from './turn.js'
import { createTurnSummaryStore } from './turn-summary.js'
import { GitBranchIcon, TurnTailChanges } from './TurnTail.jsx'
import { VcsView } from './VcsView.jsx'
import { ViewErrorBoundary } from './ViewErrorBoundary.jsx'

/** Locale namespace owned by this plugin. */
const NS = 'vcs'

/**
 * Right-Sidebar identity: the type's id (also the key its body and title
 * register under), the kind pages open by, and the guide card that offers it.
 */
const TAB_ID = 'dsh-vcs-panel'
const TAB_KIND = 'vcs'
const GUIDE_ID = 'vcs'
/** The Files card is 10 and Terminal is 20; sit directly between them. */
const GUIDE_ORDER = 15

/** Turn-tail entry identity and position (first, where the card used to be). */
const TURN_TAIL_ID = 'dsh-vcs-panel'
const TURN_TAIL_ORDER = -10

/**
 * The command identity as the registry's catalog key.
 *
 * `SHORTCUT_ID` is the plain string this plugin owns; DSH keys its command
 * catalog and guide entries by a nominally branded id, as its own registrations
 * brand theirs at the same boundary.
 */
const COMMAND_ID = SHORTCUT_ID as ShortcutCommandId

/** Required client services: slots, locale, the Conversation registries, and the right Sidebar. */
export const inject = ['slots', 'locale', 'uiConversation', 'sidebarRight', 'sidebarRightTabs']

/**
 * The renderer SlotRegistry face this entry registers through.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the `slots` service is
 * installed by the renderer package, which is not part of this plugin's
 * installed type set. The two Sidebar slots it contributes are declared by
 * `dsh-client-ui-sidebar-right`; the Turn-tail slot is owned by the chat
 * package and restated here.
 */
interface SlotRegistryFace {
  /**
   * Run one registration inside the slot's lifetime.
   * @param name - slot key.
   * @param register - the registration, returning its disposer.
   * @returns the occurrence's disposer.
   */
  inject(name: string, register: () => () => void): () => void
  /**
   * Contribute one component to a declared slot.
   * @param options - the slot key and its kind-specific fields.
   * @param component - the entry component.
   * @returns the registration's disposer.
   */
  register(options: SlotRegistration, component: SlotComponent<never>): () => void
}

/** The registration options of the three slots this entry contributes to. */
type SlotRegistration =
  | { readonly name: 'sidebar.right.pane.tab'; readonly key: string; readonly locale: string }
  | { readonly name: 'sidebar.right.pane.tab.title'; readonly key: string; readonly locale: string }
  | { readonly name: 'conversation.chat.turnTail'; readonly id: string; readonly order: number; readonly locale: string }

/**
 * The browser Session controller's live list face.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the `sessions` service
 * publishes the Session rows under `list.getSnapshot()`. The installed type
 * packages declare the Host `SessionStore` under that same name.
 */
interface ClientSessionList {
  readonly list?: {
    getSnapshot?(): SessionListSnapshot | undefined
  }
}

/** Props of the right-Sidebar tab body: Session identity, translator, and tab info hook. */
interface SidebarVcsViewProps {
  sessionId: string
  t: Translate
  useTabInfo: UseSidebarRightTabInfo
}

/**
 * Props of the Turn-tail entry.
 *
 * Internal shape, verified against DSH 0.2.2-rc.5: the chat package owns this
 * slot, so the entry receives the Turn Location, its Session identity, and the
 * registered translator.
 */
interface TurnTailEntryProps {
  turn: TrackedTurn
  sessionId: string
  t: Translate
}

/**
 * Register the application-wide panel shortcut on a scope that has the
 * `shortcuts` and `sessions` services.
 *
 * A press collapses the Sidebar back to the conversation while its VCS page is
 * showing, and otherwise opens or reveals the page. The controller acts on the
 * on-screen Session, so a retained background Session is left alone. The
 * command is application-wide for the receiving device: regions cover the page,
 * editors, and terminal, while modals are left to the host's policy. A default
 * rejected by a future DSH release falls back to an unbound command so the user
 * can still assign a key in Settings > Shortcuts.
 *
 * @param ctx - the Client root context.
 * @param scope - injected Client scope.
 * @param t - namespaced translate function.
 * @returns shortcut disposer.
 */
function registerPanelShortcut(ctx: Context, scope: Context, t: Translate): () => void {
  const sidebar = ctx.sidebarRight
  // The injected `sessions` service is the browser Session controller; its
  // live list face is not part of this plugin's installed type set.
  const sessions = (scope as unknown as { readonly sessions?: ClientSessionList }).sessions
  const command: ShortcutCommand = {
    id: COMMAND_ID,
    label: () => t('shortcut.toggle'),
    aliases: ['vcs', 'version control', 'toggle vcs', 'changes'],
    defaults: SHORTCUT_DEFAULTS,
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve(context) {
      // Web/Linux already block commands behind modals; Desktop native input
      // takes priority over them, so decline explicitly instead of opening a
      // tab behind a dialog.
      if (context?.modal !== null && context?.modal !== undefined) return { status: 'pass' }
      const sessionId = mainSessionId(sessions?.list?.getSnapshot?.())
      if (sessionId === null) return { status: 'pass' }
      if (sidebar.mounted?.getSnapshot?.() !== sessionId) return { status: 'pass' }
      // A visible panel collapses the Sidebar; the tab and its body stay mounted
      // so the slide back to the conversation animates the panel, not an empty
      // page. The next press reveals the same tab again.
      if (sidebar.isExpanded()) {
        const active = sidebar.active()
        if (active?.kind === TAB_KIND) {
          return {
            status: 'handled',
            run: () => { sidebar.hide(active.id) },
          }
        }
      }
      return {
        status: 'handled',
        run: () => { sidebar.openTab(TAB_KIND) },
      }
    },
  }
  try {
    return scope.shortcuts.register(command)
  } catch (error) {
    console.warn('dsh-vcs-panel: shortcut default is unavailable', error)
    try {
      return scope.shortcuts.register({ ...command, defaults: {} })
    } catch (fallbackError) {
      console.warn('dsh-vcs-panel: shortcut could not be registered', fallbackError)
      return () => {}
    }
  }
}

/**
 * Register the Sidebar page, its guide card, the Turn-tail entry, the locale
 * dictionaries, the Turn fold, and the panel shortcut for the lifetime of this
 * plugin entry.
 * @param ctx - the Client root context.
 */
export function apply(ctx: Context): void {
  // The renderer's slot registry is not part of this plugin's installed type
  // set; its two calls are the only slot service surface this entry uses.
  const slots = (ctx as unknown as { readonly slots: SlotRegistryFace }).slots
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-vcs-panel: locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-vcs-panel'
    style.textContent = `${shellStyles}\n${diffStyles}\n${graphStyles}`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-vcs-panel: styles')

  ctx.effect(() => ctx.uiConversation.events.register(createTurnChangesDefinition()), 'dsh-vcs-panel: turn changes')

  const turnSummaries = createTurnSummaryStore()
  ctx.effect(() => {
    const disposeReset = typeof ctx.on === 'function'
      ? ctx.on('connection/reset', () => { turnSummaries.reset() })
      : undefined
    return () => {
      if (typeof disposeReset === 'function') disposeReset()
      turnSummaries.dispose()
    }
  }, 'dsh-vcs-panel: turn summaries')

  const t: Translate = ctx.locale.bind(NS)

  /**
   * Track the active UI locale so dates and counts follow the language switch.
   * The translate function reads the locale at call time; subscribing makes the
   * caller re-render when the switch happens.
   * @returns active BCP 47 locale tag.
   */
  function useActiveLocale(): string {
    const [locale, setLocale] = useState(() => ctx.locale.getLocale().active)
    useEffect(() => ctx.locale.subscribe(() => {
      setLocale(ctx.locale.getLocale().active)
    }), [])
    return locale
  }

  /**
   * Version control panel living in a right-Sidebar tab.
   *
   * Opening or revealing the page asks the panel to refresh and land keyboard
   * focus after the host has focused its pane. An already visible page starts
   * with that request handled by the initial load.
   * @param props - standard `sidebar.right.pane.tab` props.
   * @returns the version control panel with the active locale.
   */
  function SidebarVcsView(props: SidebarVcsViewProps) {
    const locale = useActiveLocale()
    const { tab } = props.useTabInfo()
    const navRevision = tab.navigation?.revision ?? 0
    const [focusRequest, setFocusRequest] = useState(tab.visible && navRevision > 0 ? 1 : 0)
    const wasVisibleRef = useRef(tab.visible)
    const lastRevisionRef = useRef(tab.visible ? navRevision : 0)

    useEffect(() => {
      const becameVisible = tab.visible && !wasVisibleRef.current
      wasVisibleRef.current = tab.visible
      if (!tab.visible) return
      const navigated = navRevision > 0 && navRevision !== lastRevisionRef.current
      if (navRevision > 0) lastRevisionRef.current = navRevision
      if (becameVisible || navigated) setFocusRequest(value => value + 1)
    }, [navRevision, tab.visible])

    return (
      <ViewErrorBoundary key={props.sessionId} t={t}>
        <VcsView {...props} locale={locale} visible={tab.visible} focusRequest={focusRequest} />
      </ViewErrorBoundary>
    )
  }

  /**
   * The Sidebar chip's text. Registering it keeps the label in the current
   * language instead of the text captured when the tab opened.
   * @returns the localized view label.
   */
  function VcsTabTitle(): string {
    return t('view.label')
  }

  /**
   * The Sidebar tab type: a page opened by kind, with one guide card. The guide
   * is how a user who never opened the panel discovers it.
   */
  const sidebarDefinition: SidebarRightTabDefinition = {
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => t('view.label'),
    guide: [{
      id: GUIDE_ID,
      order: GUIDE_ORDER,
      commandId: COMMAND_ID,
      title: () => t('view.label'),
      description: () => t('sidebar.guide'),
      icon: GitBranchIcon,
    }],
  }

  ctx.effect(
    () => ctx.sidebarRightTabs.register(sidebarDefinition),
    'dsh-vcs-panel: sidebar tab type',
  )

  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
  }, SidebarVcsView)), 'dsh-vcs-panel: sidebar tab body')

  ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
    locale: NS,
  }, VcsTabTitle)), 'dsh-vcs-panel: sidebar tab title')

  ctx.effect(() => slots.inject('conversation.chat.turnTail', () => {
    /**
     * Banner for a Turn that changed files, reading that Turn's recorded
     * repository head and line-diff totals. Clicking it opens the VCS page in
     * the right Sidebar.
     */
    function ActiveTurnTailEntry(props: TurnTailEntryProps) {
      const locale = useActiveLocale()
      const coordinates = turnChanges(props.turn)
      const turnNumber = coordinates?.turn ?? null
      const seq = coordinates?.seq ?? null
      const [, setRevision] = useState(0)
      // The cache keys a summary by its numbered Turn; a changed Turn always
      // has one, and an unnumbered location caches nothing.
      const summary = turnNumber === null ? null : turnSummaries.get(props.sessionId, turnNumber, seq)
      useEffect(() => {
        if (turnNumber === null) return undefined
        const unsubscribe = turnSummaries.subscribe(props.sessionId, turnNumber, seq, () => {
          setRevision(value => value + 1)
        })
        turnSummaries.observe(props.sessionId, turnNumber, seq)
        return unsubscribe
      }, [props.sessionId, turnNumber, seq])
      return (
        <TurnTailChanges
          turn={props.turn}
          summary={summary}
          locale={locale}
          t={props.t}
          onOpen={() => { ctx.sidebarRight.openTab(TAB_KIND) }}
        />
      )
    }

    /** Skip hooks and subscriptions on Turns that changed no files. */
    function TurnTailEntry(props: TurnTailEntryProps): ReactNode {
      if (!turnChangedFiles(props.turn)) return null
      return <ActiveTurnTailEntry {...props} />
    }
    return slots.register({
      name: 'conversation.chat.turnTail',
      id: TURN_TAIL_ID,
      order: TURN_TAIL_ORDER,
      locale: NS,
    }, TurnTailEntry)
  }), 'dsh-vcs-panel: turn tail')

  // The shortcut is optional: without the host services the page keeps its
  // normal registrations and simply has no global key.
  ctx.inject(['shortcuts', 'sessions'], scope => {
    scope.effect(() => registerPanelShortcut(ctx, scope, t), 'dsh-vcs-panel: panel shortcut')
  })
}
