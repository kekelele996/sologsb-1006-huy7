import { writable, get } from 'svelte/store'
import type {
  Announcement, BackstageState, Cue, CueStatus, FrozenTerm, Reminder, Session, Speaker, SyncEvent, Term
} from './types'
import {
  buildHandoverPackage, buildUpdateMarker, compareHandover, cueDigestHash, detectTerms, eventKey,
  findDuplicate, hashString, makeDispute, stableStringify, termRelatesToCue, verifyHandover
} from './sync'
import type { HandoverPackage, HandoverDispute, LiveState } from './types'

const BACKSTAGE_KEY = 'cue-desk-backstage-v2'
const LIVE_KEY = 'cue-desk-live-v2'
const LEGACY_KEY = 'conference-cue-desk-v1'

const speakersSeed: Speaker[] = [
  { id: 'sp-1', name: 'Dr. Maya Chen', title: '首席气候科学家', language: '英语 → 中文', color: '#0f766e' },
  { id: 'sp-2', name: '刘启明', title: '城市韧性研究员', language: '中文 → 英语', color: '#b45309' },
  { id: 'sp-3', name: 'Prof. Daniel Ortiz', title: '公共卫生政策顾问', language: '西班牙语 → 中文', color: '#6d28d9' },
  { id: 'sp-4', name: '佐藤 美咲', title: '社区能源设计师', language: '日语 → 中文', color: '#be123c' }
]
const sessionsSeed: Session[] = [
  { id: 'se-1', order: 1, time: '09:00', title: '开幕式与议程说明', speakerId: 'sp-2', room: '主会场 A', status: 'done' },
  { id: 'se-2', order: 2, time: '09:20', title: '城市热岛与适应性基础设施', speakerId: 'sp-1', room: '主会场 A', status: 'live' },
  { id: 'se-3', order: 3, time: '10:05', title: '社区健康数据的地方行动', speakerId: 'sp-3', room: '主会场 A', status: 'upcoming' },
  { id: 'se-4', order: 4, time: '10:45', title: '分布式能源与社区共治', speakerId: 'sp-4', room: '主会场 A', status: 'upcoming' }
]
const termsSeed: Term[] = [
  { id: 'term-1', source: 'urban heat island', target: '城市热岛', note: '首次出现完整译出，后可简称热岛', speakerId: 'sp-1', priority: 'high', revision: 1, targetHistory: [] },
  { id: 'term-2', source: 'resilience', target: '韧性', note: '不使用“恢复力”', speakerId: 'sp-1', priority: 'high', revision: 1, targetHistory: [] },
  { id: 'term-3', source: 'co-benefit', target: '协同效益', note: '环境与健康共同收益', speakerId: 'sp-1', priority: 'normal', revision: 1, targetHistory: [] },
  { id: 'term-4', source: 'distributed energy resource', target: '分布式能源资源', note: '缩写 DER', speakerId: 'sp-4', priority: 'high', revision: 1, targetHistory: [] },
  { id: 'term-5', source: 'health equity', target: '健康公平', note: '不译为健康平等', speakerId: 'sp-3', priority: 'high', revision: 1, targetHistory: [] }
]

function freezeOf(termIds: string[]): FrozenTerm[] {
  return termsSeed
    .filter(term => termIds.includes(term.id))
    .map(term => ({ termId: term.id, source: term.source, target: term.target, revision: term.revision }))
}

function initialCues(): Cue[] {
  const now = Date.now()
  return [
    { id: 'cue-101', speakerId: 'sp-1', text: 'The urban heat island effect is not evenly distributed across a city.', receivedAt: now - 36000, status: 'confirmed', manual: false, offline: false, delaySeconds: 4, duplicateOf: null, followupText: '', tags: ['城市热岛'], frozenTerms: freezeOf(['term-1']), confirmedAt: now - 33000, markers: [] },
    { id: 'cue-102', speakerId: 'sp-1', text: 'Neighborhoods with less tree canopy can be several degrees warmer at night.', receivedAt: now - 19000, status: 'confirmed', manual: false, offline: false, delaySeconds: 6, duplicateOf: null, followupText: '补译：“夜间温差可达数摄氏度。”', tags: ['树冠覆盖率'], frozenTerms: [], confirmedAt: now - 16000, markers: [] },
    { id: 'cue-103', speakerId: 'sp-1', text: 'Our resilience strategy links cooling corridors with public health investments.', receivedAt: now - 9000, status: 'pending', manual: false, offline: false, delaySeconds: 11, duplicateOf: null, followupText: '', tags: ['韧性', '协同效益'], frozenTerms: null, confirmedAt: null, markers: [] },
    { id: 'cue-104', speakerId: 'sp-1', text: 'That data also reveals health equity gaps between districts.', receivedAt: now - 2500, status: 'pending', manual: false, offline: false, delaySeconds: 4, duplicateOf: null, followupText: '', tags: ['健康公平'], frozenTerms: null, confirmedAt: null, markers: [] }
  ]
}

function emptySync(online: boolean) {
  return { online, outbox: [] as SyncEvent[], journal: [] as SyncEvent[], lastReconciledAt: null as number | null, lastReconcileSummary: '尚未对账。' }
}

function demoBackstage(online: boolean): BackstageState {
  return {
    speakers: structuredClone(speakersSeed),
    sessions: structuredClone(sessionsSeed),
    terms: structuredClone(termsSeed),
    announcements: [
      { id: 'ann-1', level: 'info', text: '十点整有消防联动测试，请提醒会场人员保持镇定。', visibleOnStage: false, createdAt: new Date().toISOString() },
      { id: 'ann-2', level: 'urgent', text: '请下一位发言人提前到侧台候场。', visibleOnStage: false, createdAt: new Date().toISOString() }
    ],
    liveFeedback: [
      { cueId: 'cue-101', text: 'The urban heat island effect is not evenly distributed across a city.', status: 'confirmed', at: Date.now() - 33000 },
      { cueId: 'cue-102', text: 'Neighborhoods with less tree canopy can be several degrees warmer at night.', status: 'confirmed', at: Date.now() - 16000 }
    ],
    eventSeq: 0,
    sync: emptySync(online),
    updatedAt: new Date().toISOString()
  }
}

function demoLive(online: boolean): LiveState {
  return {
    speakers: structuredClone(speakersSeed),
    sessions: structuredClone(sessionsSeed),
    terms: structuredClone(termsSeed),
    announcements: [],
    cues: initialCues(),
    reminders: [],
    activeCueId: 'cue-103',
    fontScale: 100,
    liveSimulation: true,
    shift: { operator: '本班口译员', startedAt: Date.now() },
    handoverDisputes: [],
    eventSeq: 0,
    sync: emptySync(online),
    updatedAt: new Date().toISOString()
  }
}

function clone<T>(value: T): T { return structuredClone(value) }

type Persistable = BackstageState | LiveState
function load<T extends Persistable>(key: string, fallback: () => T): T {
  if (typeof localStorage === 'undefined') return fallback()
  try {
    const saved = localStorage.getItem(key)
    if (!saved) return fallback()
    const parsed = JSON.parse(saved) as T
    return { ...fallback(), ...parsed, sync: { ...emptySync(navigator.onLine), ...parsed.sync, online: navigator.onLine } }
  } catch {
    return fallback()
  }
}

export const backstage = writable<BackstageState>(load(BACKSTAGE_KEY, () => demoBackstage(true)))
export const live = writable<LiveState>(load(LIVE_KEY, () => demoLive(true)))

if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_KEY)

// —— 提交与撤销/重做（按最近操作的一侧回退） ——

const history: { side: 'b' | 'l'; state: BackstageState | LiveState }[] = []
const future: { side: 'b' | 'l'; state: BackstageState | LiveState }[] = []

function persist(state: BackstageState | LiveState) {
  state.updatedAt = new Date().toISOString()
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(BACKSTAGE_KEY, JSON.stringify(get(backstage)))
  localStorage.setItem(LIVE_KEY, JSON.stringify(get(live)))
}

function commitB(recipe: (state: BackstageState) => void, track = true) {
  const current = clone(get(backstage))
  const next = clone(current)
  recipe(next)
  if (track) { history.push({ side: 'b', state: current }); if (history.length > 80) history.shift(); future.length = 0 }
  backstage.set(next)
  persist(next)
  scheduleReconcile()
}

function commitL(recipe: (state: LiveState) => void, track = true) {
  const current = clone(get(live))
  const next = clone(current)
  recipe(next)
  if (track) { history.push({ side: 'l', state: current }); if (history.length > 80) history.shift(); future.length = 0 }
  live.set(next)
  persist(next)
  scheduleReconcile()
}

/** 不进撤销栈、不触发对账的元数据提交（对账结果、连通性）。 */
function patchB(recipe: (state: BackstageState) => void) { const next = clone(get(backstage)); recipe(next); backstage.set(next); persist(next) }
function patchL(recipe: (state: LiveState) => void) { const next = clone(get(live)); recipe(next); live.set(next); persist(next) }

export function undoDesk() {
  const entry = history.pop()
  if (!entry) return
  future.push({ side: entry.side, state: clone(entry.side === 'b' ? get(backstage) : get(live)) })
  if (entry.side === 'b') backstage.set(entry.state as BackstageState)
  else live.set(entry.state as LiveState)
  persist(entry.state)
}
export function redoDesk() {
  const entry = future.pop()
  if (!entry) return
  history.push({ side: entry.side, state: clone(entry.side === 'b' ? get(backstage) : get(live)) })
  if (entry.side === 'b') backstage.set(entry.state as BackstageState)
  else live.set(entry.state as LiveState)
  persist(entry.state)
}
export const canUndo = () => history.length > 0
export const canRedo = () => future.length > 0

// —— 事件箱 ——

function pushEvent(state: BackstageState | LiveState, direction: SyncEvent['direction'], type: SyncEvent['type'], payload: unknown) {
  state.eventSeq += 1
  state.sync.outbox.push({ id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seq: state.eventSeq, direction, type, at: Date.now(), payload } as SyncEvent)
}

function rosterPayload(state: BackstageState) {
  return { speakers: state.speakers, sessions: state.sessions }
}

// —— 后台准备端操作 ——

export function addSpeaker() {
  commitB(state => {
    state.speakers.push({ id: `sp-${Date.now()}`, name: '新发言人', title: '待填写机构与职务', language: '待设置语言方向', color: '#475569' })
    pushEvent(state, 'backstage-to-live', 'roster-updated', rosterPayload(state))
  })
}
export function updateSpeaker(id: string, patch: Partial<Speaker>) {
  commitB(state => {
    const item = state.speakers.find(row => row.id === id)
    if (item) Object.assign(item, patch)
    pushEvent(state, 'backstage-to-live', 'roster-updated', rosterPayload(state))
  })
}
export function addSession() {
  commitB(state => {
    state.sessions.push({ id: `se-${Date.now()}`, order: Math.max(0, ...state.sessions.map(item => item.order)) + 1, time: '11:30', title: '新演讲', speakerId: state.speakers[0]?.id || '', room: '主会场 A', status: 'upcoming' })
    pushEvent(state, 'backstage-to-live', 'roster-updated', rosterPayload(state))
  })
}
export function updateSession(id: string, patch: Partial<Session>) {
  commitB(state => {
    const item = state.sessions.find(row => row.id === id)
    if (item) Object.assign(item, patch)
    pushEvent(state, 'backstage-to-live', 'roster-updated', rosterPayload(state))
  })
}

export function addTerm() {
  commitB(state => {
    const term: Term = { id: `term-${Date.now()}`, source: 'new term', target: '新术语', note: '', speakerId: state.speakers[0]?.id || '', priority: 'normal', revision: 1, targetHistory: [] }
    state.terms.push(term)
    pushEvent(state, 'backstage-to-live', 'term-upserted', term)
  })
}
export function updateTerm(id: string, patch: Partial<Term>) {
  commitB(state => {
    const term = state.terms.find(row => row.id === id)
    if (!term) return
    const nextTarget = patch.target?.trim()
    if (nextTarget && nextTarget !== term.target) {
      // 新译法：修订号 +1，旧译法留痕，随事件立即下发现场端
      term.targetHistory.unshift({ target: term.target, revisedAt: Date.now() })
      if (term.targetHistory.length > 10) term.targetHistory.length = 10
      term.target = nextTarget
      term.revision += 1
    }
    if (patch.source !== undefined) term.source = patch.source
    if (patch.note !== undefined) term.note = patch.note
    if (patch.speakerId !== undefined) term.speakerId = patch.speakerId
    if (patch.priority !== undefined) term.priority = patch.priority
    pushEvent(state, 'backstage-to-live', 'term-upserted', clone(term))
  })
}

export function addAnnouncement(text: string, level: Announcement['level']) {
  if (!text.trim()) return
  commitB(state => {
    state.announcements.unshift({ id: `ann-${Date.now()}`, level, text: text.trim(), visibleOnStage: false, createdAt: new Date().toISOString() })
  })
}
export function publishAnnouncement(id: string, visible: boolean) {
  commitB(state => {
    const item = state.announcements.find(row => row.id === id)
    if (!item) return
    item.visibleOnStage = visible
    pushEvent(state, 'backstage-to-live', visible ? 'announcement-published' : 'announcement-recalled', visible ? clone(item) : { id })
  })
}

// —— 现场运行端操作 ——

export function setLiveSimulation(enabled: boolean) { commitL(state => { state.liveSimulation = enabled }) }
export function setActiveCue(id: string) { commitL(state => { state.activeCueId = id }) }
export function moveCue(direction: 1 | -1) {
  const state = get(live)
  const index = state.cues.findIndex(item => item.id === state.activeCueId)
  const next = state.cues[index + direction]
  if (next) setActiveCue(next.id)
}
export function setFontScale(scale: number) { commitL(state => { state.fontScale = Math.min(150, Math.max(85, scale)) }) }
export function setOperator(name: string) { commitL(state => { state.shift.operator = name.trim() || '未署名口译员' }) }

export function ingestCue(text: string, options: { manual?: boolean; speakerId?: string; receivedAt?: number } = {}) {
  const trimmed = text.trim()
  if (!trimmed) return
  commitL(state => {
    const existing = state.cues.filter(item => item.text !== trimmed)
    const duplicate = findDuplicate(trimmed, existing)
    const speakerId = options.speakerId || state.sessions.find(item => item.status === 'live')?.speakerId || state.speakers[0]?.id || ''
    const receivedAt = options.receivedAt || Date.now()
    const cue: Cue = {
      id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, speakerId, text: trimmed, receivedAt,
      status: 'pending', manual: Boolean(options.manual), offline: !state.sync.online,
      delaySeconds: Math.max(0, Math.round((Date.now() - receivedAt) / 1000)),
      duplicateOf: duplicate?.id || null, followupText: '', tags: detectTerms(trimmed, state.terms),
      frozenTerms: null, confirmedAt: null, markers: []
    }
    state.cues.push(cue)
    state.activeCueId = cue.id
    pushEvent(state, 'live-to-backstage', 'live-progress', { cueId: cue.id, text: cue.text, status: cue.status, at: Date.now() })
  })
}

export function updateCue(id: string, patch: Partial<Cue>) {
  commitL(state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return
    Object.assign(cue, patch)
    pushEvent(state, 'live-to-backstage', 'live-progress', { cueId: cue.id, text: cue.text, status: cue.status, at: Date.now() })
  })
}

export function setCueStatus(id: string, status: CueStatus) {
  commitL(state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return
    cue.status = status
    // 离开待传队列的瞬间冻结当时译法；之后稿件不再随术语表变化
    if (status !== 'pending' && cue.frozenTerms === null) {
      cue.frozenTerms = state.terms
        .filter(term => termRelatesToCue(term, cue))
        .map(term => ({ termId: term.id, source: term.source, target: term.target, revision: term.revision }))
      cue.confirmedAt = Date.now()
    }
    pushEvent(state, 'live-to-backstage', 'live-progress', { cueId: cue.id, text: cue.text, status: cue.status, at: Date.now() })
  })
}
export function deleteCue(id: string) {
  commitL(state => {
    state.cues = state.cues.filter(item => item.id !== id)
    if (state.activeCueId === id) state.activeCueId = state.cues.at(-1)?.id || ''
    pushEvent(state, 'live-to-backstage', 'live-progress', { cueId: id, status: 'deleted', at: Date.now() })
  })
}
export function clearDuplicate(id: string) { commitL(state => { const cue = state.cues.find(item => item.id === id); if (cue) cue.duplicateOf = null }) }
export function markMarkerSeen(cueId: string, markerId: string) {
  commitL(state => {
    const cue = state.cues.find(item => item.id === cueId)
    const marker = cue?.markers.find(item => item.id === markerId)
    if (marker) marker.seen = true
  })
}

export function sendReminder(termId: string, cueId: string) {
  commitL(state => {
    const exists = state.reminders.some(item => item.termId === termId && item.cueId === cueId)
    if (exists) return
    state.reminders.unshift({ id: `rem-${Date.now()}`, termId, cueId, target: state.terms.find(item => item.id === termId)?.target || '', createdAt: Date.now(), acknowledged: false })
  })
}
export function acknowledgeReminder(id: string) { commitL(state => { const item = state.reminders.find(row => row.id === id); if (item) item.acknowledged = true }) }

// —— 连通性 ——

export function setSideOnline(side: 'b' | 'l', online: boolean) {
  if (side === 'b') patchB(state => { state.sync.online = online })
  else patchL(state => { state.sync.online = online })
  if (online) scheduleReconcile()
}

// —— 对账：两侧各自事务，失败只回退出错的一侧 ——

let reconcileQueued = false
function scheduleReconcile() {
  if (reconcileQueued) return
  reconcileQueued = true
  queueMicrotask(() => { reconcileQueued = false; reconcile() })
}
export function reconcile(): { ran: boolean; reason?: string } {
  const b0 = get(backstage), l0 = get(live)
  if (!b0.sync.online || !l0.sync.online) {
    return { ran: false, reason: '两端未同时在线，事件留在各自待发箱，继续本地记录。' }
  }

  const fromBackstage = [...b0.sync.outbox].filter(event => event.direction === 'backstage-to-live').sort((a, b) => a.seq - b.seq)
  const fromLive = [...l0.sync.outbox].filter(event => event.direction === 'live-to-backstage').sort((a, b) => a.seq - b.seq)
  const knownLive = new Set(l0.sync.journal.map(eventKey))
  const knownBackstage = new Set(b0.sync.journal.map(eventKey))

  // —— 现场端：逐条事务应用后台事件；坏事件只回退该条并留在待发箱，其余照常 ——
  const lDraft = clone(l0)
  const bApplied: SyncEvent[] = []
  const liveFailures: { event: SyncEvent; error: string }[] = []
  for (const cue of lDraft.cues) {
    if (cue.offline) {
      cue.offline = false
      const duplicate = findDuplicate(cue.text, lDraft.cues.filter(item => item.id !== cue.id))
      cue.duplicateOf = duplicate?.id || null
    }
  }
  for (const event of fromBackstage) {
    if (knownLive.has(eventKey(event))) { bApplied.push(event); continue }
    const before = clone(lDraft)
    try {
      applyEventToLive(lDraft, event)
      bApplied.push(event)
    } catch (error) {
      // 回滚这一条事件对现场端草稿的影响，事件留在后台待发箱等待修复重试
      Object.assign(lDraft, before)
      liveFailures.push({ event, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const liveError: string | null = liveFailures.length
    ? `${liveFailures.length} 条报文失败并已单条回滚：${liveFailures.map(item => `#${item.event.seq}（${item.error}）`).join('；')}`
    : null

  // —— 后台端：逐条事务应用现场回传 ——
  const bDraft = clone(b0)
  const lApplied: SyncEvent[] = []
  const backstageFailures: { event: SyncEvent; error: string }[] = []
  for (const event of fromLive) {
    if (knownBackstage.has(eventKey(event))) { lApplied.push(event); continue }
    const before = clone(bDraft)
    try {
      applyEventToBackstage(bDraft, event)
      lApplied.push(event)
    } catch (error) {
      Object.assign(bDraft, before)
      backstageFailures.push({ event, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const backstageError: string | null = backstageFailures.length
    ? `${backstageFailures.length} 条报文失败并已单条回滚：${backstageFailures.map(item => `#${item.event.seq}（${item.error}）`).join('；')}`
    : null

  const bAppliedKeys = new Set(bApplied.map(eventKey))
  const lAppliedKeys = new Set(lApplied.map(eventKey))

  // 现场端草稿只含“成功应用”这一副作用，坏事件未生效：整体提交安全
  {
    const received = bApplied.filter(event => !knownLive.has(eventKey(event))).length
    lDraft.sync.journal.push(...bApplied.filter(event => !knownLive.has(eventKey(event))))
    lDraft.sync.outbox = lDraft.sync.outbox.filter(event => !lAppliedKeys.has(eventKey(event)))
    lDraft.sync.lastReconciledAt = Date.now()
    lDraft.sync.lastReconcileSummary = liveError
      ? `对账完成（现场端）：接收 ${received} 条，发出 ${lApplied.length} 条；${liveError}。坏报文已退回后台待发箱，不影响其他同步。`
      : `对账完成：接收后台 ${received} 条，发出 ${lApplied.length} 条。`
    live.set(lDraft)
    persist(lDraft)
  }

  {
    const received = lApplied.filter(event => !knownBackstage.has(eventKey(event))).length
    bDraft.sync.journal.push(...lApplied.filter(event => !knownBackstage.has(eventKey(event))))
    bDraft.sync.outbox = bDraft.sync.outbox.filter(event => !bAppliedKeys.has(eventKey(event)))
    bDraft.sync.lastReconciledAt = Date.now()
    bDraft.sync.lastReconcileSummary = backstageError
      ? `对账完成（后台端）：接收 ${received} 条，发出 ${bApplied.length} 条；${backstageError}。坏报文已退回现场待发箱，不影响其他同步。`
      : `对账完成：接收现场 ${received} 条，发出 ${bApplied.length} 条。`
    backstage.set(bDraft)
    persist(bDraft)
  }

  return { ran: true }
}

function requireObject(payload: unknown, label: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error(`${label}报文格式损坏`)
  return payload as Record<string, unknown>
}

function applyEventToLive(state: LiveState, event: SyncEvent) {
  switch (event.type) {
    case 'roster-updated': {
      const payload = requireObject(event.payload, '名单')
      if (!Array.isArray(payload.speakers) || !Array.isArray(payload.sessions)) throw new Error('名单报文缺少发言人与场次')
      state.speakers = clone(payload.speakers) as Speaker[]
      state.sessions = clone(payload.sessions) as Session[]
      return
    }
    case 'term-upserted': {
      const payload = requireObject(event.payload, '术语')
      if (typeof payload.id !== 'string' || typeof payload.target !== 'string' || typeof payload.revision !== 'number') {
        throw new Error('术语报文缺少编号、译法或修订号')
      }
      const incoming = clone(payload) as unknown as Term
      const index = state.terms.findIndex(term => term.id === incoming.id)
      if (index === -1) {
        state.terms.push(incoming)
      } else {
        const local = state.terms[index]
        const targetChanged = incoming.revision > local.revision && incoming.target !== local.target
        const oldTarget = local.target
        state.terms[index] = incoming
        if (targetChanged) {
          // 未确认稿件：直接按新译法刷新标签；已确认稿件：只加“译法已更新”标注，原文不改
          for (const cue of state.cues) {
            if (cue.frozenTerms === null) {
              cue.tags = detectTerms(cue.text, state.terms)
            } else if (termRelatesToCue(incoming, cue) && !cue.markers.some(marker => marker.id === `marker-${incoming.id}-r${incoming.revision}`)) {
              cue.markers.push(buildUpdateMarker(incoming, oldTarget, Date.now()))
            }
          }
        }
      }
      return
    }
    case 'announcement-published': {
      const payload = requireObject(event.payload, '通知')
      if (typeof payload.id !== 'string' || typeof payload.text !== 'string') throw new Error('通知报文缺少编号或正文')
      const announcement = clone(payload) as unknown as Announcement
      announcement.visibleOnStage = true
      const index = state.announcements.findIndex(item => item.id === announcement.id)
      if (index === -1) state.announcements.unshift(announcement)
      else state.announcements[index] = announcement
      return
    }
    case 'announcement-recalled': {
      const payload = requireObject(event.payload, '撤下通知')
      if (typeof payload.id !== 'string') throw new Error('撤下通知报文缺少编号')
      state.announcements = state.announcements.filter(item => item.id !== payload.id)
      return
    }
    default:
      throw new Error(`现场端无法识别的报文类型：${event.type}`)
  }
}

function applyEventToBackstage(state: BackstageState, event: SyncEvent) {
  switch (event.type) {
    case 'live-progress': {
      const payload = requireObject(event.payload, '现场进度')
      if (typeof payload.cueId !== 'string' || typeof payload.status !== 'string') throw new Error('现场进度报文缺少稿件编号或状态')
      if (payload.status === 'deleted') {
        state.liveFeedback = state.liveFeedback.filter(item => item.cueId !== payload.cueId)
        return
      }
      if (typeof payload.text !== 'string') throw new Error('现场进度报文缺少正文')
      const entry = { cueId: payload.cueId as string, text: payload.text as string, status: payload.status as Cue['status'], at: (payload.at as number) || Date.now() }
      state.liveFeedback = [entry, ...state.liveFeedback.filter(item => item.cueId !== entry.cueId)].slice(0, 60)
      return
    }
    default:
      throw new Error(`后台端无法识别的报文类型：${event.type}`)
  }
}

/** 故障注入：把指定端待发箱最新事件改成坏报文，用于演示“整侧回滚”。 */
export function corruptNextOutboxEvent(side: 'b' | 'l') {
  const mutate = (state: BackstageState | LiveState) => {
    const event = state.sync.outbox.at(-1)
    if (event) event.payload = { corrupted: true, reason: '模拟链路报文损坏' }
  }
  if (side === 'b') patchB(mutate)
  else patchL(mutate)
}

// —— 交接包 ——

export function exportHandover(): { json: string; pkg: HandoverPackage } {
  const state = get(live)
  const pkg = buildHandoverPackage(state.cues, state.reminders, state.terms, state.shift.operator, `shift-${state.shift.startedAt}`)
  return { json: JSON.stringify(pkg, null, 2), pkg }
}

export interface ImportResult {
  outcome: 'adopted' | 'mismatch' | 'invalid'
  errors: string[]
  dispute?: HandoverDispute
}

export function importHandover(json: string, nextOperator: string): ImportResult {
  const verification = verifyHandover(json)
  if (!verification.ok || !verification.pkg) return { outcome: 'invalid', errors: verification.errors }

  const state = get(live)
  const comparison = compareHandover(verification.pkg, state.cues, state.terms)
  if (!comparison.matches) {
    const dispute = makeDispute(verification.pkg, comparison.details, '交接包与本班记录对不上', json)
    commitL(draft => { draft.handoverDisputes.unshift(dispute) }, false)
    return { outcome: 'mismatch', errors: comparison.details, dispute }
  }
  adoptPackage(verification.pkg, nextOperator)
  return { outcome: 'adopted', errors: [] }
}

function adoptPackage(pkg: HandoverPackage, nextOperator: string) {
  commitL(state => {
    state.cues = structuredClone(pkg.cues)
    state.reminders = structuredClone(pkg.reminders)
    state.activeCueId = state.cues.find(cue => cue.status === 'pending')?.id || state.cues.at(-1)?.id || ''
    state.shift = { operator: nextOperator.trim() || pkg.operator, startedAt: Date.now() }
  }, false)
}

export function resolveDispute(id: string, verdict: 'accepted' | 'rejected', supervisor: string): string[] {
  const state = get(live)
  const dispute = state.handoverDisputes.find(item => item.id === id)
  if (!dispute || dispute.verdict !== 'pending') return ['未找到待裁定的交接争议。']
  if (!supervisor.trim()) return ['请先填写值班主管姓名。']
  if (verdict === 'rejected') {
    commitL(draft => {
      const item = draft.handoverDisputes.find(row => row.id === id)
      if (item) { item.verdict = 'rejected'; item.supervisor = supervisor.trim(); item.resolvedAt = Date.now() }
    }, false)
    return []
  }
  const verification = verifyHandover(dispute.packageData)
  if (!verification.ok || !verification.pkg) return verification.errors
  adoptPackage(verification.pkg, supervisor.trim() ? `${state.shift.operator}（主管 ${supervisor.trim()} 核定接班）` : state.shift.operator)
  patchL(draft => {
    const item = draft.handoverDisputes.find(row => row.id === id)
    if (item) { item.verdict = 'accepted'; item.supervisor = supervisor.trim(); item.resolvedAt = Date.now() }
  })
  return []
}

// —— 展示辅助 ——

export function getDelay(cue: Cue, now = Date.now()): number { return Math.max(cue.delaySeconds, Math.round((now - cue.receivedAt) / 1000)) }
export function speakerName(state: LiveState | BackstageState, id: string): string { return state.speakers.find(item => item.id === id)?.name || '未指定' }
export function termTarget(state: LiveState, id: string): string { return state.terms.find(item => item.id === id)?.target || '' }
export function digestOf(cue: Cue): string { return cueDigestHash(cue) }
export { hashString, stableStringify }
