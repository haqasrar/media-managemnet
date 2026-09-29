// Firebase v11 Modular SDK Integration (Google OAuth 2.0 + Firebase Cloud Storage 5GB Free Tier)
// Configured for project: media-management-5b02d with automatic Hybrid Local Storage fallback.

const STORAGE_CONFIG_KEY = "vellum_firebase_config_v1";
const USER_SESSION_KEY = "vellum_google_user_v1";

let cachedFirebaseConfig = null;
let firebaseInstances = null;
let firebaseStorageBucketAvailable = true;

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

  return null;
}

export function saveCustomFirebaseConfig(config) {
  if (!config || !config.apiKey || !config.projectId) {
    localStorage.removeItem(STORAGE_CONFIG_KEY);
    cachedFirebaseConfig = null;
    firebaseInstances = null;
    return;
  }
  localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
  cachedFirebaseConfig = config;
  firebaseInstances = null;
}

export function getSavedFirebaseConfig() {
  return cachedFirebaseConfig;
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
      storage.maxUploadRetryTime = 3000;
      storage.maxOperationRetryTime = 3000;
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

  const profile = {
    uid: u.uid,
    email: u.email || "studio@gmail.com",
    displayName: u.displayName || "Studio Director",
    photoURL: u.photoURL || "",
    studioName: "Appex Studios",
    authProvider: "google-firebase",
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

/**
 * Uploads a media file (Image, Video, or Document) to Firebase Cloud Storage
 * if the bucket is active, or streams directly to the local hybrid storage server (/api/upload).
 */
export async function uploadMediaFile(file, { folderId, ownerId, onProgress }) {
  const fb = await getFirebaseServices();

  // 1. Try Firebase Cloud Storage if bucket is active
  if (fb && fb.storage && firebaseStorageBucketAvailable) {
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `workspaces/${ownerId || "default"}/${
        folderId || "root"
      }/${Date.now()}-${safeName}`;
      const storageRef = fb.storageMod.ref(fb.storage, storagePath);
      const uploadTask = fb.storageMod.uploadBytesResumable(storageRef, file, {
        contentType: file.type || "application/octet-stream",
      });

      const downloadUrl = await new Promise((resolve, reject) => {
        // Fast fallback timer if bucket isn't provisioned on Spark plan
        const fallbackTimer = setTimeout(() => {
          try {
            uploadTask.cancel();
          } catch {
            // ignore
          }
          reject(new Error("BUCKET_UNAVAILABLE_FALLBACK"));
        }, 3500);

        uploadTask.on(
          "state_changed",
          (snapshot) => {
            if (snapshot.bytesTransferred > 0) {
              clearTimeout(fallbackTimer);
            }
            if (snapshot.totalBytes > 0 && onProgress) {
              const pct = Math.round(
                (snapshot.bytesTransferred / snapshot.totalBytes) * 100
              );
              onProgress(pct);
            }
          },
          (err) => {
            clearTimeout(fallbackTimer);
            reject(err);
          },
          async () => {
            clearTimeout(fallbackTimer);
            const url = await fb.storageMod.getDownloadURL(uploadTask.snapshot.ref);
            resolve(url);
          }
        );
      });

      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          url: downloadUrl,
          storagePath,
          storageProvider: "firebase",
          folderId: folderId || null,
          ownerId: ownerId || "default",
        }),
      });
      const data = await res.json();
      return data.file;
    } catch (fbErr) {
      firebaseStorageBucketAvailable = false;
      console.warn(
        "Firebase Storage bucket not yet provisioned; using Local Hybrid Disk Storage:",
        fbErr?.message || fbErr
      );
    }
  }

  // 2. Local Hybrid Disk Storage Upload via XMLHttpRequest for real upload progress
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload", true);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-file-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-folder-id", folderId || "");
    xhr.setRequestHeader("x-owner-id", ownerId || "default");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const pct = Math.round((event.loaded / event.total) * 100);
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (onProgress) onProgress(100);
          resolve(parsed.file);
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during media upload"));
    xhr.send(file);
  });
}
