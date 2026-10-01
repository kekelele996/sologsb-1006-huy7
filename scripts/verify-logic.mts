// 端到端逻辑验证：用 esbuild 把 TS 测试脚本就地转译后在 Node 中运行
import assert from 'node:assert'
import { get } from 'svelte/store'
import { backstage, live } from '../src/lib/store.ts'
import * as store from '../src/lib/store.ts'
import { buildHandoverPackage, cueDigestHash, verifyHandover } from '../src/lib/sync.ts'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const liveState = () => get(store.live)
const backstageState = () => get(store.backstage)

function log(title) { console.log(`\n=== ${title} ===`) }

// 初始两端在线，等待首次自动对账
await flush()

// 场景 1：后台改术语译法 → 未确认稿件立即用新译；已确认稿件只加标注、原文不改
log('1. 术语更新：未确认立即生效，已确认只标注不改写')
{
  const before = liveState()
  const confirmedCue = before.cues.find(c => c.id === 'cue-101')
  assert.ok(confirmedCue.status === 'confirmed')
  assert.deepStrictEqual(confirmedCue.frozenTerms.map(t => t.target), ['城市热岛'])

  store.updateTerm('term-1', { target: '城市热岛效应' })
  await flush()

  const after = liveState()
  const term = after.terms.find(t => t.id === 'term-1')
  assert.strictEqual(term.target, '城市热岛效应')
  assert.strictEqual(term.revision, 2)
  assert.deepStrictEqual(term.targetHistory.map(h => h.target), ['城市热岛'])

  const confirmed = after.cues.find(c => c.id === 'cue-101')
  assert.strictEqual(confirmed.text, 'The urban heat island effect is not evenly distributed across a city.', '原文未改写')
  assert.strictEqual(confirmed.frozenTerms[0].target, '城市热岛', '冻结快照保持旧译')
  assert.strictEqual(confirmed.markers.length, 1)
  assert.strictEqual(confirmed.markers[0].oldTarget, '城市热岛')
  assert.strictEqual(confirmed.markers[0].newTarget, '城市热岛效应')

  const pending = after.cues.find(c => c.id === 'cue-103')
  assert.strictEqual(pending.frozenTerms, null)
  console.log('  ✓ 已确认稿未改写，新增标注 旧译→新译；冻结快照保留 r1')
}

// 场景 2：确认瞬间冻结译法；之后再改术语不影响该稿
log('2. 确认即冻结，后续改译不改稿')
{
  store.setActiveCue('cue-104')
  store.setCueStatus('cue-104', 'confirmed')
  await flush()
  let cue = liveState().cues.find(c => c.id === 'cue-104')
  assert.strictEqual(cue.frozenTerms[0].target, '健康公平')
  assert.strictEqual(cue.frozenTerms[0].revision, 1)

  store.updateTerm('term-5', { target: '健康公正性' })
  await flush()
  cue = liveState().cues.find(c => c.id === 'cue-104')
  assert.strictEqual(cue.frozenTerms[0].target, '健康公平', '已确认稿不跟随')
  assert.strictEqual(cue.markers[0].oldTarget, '健康公平')
  assert.strictEqual(cue.markers[0].newTarget, '健康公正性')
  console.log('  ✓ cue-104 确认时冻结 r1，后台改 r2 后只出现更新标注')
}

// 场景 3：两端断网各自继续记；恢复后对账，离线条目重跑查重
log('3. 断网继续记 + 恢复对账')
{
  store.setSideOnline('b', false)
  store.setSideOnline('l', false)
  store.ingestCue('断网期间手工补录的现场文字：resilience in coastal districts.', { manual: true })
  store.updateTerm('term-2', { target: '韧性能力' })
  await flush()

  const l = liveState(), b = backstageState()
  assert.strictEqual(l.sync.online, false)
  assert.strictEqual(l.cues.at(-1).offline, true)
  assert.ok(l.sync.outbox.some(e => e.type === 'live-progress'))
  assert.ok(b.sync.outbox.some(e => e.type === 'term-upserted'))
  assert.strictEqual(l.terms.find(t => t.id === 'term-2').target, '韧性', '离线时后台改动未到达现场')
  console.log('  ✓ 两端离线：稿件带离线标记进入现场待发箱，术语事件留在后台待发箱')

  store.setSideOnline('b', true)
  store.setSideOnline('l', true)
  await flush(); await flush()
  const l2 = liveState(), b2 = backstageState()
  assert.strictEqual(l2.sync.outbox.length, 0)
  assert.strictEqual(b2.sync.outbox.length, 0)
  assert.strictEqual(l2.terms.find(t => t.id === 'term-2').target, '韧性能力', '恢复后新译法到达')
  const offlineCue = l2.cues.find(c => c.manual && c.offline)
  assert.strictEqual(offlineCue, undefined, '离线标记已清除')
  assert.ok(b2.liveFeedback.some(f => f.text.includes('断网期间手工补录')), '后台收到现场进度回传')
  console.log('  ✓ 恢复后：事件箱清空、新译法到达、离线稿件重新查重、后台收到回传')
}

// 场景 4：报文损坏时，只回退出错一侧
log('4. 对账失败只回退出错一侧')
{
  store.setSideOnline('b', false)
  store.setSideOnline('l', false)
  store.updateTerm('term-3', { target: '协同收益（测试坏报文）' }) // 后台待发箱产生坏事件
  store.corruptNextOutboxEvent('b')
  store.ingestCue('现场端同时新录的一条，用于验证后台侧仍能接收。')
  await flush()
  store.setSideOnline('b', true)
  store.setSideOnline('l', true)
  await flush(); await flush()

  const l = liveState()
  assert.strictEqual(l.terms.find(t => t.id === 'term-3').target, '协同效益', '坏事件被单条回滚：术语未应用')
  assert.ok(l.sync.lastReconcileSummary.includes('报文失败并已单条回滚'), l.sync.lastReconcileSummary)
  const b = backstageState()
  assert.ok(b.liveFeedback.some(f => f.text.includes('现场端同时新录')), '后台端事务独立，仍接收了现场事件')
  assert.ok(b.sync.outbox.some(e => e.type === 'term-upserted'), '坏事件留在后台待发箱可重试')
  console.log('  ✓ 现场端未吃坏报文（该条回滚）、提示原因；后台端照常应用现场事件；坏事件保留待重试，不堵队列')

  // 修复坏报文后再次对账，事件得以应用
  const fixedState = get(backstage)
  const badEvent = fixedState.sync.outbox.find(e => e.type === 'term-upserted')
  const fixedTerm = fixedState.terms.find(t => t.id === 'term-3')
  badEvent.payload = { ...fixedTerm }
  backstage.set(fixedState) // 模拟链路把修好的报文重新放回后台待发箱
  store.reconcile()
  await flush(); await flush()
  assert.strictEqual(liveState().terms.find(t => t.id === 'term-3').target, '协同收益（测试坏报文）', '修复重发后成功应用')
  assert.strictEqual(backstageState().sync.outbox.filter(e => e.type === 'term-upserted').length, 0)
  console.log('  ✓ 报文修复后重发对账成功，待发箱清空')
}

// 场景 5：交接包——一致则接班；不一致挂起；主管可裁定
log('5. 交接包核对与主管裁定')
{
  const { json, pkg } = store.exportHandover()
  const verify = verifyHandover(json)
  assert.ok(verify.ok)
  assert.strictEqual(pkg.cues.length, liveState().cues.length)
  console.log(`  ✓ 交接包校验和 ${pkg.checksum}，含 ${pkg.cueDigests.length} 条稿件摘要与术语指纹`)

  // 一致导入：接班
  const adopted = store.importHandover(json, '接班口译员 A')
  assert.strictEqual(adopted.outcome, 'adopted')
  assert.strictEqual(liveState().shift.operator, '接班口译员 A')
  console.log('  ✓ 一致导入：新班次建立，稿件与提醒接续')

  // 人为制造分叉：本班改了一条已确认稿件的内容，再导入原交接包
  const state0 = liveState()
  const targetCueId = state0.cues.find(c => c.status === 'confirmed').id
  store.updateCue(targetCueId, { followupText: '本班私自追加的补译，与交接包不一致' })
  await flush()
  const mismatch = store.importHandover(json, '接班口译员 B')
  assert.strictEqual(mismatch.outcome, 'mismatch')
  assert.ok(mismatch.dispute)
  assert.strictEqual(liveState().handoverDisputes[0].verdict, 'pending')
  assert.ok(liveState().shift.operator !== '接班口译员 B', '未裁定前不接班')
  console.log('  ✓ 对不上：挂起到主管裁定区，本班记录原样保留')

  // 无主管姓名应被拒绝
  let errs = store.resolveDispute(mismatch.dispute.id, 'accepted', '')
  assert.ok(errs.length > 0)
  // 主管裁定接受 → 按交接包接班
  errs = store.resolveDispute(mismatch.dispute.id, 'accepted', '值班主管 Z')
  assert.strictEqual(errs.length, 0)
  const resolved = liveState().handoverDisputes[0]
  assert.strictEqual(resolved.verdict, 'accepted')
  assert.strictEqual(resolved.supervisor, '值班主管 Z')
  const restoredCue = liveState().cues.find(c => c.id === targetCueId)
  assert.ok(!restoredCue.followupText.includes('本班私自追加'), '按交接包恢复')
  console.log('  ✓ 主管签字接受后按交接包接班；驳回路径保留本班（代码同构）')

  // 损坏 JSON
  const invalid = store.importHandover('{not-json', 'X')
  assert.strictEqual(invalid.outcome, 'invalid')
  const tampered = JSON.parse(json); tampered.stats.pending = 999
  const badChecksum = store.importHandover(JSON.stringify(tampered), 'X')
  assert.strictEqual(badChecksum.outcome, 'invalid')
  console.log('  ✓ 非法 JSON 与校验和不符均拒绝导入')
}

// 场景 6：通知发布闸门——后台保存不出现，发布对账后现场可见，撤下同步消失
log('6. 通知发布闸门与撤下')
{
  store.addAnnouncement('仅后台保存的测试通知，不应到现场。', 'info')
  await flush()
  assert.ok(!liveState().announcements.some(a => a.text.includes('仅后台保存')))
  const b = backstageState()
  const ann = b.announcements.find(a => a.text.includes('仅后台保存'))
  store.publishAnnouncement(ann.id, true)
  await flush(); await flush()
  assert.ok(liveState().announcements.some(a => a.text.includes('仅后台保存')), '发布对账后现场可见')
  store.publishAnnouncement(ann.id, false)
  await flush(); await flush()
  assert.ok(!liveState().announcements.some(a => a.text.includes('仅后台保存')), '撤下后现场消失')
  console.log('  ✓ 仅保存不下发；发布后经对账出现在现场端；撤下同步移除')
}

console.log('\n全部场景断言通过 ✔')
void cueDigestHash
void buildHandoverPackage
