export type CueStatus = 'pending' | 'confirmed' | 'followup'
export type Side = 'backstage' | 'onsite'
export type TabId = 'live' | 'prep' | 'terms' | 'offline'

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

export interface Term {
  id: string
  source: string
  target: string
  note: string
  speakerId: string
  priority: 'normal' | 'high'
  /** 译法版本：每次修改指定译法 +1；已确认稿件不随改，只按版本差标注「译法已更新」 */
  revision: number
}

/** 稿件录入时命中的术语快照（术语 id + 当时版本 + 当时译法） */
export interface TermHit {
  termId: string
  revision: number
  source: string
  target: string
}

export interface Announcement {
  id: string
  level: 'info' | 'warning' | 'urgent'
  text: string
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
  termHits: TermHit[]
  updatedAt: number
}

export interface Reminder {
  id: string
  termId: string
  cueId: string
  target: string
  createdAt: number
  acknowledged: boolean
}

/** 一份记录、两端各自持有：后台准备端与现场运行端 */
export interface DeskMeta {
  side: Side
  shiftId: string
  shiftName: string
  termRevision: number
  lastSyncAt: number | null
  lastSyncPeer: Side | null
}

export type OpKind =
  | 'speaker.upsert' | 'speaker.delete'
  | 'session.upsert' | 'session.delete'
  | 'term.upsert' | 'term.delete'
  | 'announcement.upsert' | 'announcement.publish' | 'announcement.delete'
  | 'cue.add' | 'cue.update' | 'cue.delete'
  | 'reminder.add' | 'reminder.ack'

/** 操作日志：所有变更以操作为单位，对账时按操作重放、只回退出错一边 */
export interface Op {
  id: string
  side: Side
  ts: number
  kind: OpKind
  entityId: string
  payload: Record<string, unknown>
}

/** 对账冲突：两端在同一同步点之后改了同一实体，交值班主管决定 */
export interface SyncConflict {
  id: string
  entityKind: 'speaker' | 'session' | 'term' | 'announcement' | 'cue' | 'reminder'
  entityId: string
  localLabel: string
  remoteLabel: string
  /** 对端操作应用前的本机实体快照；主管选「保留本班」时据此回退 */
  localSnapshot: unknown
  localUpdatedAt: number
  remoteUpdatedAt: number
  resolved: boolean
  resolution?: 'local' | 'remote' | 'merge'
}

export interface SyncReport {
  at: number
  peer: Side
  received: number
  applied: number
  conflicts: number
  rolledBack: boolean
  error?: string
  kind?: 'sync' | 'handover'
}

/** 换班交接包：现场那份记录的完整快照 + 操作日志 */
export interface HandoverPackage {
  kind: 'cue-desk-handover'
  version: 1
  shiftId: string
  shiftName: string
  exportedAt: string
  exportedFrom: Side
  state: DeskState
  ops: Op[]
}

export interface HandoverCheck {
  valid: boolean
  sameShift: boolean
  localOnlyCues: number
  incomingCues: number
  localShift: string
  incomingShift: string
}

export interface DeskState {
  speakers: Speaker[]
  sessions: Session[]
  terms: Term[]
  announcements: Announcement[]
  cues: Cue[]
  reminders: Reminder[]
  activeCueId: string
  fontScale: number
  online: boolean
  liveSimulation: boolean
  meta: DeskMeta
  ops: Op[]
  redoStack: Op[]
  conflicts: SyncConflict[]
  peerSnapshot: DeskState | null
  lastSyncReport: SyncReport | null
  updatedAt: string
}
