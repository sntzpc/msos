(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const nowISO = () => new Date().toISOString();
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // ============================
  // ✅ HARDCODE GAS URL DI SINI
  // ============================
  const GAS_URL = "https://script.google.com/macros/s/AKfycbwFBl_W8lZTVvEFbjfR13Y_DGsbBp6ObYpmx5WtUIoDwaT_WNdQV1I5S2ix4VVU1m-n/exec"; // <-- GANTI dengan URL deploy /exec Anda

  // ----------------------------
  // Local settings
  // ----------------------------
  const LS = {
    viewerName: "tc.viewerName",
    deviceId: "tc.deviceId",
    sort: "tc.sort", // newest|oldest
    onlyFeatured: "tc.onlyFeatured"
  };

    // ----------------------------
  // Session (30 hari) + Logging events ke GAS
  // ----------------------------
  const SESSION = {
    id: "tc.sessionId",
    exp: "tc.sessionExp" // ISO
  };
  const SESSION_DAYS = 30;

  function addDaysISO(days) {
    const d = new Date();
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString();
  }

  function getSession() {
    const now = Date.now();
    let sid = localStorage.getItem(SESSION.id) || "";
    let exp = localStorage.getItem(SESSION.exp) || "";
    const expMs = exp ? new Date(exp).getTime() : 0;

    // jika tidak ada atau sudah lewat, buat session baru
    if (!sid || !expMs || now > expMs) {
      sid = uid();
    }

    // setiap kali aplikasi dibuka: perpanjang 30 hari
    exp = addDaysISO(SESSION_DAYS);

    localStorage.setItem(SESSION.id, sid);
    localStorage.setItem(SESSION.exp, exp);

    return { sessionId: sid, expiresAt: exp };
  }

    // ----------------------------
  // Public paging cache (3 hari per batch)
  // ----------------------------
  const PUBLIC_PAGE_DAYS = 3;
  const CURSOR_KEY = "tc.publicCursorBeforeDay"; // disimpan di localStorage
  const LOADED_RANGE_KEY = "tc.publicLoadedRanges"; // opsional (string json)

  function getDeviceId() {
    let d = localStorage.getItem(LS.deviceId);
    if (!d) {
      d = uid();
      localStorage.setItem(LS.deviceId, d);
    }
    return d;
  }

  function getViewerName() {
    return (localStorage.getItem(LS.viewerName) || "").trim();
  }

  function setViewerName(n) {
    localStorage.setItem(LS.viewerName, (n || "").trim());
  }

  function getGasUrlHardcoded() {
    return (GAS_URL || "").trim();
  }

  // ----------------------------
  // IndexedDB Minimal Wrapper
  // ----------------------------
  const DB_NAME = "tc_activity_db";
  const DB_VER = 1;
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;

        const posts = d.createObjectStore("posts", { keyPath: "id" });
        posts.createIndex("byPublished", "isPublished", { unique: false });
        posts.createIndex("byCreatedAt", "createdAt", { unique: false });

        const comments = d.createObjectStore("comments", { keyPath: "id" });
        comments.createIndex("byPostId", "postId", { unique: false });
        comments.createIndex("byCreatedAt", "createdAt", { unique: false });

        const reports = d.createObjectStore("reports_private", { keyPath: "id" });
        reports.createIndex("byDate", "date", { unique: false });

        const media = d.createObjectStore("media_blobs", { keyPath: "key" }); // {key, blob}
        const queue = d.createObjectStore("sync_queue", { keyPath: "id" });
        queue.createIndex("byStatus", "status", { unique: false });

        const auth = d.createObjectStore("admin_auth", { keyPath: "username" });
        const stats = d.createObjectStore("stats", { keyPath: "key" }); // e.g. {key:"visitTotal", value:123}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode = "readonly") {
    const t = db.transaction(storeName, mode);
    return [t.objectStore(storeName), t];
  }

  async function idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const [os] = tx(store);
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, val) {
    return new Promise((resolve, reject) => {
      const [os] = tx(store, "readwrite");
      const req = os.put(val);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDel(store, key) {
    return new Promise((resolve, reject) => {
      const [os] = tx(store, "readwrite");
      const req = os.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbAll(store) {
    return new Promise((resolve, reject) => {
      const [os] = tx(store);
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbIndexAll(store, indexName, key) {
    return new Promise((resolve, reject) => {
      const [os] = tx(store);
      const idx = os.index(indexName);
      const req = idx.getAll(key);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ----------------------------
  // Toast
  // ----------------------------
  const toastEl = $("#toast");

    // default toast (auto hide)
    let toast = toastEl ? new bootstrap.Toast(toastEl, { delay: 2500, autohide: true }) : null;

    function showToast(msg, opts = {}) {
    const { sticky = false, delay = 2500 } = opts || {};
    if (!toastEl) return;

    const txt = $("#toastText");
    if (txt) txt.textContent = msg;

    // sticky toast: tidak auto-hide
    if (sticky) {
        toast = new bootstrap.Toast(toastEl, { autohide: false, delay: 999999 });
    } else {
        toast = new bootstrap.Toast(toastEl, { autohide: true, delay });
    }
    toast.show();
    }

    function hideToast() {
    try { toast?.hide(); } catch {}
    }

    // helper progress: update toast tetap tampil
    function progressToast(msg) {
    showToast(msg, { sticky: true });
    }

  // ----------------------------
  // Crypto (PBKDF2)
  // ----------------------------
  async function pbkdf2Hash(password, saltB64, iterations = 200000) {
    const enc = new TextEncoder();
    const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return {
      saltB64: bytesToBase64(salt),
      iterations,
      hashB64: bytesToBase64(new Uint8Array(bits))
    };
  }

  function bytesToBase64(bytes) {
    let bin = "";
    bytes.forEach(b => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ----------------------------
  // Admin Auth
  // ----------------------------
  let isAdmin = false;
  let adminMustChange = false;

  async function ensureAdminAuthInitialized() {
    const existing = await idbGet("admin_auth", "admin");
    if (existing) return;

    const { saltB64, iterations, hashB64 } = await pbkdf2Hash("123456", null, 200000);
    await idbPut("admin_auth", {
      username: "admin",
      saltB64,
      iterations,
      hashB64,
      mustChangePassword: true,
      updatedAt: nowISO()
    });
  }

  async function adminLogin(username, password) {
    const rec = await idbGet("admin_auth", username);
    if (!rec) return { ok: false, msg: "User tidak ditemukan." };
    const { hashB64 } = await pbkdf2Hash(password, rec.saltB64, rec.iterations);
    if (hashB64 !== rec.hashB64) return { ok: false, msg: "Password salah." };
    isAdmin = true;
    adminMustChange = !!rec.mustChangePassword;
    return { ok: true, mustChange: adminMustChange };
  }

  async function adminChangePassword(newPass) {
    const rec = await idbGet("admin_auth", "admin");
    if (!rec) throw new Error("Admin auth tidak ada.");
    const { saltB64, iterations, hashB64 } = await pbkdf2Hash(newPass, null, 220000);
    await idbPut("admin_auth", {
      ...rec,
      saltB64,
      iterations,
      hashB64,
      mustChangePassword: false,
      updatedAt: nowISO()
    });
    adminMustChange = false;
  }

  // ----------------------------
  // Queue helpers
  // ----------------------------
  async function queueAdd(type, payload) {
    const item = { id: uid(), type, payload, status: "queued", createdAt: nowISO(), updatedAt: nowISO() };
    await idbPut("sync_queue", item);
    await refreshStats();
    return item.id;
  }

  async function queueListQueued() {
    const all = await idbAll("sync_queue");
    return all.filter(x => x.status === "queued");
  }

  async function queueSetStatus(id, status, errorMsg = "") {
    const cur = await idbGet("sync_queue", id);
    if (!cur) return;
    await idbPut("sync_queue", { ...cur, status, errorMsg, updatedAt: nowISO() });
    await refreshStats();
  }

  // =============================
// ✅ Public outbox (Komentar publik) - TANPA ADMIN
// =============================
async function flushPublicCommentOutbox({ silent = true } = {}) {
  const base = getGasUrlHardcoded();
  if (!navigator.onLine || !base) return;

  // ambil queued items khusus komentar publik
  const all = await idbAll("sync_queue");
  const items = all.filter(x => x.status === "queued" && x.type === "publicAddComment");

  if (!items.length) return;

  for (const item of items) {
    try {
      const c = await idbGet("comments", item.payload.commentId);
      if (!c) {
        await queueSetStatus(item.id, "done");
        continue;
      }

      // kirim ke server (langsung addComment)
      await gasFetch("addComment", { comment: c }, "POST");

      // tandai komentar sudah tersinkron otomatis
      await idbPut("comments", { ...c, syncedAt: nowISO(), updatedAt: nowISO() });

      await queueSetStatus(item.id, "done");
    } catch (e) {
      await queueSetStatus(item.id, "error", String(e?.message || e));
      if (!silent) showToast("Gagal kirim komentar: " + (e?.message || e));
    }
  }
}

  // ----------------------------
  // Visits (public view counter)
  // ----------------------------
  function ymd(d = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

    function addDaysYmd(ymdStr, deltaDays) {
    const [Y, M, D] = String(ymdStr).split("-").map(Number);
    const dt = new Date(Y, (M || 1) - 1, D || 1);
    dt.setDate(dt.getDate() + Number(deltaDays || 0));
    return ymd(dt);
  }

  async function recordVisitOncePerDay() {
    const deviceId = getDeviceId();
    const today = ymd();
    const key = `visit_${deviceId}_${today}`;
    const already = await idbGet("stats", key);
    if (already) return;

    await idbPut("stats", { key, value: 1, updatedAt: nowISO() });

    await queueAdd("visit", {
      deviceId,
      day: today,
      ts: nowISO(),
      ua: navigator.userAgent.slice(0, 120)
    });
  }

  // ----------------------------
  // Posts, comments, reports
  // ----------------------------
  async function savePostLocal({ title, caption, tags, createdAt, isPublished, isFeatured, mediaKeys }) {
    const post = {
      id: uid(),
      title: title.trim(),
      caption: caption.trim(),
      tags,
      createdAt,
      updatedAt: nowISO(),
      isPublished: !!isPublished,
      isFeatured: !!isFeatured,
      media: (mediaKeys || []).map(k => ({
        type: k.startsWith("video:") ? "video" : "image",
        localKey: k,
        driveFileId: "",
        url: "",
        thumbUrl: ""
      }))
    };
    await idbPut("posts", post);
    await queueAdd("upsertPost", { postId: post.id });
    return post;
  }

  async function savePrivateReportLocal({ date, type, detail }) {
    const rep = {
      id: uid(),
      date,
      type: type.trim(),
      detail: detail.trim(),
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    await idbPut("reports_private", rep);
    await queueAdd("upsertReport", { reportId: rep.id });
    return rep;
  }

  async function addCommentLocal(postId, name, text) {
    const c = {
        id: uid(),
        postId,
        name: name.trim(),
        text: text.trim(),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        status: "active",
        syncedAt: "" // kosong jika belum terkirim
    };

    // 1) Simpan lokal dulu (UX cepat)
    await idbPut("comments", c);

    // 2) Kalau online → langsung kirim ke GAS (tanpa admin)
    const base = getGasUrlHardcoded();
    if (navigator.onLine && base) {
        try {
        await gasFetch("addComment", { comment: c }, "POST");
        await idbPut("comments", { ...c, syncedAt: nowISO(), updatedAt: nowISO() });
        return c;
        } catch (e) {
        // fallback: masuk outbox publik (tetap tanpa admin, auto-flush saat online)
        await queueAdd("publicAddComment", { commentId: c.id });
        return c;
        }
    }

    // 3) Offline → masuk outbox publik
    await queueAdd("publicAddComment", { commentId: c.id });
    return c;
    }

  async function setCommentStatusLocal(commentId, status) {
    const c = await idbGet("comments", commentId);
    if (!c) return;
    await idbPut("comments", { ...c, status, updatedAt: nowISO() });
    await queueAdd("setCommentStatus", { commentId, status });
  }

  async function compressImageFile(file, opts = {}) {
  const {
    maxW = 1600,
    maxH = 1600,
    quality = 0.82,
    outType = "image/jpeg"
  } = opts;

  // kalau bukan image, return original
  if (!file.type.startsWith("image/")) return file;

  // kalau kecil banget, tidak usah kompres
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB <= 0.8) return file;

  const imgURL = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = imgURL;
    });

    let { width: w, height: h } = img;

    // hitung rasio resize
    const r = Math.min(maxW / w, maxH / h, 1);
    const nw = Math.max(1, Math.round(w * r));
    const nh = Math.max(1, Math.round(h * r));

    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0, nw, nh);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, outType, quality)
    );

    if (!blob) return file;

    // buat File baru (biar tetap punya name/mime)
    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: outType });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(imgURL);
  }
}


  // ----------------------------
  // Media store (Blobs)
  // ----------------------------
  async function putMediaBlob(file) {
    const key = (file.type.startsWith("video/") ? "video:" : "image:") + uid();
    await idbPut("media_blobs", { key, blob: file, name: file.name, mime: file.type, size: file.size, createdAt: nowISO() });
    return key;
  }

  async function getMediaBlob(key) {
    return await idbGet("media_blobs", key);
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // ----------------------------
  // GAS network (HARDCODE)
  // ----------------------------
  // ----------------------------
        async function gasFetch(action, payload = {}, method = "POST") {
        const base = getGasUrlHardcoded(); // atau GAS_URL hardcode Anda
        if (!base) throw new Error("GAS_URL hardcode belum diisi di app.js.");

        const url = base + (base.includes("?") ? "&" : "?") + "action=" + encodeURIComponent(action);

        // PENTING:
        // - Jangan set headers Content-Type: application/json (itu memicu preflight OPTIONS)
        // - Kirim body string JSON => browser default text/plain;charset=UTF-8 (simple request)
        const opt = {
            method,
            body: method === "POST" ? JSON.stringify(payload) : undefined,
            // credentials: "omit" // default
        };

        const res = await fetch(url, opt);
        if (!res.ok) throw new Error(`GAS error ${res.status}`);

        // GAS harus balas JSON
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "GAS failed");
        return data;
        }

  // ----------------------------
  // Sync Engine (Admin only)
  // ----------------------------
  function log(line) {
    const el = $("#syncLog");
    if (!el) return;
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }

    async function pullPublicLatest({ resetCursor = false } = {}) {
    const base = getGasUrlHardcoded();
    if (!base) { showToast("GAS_URL belum diisi di app.js."); return; }
    if (!navigator.onLine) { showToast("Sedang offline."); return; }

    // reset cursor => mulai dari hari ini
    if (resetCursor) {
      localStorage.setItem(CURSOR_KEY, ymd(new Date()));
    }

    // cursor beforeDay (inclusive)
    const beforeDay = (localStorage.getItem(CURSOR_KEY) || ymd(new Date())).trim();
    const days = PUBLIC_PAGE_DAYS;

    log(`Pull: ambil ${days} hari (s.d. ${beforeDay})...`);
    const data = await gasFetch("publicDumpDays", { beforeDay, days }, "POST");

    const posts = data.posts || [];
    for (const p of posts) await idbPut("posts", p);

    const comments = data.comments || [];
    for (const c of comments) await idbPut("comments", c);

    if (typeof data.visitTotal === "number") {
      await idbPut("stats", { key: "visitTotal", value: data.visitTotal, updatedAt: nowISO() });
    }

    // simpan cursor berikutnya
    if (data.nextBeforeDay) {
      localStorage.setItem(CURSOR_KEY, String(data.nextBeforeDay));
    } else {
      // fallback kalau server tidak mengirim (harusnya kirim)
      localStorage.setItem(CURSOR_KEY, addDaysYmd(beforeDay, -days));
    }

    // opsional: simpan range yang sudah di-load
    try {
      const ranges = JSON.parse(localStorage.getItem(LOADED_RANGE_KEY) || "[]");
      if (data.range?.fromDay && data.range?.toDay) {
        ranges.push({ fromDay: data.range.fromDay, toDay: data.range.toDay, ts: nowISO() });
        localStorage.setItem(LOADED_RANGE_KEY, JSON.stringify(ranges.slice(-50)));
      }
    } catch {}

    await refreshUI();
    log("Pull: selesai ✅");
    showToast(`Data ditambah: ${posts.length} post (${data.range?.fromDay || "?"}..${data.range?.toDay || "?"})`);
  }

  // =============================
// ✅ Helper: bangun index lokal (id -> updatedAt) untuk dedupe cepat
// =============================
async function buildLocalIndexMap(storeName, idField = "id", updatedField = "updatedAt") {
  const all = await idbAll(storeName);
  const map = new Map();
  for (const x of all) {
    const id = (x && x[idField]) ? String(x[idField]) : "";
    if (!id) continue;
    map.set(id, String(x[updatedField] || ""));
  }
  return map;
}

// =============================
// ✅ Helper: upsert dengan hitung "baru/updated"
// =============================
async function upsertManyWithCount(storeName, items, localMap) {
  let insertedOrUpdated = 0;
  for (const it of (items || [])) {
    if (!it?.id) continue;
    const id = String(it.id);
    const incomingUpd = String(it.updatedAt || "");

    const existedUpd = localMap.get(id) || null;
    // jika belum ada => insert
    // jika ada tapi updatedAt beda (lebih baru / beda) => update
    if (!existedUpd || (incomingUpd && incomingUpd !== existedUpd)) {
      await idbPut(storeName, it);
      localMap.set(id, incomingUpd);
      insertedOrUpdated++;
    }
  }
  return insertedOrUpdated;
}

// =============================
// ✅ Pull paged: ambil berkali-kali sampai tidak ada data baru
// =============================
async function refreshPullMissingFromServer({
    daysPerBatch = PUBLIC_PAGE_DAYS,
    maxBatches = 20,
    resetCursor = true,
    // mode full: lanjut sampai mentok (data kosong / no next), bukan stop saat "no new"
    full = false,
    onProgress = null // (info)=>void
    } = {}) {
    const base = getGasUrlHardcoded();
    if (!base) throw new Error("GAS_URL belum diisi di app.js.");
    if (!navigator.onLine) throw new Error("Sedang offline.");

    // bangun index lokal (sekali saja)
    const postMap = await buildLocalIndexMap("posts", "id", "updatedAt");
    const commentMap = await buildLocalIndexMap("comments", "id", "updatedAt");

    // reset cursor => mulai dari hari ini
    if (resetCursor) localStorage.setItem(CURSOR_KEY, ymd(new Date()));

    let totalNewPosts = 0;
    let totalNewComments = 0;
    let batchesUsed = 0;

    for (let i = 0; i < maxBatches; i++) {
        const beforeDay = (localStorage.getItem(CURSOR_KEY) || ymd(new Date())).trim();
        batchesUsed = i + 1;

        const infoStart = {
        phase: "batch_start",
        batch: i + 1,
        maxBatches,
        daysPerBatch,
        beforeDay,
        totalNewPosts,
        totalNewComments
        };
        try { onProgress && onProgress(infoStart); } catch {}

        log(`Refresh Pull: batch ${i + 1}/${maxBatches} • ${daysPerBatch} hari (s.d. ${beforeDay})...`);

        const data = await gasFetch("publicDumpDays", { beforeDay, days: daysPerBatch }, "POST");

        const posts = data.posts || [];
        const comments = data.comments || [];

        const addedPosts = await upsertManyWithCount("posts", posts, postMap);
        const addedComments = await upsertManyWithCount("comments", comments, commentMap);

        totalNewPosts += addedPosts;
        totalNewComments += addedComments;

        // stats
        if (typeof data.visitTotal === "number") {
        await idbPut("stats", { key: "visitTotal", value: data.visitTotal, updatedAt: nowISO() });
        }

        // cursor mundur
        if (data.nextBeforeDay) {
        localStorage.setItem(CURSOR_KEY, String(data.nextBeforeDay));
        } else {
        localStorage.setItem(CURSOR_KEY, addDaysYmd(beforeDay, -daysPerBatch));
        }

        const infoEnd = {
        phase: "batch_end",
        batch: i + 1,
        maxBatches,
        beforeDay,
        gotPosts: posts.length,
        gotComments: comments.length,
        addedPosts,
        addedComments,
        totalNewPosts,
        totalNewComments,
        nextBeforeDay: data.nextBeforeDay || ""
        };
        try { onProgress && onProgress(infoEnd); } catch {}

        // ✅ STOP rules:
        // - mode normal: stop kalau tidak ada penambahan (local sudah lengkap untuk range itu)
        // - mode full: stop kalau server sudah tidak ada data (posts+comments kosong) ATAU tidak ada nextBeforeDay (anggap sudah mentok)
        if (!full) {
        if (addedPosts === 0 && addedComments === 0) {
            log("Refresh Pull: tidak ada data baru di batch ini → stop.");
            break;
        }
        } else {
        if ((posts.length === 0 && comments.length === 0) || !data.nextBeforeDay) {
            log("Refresh Pull (FULL): data kosong / tidak ada nextBeforeDay → stop.");
            break;
        }
        }
    }

    await refreshUI();
    return { totalNewPosts, totalNewComments, batchesUsed };
    }

  async function autoPullPublicIfNeeded() {
    const base = getGasUrlHardcoded();
    if (!navigator.onLine || !base) return;

    // throttle: maksimal 1x per 10 menit per perangkat
    const KEY = "tc.lastPublicPull";
    const last = Number(localStorage.getItem(KEY) || "0");
    const now = Date.now();
    const intervalMs = 10 * 60 * 1000;
    if (now - last < intervalMs) return;

    try {
        await pullPublicLatest();
        localStorage.setItem(KEY, String(now));
    } catch (e) {
        // biarkan silent agar tidak ganggu UX
        console.warn("autoPullPublicIfNeeded failed:", e);
    }
    }

      let isLoadingMore = false;

  async function loadNextPageIfNearBottom() {
    if (isLoadingMore) return;
    if (!navigator.onLine) return;

    const doc = document.documentElement;
    const scrollBottom = window.scrollY + window.innerHeight;
    const near = doc.scrollHeight - 250; // 250px dari bawah

    if (scrollBottom < near) return;

    isLoadingMore = true;
    try {
      await pullPublicLatest({ resetCursor: false }); // ambil 3 hari berikutnya sesuai cursor
    } catch (e) {
      console.warn("loadNextPageIfNearBottom failed:", e);
    } finally {
      isLoadingMore = false;
    }
  }


  async function syncNow() {
    if (!isAdmin) { showToast("Login admin dulu."); return; }
    const base = getGasUrlHardcoded();
    if (!base) { showToast("GAS_URL belum diisi di app.js."); return; }

    log("Sync: mulai...");
    const queued = await queueListQueued();
    log(`Sync: queued items = ${queued.length}`);

    // 1) Upload media
    const posts = await idbAll("posts");
    for (const p of posts) {
      for (const m of (p.media || [])) {
        if (m.driveFileId) continue;
        if (!m.localKey) continue;

        const mb = await getMediaBlob(m.localKey);
        if (!mb?.blob) continue;

        const maxMB = 30;
        const sizeMB = (mb.size || mb.blob.size || 0) / (1024 * 1024);
        if (sizeMB > maxMB) {
          log(`Media SKIP (>${maxMB}MB): ${mb.name} (${sizeMB.toFixed(1)}MB)`);
          continue;
        }

        log(`Upload media: ${mb.name} (${sizeMB.toFixed(1)}MB) ...`);
        const b64 = await blobToBase64(mb.blob);

        const up = await gasFetch("uploadMedia", {
          filename: mb.name || "media",
          mime: mb.mime || "application/octet-stream",
          base64: b64
        });

        m.driveFileId = up.fileId || "";
        m.url = up.url || "";
        m.thumbUrl = up.thumbUrl || "";
        log(`Upload OK: ${m.driveFileId}`);
      }
      p.updatedAt = nowISO();
      await idbPut("posts", p);
    }

    // 2) Process queue items
    for (const item of queued) {
      try {
        log(`→ ${item.type} (${item.id})`);

        if (item.type === "visit") {
          await gasFetch("recordVisit", item.payload, "POST");
        }

        if (item.type === "upsertPost") {
          const post = await idbGet("posts", item.payload.postId);
          if (post) await gasFetch("upsertPost", { post }, "POST");
        }

        if (item.type === "addComment") {
          const c = await idbGet("comments", item.payload.commentId);
          if (c) await gasFetch("addComment", { comment: c }, "POST");
        }

        if (item.type === "publicAddComment") {
        const c = await idbGet("comments", item.payload.commentId);
        if (c) await gasFetch("addComment", { comment: c }, "POST");
        }

        if (item.type === "setCommentStatus") {
          await gasFetch("setCommentStatus", item.payload, "POST");
        }

        if (item.type === "upsertReport") {
          const r = await idbGet("reports_private", item.payload.reportId);
          if (r) await gasFetch("upsertReport", { report: r }, "POST");
        }

        if (item.type === "eventLog") {
          await gasFetch("logEvent", { event: item.payload }, "POST");
        }

        await queueSetStatus(item.id, "done");
      } catch (e) {
        log(`  ERROR: ${e.message || e}`);
        await queueSetStatus(item.id, "error", String(e.message || e));
      }
    }

    // 3) Refresh stats
    try {
      const stats = await gasFetch("publicStats", {}, "POST");
      if (typeof stats.visitTotal === "number") {
        await idbPut("stats", { key: "visitTotal", value: stats.visitTotal, updatedAt: nowISO() });
      }
      $("#adminVisitTotal").textContent = String(stats.visitTotal ?? "—");
      $("#adminPostCount").textContent = String(stats.postCount ?? "—");
      $("#adminCommentCount").textContent = String(stats.commentCount ?? "—");
    } catch (e) {
      log("Stats refresh failed: " + (e.message || e));
    }

    await refreshUI();
    log("Sync: selesai ✅");
    showToast("Sync selesai.");
  }

  // =============================
  // ✅ Pending comment draft (auto-send setelah isi nama)
  // =============================
    let pendingCommentDraft = null; 
    // { postId, text }

    let viewerModalOnSaved = null; // callback setelah nama tersimpan

    function openViewerModal(opts = {}) {
    // patch: dukung callback setelah save
    viewerModalOnSaved = typeof opts.onSaved === "function" ? opts.onSaved : null;

    $("#viewerNameInput").value = getViewerName();
    const m = new bootstrap.Modal($("#viewerModal"));
    m.show();
    }

  // ----------------------------
  // UI Rendering
  // ----------------------------
  let sortMode = localStorage.getItem(LS.sort) || "newest";
  let onlyFeatured = localStorage.getItem(LS.onlyFeatured) === "1";

  function formatDT(iso) {
        const d = new Date(iso);
        return d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
    }

    function renderTags(tags = []) {
        const arr = (tags || []).filter(Boolean).slice(0, 6);
        return arr.map((t, i) => `<span class="tag ${i % 2 ? "tag2" : ""}">#${escapeHtml(t.trim())}</span>`).join("");
    }

    function escapeHtml(str) {
        return (str || "").toString().replace(/[&<>"']/g, (m) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
        }[m]));
    }

    function driveIdFromUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";

    // 1) query param ?id=...
    try {
        const url = new URL(s);
        const qid = url.searchParams.get("id");
        if (qid) return qid;

        // 2) pattern /d/<ID> (lh3.googleusercontent.com/d/<ID>=w1200)
        //    atau drive.google.com/file/d/<ID>/view
        const m1 = url.pathname.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
        if (m1 && m1[1]) return m1[1];

        // 3) pattern /uc?...&id=<ID> kadang tidak lewat searchParams (fallback regex)
        const m2 = (url.href || "").match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
        if (m2 && m2[1]) return m2[1];
    } catch {
        // ignore
    }

    // regex fallback untuk string non-URL valid
    const m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m && m[1]) return m[1];

    const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m2 && m2[1]) return m2[1];

    return "";
    }

    function isLh3GoogleUsercontent(url) {
  const s = String(url || "");
  return s.includes("lh3.googleusercontent.com");
}

function buildMediaCandidates(mediaItem, { preferFull = false, sz = "w1200" } = {}) {
  if (!mediaItem) return [];

  // video: pakai url/uc view
  if (mediaItem.type === "video") {
    const arr = [];
    if ((mediaItem.url || "").trim()) arr.push(mediaItem.url.trim());
    if ((mediaItem.driveFileId || "").trim()) arr.push(driveViewUrl(mediaItem.driveFileId.trim()));
    return arr;
  }

  // image:
  const url = (mediaItem.url || "").trim();
  const thumbUrl = (mediaItem.thumbUrl || "").trim();
  const fid = (mediaItem.driveFileId || "").trim();

  const fromId = fid ? driveThumbUrl(fid, sz) : "";
  const ucFull = fid ? driveViewUrl(fid) : "";

  // urutan kandidat:
  // - kalau thumbUrl adalah lh3, sering “abort” di Firefox → jangan jadi satu-satunya.
  // - always include drive thumbnail as strong fallback jika ada driveFileId
  const primary = [];
    if (preferFull) {
        if (url) primary.push(url);
        if (thumbUrl) primary.push(thumbUrl);
    } else {
        if (thumbUrl) primary.push(thumbUrl);
        if (url) primary.push(url);
    }

    const candidates = [];
    for (const x of primary) candidates.push(x);

    if (fromId) candidates.push(fromId);
    if (ucFull) candidates.push(ucFull);

    // dedupe
    return Array.from(new Set(candidates.filter(Boolean)));
    }

    function attachImgFallback(img, candidates, { timeoutMs = 4500 } = {}) {
    if (!img || !candidates?.length) return;

    let idx = 0;
    let timer = null;

    const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const tryNext = () => {
        cleanup();
        idx++;
        if (idx >= candidates.length) return;
        img.src = candidates[idx];

        // timeout fallback (untuk kasus NS_BINDING_ABORTED / tidak trigger onerror)
        timer = setTimeout(() => {
        // kalau belum tampil (naturalWidth==0), paksa next
        if (!img.complete || img.naturalWidth === 0) {
            tryNext();
        }
        }, timeoutMs);
    };

    img.onerror = () => tryNext();

    // start candidate 0
    img.src = candidates[0];
    timer = setTimeout(() => {
        if (!img.complete || img.naturalWidth === 0) {
        tryNext();
        }
    }, timeoutMs);
    }

    function driveThumbUrl(id, sz = "w1200") {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=${encodeURIComponent(sz)}`;
    }

      function driveViewUrl(id) {
    return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;
  }

  function resolveBestMediaSrc(mediaItem, { preferFull = false } = {}) {
    if (!mediaItem) return "";

    // 1) jika video: utamakan url (uc view) karena thumbUrl biasanya untuk image
    if (mediaItem.type === "video") {
      if ((mediaItem.url || "").trim()) return mediaItem.url.trim();
      if ((mediaItem.driveFileId || "").trim()) return driveViewUrl(mediaItem.driveFileId.trim());
      // localKey akan di-handle oleh resolveLocalUrl
      return "";
    }

    // 2) image: preferFull = true => coba url dulu, tapi fallback thumbUrl
    const url = (mediaItem.url || "").trim();
    const thumbUrl = (mediaItem.thumbUrl || "").trim();

    if (preferFull) {
      if (url) return url;
      if (thumbUrl) return thumbUrl;
    } else {
      if (thumbUrl) return thumbUrl;
      if (url) return url;
    }

    // 3) jika hanya punya driveFileId, buat thumbnail endpoint (lebih stabil)
    if ((mediaItem.driveFileId || "").trim()) {
      return driveThumbUrl(mediaItem.driveFileId.trim(), "w1600");
    }

    // 4) localKey akan di-handle oleh resolveLocalUrl
    return "";
  }


  function extractCover(post) {
    const m = (post.media || [])[0];
    if (!m) return { kind: "none", src: "" };

    // Prioritas: thumbUrl (ringan) -> url (full)
    const src = (m.thumbUrl || m.url || "").trim();

    if (src) return { kind: m.type, src };

    // kalau belum ada URL (masih offline lokal admin), nanti resolveLocalUrl dipakai
    if (m.localKey) return { kind: m.type, src: "" };

    return { kind: "none", src: "" };
    }


    async function resolveLocalUrl(mediaItem, opts = {}) {
    // 1) server url/thumb/drive id
    const best = resolveBestMediaSrc(mediaItem, opts);
    if (best) return best;

    // 2) local blob (offline admin)
    if (!mediaItem?.localKey) return "";
    const mb = await getMediaBlob(mediaItem.localKey);
    if (!mb?.blob) return "";
    return URL.createObjectURL(mb.blob);
  }

  async function loadFeed() {
    let posts = await idbAll("posts");
    posts = posts.filter(p => p.isPublished);

    const q = ($("#q")?.value || "").trim().toLowerCase();
    if (q) {
      posts = posts.filter(p => {
        const hay = `${p.title} ${p.caption} ${(p.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (onlyFeatured) posts = posts.filter(p => !!p.isFeatured);

    posts.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return sortMode === "newest" ? (tb - ta) : (ta - tb);
    });

    const feed = $("#feed");
    const empty = $("#emptyState");
    feed.innerHTML = "";

    if (!posts.length) {
      empty.classList.remove("d-none");
      return;
    }
    empty.classList.add("d-none");

    for (const p of posts) {
      const cover = extractCover(p);
      let coverHtml = `<div class="post-cover d-flex align-items-center justify-content-center text-muted">No media</div>`;

      if (cover.kind !== "none") {
        coverHtml = `<img class="post-cover" data-post="${p.id}" alt="" loading="lazy" decoding="async">`;
      }

      const card = document.createElement("div");
      card.className = "post-card";
      card.innerHTML = `
        ${coverHtml}
        <div class="post-body">
          <div class="d-flex align-items-start justify-content-between gap-2">
            <div>
              <div class="fw-bold">${escapeHtml(p.title || "(Tanpa judul)")}</div>
              <div class="text-muted small">${formatDT(p.createdAt)}</div>
            </div>
            ${p.isFeatured ? `<span class="tag tag2"><i class="bi bi-stars"></i> Highlight</span>` : ``}
          </div>
          <div class="mt-2 text-muted">${escapeHtml((p.caption || "").slice(0, 110))}${(p.caption || "").length > 110 ? "…" : ""}</div>
          <div class="d-flex flex-wrap gap-2 mt-3">${renderTags(p.tags || [])}</div>
        </div>
      `;
      card.addEventListener("click", () => openPostModal(p.id));
      feed.appendChild(card);

      // Fallback khusus Drive: kalau uc?export=view sering "abort", pindah ke thumbnail endpoint
        const imgEl = card.querySelector(`img.post-cover[data-post="${p.id}"]`);
            if (imgEl) {
            const first = (p.media || [])[0] || null;

            // 1) kalau cover.src ada (thumbUrl/url), pakai itu sebagai kandidat awal
            // 2) tambahkan fallback dari driveFileId / uc view
            const fid = (first?.driveFileId || driveIdFromUrl(cover.src) || "").trim();

            const tempMedia = first ? { ...first, driveFileId: first.driveFileId || fid } : null;

            // kandidat: (thumb/url dari server) -> drive thumbnail -> uc view
            const candidates = [];

            if ((cover.src || "").trim()) candidates.push(cover.src.trim());
            if (tempMedia) {
                for (const u of buildMediaCandidates(tempMedia, { preferFull: false, sz: "w1200" })) {
                candidates.push(u);
                }
            }

            attachImgFallback(imgEl, Array.from(new Set(candidates.filter(Boolean))), { timeoutMs: 4500 });
            }

            if (cover.kind !== "none" && !cover.src) {
        const img = card.querySelector(`img.post-cover[data-post="${p.id}"]`);
        if (img) {
            const first = (p.media || [])[0];
            const url = await resolveLocalUrl(first);
            if (url) attachImgFallback(img, [url], { timeoutMs: 4500 });
        }
        }
    }
  }

    // =============================
    // ✅ Pull komentar terbaru per post (ringan)
    // =============================
    async function pullCommentsForPost(postId, { limit = 200, silent = true } = {}) {
    const base = getGasUrlHardcoded();
    if (!navigator.onLine || !base) return { count: 0 };

    try {
        const data = await gasFetch("publicCommentsByPost", { postId, limit }, "POST");
        const comments = data.comments || [];

        // upsert ke IDB agar renderComments() otomatis pakai data terbaru
        for (const c of comments) {
        await idbPut("comments", c);
        }

        return { count: comments.length };
    } catch (e) {
        if (!silent) showToast("Gagal cek komentar terbaru: " + (e?.message || e));
        return { count: 0, error: e };
    }
    }

  async function openPostModal(postId) {
    const post = await idbGet("posts", postId);
    if (!post) return;

    $("#postMeta").textContent = `${formatDT(post.createdAt)} • ${post.isFeatured ? "Highlight" : "Aktivitas"}`;
    $("#postTitle").textContent = post.title || "(Tanpa judul)";
    $("#postCaption").textContent = post.caption || "";
    $("#postTags").innerHTML = renderTags(post.tags || []);

        const stack = $("#postMedia");
    stack.innerHTML = "";

    for (const m of (post.media || [])) {
      // Untuk modal, image lebih nyaman pakai preferFull=true,
      // tapi tetap fallback thumb jika url gagal.
      const src = await resolveLocalUrl(m, { preferFull: m.type !== "video" });

      if (!src) continue;

      if (m.type === "video") {
        const v = document.createElement("video");
        v.controls = true;
        v.playsInline = true;
        v.preload = "metadata";
        v.src = src;
        stack.appendChild(v);
      } else {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = "";
        // kandidat berlapis untuk modal (lebih besar)
        const fid = (m.driveFileId || driveIdFromUrl(src) || "").trim();
        const mm = { ...m, driveFileId: fid };

        const candidates = buildMediaCandidates(mm, { preferFull: true, sz: "w1600" });
        if (src) candidates.unshift(src); // pastikan src awal ikut dicoba dulu

        attachImgFallback(img, Array.from(new Set(candidates.filter(Boolean))), { timeoutMs: 5500 });

        stack.appendChild(img);
      }
    }

            // ✅ Saat modal dibuka: cek komentar terbaru khusus post ini (ringan)
        try { await flushPublicCommentOutbox({ silent: true }); } catch {}
        await pullCommentsForPost(postId, { limit: 200, silent: true });
        await renderComments(postId);

    $("#btnSendComment").onclick = async () => {
        const text = ($("#commentText").value || "").trim();
        if (!text) { showToast("Komentar masih kosong."); return; }

        const name = getViewerName();
        if (!name) {
            // ✅ simpan draft -> setelah nama disimpan, auto terkirim
            pendingCommentDraft = { postId, text };
            showToast("Isi nama dulu, lalu komentar akan langsung terkirim.");
            openViewerModal({
            onSaved: () => {
                // tidak perlu apa-apa di sini, karena btnSaveViewerName sudah auto-send draft
            }
            });
            return;
        }

        $("#btnSendComment").disabled = true;
        try {
            await addCommentLocal(postId, name, text);
            $("#commentText").value = "";
            await renderComments(postId);

            if (navigator.onLine) showToast("Komentar terkirim ✅");
            else showToast("Offline: komentar tersimpan, akan terkirim otomatis saat online.");
        } finally {
            $("#btnSendComment").disabled = false;
        }
        };

    $("#btnChangeNameInline").onclick = () => openViewerModal();

    const modal = new bootstrap.Modal($("#postModal"));
    modal.show();
  }

  async function renderComments(postId) {
    const list = $("#commentList");
    const nameLabel = $("#viewerNameLabel");
    nameLabel.textContent = getViewerName() || "(belum diisi)";

    let comments = await idbIndexAll("comments", "byPostId", postId);
    comments = comments.filter(c => c.status !== "hidden");
    comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    $("#commentCount").textContent = String(comments.length);
    list.innerHTML = "";

    if (!comments.length) {
      list.innerHTML = `<div class="text-muted small">Belum ada komentar. Jadilah yang pertama 🙂</div>`;
      return;
    }

    for (const c of comments) {
      const el = document.createElement("div");
      el.className = "comment";
      el.innerHTML = `
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="fw-semibold">${escapeHtml(c.name || "Anonim")}</div>
          <div class="meta">${formatDT(c.createdAt)}</div>
        </div>
        <div class="mt-1">${escapeHtml(c.text || "")}</div>
      `;
      list.appendChild(el);
    }
  }

  function setText(sel, val) {
    const el = $(sel);
    if (el) el.textContent = String(val);
    }

  async function refreshStats() {
  const postCount = (await idbAll("posts")).filter(p => p.isPublished).length;
  const commentCount = (await idbAll("comments")).filter(c => c.status !== "hidden").length;
  const qCount = (await idbAll("sync_queue")).filter(x => x.status === "queued").length;

  setText("#statPosts", postCount);
  setText("#statComments", commentCount);
  setText("#statQueue", qCount);

  const visitTotalRec = await idbGet("stats", "visitTotal");
  const visitTotal = visitTotalRec?.value ?? "—";
  setText("#visitTotal", visitTotal);

  setText("#syncStatus", qCount ? "Ada antrian" : "Rapi");
}

  async function refreshUI() {
    await refreshStats();
    await loadFeed();
  }

  // ----------------------------
  // Viewer modal
  // ----------------------------
  function openViewerModal() {
    $("#viewerNameInput").value = getViewerName();
    const m = new bootstrap.Modal($("#viewerModal"));
    m.show();
  }

  // ----------------------------
  // Admin UI
  // ----------------------------
  function showAdminPanel() {
    $("#adminGate").classList.add("d-none");
    $("#adminPanel").classList.remove("d-none");

    // tampilkan URL hardcode pada UI (read-only)
    const inp = $("#gasUrlInput");
    if (inp) {
      inp.value = getGasUrlHardcoded();
      inp.readOnly = true;
    }

    (async () => {
      const stats = await idbGet("stats", "visitTotal");
      $("#adminVisitTotal").textContent = String(stats?.value ?? "—");
      $("#adminPostCount").textContent = $("#statPosts").textContent;
      $("#adminCommentCount").textContent = $("#statComments").textContent;
    })();
  }

  function showAdminGate() {
    $("#adminPanel").classList.add("d-none");
    $("#adminGate").classList.remove("d-none");
  }

  // ----------------------------
  // Moderation list
  // ----------------------------
  async function renderModeration() {
    const wrap = $("#modList");
    wrap.innerHTML = "";
    let comments = await idbAll("comments");
    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    comments = comments.slice(0, 25);

    if (!comments.length) {
      wrap.innerHTML = `<div class="text-muted small">Belum ada komentar.</div>`;
      return;
    }

    for (const c of comments) {
      const post = await idbGet("posts", c.postId);
      const title = post?.title || "(Post tidak ditemukan)";
      const card = document.createElement("div");
      card.className = "card border-0 bg-light rounded-4";
      card.innerHTML = `
        <div class="card-body">
          <div class="d-flex justify-content-between gap-2">
            <div>
              <div class="fw-bold">${escapeHtml(c.name)} <span class="text-muted fw-normal">• ${formatDT(c.createdAt)}</span></div>
              <div class="text-muted small">Pada: ${escapeHtml(title)}</div>
            </div>
            <span class="tag ${c.status === "hidden" ? "" : "tag2"}">${c.status}</span>
          </div>
          <div class="mt-2">${escapeHtml(c.text)}</div>
          <div class="d-flex justify-content-end gap-2 mt-3">
            <button class="btn btn-outline-secondary btn-sm rounded-pill" data-act="toggle">
              ${c.status === "hidden" ? "Tampilkan" : "Sembunyikan"}
            </button>
          </div>
        </div>
      `;
      card.querySelector('[data-act="toggle"]').onclick = async () => {
        const next = c.status === "hidden" ? "active" : "hidden";
        await setCommentStatusLocal(c.id, next);
        showToast("Status komentar diubah (offline).");
        await renderModeration();
        await refreshStats();
      };
      wrap.appendChild(card);
    }
  }

  // ----------------------------
  // Reports list
  // ----------------------------
  async function renderReports() {
    const wrap = $("#reportList");
    wrap.innerHTML = "";
    let reps = await idbAll("reports_private");
    reps.sort((a, b) => (a.date < b.date ? 1 : -1));

    if (!reps.length) {
      wrap.innerHTML = `<div class="text-muted small">Belum ada laporan privat.</div>`;
      return;
    }

    for (const r of reps.slice(0, 50)) {
      const card = document.createElement("div");
      card.className = "card border-0 bg-light rounded-4";
      card.innerHTML = `
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
              <div class="fw-bold">${escapeHtml(r.type || "Laporan")}</div>
              <div class="text-muted small">${escapeHtml(r.date)} • dibuat ${formatDT(r.createdAt)}</div>
            </div>
            <button class="btn btn-outline-danger btn-sm rounded-pill" data-del>
              <i class="bi bi-trash"></i>
            </button>
          </div>
          <div class="mt-2">${escapeHtml((r.detail || "").slice(0, 200))}${(r.detail || "").length > 200 ? "…" : ""}</div>
        </div>
      `;
      card.querySelector("[data-del]").onclick = async () => {
        await idbDel("reports_private", r.id);
        await queueAdd("upsertReport", { reportId: r.id, deleted: true }); // optional
        showToast("Laporan dihapus (lokal).");
        await renderReports();
        await refreshStats();
      };
      wrap.appendChild(card);
    }
  }

  // ----------------------------
  // Events
  // ----------------------------
  function setOnlineUI() {
    const online = navigator.onLine;
    const t = $("#onlineText");
    const d = $("#dotOnline");
    if (t) t.textContent = online ? "Online" : "Offline";
    if (d) {
        d.style.background = online ? "#20c997" : "#adb5bd";
        d.style.boxShadow = online ? "0 0 0 5px rgba(32,201,151,.18)" : "0 0 0 5px rgba(173,181,189,.18)";
    }
    }

  async function refreshPublicStatsIfPossible() {
    const base = getGasUrlHardcoded();
    if (!navigator.onLine || !base) return;
    try {
      const stats = await gasFetch("publicStats", {}, "POST");
      if (typeof stats.visitTotal === "number") {
        await idbPut("stats", { key: "visitTotal", value: stats.visitTotal, updatedAt: nowISO() });
      }
      $("#visitTotal").textContent = String(stats.visitTotal ?? "—");
    } catch {
      // silent
    }
  }

  // ----------------------------
  // Init
  // ----------------------------
  async function init() {
    // SW
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch {}
    }

    db = await openDB();
    await ensureAdminAuthInitialized();
        // Session extend 30 hari setiap app dibuka
    const sess = getSession();
    await queueAdd("eventLog", {
      type: "session_ping",
      sessionId: sess.sessionId,
      expiresAt: sess.expiresAt,
      deviceId: getDeviceId(),
      viewerName: getViewerName(),
      adminUser: "",
      detail: "",
      ts: nowISO(),
      ua: navigator.userAgent.slice(0, 120)
    });

    // record visit
    await recordVisitOncePerDay();

    // UI
    setOnlineUI();

    // ✅ Saat online: update stats + auto-kirim komentar pending (tanpa admin)
    window.addEventListener("online", async () => {
    setOnlineUI();
    await refreshPublicStatsIfPossible();
    try { await flushPublicCommentOutbox({ silent: true }); } catch {}
    });

    // Saat offline: hanya update indikator
    window.addEventListener("offline", () => setOnlineUI());

    // header buttons
    $("#btnViewerName").onclick = openViewerModal;
        $("#btnSaveViewerName").onclick = async () => {
    const v = ($("#viewerNameInput").value || "").trim();
    if (!v) { showToast("Nama tidak boleh kosong."); return; }

    setViewerName(v);

    // log event ke queue (akan tersinkron saat admin Sync)
    const sess = getSession();
    await queueAdd("eventLog", {
        type: "viewer_name_set",
        sessionId: sess.sessionId,
        expiresAt: sess.expiresAt,
        deviceId: getDeviceId(),
        viewerName: v,
        adminUser: "",
        detail: "",
        ts: nowISO(),
        ua: navigator.userAgent.slice(0, 120)
    });

    showToast("Nama disimpan.");
    bootstrap.Modal.getInstance($("#viewerModal"))?.hide();

    // ✅ jika ada callback setelah save
    try { viewerModalOnSaved && viewerModalOnSaved(v); } catch(e) { console.warn(e); }
    viewerModalOnSaved = null;

    // ✅ jika ada draft komentar pending -> auto kirim
    if (pendingCommentDraft?.postId && pendingCommentDraft?.text) {
        const { postId, text } = pendingCommentDraft;
        pendingCommentDraft = null;

        try {
        // tombol kirim mungkin ada jika postModal sedang terbuka
        const btn = $("#btnSendComment");
        if (btn) btn.disabled = true;

        await addCommentLocal(postId, v, text);

        const ta = $("#commentText");
        if (ta) ta.value = "";

        await renderComments(postId);

        if (navigator.onLine) showToast("Komentar terkirim ✅");
        else showToast("Offline: komentar tersimpan, akan terkirim otomatis saat online.");
        } catch (e) {
        showToast("Gagal kirim komentar: " + (e?.message || e));
        } finally {
        const btn = $("#btnSendComment");
        if (btn) btn.disabled = false;
        }
    }
    };

    $("#btnAdmin").onclick = () => {
      showAdminGate();
      const m = new bootstrap.Modal($("#adminModal"));
      m.show();
    };

    $("#btnRefresh").onclick = async () => {
    try {
        if (navigator.onLine) {
        // ✅ ambil data yang belum ada di local (loop paging)
        const r = await refreshPullMissingFromServer({
            daysPerBatch: PUBLIC_PAGE_DAYS,
            maxBatches: 20,
            resetCursor: true
        });
        showToast(`Refresh OK ✅ +${r.totalNewPosts} post, +${r.totalNewComments} komentar`);
        } else {
        await refreshUI();
        showToast("Refresh offline.");
        }
    } catch (e) {
        showToast("Refresh gagal: " + (e.message || e));
    }
    };

    // =============================
    // ✅ Opsi: Refresh total sampai paling lama (maxBatches 200) + progress toast/log
    // =============================
(function attachRefreshAllOption(){
    const btnRefresh = $("#btnRefresh");
    if (!btnRefresh) return;

    // Jika HTML belum punya tombolnya, buat otomatis
    let btnAll = $("#btnRefreshAll");
    if (!btnAll) {
        btnAll = document.createElement("button");
        btnAll.id = "btnRefreshAll";
        btnAll.type = "button";
        btnAll.className = btnRefresh.className; // ikut style tombol refresh
        btnAll.innerHTML = `<i class="bi bi-arrow-repeat"></i> Refresh Total`;
        btnAll.title = "Refresh total sampai paling lama (max 200 batch)";
        btnRefresh.insertAdjacentElement("afterend", btnAll);
    }

    btnAll.onclick = async () => {
        if (!navigator.onLine) {
        await refreshUI();
        showToast("Offline: tidak bisa Refresh Total.");
        return;
        }

        // progress toast sticky
        progressToast("Refresh Total: mulai…");

        btnAll.disabled = true;
        try {
        const r = await refreshPullMissingFromServer({
            daysPerBatch: PUBLIC_PAGE_DAYS,
            maxBatches: 200,
            resetCursor: true,
            full: true,
            onProgress: (info) => {
            if (!info) return;

            if (info.phase === "batch_start") {
                progressToast(`Refresh Total: batch ${info.batch}/${info.maxBatches} • s.d. ${info.beforeDay}`);
            }

            if (info.phase === "batch_end") {
                // tampilkan ringkas: batch selesai + akumulasi
                const msg =
                `Refresh Total: batch ${info.batch}/${info.maxBatches} selesai • ` +
                `+${info.addedPosts} post, +${info.addedComments} komentar (total +${info.totalNewPosts}/+${info.totalNewComments})`;
                log(msg);
                progressToast(msg);
            }
            }
        });

        hideToast();
        showToast(`Refresh Total selesai ✅ +${r.totalNewPosts} post, +${r.totalNewComments} komentar (batches ${r.batchesUsed})`, { delay: 4000 });
        } catch (e) {
        hideToast();
        showToast("Refresh Total gagal: " + (e?.message || e));
        } finally {
        btnAll.disabled = false;
        }
    };
    })();

    $("#btnOpenFeed").onclick = () => window.scrollTo({ top: $("#feed").offsetTop - 80, behavior: "smooth" });

    $("#btnClearQ").onclick = async () => { $("#q").value = ""; await loadFeed(); };
    $("#q").addEventListener("input", () => loadFeed());

    $("#btnSort").onclick = async () => {
      sortMode = (sortMode === "newest") ? "oldest" : "newest";
      localStorage.setItem(LS.sort, sortMode);
      $("#btnSort").innerHTML = sortMode === "newest"
        ? `<i class="bi bi-sort-down"></i> Terbaru`
        : `<i class="bi bi-sort-up"></i> Terlama`;
      await loadFeed();
    };
    $("#btnSort").innerHTML = sortMode === "newest"
      ? `<i class="bi bi-sort-down"></i> Terbaru`
      : `<i class="bi bi-sort-up"></i> Terlama`;

    $("#btnOnlyFeatured").onclick = async () => {
      onlyFeatured = !onlyFeatured;
      localStorage.setItem(LS.onlyFeatured, onlyFeatured ? "1" : "0");
      $("#btnOnlyFeatured").classList.toggle("btn-outline-secondary", !onlyFeatured);
      $("#btnOnlyFeatured").classList.toggle("btn-primary", onlyFeatured);
      await loadFeed();
    };
    if (onlyFeatured) {
      $("#btnOnlyFeatured").classList.remove("btn-outline-secondary");
      $("#btnOnlyFeatured").classList.add("btn-primary");
    }

    $("#btnSyncPublic").onclick = async () => {
    try {
        await pullPublicLatest(); // ambil data publik dari server
    } catch (e) {
        showToast("Gagal ambil data publik: " + (e.message || e));
    }
    };

    // Admin login
    $("#btnAdminLogin").onclick = async () => {
      const u = ($("#adminUser").value || "").trim();
      const p = ($("#adminPass").value || "");
      $("#btnAdminLogin").disabled = true;
      try {
        const res = await adminLogin(u, p);
        if (!res.ok) { showToast(res.msg); return; }
        showToast("Login admin berhasil.");
        showAdminPanel();
        if (res.mustChange) showToast("Wajib ganti password (tab Sync).");

        await renderReports();
        await renderModeration();
        await refreshStats();
      } finally {
        $("#btnAdminLogin").disabled = false;
      }
    };

    $("#btnAdminLogout").onclick = () => {
      isAdmin = false;
      adminMustChange = false;
      showToast("Logout.");
      showAdminGate();
    };

    // Admin: create post
    $("#postDateInput").value = new Date().toISOString().slice(0, 16);
    $("#postMediaInput").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      const preview = $("#mediaPreview");
      preview.innerHTML = "";
      const keys = [];
      for (const f of files) {
        // kompres hanya untuk gambar
        const f2 = await compressImageFile(f, { maxW: 1600, maxH: 1600, quality: 0.82 });
        const k = await putMediaBlob(f2);
        keys.push(k);

        const url = URL.createObjectURL(f2);
        const tile = document.createElement("div");
        tile.className = "preview-tile";
        tile.innerHTML = f2.type.startsWith("video/")
            ? `<video src="${url}" muted playsinline></video>`
            : `<img src="${url}" alt="">`;
        preview.appendChild(tile);
        }
      preview.dataset.keys = JSON.stringify(keys);
    });

    $("#btnResetPost").onclick = () => {
      $("#postTitleInput").value = "";
      $("#postCaptionInput").value = "";
      $("#postTagsInput").value = "";
      $("#postDateInput").value = new Date().toISOString().slice(0, 16);
      $("#postPublished").checked = true;
      $("#postFeatured").checked = false;
      $("#postMediaInput").value = "";
      $("#mediaPreview").innerHTML = "";
      $("#mediaPreview").dataset.keys = "[]";
    };

    $("#btnSavePost").onclick = async () => {
      if (!isAdmin) { showToast("Login admin dulu."); return; }
      if (adminMustChange) { showToast("Ganti password dulu (tab Sync)."); return; }

      const title = $("#postTitleInput").value || "";
      const caption = $("#postCaptionInput").value || "";
      const tags = ($("#postTagsInput").value || "")
        .split(",").map(x => x.trim()).filter(Boolean);
      const createdAt = new Date($("#postDateInput").value || new Date()).toISOString();
      const isPublished = $("#postPublished").checked;
      const isFeatured = $("#postFeatured").checked;

      const keys = JSON.parse($("#mediaPreview").dataset.keys || "[]");

      if (!title.trim() && !caption.trim()) { showToast("Isi judul atau caption."); return; }
      if (!keys.length) { showToast("Tambahkan minimal 1 foto/video."); return; }

      $("#btnSavePost").disabled = true;
      try {
        await savePostLocal({ title, caption, tags, createdAt, isPublished, isFeatured, mediaKeys: keys });
        showToast("Post tersimpan (offline).");
        $("#btnResetPost").click();
        await refreshUI();
      } finally {
        $("#btnSavePost").disabled = false;
      }
    };

    // Admin: reports
    $("#repDate").value = ymd();
    $("#btnResetReport").onclick = () => {
      $("#repDate").value = ymd();
      $("#repType").value = "";
      $("#repDetail").value = "";
    };
    $("#btnSaveReport").onclick = async () => {
      if (!isAdmin) { showToast("Login admin dulu."); return; }
      if (adminMustChange) { showToast("Ganti password dulu (tab Sync)."); return; }

      const date = $("#repDate").value;
      const type = $("#repType").value || "";
      const detail = $("#repDetail").value || "";
      if (!date || !type.trim() || !detail.trim()) { showToast("Lengkapi tanggal, jenis, detail."); return; }
      await savePrivateReportLocal({ date, type, detail });
      showToast("Laporan privat tersimpan.");
      $("#btnResetReport").click();
      await renderReports();
      await refreshStats();
    };
    $("#btnRefreshReports").onclick = async () => { await renderReports(); showToast("Reports refreshed."); };

    // Admin: moderation
    $("#btnRefreshModeration").onclick = async () => { await renderModeration(); showToast("Moderation refreshed."); };

    // Admin: sync & settings (hardcode)
    $("#btnTestGAS").onclick = async () => {
      try {
        const res = await gasFetch("ping", { deviceId: getDeviceId() }, "POST");
        showToast("GAS OK ✅");
        log("Ping OK: " + JSON.stringify(res));
      } catch (e) {
        showToast("GAS gagal ❌");
        log("Ping ERROR: " + (e.message || e));
      }
    };

    $("#btnSyncAdmin").onclick = async () => {
      if (adminMustChange) { showToast("Ganti password dulu."); return; }
      await syncNow();
    };

    $("#btnPullLatest").onclick = async () => {
      await pullPublicLatest();
    };

    $("#btnChangeAdminPass").onclick = async () => {
      if (!isAdmin) { showToast("Login admin dulu."); return; }
      const p1 = $("#newPass1").value || "";
      const p2 = $("#newPass2").value || "";
      if (p1.length < 8) { showToast("Minimal 8 karakter."); return; }
      if (p1 !== p2) { showToast("Password tidak sama."); return; }
      $("#btnChangeAdminPass").disabled = true;
            try {
        await adminChangePassword(p1);

        const sess = getSession();
        await queueAdd("eventLog", {
          type: "admin_password_changed",
          sessionId: sess.sessionId,
          expiresAt: sess.expiresAt,
          deviceId: getDeviceId(),
          viewerName: getViewerName(),
          adminUser: "admin",
          detail: "changed_via_app",
          ts: nowISO(),
          ua: navigator.userAgent.slice(0, 120)
        });

        showToast("Password admin diganti ✅");
        $("#newPass1").value = "";
        $("#newPass2").value = "";
      } finally {
        $("#btnChangeAdminPass").disabled = false;
      }
    };

    await refreshPublicStatsIfPossible();

    // ✅ coba flush outbox komentar sekali saat init (kalau sudah online)
    try { await flushPublicCommentOutbox({ silent: true }); } catch {}

    // Jika cache masih kosong, ambil batch pertama (3 hari) saat online
    const localPosts = await idbAll("posts");
    const localComments = await idbAll("comments");

        // Jika cache masih kosong, ambil batch pertama (3 hari) saat online
        if ((!localPosts.length || !localComments.length) && navigator.onLine) {
        localStorage.setItem(CURSOR_KEY, ymd(new Date()));
        await pullPublicLatest({ resetCursor: false });
        } else {
        await autoPullPublicIfNeeded(); // throttle 10 menit
        await refreshUI();
        }

    // Infinite scroll
    window.addEventListener("scroll", () => {
      // jangan await di listener (biar ringan)
      loadNextPageIfNearBottom();
    }, { passive: true });
  }

  init().catch(err => {
    console.error(err);
    showToast("Gagal start aplikasi: " + (err.message || err));
  });

})();
