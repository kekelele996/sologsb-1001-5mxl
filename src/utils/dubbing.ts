import type {
  Cue, DubbingBase, DubbingExportFile, DubbingExportLine, EditorDocument,
  MergeIssue, MergeLineResult, MergePlan,
} from '../types'

export const SUBTITLE_DOCUMENT_ID = 'subtitle-script'
export const DUBBING_DOCUMENT_ID = 'dubbing-script'
export const LEGACY_DOCUMENT_ID = 'subtitle-dubbing-document'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 以字幕稿当前内容为基线，生成本轮配音对账基线 */
export const buildDubbingBase = (cues: Cue[], revision: number): DubbingBase => ({
  revision,
  createdAt: Date.now(),
  lines: Object.fromEntries(cues.map((cue) => [cue.id, { target: cue.target, speed: cue.speed }])),
})

/**
 * 从字幕稿重新生成配音稿（开启新一轮）。
 * 台词 id 与字幕稿一一对应，配音稿内全部解锁以便配音组编辑；
 * 保留配音稿已有的版本快照与标题。
 */
export const deriveDubbingDocument = (subtitle: EditorDocument, existing: EditorDocument | null): EditorDocument => ({
  id: DUBBING_DOCUMENT_ID,
  title: existing?.title ?? `${subtitle.title}（配音稿）`,
  language: subtitle.language,
  cues: subtitle.cues.map((cue) => ({ ...clone(cue), locked: false })),
  actors: clone(subtitle.actors),
  terms: clone(subtitle.terms),
  snapshots: existing ? clone(existing.snapshots) : [],
  updatedAt: Date.now(),
  revision: existing?.revision ?? 0,
  lastWriter: existing?.lastWriter ?? '',
  dubbingBase: buildDubbingBase(subtitle.cues, subtitle.revision),
})

/** 把配音稿序列化为可分发的回传文件（自包含基线，离线编辑后可直接对账） */
export const toDubbingExportFile = (dubbing: EditorDocument): DubbingExportFile => ({
  kind: 'dubbing-script',
  version: 1,
  documentId: DUBBING_DOCUMENT_ID,
  baseRevision: dubbing.dubbingBase?.revision ?? 0,
  exportedAt: Date.now(),
  lines: dubbing.cues.map((cue) => ({
    cueId: cue.id,
    base: dubbing.dubbingBase?.lines[cue.id] ?? { target: cue.target, speed: cue.speed },
    target: cue.target,
    speed: cue.speed,
  })),
})

export const parseDubbingFile = (text: string): { ok: true; file: DubbingExportFile } | { ok: false; issues: MergeIssue[] } => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, issues: [{ key: 'mergeErrorBadFile' }] }
  }
  const file = raw as Partial<DubbingExportFile> | null
  if (!file || file.kind !== 'dubbing-script' || file.version !== 1 || !Array.isArray(file.lines)) {
    return { ok: false, issues: [{ key: 'mergeErrorBadFile' }] }
  }
  const issues: MergeIssue[] = []
  file.lines.forEach((line, index) => {
    const item = line as Partial<DubbingExportLine> | null
    if (
      !item
      || typeof item.cueId !== 'string'
      || typeof item.target !== 'string'
      || typeof item.speed !== 'number'
      || typeof item.base?.target !== 'string'
      || typeof item.base?.speed !== 'number'
    ) {
      issues.push({ key: 'mergeErrorBadLine', values: { line: index + 1 } })
    }
  })
  return issues.length ? { ok: false, issues } : { ok: true, file: file as DubbingExportFile }
}

const summarize = (results: MergeLineResult[]): MergePlan => ({
  results,
  appliedCount: results.filter((item) => item.kind === 'applied').length,
  preservedCount: results.filter((item) => item.kind === 'preserved').length,
  unchangedCount: results.filter((item) => item.kind === 'unchanged').length,
  conflictCount: results.filter((item) => item.kind === 'applied' && item.conflict).length,
})

/**
 * 逐条对账：回传台词 vs 当前字幕稿。
 * - 任一条台词对不上（字幕稿不存在 / 文件内重复）→ 整体失败，调用方不得写入；
 * - 配音组没改的行跳过；
 * - 字幕组已锁定或已确认的行保留字幕稿内容；
 * - 其余改动写入口播词与语速，字幕组同时改过的行标注 conflict。
 */
export const reconcileDubbingLines = (
  lines: DubbingExportLine[],
  subtitle: EditorDocument,
): { ok: true; plan: MergePlan } | { ok: false; issues: MergeIssue[] } => {
  const issues: MergeIssue[] = []
  const seen = new Set<string>()
  const cueById = new Map(subtitle.cues.map((cue) => [cue.id, cue]))
  for (const line of lines) {
    if (seen.has(line.cueId)) issues.push({ key: 'mergeErrorDuplicateCue', values: { id: line.cueId } })
    seen.add(line.cueId)
    if (!cueById.has(line.cueId)) issues.push({ key: 'mergeErrorUnknownCue', values: { id: line.cueId } })
  }
  if (issues.length) return { ok: false, issues }
  const results: MergeLineResult[] = lines.map((line) => {
    const cue = cueById.get(line.cueId) as Cue
    if (line.target === line.base.target && line.speed === line.base.speed) {
      return { cueId: line.cueId, kind: 'unchanged' }
    }
    if (cue.locked) {
      return { cueId: line.cueId, kind: 'preserved', reason: 'locked' as const, from: { target: cue.target, speed: cue.speed }, to: { target: line.target, speed: line.speed } }
    }
    if (cue.status === 'reviewed') {
      return { cueId: line.cueId, kind: 'preserved', reason: 'reviewed' as const, from: { target: cue.target, speed: cue.speed }, to: { target: line.target, speed: line.speed } }
    }
    const conflict = cue.target !== line.base.target || cue.speed !== line.base.speed
    return {
      cueId: line.cueId,
      kind: 'applied',
      conflict,
      from: { target: cue.target, speed: cue.speed },
      to: { target: line.target, speed: line.speed },
    }
  })
  return { ok: true, plan: summarize(results) }
}

/** 按对账结果生成新的字幕稿台词数组（纯函数，不改动原数组） */
export const applyMergePlan = (cues: Cue[], plan: MergePlan): Cue[] => {
  const applied = new Map(
    plan.results
      .filter((item) => item.kind === 'applied' && item.to)
      .map((item) => [item.cueId, item.to as NonNullable<MergeLineResult['to']>]),
  )
  return cues.map((cue) => {
    const change = applied.get(cue.id)
    return change ? { ...cue, target: change.target, speed: change.speed } : cue
  })
}
