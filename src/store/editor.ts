import { defineStore } from 'pinia'
import type {
  Cue, DubbingExportFile, EditorDocument, Locale, MergeIssue, MergePlan, ScriptKind, Snapshot,
} from '../types'
import { loadDocument, saveDocument, saveDocumentsAtomically } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import {
  DUBBING_DOCUMENT_ID, LEGACY_DOCUMENT_ID, SUBTITLE_DOCUMENT_ID,
  applyMergePlan, deriveDubbingDocument, parseDubbingFile, reconcileDubbingLines, toDubbingExportFile,
} from '../utils/dubbing'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_IDS: Record<ScriptKind, string> = { subtitle: SUBTITLE_DOCUMENT_ID, dubbing: DUBBING_DOCUMENT_ID }
const SCRIPT_KINDS: ScriptKind[] = ['subtitle', 'dubbing']
const saveTimers: Partial<Record<ScriptKind, ReturnType<typeof setTimeout>>> = {}
let channel: BroadcastChannel | undefined

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const plainDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

const createDefaultSubtitleDocument = (): EditorDocument => ({
  id: SUBTITLE_DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  dubbingBase: null,
  actors: [
    { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
    { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
    { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
    { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
  ],
  terms: [
    { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
    { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
    { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
    { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
  ],
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  snapshots: [],
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => {
    const subtitle = createDefaultSubtitleDocument()
    return {
      documents: {
        subtitle,
        dubbing: deriveDubbingDocument(subtitle, null),
      } as Record<ScriptKind, EditorDocument>,
      activeScript: 'subtitle' as ScriptKind,
      selectedCueId: 'cue-demo-03' as string | null,
      actorFilter: 'all',
      timelineZoom: 1,
      saveStates: { subtitle: 'saved', dubbing: 'saved' } as Record<ScriptKind, SaveState>,
      saving: false,
      initialized: false,
      conflicts: { subtitle: false, dubbing: false } as Record<ScriptKind, boolean>,
      online: navigator.onLine,
      tabId: makeId('tab'),
      lastSeenRevisions: { subtitle: 0, dubbing: 0 } as Record<ScriptKind, number>,
      mutationSerials: { subtitle: 0, dubbing: 0 } as Record<ScriptKind, number>,
      past: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
      future: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
      // 配音稿对账合并：回传文件在对账成功前一直保留，失败可重试
      pendingMergeFile: null as DubbingExportFile | null,
      pendingMergeSource: 'file' as 'file' | 'local',
      mergePlan: null as MergePlan | null,
      mergeIssues: [] as MergeIssue[],
      mergeBusy: false,
    }
  },
  getters: {
    /** 当前正在编辑的稿件（字幕稿或配音稿） */
    document: (state) => state.documents[state.activeScript],
    saveState: (state) => state.saveStates[state.activeScript],
    conflict: (state) => state.conflicts[state.activeScript],
    anyConflict: (state) => state.conflicts.subtitle || state.conflicts.dubbing,
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.documents[state.activeScript].language, key, values),
    selectedCue(state): Cue | undefined {
      return state.documents[state.activeScript].cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): Cue[] {
      const cues = state.documents[state.activeScript].cues
      return state.actorFilter === 'all'
        ? cues
        : cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.documents[state.activeScript].cues.map((cue) => cue.end)) * 1.04
    },
    /** 配音稿相对其基线被配音组改动、尚未合并回字幕稿的台词数 */
    dubbingDirtyLines(state): number {
      const dubbing = state.documents.dubbing
      const base = dubbing.dubbingBase?.lines ?? {}
      return dubbing.cues.filter((cue) => {
        const line = base[cue.id]
        return !line || line.target !== cue.target || line.speed !== cue.speed
      }).length
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      let subtitle = await loadDocument(SUBTITLE_DOCUMENT_ID)
      if (!subtitle) {
        // 迁移早期“字幕+配音混存”的单文档：作为字幕稿留档，配音稿由此派生
        const legacy = await loadDocument(LEGACY_DOCUMENT_ID)
        if (legacy) subtitle = { ...legacy, id: SUBTITLE_DOCUMENT_ID, dubbingBase: null }
      }
      if (subtitle) {
        this.documents.subtitle = subtitle
        this.lastSeenRevisions.subtitle = subtitle.revision
      } else {
        const saved = await saveDocument(plainDocument(this.documents.subtitle))
        this.documents.subtitle = saved
        this.lastSeenRevisions.subtitle = saved.revision
      }
      const dubbing = await loadDocument(DUBBING_DOCUMENT_ID)
      if (dubbing) {
        this.documents.dubbing = dubbing
        this.lastSeenRevisions.dubbing = dubbing.revision
      } else {
        const derived = deriveDubbingDocument(plainDocument(this.documents.subtitle), null)
        const saved = await saveDocument(derived)
        this.documents.dubbing = saved
        this.lastSeenRevisions.dubbing = saved.revision
      }
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId) return
          const kind = SCRIPT_KINDS.find((item) => DOCUMENT_IDS[item] === message.documentId)
          if (!kind || message.revision <= this.lastSeenRevisions[kind]) return
          if (this.saveStates[kind] === 'dirty' || this.saveStates[kind] === 'saving' || this.conflicts[kind]) {
            this.conflicts[kind] = true
            this.saveStates[kind] = 'conflict'
            return
          }
          const latest = await loadDocument(DOCUMENT_IDS[kind])
          if (latest && latest.revision > this.lastSeenRevisions[kind]) {
            this.documents[kind] = latest
            this.lastSeenRevisions[kind] = latest.revision
            this.saveStates[kind] = 'saved'
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    setActiveScript(kind: ScriptKind) {
      if (this.activeScript === kind) return
      this.activeScript = kind
      this.past = []
      this.future = []
      this.selectedCueId = this.documents[kind].cues[0]?.id ?? null
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before = cloneCues(this.document.cues)
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push({ label, cues: before, selectedCueId: this.selectedCueId })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = working
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      const kind = this.activeScript
      this.documents[kind].updatedAt = Date.now()
      if (persist) {
        this.saveStates[kind] = 'dirty'
        this.mutationSerials[kind] += 1
        if (saveTimers[kind]) clearTimeout(saveTimers[kind])
        saveTimers[kind] = setTimeout(() => void this.persist(kind, label), 500)
      }
    },
    async persist(kind: ScriptKind, label = 'autosave') {
      if (!this.initialized || this.conflicts[kind] || this.saveStates[kind] === 'saving') return
      const serial = this.mutationSerials[kind]
      this.saveStates[kind] = 'saving'
      this.saving = true
      try {
        const next = await saveDocument({ ...plainDocument(this.documents[kind]), lastWriter: this.tabId }, this.lastSeenRevisions[kind])
        this.documents[kind].revision = next.revision
        this.documents[kind].updatedAt = next.updatedAt
        this.lastSeenRevisions[kind] = next.revision
        this.saveStates[kind] = serial === this.mutationSerials[kind] ? 'saved' : 'dirty'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_IDS[kind] })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflicts[kind] = true
          this.saveStates[kind] = 'conflict'
        } else {
          this.saveStates[kind] = 'dirty'
          console.error(label, error)
        }
      } finally {
        this.saving = false
        if (this.saveStates[kind] === 'dirty') {
          if (saveTimers[kind]) clearTimeout(saveTimers[kind])
          saveTimers[kind] = setTimeout(() => void this.persist(kind, label), 700)
        }
      }
    },
    conflictedKinds(): ScriptKind[] {
      const kinds = SCRIPT_KINDS.filter((kind) => this.conflicts[kind])
      return kinds.length ? kinds : [this.activeScript]
    },
    async keepMine() {
      this.saving = true
      try {
        for (const kind of this.conflictedKinds()) {
          const latest = await loadDocument(DOCUMENT_IDS[kind])
          const expected = latest?.revision ?? this.lastSeenRevisions[kind]
          const next = await saveDocument({ ...plainDocument(this.documents[kind]), lastWriter: this.tabId }, expected)
          this.documents[kind].revision = next.revision
          this.documents[kind].updatedAt = next.updatedAt
          this.lastSeenRevisions[kind] = next.revision
          this.conflicts[kind] = false
          this.saveStates[kind] = 'saved'
          channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_IDS[kind] })
        }
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      for (const kind of this.conflictedKinds()) {
        const latest = await loadDocument(DOCUMENT_IDS[kind])
        if (!latest) continue
        this.documents[kind] = latest
        this.lastSeenRevisions[kind] = latest.revision
        this.conflicts[kind] = false
        this.saveStates[kind] = 'saved'
        if (kind === this.activeScript) this.selectedCueId = latest.cues[0]?.id ?? null
      }
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const ratio = Math.max(0.25, Math.min(0.75, source.source.length ? 0.5 : 0.5))
      const middle = Number((source.start + (source.end - source.start) * ratio).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length * ratio))
      const targetMid = Math.max(1, Math.round(source.target.length * ratio))
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          target: cue.target.slice(targetMid).trim(),
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        cue.target = cue.target.slice(0, targetMid).trim()
        cue.status = 'draft'
        cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        item.target = `${item.target} ${following.target}`.trim()
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = { id: makeId('snapshot'), name: name.trim() || `v${this.document.snapshots.length + 1}`, createdAt: Date.now(), cues: cloneCues(this.document.cues) }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.future = []
      this.document.cues = cloneCues(snapshot.cues)
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current) => {
        current.splice(0, current.length, ...cues)
      }, cues[0].id)
      return cues.length
    },
    exportSrt() {
      const blob = new Blob([toSrt(this.document.cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
    /**
     * 导出配音稿：按当前字幕稿重新生成配音稿留档（开启新一轮对账基线），
     * 并把自包含基线的配音稿文件交给配音组离线编辑。
     */
    async exportDubbing() {
      const derived = deriveDubbingDocument(plainDocument(this.documents.subtitle), plainDocument(this.documents.dubbing))
      try {
        const saved = await saveDocument({ ...derived, lastWriter: this.tabId }, this.lastSeenRevisions.dubbing)
        this.documents.dubbing = saved
        this.lastSeenRevisions.dubbing = saved.revision
        this.conflicts.dubbing = false
        this.saveStates.dubbing = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: saved.revision, documentId: DUBBING_DOCUMENT_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflicts.dubbing = true
          this.saveStates.dubbing = 'conflict'
        } else {
          console.error('export-dubbing', error)
        }
        return false
      }
      const file = toDubbingExportFile(this.documents.dubbing)
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.documents.subtitle.title || 'dubbing'}-配音稿.json`
      anchor.click()
      URL.revokeObjectURL(url)
      return true
    },
    /** 导入配音组回传的文件并立即对账；失败时文件保留在 pendingMergeFile 中供重试 */
    prepareMergeFromFile(text: string) {
      const parsed = parseDubbingFile(text)
      if (!parsed.ok) {
        this.pendingMergeFile = null
        this.mergePlan = null
        this.mergeIssues = parsed.issues
        return false
      }
      this.pendingMergeFile = parsed.file
      this.pendingMergeSource = 'file'
      return this.reconcilePending()
    },
    /** 直接用本机配音稿留档对账（配音组在同一工作台编辑的场景） */
    prepareMergeFromLocal() {
      this.pendingMergeFile = toDubbingExportFile(this.documents.dubbing)
      this.pendingMergeSource = 'local'
      return this.reconcilePending()
    },
    /** 对账（可重复调用）：只生成合并计划，不写任何数据 */
    reconcilePending() {
      if (!this.pendingMergeFile) return false
      const result = reconcileDubbingLines(this.pendingMergeFile.lines, this.documents.subtitle)
      if (!result.ok) {
        this.mergePlan = null
        this.mergeIssues = result.issues
        return false
      }
      this.mergeIssues = []
      this.mergePlan = result.plan
      return true
    },
    clearMerge() {
      this.pendingMergeFile = null
      this.mergePlan = null
      this.mergeIssues = []
    },
    /**
     * 确认合并：字幕稿与配音稿在同一个 IndexedDB 事务中写入。
     * 任一文档写入失败（含版本冲突）整体回滚，两份稿子都不会留下半成品；
     * 回传文件保留在内存中，解决冲突后可直接重试。
     * 返回写入的台词数，失败返回 false。
     */
    async confirmMerge(): Promise<number | false> {
      const plan = this.mergePlan
      if (!plan || !this.pendingMergeFile || this.mergeBusy) return false
      this.mergeBusy = true
      try {
        const subtitle = plainDocument(this.documents.subtitle)
        const nextSubtitle: EditorDocument = {
          ...subtitle,
          cues: applyMergePlan(subtitle.cues, plan),
          revision: this.lastSeenRevisions.subtitle + 1,
          lastWriter: this.tabId,
        }
        // 配音稿同步到合并后的状态，并以合并结果为新一轮基线
        const nextDubbing = deriveDubbingDocument(nextSubtitle, plainDocument(this.documents.dubbing))
        const [savedSubtitle, savedDubbing] = await saveDocumentsAtomically([
          { document: nextSubtitle, expectedRevision: this.lastSeenRevisions.subtitle },
          { document: nextDubbing, expectedRevision: this.lastSeenRevisions.dubbing },
        ])
        if (this.activeScript === 'subtitle') {
          this.past.push({ label: 'merge-dubbing', cues: cloneCues(this.documents.subtitle.cues), selectedCueId: this.selectedCueId })
          if (this.past.length > 60) this.past.shift()
        } else {
          this.past = []
        }
        this.future = []
        if (saveTimers.subtitle) clearTimeout(saveTimers.subtitle)
        if (saveTimers.dubbing) clearTimeout(saveTimers.dubbing)
        this.documents.subtitle = savedSubtitle
        this.documents.dubbing = savedDubbing
        this.lastSeenRevisions.subtitle = savedSubtitle.revision
        this.lastSeenRevisions.dubbing = savedDubbing.revision
        this.saveStates.subtitle = 'saved'
        this.saveStates.dubbing = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: savedSubtitle.revision, documentId: SUBTITLE_DOCUMENT_ID })
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: savedDubbing.revision, documentId: DUBBING_DOCUMENT_ID })
        const applied = plan.appliedCount
        this.clearMerge()
        return applied
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          const [latestSubtitle, latestDubbing] = await Promise.all([
            loadDocument(SUBTITLE_DOCUMENT_ID),
            loadDocument(DUBBING_DOCUMENT_ID),
          ])
          if (latestSubtitle && latestSubtitle.revision !== this.lastSeenRevisions.subtitle) {
            this.conflicts.subtitle = true
            this.saveStates.subtitle = 'conflict'
          }
          if (latestDubbing && latestDubbing.revision !== this.lastSeenRevisions.dubbing) {
            this.conflicts.dubbing = true
            this.saveStates.dubbing = 'conflict'
          }
          this.mergeIssues = [{ key: 'mergeErrorRevision' }]
        } else {
          console.error('merge-dubbing', error)
          this.mergeIssues = [{ key: 'saveError' }]
        }
        // 写入失败：计划作废（字幕稿可能已变），回传文件保留，可重新对账
        this.mergePlan = null
        return false
      } finally {
        this.mergeBusy = false
      }
    },
  },
})
