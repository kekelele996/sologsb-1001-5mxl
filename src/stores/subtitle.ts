import { defineStore } from 'pinia'
import type { Cue, EditorDocument, Locale, Snapshot, SubtitleCue, SubtitleDocument } from '../types'
import { ensureDocuments, createDefaultSubtitleDocument, loadSubtitleDocument, saveSubtitleDocument, SUBTITLE_DOC_ID } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, toSrt } from '../utils/subtitle'
import { translate, type MessageKey } from '../i18n'

let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const cloneCues = (cues: SubtitleCue[]): SubtitleCue[] => JSON.parse(JSON.stringify(cues)) as SubtitleCue[]
const plainDocument = (document: SubtitleDocument): SubtitleDocument => JSON.parse(JSON.stringify(document)) as SubtitleDocument

const toEditorCue = (cue: SubtitleCue, actors: SubtitleDocument['actors']): Cue => ({
  id: cue.id,
  start: cue.start,
  end: cue.end,
  source: cue.source,
  target: cue.target,
  actorId: actors[0]?.id ?? 'actor-narrator',
  speed: 1,
  termIds: [],
  status: cue.status,
  locked: cue.locked,
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useSubtitleStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultSubtitleDocument() as SubtitleDocument,
    selectedCueId: 'cue-demo-03' as string | null,
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    online: navigator.onLine,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    past: [] as { label: string; cues: SubtitleCue[]; selectedCueId: string | null }[],
    future: [] as { label: string; cues: SubtitleCue[]; selectedCueId: string | null }[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) =>
      translate(state.document?.language ?? 'zh-CN', key, values),
    cues(state): SubtitleCue[] {
      return state.document?.cues ?? []
    },
    actors(state): SubtitleDocument['actors'] {
      return state.document?.actors ?? []
    },
    terms(state): SubtitleDocument['terms'] {
      return state.document?.terms ?? []
    },
    snapshots(state): Snapshot[] {
      return state.document?.snapshots ?? []
    },
    selectedCue(state): SubtitleCue | undefined {
      return state.document?.cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): SubtitleCue[] {
      return state.document?.cues ?? []
    },
    totalDuration(state): number {
      return Math.max(10, ...(state.document?.cues ?? []).map((cue) => cue.end)) * 1.04
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const { subtitle } = await ensureDocuments()
      this.document = subtitle
      this.lastSeenRevision = subtitle.revision
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== SUBTITLE_DOC_ID) return
          if (message.revision <= this.lastSeenRevision) return
          if (this.saveState === 'dirty' || this.saveState === 'saving' || this.conflict) {
            this.conflict = true
            this.saveState = 'conflict'
            return
          }
          const latest = await loadSubtitleDocument()
          if (latest && latest.revision > this.lastSeenRevision) {
            this.document = latest
            this.lastSeenRevision = latest.revision
            this.saveState = 'saved'
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      if (!this.document) return
      this.document.language = locale
      this.markChanged('language', true)
    },
    commit(label: string, mutate: (cues: SubtitleCue[]) => void, nextSelection?: string | null) {
      if (!this.document) return
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
      if (!this.document) return
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.document || !this.initialized || this.conflict || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const next = await saveSubtitleDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, this.lastSeenRevision)
        this.document.revision = next.revision
        this.document.updatedAt = next.updatedAt
        this.lastSeenRevision = next.revision
        if (serial === this.mutationSerial) {
          this.saveState = 'saved'
        } else {
          this.saveState = 'dirty'
        }
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: SUBTITLE_DOC_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflict = true
          this.saveState = 'conflict'
        } else {
          this.saveState = 'dirty'
          console.error(label, error)
        }
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 700)
        }
      }
    },
    async keepMine() {
      if (!this.document) return
      try {
        this.saving = true
        const latest = await loadSubtitleDocument()
        const expected = latest?.revision ?? this.lastSeenRevision
        const next = await saveSubtitleDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, expected)
        this.document.revision = next.revision
        this.lastSeenRevision = next.revision
        this.conflict = false
        this.saveState = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: SUBTITLE_DOC_ID })
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      const latest = await loadSubtitleDocument()
      if (!latest) return
      this.document = latest
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
    },
    undo() {
      const entry = this.past.pop()
      if (!entry || !this.document) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry || !this.document) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<SubtitleCue>, historyLabel = 'update-cue') {
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
      const current = this.document?.cues.find((cue) => cue.id === id)
      this.updateCue(id, { locked: !current?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      if (!this.document) return
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
        const second: SubtitleCue = {
          id: secondId,
          start: middle,
          end: cue.end,
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
      if (!this.document) return
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
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      if (!this.document) return
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      if (!this.document) return
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      if (!this.document) return
      const snapshot: Snapshot = {
        id: makeId('snapshot'),
        name: name.trim() || `v${this.document.snapshots.length + 1}`,
        createdAt: Date.now(),
        cues: this.document.cues.map((cue) => ({ ...toEditorCue(cue, this.document!.actors) })),
      }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      if (!this.document) return
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.future = []
      this.document.cues = snapshot.cues.map((cue) => ({
        id: cue.id,
        start: cue.start,
        end: cue.end,
        source: cue.source,
        target: cue.target,
        status: cue.status,
        locked: cue.locked,
      }))
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      if (!this.document) return 0
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      const subtitleCues: SubtitleCue[] = cues.map((cue) => ({
        id: cue.id,
        start: cue.start,
        end: cue.end,
        source: cue.source,
        target: cue.target,
        status: cue.status,
        locked: cue.locked,
      }))
      this.commit('import', (current) => {
        current.splice(0, current.length, ...subtitleCues)
      }, subtitleCues[0].id)
      return subtitleCues.length
    },
    exportSrt() {
      if (!this.document) return
      const cues: Cue[] = this.document.cues.map((cue) => toEditorCue(cue, this.document!.actors))
      const blob = new Blob([toSrt(cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})
