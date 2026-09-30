import type {
  DubbingDocument,
  EditorDocument,
  MergeCommitOutcome,
  MergeLogRecord,
  ReconcileLine,
  ReconcileResult,
  SubtitleDocument,
} from '../types'
import { applyDubbingMerge, reconcileDubbing, syncDubbingCues } from './dubbing'
import { makeId } from './id'

const DB_NAME = 'sologsb-1001'
const STORE = 'documents'
export const SUBTITLE_DOC_ID = 'subtitle-document'
export const DUBBING_DOC_ID = 'dubbing-document'
const LEGACY_DOC_ID = 'subtitle-dubbing-document'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const reqAsPromise = <T>(request: IDBRequest<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const transact = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export const loadDocument = (id: string) => transact<EditorDocument | undefined>('readonly', (store) => store.get(id))

export const saveDocument = async (document: EditorDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<EditorDocument>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const getRequest = store.get(document.id)
    let next: EditorDocument | undefined
    let settled = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as EditorDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        settled = true
        reject(new Error('REVISION_CONFLICT'))
        return
      }
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && next) resolve(next)
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}

export const loadSubtitleDocument = () =>
  transact<SubtitleDocument | undefined>('readonly', (store) => store.get(SUBTITLE_DOC_ID))

export const loadDubbingDocument = () =>
  transact<DubbingDocument | undefined>('readonly', (store) => store.get(DUBBING_DOC_ID))

export const saveSubtitleDocument = async (document: SubtitleDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<SubtitleDocument>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const getRequest = store.get(document.id)
    let next: SubtitleDocument | undefined
    let settled = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as SubtitleDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        settled = true
        reject(new Error('REVISION_CONFLICT'))
        return
      }
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && next) resolve(next)
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}

export const saveDubbingDocument = async (document: DubbingDocument, expectedRevision?: number) => {
  const db = await openDb()
  return new Promise<DubbingDocument>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const getRequest = store.get(document.id)
    let next: DubbingDocument | undefined
    let settled = false
    getRequest.onsuccess = () => {
      const current = getRequest.result as DubbingDocument | undefined
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision) {
        settled = true
        reject(new Error('REVISION_CONFLICT'))
        return
      }
      next = { ...document, revision: (current?.revision ?? document.revision ?? 0) + 1, updatedAt: Date.now() }
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      if (!settled && next) resolve(next)
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
  })
}

const splitLegacyToSubtitle = (legacy: EditorDocument): SubtitleDocument => ({
  id: SUBTITLE_DOC_ID,
  title: legacy.title,
  language: legacy.language,
  revision: legacy.revision,
  updatedAt: legacy.updatedAt,
  lastWriter: legacy.lastWriter,
  actors: legacy.actors,
  terms: legacy.terms,
  snapshots: legacy.snapshots,
  cues: legacy.cues.map((cue) => ({
    id: cue.id,
    start: cue.start,
    end: cue.end,
    source: cue.source,
    target: cue.target,
    status: cue.status,
    locked: cue.locked,
  })),
})

const splitLegacyToDubbing = (legacy: EditorDocument): DubbingDocument => ({
  id: DUBBING_DOC_ID,
  title: legacy.title,
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  lastExportAt: null,
  cues: legacy.cues.map((cue) => ({
    cueId: cue.id,
    start: cue.start,
    end: cue.end,
    actorId: cue.actorId,
    speed: cue.speed,
    dubbingText: cue.target || cue.source,
    baseText: cue.target || cue.source,
    modified: false,
  })),
})

export const createDefaultSubtitleDocument = (): SubtitleDocument => ({
  id: SUBTITLE_DOC_ID,
  title: '纪录片《开源之路》中文字幕',
  language: 'zh-CN',
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
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
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', status: 'draft', locked: false },
  ],
  snapshots: [],
})

export const createDefaultDubbingDocument = (subtitle: SubtitleDocument): DubbingDocument => ({
  id: DUBBING_DOC_ID,
  title: subtitle.title,
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  lastExportAt: null,
  cues: subtitle.cues.map((cue) => ({
    cueId: cue.id,
    start: cue.start,
    end: cue.end,
    actorId: 'actor-narrator',
    speed: 1,
    dubbingText: cue.target || cue.source,
    baseText: cue.target || cue.source,
    modified: false,
  })),
})

/**
 * 确保两份文档都存在（同一事务，原子迁移）：
 * - 字幕稿不存在时，从旧的单文档迁移拆分出字幕稿 + 配音稿
 * - 字幕稿存在但配音稿缺失时，补配音稿
 */
export const ensureDocuments = async (): Promise<{ subtitle: SubtitleDocument; dubbing: DubbingDocument }> => {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  try {
    let subtitle = (await reqAsPromise(store.get(SUBTITLE_DOC_ID))) as SubtitleDocument | undefined
    let dubbing = (await reqAsPromise(store.get(DUBBING_DOC_ID))) as DubbingDocument | undefined

    if (!subtitle) {
      const legacy = (await reqAsPromise(store.get(LEGACY_DOC_ID))) as EditorDocument | undefined
      if (legacy) {
        subtitle = splitLegacyToSubtitle(legacy)
        dubbing = splitLegacyToDubbing(legacy)
      } else {
        subtitle = createDefaultSubtitleDocument()
        dubbing = createDefaultDubbingDocument(subtitle)
      }
      store.put(subtitle)
      store.put(dubbing)
    } else if (!dubbing) {
      dubbing = createDefaultDubbingDocument(subtitle)
      store.put(dubbing)
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(new Error('TRANSACTION_ABORTED'))
    })
    db.close()
    return { subtitle, dubbing }
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * 配音回传合并（单事务，原子提交）：
 * - 同一事务内读取字幕稿（只读，绝不 put）与配音稿
 * - 重新逐条对账（以 IDB 最新状态为准），任一 missing/drifted 则 abort，不写任何内容
 * - 全部通过才写入配音稿（只写 changed 行）+ 合并日志
 * - 字幕稿在整个事务中只读，touchedSubtitle 恒为 false
 */
export const commitDubbingMerge = async (imported: ReconcileLine[]): Promise<MergeCommitOutcome> => {
  const db = await openDb()
  return new Promise<MergeCommitOutcome>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    let settled = false

    const finish = (outcome: MergeCommitOutcome) => {
      settled = true
      db.close()
      resolve(outcome)
    }

    tx.onabort = () => {
      db.close()
      if (!settled) reject(tx.error ?? new Error('TRANSACTION_ABORTED'))
    }
    tx.onerror = () => {
      db.close()
      if (!settled) reject(tx.error)
    }

    const subReq = store.get(SUBTITLE_DOC_ID)
    subReq.onsuccess = () => {
      const subtitle = subReq.result as SubtitleDocument | undefined
      const dubReq = store.get(DUBBING_DOC_ID)
      dubReq.onsuccess = () => {
        const currentDubbing = dubReq.result as DubbingDocument | undefined
        const dubbing = currentDubbing ?? createDefaultDubbingDocument(subtitle ?? createDefaultSubtitleDocument())
        const results: ReconcileResult[] = reconcileDubbing(imported, subtitle?.cues ?? [], dubbing.cues)

        if (results.some((result) => result.status === 'missing' || result.status === 'drifted')) {
          // 对账失败：abort 回滚，不写任何内容；调用方可据此重试
          tx.abort()
          finish({
            ok: false,
            results,
            changedCount: 0,
            unchangedCount: results.filter((result) => result.status === 'unchanged').length,
            subtitleRevision: subtitle?.revision ?? 0,
          })
          return
        }

        const merged = applyDubbingMerge(dubbing, imported, results)
        const next: DubbingDocument = {
          ...merged,
          cues: syncDubbingCues(merged, subtitle?.cues ?? []).cues,
          revision: dubbing.revision + 1,
          updatedAt: Date.now(),
        }
        store.put(next)

        const changedCount = results.filter((result) => result.status === 'changed').length
        const log: MergeLogRecord = {
          id: makeId('merge'),
          at: Date.now(),
          type: 'dubbing-merge',
          changedCount,
          unchangedCount: results.filter((result) => result.status === 'unchanged').length,
          touchedSubtitle: false,
          lines: results,
        }
        store.put(log)

        tx.oncomplete = () => {
          finish({ ok: true, results, changedCount, unchangedCount: log.unchangedCount, subtitleRevision: subtitle?.revision ?? 0 })
        }
      }
    }
  })
}
