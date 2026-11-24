/**
 * The tiled layout's top-bar controls: one button per state that steps through
 * its pointers (number keys 1–7, Shift steps back), and the column order.
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

import type { TileOrder } from '../state.js'
import type { FilterId } from './model.js'
import { FILTERS } from './model.js'
import { FILTER_KEYS } from './labels.js'

export interface StateButtonsProps {
  counts: Readonly<Record<FilterId, number>>
  filter: FilterId | null
  /** Position in the active traversal, from 0. */
  index: number
  /** Hits of the active traversal. */
  total: number
  order: TileOrder
  onStep: (filter: FilterId, direction: 1 | -1) => void
  onOrder: (order: TileOrder) => void
  t: Translate
}

export function StateButtons({ counts, filter, index, total, order, onStep, onOrder, t }: StateButtonsProps) {
  return (
    <>
      <div className="vcs-state-buttons" role="group" aria-label={t('tile.states')}>
        {FILTERS.map((id, position) => {
          const count = counts[id]
          const label = t(FILTER_KEYS[id])
          const active = filter === id
          return (
            <button
              key={id}
              type="button"
              className="vcs-state-chip"
              data-state={id}
              aria-pressed={active}
              aria-disabled={count === 0 || undefined}
              data-zero={count === 0 || undefined}
              title={count === 0 ? t('tile.none', { state: label }) : t('tile.next', { state: label })}
              onClick={event => { if (count > 0) onStep(id, event.shiftKey ? -1 : 1) }}
            >
              <span className="vcs-state-dot" aria-hidden="true" />
              {label}
              <b>{count}</b>
              {active && total > 0 ? <span className="vcs-state-position">{index + 1}/{total}</span> : null}
              <kbd aria-hidden="true">{position + 1}</kbd>
            </button>
          )
        })}
      </div>
      <div className="vcs-tile-order" role="group" aria-label={t('tile.order')}>
        <button type="button" aria-pressed={order === 'directory'} onClick={() => { onOrder('directory') }}>{t('tile.orderDirectory')}</button>
        <button type="button" aria-pressed={order === 'attention'} onClick={() => { onOrder('attention') }}>{t('tile.orderAttention')}</button>
      </div>
    </>
  )
}
