import type {
  DubbingCue,
  DubbingDocument,
  DubbingExportFile,
  ReconcileField,
  ReconcileLine,
  ReconcileMatch,
  ReconcileResult,
  SubtitleCue,
  SubtitleDocument,
} from '../types'

export const DUBBING_FORMAT = 'sologsb-dubbing-export'
export const DUBBING_VERSION = 1
/** 时间码漂移容忍度（秒）：超过则认为字幕组已改动时间码，对账失败 */
export const DRIFT_TOLERANCE = 0.5

export const buildReconcileLine = (cue: {
  cueId: string
  start: number
  end: number
  actorId: string
  speed: number
  dubbingText: string
}): ReconcileLine => ({
  cueId: cue.cueId,
  start: cue.start,
  end: cue.end,
  actorId: cue.actorId,
  speed: cue.speed,
  dubbingText: cue.dubbingText,
})

/** 导出配音稿：生成配音组离线编辑用的 JSON 文件 */
export const buildDubbingExport = (
  subtitle: SubtitleDocument,
  dubbing: DubbingDocument,
): DubbingExportFile => ({
  format: DUBBING_FORMAT,
  version: DUBBING_VERSION,
  exportedAt: Date.now(),
  subtitleRevision: subtitle.revision,
  actors: subtitle.actors.map((actor) => ({ id: actor.id, name: actor.name, color: actor.color })),
  cues: dubbing.cues.map((cue) => ({
    cueId: cue.cueId,
    start: cue.start,
    end: cue.end,
    actorId: cue.actorId,
    speed: cue.speed,
    dubbingText: cue.dubbingText,
  })),
})

/** 解析配音组回传的文件，返回对账行；格式不对时抛错 */
export const parseDubbingFile = (text: string): { exportedAt: number; subtitleRevision: number; lines: ReconcileLine[] } => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('DUBBING_PARSE')
  }
  const file = data as Partial<DubbingExportFile>
  if (!file || file.format !== DUBBING_FORMAT || file.version !== DUBBING_VERSION || !Array.isArray(file.cues)) {
    throw new Error('DUBBING_FORMAT')
  }
  const lines: ReconcileLine[] = []
  for (const raw of file.cues) {
    const cue = raw as Partial<ReconcileLine>
    if (typeof cue.cueId !== 'string' || typeof cue.start !== 'number' || typeof cue.end !== 'number' || typeof cue.dubbingText !== 'string') {
      throw new Error('DUBBING_FORMAT')
    }
    lines.push({
      cueId: cue.cueId,
      start: cue.start,
      end: cue.end,
      actorId: typeof cue.actorId === 'string' ? cue.actorId : '',
      speed: typeof cue.speed === 'number' ? cue.speed : 1,
      dubbingText: cue.dubbingText,
    })
  }
  return { exportedAt: file.exportedAt ?? 0, subtitleRevision: file.subtitleRevision ?? 0, lines }
}

/**
 * 逐条对账（纯函数，无副作用）：
 * 1. 按 cueId 匹配字幕 cue；找不到则按时间码就近匹配，再找不到按顺序匹配
 * 2. 匹配上后检测时间码漂移，超过容忍度 → drifted（对账失败）
 * 3. 与配音稿 baseText 比对：dubbingText / actorId / speed 有差异 → changed（可写入），否则 unchanged（跳过）
 * 4. 完全找不到 → missing（对账失败）
 */
export const reconcileDubbing = (
  imported: ReconcileLine[],
  subtitleCues: SubtitleCue[],
  dubbingCues: DubbingCue[],
  tolerance = DRIFT_TOLERANCE,
): ReconcileResult[] => {
  const usedSubtitleIds = new Set<string>()

  return imported.map((line, index) => {
    let sub = subtitleCues.find((cue) => cue.id === line.cueId)
    let matchedBy: ReconcileMatch = sub ? 'id' : null

    // 按 id 找不到 → 按时间码就近匹配（容忍范围内唯一候选）
    if (!sub) {
      const candidates = subtitleCues
        .filter((cue) => !usedSubtitleIds.has(cue.id))
        .map((cue) => ({ cue, drift: Math.abs(cue.start - line.start) }))
        .filter((item) => item.drift <= tolerance)
        .sort((a, b) => a.drift - b.drift)
      if (candidates.length === 1) {
        sub = candidates[0].cue
        matchedBy = 'timecode'
      }
    }

    // 还找不到 → 按顺序匹配（第 n 行对第 n 条）
    if (!sub) {
      const byOrder = subtitleCues[index]
      if (byOrder && !usedSubtitleIds.has(byOrder.id)) {
        sub = byOrder
        matchedBy = 'order'
      }
    }

    if (!sub) {
      return {
        cueId: line.cueId,
        importedCueId: line.cueId,
        status: 'missing',
        matchedBy: null,
        drift: 0,
        changedFields: [],
        reason: 'missing',
        subtitleStart: null,
        subtitleEnd: null,
        actorId: line.actorId,
        speed: line.speed,
        dubbingText: line.dubbingText,
      } satisfies ReconcileResult
    }

    usedSubtitleIds.add(sub.id)
    const drift = Math.abs(sub.start - line.start)

    if (drift > tolerance) {
      return {
        cueId: sub.id,
        importedCueId: line.cueId,
        status: 'drifted',
        matchedBy,
        drift,
        changedFields: [],
        reason: 'drifted',
        subtitleStart: sub.start,
        subtitleEnd: sub.end,
        actorId: line.actorId,
        speed: line.speed,
        dubbingText: line.dubbingText,
      } satisfies ReconcileResult
    }

    const dub = dubbingCues.find((cue) => cue.cueId === sub!.id)
    const baseText = dub?.baseText ?? ''
    const changedFields: ReconcileField[] = []
    if (line.dubbingText !== baseText) changedFields.push('dubbingText')
    if (line.actorId !== (dub?.actorId ?? '')) changedFields.push('actorId')
    if (line.speed !== (dub?.speed ?? 1)) changedFields.push('speed')

    return {
      cueId: sub.id,
      importedCueId: line.cueId,
      status: changedFields.length ? 'changed' : 'unchanged',
      matchedBy,
      drift,
      changedFields,
      reason: changedFields.length ? 'changed' : 'unchanged',
      subtitleStart: sub.start,
      subtitleEnd: sub.end,
      actorId: line.actorId,
      speed: line.speed,
      dubbingText: line.dubbingText,
    } satisfies ReconcileResult
  })
}

/**
 * 应用合并（纯函数）：只写 status === 'changed' 的台词，其余原样保留。
 * 返回新的配音稿（不可变更新）。
 */
export const applyDubbingMerge = (
  dubbing: DubbingDocument,
  imported: ReconcileLine[],
  results: ReconcileResult[],
): DubbingDocument => {
  const next: DubbingDocument = {
    ...dubbing,
    cues: dubbing.cues.map((cue) => ({ ...cue })),
  }

  for (const result of results) {
    if (result.status !== 'changed') continue
    const line = imported.find((item) => item.cueId === result.importedCueId)
    if (!line) continue

    let target = next.cues.find((cue) => cue.cueId === result.cueId)
    if (!target) {
      target = {
        cueId: result.cueId,
        start: line.start,
        end: line.end,
        actorId: line.actorId,
        speed: line.speed,
        dubbingText: '',
        baseText: '',
        modified: false,
      }
      next.cues.push(target)
    }

    if (result.changedFields.includes('dubbingText')) {
      target.dubbingText = line.dubbingText
      target.baseText = line.dubbingText
    }
    if (result.changedFields.includes('actorId')) target.actorId = line.actorId
    if (result.changedFields.includes('speed')) target.speed = line.speed
    target.start = line.start
    target.end = line.end
    target.modified = true
  }

  return next
}

/** 字幕稿新增 cue 后，补齐配音稿里缺失的条目（不删除任何已有配音条目） */
export const syncDubbingCues = (dubbing: DubbingDocument, subtitleCues: SubtitleCue[]): DubbingDocument => {
  const existing = new Set(dubbing.cues.map((cue) => cue.cueId))
  const additions: DubbingCue[] = subtitleCues
    .filter((cue) => !existing.has(cue.id))
    .map((cue) => ({
      cueId: cue.id,
      start: cue.start,
      end: cue.end,
      actorId: dubbing.cues[0]?.actorId ?? 'actor-narrator',
      speed: 1,
      dubbingText: cue.target || cue.source,
      baseText: cue.target || cue.source,
      modified: false,
    }))
  if (!additions.length) return dubbing
  return { ...dubbing, cues: [...dubbing.cues, ...additions] }
}
