import {
  loadFirebaseConfig,
  saveCustomFirebaseConfig,
  getSavedFirebaseConfig,
  getCurrentGoogleUser,
  setCurrentGoogleUser,
  completeNewUserOnboarding,
  signInWithFirebaseGoogle,
  signOutGoogleUser,
  uploadMediaFile,
  hydrateMediaFilesFromVault,
  isLiveSessionBlobUrl,
} from "./firebase-client.js?v=12";
import {
  formatBytes,
  formatDateShort,
  formatRelativeTime,
  escapeHtml,
  GOOGLE_LOGO_SVG,
  getFolderColorStyles,
  renderApprovalBadge,
  renderCategoryBadge,
  mountSampleCinemaCanvas,
  enhanceAppexLogos,
  isCodeFile,
  isHtmlFile,
  getCodeLanguage,
  renderCodeCardThumbnail,
  renderCodeViewerContainer,
  fetchAndRenderCodePreview,
} from "./ui-helpers.js?v=12";
import { createClientPortalController } from "./client-portal.js?v=13";

const rootEl = document.getElementById("app-root");
const globalFileInput = document.getElementById("global-file-input");
const globalFolderInput = document.getElementById("global-folder-input");

const FIVE_GB = 5 * 1024 * 1024 * 1024;
const WORKSPACE_CACHE_KEY = "appex_workspace_cache_v1";
const LEGACY_DEFAULT_OWNER_KEY = "appex_legacy_default_owner_v1";

const LEGACY_SAMPLE_FILE_IDS = new Set(["file-1", "file-2", "file-3", "file-4"]);
const LEGACY_SAMPLE_FOLDER_IDS = new Set(["fld-1", "fld-2", "fld-3"]);
const LEGACY_SAMPLE_SHARE_IDS = new Set(["shr-sample-folder-1"]);
const LEGACY_SAMPLE_FEEDBACK_IDS = new Set(["fb-1", "fb-2"]);

function sanitizeWorkspaceCollections(raw = {}) {
  const rawFiles = Array.isArray(raw.files) ? raw.files : [];
  const files = rawFiles.filter((f) => f && f.id && !LEGACY_SAMPLE_FILE_IDS.has(f.id));
  const usedFolderIds = new Set(files.map((f) => f.folderId).filter(Boolean));

  const rawFolders = Array.isArray(raw.folders) ? raw.folders : [];
  const folders = rawFolders.filter(
    (fld) =>
      fld &&
      fld.id &&
      (!LEGACY_SAMPLE_FOLDER_IDS.has(fld.id) || usedFolderIds.has(fld.id))
  );

  const rawShares = Array.isArray(raw.shares) ? raw.shares : [];
  const shares = rawShares.filter((s) => s && s.id && !LEGACY_SAMPLE_SHARE_IDS.has(s.id));

  const rawFeedback = Array.isArray(raw.feedback) ? raw.feedback : [];
  const feedback = rawFeedback.filter(
    (fb) => fb && fb.id && !LEGACY_SAMPLE_FEEDBACK_IDS.has(fb.id)
  );

  return { folders, files, shares, feedback };
}

/**
 * Strictly determines if the current browser tab is a Client Share Portal.
 * Locks the token in sessionStorage so refreshing (F5) in a client portal tab
 * NEVER falls back to the Studio Account.
 */
function getActiveClientPortalToken() {
  const path = window.location.pathname || "";
  const searchParams = new URLSearchParams(window.location.search || "");
  const hash = window.location.hash || "";

  let token = null;
  if (path.startsWith("/share/")) {
    token = decodeURIComponent(path.replace("/share/", "").split("/")[0].trim());
  } else if (searchParams.get("share")) {
    token = searchParams.get("share").trim();
  } else if (hash.startsWith("#/share/")) {
    token = decodeURIComponent(hash.replace("#/share/", "").split("/")[0].trim());
  }

  if (token) {
    try {
      sessionStorage.setItem("appex_client_portal_lock", token);
      window.__APPEX_CLIENT_PORTAL_LOCK__ = token;
    } catch {
      // ignore
    }
    return token;
  }

  // If this tab was locked as a Client Portal and the browser/CDN rewrote the path to "/" on refresh,
  // keep it strictly locked in the Client Portal unless the user explicitly navigated to /dashboard or /login
  if (path !== "/dashboard" && path !== "/login") {
    try {
      const locked =
        window.__APPEX_CLIENT_PORTAL_LOCK__ ||
        sessionStorage.getItem("appex_client_portal_lock");
      if (locked) {
        window.history.replaceState({}, "", `/share/${encodeURIComponent(locked)}`);
        return locked;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function openClientShareInNewTab(token) {
  if (!token) return;
  const url = `${window.location.origin}/share/${encodeURIComponent(token)}`;
  const win = window.open(url, "_blank", "noopener");
  if (!win) {
    navigateTo(`/share/${encodeURIComponent(token)}`);
  }
}

function loadWorkspaceCache() {
  try {
    const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
    if (!raw) return null;
    return sanitizeWorkspaceCollections(JSON.parse(raw));
  } catch {
    return null;
  }
}

let syncTimer = null;

function isValidPersistentMediaUrl(u) {
  if (!u || typeof u !== "string") return false;
  if (u.startsWith("blob:")) return isLiveSessionBlobUrl(u);
  if (u === "/sample-media/brand-stills.svg") return false;
  return (
    u.startsWith("data:") ||
    u.startsWith("/uploads/") ||
    u.startsWith("http") ||
    u.startsWith("/sample-media/")
  );
}

function toPersistedFileRecord(f, maxDataUrlLen = 650000) {
  const { uploadProgress, uploadStatus, uploadedBytes, ...rest } = f;
  let url = rest.url || "";
  if (url.startsWith("blob:")) {
    url = rest.posterUrl || "";
  } else if (url.startsWith("data:") && url.length > maxDataUrlLen) {
    url =
      rest.posterUrl && rest.posterUrl.length <= maxDataUrlLen
        ? rest.posterUrl
        : "";
  }
  return { ...rest, url };
}

function syncWorkspaceToServer() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const syncableFiles = state.files.map((f) => toPersistedFileRecord(f, 800000));
    fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folders: state.folders,
        files: syncableFiles,
        shares: state.shares,
        feedback: state.feedback,
      }),
    }).catch(() => {});
  }, 120);
}

function saveWorkspaceCache() {
  try {
    const serializableFiles = state.files.map((f) => toPersistedFileRecord(f, 500000));
    localStorage.setItem(
      WORKSPACE_CACHE_KEY,
      JSON.stringify({
        folders: state.folders,
        files: serializableFiles,
        shares: state.shares,
        feedback: state.feedback,
      })
    );
  } catch {
    // If localStorage hits 5MB quota on large base64 data URLs, store compact records (full media remains in IndexedDB)
    try {
      const compactFiles = state.files.map((f) => toPersistedFileRecord(f, 180000));
      localStorage.setItem(
        WORKSPACE_CACHE_KEY,
        JSON.stringify({
          folders: state.folders,
          files: compactFiles,
          shares: state.shares,
          feedback: state.feedback,
        })
      );
    } catch {
      // ignore
    }
  }
  syncWorkspaceToServer();
}

function mergeById(localArr = [], remoteArr = []) {
  const map = new Map();
  for (const item of remoteArr) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of localArr) {
    if (!item || !item.id) continue;
    if (!map.has(item.id)) {
      map.set(item.id, item);
    } else {
      const rem = map.get(item.id);
      const bestUrl = isValidPersistentMediaUrl(item.url)
        ? item.url
        : isValidPersistentMediaUrl(rem.url)
        ? rem.url
        : item.posterUrl || rem.posterUrl || item.url || rem.url || "";
      const bestPoster = item.posterUrl || rem.posterUrl || null;
      map.set(item.id, {
        ...rem,
        ...item,
        url: bestUrl,
        posterUrl: bestPoster,
      });
    }
  }
  return Array.from(map.values());
}

// Application State
const cachedWs = loadWorkspaceCache();
const state = {
  user: getCurrentGoogleUser(),
  firebaseConnected: true,
  folders: cachedWs?.folders || [],
  files: cachedWs?.files || [],
  shares: cachedWs?.shares || [],
  feedback: cachedWs?.feedback || [],
  storageUsedBytes: 0,
  storageQuotaBytes: FIVE_GB,

  // Navigation & Filters
  activeNav: "ALL", // ALL | IMAGE | VIDEO | DOCUMENT | SHARES | REVIEWS | STARRED | TRASH
  currentFolderId: null,
  searchQuery: "",
  viewMode: "grid", // grid | table
  codePreviewMode: "render",

  // Upload Queue (disabled blocking loader; instant updates)
  uploadStatus: null,

  // Modals & Responsive Navigation
  mobileSidebarOpen: false,
  showNewFolderModal: false,
  showFirebaseModal: false,
  showGoogleAccountModal: false,
  shareTarget: null, // { resourceType: 'FOLDER'|'FILE', item }
  createdShareResult: null, // ShareLinkItem after creation
  previewFile: null, // MediaFileItem
};

/**
 * Per-Login 5.0 GB Free Workspace Isolation Helpers
 * Every Google login gets its own independent 5.0 GB Free Cloud Storage vault.
 */
function getPrimaryUserOwnerId(user = state.user) {
  if (!user) return "anonymous";
  const email = (user.email || "").toLowerCase().trim();
  if (email) return email;
  return String(user.uid || "default").toLowerCase().trim();
}

function getUserOwnerKeySet(user = state.user) {
  const keys = new Set();
  if (!user) return keys;
  if (user.email) keys.add(user.email.toLowerCase().trim());
  if (user.uid) keys.add(String(user.uid).toLowerCase().trim());
  return keys;
}

function claimLegacyDefaultItemsForUser(user = state.user) {
  if (!user) return;
  const primaryKey = getPrimaryUserOwnerId(user);
  if (!primaryKey || primaryKey === "anonymous") return;

  const hasLegacyItems =
    state.folders.some((f) => !f.ownerId || f.ownerId === "default") ||
    state.files.some((f) => !f.ownerId || f.ownerId === "default") ||
    state.shares.some((s) => !s.ownerId || s.ownerId === "default");

  if (!hasLegacyItems) return;

  let legacyOwner = null;
  try {
    legacyOwner = localStorage.getItem(LEGACY_DEFAULT_OWNER_KEY);
    if (!legacyOwner) {
      legacyOwner = primaryKey;
      localStorage.setItem(LEGACY_DEFAULT_OWNER_KEY, primaryKey);
    }
  } catch {
    legacyOwner = primaryKey;
  }

  const userKeys = getUserOwnerKeySet(user);
  if (userKeys.has(legacyOwner)) {
    let updated = false;
    for (const fld of state.folders) {
      if (!fld.ownerId || fld.ownerId === "default") {
        fld.ownerId = primaryKey;
        updated = true;
      }
    }
    for (const file of state.files) {
      if (!file.ownerId || file.ownerId === "default") {
        file.ownerId = primaryKey;
        updated = true;
      }
    }
    for (const shr of state.shares) {
      if (!shr.ownerId || shr.ownerId === "default") {
        shr.ownerId = primaryKey;
        updated = true;
      }
    }
    if (updated) saveWorkspaceCache();
  }
}

function belongsToCurrentUser(item, user = state.user) {
  if (!item || !user) return false;
  const owner = String(item.ownerId || "").toLowerCase().trim();
  const keys = getUserOwnerKeySet(user);
  if (owner && keys.has(owner)) return true;
  try {
    const legacyOwner = localStorage.getItem(LEGACY_DEFAULT_OWNER_KEY);
    if ((!owner || owner === "default") && legacyOwner && keys.has(legacyOwner)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function getUserFolders() {
  claimLegacyDefaultItemsForUser(state.user);
  return state.folders.filter((f) => belongsToCurrentUser(f));
}

function getUserFiles() {
  claimLegacyDefaultItemsForUser(state.user);
  return state.files.filter((f) => belongsToCurrentUser(f));
}

function getUserShares() {
  claimLegacyDefaultItemsForUser(state.user);
  return state.shares.filter((s) => belongsToCurrentUser(s));
}

function getUserFeedback() {
  const uFiles = new Set(getUserFiles().map((f) => f.id));
  const uShares = new Set(getUserShares().map((s) => s.id));
  return state.feedback.filter(
    (fb) => (fb.fileId && uFiles.has(fb.fileId)) || (fb.shareId && uShares.has(fb.shareId))
  );
}

let cleanupPreviewVideo = null;

// Toast Notification Helper
function showToast(message, type = "info") {
  let container = document.getElementById("vellum-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "vellum-toast-container";
    container.className = "fixed bottom-5 right-5 z-[100] flex flex-col gap-2.5 max-w-sm";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  const borderClass =
    type === "success"
      ? "border-emerald-500/30 text-emerald-200"
      : type === "error"
      ? "border-rose-500/30 text-rose-200"
      : "border-white/15 text-slate-200";
  el.className = `glass-modal px-4 py-3 rounded-xl text-xs font-medium border ${borderClass} shadow-2xl flex items-center gap-2.5 animate-view`;
  el.innerHTML = `
    <span class="w-2 h-2 rounded-full ${
      type === "success"
        ? "bg-emerald-400"
        : type === "error"
        ? "bg-rose-400"
        : "bg-amber-400"
    }"></span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 200ms ease";
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

// Navigation Router
function navigateTo(path) {
  window.history.pushState({}, "", path);
  handleRoute();
}

window.addEventListener("popstate", () => handleRoute());

async function fetchWorkspaceData() {
  if (getActiveClientPortalToken()) return;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folders: state.folders,
        files: state.files.map((f) => toPersistedFileRecord(f, 800000)),
        shares: state.shares,
        feedback: state.feedback,
      }),
    });
    if (res.ok) {
      const data = sanitizeWorkspaceCollections(await res.json());
      state.folders = mergeById(state.folders, data.folders || []);
      state.files = mergeById(state.files, data.files || []);
      state.shares = mergeById(state.shares, data.shares || []);
      state.feedback = mergeById(state.feedback, data.feedback || []);
      await hydrateMediaFilesFromVault(state.files);
      saveWorkspaceCache();
    }
  } catch (err) {
    console.error("Workspace sync notice:", err);
  }
}

async function handleRoute() {
  const path = window.location.pathname;

  if (cleanupPreviewVideo) {
    cleanupPreviewVideo();
    cleanupPreviewVideo = null;
  }

  // 1. Strict Public Client Share Portal (/share/:token) — completely isolated from Studio Account
  const clientToken = getActiveClientPortalToken();
  if (clientToken) {
    createClientPortalController({
      rootEl,
      token: clientToken,
      showToast,
    });
    return;
  }

  // Check Firebase Configuration
  const fbCfg = await loadFirebaseConfig();
  state.firebaseConnected = Boolean(fbCfg && fbCfg.apiKey);

  // 2. If not signed in with Google, or if new user needs to complete profile after Google login
  if (!state.user || path === "/login" || state.user.needsOnboarding) {
    renderGoogleLoginScreen();
    return;
  }

  // 3. Creator Studio Dashboard (hydrate IndexedDB media vault & render immediately)
  renderDashboard();
  hydrateMediaFilesFromVault(state.files).then((changed) => {
    if (changed) {
      saveWorkspaceCache();
      renderDashboard();
    }
  });
  fetchWorkspaceData().then(() => renderDashboard());
}

// ============================================================================
// GOOGLE-ONLY LOGIN SCREEN (LEFT LOGIN PANEL + RIGHT STUDIO SHOWCASE IMAGE)
// ============================================================================
function renderGoogleLoginScreen() {
  rootEl.innerHTML = `
    <div class="min-h-[100dvh] lg:h-screen lg:overflow-hidden grid grid-cols-1 lg:grid-cols-12 bg-[#12151e]">
      <!-- LEFT SIDE (FULL-SCREEN ON MOBILE/TABLET WITH TRANSLUCENT STUDIO IMAGE BACKDROP, LEFT COLUMN ON DESKTOP) -->
      <div class="lg:col-span-5 xl:col-span-5 min-h-[100dvh] lg:h-screen flex flex-col justify-between lg:border-r border-white/[0.12] studio-auth-panel relative overflow-hidden z-10">
        
        <!-- Mobile & Tablet Translucent Studio Image in Backside (< 1024px) -->
        <div class="lg:hidden pointer-events-none absolute inset-0 overflow-hidden">
          <img
            src="/assets/appex-studio-hero.jpg"
            alt=""
            class="w-full h-full object-cover object-center opacity-30 scale-105"
          />
          <div class="absolute inset-0 bg-gradient-to-b from-[#090c12]/80 via-[#090c12]/65 to-[#090c12]/92 backdrop-blur-[2px]"></div>
        </div>

        <!-- Visual Background Architecture (Grid, Viewfinder Corners, Lens Rings & Studio Light) -->
        <div class="pointer-events-none absolute inset-0 studio-grid-overlay"></div>

        <!-- Ambient Studio Spotlights & Concentric Aperture Rings Behind Card -->
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          <div class="w-[340px] h-[340px] sm:w-[540px] sm:h-[540px] rounded-full border border-white/[0.045] absolute"></div>
          <div class="w-[260px] h-[260px] sm:w-[390px] sm:h-[390px] rounded-full border border-dashed border-white/[0.07] absolute"></div>
          <div class="w-[220px] h-[220px] sm:w-[280px] sm:h-[280px] rounded-full bg-red-500/[0.08] blur-[75px] absolute -translate-y-4"></div>
          <div class="w-[240px] h-[240px] sm:w-[320px] sm:h-[320px] rounded-full bg-slate-200/[0.06] blur-[85px] absolute translate-y-6"></div>
        </div>

        <!-- Subtle Camera Viewfinder Framing Marks -->
        <div class="hidden sm:block pointer-events-none absolute top-24 left-7 w-4 h-4 border-t border-l border-white/20"></div>
        <div class="hidden sm:block pointer-events-none absolute top-24 right-7 w-4 h-4 border-t border-r border-white/20"></div>
        <div class="hidden sm:block pointer-events-none absolute bottom-16 left-7 w-4 h-4 border-b border-l border-white/20"></div>
        <div class="hidden sm:block pointer-events-none absolute bottom-16 right-7 w-4 h-4 border-b border-r border-white/20"></div>

        <!-- 1. Top Header Bar — Official Appex Logo pinned at Top-Left Corner -->
        <header class="relative z-10 w-full px-4 sm:px-7 pt-4 sm:pt-6 pb-2 sm:pb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 sm:gap-3.5">
            <div class="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center shadow-[0_8px_20px_rgba(0,0,0,0.65)] shrink-0 p-1.5">
              <img
                data-appex-logo="mark"
                src="/assets/appex-logo.webp"
                alt="Tech Titans Logo"
                class="w-full h-full object-contain drop-shadow-[0_2px_6px_rgba(239,68,68,0.25)]"
              />
            </div>
            <div>
              <div class="text-xs sm:text-sm font-bold tracking-wider text-white uppercase leading-none">TECH TITANS</div>
              <div class="text-[9px] sm:text-[10px] font-mono-code text-slate-300 tracking-wider mt-1">MEDIA VAULT & CLIENT PORTAL</div>
            </div>
          </div>
        </header>

        <!-- 2. Center Glassmorphic Sign-In Card (+ Translucent Glassmorphic Showcase Card on Mobile/Tablet) -->
        <div class="relative z-10 my-auto mx-auto w-full max-w-[460px] px-4 sm:px-6 py-4 sm:py-6 space-y-3.5">
          <div class="studio-auth-card rounded-2xl p-5 sm:p-8 w-full animate-view space-y-5 sm:space-y-6 relative overflow-hidden">
            <!-- Top Specular Metallic & Crimson Rim Line -->
            <div class="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-red-400/50 to-transparent"></div>

            <!-- Official Appex Emblem + Badge Header -->
            <div class="flex items-center justify-between gap-2.5">
              <div class="inline-flex items-center gap-1.5 sm:gap-2 px-2 sm:px-2.5 py-1 rounded-md bg-red-500/12 border border-red-400/30 text-[9px] sm:text-[10px] font-mono-code text-red-300 uppercase tracking-wider">
                <span class="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0"></span>
                <span class="truncate">Studio Workspace Access • 5 GB Free</span>
              </div>
              <img
                data-appex-logo="mark"
                src="/assets/appex-logo.webp"
                alt="Appex Mark"
                class="w-7 h-7 sm:w-8 sm:h-8 object-contain opacity-90 shrink-0"
              />
            </div>

            <div>
              <h1 class="text-xl sm:text-2xl md:text-3xl font-semibold text-white tracking-tight leading-snug">
                Deliver client media with studio precision.
              </h1>
              <p class="text-xs sm:text-sm text-slate-300 leading-relaxed mt-2 sm:mt-2.5">
                Every Google login includes <strong class="text-white font-semibold">5.0 GB Free Cloud Storage</strong>. Store high-resolution images, 4K video cuts, and project documents in structured folders and share secure client review links.
              </p>
            </div>

            <!-- Exclusive Google Sign-In Button -->
            <div>
              <button
                id="btn-google-signin"
                type="button"
                class="w-full bg-white hover:bg-slate-100 text-slate-950 font-semibold py-3 sm:py-3.5 px-4 sm:px-5 rounded-xl flex items-center justify-center gap-3 shadow-[0_10px_25px_-5px_rgba(255,255,255,0.2)] transition transform active:scale-[0.99]"
              >
                ${GOOGLE_LOGO_SVG}
                <span class="text-sm">Continue with Google</span>
              </button>
            </div>
          </div>

          <!-- Mobile & Tablet Translucent Glassmorphic Showcase Card (Floats over backside image, hidden on lg+) -->
          <div class="lg:hidden glass-panel rounded-2xl p-4 sm:p-5 border border-white/[0.15] bg-white/[0.04] backdrop-blur-xl space-y-2.5">
            <div class="text-[9px] sm:text-[10px] font-mono-code uppercase tracking-widest text-red-300">
              UNIFIED STORAGE & CLIENT DELIVERY
            </div>
            <div class="text-sm sm:text-base font-semibold text-white leading-snug">
              Built for Photographers, Filmmakers & Creative Agencies
            </div>
            <div class="text-[11px] sm:text-xs text-slate-300 leading-relaxed">
              Upload project folders, organize high-resolution stills, video masters, and documents, and share password-protected or open client links with instant approval tracking.
            </div>
            <div class="pt-2.5 border-t border-white/[0.1] grid grid-cols-2 gap-2 text-[10px] sm:text-xs font-mono-code text-slate-200">
              <span class="inline-flex items-center gap-1.5">
                <i data-lucide="image" class="w-3.5 h-3.5 text-amber-400 shrink-0"></i>
                <span class="truncate">High-Res Images</span>
              </span>
              <span class="inline-flex items-center gap-1.5">
                <i data-lucide="film" class="w-3.5 h-3.5 text-sky-400 shrink-0"></i>
                <span class="truncate">Video Streams</span>
              </span>
              <span class="inline-flex items-center gap-1.5">
                <i data-lucide="file-text" class="w-3.5 h-3.5 text-emerald-400 shrink-0"></i>
                <span class="truncate">Project Documents</span>
              </span>
              <span class="inline-flex items-center gap-1.5">
                <i data-lucide="folder-lock" class="w-3.5 h-3.5 text-slate-300 shrink-0"></i>
                <span class="truncate">Client Folder Links</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 3. Bottom Footer — Pinned at the very bottom of the screen -->
        <footer class="relative z-10 w-full px-4 sm:px-7 py-3.5 sm:py-4 border-t border-white/[0.1] bg-black/30 backdrop-blur-md flex flex-wrap items-center justify-between gap-2 text-[11px] sm:text-xs">
          <div class="flex items-center gap-1.5 sm:gap-2 text-slate-300">
            <span class="font-medium">© Tech Titans</span>
            <span class="text-slate-600">•</span>
            <span class="text-slate-400">Mohammad Asrar, Punit Badyal And Neyashri A</span>
          </div>
        </footer>

      </div>

      <!-- RIGHT SIDE: FULL-VIEWPORT FRAMED STUDIO PHOTOGRAPHY SHOWCASE (DESKTOP ONLY lg+) -->
      <div class="hidden lg:flex lg:col-span-7 xl:col-span-7 lg:h-screen p-7 items-center justify-center relative">
        <div class="relative w-full h-full rounded-3xl overflow-hidden border border-white/[0.14] shadow-2xl flex flex-col justify-between p-8">
          <!-- Generated Studio Background Image -->
          <img
            src="/assets/appex-studio-hero.jpg"
            alt="Tech Titans Production Suite"
            class="absolute inset-0 w-full h-full object-cover object-center"
          />
          <!-- Balanced Vignette Gradients -->
          <div class="absolute inset-0 bg-gradient-to-t from-[#06080c]/95 via-[#06080c]/20 to-[#06080c]/45"></div>

          <!-- Top Badge Inside Showcase -->
          <div class="relative z-10 flex items-center justify-between gap-4 w-full">
            <div class="glass-panel px-3.5 py-1.5 rounded-full text-[11px] font-mono-code text-slate-200 inline-flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
              <span>TECH TITANS • CREATIVE MEDIA WORKSPACE</span>
            </div>
          </div>

          <!-- Bottom Studio Caption Card (No Demo Links) -->
          <div class="relative z-10 w-full">
            <div class="glass-panel rounded-2xl p-6 border border-white/[0.15] backdrop-blur-xl space-y-3">
              <div class="text-[10px] font-mono-code uppercase tracking-widest text-red-300">
                UNIFIED STORAGE & CLIENT DELIVERY
              </div>
              <div class="text-lg font-semibold text-white leading-snug">
                Built for Photographers, Filmmakers & Creative Agencies
              </div>
              <div class="text-xs text-slate-300 max-w-2xl leading-relaxed">
                Upload project folders, organize high-resolution stills, video masters, and documents, and share password-protected or open client links with instant approval tracking.
              </div>

              <div class="pt-3 border-t border-white/[0.1] flex flex-wrap items-center gap-5 text-xs font-mono-code text-slate-300">
                <span class="inline-flex items-center gap-1.5">
                  <i data-lucide="image" class="w-3.5 h-3.5 text-amber-400"></i>
                  High-Res Images
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <i data-lucide="film" class="w-3.5 h-3.5 text-sky-400"></i>
                  Video Streams
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <i data-lucide="file-text" class="w-3.5 h-3.5 text-emerald-400"></i>
                  Project Documents
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <i data-lucide="folder-lock" class="w-3.5 h-3.5 text-slate-300"></i>
                  Client Folder Links
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    ${state.user && state.user.needsOnboarding ? renderNewUserOnboardingModal(state.user) : ""}
  `;

  if (window.lucide) window.lucide.createIcons();
  enhanceAppexLogos();

  document.getElementById("btn-google-signin")?.addEventListener("click", async () => {
    try {
      const profile = await signInWithFirebaseGoogle();
      state.user = profile;
      state.currentFolderId = null;
      if (profile.needsOnboarding) {
        renderGoogleLoginScreen();
        document.getElementById("onboarding-name-input")?.focus();
        return;
      }
      showToast(`Signed in as ${profile.displayName} • 5.0 GB Free Storage active`, "success");
      navigateTo("/dashboard");
    } catch (err) {
      if (
        err?.code === "auth/popup-closed-by-user" ||
        err?.code === "auth/cancelled-popup-request"
      ) {
        return;
      }
      if (err?.code === "auth/unauthorized-domain") {
        showToast(
          `Please add "${window.location.hostname}" to Firebase Console → Authentication → Settings → Authorized domains`,
          "error"
        );
        return;
      }
      showToast(err?.message || "Google Sign-In could not be completed", "error");
    }
  });

  bindNewUserOnboardingEvents();
}

function renderNewUserOnboardingModal(user) {
  return `
    <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
      <div class="glass-modal w-full max-w-md rounded-2xl overflow-hidden animate-modal">
        <div class="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            ${GOOGLE_LOGO_SVG}
            <span class="text-sm font-semibold text-white">Complete Your Profile — Tech Titans</span>
          </div>
        </div>

        <div class="p-6 space-y-4">
          <p class="text-xs text-slate-300">
            Welcome! Your Google account is verified and includes <strong class="text-emerald-300">5.0 GB Free Cloud Storage</strong>. Please confirm your name to complete your new studio profile:
          </p>

          <form id="new-user-onboarding-form" class="space-y-3.5">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-[11px] text-slate-300">Google Email</label>
                <span class="text-[10px] font-mono-code text-emerald-400">Verified • 5.0 GB Free</span>
              </div>
              <input
                type="email"
                readonly
                value="${escapeHtml(user?.email || "")}"
                class="glass-input w-full px-3 py-2 rounded-lg text-xs text-slate-300 bg-white/[0.03] border-white/[0.08] cursor-not-allowed select-all"
              />
            </div>

            <div>
              <label class="block text-[11px] text-slate-300 mb-1">Your Name</label>
              <input
                id="onboarding-name-input"
                type="text"
                required
                value="${escapeHtml(user?.googleDisplayName || "")}"
                placeholder="Enter your full name"
                class="glass-input w-full px-3 py-2 rounded-lg text-xs"
              />
            </div>

            <button type="submit" class="btn-studio-primary w-full py-2.5 rounded-lg text-xs flex items-center justify-center gap-2">
              <span>Continue to Tech Titans</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function bindNewUserOnboardingEvents() {
  document.getElementById("new-user-onboarding-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("onboarding-name-input");
    const displayName = nameInput ? nameInput.value.trim() : "";
    if (!displayName) return;
    state.user = completeNewUserOnboarding(state.user, displayName);
    showToast(`Welcome to Tech Titans, ${state.user.displayName} (5.0 GB Free)`, "success");
    navigateTo("/dashboard");
  });
}

// ============================================================================
// CREATOR STUDIO DASHBOARD
// ============================================================================
function renderDashboard() {
  if (getActiveClientPortalToken()) {
    return;
  }
  if (cleanupPreviewVideo) {
    cleanupPreviewVideo();
    cleanupPreviewVideo = null;
  }

  const userFolders = getUserFolders();
  const userFiles = getUserFiles();
  const userShares = getUserShares();
  const userFeedback = getUserFeedback();

  if (state.currentFolderId && !userFolders.some((f) => f.id === state.currentFolderId)) {
    state.currentFolderId = null;
  }

  const activeFiles = userFiles.filter((f) => !f.isTrashed);
  const imageBytes = activeFiles
    .filter((f) => f.category === "IMAGE")
    .reduce((a, b) => a + (Number(b.sizeBytes) || 0), 0);
  const videoBytes = activeFiles
    .filter((f) => f.category === "VIDEO")
    .reduce((a, b) => a + (Number(b.sizeBytes) || 0), 0);
  const docBytes = activeFiles
    .filter((f) => f.category === "DOCUMENT")
    .reduce((a, b) => a + (Number(b.sizeBytes) || 0), 0);
  const totalUsedBytes = imageBytes + videoBytes + docBytes;
  const quotaPct =
    totalUsedBytes > 0 ? Math.min(100, Math.max(1, (totalUsedBytes / FIVE_GB) * 100)) : 0;

  const videoPct = videoBytes > 0 ? Math.max(1.2, (videoBytes / FIVE_GB) * 100) : 0;
  const imagePct = imageBytes > 0 ? Math.max(1.2, (imageBytes / FIVE_GB) * 100) : 0;
  const docPct = docBytes > 0 ? Math.max(1, (docBytes / FIVE_GB) * 100) : 0;

  // Compute breadcrumbs when in ALL nav
  const breadcrumbs = [];
  if (state.activeNav === "ALL" && state.currentFolderId) {
    let ptr = userFolders.find((f) => f.id === state.currentFolderId);
    while (ptr) {
      breadcrumbs.unshift(ptr);
      ptr = userFolders.find((f) => f.id === ptr.parentId);
    }
  }

  // Filter folders and files for current view
  let visibleFolders = [];
  let visibleFiles = [];

  const q = state.searchQuery.trim().toLowerCase();

  if (state.activeNav === "ALL") {
    visibleFolders = userFolders.filter(
      (f) =>
        !f.isTrashed &&
        (q ? f.name.toLowerCase().includes(q) : f.parentId === state.currentFolderId)
    );
    visibleFiles = userFiles.filter(
      (f) =>
        !f.isTrashed &&
        (q ? f.name.toLowerCase().includes(q) : f.folderId === state.currentFolderId)
    );
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(state.activeNav)) {
    visibleFiles = userFiles.filter(
      (f) =>
        !f.isTrashed &&
        f.category === state.activeNav &&
        (!q || f.name.toLowerCase().includes(q))
    );
  } else if (state.activeNav === "STARRED") {
    visibleFolders = userFolders.filter(
      (f) => !f.isTrashed && f.isStarred && (!q || f.name.toLowerCase().includes(q))
    );
    visibleFiles = userFiles.filter(
      (f) => !f.isTrashed && f.isStarred && (!q || f.name.toLowerCase().includes(q))
    );
  } else if (state.activeNav === "TRASH") {
    visibleFolders = userFolders.filter((f) => f.isTrashed);
    visibleFiles = userFiles.filter((f) => f.isTrashed);
  } else if (state.activeNav === "REVIEWS") {
    visibleFiles = userFiles.filter(
      (f) =>
        !f.isTrashed &&
        (f.approvalStatus === "APPROVED" ||
          f.approvalStatus === "CHANGES_REQUESTED" ||
          userFeedback.some((fb) => fb.fileId === f.id))
    );
  }

  const initials = (state.user?.displayName || "Studio")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  rootEl.innerHTML = `
    <div id="dashboard-dropzone" class="min-h-screen flex flex-col lg:flex-row relative">
      <!-- MOBILE & TABLET SIDEBAR BACKDROP (< 1024px) -->
      ${
        state.mobileSidebarOpen
          ? `<div id="mobile-sidebar-backdrop" class="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"></div>`
          : ""
      }

      <!-- LEFT GLASS SIDEBAR (Slide-over Drawer on <1024px, Pinned Sidebar on lg+) -->
      <aside class="glass-sidebar fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] transform transition-transform duration-200 ease-out ${
        state.mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
      } lg:static lg:translate-x-0 lg:w-64 shrink-0 flex flex-col justify-between p-4 lg:min-h-screen overflow-y-auto">
        <div class="space-y-6">
          <!-- Brand Header -->
          <div class="flex items-center justify-between px-2 pt-1">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-9 h-9 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center p-1 shadow-md shrink-0">
                <img
                  data-appex-logo="mark"
                  src="/assets/appex-logo.webp"
                  alt="Tech Titans"
                  class="w-full h-full object-contain"
                />
              </div>
              <div class="min-w-0">
                <div class="text-sm font-bold text-white tracking-wider leading-none truncate">TECH TITANS</div>
                <div class="text-[10px] font-mono-code text-slate-400 mt-1 truncate max-w-[135px]">${escapeHtml(
                  state.user?.studioName || "Tech Titans"
                )}</div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-white/[0.05] text-slate-300 border border-white/[0.08]">PRO</span>
              <button
                id="btn-close-mobile-sidebar"
                type="button"
                class="lg:hidden glass-button p-1.5 rounded-lg text-slate-400 hover:text-white"
                title="Close Navigation"
              >
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <!-- Primary Upload Action -->
          <button
            id="sidebar-upload-btn"
            class="btn-studio-primary w-full py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2"
          >
            <i data-lucide="upload" class="w-4 h-4"></i>
            <span>Upload Media Files</span>
          </button>

          <!-- Navigation Menu -->
          <nav class="space-y-1">
            <div class="px-2.5 pb-1 text-[10px] font-mono-code uppercase tracking-wider text-slate-500">Media Library</div>
            ${[
              {
                id: "ALL",
                label: "All Folders & Files",
                icon: "folder-kanban",
                count: activeFiles.length,
              },
              {
                id: "IMAGE",
                label: "Images & Stills",
                icon: "image",
                count: activeFiles.filter((f) => f.category === "IMAGE").length,
              },
              {
                id: "VIDEO",
                label: "Video Deliverables",
                icon: "film",
                count: activeFiles.filter((f) => f.category === "VIDEO").length,
              },
              {
                id: "DOCUMENT",
                label: "Documents & Code",
                icon: "file-code",
                count: activeFiles.filter((f) => f.category === "DOCUMENT").length,
              },
            ]
              .map(
                (item) => `
              <button
                data-nav-item="${item.id}"
                class="w-full px-3 py-2 rounded-xl text-xs font-medium flex items-center justify-between transition ${
                  state.activeNav === item.id
                    ? "bg-white/[0.09] text-white border border-white/[0.12]"
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                }"
              >
                <span class="flex items-center gap-2.5">
                  <i data-lucide="${item.icon}" class="w-4 h-4 ${
                  state.activeNav === item.id ? "text-amber-400" : "text-slate-400"
                }"></i>
                  <span>${item.label}</span>
                </span>
                <span class="text-[11px] font-mono-code text-slate-500">${item.count}</span>
              </button>
            `
              )
              .join("")}

            <div class="px-2.5 pt-4 pb-1 text-[10px] font-mono-code uppercase tracking-wider text-slate-500">Client Delivery</div>
            ${[
              {
                id: "SHARES",
                label: "Client Share Links",
                icon: "link-2",
                count: userShares.length,
              },
              {
                id: "REVIEWS",
                label: "Client Approvals",
                icon: "check-circle-2",
                count: userFeedback.length,
              },
              {
                id: "STARRED",
                label: "Starred Items",
                icon: "star",
                count:
                  activeFiles.filter((f) => f.isStarred).length +
                  userFolders.filter((f) => !f.isTrashed && f.isStarred).length,
              },
              {
                id: "TRASH",
                label: "Trash",
                icon: "trash-2",
                count:
                  userFiles.filter((f) => f.isTrashed).length +
                  userFolders.filter((f) => f.isTrashed).length,
              },
            ]
              .map(
                (item) => `
              <button
                data-nav-item="${item.id}"
                class="w-full px-3 py-2 rounded-xl text-xs font-medium flex items-center justify-between transition ${
                  state.activeNav === item.id
                    ? "bg-white/[0.09] text-white border border-white/[0.12]"
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                }"
              >
                <span class="flex items-center gap-2.5">
                  <i data-lucide="${item.icon}" class="w-4 h-4 ${
                  state.activeNav === item.id ? "text-amber-400" : "text-slate-400"
                }"></i>
                  <span>${item.label}</span>
                </span>
                <span class="text-[11px] font-mono-code text-slate-500">${item.count}</span>
              </button>
            `
              )
              .join("")}
          </nav>
        </div>

        <!-- Bottom Storage Meter & Google Account Card -->
        <div class="space-y-4 pt-6">
          <!-- Studio Cloud Storage Quota Card (5.0 GB Free per Google Login) -->
          <div class="glass-card rounded-xl p-3.5 space-y-2.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-slate-200 flex items-center gap-1.5">
                <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-amber-400"></i>
                <span>Cloud Storage</span>
              </span>
              <span class="text-[10px] font-mono-code px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                5.0 GB Free
              </span>
            </div>

            <div class="w-full h-1.5 bg-white/[0.07] rounded-full overflow-hidden flex">
              ${videoPct > 0 ? `<div style="width: ${videoPct}%" class="bg-sky-400 h-full"></div>` : ""}
              ${imagePct > 0 ? `<div style="width: ${imagePct}%" class="bg-amber-400 h-full"></div>` : ""}
              ${docPct > 0 ? `<div style="width: ${docPct}%" class="bg-emerald-400 h-full"></div>` : ""}
            </div>

            <div class="flex items-center justify-between text-[11px] font-mono-code text-slate-400">
              <span>${formatBytes(totalUsedBytes)} used</span>
              <span>${formatBytes(Math.max(0, FIVE_GB - totalUsedBytes))} free</span>
            </div>
          </div>

          <!-- Signed-in Google User Profile -->
          <div class="glass-card rounded-xl p-3 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                ${escapeHtml(initials)}
              </div>
              <div class="min-w-0">
                <div class="text-xs font-medium text-white truncate">${escapeHtml(
                  state.user?.displayName || "Studio Creator"
                )}</div>
                <div class="text-[11px] text-slate-400 font-mono-code truncate flex items-center gap-1">
                  <span>Google Verified</span>
                </div>
              </div>
            </div>
            <button
              id="btn-signout-google"
              class="glass-button p-1.5 rounded-lg text-slate-400 hover:text-rose-300"
              title="Sign Out of Google Account"
            >
              <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      </aside>

      <!-- MAIN WORKSPACE AREA -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Top Frosted Glass Header -->
        <header class="glass-header sticky top-0 z-20 px-3.5 sm:px-6 py-3 flex flex-col gap-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2.5">
            <!-- Left: Mobile Drawer Button + Breadcrumb Navigation -->
            <div class="flex items-center gap-1.5 text-xs sm:text-sm min-w-0 flex-wrap">
              <button
                id="btn-mobile-sidebar-toggle"
                type="button"
                class="lg:hidden glass-button p-2 rounded-lg text-slate-200 hover:text-white inline-flex items-center justify-center shrink-0"
                title="Open Studio Menu"
              >
                <i data-lucide="menu" class="w-4 h-4"></i>
              </button>

              <div class="lg:hidden w-7 h-7 rounded-lg bg-[#080a0f]/90 border border-white/20 flex items-center justify-center p-1 shrink-0">
                <img
                  data-appex-logo="mark"
                  src="/assets/appex-logo.webp"
                  alt="Tech Titans"
                  class="w-full h-full object-contain"
                />
              </div>

              <button
                id="breadcrumb-root"
                class="px-2 sm:px-2.5 py-1 rounded-lg transition flex items-center gap-1.5 ${
                  state.activeNav === "ALL" && !state.currentFolderId
                    ? "bg-white/10 text-white font-medium border border-white/15"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
                }"
              >
                <i data-lucide="layers" class="w-3.5 h-3.5 text-amber-400 shrink-0"></i>
                <span class="truncate max-w-[120px] sm:max-w-none">Studio Workspace</span>
              </button>

              ${
                state.activeNav === "ALL"
                  ? breadcrumbs
                      .map(
                        (b, idx) => `
                    <span class="text-slate-600">/</span>
                    <button
                      data-breadcrumb-folder="${escapeHtml(b.id)}"
                      class="px-2 sm:px-2.5 py-1 rounded-lg transition truncate max-w-[125px] sm:max-w-[200px] ${
                        idx === breadcrumbs.length - 1
                          ? "bg-white/10 text-white font-medium border border-white/15"
                          : "text-slate-400 hover:text-white hover:bg-white/5"
                      }"
                    >
                      ${escapeHtml(b.name)}
                    </button>
                  `
                      )
                      .join("")
                  : `<span class="text-slate-600">/</span>
                     <span class="px-2 sm:px-2.5 py-1 rounded-lg bg-white/10 text-white text-[11px] sm:text-xs font-mono-code uppercase">${escapeHtml(
                       state.activeNav
                     )}</span>`
              }
            </div>

            <!-- Right: Search + View Controls + Folder & Share Actions -->
            <div class="flex items-center gap-2 flex-wrap w-full sm:w-auto justify-between sm:justify-end">
              <div class="relative flex-1 sm:flex-initial min-w-[140px]">
                <i data-lucide="search" class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"></i>
                <input
                  id="workspace-search-input"
                  type="text"
                  value="${escapeHtml(state.searchQuery)}"
                  placeholder="Search files or folders…"
                  class="glass-input pl-8 pr-3 py-1.5 rounded-lg text-xs w-full sm:w-52 md:w-60"
                />
              </div>

              <!-- Grid vs List Toggle -->
              <div class="flex items-center bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.08] shrink-0">
                <button
                  data-view-mode="grid"
                  class="p-1.5 rounded-md transition ${
                    state.viewMode === "grid"
                      ? "bg-white/15 text-white"
                      : "text-slate-400 hover:text-white"
                  }"
                  title="Grid View"
                >
                  <i data-lucide="grid" class="w-3.5 h-3.5"></i>
                </button>
                <button
                  data-view-mode="table"
                  class="p-1.5 rounded-md transition ${
                    state.viewMode === "table"
                      ? "bg-white/15 text-white"
                      : "text-slate-400 hover:text-white"
                  }"
                  title="Table List View"
                >
                  <i data-lucide="list" class="w-3.5 h-3.5"></i>
                </button>
              </div>

              <button
                id="header-new-folder-btn"
                class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 shrink-0"
                title="New Folder"
              >
                <i data-lucide="folder-plus" class="w-3.5 h-3.5 text-amber-400"></i>
                <span class="hidden xs:inline sm:inline">New Folder</span>
              </button>

              <button
                id="header-upload-folder-btn"
                class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 shrink-0"
                title="Upload Folder"
              >
                <i data-lucide="folder-up" class="w-3.5 h-3.5 text-sky-400"></i>
                <span class="hidden sm:inline">Upload Folder</span>
              </button>

              ${
                state.currentFolderId
                  ? `<button
                      id="header-share-current-folder"
                      class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 border-amber-500/30 inline-flex items-center gap-1.5 shrink-0"
                    >
                      <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
                      <span>Share Folder</span>
                    </button>`
                  : ""
              }

              <button
                id="header-upload-btn"
                class="btn-studio-primary px-3 sm:px-3.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 shrink-0"
              >
                <i data-lucide="plus" class="w-3.5 h-3.5"></i>
                <span>Upload Files</span>
              </button>
            </div>
          </div>

          <!-- Mobile & Tablet Quick-Filter Pill Strip (< 1024px) -->
          <div class="lg:hidden flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-1 pb-0.5 border-t border-white/[0.06]">
            ${[
              { id: "ALL", label: "All", icon: "folder-kanban" },
              { id: "IMAGE", label: "Images", icon: "image" },
              { id: "VIDEO", label: "Videos", icon: "film" },
              { id: "DOCUMENT", label: "Docs", icon: "file-text" },
              { id: "SHARES", label: "Shares", icon: "link-2" },
              { id: "REVIEWS", label: "Approvals", icon: "check-circle-2" },
              { id: "STARRED", label: "Starred", icon: "star" },
              { id: "TRASH", label: "Trash", icon: "trash-2" },
            ]
              .map(
                (item) => `
              <button
                data-nav-item="${item.id}"
                class="px-2.5 py-1 rounded-lg text-[11px] font-medium inline-flex items-center gap-1.5 shrink-0 transition ${
                  state.activeNav === item.id
                    ? "bg-white/15 text-white border border-white/20"
                    : "text-slate-400 hover:text-white bg-white/[0.03] border border-transparent"
                }"
              >
                <i data-lucide="${item.icon}" class="w-3 h-3 ${
                  state.activeNav === item.id ? "text-amber-400" : "text-slate-400"
                }"></i>
                <span>${item.label}</span>
              </button>
            `
              )
              .join("")}
          </div>
        </header>

        <!-- Main Explorer Body -->
        <main class="flex-1 p-3.5 sm:p-6 space-y-6 sm:space-y-8 animate-view">
          ${
            state.activeNav === "SHARES"
              ? renderSharesManagementSection()
              : state.activeNav === "REVIEWS"
              ? renderReviewsSection(visibleFiles)
              : renderMediaExplorerSection(visibleFolders, visibleFiles, quotaPct)
          }
        </main>
      </div>
    </div>

    ${state.showNewFolderModal ? renderNewFolderModal() : ""}
    ${state.shareTarget ? renderShareModal(state.shareTarget, state.createdShareResult) : ""}
    ${state.previewFile ? renderStudioPreviewModal(state.previewFile) : ""}
    ${state.showFirebaseModal ? renderFirebaseConfigModal() : ""}
  `;

  if (window.lucide) window.lucide.createIcons();
  enhanceAppexLogos();
  bindDashboardEvents();
}

// ============================================================================
// EXPLORER SECTIONS (FOLDERS + MEDIA FILES + CLIENT SHARES)
// ============================================================================
function renderMediaExplorerSection(visibleFolders, visibleFiles) {
  const userFolders = getUserFolders();
  const userFiles = getUserFiles();
  const userShares = getUserShares();

  const currentFolder = state.currentFolderId
    ? userFolders.find((f) => f.id === state.currentFolderId)
    : null;
  const activeFolderShare = currentFolder
    ? userShares.find(
        (s) =>
          s.isActive !== false &&
          s.resourceType === "FOLDER" &&
          (s.folderId === currentFolder.id || s.resourceName === currentFolder.name)
      )
    : null;

  return `
    ${
      activeFolderShare
        ? `<div class="glass-panel rounded-2xl p-4 border border-emerald-500/30 bg-emerald-500/[0.05] flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <div class="min-w-0">
                <div class="text-xs font-semibold text-emerald-300 flex items-center gap-2">
                  <span>Live Client Folder Share Active</span>
                  <span class="font-mono-code text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30">/share/${escapeHtml(
                    activeFolderShare.token
                  )}</span>
                </div>
                <div class="text-[11px] text-slate-300 mt-0.5">
                  Any new images, videos, or documents uploaded into <strong>${escapeHtml(
                    currentFolder.name
                  )}</strong> automatically appear on the client side in real time.
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                data-copy-share-url="${escapeHtml(
                  `${window.location.origin}/share/${activeFolderShare.token}`
                )}"
                class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-white inline-flex items-center gap-1.5"
              >
                <i data-lucide="copy" class="w-3.5 h-3.5 text-emerald-400"></i>
                <span>Copy Client Link</span>
              </button>
              <button
                data-open-share-portal="${escapeHtml(activeFolderShare.token)}"
                class="btn-studio-primary px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
              >
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                <span>Open Client View</span>
              </button>
            </div>
          </div>`
        : ""
    }

    <!-- Quick Drag & Drop Studio Bar -->
    <div
      id="inline-upload-dropzone"
      class="glass-panel rounded-2xl p-5 border-dashed border-white/[0.14] hover:border-white/[0.25] transition flex flex-col sm:flex-row items-center justify-between gap-4 cursor-pointer"
    >
      <div class="flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-white/[0.05] border border-white/[0.1] flex items-center justify-center text-amber-400 shrink-0">
          <i data-lucide="upload-cloud" class="w-5 h-5"></i>
        </div>
        <div>
          <div class="text-sm font-medium text-white">Drop images, videos, or documents here to upload${
            currentFolder ? ` into "${escapeHtml(currentFolder.name)}"` : ""
          }</div>
          <div class="text-xs text-slate-400">
            Supports RAW/SVG/PNG/JPG stills, MP4/MOV video streams, and PDF/Office project documents • Instant live sync to shared client links
          </div>
        </div>
      </div>
      <span class="glass-button px-3.5 py-1.5 rounded-lg text-xs font-mono-code text-slate-200 shrink-0">
        Select Files
      </span>
    </div>

    <!-- Live Per-Media Upload Progress Queue Slot -->
    <div id="active-upload-queue-slot">${renderActiveUploadQueueHTML()}</div>

    <!-- FOLDERS SECTION -->
    ${
      visibleFolders.length > 0
        ? `
      <section>
        <div class="flex items-center justify-between mb-3.5">
          <h2 class="text-xs font-mono-code uppercase tracking-wider text-slate-400">
            Folders (${visibleFolders.length})
          </h2>
          <span class="text-[11px] text-slate-500">Click a folder to open • Upload files inside to auto-update shared client links</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          ${visibleFolders
            .map((fld) => {
              const c = getFolderColorStyles(fld.color);
              const itemCount =
                userFiles.filter((f) => !f.isTrashed && f.folderId === fld.id).length +
                userFolders.filter((sf) => !sf.isTrashed && sf.parentId === fld.id)
                  .length;
              const folderBytes = userFiles
                .filter((f) => !f.isTrashed && f.folderId === fld.id)
                .reduce((a, b) => a + (Number(b.sizeBytes) || 0), 0);
              const existingShare = userShares.find(
                (s) =>
                  s.isActive !== false &&
                  s.resourceType === "FOLDER" &&
                  (s.folderId === fld.id || s.resourceName === fld.name)
              );

              return `
                <div
                  data-open-folder="${escapeHtml(fld.id)}"
                  class="glass-card rounded-xl p-4 cursor-pointer flex flex-col justify-between gap-3.5 group"
                >
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex items-center gap-3 min-w-0">
                      <div class="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center ${
                        c.icon
                      } shrink-0">
                        <i data-lucide="folder" class="w-5 h-5 fill-current opacity-85"></i>
                      </div>
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-white truncate group-hover:text-amber-300 transition" title="${escapeHtml(
                          fld.name
                        )}">
                          ${escapeHtml(fld.name)}
                        </div>
                        <div class="text-[11px] text-slate-400 font-mono-code mt-0.5">
                          ${itemCount} ${itemCount === 1 ? "item" : "items"} • ${formatBytes(
                folderBytes
              )}
                        </div>
                      </div>
                    </div>
                    ${
                      existingShare
                        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono-code bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0" title="Live Client Share Active">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                            Shared
                          </span>`
                        : ""
                    }
                  </div>

                  <div class="pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-1">
                    <div class="flex items-center gap-1.5">
                      <button
                        data-share-folder="${escapeHtml(fld.id)}"
                        class="glass-button px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-200 hover:text-amber-300 inline-flex items-center gap-1.5"
                        title="Create or Manage Client Share Link for this Folder"
                      >
                        <i data-lucide="share-2" class="w-3 h-3 text-amber-400"></i>
                        <span>${existingShare ? "Share Settings" : "Share Folder"}</span>
                      </button>
                      ${
                        existingShare
                          ? `<button
                              data-copy-folder-share="${escapeHtml(
                                `${window.location.origin}/share/${existingShare.token}`
                              )}"
                              class="glass-button p-1.5 rounded-md text-emerald-300 hover:text-white"
                              title="Copy Active Client Share Link"
                            >
                              <i data-lucide="copy" class="w-3 h-3"></i>
                            </button>`
                          : ""
                      }
                    </div>

                    <div class="flex items-center gap-1">
                      <button
                        data-star-folder="${escapeHtml(fld.id)}"
                        class="p-1 rounded hover:bg-white/10 ${
                          fld.isStarred ? "text-amber-400" : "text-slate-500 hover:text-slate-300"
                        }"
                        title="Star Folder"
                      >
                        <i data-lucide="star" class="w-3.5 h-3.5 ${
                          fld.isStarred ? "fill-current" : ""
                        }"></i>
                      </button>
                      <button
                        data-trash-folder="${escapeHtml(fld.id)}"
                        class="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-rose-400"
                        title="${fld.isTrashed ? "Delete Permanently" : "Move to Trash"}"
                      >
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                      </button>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
    `
        : ""
    }

    <!-- MEDIA FILES SECTION -->
    <section>
      <div class="flex items-center justify-between mb-3.5">
        <h2 class="text-xs font-mono-code uppercase tracking-wider text-slate-400">
          Media Deliverables (${visibleFiles.length})
        </h2>
        <span class="text-[11px] text-slate-500">Images • Videos • Documents</span>
      </div>

      ${
        visibleFiles.length === 0
          ? `<div class="glass-panel rounded-2xl p-12 text-center space-y-3">
              <div class="w-11 h-11 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mx-auto text-slate-400">
                <i data-lucide="folder-open" class="w-5 h-5"></i>
              </div>
              <div class="text-sm font-medium text-white">No media files in this view</div>
              <p class="text-xs text-slate-400 max-w-md mx-auto">
                Click "Upload Media Files" or drag and drop images, videos, or PDF documents from your computer into this folder.
              </p>
            </div>`
          : state.viewMode === "grid"
          ? renderFilesGridView(visibleFiles)
          : renderFilesTableView(visibleFiles)
      }
    </section>
  `;
}

function renderActiveUploadQueueHTML() {
  const uploadingFiles = getUserFiles().filter(
    (f) =>
      !f.isTrashed &&
      (f.uploadStatus === "uploading" || f.uploadStatus === "complete")
  );
  if (uploadingFiles.length === 0) return "";

  const totalPct = Math.round(
    uploadingFiles.reduce((acc, f) => acc + (Number(f.uploadProgress) || 0), 0) /
      uploadingFiles.length
  );
  const completedCount = uploadingFiles.filter(
    (f) => (f.uploadProgress || 0) >= 100
  ).length;
  const allDone = completedCount === uploadingFiles.length;

  return `
    <div class="glass-panel rounded-2xl p-4 border ${
      allDone ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-amber-500/30 bg-amber-500/[0.04]"
    } space-y-3.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2.5">
          <span class="w-2.5 h-2.5 rounded-full ${
            allDone ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
          }"></span>
          <span class="text-xs font-semibold text-white">
            ${
              allDone
                ? `Uploaded ${uploadingFiles.length} ${
                    uploadingFiles.length === 1 ? "media deliverable" : "media deliverables"
                  } (100%)`
                : `Uploading ${uploadingFiles.length} ${
                    uploadingFiles.length === 1 ? "media deliverable" : "media deliverables"
                  } (${completedCount}/${uploadingFiles.length} complete)`
            }
          </span>
        </div>
        <span class="text-xs font-mono-code font-semibold ${
          allDone ? "text-emerald-300" : "text-amber-300"
        }">${totalPct}%</span>
      </div>

      <!-- Overall Batch Upload Progress Line -->
      <div class="w-full h-1.5 rounded-full bg-slate-900/90 overflow-hidden border border-white/[0.06]">
        <div
          class="h-full rounded-full transition-all duration-150 ${
            allDone
              ? "bg-emerald-400"
              : "bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400"
          }"
          style="width: ${totalPct}%"
        ></div>
      </div>

      <!-- Individual Media File Progress Lines -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-48 overflow-y-auto pr-1">
        ${uploadingFiles
          .map((f) => {
            const pct = Math.min(100, Math.max(0, Number(f.uploadProgress) || 0));
            const done = pct >= 100 || f.uploadStatus === "complete";
            const loadedBytes =
              f.uploadedBytes !== undefined
                ? f.uploadedBytes
                : Math.round((pct / 100) * (f.sizeBytes || 0));
            return `
              <div class="glass-card rounded-xl px-3 py-2.5 space-y-1.5 border ${
                done ? "border-emerald-500/25" : "border-white/[0.08]"
              }">
                <div class="flex items-center justify-between gap-2 text-[11px]">
                  <span class="font-medium text-white truncate" title="${escapeHtml(
                    f.name
                  )}">${escapeHtml(f.name)}</span>
                  <span class="font-mono-code shrink-0 ${
                    done ? "text-emerald-300" : "text-amber-300"
                  }">${done ? "100% ✓" : `${pct}%`}</span>
                </div>
                <div class="w-full h-1.5 rounded-full bg-slate-950 overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-150 ${
                      done
                        ? "bg-emerald-400"
                        : "bg-gradient-to-r from-amber-500 to-amber-300"
                    }"
                    style="width: ${pct}%"
                  ></div>
                </div>
                <div class="flex items-center justify-between text-[10px] font-mono-code text-slate-400">
                  <span>${formatBytes(loadedBytes)} / ${formatBytes(f.sizeBytes)}</span>
                  <span>${done ? "Synced" : "Uploading…"}</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderFilesGridView(files) {
  return `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      ${files
        .map((file) => {
          const fbCount = state.feedback.filter((fb) => fb.fileId === file.id).length;
          const isUploading =
            file.uploadStatus === "uploading" || file.uploadStatus === "complete";
          const pct = isUploading
            ? Math.min(100, Math.max(0, Number(file.uploadProgress) || 0))
            : 100;
          const isComplete = pct >= 100 || file.uploadStatus === "complete";
          const loadedBytes =
            file.uploadedBytes !== undefined
              ? file.uploadedBytes
              : Math.round((pct / 100) * (file.sizeBytes || 0));

          return `
            <div class="glass-card rounded-2xl overflow-hidden flex flex-col justify-between group">
              <!-- Media Preview Header -->
              <div
                data-preview-file="${escapeHtml(file.id)}"
                class="relative h-44 bg-slate-950/80 border-b border-white/[0.07] cursor-pointer overflow-hidden flex items-center justify-center"
              >
                ${
                  file.category === "IMAGE"
                    ? `<img src="${escapeHtml(file.posterUrl || file.url || "/sample-media/nordic-coast.svg")}" alt="${escapeHtml(
                        file.name
                      )}" onerror="this.onerror=null;this.src='/sample-media/nordic-coast.svg';" class="w-full h-full object-cover group-hover:scale-[1.02] transition duration-300" />`
                    : file.category === "VIDEO"
                    ? `<div class="w-full h-full relative flex items-center justify-center bg-slate-950">
                        ${
                          file.posterUrl
                            ? `<img src="${escapeHtml(file.posterUrl)}" alt="${escapeHtml(
                                file.name
                              )}" onerror="this.onerror=null;this.src='/sample-media/oslo-pavilion.svg';" class="w-full h-full object-cover opacity-75 group-hover:scale-[1.02] transition duration-300" />`
                            : file.url && !file.url.includes("studio-walkthrough.mp4")
                            ? `<video src="${escapeHtml(file.url)}" muted playsinline preload="metadata" class="w-full h-full object-cover opacity-75"></video>`
                            : `<img src="/sample-media/oslo-pavilion.svg" alt="" class="w-full h-full object-cover opacity-55" />`
                        }
                        <div class="absolute inset-0 flex items-center justify-center">
                          <div class="w-11 h-11 rounded-full bg-white/15 backdrop-blur-md border border-white/30 flex items-center justify-center text-white group-hover:scale-105 transition">
                            <i data-lucide="play" class="w-4 h-4 fill-current ml-0.5"></i>
                          </div>
                        </div>
                      </div>`
                    : isCodeFile(file.name, file.mimeType)
                    ? renderCodeCardThumbnail(file)
                    : `<div class="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-b from-slate-900/40 to-slate-950">
                        <div class="w-11 h-13 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-300 mb-2 p-2.5">
                          <i data-lucide="file-text" class="w-5 h-5"></i>
                        </div>
                        <span class="text-[11px] font-mono-code text-slate-400">${escapeHtml(
                          file.metaLabel || "Document"
                        )}</span>
                      </div>`
                }

                <div class="absolute top-2.5 left-2.5 flex items-center gap-1.5">
                  ${renderCategoryBadge(file.category, file.name)}
                </div>
                <div class="absolute top-2.5 right-2.5">
                  ${renderApprovalBadge(file.approvalStatus)}
                </div>

                <!-- Thumbnail Bottom Upload Progress Line Overlay -->
                <div
                  data-card-upload-overlay="${escapeHtml(file.id)}"
                  class="absolute inset-x-0 bottom-0 bg-slate-950/85 backdrop-blur-md px-3 pt-1.5 pb-2 border-t border-white/10 transition-opacity duration-300 ${
                    isUploading ? "opacity-100" : "opacity-0 pointer-events-none hidden"
                  }"
                >
                  <div class="flex items-center justify-between text-[10px] font-mono-code mb-1">
                    <span data-card-upload-label="${escapeHtml(file.id)}" class="${
            isComplete ? "text-emerald-300" : "text-amber-300"
          } font-medium">
                      ${isComplete ? "✓ Upload Complete" : "Uploading media…"}
                    </span>
                    <span data-card-upload-pct="${escapeHtml(
                      file.id
                    )}" class="text-white font-semibold">${pct}%</span>
                  </div>
                  <div class="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      data-card-upload-bar="${escapeHtml(file.id)}"
                      class="h-full rounded-full transition-all duration-150 ${
                        isComplete
                          ? "bg-emerald-400"
                          : "bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400"
                      }"
                      style="width: ${pct}%"
                    ></div>
                  </div>
                </div>
              </div>

              <!-- File Metadata & Actions -->
              <div class="p-3.5 space-y-3">
                <div>
                  <div
                    data-preview-file="${escapeHtml(file.id)}"
                    class="text-xs font-medium text-white truncate cursor-pointer hover:text-amber-300 transition"
                    title="${escapeHtml(file.name)}"
                  >
                    ${escapeHtml(file.name)}
                  </div>
                  <div class="flex items-center justify-between text-[11px] text-slate-400 font-mono-code mt-1">
                    <span>${formatBytes(file.sizeBytes)}</span>
                    <span>${escapeHtml(file.metaLabel || "")}</span>
                  </div>

                  <!-- Per-Media Card Body Upload Progress Line -->
                  <div
                    data-card-upload-wrap="${escapeHtml(file.id)}"
                    class="mt-2.5 pt-2 border-t border-white/[0.06] space-y-1.5 ${
                      isUploading ? "" : "hidden"
                    }"
                  >
                    <div class="flex items-center justify-between text-[10px] font-mono-code">
                      <span
                        data-card-upload-bytes="${escapeHtml(file.id)}"
                        class="text-slate-400"
                      >${formatBytes(loadedBytes)} / ${formatBytes(file.sizeBytes)}</span>
                      <span
                        data-card-upload-pct="${escapeHtml(file.id)}"
                        class="${
                          isComplete ? "text-emerald-300" : "text-amber-300"
                        } font-semibold"
                      >${isComplete ? "100% • Uploaded" : `${pct}%`}</span>
                    </div>
                    <div class="w-full h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                      <div
                        data-card-upload-bar="${escapeHtml(file.id)}"
                        class="h-full rounded-full transition-all duration-150 ${
                          isComplete
                            ? "bg-emerald-400"
                            : "bg-gradient-to-r from-amber-500 via-amber-400 to-emerald-400"
                        }"
                        style="width: ${pct}%"
                      ></div>
                    </div>
                  </div>
                </div>

                <div class="pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-1">
                  <button
                    data-share-file="${escapeHtml(file.id)}"
                    class="glass-button px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-200 hover:text-amber-300 inline-flex items-center gap-1.5"
                    title="Share File Link with Client"
                  >
                    <i data-lucide="link-2" class="w-3 h-3 text-amber-400"></i>
                    <span>Share Link</span>
                  </button>

                  <div class="flex items-center gap-1">
                    ${
                      fbCount > 0
                        ? `<button
                            data-preview-file="${escapeHtml(file.id)}"
                            class="px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono-code text-slate-300 inline-flex items-center gap-1"
                            title="${fbCount} Client Review Notes"
                          >
                            <i data-lucide="message-square" class="w-3 h-3 text-amber-400"></i>
                            ${fbCount}
                          </button>`
                        : ""
                    }
                    <button
                      data-star-file="${escapeHtml(file.id)}"
                      class="p-1 rounded hover:bg-white/10 ${
                        file.isStarred
                          ? "text-amber-400"
                          : "text-slate-500 hover:text-slate-300"
                      }"
                      title="Star File"
                    >
                      <i data-lucide="star" class="w-3.5 h-3.5 ${
                        file.isStarred ? "fill-current" : ""
                      }"></i>
                    </button>
                    <a
                      href="${escapeHtml(file.url)}"
                      download="${escapeHtml(file.name)}"
                      class="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-slate-200"
                      title="Download File"
                    >
                      <i data-lucide="download" class="w-3.5 h-3.5"></i>
                    </a>
                    <button
                      data-trash-file="${escapeHtml(file.id)}"
                      class="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-rose-400"
                      title="${file.isTrashed ? "Delete Permanently" : "Move to Trash"}"
                    >
                      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderFilesTableView(files) {
  return `
    <div class="glass-panel rounded-2xl overflow-hidden">
      <div class="overflow-x-auto w-full">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-white/[0.08] text-[11px] font-mono-code uppercase text-slate-400">
              <th class="py-3 px-3 sm:px-4">Deliverable Name</th>
              <th class="py-3 px-4 hidden sm:table-cell">Category</th>
              <th class="py-3 px-4 hidden md:table-cell">Client Status</th>
              <th class="py-3 px-4 hidden lg:table-cell">Size</th>
              <th class="py-3 px-3 sm:px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/[0.06] text-xs">
            ${files
              .map((file) => {
                const isUploading =
                  file.uploadStatus === "uploading" || file.uploadStatus === "complete";
                const pct = isUploading
                  ? Math.min(100, Math.max(0, Number(file.uploadProgress) || 0))
                  : 100;
                const isComplete = pct >= 100 || file.uploadStatus === "complete";

                return `
              <tr class="hover:bg-white/[0.03] transition">
                <td class="py-3 px-3 sm:px-4 max-w-[160px] sm:max-w-xs">
                  <div
                    data-preview-file="${escapeHtml(file.id)}"
                    class="font-medium text-white cursor-pointer hover:text-amber-300 truncate"
                  >
                    ${escapeHtml(file.name)}
                  </div>
                  <div class="text-[11px] text-slate-500 font-mono-code truncate">${escapeHtml(
                    file.metaLabel || ""
                  )}</div>
                  <div
                    data-card-upload-wrap="${escapeHtml(file.id)}"
                    class="mt-1.5 max-w-xs space-y-1 ${isUploading ? "" : "hidden"}"
                  >
                    <div class="flex items-center justify-between text-[10px] font-mono-code">
                      <span class="text-slate-400">${
                        isComplete ? "Uploaded" : "Uploading…"
                      }</span>
                      <span data-card-upload-pct="${escapeHtml(file.id)}" class="${
                  isComplete ? "text-emerald-300" : "text-amber-300"
                }">${pct}%</span>
                    </div>
                    <div class="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div
                        data-card-upload-bar="${escapeHtml(file.id)}"
                        class="h-full rounded-full transition-all duration-150 ${
                          isComplete ? "bg-emerald-400" : "bg-amber-400"
                        }"
                        style="width: ${pct}%"
                      ></div>
                    </div>
                  </div>
                </td>
                <td class="py-3 px-4 hidden sm:table-cell">${renderCategoryBadge(
                  file.category,
                  file.name
                )}</td>
                <td class="py-3 px-4 hidden md:table-cell">${renderApprovalBadge(
                  file.approvalStatus
                )}</td>
                <td class="py-3 px-4 hidden lg:table-cell font-mono-code text-slate-400">${formatBytes(
                  file.sizeBytes
                )}</td>
                <td class="py-3 px-3 sm:px-4 text-right whitespace-nowrap space-x-1 sm:space-x-1.5">
                  <button
                    data-share-file="${escapeHtml(file.id)}"
                    class="glass-button px-2 sm:px-2.5 py-1 rounded text-[11px] text-amber-300 inline-flex items-center gap-1"
                  >
                    <i data-lucide="share-2" class="w-3 h-3"></i>
                    <span class="hidden xs:inline sm:inline">Share</span>
                  </button>
                  <button
                    data-preview-file="${escapeHtml(file.id)}"
                    class="glass-button px-2 sm:px-2.5 py-1 rounded text-[11px] text-slate-200"
                  >
                    Preview
                  </button>
                </td>
              </tr>
            `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// CLIENT SHARE LINKS MANAGEMENT VIEW
// ============================================================================
function renderSharesManagementSection() {
  const origin = window.location.origin;
  const userShares = getUserShares();
  return `
    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-lg sm:text-xl font-semibold text-white">Client Share Links & Delivery Portals</h1>
          <p class="text-xs text-slate-400 mt-1">
            Every shared folder or file link below opens a clean, distraction-free Client Review Portal with download and approval controls.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4">
        ${
          userShares.length === 0
            ? `<div class="glass-panel rounded-2xl p-8 sm:p-10 text-center text-sm text-slate-400">
                No client share links created yet. Click "Share Folder Link" or "Share Link" on any item in your workspace.
              </div>`
            : userShares
                .map((s) => {
                  const shareUrl = `${origin}/share/${s.token}`;
                  return `
                    <div class="glass-panel rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 sm:gap-5">
                      <div class="space-y-2 max-w-2xl min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="px-2 py-0.5 rounded text-[10px] font-mono-code uppercase bg-amber-500/15 text-amber-300 border border-amber-500/25">
                            ${s.resourceType === "FOLDER" ? "FOLDER PORTAL" : "FILE LINK"}
                          </span>
                          <span class="text-xs font-mono-code text-slate-400 truncate max-w-full">Target: ${escapeHtml(
                            s.resourceName
                          )}</span>
                          ${
                            s.hasPassword
                              ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-white/10 text-slate-200">Passcode Protected</span>`
                              : ""
                          }
                        </div>

                        <div class="text-sm sm:text-base font-semibold text-white break-words">${escapeHtml(
                          s.title
                        )}</div>
                        ${
                          s.description
                            ? `<p class="text-xs text-slate-400">${escapeHtml(
                                s.description
                              )}</p>`
                            : ""
                        }

                        <div class="flex flex-wrap items-center gap-3 sm:gap-4 pt-1 text-xs font-mono-code text-slate-400">
                          <span>Views: <strong class="text-white">${
                            s.viewCount || 0
                          }</strong></span>
                          <span>Downloads: <strong class="text-white">${
                            s.downloadCount || 0
                          }</strong></span>
                          <span>Downloads Allowed: <strong class="${
                            s.allowDownload ? "text-emerald-400" : "text-amber-300"
                          }">${s.allowDownload ? "Yes" : "View-Only"}</strong></span>
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center gap-2 w-full lg:w-auto shrink-0">
                        <div class="glass-input px-3 py-2 rounded-lg text-xs font-mono-code text-slate-300 w-full sm:w-auto sm:max-w-[260px] truncate">
                          ${escapeHtml(shareUrl)}
                        </div>
                        <button
                          data-copy-share-url="${escapeHtml(shareUrl)}"
                          class="btn-studio-primary px-3.5 py-2 rounded-lg text-xs inline-flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
                        >
                          <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                          <span>Copy Link</span>
                        </button>
                        <button
                          data-open-share-portal="${escapeHtml(s.token)}"
                          class="glass-button px-3.5 py-2 rounded-lg text-xs font-medium text-amber-300 inline-flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
                        >
                          <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                          <span>Open Client View</span>
                        </button>
                        <button
                          data-delete-share="${escapeHtml(s.id)}"
                          class="glass-button p-2 rounded-lg text-slate-400 hover:text-rose-400 shrink-0"
                          title="Revoke Share Link"
                        >
                          <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join("")
        }
      </div>
    </div>
  `;
}

function renderReviewsSection(reviewedFiles) {
  const userFeedback = getUserFeedback();
  return `
    <div class="space-y-6">
      <div>
        <h1 class="text-lg sm:text-xl font-semibold text-white">Client Approvals & Revision Notes</h1>
        <p class="text-xs text-slate-400 mt-1">
          Real-time log of client sign-offs and revision requests submitted across your shared portals.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="lg:col-span-2 space-y-4">
          <h2 class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Deliverables with Client Status</h2>
          ${renderFilesGridView(reviewedFiles)}
        </div>

        <div class="space-y-3">
          <h2 class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Latest Client Feedback Stream</h2>
          ${userFeedback
            .map(
              (fb) => `
            <div class="glass-panel rounded-xl p-4 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-white">${escapeHtml(
                  fb.clientName
                )}</span>
                <span class="text-[11px] font-mono-code text-slate-500">${formatRelativeTime(
                  fb.createdAt
                )}</span>
              </div>
              <div class="text-xs font-mono-code text-amber-300 truncate">${escapeHtml(
                fb.fileName || ""
              )}</div>
              <div>${renderApprovalBadge(fb.status)}</div>
              ${
                fb.comment
                  ? `<p class="text-xs text-slate-300 leading-relaxed">${escapeHtml(
                      fb.comment
                    )}</p>`
                  : ""
              }
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// MODALS: NEW FOLDER, SHARE WITH CLIENT, STUDIO PREVIEW, FIREBASE SETTINGS
// ============================================================================
function renderNewFolderModal() {
  return `
    <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="glass-modal w-full max-w-md rounded-2xl p-5 sm:p-6 animate-modal">
        <div class="flex items-center justify-between mb-5">
          <h3 class="text-base font-semibold text-white">Create Studio Folder</h3>
          <button id="close-new-folder-modal" class="text-slate-400 hover:text-white">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <form id="new-folder-form" class="space-y-4">
          <div>
            <label class="block text-xs text-slate-300 mb-1.5">Folder Name</label>
            <input
              id="new-folder-name"
              type="text"
              required
              placeholder="e.g. 04 — Client Commercial Deliverables"
              class="glass-input w-full px-3.5 py-2.5 rounded-lg text-sm"
            />
          </div>

          <div>
            <label class="block text-xs text-slate-300 mb-1.5">Folder Tag Accent</label>
            <div class="grid grid-cols-6 gap-2">
              ${["amber", "emerald", "blue", "rose", "slate", "stone"]
                .map(
                  (col, idx) => `
                <label class="cursor-pointer">
                  <input type="radio" name="folder-color" value="${col}" ${
                    idx === 0 ? "checked" : ""
                  } class="peer hidden" />
                  <div class="peer-checked:ring-2 peer-checked:ring-white glass-button py-2 rounded-lg flex items-center justify-center">
                    <span class="w-3 h-3 rounded-full ${
                      getFolderColorStyles(col).dot
                    }"></span>
                  </div>
                </label>
              `
                )
                .join("")}
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 pt-2">
            <button type="button" id="cancel-new-folder" class="glass-button px-4 py-2 rounded-lg text-xs">Cancel</button>
            <button type="submit" class="btn-studio-primary px-4 py-2 rounded-lg text-xs">Create Folder</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderShareModal(target, createdShare) {
  const { resourceType, item } = target;
  const origin = window.location.origin;

  if (createdShare) {
    const shareUrl = `${origin}/share/${createdShare.token}`;
    return `
      <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
        <div class="glass-modal w-full max-w-lg rounded-2xl p-5 sm:p-6 animate-modal space-y-5">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                <i data-lucide="check" class="w-4 h-4"></i>
              </div>
              <div>
                <h3 class="text-sm sm:text-base font-semibold text-white">Client Portal Link Ready</h3>
                <p class="text-xs text-slate-400">Send this link to your client for instant viewing & approval.</p>
              </div>
            </div>
            <button id="close-share-modal" class="text-slate-400 hover:text-white shrink-0">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="glass-card rounded-xl p-4 space-y-3">
            <div class="text-xs font-mono-code text-amber-300 uppercase">${
              createdShare.resourceType === "FOLDER" ? "SHARED FOLDER LINK" : "SHARED FILE LINK"
            }</div>
            <div class="text-sm font-semibold text-white break-words">${escapeHtml(
              createdShare.title
            )}</div>
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                id="created-share-url-input"
                type="text"
                readonly
                value="${escapeHtml(shareUrl)}"
                class="glass-input flex-1 px-3 py-2 rounded-lg text-xs font-mono-code text-sky-300"
              />
              <button
                id="btn-copy-created-share"
                class="btn-studio-primary px-3.5 py-2 rounded-lg text-xs inline-flex items-center justify-center gap-1.5"
              >
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                <span>Copy</span>
              </button>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
            <button
              id="btn-open-created-portal"
              class="glass-button px-4 py-2 rounded-lg text-xs font-medium text-amber-300 inline-flex items-center gap-2"
            >
              <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
              <span>Preview Client View Now</span>
            </button>
            <button id="done-share-modal" class="glass-button px-4 py-2 rounded-lg text-xs">Done</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div class="glass-modal w-full max-w-lg rounded-2xl p-5 sm:p-6 animate-modal my-auto">
        <div class="flex items-center justify-between mb-5 pb-3 border-b border-white/[0.08] gap-2">
          <div class="min-w-0">
            <span class="text-[10px] font-mono-code uppercase tracking-wider text-amber-400">
              ${resourceType === "FOLDER" ? "Share Folder with Client" : "Share Deliverable File"}
            </span>
            <h3 class="text-sm sm:text-base font-semibold text-white mt-0.5 truncate">${escapeHtml(
              item.name
            )}</h3>
          </div>
          <button id="close-share-modal" class="text-slate-400 hover:text-white shrink-0">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <form id="create-share-form" class="space-y-4">
          <div>
            <label class="block text-xs text-slate-300 mb-1">Client Portal Title</label>
            <input
              id="share-title-input"
              type="text"
              required
              value="${escapeHtml(item.name)} — Client Review"
              class="glass-input w-full px-3.5 py-2 rounded-lg text-xs"
            />
          </div>

          <div>
            <label class="block text-xs text-slate-300 mb-1">Client Note / Review Instructions</label>
            <textarea
              id="share-desc-input"
              rows="2"
              placeholder="Optional instructions for your client (e.g. Please review and approve final selects)…"
              class="glass-input w-full px-3.5 py-2 rounded-lg text-xs resize-none"
            ></textarea>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="glass-card p-3 rounded-xl flex items-center justify-between cursor-pointer">
              <div>
                <div class="text-xs font-medium text-white">Allow Downloads</div>
                <div class="text-[11px] text-slate-400">Uncheck for View-Only</div>
              </div>
              <input id="share-allow-download" type="checkbox" checked class="accent-amber-400 w-4 h-4" />
            </label>

            <label class="glass-card p-3 rounded-xl flex items-center justify-between cursor-pointer">
              <div>
                <div class="text-xs font-medium text-white">Client Approvals</div>
                <div class="text-[11px] text-slate-400">Approve & revision notes</div>
              </div>
              <input id="share-allow-feedback" type="checkbox" checked class="accent-amber-400 w-4 h-4" />
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-slate-300 mb-1">Optional Passcode</label>
              <input
                id="share-password-input"
                type="text"
                placeholder="Leave blank for open link"
                class="glass-input w-full px-3 py-2 rounded-lg text-xs"
              />
            </div>
            <div>
              <label class="block text-xs text-slate-300 mb-1">Link Expiration</label>
              <select id="share-expiry-select" class="glass-input w-full px-3 py-2 rounded-lg text-xs bg-slate-900">
                <option value="30">Expires in 30 Days</option>
                <option value="7">Expires in 7 Days</option>
                <option value="0">Never Expires</option>
              </select>
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-white/[0.08]">
            <button type="button" id="cancel-share-modal" class="glass-button px-4 py-2 rounded-lg text-xs">Cancel</button>
            <button type="submit" class="btn-studio-primary px-4 py-2 rounded-lg text-xs inline-flex items-center gap-1.5">
              <i data-lucide="link-2" class="w-3.5 h-3.5"></i>
              <span>Generate Client Link</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderStudioPreviewModal(file) {
  const fileFeedback = state.feedback.filter((fb) => fb.fileId === file.id);

  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 lg:p-8">
      <div class="glass-modal w-full max-w-6xl h-[92dvh] lg:h-[85vh] rounded-2xl overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row animate-modal">
        <!-- Left Media Stage -->
        <div class="flex-1 bg-slate-950/90 flex flex-col min-h-[260px] sm:min-h-[360px] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <div class="px-3.5 sm:px-5 py-3 sm:py-3.5 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-2 sm:gap-4">
            <div class="flex items-center gap-2 min-w-0">
              ${renderCategoryBadge(file.category, file.name)}
              <span class="text-xs sm:text-sm font-medium text-white truncate max-w-[160px] sm:max-w-xs">${escapeHtml(
                file.name
              )}</span>
            </div>
            <div class="flex items-center gap-1.5 sm:gap-2">
              <button
                id="preview-share-file-btn"
                class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 inline-flex items-center gap-1.5"
              >
                <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
                <span class="hidden sm:inline">Share with Client</span>
              </button>
              <a
                href="${escapeHtml(file.url)}"
                download="${escapeHtml(file.name)}"
                class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
              >
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
                <span class="hidden sm:inline">Download</span>
              </a>
              <button id="close-preview-modal" class="glass-button p-1.5 rounded-lg text-slate-400 hover:text-white">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <div class="flex-1 flex items-center justify-center p-3 sm:p-6 overflow-auto min-h-[220px]">
            ${
              file.category === "IMAGE"
                ? `<img src="${escapeHtml(file.url || file.posterUrl || "/sample-media/nordic-coast.svg")}" alt="${escapeHtml(
                    file.name
                  )}" onerror="this.onerror=null;this.src='/sample-media/nordic-coast.svg';" class="max-w-full max-h-[55vh] lg:max-h-full object-contain rounded-lg shadow-2xl" />`
                : file.category === "VIDEO"
                ? (file.url || "").includes("studio-walkthrough.mp4")
                  ? `<div class="w-full max-w-3xl space-y-3">
                      <canvas id="studio-cinema-canvas" width="960" height="540" class="w-full rounded-xl border border-white/10 shadow-2xl bg-black"></canvas>
                      <div class="glass-panel px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl flex items-center gap-3 sm:gap-4">
                        <button id="studio-cinema-play" type="button" class="btn-studio-primary px-3 py-1 rounded text-xs">Pause</button>
                        <input id="studio-cinema-scrubber" type="range" min="0" max="100" value="0" class="flex-1 accent-amber-400 cursor-pointer" />
                        <span id="studio-cinema-time" class="text-[11px] sm:text-xs font-mono-code text-slate-300">00:00:00 / 00:12:00</span>
                      </div>
                    </div>`
                  : `<video src="${escapeHtml(
                      file.url || ""
                    )}" poster="${escapeHtml(file.posterUrl || "")}" controls autoplay class="max-w-full max-h-[55vh] lg:max-h-full rounded-xl border border-white/10 shadow-2xl"></video>`
                : isHtmlFile(file.name)
                ? `
                  <div class="w-full h-full flex flex-col space-y-2.5">
                    <div class="flex items-center justify-between px-1 shrink-0">
                      <div class="inline-flex rounded-lg bg-black/50 border border-white/10 p-0.5 text-xs font-mono-code">
                        <button id="btn-html-view-render" type="button" class="px-2.5 py-1 rounded-md transition ${state.codePreviewMode === 'code' ? 'text-slate-400 hover:text-white' : 'bg-white/15 text-white font-medium border border-white/10'}">
                          <span class="inline-flex items-center gap-1.5"><i data-lucide="eye" class="w-3.5 h-3.5 text-amber-400"></i> Rendered View</span>
                        </button>
                        <button id="btn-html-view-code" type="button" class="px-2.5 py-1 rounded-md transition ${state.codePreviewMode === 'code' ? 'bg-white/15 text-white font-medium border border-white/10' : 'text-slate-400 hover:text-white'}">
                          <span class="inline-flex items-center gap-1.5"><i data-lucide="code-2" class="w-3.5 h-3.5 text-emerald-400"></i> Source Code</span>
                        </button>
                      </div>
                      <span class="text-[11px] font-mono-code text-slate-400">HTML Deliverable</span>
                    </div>
                    <div class="flex-1 min-h-0">
                      ${
                        state.codePreviewMode === "code"
                          ? renderCodeViewerContainer(file)
                          : `<iframe src="${escapeHtml(file.url || "")}" class="w-full h-[50vh] lg:h-full rounded-xl border border-white/10 bg-white"></iframe>`
                      }
                    </div>
                  </div>
                `
                : isCodeFile(file.name, file.mimeType)
                ? renderCodeViewerContainer(file)
                : `<iframe src="${escapeHtml(
                    file.url || ""
                  )}" class="w-full h-[50vh] lg:h-full rounded-xl border border-white/10 bg-white"></iframe>`
            }
          </div>
        </div>

        <!-- Right Deliverable Inspector & Client Feedback -->
        <div class="w-full lg:w-96 flex flex-col bg-slate-950/60 min-h-0">
          <div class="p-4 sm:p-5 border-b border-white/[0.08] space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-mono-code uppercase text-slate-400">Client Review Status</span>
              ${renderApprovalBadge(file.approvalStatus)}
            </div>
            <div class="grid grid-cols-2 gap-2 text-xs font-mono-code">
              <div class="glass-card p-2.5 rounded-lg">
                <div class="text-[10px] text-slate-500">FILE SIZE</div>
                <div class="text-slate-200 mt-0.5">${formatBytes(file.sizeBytes)}</div>
              </div>
              <div class="glass-card p-2.5 rounded-lg">
                <div class="text-[10px] text-slate-500">STORAGE</div>
                <div class="text-emerald-400 mt-0.5 uppercase">CLOUD VAULT</div>
              </div>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
            <div class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Client Revision Notes (${
              fileFeedback.length
            })</div>
            ${
              fileFeedback.length === 0
                ? `<div class="glass-card rounded-xl p-4 text-xs text-slate-400">
                    No client comments yet. Share this file or its folder with your client to collect approvals.
                  </div>`
                : fileFeedback
                    .map(
                      (fb) => `
                  <div class="glass-card rounded-xl p-3.5 space-y-1.5">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-semibold text-white">${escapeHtml(
                        fb.clientName
                      )}</span>
                      <span class="text-[11px] font-mono-code text-slate-500">${formatRelativeTime(
                        fb.createdAt
                      )}</span>
                    </div>
                    <div>${renderApprovalBadge(fb.status)}</div>
                    <p class="text-xs text-slate-300 leading-relaxed">${escapeHtml(
                      fb.comment
                    )}</p>
                  </div>
                `
                    )
                    .join("")
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFirebaseConfigModal() {
  const cfg = getSavedFirebaseConfig() || {};
  return `
    <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="glass-modal w-full max-w-lg rounded-2xl p-6 animate-modal space-y-4">
        <div class="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div>
            <span class="text-[10px] font-mono-code uppercase text-amber-400">Cloud Storage & Google OAuth</span>
            <h3 class="text-base font-semibold text-white">Firebase 5 GB Free Tier Configuration</h3>
          </div>
          <button id="close-fb-config-modal" class="text-slate-400 hover:text-white">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <p class="text-xs text-slate-400 leading-relaxed">
          Paste your Firebase Web App credentials below (or in <code class="text-slate-200 font-mono-code">.env.local</code>) to connect live Firebase Google OAuth and your 5 GB Firebase Cloud Storage bucket. When blank, Tech Titans automatically runs in Hybrid Local Storage mode.
        </p>

        <form id="firebase-config-form" class="space-y-3">
          <div>
            <label class="block text-[11px] text-slate-300 mb-1">Firebase API Key</label>
            <input id="fb-api-key" type="text" value="${escapeHtml(
              cfg.apiKey || ""
            )}" placeholder="AIzaSy..." class="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono-code" />
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-[11px] text-slate-300 mb-1">Project ID</label>
              <input id="fb-project-id" type="text" value="${escapeHtml(
                cfg.projectId || ""
              )}" placeholder="my-studio-vault" class="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono-code" />
            </div>
            <div>
              <label class="block text-[11px] text-slate-300 mb-1">Storage Bucket</label>
              <input id="fb-storage-bucket" type="text" value="${escapeHtml(
                cfg.storageBucket || ""
              )}" placeholder="my-studio-vault.firebasestorage.app" class="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono-code" />
            </div>
          </div>
          <div>
            <label class="block text-[11px] text-slate-300 mb-1">Auth Domain (Optional)</label>
            <input id="fb-auth-domain" type="text" value="${escapeHtml(
              cfg.authDomain || ""
            )}" placeholder="my-studio-vault.firebaseapp.com" class="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono-code" />
          </div>

          <div class="flex items-center justify-between pt-3 border-t border-white/[0.08]">
            <button type="button" id="reset-fb-config" class="glass-button px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white">
              Use Local Hybrid Mode
            </button>
            <button type="submit" class="btn-studio-primary px-4 py-2 rounded-lg text-xs">
              Save Firebase Config
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function bindFirebaseConfigModalEvents(rerenderFn) {
  document.getElementById("close-fb-config-modal")?.addEventListener("click", () => {
    state.showFirebaseModal = false;
    rerenderFn();
  });

  document.getElementById("reset-fb-config")?.addEventListener("click", () => {
    saveCustomFirebaseConfig(null);
    state.firebaseConnected = false;
    state.showFirebaseModal = false;
    showToast("Switched to Local Hybrid Storage Mode", "info");
    rerenderFn();
  });

  document.getElementById("firebase-config-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const apiKey = document.getElementById("fb-api-key").value.trim();
    const projectId = document.getElementById("fb-project-id").value.trim();
    const storageBucket = document.getElementById("fb-storage-bucket").value.trim();
    const authDomain =
      document.getElementById("fb-auth-domain").value.trim() ||
      (projectId ? `${projectId}.firebaseapp.com` : "");

    if (!apiKey || !projectId) {
      showToast("Please provide both API Key and Project ID", "error");
      return;
    }

    saveCustomFirebaseConfig({ apiKey, projectId, storageBucket, authDomain });
    state.firebaseConnected = true;
    state.showFirebaseModal = false;
    showToast("Firebase Cloud configuration saved", "success");
    rerenderFn();
  });
}

// ============================================================================
// DASHBOARD INTERACTION BINDINGS
// ============================================================================
function bindDashboardEvents() {
  // Mobile & Tablet Drawer Toggle Controls
  document.getElementById("btn-mobile-sidebar-toggle")?.addEventListener("click", () => {
    state.mobileSidebarOpen = true;
    renderDashboard();
  });

  document.getElementById("btn-close-mobile-sidebar")?.addEventListener("click", () => {
    state.mobileSidebarOpen = false;
    renderDashboard();
  });

  document.getElementById("mobile-sidebar-backdrop")?.addEventListener("click", () => {
    state.mobileSidebarOpen = false;
    renderDashboard();
  });

  // Sidebar & Quick-Filter navigation
  rootEl.querySelectorAll("[data-nav-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeNav = btn.getAttribute("data-nav-item");
      state.mobileSidebarOpen = false;
      if (state.activeNav !== "ALL") {
        state.currentFolderId = null;
      }
      renderDashboard();
    });
  });

  // Breadcrumb navigation
  document.getElementById("breadcrumb-root")?.addEventListener("click", () => {
    state.activeNav = "ALL";
    state.currentFolderId = null;
    state.mobileSidebarOpen = false;
    renderDashboard();
  });

  rootEl.querySelectorAll("[data-breadcrumb-folder]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeNav = "ALL";
      state.currentFolderId = btn.getAttribute("data-breadcrumb-folder");
      state.mobileSidebarOpen = false;
      renderDashboard();
    });
  });

  // Search Input
  const searchInput = document.getElementById("workspace-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderDashboard();
      const refocused = document.getElementById("workspace-search-input");
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(
          refocused.value.length,
          refocused.value.length
        );
      }
    });
  }

  // View Mode Toggle
  rootEl.querySelectorAll("[data-view-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.viewMode = btn.getAttribute("data-view-mode");
      renderDashboard();
    });
  });

  // Sign Out
  document.getElementById("btn-signout-google")?.addEventListener("click", async () => {
    state.mobileSidebarOpen = false;
    await signOutGoogleUser();
    state.user = null;
    showToast("Signed out of Google Workspace", "info");
    navigateTo("/login");
  });

  // Open Firebase Config
  document.getElementById("open-fb-settings")?.addEventListener("click", () => {
    state.showFirebaseModal = true;
    renderDashboard();
  });
  bindFirebaseConfigModalEvents(renderDashboard);

  // Trigger File Upload Picker
  const triggerUploadPicker = () => {
    state.mobileSidebarOpen = false;
    if (globalFileInput) {
      globalFileInput.value = "";
      globalFileInput.click();
    }
  };
  document
    .getElementById("sidebar-upload-btn")
    ?.addEventListener("click", triggerUploadPicker);
  document
    .getElementById("header-upload-btn")
    ?.addEventListener("click", triggerUploadPicker);
  document
    .getElementById("inline-upload-dropzone")
    ?.addEventListener("click", triggerUploadPicker);

  // Trigger Folder Upload Picker
  document
    .getElementById("header-upload-folder-btn")
    ?.addEventListener("click", () => {
      if (globalFolderInput) {
        globalFolderInput.value = "";
        globalFolderInput.click();
      }
    });

  // Drag & Drop File Upload on Workspace
  const dropzone = document.getElementById("dashboard-dropzone");
  if (dropzone) {
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      document
        .getElementById("inline-upload-dropzone")
        ?.classList.add("dropzone-active");
    });
    dropzone.addEventListener("dragleave", () => {
      document
        .getElementById("inline-upload-dropzone")
        ?.classList.remove("dropzone-active");
    });
    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      document
        .getElementById("inline-upload-dropzone")
        ?.classList.remove("dropzone-active");
      if (e.dataTransfer?.files?.length) {
        await handleFilesBatchUpload(Array.from(e.dataTransfer.files));
      }
    });
  }

  // Open Folder
  rootEl.querySelectorAll("[data-open-folder]").forEach((card) => {
    card.addEventListener("click", () => {
      state.activeNav = "ALL";
      state.currentFolderId = card.getAttribute("data-open-folder");
      renderDashboard();
    });
  });

  // Star / Trash Folder (Instant Optimistic Update)
  rootEl.querySelectorAll("[data-star-folder]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-star-folder");
      const target = state.folders.find((f) => f.id === id);
      if (!target) return;
      target.isStarred = !target.isStarred;
      saveWorkspaceCache();
      renderDashboard();
      fetch(`/api/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: target.isStarred }),
      }).catch(() => {});
    });
  });

  rootEl.querySelectorAll("[data-trash-folder]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-trash-folder");
      const target = state.folders.find((f) => f.id === id);
      if (!target) return;
      if (target.isTrashed) {
        state.folders = state.folders.filter((f) => f.id !== id);
        state.files = state.files.filter((f) => f.folderId !== id);
        saveWorkspaceCache();
        renderDashboard();
        showToast("Folder permanently deleted", "info");
        fetch(`/api/folders/${id}`, { method: "DELETE" }).catch(() => {});
      } else {
        target.isTrashed = true;
        saveWorkspaceCache();
        renderDashboard();
        showToast("Folder moved to Trash", "info");
        fetch(`/api/folders/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isTrashed: true }),
        }).catch(() => {});
      }
    });
  });

  // Share Folder
  rootEl.querySelectorAll("[data-share-folder]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-share-folder");
      const folder = state.folders.find((f) => f.id === id);
      if (folder) {
        state.shareTarget = { resourceType: "FOLDER", item: folder };
        state.createdShareResult = null;
        renderDashboard();
      }
    });
  });

  document
    .getElementById("header-share-current-folder")
    ?.addEventListener("click", () => {
      const folder = state.folders.find((f) => f.id === state.currentFolderId);
      if (folder) {
        state.shareTarget = { resourceType: "FOLDER", item: folder };
        state.createdShareResult = null;
        renderDashboard();
      }
    });

  // Share File
  rootEl.querySelectorAll("[data-share-file]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-share-file");
      const file = state.files.find((f) => f.id === id);
      if (file) {
        state.shareTarget = { resourceType: "FILE", item: file };
        state.createdShareResult = null;
        renderDashboard();
      }
    });
  });

  // Star / Trash File (Instant Optimistic Update)
  rootEl.querySelectorAll("[data-star-file]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-star-file");
      const file = state.files.find((f) => f.id === id);
      if (!file) return;
      file.isStarred = !file.isStarred;
      saveWorkspaceCache();
      renderDashboard();
      fetch(`/api/files/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: file.isStarred }),
      }).catch(() => {});
    });
  });

  rootEl.querySelectorAll("[data-trash-file]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-trash-file");
      const file = state.files.find((f) => f.id === id);
      if (!file) return;
      if (file.isTrashed) {
        state.files = state.files.filter((f) => f.id !== id);
        saveWorkspaceCache();
        renderDashboard();
        showToast("File permanently deleted", "info");
        fetch(`/api/files/${id}`, { method: "DELETE" }).catch(() => {});
      } else {
        file.isTrashed = true;
        saveWorkspaceCache();
        renderDashboard();
        showToast("File moved to Trash", "info");
        fetch(`/api/files/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isTrashed: true }),
        }).catch(() => {});
      }
    });
  });

  // Preview File Modal
  rootEl.querySelectorAll("[data-preview-file]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.getAttribute("data-preview-file");
      const file = state.files.find((f) => f.id === id);
      if (file) {
        state.previewFile = file;
        if (isCodeFile(file.name, file.mimeType)) {
          state.codePreviewMode = isHtmlFile(file.name) ? "render" : "code";
        }
        renderDashboard();
      }
    });
  });

  if (state.previewFile) {
    document.getElementById("close-preview-modal")?.addEventListener("click", () => {
      state.previewFile = null;
      renderDashboard();
    });
    document
      .getElementById("preview-share-file-btn")
      ?.addEventListener("click", () => {
        const targetFile = state.previewFile;
        state.previewFile = null;
        state.shareTarget = { resourceType: "FILE", item: targetFile };
        state.createdShareResult = null;
        renderDashboard();
      });

    if (
      state.previewFile.category === "VIDEO" &&
      state.previewFile.url.includes("studio-walkthrough.mp4")
    ) {
      cleanupPreviewVideo = mountSampleCinemaCanvas(
        document.getElementById("studio-cinema-canvas"),
        document.getElementById("studio-cinema-time"),
        document.getElementById("studio-cinema-scrubber"),
        document.getElementById("studio-cinema-play")
      );
    }

    if (isCodeFile(state.previewFile.name, state.previewFile.mimeType)) {
      if (!isHtmlFile(state.previewFile.name) || state.codePreviewMode === "code") {
        const bodyEl = document.getElementById("code-viewer-body");
        const statsEl = document.getElementById("code-viewer-stats");
        const copyBtn = document.getElementById("btn-copy-code");
        if (bodyEl) {
          fetchAndRenderCodePreview(state.previewFile, bodyEl, statsEl, copyBtn);
        }
      }
    }

    document.getElementById("btn-html-view-render")?.addEventListener("click", () => {
      state.codePreviewMode = "render";
      renderDashboard();
    });
    document.getElementById("btn-html-view-code")?.addEventListener("click", () => {
      state.codePreviewMode = "code";
      renderDashboard();
    });
  }

  // New Folder Modal Events (Instant 0ms Folder Creation)
  document.getElementById("header-new-folder-btn")?.addEventListener("click", () => {
    state.showNewFolderModal = true;
    renderDashboard();
    document.getElementById("new-folder-name")?.focus();
  });

  document.getElementById("close-new-folder-modal")?.addEventListener("click", () => {
    state.showNewFolderModal = false;
    renderDashboard();
  });
  document.getElementById("cancel-new-folder")?.addEventListener("click", () => {
    state.showNewFolderModal = false;
    renderDashboard();
  });

  document.getElementById("new-folder-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("new-folder-name").value.trim();
    const colorEl = document.querySelector('input[name="folder-color"]:checked');
    const color = colorEl ? colorEl.value : "amber";
    if (!name) return;

    const now = new Date().toISOString();
    const newFolder = {
      id: `fld-${Math.random().toString(36).slice(2, 11)}`,
      name,
      parentId: state.currentFolderId,
      color,
      ownerId: getPrimaryUserOwnerId(),
      isStarred: false,
      isTrashed: false,
      createdAt: now,
      updatedAt: now,
    };

    state.folders.unshift(newFolder);
    state.showNewFolderModal = false;
    saveWorkspaceCache();
    renderDashboard();
    showToast(`Created folder "${name}"`, "success");

    // Background sync
    fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newFolder),
    }).catch(() => {});
  });

  // Share Modal Events
  const closeShareModal = () => {
    state.shareTarget = null;
    state.createdShareResult = null;
    renderDashboard();
  };
  document
    .getElementById("close-share-modal")
    ?.addEventListener("click", closeShareModal);
  document
    .getElementById("cancel-share-modal")
    ?.addEventListener("click", closeShareModal);
  document
    .getElementById("done-share-modal")
    ?.addEventListener("click", closeShareModal);

  document.getElementById("create-share-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { resourceType, item } = state.shareTarget;
    const title = document.getElementById("share-title-input").value.trim();
    const description = document.getElementById("share-desc-input").value.trim();
    const allowDownload = document.getElementById("share-allow-download").checked;
    const allowFeedback = document.getElementById("share-allow-feedback").checked;
    const password = document.getElementById("share-password-input").value.trim();
    const expiresInDays = Number(
      document.getElementById("share-expiry-select").value
    );

    const now = new Date();
    const slugBase = (title || item.name || "client-portal")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const shortHash = Math.random().toString(36).slice(2, 8);
    const token = `${slugBase}-${shortHash}`;

    let expiresAt = null;
    if (expiresInDays > 0) {
      expiresAt = new Date(now.getTime() + expiresInDays * 86400000).toISOString();
    }

    const ownerId = getPrimaryUserOwnerId();
    const optimisticShare = {
      id: `shr-${Math.random().toString(36).slice(2, 11)}`,
      token,
      title: title || item.name || "Client Delivery",
      description,
      resourceType,
      folderId: resourceType === "FOLDER" ? item.id : null,
      fileId: resourceType === "FILE" ? item.id : null,
      resourceName: item.name,
      ownerId,
      ownerName: state.user?.displayName || "Studio Director",
      studioName: state.user?.studioName || "Tech Titans",
      allowDownload,
      allowFeedback,
      password: password || null,
      hasPassword: Boolean(password),
      expiresAt,
      viewCount: 0,
      downloadCount: 0,
      isActive: true,
      createdAt: now.toISOString(),
    };

    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: optimisticShare.id,
          token: optimisticShare.token,
          title,
          description,
          resourceType,
          folderId: resourceType === "FOLDER" ? item.id : null,
          fileId: resourceType === "FILE" ? item.id : null,
          resourceName: item.name,
          ownerId,
          ownerName: state.user?.displayName || "Studio Director",
          studioName: state.user?.studioName || "Tech Titans",
          allowDownload,
          allowFeedback,
          password: password || null,
          expiresInDays,
        }),
      });
      const data = await res.json();
      if (res.ok && data.share) {
        data.share.ownerId = ownerId;
        state.shares.unshift(data.share);
        state.createdShareResult = data.share;
      } else {
        state.shares.unshift(optimisticShare);
        state.createdShareResult = optimisticShare;
      }
    } catch {
      state.shares.unshift(optimisticShare);
      state.createdShareResult = optimisticShare;
    }

    saveWorkspaceCache();
    showToast("Client Share Link generated & synced", "success");
    renderDashboard();
  });

  document.getElementById("btn-copy-created-share")?.addEventListener("click", () => {
    const val = document.getElementById("created-share-url-input")?.value;
    if (val) {
      navigator.clipboard.writeText(val);
      showToast("Client link copied to clipboard", "success");
    }
  });

  document.getElementById("btn-open-created-portal")?.addEventListener("click", () => {
    if (state.createdShareResult?.token) {
      const tok = state.createdShareResult.token;
      state.shareTarget = null;
      state.createdShareResult = null;
      renderDashboard();
      openClientShareInNewTab(tok);
    }
  });

  // Quick Copy Share URL on Folder Cards & Active Share Banner
  rootEl.querySelectorAll("[data-copy-folder-share]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = btn.getAttribute("data-copy-folder-share");
      if (url) {
        navigator.clipboard.writeText(url);
        showToast("Client folder share link copied to clipboard", "success");
      }
    });
  });

  // Shares Management Tab Actions
  rootEl.querySelectorAll("[data-copy-share-url]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.getAttribute("data-copy-share-url");
      navigator.clipboard.writeText(url);
      showToast("Client link copied to clipboard", "success");
    });
  });

  rootEl.querySelectorAll("[data-open-share-portal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tok = btn.getAttribute("data-open-share-portal");
      openClientShareInNewTab(tok);
    });
  });

  rootEl.querySelectorAll("[data-delete-share]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = btn.getAttribute("data-delete-share");
      state.shares = state.shares.filter((s) => s.id !== id);
      saveWorkspaceCache();
      renderDashboard();
      showToast("Client share link revoked", "info");
      fetch(`/api/shares/${id}`, { method: "DELETE" }).catch(() => {});
    });
  });
}

function isFolderInsideSharedHierarchy(folderId) {
  if (!folderId) return false;
  const activeFolderShareIds = new Set(
    getUserShares()
      .filter((s) => s.resourceType === "FOLDER" && s.isActive !== false && s.folderId)
      .map((s) => s.folderId)
  );
  if (activeFolderShareIds.size === 0) return false;
  let ptrId = folderId;
  const visited = new Set();
  while (ptrId && !visited.has(ptrId)) {
    if (activeFolderShareIds.has(ptrId)) return true;
    visited.add(ptrId);
    const fld = state.folders.find((f) => f.id === ptrId);
    ptrId = fld ? fld.parentId : null;
  }
  return false;
}

// ============================================================================
// LIVE PER-MEDIA UPLOAD PROGRESS DOM UPDATER & UPLOAD HANDLERS
// ============================================================================
function updateUploadProgressDOM(file) {
  if (!file || !file.id) return;
  const fid = file.id;
  const isUploading =
    file.uploadStatus === "uploading" || file.uploadStatus === "complete";
  const pct = isUploading
    ? Math.min(100, Math.max(0, Number(file.uploadProgress) || 0))
    : 100;
  const isComplete = pct >= 100 || file.uploadStatus === "complete";
  const loadedBytes =
    file.uploadedBytes !== undefined
      ? file.uploadedBytes
      : Math.round((pct / 100) * (file.sizeBytes || 0));

  // 1. Update card progress bars
  rootEl.querySelectorAll(`[data-card-upload-bar="${fid}"]`).forEach((bar) => {
    bar.style.width = `${pct}%`;
    if (isComplete) {
      bar.className =
        "h-full rounded-full transition-all duration-150 bg-emerald-400";
    }
  });

  // 2. Update card percentage labels
  rootEl.querySelectorAll(`[data-card-upload-pct="${fid}"]`).forEach((lbl) => {
    const isOverlayPct = lbl.closest(`[data-card-upload-overlay="${fid}"]`);
    lbl.textContent = isOverlayPct
      ? `${pct}%`
      : isComplete
      ? "100% • Uploaded"
      : `${pct}%`;
    if (!isOverlayPct) {
      lbl.className = `${
        isComplete ? "text-emerald-300" : "text-amber-300"
      } font-semibold`;
    }
  });

  // 3. Update card overlay status text
  rootEl.querySelectorAll(`[data-card-upload-label="${fid}"]`).forEach((lbl) => {
    lbl.textContent = isComplete ? "✓ Upload Complete" : "Uploading media…";
    lbl.className = `${
      isComplete ? "text-emerald-300" : "text-amber-300"
    } font-medium`;
  });

  // 4. Update card uploaded bytes text
  rootEl.querySelectorAll(`[data-card-upload-bytes="${fid}"]`).forEach((el) => {
    el.textContent = `${formatBytes(loadedBytes)} / ${formatBytes(file.sizeBytes)}`;
  });

  // 5. Show/hide card upload progress wrappers when finished
  rootEl.querySelectorAll(`[data-card-upload-overlay="${fid}"]`).forEach((ov) => {
    if (isUploading) {
      ov.classList.remove("opacity-0", "pointer-events-none", "hidden");
      ov.classList.add("opacity-100");
    } else {
      ov.classList.add("opacity-0", "pointer-events-none", "hidden");
      ov.classList.remove("opacity-100");
    }
  });

  rootEl.querySelectorAll(`[data-card-upload-wrap="${fid}"]`).forEach((wrap) => {
    if (isUploading) {
      wrap.classList.remove("hidden");
    } else {
      wrap.classList.add("hidden");
    }
  });

  // 6. Refresh the top Active Upload Queue Panel
  const queueSlot = document.getElementById("active-upload-queue-slot");
  if (queueSlot) {
    queueSlot.innerHTML = renderActiveUploadQueueHTML();
  }
}

function getCurrentUserUsedBytes() {
  return getUserFiles()
    .filter((f) => !f.isTrashed)
    .reduce((acc, f) => acc + (Number(f.sizeBytes) || 0), 0);
}

async function handleFilesBatchUpload(fileList) {
  if (!fileList || fileList.length === 0) return;

  const incomingBytes = fileList.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
  if (getCurrentUserUsedBytes() + incomingBytes > FIVE_GB) {
    showToast("Upload exceeds your 5.0 GB Free Cloud Storage quota for this account", "error");
    return;
  }

  const ownerId = getPrimaryUserOwnerId();
  const addedFiles = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const existingIdx = state.files.findIndex(
      (f) =>
        !f.isTrashed &&
        belongsToCurrentUser(f) &&
        (f.folderId || null) === (state.currentFolderId || null) &&
        f.name === file.name
    );
    const existingFile = existingIdx >= 0 ? state.files[existingIdx] : null;

    const instantItem = await uploadMediaFile(file, {
      existingId: existingFile?.id || null,
      folderId: state.currentFolderId,
      ownerId,
      onProgress: (updatedFile) => {
        updateUploadProgressDOM(updatedFile);
      },
      onSynced: () => {
        saveWorkspaceCache();
      },
    });

    if (existingFile) {
      instantItem.approvalStatus = existingFile.approvalStatus || "PENDING";
      instantItem.isStarred = Boolean(existingFile.isStarred);
      state.files[existingIdx] = instantItem;
    } else {
      state.files.unshift(instantItem);
    }
    addedFiles.push(instantItem);
  }

  saveWorkspaceCache();
  renderDashboard();
  const isShared = isFolderInsideSharedHierarchy(state.currentFolderId);
  const baseMsg =
    addedFiles.length === 1
      ? `Uploading ${addedFiles[0].name}`
      : `Uploading ${addedFiles.length} media files`;
  showToast(
    isShared ? `${baseMsg} • Live syncing to Client Portal` : baseMsg,
    "success"
  );
}

async function handleFolderBatchUpload(fileList) {
  if (!fileList || fileList.length === 0) return;

  const incomingBytes = fileList.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
  if (getCurrentUserUsedBytes() + incomingBytes > FIVE_GB) {
    showToast("Folder upload exceeds your 5.0 GB Free Cloud Storage quota for this account", "error");
    return;
  }

  const ownerId = getPrimaryUserOwnerId();
  const now = new Date().toISOString();
  const folderPathMap = new Map(); // relativeFolderPath -> folderId

  const getOrCreateFolderId = (segments) => {
    let parentId = state.currentFolderId || null;
    let currentKey = "";
    for (const seg of segments) {
      currentKey = currentKey ? `${currentKey}/${seg}` : seg;
      if (folderPathMap.has(currentKey)) {
        parentId = folderPathMap.get(currentKey);
      } else {
        const existingFolder = state.folders.find(
          (f) =>
            !f.isTrashed &&
            belongsToCurrentUser(f) &&
            (f.parentId || null) === (parentId || null) &&
            f.name.toLowerCase() === seg.toLowerCase()
        );
        if (existingFolder) {
          folderPathMap.set(currentKey, existingFolder.id);
          parentId = existingFolder.id;
        } else {
          const newFolder = {
            id: `fld-${Math.random().toString(36).slice(2, 11)}`,
            name: seg,
            parentId,
            color: "amber",
            ownerId,
            isStarred: false,
            isTrashed: false,
            createdAt: now,
            updatedAt: now,
          };
          state.folders.unshift(newFolder);
          folderPathMap.set(currentKey, newFolder.id);
          parentId = newFolder.id;

          // Background sync
          fetch("/api/folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newFolder),
          }).catch(() => {});
        }
      }
    }
    return parentId;
  };

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/").filter(Boolean);
    const folderSegments = parts.length > 1 ? parts.slice(0, -1) : [];
    const targetFolderId =
      folderSegments.length > 0
        ? getOrCreateFolderId(folderSegments)
        : state.currentFolderId;

    const existingIdx = state.files.findIndex(
      (f) =>
        !f.isTrashed &&
        belongsToCurrentUser(f) &&
        (f.folderId || null) === (targetFolderId || null) &&
        f.name === file.name
    );
    const existingFile = existingIdx >= 0 ? state.files[existingIdx] : null;

    const instantItem = await uploadMediaFile(file, {
      existingId: existingFile?.id || null,
      folderId: targetFolderId,
      ownerId,
      onProgress: (updatedFile) => {
        updateUploadProgressDOM(updatedFile);
      },
      onSynced: () => {
        saveWorkspaceCache();
      },
    });

    if (existingFile) {
      instantItem.approvalStatus = existingFile.approvalStatus || "PENDING";
      instantItem.isStarred = Boolean(existingFile.isStarred);
      state.files[existingIdx] = instantItem;
    } else {
      state.files.unshift(instantItem);
    }
  }

  saveWorkspaceCache();
  renderDashboard();
  const rootFolderName =
    (fileList[0]?.webkitRelativePath || "").split("/")[0] || "Folder";
  const isShared = isFolderInsideSharedHierarchy(state.currentFolderId);
  showToast(
    isShared
      ? `Uploading folder "${rootFolderName}" (${fileList.length} files) • Live syncing to Client Portal`
      : `Uploading folder "${rootFolderName}" (${fileList.length} files)`,
    "success"
  );
}

globalFileInput?.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length > 0) {
    await handleFilesBatchUpload(files);
  }
});

globalFolderInput?.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length > 0) {
    await handleFolderBatchUpload(files);
  }
});

// Boot Application
handleRoute();
