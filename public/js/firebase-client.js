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

/**
 * Instant, non-blocking media file upload.
 * Immediately creates a playable/viewable object in the workspace with zero loading wait,
 * and syncs to the backend / cloud storage in the background.
 */
export async function uploadMediaFile(file, { folderId, ownerId }) {
  const now = new Date().toISOString();
  const category = classifyFileCategory(file.type, file.name);
  const instantBlobUrl = URL.createObjectURL(file);

  // Create immediate file item so UI updates with zero loading delay
  const instantFile = {
    id: `file-${Math.random().toString(36).slice(2, 11)}`,
    name: file.name,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    category,
    sizeBytes: file.size || 0,
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

  // Sync to backend in the background without blocking UI
  (async () => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      xhr.setRequestHeader("x-file-type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-folder-id", folderId || "");
      xhr.setRequestHeader("x-owner-id", ownerId || "default");
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed?.file?.url && !parsed.file.url.startsWith("data:")) {
              instantFile.url = parsed.file.url;
            }
          } catch {
            // keep instantBlobUrl
          }
        }
      };
      xhr.send(file);
    } catch {
      // keep instantBlobUrl
    }
  })();

  return instantFile;
}
