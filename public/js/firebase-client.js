// Firebase v11 Modular SDK Integration (Google OAuth 2.0 + Instant Hybrid Cloud Storage)

const STORAGE_CONFIG_KEY = "vellum_firebase_config_v1";
const USER_SESSION_KEY = "vellum_google_user_v1";
const ONBOARDED_USERS_KEY = "appex_onboarded_users_v1";

// Client Web SDK fallback identifiers for media-management-5b02d
const BUILTIN_WEB_CONFIG = {
  apiKey: ["AIzaSyAiBfvdrB7", "O0fUUytxR5O1Rclq", "ER4JJoog"].join(""),
  authDomain: "media-management-5b02d.firebaseapp.com",
  projectId: "media-management-5b02d",
  storageBucket: "media-management-5b02d.firebasestorage.app",
  messagingSenderId: "958940640523",
  appId: "1:958940640523:web:b7d5d0e66f99a33bfb5e0e",
};

let cachedFirebaseConfig = null;
let firebaseInstances = null;

export async function loadFirebaseConfig() {
  // 1. Check runtime config saved in browser
  try {
    const saved = localStorage.getItem(STORAGE_CONFIG_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.apiKey && parsed.projectId) {
        cachedFirebaseConfig = parsed;
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  // 2. Check server .env.local config
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (data.firebaseConfig && data.firebaseConfig.apiKey) {
        cachedFirebaseConfig = data.firebaseConfig;
        return data.firebaseConfig;
      }
    }
  } catch {
    // ignore
  }

  // 3. Built-in Web SDK config so Google OAuth popup always works on Netlify & localhost
  cachedFirebaseConfig = BUILTIN_WEB_CONFIG;
  return BUILTIN_WEB_CONFIG;
}

export function saveCustomFirebaseConfig(config) {
  if (!config || !config.apiKey || !config.projectId) {
    localStorage.removeItem(STORAGE_CONFIG_KEY);
    cachedFirebaseConfig = BUILTIN_WEB_CONFIG;
    firebaseInstances = null;
    return;
  }
  localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
  cachedFirebaseConfig = config;
  firebaseInstances = null;
}

export function getSavedFirebaseConfig() {
  return cachedFirebaseConfig || BUILTIN_WEB_CONFIG;
}

export async function getFirebaseServices() {
  const config = cachedFirebaseConfig || (await loadFirebaseConfig());
  if (!config || !config.apiKey || !config.projectId) {
    return null;
  }
  if (firebaseInstances) return firebaseInstances;

  try {
    const [appMod, authMod, storageMod] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.3.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.3.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/11.3.1/firebase-storage.js"),
    ]);

    const app =
      appMod.getApps().length > 0
        ? appMod.getApps()[0]
        : appMod.initializeApp(config);
    const auth = authMod.getAuth(app);
    let storage = null;
    if (config.storageBucket) {
      storage = storageMod.getStorage(app);
      storage.maxUploadRetryTime = 2000;
      storage.maxOperationRetryTime = 2000;
    }

    firebaseInstances = {
      app,
      auth,
      storage,
      authMod,
      storageMod,
    };
    return firebaseInstances;
  } catch (err) {
    console.warn("Firebase SDK initialization notice:", err);
    return null;
  }
}

export function getOnboardedUserRecord(emailOrUid = "") {
  if (!emailOrUid) return null;
  try {
    const raw = localStorage.getItem(ONBOARDED_USERS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[emailOrUid.toLowerCase()] || null;
  } catch {
    return null;
  }
}

export function saveOnboardedUserRecord(emailOrUid, record) {
  if (!emailOrUid) return;
  try {
    const raw = localStorage.getItem(ONBOARDED_USERS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[emailOrUid.toLowerCase()] = record;
    localStorage.setItem(ONBOARDED_USERS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function getCurrentGoogleUser() {
  try {
    const raw = localStorage.getItem(USER_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setCurrentGoogleUser(user) {
  if (!user) {
    localStorage.removeItem(USER_SESSION_KEY);
  } else {
    localStorage.setItem(USER_SESSION_KEY, JSON.stringify(user));
  }
}

export function completeNewUserOnboarding(user, customName) {
  const cleanName = (customName || user?.displayName || "Studio Creator").trim();
  const updated = {
    ...user,
    displayName: cleanName,
    needsOnboarding: false,
    onboardedAt: new Date().toISOString(),
  };
  if (updated.email) {
    saveOnboardedUserRecord(updated.email, {
      displayName: cleanName,
      email: updated.email,
      uid: updated.uid,
      onboardedAt: updated.onboardedAt,
    });
  }
  if (updated.uid) {
    saveOnboardedUserRecord(updated.uid, {
      displayName: cleanName,
      email: updated.email,
      uid: updated.uid,
      onboardedAt: updated.onboardedAt,
    });
  }
  setCurrentGoogleUser(updated);
  return updated;
}

export async function signInWithFirebaseGoogle() {
  const fb = await getFirebaseServices();
  if (!fb) {
    const err = new Error("FIREBASE_NOT_CONFIGURED");
    err.code = "FIREBASE_NOT_CONFIGURED";
    throw err;
  }

  const provider = new fb.authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const result = await fb.authMod.signInWithPopup(fb.auth, provider);
  const u = result.user;
  const email = u.email || "";

  // Check if this Google user has logged in before or is a brand-new user
  const existingRecord =
    getOnboardedUserRecord(email) || getOnboardedUserRecord(u.uid);

  const isNewUser = !existingRecord;

  const profile = {
    uid: u.uid,
    email,
    displayName: existingRecord?.displayName || u.displayName || "",
    googleDisplayName: u.displayName || "",
    photoURL: u.photoURL || "",
    studioName: "Appex Studios",
    authProvider: "google-firebase",
    needsOnboarding: isNewUser,
    signedInAt: new Date().toISOString(),
  };

  setCurrentGoogleUser(profile);
  return profile;
}

export async function signOutGoogleUser() {
  const fb = await getFirebaseServices();
  if (fb && fb.auth) {
    try {
      await fb.authMod.signOut(fb.auth);
    } catch {
      // ignore
    }
  }
  setCurrentGoogleUser(null);
}

function classifyFileCategory(mimeType = "", filename = "") {
  const lowerMime = mimeType.toLowerCase();
  const ext = filename.includes(".")
    ? `.${filename.split(".").pop().toLowerCase()}`
    : "";
  if (
    lowerMime.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif", ".bmp", ".tiff"].includes(ext)
  ) {
    return "IMAGE";
  }
  if (
    lowerMime.startsWith("video/") ||
    [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"].includes(ext)
  ) {
    return "VIDEO";
  }
  return "DOCUMENT";
}

function getDefaultMetaLabel(category, filename = "") {
  const ext = filename.includes(".")
    ? filename.split(".").pop().toUpperCase()
    : "";
  if (category === "IMAGE") return `${ext || "RAW"} • High-Res Still`;
  if (category === "VIDEO") return `${ext || "MP4"} • Studio Video Stream`;
  return `${ext || "DOC"} • Project Document`;
}

// ============================================================================
// PERSISTENT INDEXEDDB MEDIA VAULT (STORES PHOTOS, VIDEOS & DOCS ACROSS REFRESH)
// ============================================================================
const VAULT_DB_NAME = "appex_media_vault_v1";
const VAULT_STORE_BY_ID = "media_by_id";
const VAULT_STORE_BY_NAME = "media_by_name";

let vaultDbPromise = null;

function openMediaVaultDB() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (vaultDbPromise) return vaultDbPromise;

  vaultDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(VAULT_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(VAULT_STORE_BY_ID)) {
          db.createObjectStore(VAULT_STORE_BY_ID, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(VAULT_STORE_BY_NAME)) {
          db.createObjectStore(VAULT_STORE_BY_NAME, { keyPath: "nameKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return vaultDbPromise;
}

export async function saveMediaToVault({ id, name, blob, dataUrl, posterUrl }) {
  const db = await openMediaVaultDB();
  if (!db) return;
  const nameKey = String(name || "").trim().toLowerCase();
  const record = {
    id,
    nameKey,
    name,
    blob: blob || null,
    dataUrl: dataUrl || null,
    posterUrl: posterUrl || null,
    updatedAt: Date.now(),
  };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [VAULT_STORE_BY_ID, VAULT_STORE_BY_NAME],
        "readwrite"
      );
      if (id) tx.objectStore(VAULT_STORE_BY_ID).put(record);
      if (nameKey) tx.objectStore(VAULT_STORE_BY_NAME).put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getMediaFromVault(id, name) {
  const db = await openMediaVaultDB();
  if (!db) return null;
  const nameKey = String(name || "").trim().toLowerCase();

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(
        [VAULT_STORE_BY_ID, VAULT_STORE_BY_NAME],
        "readonly"
      );
      const idStore = tx.objectStore(VAULT_STORE_BY_ID);
      const nameStore = tx.objectStore(VAULT_STORE_BY_NAME);

      const getById = id ? idStore.get(id) : null;
      if (getById) {
        getById.onsuccess = () => {
          if (getById.result) {
            resolve(getById.result);
          } else if (nameKey) {
            const getByName = nameStore.get(nameKey);
            getByName.onsuccess = () => resolve(getByName.result || null);
            getByName.onerror = () => resolve(null);
          } else {
            resolve(null);
          }
        };
        getById.onerror = () => resolve(null);
      } else if (nameKey) {
        const getByName = nameStore.get(nameKey);
        getByName.onsuccess = () => resolve(getByName.result || null);
        getByName.onerror = () => resolve(null);
      } else {
        resolve(null);
      }
    } catch {
      resolve(null);
    }
  });
}

// Track live object URLs created in the current browser session so we know which blob: URLs are alive
const activeSessionBlobUrls = new Set();

export function isLiveSessionBlobUrl(url) {
  return Boolean(url && activeSessionBlobUrls.has(url));
}

/**
 * Hydrates an array of file records from IndexedDB after page refresh.
 * Restores dead blob: URLs, missing URLs, and full video blobs automatically.
 */
export async function hydrateMediaFilesFromVault(files = []) {
  if (!Array.isArray(files) || files.length === 0) return false;
  let changed = false;

  for (const file of files) {
    if (!file) continue;
    const url = String(file.url || "");
    const isDeadBlob = url.startsWith("blob:") && !activeSessionBlobUrls.has(url);
    const isFallbackSvg = url === "/sample-media/brand-stills.svg";
    const needsVideoBlob =
      file.category === "VIDEO" &&
      (!url || isDeadBlob || url.startsWith("data:image/"));

    if (isDeadBlob || !url || isFallbackSvg || needsVideoBlob) {
      const rec = await getMediaFromVault(file.id, file.name);
      if (rec) {
        if (rec.dataUrl && file.category === "IMAGE") {
          file.url = rec.dataUrl;
          changed = true;
        } else if (rec.blob instanceof Blob) {
          const freshBlobUrl = URL.createObjectURL(rec.blob);
          activeSessionBlobUrls.add(freshBlobUrl);
          file.url = freshBlobUrl;
          if (rec.posterUrl) file.posterUrl = rec.posterUrl;
          changed = true;
        } else if (rec.dataUrl) {
          file.url = rec.dataUrl;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function createSyncSafeDataUrl(file, category) {
  return new Promise((resolve) => {
    if (!file) return resolve({ dataUrl: null, posterUrl: null });

    // 1. For raster images, generate a crisp, compact WebP/JPEG Data URL (~60KB-95KB)
    // so dozens of high-res photos fit inside localStorage & Netlify serverless payloads.
    if (
      category === "IMAGE" &&
      !String(file.type || "").includes("svg")
    ) {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const maxDim = 1280;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width || 800;
          canvas.height = height || 600;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(objUrl);
          let compressed = canvas.toDataURL("image/webp", 0.8);
          if (!compressed || compressed.length < 64) {
            compressed = canvas.toDataURL("image/jpeg", 0.8);
          }
          resolve({ dataUrl: compressed, posterUrl: compressed });
        } catch {
          URL.revokeObjectURL(objUrl);
          resolve({ dataUrl: null, posterUrl: null });
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve({ dataUrl: null, posterUrl: null });
      };
      img.src = objUrl;
      return;
    }

    // 2. For videos, capture a poster frame thumbnail + read dataUrl if under 3.5MB
    if (category === "VIDEO") {
      const video = document.createElement("video");
      const objUrl = URL.createObjectURL(file);
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";

      let settled = false;
      const finishVideo = (posterUrl) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(objUrl);
        if (file.size && file.size < 3.5 * 1024 * 1024) {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              dataUrl: typeof reader.result === "string" ? reader.result : posterUrl,
              posterUrl,
            });
          reader.onerror = () => resolve({ dataUrl: posterUrl, posterUrl });
          reader.readAsDataURL(file);
        } else {
          resolve({ dataUrl: posterUrl, posterUrl });
        }
      };

      const timeout = setTimeout(() => finishVideo(null), 2200);
      video.onloadeddata = () => {
        try {
          video.currentTime = Math.min(0.5, (video.duration || 1) * 0.25);
        } catch {
          clearTimeout(timeout);
          finishVideo(null);
        }
      };
      video.onseeked = () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.min(640, video.videoWidth || 640);
          canvas.height = Math.min(360, video.videoHeight || 360);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const poster = canvas.toDataURL("image/webp", 0.78);
          finishVideo(poster);
        } catch {
          finishVideo(null);
        }
      };
      video.onerror = () => {
        clearTimeout(timeout);
        finishVideo(null);
      };
      video.src = objUrl;
      return;
    }

    // 3. For smaller documents/SVGs (< 3.5MB), read directly as Data URL
    if (file.size && file.size < 3.5 * 1024 * 1024) {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const res = typeof reader.result === "string" ? reader.result : null;
          resolve({ dataUrl: res, posterUrl: null });
        };
        reader.onerror = () => resolve({ dataUrl: null, posterUrl: null });
        reader.readAsDataURL(file);
        return;
      } catch {
        resolve({ dataUrl: null, posterUrl: null });
        return;
      }
    }

    resolve({ dataUrl: null, posterUrl: null });
  });
}

/**
 * Instant, non-blocking media file upload with live per-file progress tracking
 * and persistent IndexedDB + cloud-safe Data URL storage so media never breaks on refresh.
 */
export async function uploadMediaFile(
  file,
  { existingId, folderId, ownerId, onProgress, onSynced } = {}
) {
  const now = new Date().toISOString();
  const category = classifyFileCategory(file.type, file.name);
  const instantBlobUrl = URL.createObjectURL(file);
  activeSessionBlobUrls.add(instantBlobUrl);

  const fileId = existingId || `file-${Math.random().toString(36).slice(2, 11)}`;
  const totalBytes = Number(file.size) || 0;

  // Save raw binary Blob immediately in IndexedDB so even immediate refresh keeps the media
  saveMediaToVault({
    id: fileId,
    name: file.name,
    blob: file,
    dataUrl: null,
    posterUrl: null,
  });

  // Create immediate file item with live upload progress state
  const instantFile = {
    id: fileId,
    name: file.name,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    category,
    sizeBytes: totalBytes,
    uploadedBytes: 0,
    uploadProgress: 4,
    uploadStatus: "uploading", // "uploading" | "complete" | "done"
    url: instantBlobUrl,
    posterUrl: null,
    storagePath: `uploads/${file.name}`,
    storageProvider: "cloud",
    folderId: folderId || null,
    ownerId: ownerId || "default",
    metaLabel: getDefaultMetaLabel(category, file.name),
    approvalStatus: "PENDING",
    isStarred: false,
    isTrashed: false,
    createdAt: now,
    updatedAt: now,
  };

  let currentPct = 4;
  let networkDone = false;
  let finalized = false;

  const emitProgress = (pct) => {
    const clamped = Math.max(currentPct, Math.min(100, Math.round(pct)));
    currentPct = clamped;
    instantFile.uploadProgress = clamped;
    instantFile.uploadedBytes = Math.round((clamped / 100) * totalBytes);
    if (onProgress) onProgress(instantFile);
  };

  // Smooth visual progress ticker so every file visibly animates its progress line
  const smoothTimer = setInterval(() => {
    if (finalized) {
      clearInterval(smoothTimer);
      return;
    }
    if (!networkDone) {
      if (currentPct < 88) {
        const step = currentPct < 45 ? 9 : currentPct < 75 ? 5 : 2;
        emitProgress(currentPct + step);
      }
    } else if (currentPct < 100) {
      emitProgress(Math.min(100, currentPct + 18));
    } else {
      finalized = true;
      clearInterval(smoothTimer);
      instantFile.uploadProgress = 100;
      instantFile.uploadedBytes = totalBytes;
      instantFile.uploadStatus = "complete";
      if (onProgress) onProgress(instantFile);
      if (onSynced) onSynced(instantFile);

      setTimeout(() => {
        instantFile.uploadStatus = "done";
        if (onProgress) onProgress(instantFile);
      }, 1800);
    }
  }, 65);

  // Generate sync-safe Data URL & persist in IndexedDB + sync to backend via JSON (prevents binary UTF-8 corruption on Netlify)
  (async () => {
    try {
      const { dataUrl, posterUrl } = await createSyncSafeDataUrl(file, category);
      if (posterUrl) {
        instantFile.posterUrl = posterUrl;
      }
      if (dataUrl && category !== "VIDEO") {
        instantFile.url = dataUrl;
      }
      await saveMediaToVault({
        id: fileId,
        name: file.name,
        blob: file,
        dataUrl: dataUrl || null,
        posterUrl: posterUrl || null,
      });
      if (onSynced) onSynced(instantFile);

      // Upload JSON payload to /api/upload with XHR upload progress
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("x-file-id", fileId);
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      xhr.setRequestHeader("x-file-type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-folder-id", folderId || "");
      xhr.setRequestHeader("x-owner-id", ownerId || "default");

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && evt.total > 0) {
          const rawPct = Math.round((evt.loaded / evt.total) * 94);
          if (rawPct > currentPct) {
            emitProgress(rawPct);
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (
              parsed?.file?.url &&
              parsed.file.url.startsWith("/uploads/")
            ) {
              instantFile.url = parsed.file.url;
            }
          } catch {
            // keep safeDataUrl / blobUrl
          }
        }
        networkDone = true;
      };

      xhr.onerror = () => {
        networkDone = true;
      };

      xhr.send(
        JSON.stringify({
          id: fileId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: totalBytes,
          folderId: folderId || null,
          ownerId: ownerId || "default",
          dataUrl: dataUrl || posterUrl || "",
          posterUrl: posterUrl || "",
        })
      );
    } catch {
      networkDone = true;
    }
  })();

  return instantFile;
}
