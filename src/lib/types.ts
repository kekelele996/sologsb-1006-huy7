export type CueStatus = 'pending' | 'confirmed' | 'followup'
export type TabId = 'live' | 'backstage' | 'terms' | 'reconcile' | 'handover'

export interface Speaker {
  id: string
  name: string
  title: string
  language: string
  color: string
}

export interface Session {
  id: string
  order: number
  time: string
  title: string
  speakerId: string
  room: string
  status: 'upcoming' | 'live' | 'done'
}

/** 后台端持有的术语定义；译法变化时 revision 递增、旧译法留在 targetHistory。 */
export interface Term {
  id: string
  source: string
  target: string
  note: string
  speakerId: string
  priority: 'normal' | 'high'
  revision: number
  targetHistory: { target: string; revisedAt: number }[]
}

/** 现场端在确认瞬间冻结的术语快照，之后永不改写。 */
export interface FrozenTerm {
  termId: string
  source: string
  target: string
  revision: number
}

/** 已确认稿件上的“译法已更新”标注，只标记、不改写原文。 */
export interface TermUpdateMarker {
  id: string
  termId: string
  source: string
  oldTarget: string
  newTarget: string
  newRevision: number
  markedAt: number
  seen: boolean
}

export interface Announcement {
  id: string
  level: 'info' | 'warning' | 'urgent'
  text: string
  /** 后台端：是否已按下发布闸门；现场端：现场是否可见。 */
  visibleOnStage: boolean
  createdAt: string
}

export interface Cue {
  id: string
  speakerId: string
  text: string
  receivedAt: number
  status: CueStatus
  manual: boolean
  offline: boolean
  delaySeconds: number
  duplicateOf: string | null
  followupText: string
  tags: string[]
  /** 确认时冻结的术语快照；未确认为 null，始终跟随现场端最新译法。 */
  frozenTerms: FrozenTerm[] | null
  confirmedAt: number | null
  markers: TermUpdateMarker[]
}

export interface Reminder {
  id: string
  termId: string
  cueId: string
  target: string
  createdAt: number
  acknowledged: boolean
}

export interface Shift {
  operator: string
  startedAt: number
}

// —— 两端对账事件 ——

export type EventDirection = 'backstage-to-live' | 'live-to-backstage'

export type BackstageEventType =
  | 'term-upserted'
  | 'roster-updated'
  | 'announcement-published'
  | 'announcement-recalled'
export type LiveEventType = 'live-progress'

export type SyncEvent =
  | {
      id: string
      seq: number
      direction: 'backstage-to-live'
      type: BackstageEventType
      at: number
      payload: unknown
    }
  | {
      id: string
      seq: number
      direction: 'live-to-backstage'
      type: LiveEventType
      at: number
      payload: unknown
    }

export interface SyncState {
  online: boolean
  /** 本机已产生、等待对端取走的事件。 */
  outbox: SyncEvent[]
  /** 已成功应用的事件编号（按方向），用于对账去重。 */
  journal: SyncEvent[]
  lastReconciledAt: number | null
  lastReconcileSummary: string
}

/** 后台准备端自有内容。 */
export interface BackstageState {
  speakers: Speaker[]
  sessions: Session[]
  terms: Term[]
  announcements: Announcement[]
  /** 现场回传的动态，仅供后台展示。 */
  liveFeedback: { cueId: string; text: string; status: CueStatus; at: number }[]
  /** 单调递增的事件序号。 */
  eventSeq: number
  sync: SyncState
  updatedAt: string
}

/** 现场运行端自有内容（自己持有一份术语/通知副本）。 */
export interface LiveState {
  /** 现场自持的发言人名册副本，经后台名册事件更新。 */
  speakers: Speaker[]
  sessions: Session[]
  /** 现场自持的术语副本，后台新译法到达后立即替换。 */
  terms: Term[]
  announcements: Announcement[]
  cues: Cue[]
  reminders: Reminder[]
  activeCueId: string
  fontScale: number
  liveSimulation: boolean
  shift: Shift
  /** 值班主管裁定后挂起的交接争议。 */
  handoverDisputes: HandoverDispute[]
  eventSeq: number
  sync: SyncState
  updatedAt: string
}

// —— 交接包 ——

export interface HandoverPackage {
  format: 'cue-desk-handover'
  version: 1
  shiftId: string
  operator: string
  handedAt: string
  stats: {
    pending: number
    followup: number
    confirmed: number
    offline: number
    marked: number
  }
  cueDigests: { cueId: string; status: CueStatus; hash: string }[]
  termRevisionFingerprint: string
  cues: Cue[]
  reminders: Reminder[]
  checksum: string
}

export type HandoverVerdict = 'pending' | 'accepted' | 'rejected'

export interface HandoverDispute {
  id: string
  importedAt: number
  incomingOperator: string
  reason: string
  mismatchDetails: string[]
  supervisor: string
  verdict: HandoverVerdict
  resolvedAt: number | null
  packageData: string
}
