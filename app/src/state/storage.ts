// Tiny IndexedDB key-value store. Everything stays on this device.

const DB_NAME = 'webrack'
const STORE = 'kv'

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(database.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function load<T>(key: string): Promise<T | undefined> {
  try {
    return await run<T | undefined>('readonly', (s) => s.get(key))
  } catch {
    return undefined // private browsing or storage blocked: start fresh
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(value, key))
  } catch {
    // Storage unavailable; the session still works, it just won't persist.
  }
}
