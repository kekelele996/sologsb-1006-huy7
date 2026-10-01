<script lang="ts">
  import { onMount } from 'svelte'
  import Button from 'flowbite-svelte/Button.svelte'
  import {
    acknowledgeReminder, addAnnouncement, addSession, addSpeaker, addTerm, backstage, live,
    canRedo, canUndo, clearDuplicate, corruptNextOutboxEvent, deleteCue, exportHandover, getDelay,
    importHandover, ingestCue, markMarkerSeen, moveCue, publishAnnouncement, reconcile, redoDesk,
    resolveDispute, sendReminder, setActiveCue, setCueStatus, setFontScale, setLiveSimulation,
    setOperator, setSideOnline, speakerName, termTarget, undoDesk, updateCue, updateSession,
    updateSpeaker, updateTerm
  } from '$lib/store'
  import type { Announcement, Cue, Session, SyncEvent, TabId, Term } from '$lib/types'

  const liveLines = [
    'Cooling corridors can connect parks, schools, and shaded transit stops.',
    'The program gives every district a shared baseline for heat risk.',
    'Community health workers are collecting temperature and respiratory data together.',
    'This evidence helps us prioritize investments where vulnerability is highest.',
    'We will publish the indicator framework before the next budget cycle.'
  ]
  let tab: TabId = 'live'
  let now = Date.now()
  let manualText = ''
  let manualSpeakerId = ''
  let followup = ''
  let notice = ''
  let reconcileNotice = ''
  let announcementText = ''
  let announcementLevel: Announcement['level'] = 'info'
  let manualInput: HTMLTextAreaElement
  let simulationIndex = 0
  let showHelp = false

  // 换班交接
  let nextOperator = ''
  let handoverPreview = ''
  let handoverPaste = ''
  let handoverFile: File | null = null
  let importErrors: string[] = []
  const supervisorNames: Record<string, string> = {}

  $: currentSession = $live.sessions.find(item => item.status === 'live') || $live.sessions[0]
  $: activeCue = $live.cues.find(item => item.id === $live.activeCueId) || $live.cues.at(-1)
  $: pendingCount = $live.cues.filter(item => item.status === 'pending').length
  $: offlineCount = $live.cues.filter(item => item.offline).length
  $: lateCount = $live.cues.filter(item => getDelay(item, now) > 8 && item.status !== 'confirmed').length
  $: duplicateCount = $live.cues.filter(item => item.duplicateOf).length
  $: markerCount = $live.cues.reduce((sum, cue) => sum + cue.markers.filter(marker => !marker.seen).length, 0)
  $: pendingDisputes = $live.handoverDisputes.filter(item => item.verdict === 'pending')
  $: activeSpeaker = $live.speakers.find(item => item.id === activeCue?.speakerId)
  $: activeTerms = $live.terms.filter(item => item.speakerId === activeCue?.speakerId || activeCue?.tags.includes(item.target))
  $: unreadReminders = $live.reminders.filter(item => !item.acknowledged)
  $: bOutbox = $backstage.sync.outbox.length
  $: lOutbox = $live.sync.outbox.length

  onMount(() => {
    if (typeof navigator !== 'undefined') {
      const online = navigator.onLine
      setSideOnline('b', online)
      setSideOnline('l', online)
    }
    const onlineHandler = () => { setSideOnline('b', true); setSideOnline('l', true) }
    const offlineHandler = () => { setSideOnline('b', false); setSideOnline('l', false) }
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    window.addEventListener('keydown', handleKeyboard)
    const tick = window.setInterval(() => { now = Date.now() }, 1000)
    const simulate = window.setInterval(() => {
      if ($live.liveSimulation && $live.sync.online) {
        ingestCue(liveLines[simulationIndex % liveLines.length])
        simulationIndex++
      }
    }, 16000)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      window.removeEventListener('keydown', handleKeyboard)
      window.clearInterval(tick)
      window.clearInterval(simulate)
    }
  })

  function flash(message: string) {
    notice = message
    window.setTimeout(() => { if (notice === message) notice = '' }, 3200)
  }
  function flashReconcile(message: string) {
    reconcileNotice = message
    window.setTimeout(() => { if (reconcileNotice === message) reconcileNotice = '' }, 5000)
  }
  function selectCue(cue: Cue) {
    setActiveCue(cue.id)
    followup = ''
  }
  function confirmActive() {
    if (!activeCue) return
    setCueStatus(activeCue.id, 'confirmed')
    flash('已确认传译：本段译法快照已固化，之后术语更新不会改写本稿。')
    moveCue(1)
  }
  function saveFollowup() {
    if (!activeCue || !followup.trim()) return
    updateCue(activeCue.id, { followupText: followup.trim(), status: 'followup' })
    followup = ''
    flash('遗漏内容已补充并标记为待跟进，译法快照同时固化。')
  }
  function submitManual() {
    if (!manualText.trim()) return
    ingestCue(manualText, { manual: true, speakerId: manualSpeakerId || activeCue?.speakerId })
    manualText = ''
    if (!$live.sync.online) flash('现场端离线：稿件与进度事件已存入本机待发箱。')
    else flash('手工录入已进入现场队列。')
  }
  function runReconcile() {
    const result = reconcile()
    if (!result.ran) flashReconcile(result.reason || '')
    else flashReconcile('对账已执行，请查看两端各自的对账结果。')
  }
  function reconnectLive() {
    setSideOnline('l', true)
    reconcile()
    flashReconcile('现场端恢复在线：离线稿件重新查重，两端按事件序号对账。')
  }
  function sendTermReminder(termId: string) {
    if (!activeCue) return
    sendReminder(termId, activeCue.id)
    flash(`术语提醒已发送：${termTarget($live, termId)}`)
  }
  function createAnnouncement() {
    addAnnouncement(announcementText, announcementLevel)
    announcementText = ''
    flash('紧急通知已保存到后台，需明确发布才会进入现场。')
  }
  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }
  function eventLabel(event: SyncEvent): string {
    return ({
      'term-upserted': '术语译法更新',
      'roster-updated': '发言人名册更新',
      'announcement-published': '紧急通知发布',
      'announcement-recalled': '紧急通知撤下',
      'live-progress': '现场稿件进度'
    } as Record<string, string>)[event.type] || event.type
  }
  function delayClass(seconds: number) {
    if (seconds > 12) return 'bg-red-100 text-red-800 border-red-200'
    if (seconds > 8) return 'bg-amber-100 text-amber-900 border-amber-200'
    return 'bg-emerald-50 text-emerald-800 border-emerald-200'
  }
  function statusLabel(status: Cue['status']) {
    return ({ pending: '待传', confirmed: '已确认', followup: '有补充' })[status]
  }
  function handleKeyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? redoDesk() : undoDesk(); return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoDesk(); return }
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveCue(1) }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveCue(-1) }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); confirmActive() }
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault(); tab = 'reconcile'
      window.setTimeout(() => manualInput?.focus(), 60)
      flash('手工录入已获焦，输入后按 Ctrl + Enter 提交。')
    }
    if (event.key.toLowerCase() === 't' && activeTerms[0]) { event.preventDefault(); sendTermReminder(activeTerms[0].id) }
    if (event.key === '?') { event.preventDefault(); showHelp = true }
    if (event.key === '+' || event.key === '=') setFontScale($live.fontScale + 5)
    if (event.key === '-') setFontScale($live.fontScale - 5)
  }

  // —— 交接包 ——

  function buildPackage() {
    const { json } = exportHandover()
    handoverPreview = json
    flash('交接包已生成，包含稿件校验和与术语修订指纹。')
  }
  function downloadPackage() {
    if (!handoverPreview) buildPackage()
    const blob = new Blob([handoverPreview], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `handover-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  async function readHandoverFile(file: File) {
    handoverPaste = await file.text()
  }
  function submitImport() {
    importErrors = []
    const source = handoverPaste.trim()
    if (!source) { importErrors = ['请粘贴交接包内容或选择交接包文件。']; return }
    const result = importHandover(source, nextOperator)
    if (result.outcome === 'adopted') {
      flash('核对一致：已按交接包接班，本班继续处理。')
      handoverPaste = ''; handoverFile = null; nextOperator = ''; tab = 'live'
    } else if (result.outcome === 'mismatch') {
      importErrors = result.errors
      flash('交接包与本班记录对不上，已挂起交值班主管裁定。')
    } else {
      importErrors = result.errors
    }
  }
  function decideDispute(id: string, verdict: 'accepted' | 'rejected') {
    const errors = resolveDispute(id, verdict, supervisorNames[id] || '')
    if (errors.length) flash(errors[0])
    else flash(verdict === 'accepted' ? '值班主管已核定：按交接包接班。' : '值班主管已驳回：保留本班记录继续处理。')
  }
</script>

<svelte:head><title>会议同传提示台 · Live Cue Desk</title></svelte:head>

<a class="fixed left-2 top-2 z-[100] -translate-y-20 rounded-lg bg-white px-4 py-2 font-bold shadow focus:translate-y-0" href="#main">跳到主要内容</a>

<div class="min-h-full bg-paper text-ink" style={`font-size:${$live.fontScale}%`}>
  <header class="sticky top-0 z-40 border-b border-slate-800 bg-ink text-white shadow-xl">
    <div class="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3">
      <div class="mr-3 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-xl bg-orange-500 font-black">译</div>
        <div><strong class="block tracking-tight">会议同传提示台</strong><span class="block text-[10px] uppercase tracking-[.16em] text-slate-400">两端分立 · Live Cue Desk</span></div>
      </div>
      <nav class="order-3 flex w-full gap-1 overflow-x-auto rounded-xl bg-slate-800/80 p-1 lg:order-none lg:w-auto" aria-label="工作区">
        {#each [['live','现场运行端'],['backstage','后台准备端'],['terms','术语与通知'],['reconcile','对账与离线'],['handover','换班交接']] as item}
          <button class="focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition {tab === item[0] ? 'bg-white text-ink shadow' : 'text-slate-300 hover:bg-slate-700'}" aria-current={tab === item[0] ? 'page' : undefined} on:click={() => tab = item[0] as TabId}>
            {item[1]}
            {#if item[0] === 'live' && pendingCount}<span class="ml-2 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] text-white">{pendingCount}</span>{/if}
            {#if item[0] === 'live' && markerCount}<span class="ml-1 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] text-slate-900">译法更新 {markerCount}</span>{/if}
            {#if item[0] === 'reconcile' && (bOutbox + lOutbox)}<span class="ml-2 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">{bOutbox + lOutbox}</span>{/if}
            {#if item[0] === 'handover' && pendingDisputes.length}<span class="ml-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] text-white">待裁定 {pendingDisputes.length}</span>{/if}
          </button>
        {/each}
      </nav>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={$backstage.sync.online} aria-label="后台准备端连接" title="后台准备端连接" class="rounded-full border px-3 py-1.5 text-[11px] font-bold {$backstage.sync.online ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/40 bg-amber-500/15 text-amber-300'}" on:click={() => setSideOnline('b', !$backstage.sync.online)}>
          <span class="mr-2 inline-block h-2 w-2 rounded-full {$backstage.sync.online ? 'bg-emerald-400' : 'bg-amber-400'}"></span>后台端{$backstage.sync.online ? '在线' : '离线'}
        </button>
        <button type="button" role="switch" aria-checked={$live.sync.online} aria-label="现场运行端连接" title="现场运行端连接" class="rounded-full border px-3 py-1.5 text-[11px] font-bold {$live.sync.online ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/40 bg-amber-500/15 text-amber-300'}" on:click={() => setSideOnline('l', !$live.sync.online)}>
          <span class="mr-2 inline-block h-2 w-2 rounded-full {$live.sync.online ? 'bg-emerald-400' : 'bg-amber-400'}"></span>现场端{$live.sync.online ? '在线' : '离线'}
        </button>
        <div class="flex items-center rounded-lg bg-slate-800 p-1">
          <button class="focus-ring h-7 w-7 rounded text-lg" title="缩小字号" on:click={() => setFontScale($live.fontScale - 5)}>−</button>
          <span class="w-12 text-center text-[11px]">{$live.fontScale}%</span>
          <button class="focus-ring h-7 w-7 rounded text-lg" title="放大字号" on:click={() => setFontScale($live.fontScale + 5)}>＋</button>
        </div>
        <Button size="sm" color="light" on:click={() => showHelp = true}>快捷键</Button>
      </div>
    </div>
  </header>

  {#if notice}<div role="status" class="fixed right-5 top-20 z-50 rounded-xl border border-teal-200 bg-white px-4 py-3 text-sm font-bold text-teal-800 shadow-2xl">{notice}</div>{/if}

  <main id="main" class="mx-auto max-w-[1800px] p-4 lg:p-6">
    {#if tab === 'live'}
      <div class="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">现场运行端 · 自持术语与稿件 · {$live.sync.online ? 'LIVE' : 'OFFLINE MODE'}</p>
          <h1 class="mt-1 text-2xl font-black tracking-tight lg:text-4xl">{currentSession?.title}</h1>
          <p class="mt-2 text-sm text-slate-500">{currentSession?.time} · {currentSession?.room} · {speakerName($live, currentSession?.speakerId || '')} · 当班：{$live.shift.operator}</p>
        </div>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl">{pendingCount}</strong><span class="text-[10px] text-slate-500">待传</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-amber-700">{lateCount}</strong><span class="text-[10px] text-slate-500">偏高延迟</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-red-700">{duplicateCount}</strong><span class="text-[10px] text-slate-500">疑似重复</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-amber-700">{markerCount}</strong><span class="text-[10px] text-slate-500">译法更新</span></div>
        </div>
      </div>

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.75fr)]">
        <div class="space-y-4">
          <section class="overflow-hidden rounded-2xl border border-teal-800 bg-[#0d3b36] text-white shadow-lg">
            <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-200">现场可见内容</span><h2 class="mt-1 font-bold">舞台字幕与紧急通知（现场端自有副本）</h2></div>
              <span class="rounded-full bg-teal-600 px-2.5 py-1 text-[10px] font-black text-white">STAGE OUTPUT</span>
            </div>
            <div class="space-y-3 p-4">
              {#each $live.announcements as item}
                <div class="rounded-xl border border-orange-300/30 bg-orange-500/15 p-3"><strong class="text-xs text-orange-200">紧急通知</strong><p class="mt-1 text-lg font-bold">{item.text}</p></div>
              {/each}
              {#each $live.cues.filter(item => item.status === 'confirmed').slice(-2) as cue}
                <div class="rounded-xl bg-white/10 p-3">
                  <div class="mb-1 flex justify-between text-[10px] text-teal-200"><span>{speakerName($live, cue.speakerId)}</span><span>{formatTime(cue.receivedAt)}</span></div>
                  <p class="text-base leading-relaxed lg:text-lg">{cue.text}</p>
                  {#if cue.followupText}<p class="mt-1 text-sm text-amber-200">{cue.followupText}</p>{/if}
                  {#each cue.markers as marker}
                    <div class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-100">
                      <span>📌 译法已更新（不改写已确认稿）：<strong>{marker.oldTarget}</strong> → <strong>{marker.newTarget}</strong> · {marker.source}</span>
                      {#if !marker.seen}<button class="rounded bg-amber-400 px-2 py-0.5 font-bold text-slate-900" on:click={() => markMarkerSeen(cue.id, marker.id)}>知道了</button>{/if}
                    </div>
                  {/each}
                </div>
              {/each}
              {#if !$live.cues.some(item => item.status === 'confirmed') && !$live.announcements.length}
                <p class="py-5 text-center text-sm text-teal-100/60">确认传译或发布通知后，现场可见内容将在这里出现。</p>
              {/if}
            </div>
          </section>

          <section class="rounded-2xl border bg-white shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-slate-400">现场传译队列（现场运行端持有）</span><h2 class="mt-1 font-bold">待确认与遗漏补充</h2></div>
              <div class="flex items-center gap-3 text-xs text-slate-500"><span>自动接入</span><button type="button" role="switch" aria-label="自动接入现场文字" aria-checked={$live.liveSimulation} class="focus-ring h-6 w-11 rounded-full p-1 transition {$live.liveSimulation ? 'bg-teal-600' : 'bg-slate-300'}" on:click={() => setLiveSimulation(!$live.liveSimulation)}><span class="block h-4 w-4 rounded-full bg-white transition {$live.liveSimulation ? 'translate-x-5' : ''}"></span></button></div>
            </div>
            <div class="max-h-[600px] space-y-2 overflow-y-auto p-3 scrollbar-thin">
              {#each $live.cues as cue, index}
                <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                <article role="button" tabindex="0" class="cue-enter cursor-pointer rounded-xl border p-3 transition {cue.id === $live.activeCueId ? 'border-teal-600 bg-teal-50 shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'}" on:click={() => selectCue(cue)} on:keydown={event => (event.key === 'Enter' || event.key === ' ') && selectCue(cue)}>
                  <div class="flex flex-wrap items-start gap-3">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-xs font-black text-white">{index + 1}</span>
                    <div class="min-w-0 flex-1">
                      <div class="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                        <span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">{speakerName($live, cue.speakerId)}</span>
                        <span class="rounded-md border px-2 py-1 {delayClass(getDelay(cue, now))}">{formatTime(cue.receivedAt)} · 延迟 {getDelay(cue, now)}s</span>
                        <span class="rounded-md px-2 py-1 {cue.status === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : cue.status === 'followup' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-800'}">{statusLabel(cue.status)}</span>
                        {#if cue.frozenTerms !== null}<span class="rounded-md bg-slate-800 px-2 py-1 text-white">译法已固化 {cue.confirmedAt ? `@${formatTime(cue.confirmedAt)}` : ''}</span>{/if}
                        {#if cue.offline}<span class="rounded-md bg-amber-100 px-2 py-1 text-amber-900">离线暂存</span>{/if}
                        {#if cue.manual}<span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">手工</span>{/if}
                      </div>
                      <p class="text-sm leading-6 lg:text-base">{cue.text}</p>
                      {#if cue.duplicateOf}
                        <div class="mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                          <span><strong>疑似重复：</strong>与第 {$live.cues.findIndex(item => item.id === cue.duplicateOf) + 1} 条高度相似</span>
                          <button class="font-black underline" on:click|stopPropagation={() => clearDuplicate(cue.id)}>确认非重复</button>
                        </div>
                      {/if}
                      {#if cue.followupText}<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"><strong>补译：</strong>{cue.followupText}</p>{/if}
                      {#each cue.markers as marker}
                        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          <span>📌 相关段落译法已更新：<strong>{marker.oldTarget}</strong> → <strong>{marker.newTarget}</strong>（{marker.source}）；本稿保持原译不改写{#if marker.seen} · 已知悉{/if}</span>
                          {#if !marker.seen}<button class="rounded bg-amber-500 px-2 py-0.5 font-bold text-white" on:click|stopPropagation={() => markMarkerSeen(cue.id, marker.id)}>知道了</button>{/if}
                        </div>
                      {/each}
                      <div class="mt-2 flex flex-wrap gap-1">
                        {#if cue.frozenTerms !== null}
                          {#each cue.frozenTerms as frozen}<span class="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-bold text-slate-700" title="确认时固化的译法">{frozen.target} · r{frozen.revision} 🔒</span>{/each}
                          {#if !cue.frozenTerms.length}<span class="rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-400">确认时无相关术语</span>{/if}
                        {:else}
                          {#each cue.tags as tag}<span class="rounded-full bg-teal-100 px-2 py-1 text-[10px] font-bold text-teal-800">{tag}</span>{/each}
                        {/if}
                      </div>
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </section>
        </div>

        <div class="space-y-4">
          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div><span class="text-[10px] font-black uppercase tracking-wider text-teal-700">当前口译位</span><h2 class="mt-1 font-bold">{activeSpeaker?.name || '等待队列'}</h2><p class="text-xs text-slate-500">{activeSpeaker?.language}</p></div>
              <div class="flex gap-1"><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="上一条" on:click={() => moveCue(-1)}>↑</button><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="下一条" on:click={() => moveCue(1)}>↓</button></div>
            </div>
            {#if activeCue}
              <div class="rounded-xl bg-slate-50 p-3"><p class="text-sm leading-6">{activeCue.text}</p>
                {#if activeCue.frozenTerms === null}
                  <p class="mt-2 text-[10px] text-slate-500">未确认：标签实时跟随现场端最新术语译法。</p>
                {:else}
                  <p class="mt-2 text-[10px] font-bold text-slate-600">已固化译法：{activeCue.frozenTerms.map(item => `${item.target}（r${item.revision}）`).join('、') || '无'}，之后改术语不改写本稿。</p>
                {/if}
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2"><Button color="green" on:click={confirmActive}>确认已传 <kbd class="ml-1 text-[10px]">C</kbd></Button><Button color="yellow" on:click={() => tab = 'reconcile'}>手工补充</Button></div>
              <label for="followup-input" class="mt-4 block text-[10px] font-black uppercase tracking-wider text-slate-500">遗漏补译</label>
              <textarea id="followup-input" class="focus-ring mt-2 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={followup} placeholder="输入遗漏内容或修正术语…"></textarea>
              <Button class="mt-2 w-full" color="light" disabled={!followup.trim()} on:click={saveFollowup}>标记补充完成</Button>
            {/if}
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><div><span class="text-[10px] font-black uppercase tracking-wider text-slate-400">术语（现场端自持副本）</span><h2 class="mt-1 font-bold">当前发言人术语</h2></div><span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800">{activeTerms.length}</span></div>
            <p class="mb-2 text-[10px] text-slate-500">后台改译法经对账立即到达；未确认段落立即生效，已确认段落只显示更新标注。</p>
            <div class="space-y-2">
              {#each activeTerms as term}
                <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                  <div><strong class="block text-xs">{term.target} <span class="text-[9px] font-normal text-slate-400">r{term.revision}</span></strong><span class="text-[10px] text-slate-500">{term.source} · {term.note}</span></div>
                  <Button size="xs" color={term.priority === 'high' ? 'yellow' : 'light'} on:click={() => sendTermReminder(term.id)}>提醒</Button>
                </div>
              {/each}
            </div>
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><h2 class="font-bold">已发送提醒</h2><span class="text-xs text-slate-500">{unreadReminders.length} 条未确认</span></div>
            <div class="max-h-52 space-y-2 overflow-y-auto">
              {#each $live.reminders as reminder}
                <div class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs {reminder.acknowledged ? 'bg-slate-50 text-slate-400' : 'bg-teal-50 text-teal-900'}">
                  <span><strong>{reminder.target}</strong> · {formatTime(reminder.createdAt)}</span>
                  {#if !reminder.acknowledged}<button class="font-bold underline" on:click={() => acknowledgeReminder(reminder.id)}>已看到</button>{/if}
                </div>
              {/each}
              {#if !$live.reminders.length}<p class="py-4 text-center text-xs text-slate-400">尚未发送术语提醒。</p>{/if}
            </div>
          </section>
        </div>
      </div>
    {/if}

    {#if tab === 'backstage'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台准备端 · 自有一份准备内容 · {$backstage.sync.online ? '在线，改动即时入账待发' : '离线，改动先记本机待发箱'}</p><h1 class="mt-1 text-3xl font-black">议程、发言人与现场回传</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.3fr_.7fr]">
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="font-black">演讲顺序</h2><p class="text-xs text-slate-500">改动名册会生成事件，经对账同步到现场运行端。</p></div><Button size="sm" on:click={addSession}>新增场次</Button></div>
          <div class="space-y-3">
            {#each [...$backstage.sessions].sort((a,b) => a.order - b.order) as session}
              <article class="grid gap-3 rounded-xl border p-3 md:grid-cols-[80px_1fr_190px_120px]">
                <input class="focus-ring rounded-lg border px-2 py-2 text-sm font-bold" type="time" value={session.time} on:change={event => updateSession(session.id, { time: (event.target as HTMLInputElement).value })} />
                <div><input class="focus-ring w-full rounded-lg border px-2 py-2 font-bold" value={session.title} on:change={event => updateSession(session.id, { title: (event.target as HTMLInputElement).value })} /><span class="mt-1 block text-[10px] text-slate-500">{session.room}</span></div>
                <select class="focus-ring rounded-lg border px-2" value={session.speakerId} on:change={event => updateSession(session.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $backstage.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select>
                <select class="focus-ring rounded-lg border px-2" value={session.status} on:change={event => updateSession(session.id, { status: (event.target as HTMLSelectElement).value as Session['status'] })}><option value="upcoming">未开始</option><option value="live">进行中</option><option value="done">已结束</option></select>
              </article>
            {/each}
          </div>
          <div class="mt-5">
            <div class="mb-3 flex items-center justify-between"><h3 class="font-black">发言人</h3><Button size="sm" color="light" on:click={addSpeaker}>新增</Button></div>
            <div class="grid gap-3 md:grid-cols-2">
              {#each $backstage.speakers as speaker}
                <div class="rounded-xl border p-3">
                  <div class="flex items-center gap-2"><input class="focus-ring h-8 w-8 rounded-lg border-0 p-1" type="color" value={speaker.color} aria-label="标识颜色" on:change={event => updateSpeaker(speaker.id, { color: (event.target as HTMLInputElement).value })} /><input class="focus-ring min-w-0 flex-1 rounded-lg border px-2 py-2 font-bold" value={speaker.name} on:change={event => updateSpeaker(speaker.id, { name: (event.target as HTMLInputElement).value })} /></div>
                  <input class="focus-ring mt-2 w-full rounded-lg border px-2 py-2 text-xs" value={speaker.title} on:change={event => updateSpeaker(speaker.id, { title: (event.target as HTMLInputElement).value })} />
                  <input class="focus-ring mt-2 w-full rounded-lg border px-2 py-2 text-xs" value={speaker.language} on:change={event => updateSpeaker(speaker.id, { language: (event.target as HTMLInputElement).value })} />
                </div>
              {/each}
            </div>
          </div>
        </section>
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-3"><h2 class="font-black">现场回传动态</h2><p class="text-xs text-slate-500">只读：现场端的稿件进度事件经对账进入后台。</p></div>
          <div class="max-h-[560px] space-y-2 overflow-y-auto scrollbar-thin">
            {#each $backstage.liveFeedback as entry}
              <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
                <div class="mb-1 flex justify-between font-bold text-slate-500"><span>{statusLabel(entry.status)}</span><span>{formatTime(entry.at)}</span></div>
                <p class="leading-5 text-slate-700">{entry.text}</p>
              </div>
            {/each}
            {#if !$backstage.liveFeedback.length}<p class="py-6 text-center text-xs text-slate-400">对账后将显示现场稿件进度。</p>{/if}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'terms'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台术语表 · 新译法立即下发 · 已确认稿件不改写只标注</p><h1 class="mt-1 text-3xl font-black">术语表、紧急通知与发布闸门</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <section class="overflow-hidden rounded-2xl border bg-white shadow-sm">
          <div class="flex items-center justify-between border-b p-4"><div><h2 class="font-black">术语表（修订留痕）</h2><p class="text-xs text-slate-500">修改“指定译法”即产生新版本：现场待传段落立即用新译；已确认段落只在段内标注“译法已更新：旧译→新译”。</p></div><Button size="sm" on:click={addTerm}>新增术语</Button></div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[820px] text-left text-xs">
              <thead class="bg-slate-50 uppercase tracking-wider text-slate-500"><tr><th class="p-3">原文</th><th class="p-3">指定译法</th><th class="p-3">版本</th><th class="p-3">说明</th><th class="p-3">发言人</th><th class="p-3">优先级</th><th class="p-3"></th></tr></thead>
              <tbody>{#each $backstage.terms as term}<tr class="border-t align-top"><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2" value={term.source} on:change={event => updateTerm(term.id, { source: (event.target as HTMLInputElement).value })} /></td><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2 font-bold" value={term.target} on:change={event => updateTerm(term.id, { target: (event.target as HTMLInputElement).value })} />{#if term.targetHistory[0]}<p class="mt-1 text-[10px] text-slate-400">上一版：{term.targetHistory[0].target}</p>{/if}</td><td class="p-2 text-center font-black text-slate-500">r{term.revision}</td><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2" value={term.note} on:change={event => updateTerm(term.id, { note: (event.target as HTMLInputElement).value })} /></td><td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.speakerId} on:change={event => updateTerm(term.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $backstage.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></td><td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.priority} on:change={event => updateTerm(term.id, { priority: (event.target as HTMLSelectElement).value as Term['priority'] })}><option value="normal">常规</option><option value="high">高优先</option></select></td><td class="p-2"><Button size="xs" color="yellow" disabled={!activeCue} on:click={() => sendTermReminder(term.id)}>提醒现场</Button></td></tr>{/each}</tbody>
            </table>
          </div>
        </section>
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4"><h2 class="font-black">紧急通知</h2><p class="text-xs text-slate-500">先保存后台，管理员明确发布后，现场端经对账才可见。</p></div>
          <select class="focus-ring w-full rounded-xl border p-3 text-sm" bind:value={announcementLevel}><option value="info">信息提示</option><option value="warning">时间提醒</option><option value="urgent">紧急通知</option></select>
          <textarea class="focus-ring mt-3 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={announcementText} placeholder="输入通知内容…"></textarea>
          <Button class="mt-3 w-full" disabled={!announcementText.trim()} on:click={createAnnouncement}>保存到后台</Button>
          <div class="mt-6 space-y-3">
            {#each $backstage.announcements as announcement}
              <div class="rounded-xl border p-3 {announcement.visibleOnStage ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-slate-50'}">
                <div class="flex items-center justify-between gap-3"><span class="rounded-full bg-white px-2 py-1 text-[10px] font-bold">{announcement.level === 'urgent' ? '紧急' : announcement.level === 'warning' ? '提醒' : '信息'}</span><span class="text-[10px] font-bold {announcement.visibleOnStage ? 'text-orange-700' : 'text-slate-500'}">{announcement.visibleOnStage ? '已发布·现场端对账后可见' : '仅后台'}</span></div>
                <p class="my-2 text-sm font-bold">{announcement.text}</p>
                <Button size="xs" color={announcement.visibleOnStage ? 'light' : 'yellow'} on:click={() => publishAnnouncement(announcement.id, !announcement.visibleOnStage)}>{announcement.visibleOnStage ? '撤下现场' : '发布到现场'}</Button>
              </div>
            {/each}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'reconcile'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-amber-700">断网各自继续记 · 恢复后各自对账 · 出错只回退出错一侧</p><h1 class="mt-1 text-3xl font-black">两端事件箱、对账与离线手工录入</h1></div>

      {#if reconcileNotice}<div role="status" class="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">{reconcileNotice}</div>{/if}

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <Button size="lg" color="green" disabled={!$backstage.sync.online || !$live.sync.online} on:click={runReconcile}>立即对账</Button>
        <Button size="lg" color="yellow" disabled={$live.sync.online || !offlineCount} on:click={reconnectLive}>现场端恢复连接并合并 {offlineCount ? `(${offlineCount})` : ''}</Button>
        <span class="text-xs text-slate-500">只有两端同时在线才能交换事件箱；任一端离线时，两端都继续往自己的待发箱记。</span>
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <section class="rounded-2xl border bg-white p-5 shadow-sm {$backstage.sync.online ? '' : 'offline-hatch border-amber-200'}">
          <div class="mb-3 flex items-center justify-between">
            <div><h2 class="font-black">后台准备端</h2><p class="text-xs text-slate-500">{$backstage.sync.online ? '在线' : '离线 · 改动只进本机待发箱'}</p></div>
            <button type="button" role="switch" aria-label="切换后台准备端连接" aria-checked={$backstage.sync.online} class="focus-ring h-6 w-11 rounded-full p-1 {$backstage.sync.online ? 'bg-teal-600' : 'bg-slate-300'}" on:click={() => setSideOnline('b', !$backstage.sync.online)}><span class="block h-4 w-4 rounded-full bg-white transition {$backstage.sync.online ? 'translate-x-5' : ''}"></span></button>
          </div>
          <p class="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">待发 <strong>{bOutbox}</strong> 条 · 已对账 <strong>{$backstage.sync.journal.length}</strong> 条 · 上次对账：{$backstage.sync.lastReconciledAt ? formatTime($backstage.sync.lastReconciledAt) : '—'}</p>
          <p class="mb-3 text-xs font-bold text-slate-700">{$backstage.sync.lastReconcileSummary}</p>
          <div class="max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
            {#each $backstage.sync.outbox as event}
              <div class="flex justify-between rounded-lg border border-dashed border-slate-200 px-2 py-1 text-[11px]"><span>#{event.seq} {eventLabel(event)}</span><span class="text-slate-400">{formatTime(event.at)}</span></div>
            {/each}
            {#if !bOutbox}<p class="py-3 text-center text-[11px] text-slate-400">待发箱为空。</p>{/if}
          </div>
          <Button class="mt-3" size="xs" color="light" disabled={!bOutbox} on:click={() => corruptNextOutboxEvent('b')}>演练：破坏下一条待发报文（验证现场端整侧回滚）</Button>
        </section>

        <section class="rounded-2xl border bg-white p-5 shadow-sm {$live.sync.online ? '' : 'offline-hatch border-amber-200'}">
          <div class="mb-3 flex items-center justify-between">
            <div><h2 class="font-black">现场运行端</h2><p class="text-xs text-slate-500">{$live.sync.online ? '在线' : `离线 · 稿件本机暂存（${offlineCount} 条）`}</p></div>
            <button type="button" role="switch" aria-label="切换现场运行端连接" aria-checked={$live.sync.online} class="focus-ring h-6 w-11 rounded-full p-1 {$live.sync.online ? 'bg-teal-600' : 'bg-slate-300'}" on:click={() => setSideOnline('l', !$live.sync.online)}><span class="block h-4 w-4 rounded-full bg-white transition {$live.sync.online ? 'translate-x-5' : ''}"></span></button>
          </div>
          <p class="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">待发 <strong>{lOutbox}</strong> 条 · 已对账 <strong>{$live.sync.journal.length}</strong> 条 · 上次对账：{$live.sync.lastReconciledAt ? formatTime($live.sync.lastReconciledAt) : '—'}</p>
          <p class="mb-3 text-xs font-bold text-slate-700">{$live.sync.lastReconcileSummary}</p>
          <div class="max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
            {#each $live.sync.outbox as event}
              <div class="flex justify-between rounded-lg border border-dashed border-slate-200 px-2 py-1 text-[11px]"><span>#{event.seq} {eventLabel(event)}</span><span class="text-slate-400">{formatTime(event.at)}</span></div>
            {/each}
            {#if !lOutbox}<p class="py-3 text-center text-[11px] text-slate-400">待发箱为空。</p>{/if}
          </div>
          <Button class="mt-3" size="xs" color="light" disabled={!lOutbox} on:click={() => corruptNextOutboxEvent('l')}>演练：破坏下一条待发报文（验证后台端整侧回滚）</Button>
        </section>
      </div>

      <div class="mt-4 grid gap-4 xl:grid-cols-[.9fr_1.1fr]">
        <section class="offline-hatch rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
          <div class="mb-4 flex items-center justify-between gap-3"><div><h2 class="font-black">手工录入现场文字</h2><p class="text-xs text-slate-500">现场端断网时照常记录，恢复后对账合并并重新查重。Ctrl + Enter 提交。</p></div><span class="rounded-full px-3 py-1 text-xs font-bold {$live.sync.online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}">{$live.sync.online ? '在线写入队列' : '离线保存本机'}</span></div>
          <label class="text-xs font-bold">发言人或场次<select class="focus-ring mt-2 w-full rounded-xl border p-3" bind:value={manualSpeakerId}><option value="">跟随当前发言人</option>{#each $live.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></label>
          <label class="mt-4 block text-xs font-bold">现场文字<textarea bind:this={manualInput} class="focus-ring mt-2 w-full rounded-xl border p-4 text-base leading-7" rows="7" bind:value={manualText} placeholder="网络中断时，在这里继续录入…" on:keydown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submitManual() }}></textarea></label>
          <Button class="mt-3 w-full" size="lg" disabled={!manualText.trim()} on:click={submitManual}>加入现场队列</Button>
        </section>
        <section class="rounded-2xl border bg-white p-5 shadow-sm">
          <div class="mb-4"><h2 class="font-black">离线暂存稿件</h2><p class="text-xs text-slate-500">恢复对账时自动取消离线标记并重跑重复检测；该事务失败则现场端整侧回滚。</p></div>
          <div class="space-y-3">
            {#each $live.cues.filter(item => item.offline) as cue}
              <article class="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-4">
                <div class="flex items-center justify-between text-[10px] font-bold text-amber-800"><span>本机暂存 · {formatTime(cue.receivedAt)}</span><span>{speakerName($live, cue.speakerId)}</span></div>
                <textarea class="focus-ring mt-3 w-full rounded-xl border border-amber-200 bg-white p-3 text-sm" rows="3" value={cue.text} on:change={event => updateCue(cue.id, { text: (event.target as HTMLTextAreaElement).value })}></textarea>
                <div class="mt-2 flex justify-between"><span class="text-[10px] text-amber-800">同时记入现场端待发箱，恢复后回传后台</span><button class="text-xs font-bold text-red-700 underline" on:click={() => deleteCue(cue.id)}>删除暂存</button></div>
              </article>
            {/each}
            {#if !offlineCount}<div class="grid min-h-48 place-items-center rounded-xl bg-slate-50 text-center"><div><div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div><strong class="mt-3 block text-sm">没有离线暂存条目</strong><p class="mt-1 text-xs text-slate-500">可把现场端切到离线后测试录入，再恢复对账。</p></div></div>{/if}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'handover'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">交班导出 · 接班核对 · 对不上交值班主管定</p><h1 class="mt-1 text-3xl font-black">换班交接包</h1></div>
      <div class="grid gap-4 xl:grid-cols-2">
        <section class="rounded-2xl border bg-white p-5 shadow-sm">
          <h2 class="font-black">本班（现场运行端）</h2>
          <div class="mt-3 grid grid-cols-5 gap-2 text-center text-xs">
            <div class="rounded-xl border p-2"><strong class="block text-lg">{pendingCount}</strong><span class="text-slate-500">待传</span></div>
            <div class="rounded-xl border p-2"><strong class="block text-lg">{$live.cues.filter(item => item.status === 'followup').length}</strong><span class="text-slate-500">有补充</span></div>
            <div class="rounded-xl border p-2"><strong class="block text-lg">{$live.cues.filter(item => item.status === 'confirmed').length}</strong><span class="text-slate-500">已确认</span></div>
            <div class="rounded-xl border p-2"><strong class="block text-lg">{offlineCount}</strong><span class="text-slate-500">离线</span></div>
            <div class="rounded-xl border p-2"><strong class="block text-lg text-amber-700">{markerCount}</strong><span class="text-slate-500">更新标注</span></div>
          </div>
          <label class="mt-4 block text-xs font-bold">当班口译员
            <input class="focus-ring mt-1 w-full rounded-xl border p-3 text-sm" value={$live.shift.operator} on:change={event => setOperator((event.target as HTMLInputElement).value)} />
          </label>
          <p class="mt-1 text-[10px] text-slate-500">本班开始：{new Date($live.shift.startedAt).toLocaleString('zh-CN', { hour12: false })}</p>
          <div class="mt-4 flex gap-2"><Button color="green" on:click={buildPackage}>生成交接包</Button><Button color="light" disabled={!handoverPreview} on:click={downloadPackage}>下载 .json</Button></div>
          {#if handoverPreview}
            <textarea readonly class="focus-ring mt-3 h-72 w-full rounded-xl border bg-slate-50 p-3 font-mono text-[10px] leading-4" value={handoverPreview}></textarea>
          {/if}
        </section>

        <section class="rounded-2xl border bg-white p-5 shadow-sm">
          <h2 class="font-black">接班导入</h2>
          <p class="mt-1 text-xs text-slate-500">导入时逐条核对稿件校验和与术语修订指纹：与本班对得上则接班继续；对不上则挂起，由值班主管决定接受交接包还是保留本班。</p>
          <label class="mt-3 block text-xs font-bold">接班口译员姓名
            <input class="focus-ring mt-1 w-full rounded-xl border p-3 text-sm" bind:value={nextOperator} placeholder="接班后显示在当班位置" />
          </label>
          <label class="mt-3 block text-xs font-bold">交接包文件
            <input type="file" accept="application/json,.json" class="mt-1 block w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-white" on:change={event => { handoverFile = (event.target as HTMLInputElement).files?.[0] || null; if (handoverFile) readHandoverFile(handoverFile) }} />
          </label>
          <textarea class="focus-ring mt-3 w-full rounded-xl border p-3 font-mono text-[10px] leading-4" rows="8" bind:value={handoverPaste} placeholder="或直接粘贴交接包 JSON…"></textarea>
          <Button class="mt-3 w-full" color="yellow" size="lg" on:click={submitImport}>核对并接班</Button>
          {#if importErrors.length}
            <div class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <strong class="block">交接包未能直接接班：</strong>
              <ul class="mt-1 list-disc pl-4">{#each importErrors as error}<li>{error}</li>{/each}</ul>
            </div>
          {/if}
        </section>
      </div>

      <section class="mt-4 rounded-2xl border bg-white p-5 shadow-sm">
        <div class="mb-3 flex items-center justify-between"><h2 class="font-black">值班主管裁定区</h2><span class="rounded-full px-3 py-1 text-xs font-black {pendingDisputes.length ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-500'}">{pendingDisputes.length} 条待裁定</span></div>
        <div class="space-y-3">
          {#each $live.handoverDisputes as dispute}
            <article class="rounded-xl border p-4 {dispute.verdict === 'pending' ? 'border-red-300 bg-red-50/60' : 'border-slate-200 bg-slate-50'}">
              <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-bold">
                <span>交班人：{dispute.incomingOperator} · 提交于 {new Date(dispute.importedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                <span class="rounded-full px-2 py-0.5 {dispute.verdict === 'pending' ? 'bg-red-200 text-red-900' : dispute.verdict === 'accepted' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}">
                  {dispute.verdict === 'pending' ? '待主管裁定' : dispute.verdict === 'accepted' ? `已接受（主管：${dispute.supervisor}）` : `已驳回（主管：${dispute.supervisor}）`}
                </span>
              </div>
              <p class="mt-1 text-xs text-red-800">{dispute.reason}</p>
              <ul class="mt-2 list-disc pl-5 text-xs text-slate-700">{#each dispute.mismatchDetails as detail}<li>{detail}</li>{/each}</ul>
              {#if dispute.verdict === 'pending'}
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <input class="focus-ring rounded-lg border px-3 py-2 text-xs" placeholder="值班主管姓名" bind:value={supervisorNames[dispute.id]} />
                  <Button size="sm" color="green" on:click={() => decideDispute(dispute.id, 'accepted')}>主管核定：按交接包接班</Button>
                  <Button size="sm" color="light" on:click={() => decideDispute(dispute.id, 'rejected')}>主管驳回：保留本班</Button>
                </div>
              {:else if dispute.resolvedAt}
                <p class="mt-2 text-[10px] text-slate-400">裁定于 {new Date(dispute.resolvedAt).toLocaleString('zh-CN', { hour12: false })}</p>
              {/if}
            </article>
          {/each}
          {#if !$live.handoverDisputes.length}<p class="py-6 text-center text-xs text-slate-400">暂无交接争议。</p>{/if}
        </div>
      </section>
    {/if}
  </main>

  <footer class="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[11px] text-slate-500 lg:px-6">
    <span>后台与现场各自持久化 · 后台更新 {new Date($backstage.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 现场更新 {new Date($live.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
    <span>两端内容各自持有 · 译法更新不改写已确认稿件</span>
    <div class="flex gap-2"><button class="font-bold underline disabled:opacity-40" disabled={!canUndo()} on:click={undoDesk}>撤销</button><button class="font-bold underline disabled:opacity-40" disabled={!canRedo()} on:click={redoDesk}>重做</button></div>
  </footer>
</div>

{#if showHelp}
  <div class="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4" role="presentation" on:click={() => showHelp = false} on:keydown={event => event.key === 'Escape' && (showHelp = false)}>
    <div class="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="shortcut-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="flex items-start justify-between"><div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">Keyboard First</span><h2 id="shortcut-title" class="mt-1 text-xl font-black">键盘操作</h2></div><button class="rounded-lg px-2 py-1 text-xl" aria-label="关闭" on:click={() => showHelp = false}>×</button></div>
      <div class="mt-4 grid gap-2 sm:grid-cols-2">
        {#each [['J / ↓','下一条队列'],['K / ↑','上一条队列'],['C','确认并固化本段译法'],['N','聚焦手工录入'],['T','发送当前高优先术语'],['+ / −','调整界面字号'],['Ctrl + Z','撤销'],['Ctrl + Shift + Z','重做']] as shortcut}
          <div class="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><kbd class="rounded-md border bg-white px-2 py-1 text-xs font-black">{shortcut[0]}</kbd><span class="text-xs text-slate-600">{shortcut[1]}</span></div>
        {/each}
      </div>
    </div>
  </div>
{/if}
