// The device's own copy of every message. The server keeps three days; this is
// the only place anything older lives. A classic script rather than a module,
// because the service worker loads it with importScripts and not every browser
// runs module workers yet.
(function (global) {
  const DB_NAME = "notifier";
  const VERSION = 1;
  // Long enough that the server has certainly forgotten the message too, so a
  // sync can never bring back something the user deleted.
  const TOMBSTONE_MS = 4 * 86_400_000;

  let opening = null;

  function open() {
    opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("created_at", "created_at");
        db.createObjectStore("tombstones", { keyPath: "id" });
        db.createObjectStore("meta");
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading must not be blocked by this one.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    });
    return opening;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Server rows and push payloads, into one shape.
  function normalize(n) {
    return {
      id: n.id,
      created_at: typeof n.created_at === "number" ? n.created_at : Date.parse(n.created_at),
      source: n.source ?? "",
      source_id: n.source_id ?? null,
      title: n.title || null,
      subtitle: n.subtitle ?? null,
      body: n.body ?? null,
      url: n.url ?? null,
      kind: n.kind ?? null,
      lang: n.lang ?? null,
      partial: Boolean(n.partial),
    };
  }

  // Upsert, keeping what only this device knows (read, and that it was ever
  // seen), and never letting a preview overwrite a full body.
  async function put(list) {
    const db = await open();
    const tx = db.transaction(["messages", "tombstones"], "readwrite");
    const messages = tx.objectStore("messages");
    const tombstones = tx.objectStore("tombstones");
    let added = 0;
    for (const raw of list) {
      const incoming = normalize(raw);
      if (await request(tombstones.get(incoming.id))) continue;
      const existing = await request(messages.get(incoming.id));
      if (existing) {
        if (incoming.partial && !existing.partial) continue;
        messages.put({ ...existing, ...incoming, read: existing.read });
      } else {
        messages.put({ ...incoming, read: false });
        added++;
      }
    }
    await done(tx);
    return added;
  }

  async function all() {
    const db = await open();
    const rows = await request(db.transaction("messages").objectStore("messages").index("created_at").getAll());
    return rows.reverse();
  }

  async function get(id) {
    const db = await open();
    return request(db.transaction("messages").objectStore("messages").get(id));
  }

  async function markRead(ids) {
    const db = await open();
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    for (const id of ids) {
      const row = await request(store.get(id));
      if (row && !row.read) store.put({ ...row, read: true });
    }
    await done(tx);
  }

  async function remove(ids) {
    const db = await open();
    const tx = db.transaction(["messages", "tombstones"], "readwrite");
    const at = Date.now();
    for (const id of ids) {
      tx.objectStore("messages").delete(id);
      tx.objectStore("tombstones").put({ id, at });
    }
    await done(tx);
  }

  // Undo for remove: the message exactly as it was, tombstone lifted.
  async function restore(message) {
    const db = await open();
    const tx = db.transaction(["messages", "tombstones"], "readwrite");
    tx.objectStore("tombstones").delete(message.id);
    tx.objectStore("messages").put(message);
    await done(tx);
  }

  async function unreadCount() {
    return (await all()).filter((m) => !m.read).length;
  }

  async function count() {
    const db = await open();
    return request(db.transaction("messages").objectStore("messages").count());
  }

  async function getMeta(key) {
    const db = await open();
    return request(db.transaction("meta").objectStore("meta").get(key));
  }

  async function setMeta(key, value) {
    const db = await open();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, key);
    await done(tx);
  }

  // Wipes messages and sync state, keeping nothing of the previous account.
  async function clear() {
    const db = await open();
    const tx = db.transaction(["messages", "tombstones", "meta"], "readwrite");
    for (const name of ["messages", "tombstones", "meta"]) tx.objectStore(name).clear();
    await done(tx);
  }

  async function pruneTombstones() {
    const db = await open();
    const tx = db.transaction("tombstones", "readwrite");
    const store = tx.objectStore("tombstones");
    const cutoff = Date.now() - TOMBSTONE_MS;
    for (const row of await request(store.getAll())) {
      if (row.at < cutoff) store.delete(row.id);
    }
    await done(tx);
  }

  async function updateBadge() {
    const nav = global.navigator;
    if (!nav || !("setAppBadge" in nav)) return;
    const unread = await unreadCount();
    if (unread) await nav.setAppBadge(unread).catch(() => {});
    else await nav.clearAppBadge().catch(() => {});
  }

  global.NotifierStore = {
    put,
    all,
    get,
    markRead,
    remove,
    restore,
    count,
    unreadCount,
    getMeta,
    setMeta,
    clear,
    pruneTombstones,
    updateBadge,
  };
})(self);
