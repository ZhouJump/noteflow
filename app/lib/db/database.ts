/**
 * IndexedDB 的最小封装：一个数据库、一次版本升级、四个 store。
 *
 * 事务只做写入/读取本身，大对象（Blob）在进入事务之前准备好，避免在事务里 await
 * 让浏览器把事务提前提交。升级时按 store 逐个补齐，后续新增实体不需要清库。
 */

export type StoreName = 'scores' | 'pages' | 'assets' | 'recognitions'

interface StoreIndex {
  name: string
  keyPath: string
  unique?: boolean
}

interface StoreDefinition {
  name: StoreName
  keyPath: string
  indexes?: StoreIndex[]
}

/** 新增实体时追加定义并把 `DATABASE_VERSION` 加一，旧数据不受影响。 */
const STORE_DEFINITIONS: StoreDefinition[] = [
  {
    name: 'scores',
    keyPath: 'id',
    indexes: [{ name: 'byUpdatedAt', keyPath: 'updatedAt' }]
  },
  {
    name: 'pages',
    keyPath: 'id',
    indexes: [{ name: 'byScore', keyPath: 'scoreId' }]
  },
  {
    name: 'assets',
    keyPath: 'id',
    indexes: [{ name: 'byScore', keyPath: 'scoreId' }]
  },
  {
    name: 'recognitions',
    keyPath: 'id',
    indexes: [{ name: 'byScore', keyPath: 'scoreId' }]
  }
]

const DATABASE_NAME = 'noteflow'
const DATABASE_VERSION = 1

let connection: Promise<IDBDatabase> | null = null

function upgrade(database: IDBDatabase, transaction: IDBTransaction | null): void {
  for (const definition of STORE_DEFINITIONS) {
    const store = database.objectStoreNames.contains(definition.name)
      ? transaction?.objectStore(definition.name) ?? null
      : database.createObjectStore(definition.name, { keyPath: definition.keyPath })
    if (store === null) continue
    for (const index of definition.indexes ?? []) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, index.keyPath, { unique: index.unique === true })
      }
    }
  }
}

/** 打开数据库；失败后允许下次重试（例如用户清理存储后）。 */
export function openDatabase(): Promise<IDBDatabase> {
  if (!import.meta.client) return Promise.reject(new Error('IndexedDB 只在浏览器里可用'))
  if (connection !== null) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => upgrade(request.result, request.transaction)
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
    request.onblocked = () => reject(new Error('本地数据库被其他标签页占用，请关闭后重试'))
  }).catch((error: unknown) => {
    connection = null
    throw error
  })
  return connection
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

export async function getRecord<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(store, 'readonly')
  return requestResult(transaction.objectStore(store).get(key) as IDBRequest<T | undefined>)
}

export async function getAllRecords<T>(store: StoreName): Promise<T[]> {
  const database = await openDatabase()
  const transaction = database.transaction(store, 'readonly')
  return requestResult(transaction.objectStore(store).getAll() as IDBRequest<T[]>)
}

export async function getAllByIndex<T>(
  store: StoreName,
  index: string,
  key: IDBValidKey
): Promise<T[]> {
  const database = await openDatabase()
  const transaction = database.transaction(store, 'readonly')
  return requestResult(
    transaction.objectStore(store).index(index).getAll(key) as IDBRequest<T[]>
  )
}

export interface StoreWrite {
  store: StoreName
  records: object[]
}

/** 一次事务写完多个 store；任何一条失败整体回滚。 */
export async function writeBatch(writes: StoreWrite[]): Promise<void> {
  if (writes.length === 0) return
  const database = await openDatabase()
  const names = [...new Set(writes.map(write => write.store))]
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(names, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('写入本地数据库失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('写入已回滚'))
    try {
      for (const write of writes) {
        const store = transaction.objectStore(write.store)
        for (const record of write.records) store.put(record)
      }
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
}

export interface StoreDelete {
  store: StoreName
  keys: IDBValidKey[]
}

export async function deleteBatch(deletes: StoreDelete[]): Promise<void> {
  const pending = deletes.filter(entry => entry.keys.length > 0)
  if (pending.length === 0) return
  const database = await openDatabase()
  const names = [...new Set(pending.map(entry => entry.store))]
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(names, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('删除失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('删除已回滚'))
    try {
      for (const entry of pending) {
        const store = transaction.objectStore(entry.store)
        for (const key of entry.keys) store.delete(key)
      }
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
}
