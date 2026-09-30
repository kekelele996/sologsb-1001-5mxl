export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}

// —— 字幕稿：字幕组负责（时间码 + 译文 + 锁定/确认）——
export interface SubtitleCue {
  id: string
  start: number
  end: number
  source: string
  target: string
  status: CueStatus
  locked: boolean
}

export interface SubtitleDocument {
  id: string
  title: string
  language: Locale
  cues: SubtitleCue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

// —— 配音稿：配音组负责（口播用词 + 角色 + 语速），按 cueId 与字幕稿对账 ——
export interface DubbingCue {
  cueId: string
  start: number
  end: number
  actorId: string
  speed: number
  dubbingText: string
  /** 最近一次导出/合并时的口播文本，用于判断配音组是否真的改过 */
  baseText: string
  modified: boolean
}

export interface DubbingDocument {
  id: string
  title: string
  cues: DubbingCue[]
  updatedAt: number
  revision: number
  lastWriter: string
  lastExportAt: number | null
}

// —— 配音回传文件格式 ——
export interface DubbingExportFile {
  format: 'sologsb-dubbing-export'
  version: 1
  exportedAt: number
  subtitleRevision: number
  actors: Pick<Actor, 'id' | 'name' | 'color'>[]
  cues: {
    cueId: string
    start: number
    end: number
    actorId: string
    speed: number
    dubbingText: string
  }[]
}

// —— 对账 ——
export type ReconcileStatus = 'changed' | 'unchanged' | 'missing' | 'drifted'
export type ReconcileMatch = 'id' | 'order' | 'timecode' | null
export type ReconcileField = 'dubbingText' | 'actorId' | 'speed'

export interface ReconcileLine {
  cueId: string
  start: number
  end: number
  actorId: string
  speed: number
  dubbingText: string
}

export interface ReconcileResult {
  /** 对账后的标准字幕 cueId（合并写入用） */
  cueId: string
  /** 回传文件里写的 cueId（可能与标准 cueId 不同，用于回溯） */
  importedCueId: string
  status: ReconcileStatus
  matchedBy: ReconcileMatch
  drift: number
  changedFields: ReconcileField[]
  reason: 'changed' | 'unchanged' | 'missing' | 'drifted'
  subtitleStart: number | null
  subtitleEnd: number | null
  actorId: string
  speed: number
  dubbingText: string
}

export interface MergeLogRecord {
  id: string
  at: number
  type: 'dubbing-merge'
  changedCount: number
  unchangedCount: number
  /** 合并事务是否触碰了字幕稿（保证为 false） */
  touchedSubtitle: false
  lines: ReconcileResult[]
}

export interface MergeCommitOutcome {
  ok: boolean
  results: ReconcileResult[]
  changedCount: number
  unchangedCount: number
  subtitleRevision: number
}
