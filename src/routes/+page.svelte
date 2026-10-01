<script lang="ts">
  import '../app.css'
  import { onMount } from 'svelte'
  import Button from 'flowbite-svelte/Button.svelte'
  import {
    acknowledgeReminder, addAnnouncement, addSession, addSpeaker, addTerm, applyHandover,
    broadcastHello, buildHandover, canRedo, canUndo, checkHandover, clearDuplicate,
    deleteCue, desk, getDelay, ingestCue, moveCue, peerStatus, publishAnnouncement,
    reconcile, redoDesk, resolveConflict, sendReminder, setActiveCue, setCueStatus,
    setFontScale, setLiveSimulation, setOnline, speakerName, staleHits, switchSide,
    termTarget, undoDesk, updateCue, updateSession, updateSpeaker, updateTerm
  } from '$lib/store'
  import type { Announcement, Cue, HandoverPackage, Session, Side, TabId, Term } from '$lib/types'

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
  let announcementText = ''
  let announcementLevel: Announcement['level'] = 'info'
  let manualInput: HTMLTextAreaElement
  let handoverInput: HTMLInputElement
  let simulationIndex = 0
  let showHelp = false
  let showSupervisor = false
  let showHandover = false
  let pendingHandover: HandoverPackage | null = null

  $: side = $desk.meta.side
  $: isOnsite = side === 'onsite'
  $: currentSession = $desk.sessions.find(item => item.status === 'live') || $desk.sessions[0]
  $: activeCue = $desk.cues.find(item => item.id === $desk.activeCueId) || $desk.cues.at(-1)
  $: pendingCount = $desk.cues.filter(item => item.status === 'pending').length
  $: offlineCount = $desk.cues.filter(item => item.offline).length
  $: lateCount = $desk.cues.filter(item => getDelay(item, now) > 8 && item.status !== 'confirmed').length
  $: duplicateCount = $desk.cues.filter(item => item.duplicateOf).length
  $: activeSpeaker = $desk.speakers.find(item => item.id === activeCue?.speakerId)
  $: activeTerms = $desk.terms.filter(item => item.speakerId === activeCue?.speakerId || activeCue?.tags.includes(item.target))
  $: unreadReminders = $desk.reminders.filter(item => !item.acknowledged)
  $: openConflicts = $desk.conflicts.filter(item => !item.resolved)
  $: pendingOps = $desk.ops.filter(item => item.side === side && item.ts > ($desk.meta.lastSyncAt ?? 0))
  $: staleCount = $desk.cues.filter(item => staleHits(item, $desk.terms).length > 0).length

  onMount(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine)
    const onlineHandler = () => { setOnline(true); reconcile() }
    const offlineHandler = () => setOnline(false)
    const visibleHandler = () => { if (document.visibilityState === 'visible') reconcile() }
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    document.addEventListener('visibilitychange', visibleHandler)
    window.addEventListener('keydown', handleKeyboard)
    const tick = window.setInterval(() => { now = Date.now() }, 1000)
    const simulate = window.setInterval(() => {
      if ($desk.liveSimulation && $desk.online && isOnsite) {
        ingestCue(liveLines[simulationIndex % liveLines.length])
        simulationIndex++
      }
    }, 16000)
    const syncTimer = window.setInterval(() => { if (document.visibilityState === 'visible') reconcile() }, 25000)
    broadcastHello()
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      document.removeEventListener('visibilitychange', visibleHandler)
      window.removeEventListener('keydown', handleKeyboard)
      window.clearInterval(tick)
      window.clearInterval(simulate)
      window.clearInterval(syncTimer)
    }
  })

  function flash(message: string) {
    notice = message
    window.setTimeout(() => { if (notice === message) notice = '' }, 3200)
  }
  function selectCue(cue: Cue) {
    if (!isOnsite) return
    setActiveCue(cue.id)
    followup = ''
  }
  function confirmActive() {
    if (!activeCue || !isOnsite) return
    setCueStatus(activeCue.id, 'confirmed')
    flash('已确认传译，队列自动前进。')
    moveCue(1)
  }
  function saveFollowup() {
    if (!activeCue || !followup.trim()) return
    updateCue(activeCue.id, { followupText: followup.trim(), status: 'followup' })
    followup = ''
    flash('遗漏内容已补充并标记为待跟进。')
  }
  function submitManual() {
    if (!manualText.trim()) return
    ingestCue(manualText, { manual: true, speakerId: manualSpeakerId || activeCue?.speakerId })
    manualText = ''
    if (!$desk.online) flash('网络中断中，内容已暂存在本机，恢复后自动对账。')
    else flash('手工录入已进入现场队列。')
  }
  function mergeOffline() {
    setOnline(true)
    reconcile()
    flash('网络已恢复，本机暂存已提交对账。')
  }
  function sendTermReminder(termId: string) {
    if (!activeCue) return
    sendReminder(termId, activeCue.id)
    flash(`术语提醒已发送：${termTarget($desk, termId)}`)
  }
  function createAnnouncement() {
    addAnnouncement(announcementText, announcementLevel)
    announcementText = ''
    flash('紧急通知已保存到后台。')
  }
  function chooseSide(next: Side) {
    if (next === side) return
    switchSide(next)
    tab = next === 'onsite' ? 'live' : 'prep'
  }
  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
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
    if (!isOnsite) return
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveCue(1) }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveCue(-1) }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); confirmActive() }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); manualInput?.focus(); flash('手工录入已获焦，输入后按 Ctrl + Enter 提交。') }
    if (event.key.toLowerCase() === 't' && activeTerms[0]) { event.preventDefault(); sendTermReminder(activeTerms[0].id) }
    if (event.key === '?') { event.preventDefault(); showHelp = true }
    if (event.key === '+' || event.key === '=') setFontScale($desk.fontScale + 5)
    if (event.key === '-') setFontScale($desk.fontScale - 5)
  }

  const kindLabels: Record<string, string> = {
    'cue.add': '新稿件录入', 'cue.update': '稿件更新', 'cue.delete': '稿件删除',
    'term.upsert': '术语表变更', 'term.delete': '术语删除',
    'announcement.upsert': '通知保存', 'announcement.publish': '通知发布', 'announcement.delete': '通知删除',
    'speaker.upsert': '发言人变更', 'speaker.delete': '发言人删除',
    'session.upsert': '议程变更', 'session.delete': '议程删除',
    'reminder.add': '术语提醒', 'reminder.ack': '提醒确认'
  }

  function exportHandoverFile() {
    const pkg = buildHandover()
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `交接包-${pkg.shiftName}-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    flash('交接包已导出，请接班端导入继续处理。')
  }
  function onHandoverFile(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const pkg = JSON.parse(String(reader.result)) as HandoverPackage
        const check = checkHandover(pkg)
        if (!check.valid) { flash('交接包格式无效，已取消导入。'); return }
        pendingHandover = pkg
        showHandover = true
      } catch {
        flash('交接包无法解析，已取消导入。')
      }
    }
    reader.readAsText(file)
    input.value = ''
  }
  function confirmHandover(mode: 'adopt' | 'merge' | 'keep') {
    if (!pendingHandover) return
    const report = applyHandover(pendingHandover, mode)
    showHandover = false
    pendingHandover = null
    if (report.rolledBack) flash(`接班失败：${report.error ?? '未知错误'}，本班记录未受影响。`)
    else if (mode === 'keep') flash('已保留本班记录，未采用接班包。')
    else flash(`已接班：${report.applied} 条记录入账${report.conflicts ? `，${report.conflicts} 项冲突待主管决定` : ''}。`)
  }
  function resolveConflictAndFlash(id: string, resolution: 'local' | 'remote' | 'merge') {
    resolveConflict(id, resolution)
    flash(resolution === 'local' ? '已按本班记录定稿。' : resolution === 'remote' ? '已采用对端记录。' : '已合并双方记录。')
  }

  $: handoverCheck = pendingHandover ? checkHandover(pendingHandover) : null
</script>

<svelte:head><title>会议同传提示台 · Live Cue Desk</title></svelte:head>

<a class="fixed left-2 top-2 z-[100] -translate-y-20 rounded-lg bg-white px-4 py-2 font-bold shadow focus:translate-y-0" href="#main">跳到主要内容</a>

<div class="min-h-full bg-paper text-ink" style={`font-size:${$desk.fontScale}%`}>
  <header class="sticky top-0 z-40 border-b border-slate-800 bg-ink text-white shadow-xl">
    <div class="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3">
      <div class="mr-3 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-xl bg-orange-500 font-black">译</div>
        <div><strong class="block tracking-tight">会议同传提示台</strong><span class="block text-[10px] uppercase tracking-[.16em] text-slate-400">后台准备 · 现场运行各持一份</span></div>
      </div>

      <div class="flex items-center rounded-xl bg-slate-800 p-1" role="group" aria-label="端切换">
        <button class="focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition {isOnsite ? 'bg-white text-ink shadow' : 'text-slate-300 hover:bg-slate-700'}" aria-pressed={isOnsite} on:click={() => chooseSide('onsite')}>现场运行端</button>
        <button class="focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition {!isOnsite ? 'bg-white text-ink shadow' : 'text-slate-300 hover:bg-slate-700'}" aria-pressed={!isOnsite} on:click={() => chooseSide('backstage')}>后台准备端</button>
      </div>

      <nav class="order-3 flex w-full gap-1 overflow-x-auto rounded-xl bg-slate-800/80 p-1 lg:order-none lg:w-auto" aria-label="工作区">
        {#each (isOnsite ? [['live','现场传译'],['terms','术语表'],['offline','离线暂存']] : [['live','现场监控'],['prep','议程与发言人'],['terms','术语与通知'],['offline','待同步']]) as item}
          <button class="focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition {tab === item[0] ? 'bg-white text-ink shadow' : 'text-slate-300 hover:bg-slate-700'}" aria-current={tab === item[0] ? 'page' : undefined} on:click={() => tab = item[0] as TabId}>
            {item[1]}
            {#if item[0] === 'live' && isOnsite && pendingCount}<span class="ml-2 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] text-white">{pendingCount}</span>{/if}
            {#if item[0] === 'offline' && offlineCount}<span class="ml-2 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">{offlineCount}</span>{/if}
            {#if item[0] === 'offline' && !isOnsite && pendingOps.length}<span class="ml-2 rounded-full bg-sky-500 px-1.5 py-0.5 text-[10px] text-white">{pendingOps.length}</span>{/if}
            {#if item[0] === 'terms' && staleCount}<span class="ml-2 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">{staleCount}</span>{/if}
          </button>
        {/each}
      </nav>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="rounded-full border px-3 py-1.5 text-[11px] font-bold {$peerStatus ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-slate-500/40 bg-slate-500/15 text-slate-300'}" title="同一浏览器中打开对端页面即可自动对账">
          <span class="mr-2 inline-block h-2 w-2 rounded-full {$peerStatus ? 'bg-emerald-400' : 'bg-slate-400'}"></span>{$peerStatus ? '对端在线' : '对端未连接'}
        </span>
        <span class="rounded-full border px-3 py-1.5 text-[11px] font-bold {$desk.online ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/40 bg-amber-500/15 text-amber-300'}">
          <span class="mr-2 inline-block h-2 w-2 rounded-full {$desk.online ? 'bg-emerald-400' : 'bg-amber-400'}"></span>{$desk.online ? '网络正常' : '断网 · 继续记录'}
        </span>
        <button class="focus-ring rounded-lg border border-slate-600 px-3 py-1.5 text-[11px] font-bold text-slate-200 enabled:hover:bg-slate-700" on:click={() => { reconcile(); flash('已向对端发起对账。') }}>对账</button>
        <Button size="sm" color="light" on:click={exportHandoverFile}>导出交接包</Button>
        <Button size="sm" color="light" on:click={() => handoverInput?.click()}>导入交接包</Button>
        <input bind:this={handoverInput} type="file" accept="application/json,.json" class="hidden" on:change={onHandoverFile} />
        <div class="flex items-center rounded-lg bg-slate-800 p-1">
          <button class="focus-ring h-7 w-7 rounded text-lg" title="缩小字号" on:click={() => setFontScale($desk.fontScale - 5)}>−</button>
          <span class="w-12 text-center text-[11px]">{$desk.fontScale}%</span>
          <button class="focus-ring h-7 w-7 rounded text-lg" title="放大字号" on:click={() => setFontScale($desk.fontScale + 5)}>＋</button>
        </div>
        <Button size="sm" color="light" on:click={() => showHelp = true}>快捷键</Button>
      </div>
    </div>

    {#if openConflicts.length}
      <button class="flex w-full items-center justify-center gap-2 bg-amber-400/90 px-4 py-2 text-xs font-black text-amber-950 hover:bg-amber-300" on:click={() => showSupervisor = true}>
        <span>值班主管决定：{openConflicts.length} 条记录与对端对不上</span><span class="underline">前往处理 →</span>
      </button>
    {/if}
    {#if $desk.lastSyncReport?.rolledBack}
      <div class="bg-red-900/80 px-4 py-2 text-center text-xs font-bold text-red-100">
        对账失败（{$desk.lastSyncReport.peer === 'onsite' ? '现场运行端' : '后台准备端'}）：{$desk.lastSyncReport.error ?? '未知错误'}。已只回退本机，对端未受影响。
      </div>
    {/if}
  </header>

  {#if notice}<div role="status" class="fixed right-5 top-24 z-50 rounded-xl border border-teal-200 bg-white px-4 py-3 text-sm font-bold text-teal-800 shadow-2xl">{notice}</div>{/if}

  <main id="main" class="mx-auto max-w-[1800px] p-4 lg:p-6">
    {#if tab === 'live' && isOnsite}
      <div class="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">现场运行端 · {$desk.online ? 'LIVE' : 'OFFLINE MODE'}</p>
          <h1 class="mt-1 text-2xl font-black tracking-tight lg:text-4xl">{currentSession?.title}</h1>
          <p class="mt-2 text-sm text-slate-500">{currentSession?.time} · {currentSession?.room} · {$desk.speakers.find(item => item.id === currentSession?.speakerId)?.name}</p>
        </div>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl">{pendingCount}</strong><span class="text-[10px] text-slate-500">待传</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-amber-700">{lateCount}</strong><span class="text-[10px] text-slate-500">偏高延迟</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-red-700">{duplicateCount}</strong><span class="text-[10px] text-slate-500">疑似重复</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-amber-700">{staleCount}</strong><span class="text-[10px] text-slate-500">译法已更新</span></div>
        </div>
      </div>

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.75fr)]">
        <div class="space-y-4">
          <section class="overflow-hidden rounded-2xl border border-teal-800 bg-[#0d3b36] text-white shadow-lg">
            <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-200">现场可见内容</span><h2 class="mt-1 font-bold">舞台字幕与紧急通知</h2></div>
              <span class="rounded-full bg-teal-600 px-2.5 py-1 text-[10px] font-black text-white">STAGE OUTPUT</span>
            </div>
            <div class="space-y-3 p-4">
              {#each $desk.announcements.filter(item => item.visibleOnStage) as item}
                <div class="rounded-xl border border-orange-300/30 bg-orange-500/15 p-3"><strong class="text-xs text-orange-200">紧急通知</strong><p class="mt-1 text-lg font-bold">{item.text}</p></div>
              {/each}
              {#each $desk.cues.filter(item => item.status === 'confirmed').slice(-2) as cue}
                <div class="rounded-xl bg-white/10 p-3">
                  <div class="mb-1 flex justify-between text-[10px] text-teal-200"><span>{speakerName($desk, cue.speakerId)}</span><span>{formatTime(cue.receivedAt)}</span></div>
                  <p class="text-base leading-relaxed lg:text-lg">{cue.text}</p>
                </div>
              {/each}
              {#if !$desk.cues.some(item => item.status === 'confirmed') && !$desk.announcements.some(item => item.visibleOnStage)}
                <p class="py-5 text-center text-sm text-teal-100/60">确认传译或发布通知后，现场可见内容将在这里出现。</p>
              {/if}
            </div>
          </section>

          <section class="rounded-2xl border bg-white shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-slate-400">现场传译队列</span><h2 class="mt-1 font-bold">已确认稿件不改写，只标注译法更新</h2></div>
              <div class="flex items-center gap-3 text-xs text-slate-500"><span>自动接入</span><button type="button" role="switch" aria-label="自动接入现场文字" aria-checked={$desk.liveSimulation} class="focus-ring h-6 w-11 rounded-full p-1 transition {$desk.liveSimulation ? 'bg-teal-600' : 'bg-slate-300'}" on:click={() => setLiveSimulation(!$desk.liveSimulation)}><span class="block h-4 w-4 rounded-full bg-white transition {$desk.liveSimulation ? 'translate-x-5' : ''}"></span></button></div>
            </div>
            <div class="max-h-[600px] space-y-2 overflow-y-auto p-3 scrollbar-thin">
              {#each $desk.cues as cue, index}
                <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                <article role="button" tabindex="0" class="cue-enter cursor-pointer rounded-xl border p-3 transition {cue.id === $desk.activeCueId ? 'border-teal-600 bg-teal-50 shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'}" on:click={() => selectCue(cue)} on:keydown={event => (event.key === 'Enter' || event.key === ' ') && selectCue(cue)}>
                  <div class="flex flex-wrap items-start gap-3">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-xs font-black text-white">{index + 1}</span>
                    <div class="min-w-0 flex-1">
                      <div class="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                        <span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">{speakerName($desk, cue.speakerId)}</span>
                        <span class="rounded-md border px-2 py-1 {delayClass(getDelay(cue, now))}">{formatTime(cue.receivedAt)} · 延迟 {getDelay(cue, now)}s</span>
                        <span class="rounded-md px-2 py-1 {cue.status === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : cue.status === 'followup' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-800'}">{statusLabel(cue.status)}</span>
                        {#if cue.offline}<span class="rounded-md bg-amber-100 px-2 py-1 text-amber-900">离线暂存</span>{/if}
                        {#if cue.manual}<span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">手工</span>{/if}
                      </div>
                      <p class="text-sm leading-6 lg:text-base">{cue.text}</p>
                      {#if cue.duplicateOf}
                        <div class="mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                          <span><strong>疑似重复：</strong>与第 {$desk.cues.findIndex(item => item.id === cue.duplicateOf) + 1} 条高度相似</span>
                          <button class="font-black underline" on:click|stopPropagation={() => clearDuplicate(cue.id)}>确认非重复</button>
                        </div>
                      {/if}
                      {#if staleHits(cue, $desk.terms).length}
                        <div class="mt-2 space-y-1">
                          {#each staleHits(cue, $desk.terms) as hit}
                            <p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-bold text-amber-900" title="管理员已更新该术语译法，稿件原文保持不变">译法已更新：{hit.source}「{hit.target}」→ 现行「{$desk.terms.find(item => item.id === hit.termId)?.target}」</p>
                          {/each}
                        </div>
                      {/if}
                      {#if cue.followupText}<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"><strong>补译：</strong>{cue.followupText}</p>{/if}
                      <div class="mt-2 flex flex-wrap gap-1">{#each cue.tags as tag}<span class="rounded-full bg-teal-100 px-2 py-1 text-[10px] font-bold text-teal-800">{tag}</span>{/each}</div>
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
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">当前口译位</span><h2 class="mt-1 font-bold">{activeSpeaker?.name || '等待队列'}</h2><p class="text-xs text-slate-500">{activeSpeaker?.language}</p></div>
              <div class="flex gap-1"><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="上一条" on:click={() => moveCue(-1)}>↑</button><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="下一条" on:click={() => moveCue(1)}>↓</button></div>
            </div>
            {#if activeCue}
              <div class="rounded-xl bg-slate-50 p-3"><p class="text-sm leading-6">{activeCue.text}</p><p class="mt-2 text-[10px] text-slate-500">快捷键：J / K 移动，C 确认，T 发送首条高优先术语提醒</p></div>
              <div class="mt-3 grid grid-cols-2 gap-2"><Button color="green" on:click={confirmActive}>确认已传 <kbd class="ml-1 text-[10px]">C</kbd></Button><Button color="yellow" on:click={() => tab = 'offline'}>手工补充</Button></div>
              <label for="followup-input" class="mt-4 block text-[10px] font-black uppercase tracking-wider text-slate-500">遗漏补译</label>
              <textarea id="followup-input" class="focus-ring mt-2 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={followup} placeholder="输入遗漏内容或修正术语…"></textarea>
              <Button class="mt-2 w-full" color="light" disabled={!followup.trim()} on:click={saveFollowup}>标记补充完成</Button>
            {/if}
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><div><span class="text-[10px] font-black uppercase tracking-[.16em] text-slate-400">术语提醒</span><h2 class="mt-1 font-bold">当前发言人术语</h2></div><span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800">{activeTerms.length}</span></div>
            <div class="space-y-2">
              {#each activeTerms as term}
                <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                  <div><strong class="block text-xs">{term.target}</strong><span class="text-[10px] text-slate-500">{term.source} · {term.note}</span></div>
                  <Button size="xs" color={term.priority === 'high' ? 'yellow' : 'light'} on:click={() => sendTermReminder(term.id)}>提醒</Button>
                </div>
              {/each}
            </div>
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><h2 class="font-bold">已发送提醒</h2><span class="text-xs text-slate-500">{unreadReminders.length} 条未确认</span></div>
            <div class="max-h-52 space-y-2 overflow-y-auto">
              {#each $desk.reminders as reminder}
                <div class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs {reminder.acknowledged ? 'bg-slate-50 text-slate-400' : 'bg-teal-50 text-teal-900'}">
                  <span><strong>{reminder.target}</strong> · {formatTime(reminder.createdAt)}</span>
                  {#if !reminder.acknowledged}<button class="font-bold underline" on:click={() => acknowledgeReminder(reminder.id)}>已看到</button>{/if}
                </div>
              {/each}
              {#if !$desk.reminders.length}<p class="py-4 text-center text-xs text-slate-400">尚未发送术语提醒。</p>{/if}
            </div>
          </section>
        </div>
      </div>
    {/if}

    {#if tab === 'live' && !isOnsite}
      <div class="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台准备端 · 现场只读监控</p>
          <h1 class="mt-1 text-3xl font-black">现场队列与舞台输出</h1>
          <p class="mt-2 text-sm text-slate-500">确认、补译等操作在现场运行端进行；本页仅展示对账后的现场副本。</p>
        </div>
        <Button color="light" on:click={() => { reconcile(); flash('已向现场端发起对账。') }}>立即对账</Button>
      </div>
      <div class="grid gap-4 xl:grid-cols-[1.65fr_.85fr]">
        <section class="overflow-hidden rounded-2xl border border-teal-800 bg-[#0d3b36] text-white shadow-lg">
          <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-200">舞台输出</span><h2 class="mt-1 font-bold">现场可见内容</h2></div>
            <span class="rounded-full bg-teal-600 px-2.5 py-1 text-[10px] font-black text-white">READ ONLY</span>
          </div>
          <div class="space-y-3 p-4">
            {#each $desk.announcements.filter(item => item.visibleOnStage) as item}
              <div class="rounded-xl border border-orange-300/30 bg-orange-500/15 p-3"><strong class="text-xs text-orange-200">紧急通知</strong><p class="mt-1 text-lg font-bold">{item.text}</p></div>
            {/each}
            {#each $desk.cues.filter(item => item.status === 'confirmed').slice(-4) as cue}
              <div class="rounded-xl bg-white/10 p-3">
                <div class="mb-1 flex justify-between text-[10px] text-teal-200"><span>{speakerName($desk, cue.speakerId)}</span><span>{formatTime(cue.receivedAt)}</span></div>
                <p class="text-base leading-relaxed">{cue.text}</p>
                {#if staleHits(cue, $desk.terms).length}<p class="mt-1 text-[10px] font-bold text-amber-300">译法已更新，原文未改写</p>{/if}
              </div>
            {/each}
            {#if !$desk.cues.some(item => item.status === 'confirmed') && !$desk.announcements.some(item => item.visibleOnStage)}
              <p class="py-5 text-center text-sm text-teal-100/60">尚无现场可见内容。</p>
            {/if}
          </div>
        </section>
        <section class="rounded-2xl border bg-white shadow-sm">
          <div class="border-b px-4 py-3"><h2 class="font-bold">队列状态</h2><p class="text-xs text-slate-500">共 {$desk.cues.length} 条 · 待传 {pendingCount} · 已确认 {$desk.cues.filter(item => item.status === 'confirmed').length} · 有补充 {$desk.cues.filter(item => item.status === 'followup').length}</p></div>
          <div class="max-h-[520px] space-y-2 overflow-y-auto p-3 scrollbar-thin">
            {#each $desk.cues as cue, index}
              <div class="rounded-xl border border-slate-200 p-3 opacity-90">
                <div class="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                  <span class="grid h-6 w-6 place-items-center rounded-lg bg-slate-900 text-white">{index + 1}</span>
                  <span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">{speakerName($desk, cue.speakerId)}</span>
                  <span class="rounded-md px-2 py-1 {cue.status === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : cue.status === 'followup' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-800'}">{statusLabel(cue.status)}</span>
                  {#if cue.offline}<span class="rounded-md bg-amber-100 px-2 py-1 text-amber-900">离线</span>{/if}
                </div>
                <p class="text-sm leading-6 text-slate-700">{cue.text}</p>
                {#if staleHits(cue, $desk.terms).length}<p class="mt-1 text-[10px] font-bold text-amber-700">译法已更新：{staleHits(cue, $desk.terms).map(h => h.target).join('、')} → {staleHits(cue, $desk.terms).map(h => $desk.terms.find(t => t.id === h.termId)?.target).join('、')}</p>{/if}
              </div>
            {/each}
            {#if !$desk.cues.length}<p class="py-8 text-center text-xs text-slate-400">对账后这里显示现场队列。</p>{/if}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'prep' && !isOnsite}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台准备内容 · 不会直接显示给现场</p><h1 class="mt-1 text-3xl font-black">议程、发言人与紧急通知</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.3fr_.7fr]">
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="font-black">演讲顺序</h2><p class="text-xs text-slate-500">拖动时间、状态或发言人即可更新后台准备内容。</p></div><Button size="sm" on:click={addSession}>新增场次</Button></div>
          <div class="space-y-3">
            {#each $desk.sessions.sort((a,b) => a.order - b.order) as session}
              <article class="grid gap-3 rounded-xl border p-3 md:grid-cols-[80px_1fr_190px_120px]">
                <input class="focus-ring rounded-lg border px-2 py-2 text-sm font-bold" type="time" value={session.time} on:change={event => updateSession(session.id, { time: (event.target as HTMLInputElement).value })} />
                <div><input class="focus-ring w-full rounded-lg border px-3 py-2 font-bold" value={session.title} on:change={event => updateSession(session.id, { title: (event.target as HTMLInputElement).value })} /><span class="mt-1 block text-[10px] text-slate-500">{session.room}</span></div>
                <select class="focus-ring rounded-lg border px-2" value={session.speakerId} on:change={event => updateSession(session.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select>
                <select class="focus-ring rounded-lg border px-2" value={session.status} on:change={event => updateSession(session.id, { status: (event.target as HTMLSelectElement).value as Session['status'] })}><option value="upcoming">未开始</option><option value="live">进行中</option><option value="done">已结束</option></select>
              </article>
            {/each}
          </div>
        </section>
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="font-black">发言人</h2><p class="text-xs text-slate-500">语气、语言方向与标识颜色。</p></div><Button size="sm" color="light" on:click={addSpeaker}>新增</Button></div>
          <div class="space-y-3">
            {#each $desk.speakers as speaker}
              <div class="rounded-xl border p-3">
                <div class="flex items-center gap-2"><input class="focus-ring h-8 w-8 rounded-lg border-0 p-1" type="color" value={speaker.color} aria-label="标识颜色" on:change={event => updateSpeaker(speaker.id, { color: (event.target as HTMLInputElement).value })} /><input class="focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2 font-bold" value={speaker.name} on:change={event => updateSpeaker(speaker.id, { name: (event.target as HTMLInputElement).value })} /></div>
                <input class="focus-ring mt-2 w-full rounded-lg border px-3 py-2 text-xs" value={speaker.title} on:change={event => updateSpeaker(speaker.id, { title: (event.target as HTMLInputElement).value })} />
                <input class="focus-ring mt-2 w-full rounded-lg border px-3 py-2 text-xs" value={speaker.language} on:change={event => updateSpeaker(speaker.id, { language: (event.target as HTMLInputElement).value })} />
              </div>
            {/each}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'terms'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">{isOnsite ? '现场运行端 · 术语表只读' : '后台准备端 · 后台内容与现场动作'}</p><h1 class="mt-1 text-3xl font-black">术语表、紧急通知与发布闸门</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <section class="overflow-hidden rounded-2xl border bg-white shadow-sm">
          <div class="flex items-center justify-between border-b p-4">
            <div><h2 class="font-black">术语表</h2><p class="text-xs text-slate-500">{isOnsite ? '术语由后台准备端维护；新译法立即生效，已确认稿件只标注「译法已更新」不改写。' : '修改译法后立即对现场生效；已确认稿件不会被改写，只会标注「译法已更新」。'}</p></div>
            {#if !isOnsite}<Button size="sm" on:click={addTerm}>新增术语</Button>{/if}
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-left text-xs">
              <thead class="bg-slate-50 uppercase tracking-wider text-slate-500"><tr><th class="p-3">原文</th><th class="p-3">指定译法</th><th class="p-3">说明</th><th class="p-3">发言人</th><th class="p-3">优先级</th><th class="p-3">版本</th>{#if !isOnsite}<th class="p-3"></th>{/if}</tr></thead>
              <tbody>{#each $desk.terms as term}<tr class="border-t">
                <td class="p-2">{#if isOnsite}<span class="px-2 font-bold">{term.source}</span>{:else}<input class="focus-ring w-full rounded border px-2 py-2" value={term.source} on:change={event => updateTerm(term.id, { source: (event.target as HTMLInputElement).value })} />{/if}</td>
                <td class="p-2">{#if isOnsite}<span class="px-2 font-bold">{term.target}</span>{:else}<input class="focus-ring w-full rounded border px-2 py-2 font-bold" value={term.target} on:change={event => updateTerm(term.id, { target: (event.target as HTMLInputElement).value })} />{/if}</td>
                <td class="p-2">{#if isOnsite}<span class="px-2 text-slate-500">{term.note}</span>{:else}<input class="focus-ring w-full rounded border px-2 py-2" value={term.note} on:change={event => updateTerm(term.id, { note: (event.target as HTMLInputElement).value })} />{/if}</td>
                <td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.speakerId} disabled={isOnsite} on:change={event => updateTerm(term.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></td>
                <td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.priority} disabled={isOnsite} on:change={event => updateTerm(term.id, { priority: (event.target as HTMLSelectElement).value as Term['priority'] })}><option value="normal">常规</option><option value="high">高优先</option></select></td>
                <td class="p-2"><span class="rounded-full px-2 py-1 text-[10px] font-black {term.revision > 1 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}">v{term.revision}{#if term.revision > 1} · 已更新{/if}</span></td>
                {#if !isOnsite}<td class="p-2"><Button size="xs" color="yellow" disabled={!activeCue} on:click={() => sendTermReminder(term.id)}>发送</Button></td>{/if}
              </tr>{/each}</tbody>
            </table>
          </div>
        </section>
        {#if !isOnsite}
          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-4"><h2 class="font-black">紧急通知</h2><p class="text-xs text-slate-500">先保存到后台，再由管理员明确发布到现场。</p></div>
            <select class="focus-ring w-full rounded-xl border p-3 text-sm" bind:value={announcementLevel}><option value="info">信息提示</option><option value="warning">时间提醒</option><option value="urgent">紧急通知</option></select>
            <textarea class="focus-ring mt-3 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={announcementText} placeholder="输入通知内容…"></textarea>
            <Button class="mt-3 w-full" disabled={!announcementText.trim()} on:click={createAnnouncement}>保存到后台</Button>
            <div class="mt-6 space-y-3">
              {#each $desk.announcements as announcement}
                <div class="rounded-xl border p-3 {announcement.visibleOnStage ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-slate-50'}">
                  <div class="flex items-center justify-between gap-3"><span class="rounded-full bg-white px-2 py-1 text-[10px] font-bold">{announcement.level === 'urgent' ? '紧急' : announcement.level === 'warning' ? '提醒' : '信息'}</span><span class="text-[10px] font-bold {announcement.visibleOnStage ? 'text-orange-700' : 'text-slate-500'}">{announcement.visibleOnStage ? '现场可见' : '仅后台'}</span></div>
                  <p class="my-2 text-sm font-bold">{announcement.text}</p>
                  <Button size="xs" color={announcement.visibleOnStage ? 'light' : 'yellow'} on:click={() => publishAnnouncement(announcement.id, !announcement.visibleOnStage)}>{announcement.visibleOnStage ? '撤下现场' : '发布到现场'}</Button>
                </div>
              {/each}
            </div>
          </section>
        {:else}
          <section class="rounded-2xl border border-dashed border-teal-300 bg-teal-50/50 p-4 text-xs leading-6 text-teal-900">
            <h2 class="text-sm font-black">译法更新规则</h2>
            <p class="mt-2">管理员在后台修改指定译法后：</p>
            <ul class="mt-1 list-inside list-disc space-y-1">
              <li>新录入的稿件立即使用新译法；</li>
              <li>已确认传译的稿件<strong>原文不改写</strong>；</li>
              <li>仅在相关段落标注「译法已更新：旧译法 → 新译法」。</li>
            </ul>
            <p class="mt-2">换班时通过右上角「导出交接包」把现场记录交给接班端；对不上的记录由值班主管决定。</p>
          </section>
        {/if}
      </div>
    {/if}

    {#if tab === 'offline'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-amber-700">断网继续工作 · 恢复后各自对账</p><h1 class="mt-1 text-3xl font-black">{isOnsite ? '手工录入与离线暂存' : '待同步操作与对账'}</h1></div>
      {#if isOnsite}
        <div class="grid gap-4 xl:grid-cols-[.9fr_1.1fr]">
          <section class="offline-hatch rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
            <div class="mb-4 flex items-center justify-between gap-3"><div><h2 class="font-black">手工录入现场文字</h2><p class="text-xs text-slate-500">按 Ctrl + Enter 也可以提交。</p></div><span class="rounded-full px-3 py-1 text-xs font-bold {$desk.online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}">{$desk.online ? '在线写入队列' : '离线保存本机'}</span></div>
            <label class="text-xs font-bold">发言人或场次<select class="focus-ring mt-2 w-full rounded-xl border p-3" bind:value={manualSpeakerId}><option value="">跟随当前发言人</option>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></label>
            <label class="mt-4 block text-xs font-bold">现场文字<textarea bind:this={manualInput} class="focus-ring mt-2 w-full rounded-xl border p-4 text-base leading-7" rows="8" bind:value={manualText} placeholder="网络中断时，在这里继续录入…" on:keydown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submitManual() }}></textarea></label>
            <Button class="mt-3 w-full" size="lg" disabled={!manualText.trim()} on:click={submitManual}>加入队列</Button>
            <div class="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900"><strong>暂存规则：</strong>离线条目会带“离线暂存”标记；恢复连接后提交对账，两端各自执行相似内容检测。</div>
          </section>
          <section class="rounded-2xl border bg-white p-5 shadow-sm">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-black">合并与冲突检查</h2><p class="text-xs text-slate-500">当前有 {offlineCount} 条离线条目，{duplicateCount} 条疑似重复。</p></div><Button disabled={$desk.online || !offlineCount} color="green" on:click={mergeOffline}>恢复连接并对账</Button></div>
            <div class="space-y-3">
              {#each $desk.cues.filter(item => item.offline) as cue}
                <article class="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-4">
                  <div class="flex items-center justify-between text-[10px] font-bold text-amber-800"><span>本机暂存 · {formatTime(cue.receivedAt)}</span><span>{speakerName($desk, cue.speakerId)}</span></div>
                  <textarea class="focus-ring mt-3 w-full rounded-xl border border-amber-200 bg-white p-3 text-sm" rows="3" value={cue.text} on:change={event => updateCue(cue.id, { text: (event.target as HTMLTextAreaElement).value })}></textarea>
                  <div class="mt-2 flex justify-between"><span class="text-[10px] text-amber-800">等待恢复网络后对账</span><button class="text-xs font-bold text-red-700 underline" on:click={() => deleteCue(cue.id)}>删除暂存</button></div>
                </article>
              {/each}
              {#if !offlineCount}<div class="grid min-h-60 place-items-center rounded-xl bg-slate-50 text-center"><div><div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div><strong class="mt-3 block text-sm">没有离线暂存条目</strong><p class="mt-1 text-xs text-slate-500">可断开网络后测试手工录入与恢复对账。</p></div></div>{/if}
            </div>
          </section>
        </div>
      {:else}
        <div class="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
          <section class="rounded-2xl border bg-white p-5 shadow-sm">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><h2 class="font-black">待同步操作</h2><p class="text-xs text-slate-500">断网期间所有准备变更都记在这里，恢复后点「对账」与现场端交换。</p></div>
              <Button color="green" on:click={() => { reconcile(); flash('已向现场端发起对账。') }}>立即对账</Button>
            </div>
            <div class="space-y-2">
              {#each pendingOps as op}
                <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-xs">
                  <span class="rounded-full bg-sky-100 px-2 py-1 font-black text-sky-800">{kindLabels[op.kind] ?? op.kind}</span>
                  <span class="text-slate-400">{new Date(op.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                </div>
              {/each}
              {#if !pendingOps.length}<div class="grid min-h-60 place-items-center rounded-xl bg-slate-50 text-center"><div><div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div><strong class="mt-3 block text-sm">没有待同步操作</strong><p class="mt-1 text-xs text-slate-500">所有准备变更都已与现场端对账一致。</p></div></div>{/if}
            </div>
          </section>
          <section class="rounded-2xl border border-dashed border-sky-300 bg-sky-50/50 p-5 text-xs leading-6 text-sky-900">
            <h2 class="text-sm font-black">两边断网时继续记，恢复后各自对账</h2>
            <ul class="mt-2 list-inside list-disc space-y-1">
              <li>后台准备端改议程、术语、通知，现场运行端录入、确认、补译；</li>
              <li>两端各自把内容记在本机，网络恢复后交换操作日志；</li>
              <li>同一记录两边都改了 → 标记冲突，交值班主管决定；</li>
              <li>对账失败只回退出错的一边，另一边不受影响。</li>
            </ul>
            <p class="mt-2">测试方法：同一浏览器打开两个标签页，分别切换到「后台准备端」和「现场运行端」。</p>
          </section>
        </div>
      {/if}
    {/if}
  </main>

  <footer class="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[11px] text-slate-500 lg:px-6">
    <span>本机自动保存 · 最近更新 {new Date($desk.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 班次 {$desk.meta.shiftName}</span>
    <span>后台准备内容与现场运行内容各自持有、对账合并</span>
    <div class="flex gap-2"><button class="font-bold underline disabled:opacity-40" disabled={!canUndo()} on:click={undoDesk}>撤销</button><button class="font-bold underline disabled:opacity-40" disabled={!canRedo()} on:click={redoDesk}>重做</button></div>
  </footer>
</div>

{#if showHelp}
  <div class="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4" role="presentation" on:click={() => showHelp = false} on:keydown={event => event.key === 'Escape' && (showHelp = false)}>
    <div class="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="shortcut-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="flex items-start justify-between"><div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">Keyboard First</span><h2 id="shortcut-title" class="mt-1 text-xl font-black">键盘操作</h2></div><button class="rounded-lg px-2 py-1 text-xl" aria-label="关闭" on:click={() => showHelp = false}>×</button></div>
      <div class="mt-4 grid gap-2 sm:grid-cols-2">
        {#each [['J / ↓','下一条队列'],['K / ↑','上一条队列'],['C','确认已传并前进'],['N','聚焦手工录入'],['T','发送当前高优先术语'],['+ / −','调整界面字号'],['Ctrl + Z','撤销'],['Ctrl + Shift + Z','重做']] as shortcut}
          <div class="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><kbd class="rounded-md border bg-white px-2 py-1 text-xs font-black">{shortcut[0]}</kbd><span class="text-xs text-slate-600">{shortcut[1]}</span></div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if showSupervisor}
  <div class="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4" role="presentation" on:click={() => showSupervisor = false} on:keydown={event => event.key === 'Escape' && (showSupervisor = false)}>
    <div class="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="supervisor-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="flex items-start justify-between">
        <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-amber-700">值班主管决定</span><h2 id="supervisor-title" class="mt-1 text-xl font-black">对账冲突</h2><p class="mt-1 text-xs text-slate-500">同一条记录两端都改过，无法自动合并，请主管决定保留哪一边。</p></div>
        <button class="rounded-lg px-2 py-1 text-xl" aria-label="关闭" on:click={() => showSupervisor = false}>×</button>
      </div>
      <div class="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
        {#each openConflicts as conflict}
          <article class="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <div class="mb-2 text-[10px] font-black uppercase tracking-wider text-amber-800">{{ speaker: '发言人', session: '议程', term: '术语', announcement: '通知', cue: '稿件', reminder: '提醒' }[conflict.entityKind]}冲突</div>
            <div class="grid gap-2 sm:grid-cols-2">
              <div class="rounded-lg border border-sky-200 bg-white p-3">
                <p class="text-[10px] font-black text-sky-700">本班（{isOnsite ? '现场运行端' : '后台准备端'}）</p>
                <p class="mt-1 text-xs font-bold leading-5">{conflict.localLabel}</p>
              </div>
              <div class="rounded-lg border border-slate-200 bg-white p-3">
                <p class="text-[10px] font-black text-slate-500">对端（{isOnsite ? '后台准备端' : '现场运行端'}）</p>
                <p class="mt-1 text-xs font-bold leading-5">{conflict.remoteLabel}</p>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button size="xs" color="light" on:click={() => resolveConflictAndFlash(conflict.id, 'local')}>保留本班</Button>
              <Button size="xs" color="yellow" on:click={() => resolveConflictAndFlash(conflict.id, 'remote')}>采用对端</Button>
              {#if conflict.entityKind === 'cue'}<Button size="xs" color="green" on:click={() => resolveConflictAndFlash(conflict.id, 'merge')}>合并双方</Button>{/if}
            </div>
          </article>
        {/each}
        {#if !openConflicts.length}<p class="py-8 text-center text-sm text-slate-400">没有待处理冲突。</p>{/if}
      </div>
    </div>
  </div>
{/if}

{#if showHandover && pendingHandover && handoverCheck}
  <div class="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4" role="presentation" on:click={() => showHandover = false} on:keydown={event => event.key === 'Escape' && (showHandover = false)}>
    <div class="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="handover-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="flex items-start justify-between">
        <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">换班交接包</span><h2 id="handover-title" class="mt-1 text-xl font-black">{handoverCheck.incomingShift}</h2></div>
        <button class="rounded-lg px-2 py-1 text-xl" aria-label="关闭" on:click={() => showHandover = false}>×</button>
      </div>
      {#if handoverCheck.sameShift}
        <p class="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-600">同一班次（{handoverCheck.localShift}）的交接包，共 {handoverCheck.incomingCues} 条现场记录。导入后与本班记录合并对账。</p>
        <div class="mt-4 flex justify-end gap-2"><Button color="light" on:click={() => showHandover = false}>取消</Button><Button color="green" on:click={() => confirmHandover('merge')}>合并继续</Button></div>
      {:else if handoverCheck.localOnlyCues > 0}
        <p class="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">接班包属于「{handoverCheck.incomingShift}」，本班「{handoverCheck.localShift}」有 <strong>{handoverCheck.localOnlyCues} 条记录</strong>不在交接包中，跟本班对不上，请值班主管决定：</p>
        <ul class="mt-3 space-y-2 text-xs">
          <li class="rounded-lg bg-slate-50 p-3"><strong>采用接班包：</strong>以包内记录为准接班，本班仅本机记录不再带入。</li>
          <li class="rounded-lg bg-slate-50 p-3"><strong>合并双方：</strong>接班包为基线，本班记录重放上去，冲突仍交主管。</li>
          <li class="rounded-lg bg-slate-50 p-3"><strong>保留本班：</strong>不导入接班包，继续本班记录。</li>
        </ul>
        <div class="mt-4 flex flex-wrap justify-end gap-2"><Button color="light" on:click={() => showHandover = false}>取消</Button><Button color="light" on:click={() => confirmHandover('keep')}>保留本班</Button><Button color="yellow" on:click={() => confirmHandover('merge')}>合并双方</Button><Button color="green" on:click={() => confirmHandover('adopt')}>采用接班包</Button></div>
      {:else}
        <p class="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-600">接班包「{handoverCheck.incomingShift}」共 {handoverCheck.incomingCues} 条现场记录，本班无在途记录。导入后作为新班次基线继续处理。</p>
        <div class="mt-4 flex justify-end gap-2"><Button color="light" on:click={() => showHandover = false}>取消</Button><Button color="green" on:click={() => confirmHandover('adopt')}>接班继续</Button></div>
      {/if}
    </div>
  </div>
{/if}
