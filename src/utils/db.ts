import type { EditorDocument } from '../types'

const DB_NAME = 'sologsb-1001'
const STORE = 'documents'

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
  }
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

export interface SaveEntry {
  document: EditorDocument
  expectedRevision?: number
}

/**
 * 在同一个事务里写入多份文档：先校验全部预期版本，再统一写入。
 * 任一文档版本冲突或写入失败都会中止整个事务，保证不会留下只写了一半的状态。
 */
export const saveDocumentsAtomically = async (entries: SaveEntry[]) => {
  const db = await openDb()
  return new Promise<EditorDocument[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const next: EditorDocument[] = new Array(entries.length)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try {
        tx.abort()
      } catch {
        // 事务可能已结束，忽略
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    entries.forEach((entry, index) => {
      const getRequest = store.get(entry.document.id)
      getRequest.onsuccess = () => {
        if (settled) return
        const current = getRequest.result as EditorDocument | undefined
        if (entry.expectedRevision !== undefined && current && current.revision !== entry.expectedRevision) {
          fail(new Error('REVISION_CONFLICT'))
          return
        }
        next[index] = { ...entry.document, revision: (current?.revision ?? entry.document.revision ?? 0) + 1, updatedAt: Date.now() }
        const putRequest = store.put(next[index])
        putRequest.onerror = () => fail(putRequest.error)
      }
      getRequest.onerror = () => fail(getRequest.error)
    })
    tx.oncomplete = () => {
      db.close()
      if (!settled) resolve(next)
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
