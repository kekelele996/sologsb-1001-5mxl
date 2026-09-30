export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'
export type ScriptKind = 'subtitle' | 'dubbing'

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

export interface DubbingBaseLine {
  target: string
  speed: number
}

/** 配音稿的基线：本轮从字幕稿导出时，每条台词的口播词与语速 */
export interface DubbingBase {
  revision: number
  createdAt: number
  lines: Record<string, DubbingBaseLine>
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
  /** 仅配音稿使用：标记本轮对账基线 */
  dubbingBase?: DubbingBase | null
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

/** 配音稿回传文件中的一行 */
export interface DubbingExportLine {
  cueId: string
  base: DubbingBaseLine
  target: string
  speed: number
}

/** 配音稿离线编辑后回传的文件格式 */
export interface DubbingExportFile {
  kind: 'dubbing-script'
  version: 1
  documentId: string
  baseRevision: number
  exportedAt: number
  lines: DubbingExportLine[]
}

export type MergeLineKind = 'applied' | 'preserved' | 'unchanged'

export interface MergeLineResult {
  cueId: string
  kind: MergeLineKind
  /** kind 为 preserved 时说明保留原因 */
  reason?: 'locked' | 'reviewed'
  /** 字幕组在本轮也改过这条（写入时以配音稿为准，需复核） */
  conflict?: boolean
  from?: DubbingBaseLine
  to?: DubbingBaseLine
}

export interface MergePlan {
  results: MergeLineResult[]
  appliedCount: number
  preservedCount: number
  unchangedCount: number
  conflictCount: number
}

/** 对账问题：key 为 i18n 消息键，values 为插值参数 */
export interface MergeIssue {
  key: string
  values?: Record<string, string | number>
}
