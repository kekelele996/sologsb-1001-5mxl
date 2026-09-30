import { defineStore } from 'pinia'
import type { Actor, DubbingDocument, Locale, ReconcileResult, SubtitleDocument } from '../types'
import {
  commitDubbingMerge,
  ensureDocuments,
  loadDubbingDocument,
  loadSubtitleDocument,
  saveDubbingDocument,
  DUBBING_DOC_ID,
} from '../utils/db'
import { buildDubbingExport, parseDubbingFile, reconcileDubbing, syncDubbingCues } from '../utils/dubbing'
import { makeId } from '../utils/id'
import { translate, type MessageKey } from '../i18n'

let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const plainDocument = (document: DubbingDocument): DubbingDocument => JSON.parse(JSON.stringify(document)) as DubbingDocument

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

interface PendingImport {
  filename: string
  exportedAt: number
  subtitleRevision: number
  lines: ReturnType<typeof parseDubbingFile>['lines']
}

export const useDubbingStore = defineStore('dubbing-editor', {
  state: () => ({
    document: {
      id: DUBBING_DOC_ID,
      title: '',
      cues: [],
      revision: 0,
      updatedAt: 0,
      lastWriter: '',
      lastExportAt: null,
    } as DubbingDocument,
    actors: [] as Actor[],
    subtitleCues: [] as SubtitleDocument['cues'],
    locale: 'zh-CN' as Locale,
    selectedCueId: null as string | null,
    actorFilter: 'all',
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    // 回传对账
    mergeOpen: false,
    pendingImport: null as PendingImport | null,
    results: [] as ReconcileResult[],
    committing: false,
    mergeError: null as string | null,
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) =>
      translate(state.locale, key, values),
    cues(state): DubbingDocument['cues'] {
      return state.document?.cues ?? []
    },
    visibleCues(state): DubbingDocument['cues'] {
      if (state.actorFilter === 'all') return state.document?.cues ?? []
      return (state.document?.cues ?? []).filter((cue) => cue.actorId === state.actorFilter)
    },
    changedCount(state): number {
      return state.results.filter((result) => result.status === 'changed').length
    },
    unchangedCount(state): number {
      return state.results.filter((result) => result.status === 'unchanged').length
    },
    failureCount(state): number {
      return state.results.filter((result) => result.status === 'missing' || result.status === 'drifted').length
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      const { subtitle, dubbing } = await ensureDocuments()
      this.document = dubbing
      this.actors = subtitle.actors
      this.subtitleCues = subtitle.cues
      this.locale = subtitle.language
      this.lastSeenRevision = dubbing.revision
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DUBBING_DOC_ID) return
          if (message.revision <= this.lastSeenRevision) return
          if (this.saveState === 'dirty' || this.saveState === 'saving' || this.conflict) {
            this.conflict = true
            this.saveState = 'conflict'
            return
          }
          const latest = await loadDubbingDocument()
          if (latest && latest.revision > this.lastSeenRevision) {
            this.document = latest
            this.lastSeenRevision = latest.revision
            this.saveState = 'saved'
          }
        }
      }
    },
    setLocale(locale: Locale) {
      this.locale = locale
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    actorName(id: string): string {
      return this.actors.find((actor) => actor.id === id)?.name ?? '—'
    },
    actorColor(id: string): string {
      return this.actors.find((actor) => actor.id === id)?.color ?? '#6d7b91'
    },
    isOrphan(cueId: string): boolean {
      return !this.subtitleCues.some((cue) => cue.id === cueId)
    },
    isLockedOrReviewed(cueId: string): boolean {
      const cue = this.subtitleCues.find((item) => item.id === cueId)
      return !!cue && (cue.locked || cue.status === 'reviewed')
    },
    markChanged() {
      if (!this.document) return
      this.document.updatedAt = Date.now()
      this.saveState = 'dirty'
      this.mutationSerial += 1
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void this.persist(), 500)
    },
    async persist() {
      if (!this.document || !this.initialized || this.conflict || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const next = await saveDubbingDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, this.lastSeenRevision)
        this.document.revision = next.revision
        this.document.updatedAt = next.updatedAt
        this.lastSeenRevision = next.revision
        if (serial === this.mutationSerial) this.saveState = 'saved'
        else this.saveState = 'dirty'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DUBBING_DOC_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflict = true
          this.saveState = 'conflict'
        } else {
          this.saveState = 'dirty'
          console.error('dubbing persist', error)
        }
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(), 700)
        }
      }
    },
    async keepMine() {
      if (!this.document) return
      try {
        this.saving = true
        const latest = await loadDubbingDocument()
        const expected = latest?.revision ?? this.lastSeenRevision
        const next = await saveDubbingDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, expected)
        this.document.revision = next.revision
        this.lastSeenRevision = next.revision
        this.conflict = false
        this.saveState = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DUBBING_DOC_ID })
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      const latest = await loadDubbingDocument()
      if (!latest) return
      this.document = latest
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.cueId ?? null
    },
    /** 导出配音稿 JSON（配音组离线编辑用） */
    async exportDubbing() {
      if (!this.document) return
      const subtitle = await loadSubtitleDocument()
      if (!subtitle) return
      this.subtitleCues = subtitle.cues
      this.actors = subtitle.actors
      const payload = buildDubbingExport(subtitle, this.document)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'dubbing'}.dubbing.json`
      anchor.click()
      URL.revokeObjectURL(url)
      this.document.lastExportAt = Date.now()
      this.markChanged()
    },
    /** 导入配音组回传文件：解析 + 预览对账（不写库） */
    async importDubbingFile(file: File) {
      const text = await file.text()
      const parsed = parseDubbingFile(text)
      const subtitle = await loadSubtitleDocument()
      if (!subtitle) throw new Error('NO_SUBTITLE')
      this.subtitleCues = subtitle.cues
      this.actors = subtitle.actors
      this.pendingImport = { filename: file.name, exportedAt: parsed.exportedAt, subtitleRevision: parsed.subtitleRevision, lines: parsed.lines }
      this.results = reconcileDubbing(parsed.lines, subtitle.cues, this.document?.cues ?? [])
      this.mergeError = null
      this.mergeOpen = true
    },
    /** 重新对账：以当前字幕稿/配音稿状态重跑对账（失败后重试） */
    async retryReconcile() {
      if (!this.pendingImport || !this.document) return
      const subtitle = await loadSubtitleDocument()
      if (!subtitle) return
      this.subtitleCues = subtitle.cues
      this.actors = subtitle.actors
      this.results = reconcileDubbing(this.pendingImport.lines, subtitle.cues, this.document.cues)
      this.mergeError = null
    },
    /** 应用合并：单事务原子提交；失败则保留结果供重试 */
    async applyMerge() {
      if (!this.pendingImport) return
      this.committing = true
      this.mergeError = null
      try {
        const outcome = await commitDubbingMerge(this.pendingImport.lines)
        this.results = outcome.results
        if (!outcome.ok) {
          // 对账失败：事务已 abort，无任何写入；保留弹窗与结果供重试
          this.mergeError = 'reconcile-failed'
          return
        }
        const latest = await loadDubbingDocument()
        if (latest) {
          this.document = latest
          this.lastSeenRevision = latest.revision
          this.saveState = 'saved'
        }
        this.mergeOpen = false
        this.pendingImport = null
      } catch (error) {
        this.mergeError = 'commit-failed'
        console.error('dubbing merge', error)
      } finally {
        this.committing = false
      }
    },
    closeMerge() {
      if (this.committing) return
      this.mergeOpen = false
    },
    /** 本地编辑配音台词（口播用词 / 角色 / 语速） */
    updateDubbingCue(cueId: string, patch: Partial<{ dubbingText: string; actorId: string; speed: number }>) {
      if (!this.document) return
      const cue = this.document.cues.find((item) => item.cueId === cueId)
      if (!cue) return
      if (patch.dubbingText !== undefined) cue.dubbingText = patch.dubbingText
      if (patch.actorId !== undefined) cue.actorId = patch.actorId
      if (patch.speed !== undefined) cue.speed = patch.speed
      cue.modified = true
      this.markChanged()
    },
    /** 字幕稿新增 cue 后补齐配音条目（不删除已有配音条目） */
    async syncFromSubtitle() {
      if (!this.document) return
      const subtitle = await loadSubtitleDocument()
      if (!subtitle) return
      this.subtitleCues = subtitle.cues
      this.actors = subtitle.actors
      const next = syncDubbingCues(this.document, subtitle.cues)
      if (next !== this.document) {
        this.document = next
        this.markChanged()
      }
    },
  },
})
