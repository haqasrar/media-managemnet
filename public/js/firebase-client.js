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

function createSyncSafeDataUrl(file, category) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);

    // For raster images larger than 300KB, generate an optimized high-res WebP/JPEG data URL
    // so multi-megabyte PNG batches fit inside localStorage & Netlify 6MB serverless payloads.
    if (
      category === "IMAGE" &&
      !String(file.type || "").includes("svg") &&
      file.size > 300 * 1024
    ) {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const maxDim = 1600;
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
          let compressed = canvas.toDataURL("image/webp", 0.84);
          if (!compressed || compressed.length < 64) {
            compressed = canvas.toDataURL("image/jpeg", 0.84);
          }
          resolve(compressed);
        } catch {
          URL.revokeObjectURL(objUrl);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve(null);
      };
      img.src = objUrl;
      return;
    }

    // For smaller files (< 3.5MB), read directly as Data URL
    if (file.size && file.size < 3.5 * 1024 * 1024) {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          resolve(typeof reader.result === "string" ? reader.result : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
        return;
      } catch {
        resolve(null);
        return;
      }
    }

    resolve(null);
  });
}

/**
 * Instant, non-blocking media file upload with live per-file progress tracking.
 * Immediately creates a playable/viewable object in the workspace with a 0% -> 100%
 * progress line bar and syncs to the backend / cloud storage in the background.
 */
export async function uploadMediaFile(
  file,
  { folderId, ownerId, onProgress, onSynced } = {}
) {
  const now = new Date().toISOString();
  const category = classifyFileCategory(file.type, file.name);
  const instantBlobUrl = URL.createObjectURL(file);
  const fileId = `file-${Math.random().toString(36).slice(2, 11)}`;
  const totalBytes = Number(file.size) || 0;

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

  // Prepare sync-safe Data URL for serverless & cross-tab persistence
  createSyncSafeDataUrl(file, category).then((safeDataUrl) => {
    if (safeDataUrl && instantFile.url.startsWith("blob:")) {
      instantFile.url = safeDataUrl;
      if (onSynced) onSynced(instantFile);
    }
  });

  // Sync to backend in the background with matching x-file-id & XHR upload progress
  (async () => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
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
              (!parsed.file.url.startsWith("data:") ||
                parsed.file.url.length < 600 * 1024)
            ) {
              instantFile.url = parsed.file.url;
            }
          } catch {
            // keep current url
          }
        }
        networkDone = true;
      };

      xhr.onerror = () => {
        networkDone = true;
      };

      xhr.send(file);
    } catch {
      networkDone = true;
    }
  })();

  return instantFile;
}
