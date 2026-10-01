import { writable, get } from 'svelte/store'
import type {
  Announcement, Cue, CueStatus, DeskState, DeskMeta, HandoverCheck, HandoverPackage,
  Op, OpKind, Reminder, Session, Side, Speaker, SyncConflict, SyncReport, Term, TermHit
} from './types'

const STORAGE_PREFIX = 'conference-cue-desk-v2-'
const CHANNEL_NAME = 'cue-desk-sync-v1'

/* ---------------- 种子数据（两端共享同一份基线操作） ---------------- */
const speakers: Speaker[] = [
  { id: 'sp-1', name: 'Dr. Maya Chen', title: '首席气候科学家', language: '英语 → 中文', color: '#0f766e' },
  { id: 'sp-2', name: '刘启明', title: '城市韧性研究员', language: '中文 → 英语', color: '#b45309' },
  { id: 'sp-3', name: 'Prof. Daniel Ortiz', title: '公共卫生政策顾问', language: '西班牙语 → 中文', color: '#6d28d9' },
  { id: 'sp-4', name: '佐藤 美咲', title: '社区能源设计师', language: '日语 → 中文', color: '#be123c' }
]
const sessions: Session[] = [
  { id: 'se-1', order: 1, time: '09:00', title: '开幕式与议程说明', speakerId: 'sp-2', room: '主会场 A', status: 'done' },
  { id: 'se-2', order: 2, time: '09:20', title: '城市热岛与适应性基础设施', speakerId: 'sp-1', room: '主会场 A', status: 'live' },
  { id: 'se-3', order: 3, time: '10:05', title: '社区健康数据的地方行动', speakerId: 'sp-3', room: '主会场 A', status: 'upcoming' },
  { id: 'se-4', order: 4, time: '10:45', title: '分布式能源与社区共治', speakerId: 'sp-4', room: '主会场 A', status: 'upcoming' }
]
const terms: Term[] = [
  { id: 'term-1', source: 'urban heat island', target: '城市热岛', note: '首次出现完整译出，后可简称热岛', speakerId: 'sp-1', priority: 'high', revision: 1 },
  { id: 'term-2', source: 'resilience', target: '韧性', note: '不使用“恢复力”', speakerId: 'sp-1', priority: 'high', revision: 1 },
  { id: 'term-3', source: 'co-benefit', target: '协同效益', note: '环境与健康共同收益', speakerId: 'sp-1', priority: 'normal', revision: 1 },
  { id: 'term-4', source: 'distributed energy resource', target: '分布式能源资源', note: '缩写 DER', speakerId: 'sp-4', priority: 'high', revision: 1 },
  { id: 'term-5', source: 'health equity', target: '健康公平', note: '不译为健康平等', speakerId: 'sp-3', priority: 'high', revision: 1 }
]
const announcements: Announcement[] = [
  { id: 'ann-1', level: 'info', text: '十点整有消防联动测试，请提醒会场人员保持镇定。', visibleOnStage: false, createdAt: new Date().toISOString() },
  { id: 'ann-2', level: 'urgent', text: '请下一位发言人提前到侧台候场。', visibleOnStage: false, createdAt: new Date().toISOString() }
]
function initialCues(): Cue[] {
  const now = Date.now()
  return [
    { id: 'cue-101', speakerId: 'sp-1', text: 'The urban heat island effect is not evenly distributed across a city.', receivedAt: now - 36000, status: 'confirmed', manual: false, offline: false, delaySeconds: 4, duplicateOf: null, followupText: '', tags: ['城市热岛'], termHits: [], updatedAt: now - 36000 },
    { id: 'cue-102', speakerId: 'sp-1', text: 'Neighborhoods with less tree canopy can be several degrees warmer at night.', receivedAt: now - 19000, status: 'confirmed', manual: false, offline: false, delaySeconds: 6, duplicateOf: null, followupText: '补译：“夜间温差可达数摄氏度。”', tags: ['树冠覆盖率'], termHits: [], updatedAt: now - 19000 },
    { id: 'cue-103', speakerId: 'sp-1', text: 'Our resilience strategy links cooling corridors with public health investments.', receivedAt: now - 9000, status: 'pending', manual: false, offline: false, delaySeconds: 11, duplicateOf: null, followupText: '', tags: ['韧性', '协同效益'], termHits: [], updatedAt: now - 9000 },
    { id: 'cue-104', speakerId: 'sp-1', text: 'That data also reveals health equity gaps between districts.', receivedAt: now - 2500, status: 'pending', manual: false, offline: false, delaySeconds: 4, duplicateOf: null, followupText: '', tags: ['健康公平'], termHits: [], updatedAt: now - 2500 }
  ]
}

function emptyState(side: Side): DeskState {
  return {
    speakers: [], sessions: [], terms: [], announcements: [], cues: [], reminders: [],
    activeCueId: '', fontScale: 100, online: true, liveSimulation: true,
    meta: { side, shiftId: 'shift-1', shiftName: '第一班', termRevision: 1, lastSyncAt: null, lastSyncPeer: null },
    ops: [], redoStack: [], conflicts: [], peerSnapshot: null, lastSyncReport: null,
    updatedAt: new Date().toISOString()
  }
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const index = list.findIndex(row => row.id === item.id)
  if (index >= 0) list[index] = item
  else list.push(item)
}

/** 操作重放：所有状态变更都经此入口，对账/换班时重放操作日志即可复原 */
function applyOp(draft: DeskState, op: Op) {
  const p = op.payload as Record<string, any>
  switch (op.kind) {
    case 'speaker.upsert': upsert(draft.speakers, { ...p } as Speaker)
      break
    case 'speaker.delete': draft.speakers = draft.speakers.filter(row => row.id !== op.entityId)
      break
    case 'session.upsert': upsert(draft.sessions, { ...p } as Session)
      break
    case 'session.delete': draft.sessions = draft.sessions.filter(row => row.id !== op.entityId)
      break
    case 'term.upsert': {
      const existing = draft.terms.find(row => row.id === op.entityId)
      const term = { ...p } as Term
      if (!term.revision) term.revision = existing?.revision ?? 1
      upsert(draft.terms, term)
      draft.meta.termRevision = Math.max(draft.meta.termRevision, term.revision)
      break
    }
    case 'term.delete': draft.terms = draft.terms.filter(row => row.id !== op.entityId)
      break
    case 'announcement.upsert': upsert(draft.announcements, { ...p } as Announcement)
      break
    case 'announcement.publish': {
      const item = draft.announcements.find(row => row.id === op.entityId)
      if (item) item.visibleOnStage = Boolean(p.visibleOnStage)
      break
    }
    case 'announcement.delete': draft.announcements = draft.announcements.filter(row => row.id !== op.entityId)
      break
    case 'cue.add': {
      const cue = { ...p } as Cue
      if (!Array.isArray(cue.termHits)) cue.termHits = []
      if (!cue.updatedAt) cue.updatedAt = op.ts
      if (!cue.offline) {
        const duplicate = findDuplicate(cue.text, draft.cues.filter(row => row.id !== cue.id && !row.offline))
        cue.duplicateOf = duplicate?.id ?? cue.duplicateOf ?? null
      }
      draft.cues.push(cue)
      break
    }
    case 'cue.update': {
      const cue = draft.cues.find(row => row.id === op.entityId)
      if (cue) {
        Object.assign(cue, p, { updatedAt: op.ts })
        if (p.offline === false) {
          const duplicate = findDuplicate(cue.text, draft.cues.filter(row => row.id !== cue.id && !row.offline))
          cue.duplicateOf = duplicate?.id ?? null
        }
      }
      break
    }
    case 'cue.delete': {
      draft.cues = draft.cues.filter(row => row.id !== op.entityId)
      if (draft.activeCueId === op.entityId) draft.activeCueId = draft.cues.at(-1)?.id ?? ''
      break
    }
    case 'reminder.add': draft.reminders.unshift({ ...p } as Reminder)
      break
    case 'reminder.ack': {
      const item = draft.reminders.find(row => row.id === op.entityId)
      if (item) item.acknowledged = true
      break
    }
  }
}

function replay(ops: Op[], base: DeskMeta): DeskState {
  const draft = emptyState(base.side)
  draft.meta = { ...base, termRevision: 1 }
  const sorted = [...ops].sort((a, b) => a.ts - b.ts)
  for (const op of sorted) applyOp(draft, op)
  draft.ops = sorted
  return draft
}

function seedOps(side: Side): Op[] {
  const t0 = Date.now() - 86_400_000
  const ops: Op[] = []
  const push = (kind: OpKind, entityId: string, payload: unknown, dt: number, opSide: Side = 'backstage') =>
    ops.push({ id: `seed-${kind}-${entityId}`, side: opSide, ts: t0 + dt, kind, entityId, payload: payload as Record<string, unknown> })
  speakers.forEach((item, i) => push('speaker.upsert', item.id, item, i))
  sessions.forEach((item, i) => push('session.upsert', item.id, item, 10 + i))
  terms.forEach((item, i) => push('term.upsert', item.id, item, 20 + i))
  announcements.forEach((item, i) => push('announcement.upsert', item.id, item, 30 + i))
  if (side === 'onsite') {
    initialCues().forEach((cue, i) => push('cue.add', cue.id, { ...cue, termHits: hitsFor(cue.text, terms), updatedAt: t0 + 40 + i }, 40 + i, 'onsite'))
  }
  return ops
}

function seedState(side: Side): DeskState {
  const state = replay(seedOps(side), { side, shiftId: 'shift-1', shiftName: '第一班', termRevision: 1, lastSyncAt: null, lastSyncPeer: null })
  state.activeCueId = side === 'onsite' ? 'cue-103' : ''
  return state
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
function clone<T>(value: T): T { return structuredClone(value) }

/* ---------------- 持久化：两端各自持有一份 ---------------- */
function storageKey(side: Side): string { return STORAGE_PREFIX + side }
function persist(state: DeskState) {
  state.updatedAt = new Date().toISOString()
  if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(state.meta.side), JSON.stringify(state))
}
function loadState(side: Side): DeskState {
  if (typeof localStorage === 'undefined') return seedState(side)
  try {
    const saved = localStorage.getItem(storageKey(side))
    if (saved) {
      const parsed = JSON.parse(saved) as DeskState
      return { ...seedState(side), ...parsed, meta: { ...parsed.meta, side }, peerSnapshot: null }
    }
  } catch { /* 记录损坏时回到种子，不影响对端 */ }
  return seedState(side)
}

export const desk = writable<DeskState>(loadState('onsite'))

/** 需要同步的变更：记操作日志、重放、广播给对端 */
function commit<T extends object>(kind: OpKind, entityId: string, payload: T) {
  const draft = clone(get(desk))
  const op: Op = { id: uid('op'), side: draft.meta.side, ts: Date.now(), kind, entityId, payload: payload as Record<string, unknown> }
  applyOp(draft, op)
  draft.ops.push(op)
  draft.redoStack = []
  persist(draft)
  desk.set(draft)
  broadcast({ type: 'ops', from: draft.meta.side, ops: [op], state: snapshot(draft) })
}
/** 仅本机生效的偏好（字号、在线状态、模拟开关、当前选中） */
function patchLocal(recipe: (draft: DeskState) => void) {
  const draft = clone(get(desk))
  recipe(draft)
  persist(draft)
  desk.set(draft)
}

/* ---------------- 端切换 ---------------- */
export function switchSide(side: Side) {
  const current = get(desk)
  if (current.meta.side === side) return
  persist(current)
  const next = loadState(side)
  desk.set(next)
  broadcastHello()
}

/* ---------------- 本机偏好 ---------------- */
export function setOnline(online: boolean) {
  patchLocal(draft => { draft.online = online })
  if (online) {
    for (const cue of get(desk).cues.filter(item => item.offline)) {
      commit('cue.update', cue.id, { offline: false })
    }
  }
}
export function setLiveSimulation(enabled: boolean) { patchLocal(draft => { draft.liveSimulation = enabled }) }
export function setActiveCue(id: string) { patchLocal(draft => { draft.activeCueId = id }) }
export function moveCue(direction: 1 | -1) {
  const state = get(desk)
  const index = state.cues.findIndex(item => item.id === state.activeCueId)
  const next = state.cues[index + direction]
  if (next) setActiveCue(next.id)
}
export function setFontScale(scale: number) { patchLocal(draft => { draft.fontScale = Math.min(150, Math.max(85, scale)) }) }

/* ---------------- 后台准备：发言人 / 议程 / 术语 / 通知 ---------------- */
export function addSpeaker() {
  const speaker: Speaker = { id: uid('sp'), name: '新发言人', title: '待填写机构与职务', language: '待设置语言方向', color: '#475569' }
  commit('speaker.upsert', speaker.id, speaker)
}
export function updateSpeaker(id: string, patch: Partial<Speaker>) {
  const item = get(desk).speakers.find(row => row.id === id)
  if (item) commit('speaker.upsert', id, { ...item, ...patch })
}
export function addSession() {
  const state = get(desk)
  const session: Session = { id: uid('se'), order: Math.max(0, ...state.sessions.map(item => item.order)) + 1, time: '11:30', title: '新演讲', speakerId: state.speakers[0]?.id || '', room: '主会场 A', status: 'upcoming' }
  commit('session.upsert', session.id, session)
}
export function updateSession(id: string, patch: Partial<Session>) {
  const item = get(desk).sessions.find(row => row.id === id)
  if (item) commit('session.upsert', id, { ...item, ...patch })
}
export function addTerm() {
  const state = get(desk)
  const term: Term = { id: uid('term'), source: 'new term', target: '新术语', note: '', speakerId: state.speakers[0]?.id || '', priority: 'normal', revision: 1 }
  commit('term.upsert', term.id, term)
}
export function updateTerm(id: string, patch: Partial<Term>) {
  const item = get(desk).terms.find(row => row.id === id)
  if (!item) return
  const next = { ...item, ...patch }
  if (patch.target !== undefined && patch.target !== item.target) next.revision = item.revision + 1
  commit('term.upsert', id, next)
}
export function addAnnouncement(text: string, level: Announcement['level']) {
  if (!text.trim()) return
  const announcement: Announcement = { id: uid('ann'), level, text: text.trim(), visibleOnStage: false, createdAt: new Date().toISOString() }
  commit('announcement.upsert', announcement.id, announcement)
}
export function publishAnnouncement(id: string, visible: boolean) { commit('announcement.publish', id, { visibleOnStage: visible }) }

/* ---------------- 现场：稿件队列 ---------------- */
export function ingestCue(text: string, options: { manual?: boolean; speakerId?: string; receivedAt?: number } = {}) {
  const trimmed = text.trim()
  if (!trimmed) return
  const state = get(desk)
  const duplicate = findDuplicate(trimmed, state.cues.filter(item => !item.offline))
  const speakerId = options.speakerId || state.sessions.find(item => item.status === 'live')?.speakerId || state.speakers[0]?.id || ''
  const receivedAt = options.receivedAt || Date.now()
  const cue: Cue = {
    id: uid('cue'), speakerId, text: trimmed, receivedAt,
    status: 'pending', manual: Boolean(options.manual), offline: !state.online,
    delaySeconds: Math.max(0, Math.round((Date.now() - receivedAt) / 1000)),
    duplicateOf: duplicate?.id ?? null, followupText: '',
    tags: detectTags(trimmed, state.terms), termHits: hitsFor(trimmed, state.terms),
    updatedAt: Date.now()
  }
  commit('cue.add', cue.id, cue)
  patchLocal(draft => { draft.activeCueId = cue.id })
}
export function updateCue(id: string, patch: Partial<Cue>) { commit('cue.update', id, patch as Record<string, unknown>) }
export function setCueStatus(id: string, status: CueStatus) { commit('cue.update', id, { status }) }
export function deleteCue(id: string) { commit('cue.delete', id, {}) }
export function clearDuplicate(id: string) { commit('cue.update', id, { duplicateOf: null }) }
export function sendReminder(termId: string, cueId: string) {
  const state = get(desk)
  if (state.reminders.some(item => item.termId === termId && item.cueId === cueId)) return
  const term = state.terms.find(item => item.id === termId)
  const reminder: Reminder = { id: uid('rem'), termId, cueId, target: term?.target ?? '', createdAt: Date.now(), acknowledged: false }
  commit('reminder.add', reminder.id, reminder)
}
export function acknowledgeReminder(id: string) { commit('reminder.ack', id, {}) }

/* ---------------- 撤销 / 重做（只撤销本机操作） ---------------- */
function findLastIndex<T>(list: T[], predicate: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return i
  return -1
}
function preserveLocal(draft: DeskState, source: DeskState) {
  draft.fontScale = source.fontScale
  draft.online = source.online
  draft.liveSimulation = source.liveSimulation
  draft.activeCueId = source.activeCueId
  draft.conflicts = source.conflicts
  draft.peerSnapshot = source.peerSnapshot
  draft.lastSyncReport = source.lastSyncReport
}
export function undoDesk() {
  const state = get(desk)
  const index = findLastIndex(state.ops, item => item.side === state.meta.side)
  if (index < 0) return
  const op = state.ops[index]
  const replayed = replay(state.ops.filter((_, i) => i !== index), state.meta)
  replayed.redoStack = [...state.redoStack, op]
  preserveLocal(replayed, state)
  persist(replayed); desk.set(replayed)
}
export function redoDesk() {
  const state = get(desk)
  const op = state.redoStack.at(-1)
  if (!op) return
  const replayed = replay([...state.ops, op], state.meta)
  replayed.redoStack = state.redoStack.slice(0, -1)
  preserveLocal(replayed, state)
  persist(replayed); desk.set(replayed)
}
export const canUndo = () => get(desk).ops.some(item => item.side === get(desk).meta.side)
export const canRedo = () => get(desk).redoStack.length > 0

/* ---------------- 对账：两端各自对账，失败只回退出错一边 ---------------- */
export const peerStatus = writable(false)
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null

function snapshot(state: DeskState): DeskState {
  return { ...clone(state), peerSnapshot: null, lastSyncReport: null }
}
function broadcast(message: Record<string, unknown>) {
  if (!channel) return
  try { channel.postMessage(message) } catch { /* 对端不在时静默 */ }
}
if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as { type?: string; from?: Side; ops?: Op[]; state?: DeskState; response?: boolean }
    if (message?.type === 'ops' && message.ops) {
      peerStatus.set(true)
      receiveOps(message.ops, message.from ?? 'onsite', message.state)
    } else if (message?.type === 'hello') {
      peerStatus.set(true)
      if (message.ops) receiveOps(message.ops, message.from ?? 'onsite', message.state)
      if (!message.response) broadcastHello(true)
    } else if (message?.type === 'ack') {
      peerStatus.set(true)
    }
  }
}
export function broadcastHello(response = false) {
  const state = get(desk)
  broadcast({ type: 'hello', from: state.meta.side, state: snapshot(state), ops: state.ops, response })
}
export function reconcile() { broadcastHello() }

function entityOf(state: DeskState, kind: string, id: string): unknown {
  switch (kind) {
    case 'speaker': return state.speakers.find(item => item.id === id)
    case 'session': return state.sessions.find(item => item.id === id)
    case 'term': return state.terms.find(item => item.id === id)
    case 'announcement': return state.announcements.find(item => item.id === id)
    case 'cue': return state.cues.find(item => item.id === id)
    case 'reminder': return state.reminders.find(item => item.id === id)
    default: return undefined
  }
}
function describe(kind: string, entity: unknown): string {
  if (!entity) return '（已删除）'
  switch (kind) {
    case 'cue': {
      const cue = entity as Cue
      const status = { pending: '待传', confirmed: '已确认', followup: '有补充' }[cue.status]
      return `${status} · 「${cue.text.slice(0, 24)}${cue.text.length > 24 ? '…' : ''}」`
    }
    case 'term': { const term = entity as Term; return `${term.source} → ${term.target}` }
    case 'announcement': { const item = entity as Announcement; return `${item.visibleOnStage ? '已发布' : '仅后台'} · ${item.text.slice(0, 20)}` }
    case 'session': { const item = entity as Session; return `${item.order}. ${item.title}（${item.time}）` }
    case 'speaker': { const item = entity as Speaker; return item.name }
    case 'reminder': { const item = entity as Reminder; return `提醒 ${item.target}` }
    default: return '已修改'
  }
}
function buildConflict(localState: DeskState, remoteState: DeskState | null, entityId: string, localOps: Op[], remoteOps: Op[]): SyncConflict {
  const kind = localOps[0].kind.split('.')[0] as SyncConflict['entityKind']
  const localEntity = entityOf(localState, kind, entityId)
  const remoteEntity = remoteState ? entityOf(remoteState, kind, entityId) : undefined
  return {
    id: uid('cf'), entityKind: kind, entityId,
    localLabel: describe(kind, localEntity),
    remoteLabel: describe(kind, remoteEntity),
    localSnapshot: localEntity ? structuredClone(localEntity) : null,
    localUpdatedAt: Math.max(...localOps.map(item => item.ts)),
    remoteUpdatedAt: Math.max(...remoteOps.map(item => item.ts)),
    resolved: false
  }
}

/** 接收对端操作：整体在事务中应用，任何一步失败只回退本机，对端不受影响 */
export function receiveOps(remoteOps: Op[], from: Side, remoteState?: DeskState): SyncReport {
  const draft = clone(get(desk))
  const localBefore = clone(get(desk))
  try {
    const known = new Set(draft.ops.map(item => item.id))
    const fresh = remoteOps.filter(item => !known.has(item.id))
    for (const op of fresh) {
      if (!op.id || !op.kind || !op.entityId || typeof op.ts !== 'number') throw new Error('无效同步操作')
      applyOp(draft, op)
      draft.ops.push(op)
    }
    if (remoteState) draft.peerSnapshot = remoteState
    const since = draft.meta.lastSyncAt ?? 0
    const localTouched = new Map<string, Op[]>()
    for (const op of localBefore.ops.filter(item => item.side === localBefore.meta.side && item.ts > since)) {
      const list = localTouched.get(op.entityId) ?? []
      list.push(op)
      localTouched.set(op.entityId, list)
    }
    const conflicts: SyncConflict[] = []
    for (const entityId of new Set(fresh.map(item => item.entityId))) {
      const localOps = localTouched.get(entityId)
      if (!localOps?.length) continue
      if (draft.conflicts.some(item => item.entityId === entityId && !item.resolved)) continue
      conflicts.push(buildConflict(localBefore, draft.peerSnapshot, entityId, localOps, fresh.filter(item => item.entityId === entityId)))
    }
    draft.conflicts.push(...conflicts)
    if (remoteState) draft.peerSnapshot = remoteState
    draft.meta.lastSyncAt = Date.now()
    draft.meta.lastSyncPeer = from
    draft.lastSyncReport = { at: Date.now(), peer: from, received: remoteOps.length, applied: fresh.length, conflicts: conflicts.length, rolledBack: false }
    persist(draft); desk.set(draft)
    broadcast({ type: 'ack', from: draft.meta.side, applied: fresh.length })
    return draft.lastSyncReport
  } catch (error) {
    // 失败只回退出错的这一边：当前本机状态未被改动，原样落盘
    const rolled = clone(get(desk))
    rolled.lastSyncReport = { at: Date.now(), peer: from, received: remoteOps.length, applied: 0, conflicts: 0, rolledBack: true, error: error instanceof Error ? error.message : String(error) }
    persist(rolled); desk.set(rolled)
    return rolled.lastSyncReport
  }
}

function emitEntity(kind: string, entityId: string, entity: unknown) {
  const payload = entity as Record<string, unknown>
  if (kind === 'cue') commit('cue.update', entityId, payload)
  else if (kind === 'term') commit('term.upsert', entityId, payload)
  else if (kind === 'announcement') commit('announcement.upsert', entityId, payload)
  else if (kind === 'session') commit('session.upsert', entityId, payload)
  else if (kind === 'speaker') commit('speaker.upsert', entityId, payload)
  else if (kind === 'reminder') commit('reminder.add', entityId, payload)
}

/** 值班主管对冲突拍板：保留本班 / 采用对方 / 合并双方 */
export function resolveConflict(id: string, resolution: 'local' | 'remote' | 'merge') {
  const state = get(desk)
  const conflict = state.conflicts.find(item => item.id === id)
  if (!conflict || conflict.resolved) return
  const peer = state.peerSnapshot
  if (resolution === 'local') {
    // 保留本班：对端操作已覆盖本机实体，用冲突前的本机快照回退
    if (conflict.localSnapshot) emitEntity(conflict.entityKind, conflict.entityId, conflict.localSnapshot)
  } else if (peer) {
    const localEntity = entityOf(state, conflict.entityKind, conflict.entityId)
    const remoteEntity = entityOf(peer, conflict.entityKind, conflict.entityId)
    if (conflict.entityKind === 'cue' && resolution === 'merge' && localEntity && remoteEntity) {
      const local = localEntity as Cue, remote = remoteEntity as Cue
      const merged: Cue = { ...remote, status: local.status === 'confirmed' ? 'confirmed' : remote.status, followupText: local.followupText || remote.followupText }
      commit('cue.update', conflict.entityId, merged as unknown as Record<string, unknown>)
    } else if (remoteEntity) {
      // 采用对方：对端版本在对账时已应用，无需再发
    }
  }
  const draft = clone(get(desk))
  const target = draft.conflicts.find(item => item.id === id)
  if (target) { target.resolved = true; target.resolution = resolution }
  persist(draft); desk.set(draft)
}

/* ---------------- 换班：导出现场那份为交接包，接班接着处理 ---------------- */
export function buildHandover(): HandoverPackage {
  const state = get(desk)
  return {
    kind: 'cue-desk-handover', version: 1,
    shiftId: state.meta.shiftId, shiftName: state.meta.shiftName,
    exportedAt: new Date().toISOString(), exportedFrom: state.meta.side,
    state: clone(state), ops: clone(state.ops)
  }
}
export function checkHandover(pkg: HandoverPackage): HandoverCheck {
  const state = get(desk)
  const valid = pkg.kind === 'cue-desk-handover' && pkg.version === 1 && Array.isArray(pkg.ops)
  const localOnlyCues = state.cues.filter(cue => !pkg.ops.some(op => op.kind === 'cue.add' && op.entityId === cue.id)).length
  return {
    valid,
    sameShift: valid && pkg.shiftId === state.meta.shiftId,
    localOnlyCues,
    incomingCues: pkg.state?.cues?.length ?? 0,
    localShift: state.meta.shiftName,
    incomingShift: pkg.shiftName
  }
}
export function applyHandover(pkg: HandoverPackage, mode: 'adopt' | 'merge' | 'keep'): SyncReport {
  const before = clone(get(desk))
  try {
    if (pkg.kind !== 'cue-desk-handover' || pkg.version !== 1) throw new Error('交接包格式无效')
    if (mode === 'keep') {
      const report: SyncReport = { at: Date.now(), peer: pkg.exportedFrom, received: 0, applied: 0, conflicts: 0, rolledBack: false, kind: 'handover' }
      const kept = clone(before); kept.lastSyncReport = report
      persist(kept); desk.set(kept)
      return report
    }
    if (pkg.shiftId === before.meta.shiftId) {
      return { ...receiveOps(pkg.ops, pkg.exportedFrom, pkg.state), kind: 'handover' }
    }
    if (mode === 'adopt') {
      const adopted = clone(pkg.state)
      adopted.meta = { ...before.meta, shiftId: pkg.shiftId, shiftName: pkg.shiftName, lastSyncAt: before.meta.lastSyncAt, lastSyncPeer: pkg.exportedFrom }
      adopted.ops = clone(pkg.ops)
      adopted.redoStack = []
      adopted.conflicts = []
      adopted.peerSnapshot = null
      adopted.lastSyncReport = null
      adopted.fontScale = before.fontScale
      adopted.online = before.online
      adopted.liveSimulation = before.liveSimulation
      persist(adopted); desk.set(adopted)
      return { at: Date.now(), peer: pkg.exportedFrom, received: pkg.ops.length, applied: pkg.ops.length, conflicts: 0, rolledBack: false, kind: 'handover' }
    }
    // 合并：接班包作为基线，本班仅在本机产生的操作重放上去
    const localOnlyOps = before.ops.filter(op => !pkg.ops.some(item => item.id === op.id))
    const replayed = replay([...pkg.ops, ...localOnlyOps], { ...before.meta, shiftId: pkg.shiftId, shiftName: pkg.shiftName })
    replayed.peerSnapshot = null
    replayed.redoStack = []
    replayed.conflicts = before.conflicts.filter(item => !item.resolved)
    replayed.fontScale = before.fontScale
    replayed.online = before.online
    replayed.liveSimulation = before.liveSimulation
    replayed.lastSyncReport = null
    persist(replayed); desk.set(replayed)
    return { at: Date.now(), peer: pkg.exportedFrom, received: pkg.ops.length, applied: pkg.ops.length + localOnlyOps.length, conflicts: replayed.conflicts.filter(item => !item.resolved).length, rolledBack: false, kind: 'handover' }
  } catch (error) {
    const rolled = clone(get(desk))
    rolled.lastSyncReport = { at: Date.now(), peer: pkg.exportedFrom, received: 0, applied: 0, conflicts: 0, rolledBack: true, error: error instanceof Error ? error.message : String(error), kind: 'handover' }
    persist(rolled); desk.set(rolled)
    return rolled.lastSyncReport
  }
}

/* ---------------- 术语命中与相似度 ---------------- */
export function staleHits(cue: Cue, terms: Term[]): TermHit[] {
  return cue.termHits.filter(hit => {
    const term = terms.find(item => item.id === hit.termId)
    return Boolean(term && term.revision > hit.revision)
  })
}
function hitsFor(text: string, terms: Term[]): TermHit[] {
  const lower = text.toLowerCase()
  return terms
    .filter(term => lower.includes(term.source.toLowerCase()) || lower.includes(term.target))
    .map(term => ({ termId: term.id, revision: term.revision, source: term.source, target: term.target }))
}
function detectTags(text: string, terms: Term[]): string[] {
  const lower = text.toLowerCase()
  return terms.filter(term => lower.includes(term.source.toLowerCase()) || lower.includes(term.target)).map(term => term.target)
}
function findDuplicate(text: string, cues: Cue[]): Cue | undefined {
  return cues.find(cue => similarity(text, cue.text) >= 0.72)
}
function similarity(a: string, b: string): number {
  const grams = (value: string) => {
    const clean = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    return new Set(Array.from({ length: Math.max(0, clean.length - 1) }, (_, index) => clean.slice(index, index + 2)))
  }
  const left = grams(a), right = grams(b)
  if (!left.size || !right.size) return a.trim() === b.trim() ? 1 : 0
  let intersection = 0
  left.forEach(item => { if (right.has(item)) intersection++ })
  return intersection / (left.size + right.size - intersection)
}

/* ---------------- 展示辅助 ---------------- */
export function getDelay(cue: Cue, now = Date.now()): number { return Math.max(cue.delaySeconds, Math.round((now - cue.receivedAt) / 1000)) }
export function speakerName(state: DeskState, id: string): string { return state.speakers.find(item => item.id === id)?.name || '未指定' }
export function termTarget(state: DeskState, id: string): string { return state.terms.find(item => item.id === id)?.target || '' }
