/** The usual detail pane, with reading state private to the activity row and no writes. */

import { useCallback, useRef, useState } from 'react'
import type { ActivityEntry } from '../../lib/activity.js'
import { DetailPane } from '../detail/DetailPane.jsx'
import type { DetailPaneProps } from '../detail/DetailPane.jsx'
import type { ReadingAnchor } from '../state.js'
import { Button, OpenRepositoryIcon } from '../ui.jsx'
import { ActivityRepositoryName } from './ActivityTimeline.jsx'
import type { ActivityRepository } from './ActivityTimeline.jsx'
import { activityNode } from './activity-model.js'
import type { ActivityStop } from './activity-model.js'

interface Reading {
  collapsed: Record<string, boolean>
  folds: Record<string, boolean>
  anchor: ReadingAnchor | null
}

export type ActivityReading = Map<string, Reading>

type ActivityDetailProps = Pick<DetailPaneProps,
  'api' | 'split' | 'wrap' | 'onToggleSplit' | 'onToggleWrap' | 'singleColumn' | 'onBack' | 'onLeaveNav'
  | 'onSelectCommit' | 'isLoaded' | 'onSettled' | 'revision' | 'cache' | 'detailCache' | 'control' | 't' | 'locale'> & {
  row: ActivityStop
  repository: ActivityRepository
  memory: ActivityReading
  onReveal: (entry: ActivityEntry, keyboard: boolean) => void
}

const EMPTY = Object.freeze({})

export function ActivityDetail({ row, repository, memory, onReveal, ...props }: ActivityDetailProps) {
  const [reading, setReading] = useState<Reading>(() => memory.get(row.key) ?? { collapsed: {}, folds: {}, anchor: null })
  const live = useRef(reading)
  const initialAnchor = useRef(reading.anchor)
  const remember = useCallback((patch: Partial<Reading>) => {
    const next = { ...live.current, ...patch }
    live.current = next
    memory.set(row.key, next)
    if (patch.anchor === undefined) setReading(next)
  }, [memory, row.key])
  const onReading = useCallback((anchor: ReadingAnchor | null) => { remember({ anchor }) }, [remember])
  const { entry } = row
  const title = props.t('all.open', { repo: repository.name })
  return (
    <DetailPane
      {...props}
      repo={entry.repo}
      node={activityNode(entry)}
      summary={entry.kind === 'commit' ? entry.commit : null}
      stashEntry={entry.kind === 'stash' ? entry.stash : null}
      capabilities={repository.capabilities}
      status={null}
      statusState="idle"
      statusError={null}
      dirChildren={EMPTY}
      loadingDirs={EMPTY}
      dirs={EMPTY}
      collapsed={reading.collapsed}
      onToggleDir={directory => { remember({ collapsed: { ...live.current.collapsed, [directory.key]: directory.expanded } }) }}
      folds={reading.folds}
      onToggleFold={(key, folded) => { remember({ folds: { ...live.current.folds, [key]: folded } }) }}
      onSetFolds={folds => { remember({ folds }) }}
      initialAnchor={initialAnchor.current}
      onReading={onReading}
      backgroundDiffRevision={undefined}
      stageDisabled
      toolbarStart={(
        <Button className="vcs-activity-open" title={title} aria-label={title} onClick={() => { onReveal(entry, false) }}>
          <ActivityRepositoryName repo={repository} />
          <OpenRepositoryIcon />
        </Button>
      )}
    />
  )
}
