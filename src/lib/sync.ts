import type {
  Cue,
  CueStatus,
  HandoverDispute,
  HandoverPackage,
  SyncEvent,
  Term,
  TermUpdateMarker
} from './types'

// —— 确定性哈希（FNV-1a，交接包校验用，无需加密强度） ——

export function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

// —— 术语工具 ——

export function detectTerms(text: string, terms: Term[]): string[] {
  const lower = text.toLowerCase()
  return terms
    .filter(term => lower.includes(term.source.toLowerCase()) || lower.includes(term.target))
    .map(term => term.target)
}

/** 相关段落：原文或已确认文本命中该术语的源语/任一历史译法。 */
export function termRelatesToCue(term: Term, cue: Cue): boolean {
  const haystack = cue.text.toLowerCase()
  const needles = [term.source, term.target, ...term.targetHistory.map(item => item.target)]
    .map(value => value.toLowerCase())
    .filter(Boolean)
  return needles.some(needle => haystack.includes(needle))
}

/** 已确认稿件上生成“译法已更新”标注；同一条译法更新只标注一次。 */
export function buildUpdateMarker(term: Term, oldTarget: string, now: number): TermUpdateMarker {
  return {
    id: `marker-${term.id}-r${term.revision}`,
    termId: term.id,
    source: term.source,
    oldTarget,
    newTarget: term.target,
    newRevision: term.revision,
    markedAt: now,
    seen: false
  }
}

// —— 相似度与重复检测 ——

export function findDuplicate(text: string, cues: Cue[]): Cue | undefined {
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

// —— 交接包 ——

export function cueDigestHash(cue: Cue): string {
  return hashString(stableStringify({
    text: cue.text,
    followupText: cue.followupText,
    status: cue.status,
    frozen: (cue.frozenTerms || []).map(item => `${item.termId}@${item.revision}:${item.target}`),
    markers: cue.markers.map(marker => marker.id)
  }))
}

export function buildHandoverPackage(
  cues: Cue[],
  reminders: HandoverPackage['reminders'],
  terms: Term[],
  operator: string,
  shiftId: string
): HandoverPackage {
  const counts = (status: CueStatus) => cues.filter(cue => cue.status === status).length
  const pkg: HandoverPackage = {
    format: 'cue-desk-handover',
    version: 1,
    shiftId,
    operator: operator.trim() || '本班口译员',
    handedAt: new Date().toISOString(),
    stats: {
      pending: counts('pending'),
      followup: counts('followup'),
      confirmed: counts('confirmed'),
      offline: cues.filter(cue => cue.offline).length,
      marked: cues.filter(cue => cue.markers.some(marker => !marker.seen)).length
    },
    cueDigests: cues.map(cue => ({ cueId: cue.id, status: cue.status, hash: cueDigestHash(cue) })),
    termRevisionFingerprint: hashString(stableStringify(
      [...terms].sort((a, b) => a.id.localeCompare(b.id)).map(term => ({ id: term.id, revision: term.revision, target: term.target }))
    )),
    cues: structuredClone(cues),
    reminders: structuredClone(reminders),
    checksum: ''
  }
  const { checksum: _ignored, ...body } = pkg
  pkg.checksum = hashString(stableStringify(body))
  return pkg
}

export interface HandoverVerification {
  ok: boolean
  errors: string[]
  pkg: HandoverPackage | null
}

export function verifyHandover(json: string): HandoverVerification {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, errors: ['交接包不是合法 JSON，可能已损坏或被截断。'], pkg: null }
  }
  const pkg = parsed as Partial<HandoverPackage>
  if (pkg.format !== 'cue-desk-handover' || pkg.version !== 1) errors.push('交接包格式或版本不被支持。')
  if (!Array.isArray(pkg.cueDigests) || !Array.isArray(pkg.cues)) errors.push('交接包缺少稿件清单。')
  const { checksum: _ignored, ...body } = pkg as HandoverPackage
  if (!pkg.checksum || hashString(stableStringify(body)) !== pkg.checksum) errors.push('交接包校验和不一致，内容可能已被改动。')
  return { ok: errors.length === 0, errors, pkg: errors.length === 0 ? (pkg as HandoverPackage) : null }
}

/** 接班核对：逐条比对本班稿件与交接包。 */
export interface HandoverComparison {
  matches: boolean
  details: string[]
}

export function compareHandover(pkg: HandoverPackage, currentCues: Cue[], currentTerms: Term[]): HandoverComparison {
  const details: string[] = []
  const currentById = new Map(currentCues.map(cue => [cue.id, cue]))

  for (const digest of pkg.cueDigests) {
    const local = currentById.get(digest.cueId)
    if (!local) {
      details.push(`交接包中的稿件 ${digest.cueId} 在本班不存在（状态：${statusLabel(digest.status)}）。`)
      continue
    }
    if (local.status !== digest.status) {
      details.push(`稿件 ${digest.cueId} 状态不一致：本班为「${statusLabel(local.status)}」，交接包为「${statusLabel(digest.status)}」。`)
    }
    if (cueDigestHash(local) !== digest.hash) {
      details.push(`稿件 ${digest.cueId} 内容/译法快照与交班时不一致。`)
    }
  }

  for (const cue of currentCues) {
    if (!pkg.cueDigests.some(digest => digest.cueId === cue.id)) {
      details.push(`本班稿件 ${cue.id} 不在交接包中，属于交班后新增内容。`)
    }
  }

  const localFingerprint = hashString(stableStringify(
    [...currentTerms].sort((a, b) => a.id.localeCompare(b.id)).map(term => ({ id: term.id, revision: term.revision, target: term.target }))
  ))
  if (localFingerprint !== pkg.termRevisionFingerprint) {
    details.push('术语表修订版本与交班时不一致（交班后后台可能又更新了译法）。')
  }

  return { matches: details.length === 0, details }
}

export function statusLabel(status: CueStatus): string {
  return ({ pending: '待传', confirmed: '已确认', followup: '有补充' })[status]
}

// —— 对账（事件箱交换） ——

/** 应用对端事件时的结果；失败信息按事件返回，便于只回退出错的一侧。 */
export interface ReconcileResult {
  applied: SyncEvent[]
  errors: { event: SyncEvent; error: string }[]
  summary: string
}

export function eventKey(event: SyncEvent): string {
  return `${event.direction}:${event.seq}:${event.id}`
}

export function makeDispute(
  pkg: HandoverPackage,
  details: string[],
  reason: string,
  raw: string
): HandoverDispute {
  return {
    id: `dispute-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    importedAt: Date.now(),
    incomingOperator: pkg.operator,
    reason,
    mismatchDetails: details,
    supervisor: '',
    verdict: 'pending',
    resolvedAt: null,
    packageData: raw
  }
}
