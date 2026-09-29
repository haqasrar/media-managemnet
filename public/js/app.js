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
} from "./firebase-client.js";
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
} from "./ui-helpers.js";
import { createClientPortalController } from "./client-portal.js";

const rootEl = document.getElementById("app-root");
const globalFileInput = document.getElementById("global-file-input");
const globalFolderInput = document.getElementById("global-folder-input");

const FIVE_GB = 5 * 1024 * 1024 * 1024;
const WORKSPACE_CACHE_KEY = "appex_workspace_cache_v1";

function loadWorkspaceCache() {
  try {
    const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveWorkspaceCache() {
  try {
    // Store metadata in localStorage so folders/files/shares persist instantaneously
    const serializableFiles = state.files.map((f) => ({
      ...f,
      // Keep non-oversized URLs in localStorage
      url: f.url && f.url.length > 250000 ? f.url : f.url,
    }));
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
    // ignore quota errors for large base64 items
  }
}

function mergeById(localArr = [], remoteArr = []) {
  const map = new Map();
  for (const item of remoteArr) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of localArr) {
    if (item && item.id && !map.has(item.id)) {
      map.set(item.id, item);
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

  // Upload Queue (disabled blocking loader; instant updates)
  uploadStatus: null,

  // Modals
  showNewFolderModal: false,
  showFirebaseModal: false,
  showGoogleAccountModal: false,
  shareTarget: null, // { resourceType: 'FOLDER'|'FILE', item }
  createdShareResult: null, // ShareLinkItem after creation
  previewFile: null, // MediaFileItem
};

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
  try {
    const res = await fetch("/api/workspace");
    if (res.ok) {
      const data = await res.json();
      state.folders = mergeById(state.folders, data.folders || []);
      state.files = mergeById(state.files, data.files || []);
      state.shares = mergeById(state.shares, data.shares || []);
      state.feedback = mergeById(state.feedback, data.feedback || []);
      saveWorkspaceCache();
    }
  } catch (err) {
    console.error("Workspace load error:", err);
  }
}

async function handleRoute() {
  const path = window.location.pathname;

  if (cleanupPreviewVideo) {
    cleanupPreviewVideo();
    cleanupPreviewVideo = null;
  }

  // 1. Public Client Share Portal (/share/:token)
  if (path.startsWith("/share/")) {
    const token = decodeURIComponent(path.replace("/share/", "").split("/")[0]);
    if (token) {
      createClientPortalController({
        rootEl,
        token,
        onNavigateDashboard: () => navigateTo("/dashboard"),
        showToast,
      });
      return;
    }
  }

  // Check Firebase Configuration
  const fbCfg = await loadFirebaseConfig();
  state.firebaseConnected = Boolean(fbCfg && fbCfg.apiKey);

  // 2. If not signed in with Google, or if new user needs to complete profile after Google login
  if (!state.user || path === "/login" || state.user.needsOnboarding) {
    renderGoogleLoginScreen();
    return;
  }

  // 3. Creator Studio Dashboard (render immediately, sync workspace in background)
  renderDashboard();
  fetchWorkspaceData().then(() => renderDashboard());
}

// ============================================================================
// GOOGLE-ONLY LOGIN SCREEN (LEFT LOGIN PANEL + RIGHT STUDIO SHOWCASE IMAGE)
// ============================================================================
function renderGoogleLoginScreen() {
  rootEl.innerHTML = `
    <div class="min-h-screen lg:h-screen lg:overflow-hidden grid grid-cols-1 lg:grid-cols-12 bg-[#12151e]">
      <!-- LEFT SIDE: ARCHITECTURAL STUDIO BACKGROUND, TOP-LEFT LOGO, CENTER CARD, BOTTOM FOOTER -->
      <div class="lg:col-span-5 xl:col-span-5 min-h-screen lg:h-screen flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-white/[0.12] studio-auth-panel relative overflow-hidden z-10">
        
        <!-- Visual Background Architecture (Grid, Viewfinder Corners, Lens Rings & Studio Light) -->
        <div class="pointer-events-none absolute inset-0 studio-grid-overlay"></div>

        <!-- Ambient Studio Spotlights & Concentric Aperture Rings Behind Card -->
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          <div class="w-[540px] h-[540px] rounded-full border border-white/[0.045] absolute"></div>
          <div class="w-[390px] h-[390px] rounded-full border border-dashed border-white/[0.07] absolute"></div>
          <div class="w-[280px] h-[280px] rounded-full bg-red-500/[0.08] blur-[75px] absolute -translate-y-4"></div>
          <div class="w-[320px] h-[320px] rounded-full bg-slate-200/[0.06] blur-[85px] absolute translate-y-6"></div>
        </div>

        <!-- Subtle Camera Viewfinder Framing Marks -->
        <div class="pointer-events-none absolute top-24 left-7 w-4 h-4 border-t border-l border-white/20"></div>
        <div class="pointer-events-none absolute top-24 right-7 w-4 h-4 border-t border-r border-white/20"></div>
        <div class="pointer-events-none absolute bottom-16 left-7 w-4 h-4 border-b border-l border-white/20"></div>
        <div class="pointer-events-none absolute bottom-16 right-7 w-4 h-4 border-b border-r border-white/20"></div>

        <!-- 1. Top Header Bar — Official Appex Logo pinned at Top-Left Corner -->
        <header class="relative z-10 w-full px-7 pt-6 pb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3.5">
            <div class="w-11 h-11 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center shadow-[0_8px_20px_rgba(0,0,0,0.65)] shrink-0 p-1.5">
              <img
                data-appex-logo="mark"
                src="/assets/appex-logo.webp"
                alt="Appex Studios Logo"
                class="w-full h-full object-contain drop-shadow-[0_2px_6px_rgba(239,68,68,0.25)]"
              />
            </div>
            <div>
              <div class="text-sm font-bold tracking-wider text-white uppercase leading-none">APPEX STUDIOS</div>
              <div class="text-[10px] font-mono-code text-slate-300 tracking-wider mt-1">MEDIA VAULT & CLIENT PORTAL</div>
            </div>
          </div>
        </header>

        <!-- 2. Center Glassmorphic Sign-In Card -->
        <div class="relative z-10 my-auto mx-auto w-full max-w-[450px] px-6 py-6">
          <div class="studio-auth-card rounded-2xl p-7 sm:p-8 w-full animate-view space-y-6 relative overflow-hidden">
            <!-- Top Specular Metallic & Crimson Rim Line -->
            <div class="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-red-400/50 to-transparent"></div>

            <!-- Official Appex Emblem + Badge Header -->
            <div class="flex items-center justify-between gap-3">
              <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-red-500/12 border border-red-400/30 text-[10px] font-mono-code text-red-300 uppercase tracking-wider">
                <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                <span>Studio Workspace Access</span>
              </div>
              <img
                data-appex-logo="mark"
                src="/assets/appex-logo.webp"
                alt="Appex Mark"
                class="w-8 h-8 object-contain opacity-90"
              />
            </div>

            <div>
              <h1 class="text-2xl sm:text-3xl font-semibold text-white tracking-tight leading-snug">
                Deliver client media with studio precision.
              </h1>
              <p class="text-xs sm:text-sm text-slate-300 leading-relaxed mt-2.5">
                Store high-resolution images, 4K video cuts, and project documents in structured folders. Share secure links with clients for instant review and sign-off.
              </p>
            </div>

            <!-- Exclusive Google Sign-In Button -->
            <div>
              <button
                id="btn-google-signin"
                type="button"
                class="w-full bg-white hover:bg-slate-100 text-slate-950 font-semibold py-3.5 px-5 rounded-xl flex items-center justify-center gap-3 shadow-[0_10px_25px_-5px_rgba(255,255,255,0.2)] transition transform active:scale-[0.99]"
              >
                ${GOOGLE_LOGO_SVG}
                <span class="text-sm">Continue with Google</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 3. Bottom Footer — Pinned at the very bottom of the screen -->
        <footer class="relative z-10 w-full px-7 py-4 border-t border-white/[0.1] bg-black/20 backdrop-blur-md flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-2 text-slate-300">
            <span class="font-medium">© Appex Studios</span>
            <span class="text-slate-600">•</span>
            <span class="text-slate-400">
              From
              <a
                href="https://appexproductions.com"
                target="_blank"
                rel="noopener noreferrer"
                class="text-white hover:text-red-400 font-medium underline underline-offset-4 decoration-white/25 hover:decoration-red-400 transition"
              >Appex Productions</a>
            </span>
          </div>
          <a
            href="https://appexproductions.com"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono-code text-[11px] text-slate-400 hover:text-white transition inline-flex items-center gap-1"
          >
            <span>appexproductions.com</span>
            <i data-lucide="arrow-up-right" class="w-3 h-3"></i>
          </a>
        </footer>

      </div>

      <!-- RIGHT SIDE: FULL-VIEWPORT FRAMED STUDIO PHOTOGRAPHY SHOWCASE -->
      <div class="lg:col-span-7 xl:col-span-7 h-[500px] lg:h-screen p-4 sm:p-6 lg:p-7 flex items-center justify-center relative">
        <div class="relative w-full h-full rounded-3xl overflow-hidden border border-white/[0.14] shadow-2xl flex flex-col justify-between p-6 sm:p-8">
          <!-- Generated Studio Background Image -->
          <img
            src="/assets/appex-studio-hero.jpg"
            alt="Appex Studios Production Suite"
            class="absolute inset-0 w-full h-full object-cover object-center"
          />
          <!-- Balanced Vignette Gradients -->
          <div class="absolute inset-0 bg-gradient-to-t from-[#06080c]/95 via-[#06080c]/20 to-[#06080c]/45"></div>

          <!-- Top Badge Inside Showcase -->
          <div class="relative z-10 flex items-center justify-between gap-4 w-full">
            <div class="glass-panel px-3.5 py-1.5 rounded-full text-[11px] font-mono-code text-slate-200 inline-flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-red-500"></span>
              <span>APPEX STUDIOS • CREATIVE MEDIA WORKSPACE</span>
            </div>
          </div>

          <!-- Bottom Studio Caption Card (No Demo Links) -->
          <div class="relative z-10 w-full">
            <div class="glass-panel rounded-2xl p-5 sm:p-6 border border-white/[0.15] backdrop-blur-xl space-y-3">
              <div class="text-[10px] font-mono-code uppercase tracking-widest text-red-300">
                UNIFIED STORAGE & CLIENT DELIVERY
              </div>
              <div class="text-lg font-semibold text-white">
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
      if (profile.needsOnboarding) {
        renderGoogleLoginScreen();
        document.getElementById("onboarding-name-input")?.focus();
        return;
      }
      showToast(`Signed in as ${profile.displayName}`, "success");
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
            <span class="text-sm font-semibold text-white">Complete Your Profile — Appex Studios</span>
          </div>
        </div>

        <div class="p-6 space-y-4">
          <p class="text-xs text-slate-300">
            Welcome! Your Google account is verified. Please confirm your name to complete your new studio profile:
          </p>

          <form id="new-user-onboarding-form" class="space-y-3.5">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-[11px] text-slate-300">Google Email</label>
                <span class="text-[10px] font-mono-code text-emerald-400">Verified</span>
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
              <span>Continue to Appex Studios</span>
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
    showToast(`Welcome to Appex Studios, ${state.user.displayName}`, "success");
    navigateTo("/dashboard");
  });
}

// ============================================================================
// CREATOR STUDIO DASHBOARD
// ============================================================================
function renderDashboard() {
  if (cleanupPreviewVideo) {
    cleanupPreviewVideo();
    cleanupPreviewVideo = null;
  }

  const activeFiles = state.files.filter((f) => !f.isTrashed);
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
  const quotaPct = Math.min(100, Math.max(1, (totalUsedBytes / FIVE_GB) * 100));

  // Compute breadcrumbs when in ALL nav
  const breadcrumbs = [];
  if (state.activeNav === "ALL" && state.currentFolderId) {
    let ptr = state.folders.find((f) => f.id === state.currentFolderId);
    while (ptr) {
      breadcrumbs.unshift(ptr);
      ptr = state.folders.find((f) => f.id === ptr.parentId);
    }
  }

  // Filter folders and files for current view
  let visibleFolders = [];
  let visibleFiles = [];

  const q = state.searchQuery.trim().toLowerCase();

  if (state.activeNav === "ALL") {
    visibleFolders = state.folders.filter(
      (f) =>
        !f.isTrashed &&
        (q ? f.name.toLowerCase().includes(q) : f.parentId === state.currentFolderId)
    );
    visibleFiles = state.files.filter(
      (f) =>
        !f.isTrashed &&
        (q ? f.name.toLowerCase().includes(q) : f.folderId === state.currentFolderId)
    );
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(state.activeNav)) {
    visibleFiles = state.files.filter(
      (f) =>
        !f.isTrashed &&
        f.category === state.activeNav &&
        (!q || f.name.toLowerCase().includes(q))
    );
  } else if (state.activeNav === "STARRED") {
    visibleFolders = state.folders.filter(
      (f) => !f.isTrashed && f.isStarred && (!q || f.name.toLowerCase().includes(q))
    );
    visibleFiles = state.files.filter(
      (f) => !f.isTrashed && f.isStarred && (!q || f.name.toLowerCase().includes(q))
    );
  } else if (state.activeNav === "TRASH") {
    visibleFolders = state.folders.filter((f) => f.isTrashed);
    visibleFiles = state.files.filter((f) => f.isTrashed);
  } else if (state.activeNav === "REVIEWS") {
    visibleFiles = state.files.filter(
      (f) =>
        !f.isTrashed &&
        (f.approvalStatus === "APPROVED" ||
          f.approvalStatus === "CHANGES_REQUESTED" ||
          state.feedback.some((fb) => fb.fileId === f.id))
    );
  }

  const initials = (state.user?.displayName || "Studio")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  rootEl.innerHTML = `
    <div id="dashboard-dropzone" class="min-h-screen flex flex-col lg:flex-row">
      <!-- LEFT GLASS SIDEBAR -->
      <aside class="glass-sidebar w-full lg:w-64 shrink-0 flex flex-col justify-between p-4 lg:min-h-screen">
        <div class="space-y-6">
          <!-- Brand Header -->
          <div class="flex items-center justify-between px-2 pt-1">
            <div class="flex items-center gap-2.5">
              <div class="w-9 h-9 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center p-1 shadow-md shrink-0">
                <img
                  data-appex-logo="mark"
                  src="/assets/appex-logo.webp"
                  alt="Appex Studios"
                  class="w-full h-full object-contain"
                />
              </div>
              <div>
                <div class="text-sm font-bold text-white tracking-wider leading-none">APPEX STUDIOS</div>
                <div class="text-[10px] font-mono-code text-slate-400 mt-1 truncate max-w-[135px]">${escapeHtml(
                  state.user?.studioName || "Appex Studios"
                )}</div>
              </div>
            </div>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-white/[0.05] text-slate-300 border border-white/[0.08]">PRO</span>
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
                label: "Documents & PDFs",
                icon: "file-text",
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
                count: state.shares.length,
              },
              {
                id: "REVIEWS",
                label: "Client Approvals",
                icon: "check-circle-2",
                count: state.feedback.length,
              },
              {
                id: "STARRED",
                label: "Starred Items",
                icon: "star",
                count:
                  activeFiles.filter((f) => f.isStarred).length +
                  state.folders.filter((f) => !f.isTrashed && f.isStarred).length,
              },
              {
                id: "TRASH",
                label: "Trash",
                icon: "trash-2",
                count:
                  state.files.filter((f) => f.isTrashed).length +
                  state.folders.filter((f) => f.isTrashed).length,
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
          <!-- Studio Cloud Storage Quota Card -->
          <div class="glass-card rounded-xl p-3.5 space-y-2.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-slate-200 flex items-center gap-1.5">
                <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-amber-400"></i>
                <span>Cloud Storage</span>
              </span>
              <span class="text-[11px] font-mono-code text-emerald-400">
                Active
              </span>
            </div>

            <div class="w-full h-1.5 bg-white/[0.07] rounded-full overflow-hidden flex">
              <div style="width: ${Math.max(2, (videoBytes / FIVE_GB) * 100)}%" class="bg-sky-400 h-full"></div>
              <div style="width: ${Math.max(2, (imageBytes / FIVE_GB) * 100)}%" class="bg-amber-400 h-full"></div>
              <div style="width: ${Math.max(1, (docBytes / FIVE_GB) * 100)}%" class="bg-emerald-400 h-full"></div>
            </div>

            <div class="flex items-center justify-between text-[11px] font-mono-code text-slate-400">
              <span>${formatBytes(totalUsedBytes)} used</span>
              <span>5.0 GB Vault</span>
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
        <header class="glass-header sticky top-0 z-20 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <!-- Left: Breadcrumb Navigation -->
          <div class="flex items-center gap-1.5 text-sm min-w-0 flex-wrap">
            <button
              id="breadcrumb-root"
              class="px-2.5 py-1 rounded-lg transition flex items-center gap-1.5 ${
                state.activeNav === "ALL" && !state.currentFolderId
                  ? "bg-white/10 text-white font-medium border border-white/15"
                  : "text-slate-400 hover:text-white hover:bg-white/5"
              }"
            >
              <i data-lucide="layers" class="w-3.5 h-3.5 text-amber-400"></i>
              <span>Studio Workspace</span>
            </button>

            ${
              state.activeNav === "ALL"
                ? breadcrumbs
                    .map(
                      (b, idx) => `
                  <span class="text-slate-600">/</span>
                  <button
                    data-breadcrumb-folder="${escapeHtml(b.id)}"
                    class="px-2.5 py-1 rounded-lg transition truncate max-w-[200px] ${
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
                   <span class="px-2.5 py-1 rounded-lg bg-white/10 text-white text-xs font-mono-code uppercase">${escapeHtml(
                     state.activeNav
                   )}</span>`
            }
          </div>

          <!-- Right: Search + View Controls + Folder & Share Actions -->
          <div class="flex items-center gap-2.5 flex-wrap">
            <div class="relative">
              <i data-lucide="search" class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"></i>
              <input
                id="workspace-search-input"
                type="text"
                value="${escapeHtml(state.searchQuery)}"
                placeholder="Search files or folders…"
                class="glass-input pl-8 pr-3 py-1.5 rounded-lg text-xs w-48 sm:w-60"
              />
            </div>

            <!-- Grid vs List Toggle -->
            <div class="flex items-center bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.08]">
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
              class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
            >
              <i data-lucide="folder-plus" class="w-3.5 h-3.5 text-amber-400"></i>
              <span>New Folder</span>
            </button>

            <button
              id="header-upload-folder-btn"
              class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
            >
              <i data-lucide="folder-up" class="w-3.5 h-3.5 text-sky-400"></i>
              <span>Upload Folder</span>
            </button>

            ${
              state.currentFolderId
                ? `<button
                    id="header-share-current-folder"
                    class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 border-amber-500/30 inline-flex items-center gap-1.5"
                  >
                    <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
                    <span>Share Folder with Client</span>
                  </button>`
                : ""
            }

            <button
              id="header-upload-btn"
              class="btn-studio-primary px-3.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
            >
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
              <span>Upload Files</span>
            </button>
          </div>
        </header>

        <!-- Main Explorer Body -->
        <main class="flex-1 p-6 space-y-8 animate-view">
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
  return `
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
          <div class="text-sm font-medium text-white">Drop images, videos, or documents here to upload</div>
          <div class="text-xs text-slate-400">
            Supports RAW/SVG/PNG/JPG stills, MP4/MOV video streams, and PDF/Office project documents • Share any folder or file via Client Link
          </div>
        </div>
      </div>
      <span class="glass-button px-3.5 py-1.5 rounded-lg text-xs font-mono-code text-slate-200 shrink-0">
        Select Files
      </span>
    </div>

    <!-- FOLDERS SECTION -->
    ${
      visibleFolders.length > 0
        ? `
      <section>
        <div class="flex items-center justify-between mb-3.5">
          <h2 class="text-xs font-mono-code uppercase tracking-wider text-slate-400">
            Folders (${visibleFolders.length})
          </h2>
          <span class="text-[11px] text-slate-500">Click a folder to open • Click Share icon to send folder link to client</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          ${visibleFolders
            .map((fld) => {
              const c = getFolderColorStyles(fld.color);
              const itemCount =
                state.files.filter((f) => !f.isTrashed && f.folderId === fld.id).length +
                state.folders.filter((sf) => !sf.isTrashed && sf.parentId === fld.id)
                  .length;
              const folderBytes = state.files
                .filter((f) => !f.isTrashed && f.folderId === fld.id)
                .reduce((a, b) => a + (Number(b.sizeBytes) || 0), 0);

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
                  </div>

                  <div class="pt-2.5 border-t border-white/[0.06] flex items-center justify-between">
                    <button
                      data-share-folder="${escapeHtml(fld.id)}"
                      class="glass-button px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-200 hover:text-amber-300 inline-flex items-center gap-1.5"
                      title="Create Client Share Link for this Folder"
                    >
                      <i data-lucide="share-2" class="w-3 h-3 text-amber-400"></i>
                      <span>Share Folder Link</span>
                    </button>

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

function renderFilesGridView(files) {
  return `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      ${files
        .map((file) => {
          const fbCount = state.feedback.filter((fb) => fb.fileId === file.id).length;
          return `
            <div class="glass-card rounded-2xl overflow-hidden flex flex-col justify-between group">
              <!-- Media Preview Header -->
              <div
                data-preview-file="${escapeHtml(file.id)}"
                class="relative h-44 bg-slate-950/80 border-b border-white/[0.07] cursor-pointer overflow-hidden flex items-center justify-center"
              >
                ${
                  file.category === "IMAGE"
                    ? `<img src="${escapeHtml(file.url)}" alt="${escapeHtml(
                        file.name
                      )}" class="w-full h-full object-cover group-hover:scale-[1.02] transition duration-300" />`
                    : file.category === "VIDEO"
                    ? `<div class="w-full h-full relative flex items-center justify-center bg-slate-950">
                        <img src="/sample-media/oslo-pavilion.svg" alt="" class="w-full h-full object-cover opacity-55" />
                        <div class="absolute inset-0 flex items-center justify-center">
                          <div class="w-11 h-11 rounded-full bg-white/15 backdrop-blur-md border border-white/30 flex items-center justify-center text-white group-hover:scale-105 transition">
                            <i data-lucide="play" class="w-4 h-4 fill-current ml-0.5"></i>
                          </div>
                        </div>
                      </div>`
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
                  ${renderCategoryBadge(file.category)}
                </div>
                <div class="absolute top-2.5 right-2.5">
                  ${renderApprovalBadge(file.approvalStatus)}
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
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b border-white/[0.08] text-[11px] font-mono-code uppercase text-slate-400">
            <th class="py-3 px-4">Deliverable Name</th>
            <th class="py-3 px-4 hidden sm:table-cell">Category</th>
            <th class="py-3 px-4 hidden md:table-cell">Client Status</th>
            <th class="py-3 px-4 hidden lg:table-cell">Size</th>
            <th class="py-3 px-4 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/[0.06] text-xs">
          ${files
            .map(
              (file) => `
            <tr class="hover:bg-white/[0.03] transition">
              <td class="py-3 px-4">
                <div
                  data-preview-file="${escapeHtml(file.id)}"
                  class="font-medium text-white cursor-pointer hover:text-amber-300 truncate max-w-xs"
                >
                  ${escapeHtml(file.name)}
                </div>
                <div class="text-[11px] text-slate-500 font-mono-code">${escapeHtml(
                  file.metaLabel || ""
                )}</div>
              </td>
              <td class="py-3 px-4 hidden sm:table-cell">${renderCategoryBadge(
                file.category
              )}</td>
              <td class="py-3 px-4 hidden md:table-cell">${renderApprovalBadge(
                file.approvalStatus
              )}</td>
              <td class="py-3 px-4 hidden lg:table-cell font-mono-code text-slate-400">${formatBytes(
                file.sizeBytes
              )}</td>
              <td class="py-3 px-4 text-right space-x-1.5">
                <button
                  data-share-file="${escapeHtml(file.id)}"
                  class="glass-button px-2.5 py-1 rounded text-[11px] text-amber-300 inline-flex items-center gap-1"
                >
                  <i data-lucide="share-2" class="w-3 h-3"></i>
                  <span>Share</span>
                </button>
                <button
                  data-preview-file="${escapeHtml(file.id)}"
                  class="glass-button px-2.5 py-1 rounded text-[11px] text-slate-200"
                >
                  Preview
                </button>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// CLIENT SHARE LINKS MANAGEMENT VIEW
// ============================================================================
function renderSharesManagementSection() {
  const origin = window.location.origin;
  return `
    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold text-white">Client Share Links & Delivery Portals</h1>
          <p class="text-xs text-slate-400 mt-1">
            Every shared folder or file link below opens a clean, distraction-free Client Review Portal with download and approval controls.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4">
        ${
          state.shares.length === 0
            ? `<div class="glass-panel rounded-2xl p-10 text-center text-sm text-slate-400">
                No client share links created yet. Click "Share Folder Link" or "Share Link" on any item in your workspace.
              </div>`
            : state.shares
                .map((s) => {
                  const shareUrl = `${origin}/share/${s.token}`;
                  return `
                    <div class="glass-panel rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                      <div class="space-y-2 max-w-2xl">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="px-2 py-0.5 rounded text-[10px] font-mono-code uppercase bg-amber-500/15 text-amber-300 border border-amber-500/25">
                            ${s.resourceType === "FOLDER" ? "FOLDER PORTAL" : "FILE LINK"}
                          </span>
                          <span class="text-xs font-mono-code text-slate-400">Target: ${escapeHtml(
                            s.resourceName
                          )}</span>
                          ${
                            s.hasPassword
                              ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono-code bg-white/10 text-slate-200">Passcode Protected</span>`
                              : ""
                          }
                        </div>

                        <div class="text-base font-semibold text-white">${escapeHtml(
                          s.title
                        )}</div>
                        ${
                          s.description
                            ? `<p class="text-xs text-slate-400">${escapeHtml(
                                s.description
                              )}</p>`
                            : ""
                        }

                        <div class="flex flex-wrap items-center gap-4 pt-1 text-xs font-mono-code text-slate-400">
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

                      <div class="flex flex-wrap items-center gap-2.5 shrink-0">
                        <div class="glass-input px-3 py-2 rounded-lg text-xs font-mono-code text-slate-300 max-w-[260px] truncate">
                          ${escapeHtml(shareUrl)}
                        </div>
                        <button
                          data-copy-share-url="${escapeHtml(shareUrl)}"
                          class="btn-studio-primary px-3.5 py-2 rounded-lg text-xs inline-flex items-center gap-1.5"
                        >
                          <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                          <span>Copy Link</span>
                        </button>
                        <button
                          data-open-share-portal="${escapeHtml(s.token)}"
                          class="glass-button px-3.5 py-2 rounded-lg text-xs font-medium text-amber-300 inline-flex items-center gap-1.5"
                        >
                          <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                          <span>Open Client View</span>
                        </button>
                        <button
                          data-delete-share="${escapeHtml(s.id)}"
                          class="glass-button p-2 rounded-lg text-slate-400 hover:text-rose-400"
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
  return `
    <div class="space-y-6">
      <div>
        <h1 class="text-xl font-semibold text-white">Client Approvals & Revision Notes</h1>
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
          ${state.feedback
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
      <div class="glass-modal w-full max-w-md rounded-2xl p-6 animate-modal">
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
      <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="glass-modal w-full max-w-lg rounded-2xl p-6 animate-modal space-y-5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <i data-lucide="check" class="w-4 h-4"></i>
              </div>
              <div>
                <h3 class="text-base font-semibold text-white">Client Portal Link Ready</h3>
                <p class="text-xs text-slate-400">Send this link to your client for instant viewing & approval.</p>
              </div>
            </div>
            <button id="close-share-modal" class="text-slate-400 hover:text-white">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="glass-card rounded-xl p-4 space-y-3">
            <div class="text-xs font-mono-code text-amber-300 uppercase">${
              createdShare.resourceType === "FOLDER" ? "SHARED FOLDER LINK" : "SHARED FILE LINK"
            }</div>
            <div class="text-sm font-semibold text-white">${escapeHtml(
              createdShare.title
            )}</div>
            <div class="flex items-center gap-2">
              <input
                id="created-share-url-input"
                type="text"
                readonly
                value="${escapeHtml(shareUrl)}"
                class="glass-input flex-1 px-3 py-2 rounded-lg text-xs font-mono-code text-sky-300"
              />
              <button
                id="btn-copy-created-share"
                class="btn-studio-primary px-3.5 py-2 rounded-lg text-xs inline-flex items-center gap-1.5"
              >
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                <span>Copy</span>
              </button>
            </div>
          </div>

          <div class="flex items-center justify-between pt-2">
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
    <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="glass-modal w-full max-w-lg rounded-2xl p-6 animate-modal">
        <div class="flex items-center justify-between mb-5 pb-3 border-b border-white/[0.08]">
          <div>
            <span class="text-[10px] font-mono-code uppercase tracking-wider text-amber-400">
              ${resourceType === "FOLDER" ? "Share Folder with Client" : "Share Deliverable File"}
            </span>
            <h3 class="text-base font-semibold text-white mt-0.5">${escapeHtml(
              item.name
            )}</h3>
          </div>
          <button id="close-share-modal" class="text-slate-400 hover:text-white">
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
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 lg:p-8">
      <div class="glass-modal w-full max-w-6xl h-[85vh] rounded-2xl overflow-hidden flex flex-col lg:flex-row animate-modal">
        <!-- Left Media Stage -->
        <div class="flex-1 bg-slate-950/90 flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <div class="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-4">
            <div class="flex items-center gap-2.5 min-w-0">
              ${renderCategoryBadge(file.category)}
              <span class="text-sm font-medium text-white truncate">${escapeHtml(
                file.name
              )}</span>
            </div>
            <div class="flex items-center gap-2">
              <button
                id="preview-share-file-btn"
                class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 inline-flex items-center gap-1.5"
              >
                <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
                <span>Share with Client</span>
              </button>
              <a
                href="${escapeHtml(file.url)}"
                download="${escapeHtml(file.name)}"
                class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
              >
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
                <span>Download</span>
              </a>
              <button id="close-preview-modal" class="glass-button p-1.5 rounded-lg text-slate-400 hover:text-white">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <div class="flex-1 flex items-center justify-center p-6 overflow-auto">
            ${
              file.category === "IMAGE"
                ? `<img src="${escapeHtml(file.url)}" alt="${escapeHtml(
                    file.name
                  )}" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />`
                : file.category === "VIDEO"
                ? file.url.includes("studio-walkthrough.mp4")
                  ? `<div class="w-full max-w-3xl space-y-3">
                      <canvas id="studio-cinema-canvas" width="960" height="540" class="w-full rounded-xl border border-white/10 shadow-2xl bg-black"></canvas>
                      <div class="glass-panel px-4 py-2.5 rounded-xl flex items-center gap-4">
                        <button id="studio-cinema-play" type="button" class="btn-studio-primary px-3 py-1 rounded text-xs">Pause</button>
                        <input id="studio-cinema-scrubber" type="range" min="0" max="100" value="0" class="flex-1 accent-amber-400 cursor-pointer" />
                        <span id="studio-cinema-time" class="text-xs font-mono-code text-slate-300">00:00:00 / 00:12:00</span>
                      </div>
                    </div>`
                  : `<video src="${escapeHtml(
                      file.url
                    )}" controls autoplay class="max-w-full max-h-full rounded-xl border border-white/10 shadow-2xl"></video>`
                : `<iframe src="${escapeHtml(
                    file.url
                  )}" class="w-full h-full rounded-xl border border-white/10 bg-white"></iframe>`
            }
          </div>
        </div>

        <!-- Right Deliverable Inspector & Client Feedback -->
        <div class="w-full lg:w-96 flex flex-col bg-slate-950/60 min-h-0">
          <div class="p-5 border-b border-white/[0.08] space-y-3">
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

          <div class="flex-1 overflow-y-auto p-5 space-y-3">
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
          Paste your Firebase Web App credentials below (or in <code class="text-slate-200 font-mono-code">.env.local</code>) to connect live Firebase Google OAuth and your 5 GB Firebase Cloud Storage bucket. When blank, Appex Studios automatically runs in Hybrid Local Storage mode.
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
  // Sidebar navigation
  rootEl.querySelectorAll("[data-nav-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeNav = btn.getAttribute("data-nav-item");
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
    renderDashboard();
  });

  rootEl.querySelectorAll("[data-breadcrumb-folder]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeNav = "ALL";
      state.currentFolderId = btn.getAttribute("data-breadcrumb-folder");
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
      ownerId: state.user?.uid || "default",
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

    const optimisticShare = {
      id: `shr-${Math.random().toString(36).slice(2, 11)}`,
      token,
      title: title || item.name || "Client Delivery",
      description,
      resourceType,
      folderId: resourceType === "FOLDER" ? item.id : null,
      fileId: resourceType === "FILE" ? item.id : null,
      resourceName: item.name,
      ownerId: state.user?.uid || "default",
      ownerName: state.user?.displayName || "Studio Director",
      studioName: state.user?.studioName || "Appex Studios",
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
          title,
          description,
          resourceType,
          folderId: resourceType === "FOLDER" ? item.id : null,
          fileId: resourceType === "FILE" ? item.id : null,
          resourceName: item.name,
          ownerId: state.user?.uid || "default",
          ownerName: state.user?.displayName || "Studio Director",
          studioName: state.user?.studioName || "Appex Studios",
          allowDownload,
          allowFeedback,
          password: password || null,
          expiresInDays,
        }),
      });
      const data = await res.json();
      if (res.ok && data.share) {
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
    showToast("Client Share Link generated", "success");
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
      navigateTo(`/share/${tok}`);
    }
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
      navigateTo(`/share/${tok}`);
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

// ============================================================================
// INSTANT ZERO-WAIT FILE & FOLDER UPLOAD HANDLERS
// ============================================================================
async function handleFilesBatchUpload(fileList) {
  if (!fileList || fileList.length === 0) return;

  const addedFiles = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const instantItem = await uploadMediaFile(file, {
      folderId: state.currentFolderId,
      ownerId: state.user?.uid || "default",
    });
    state.files.unshift(instantItem);
    addedFiles.push(instantItem);
  }

  saveWorkspaceCache();
  renderDashboard();
  showToast(
    addedFiles.length === 1
      ? `Added ${addedFiles[0].name}`
      : `Added ${addedFiles.length} files`,
    "success"
  );
}

async function handleFolderBatchUpload(fileList) {
  if (!fileList || fileList.length === 0) return;

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
        const newFolder = {
          id: `fld-${Math.random().toString(36).slice(2, 11)}`,
          name: seg,
          parentId,
          color: "amber",
          ownerId: state.user?.uid || "default",
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

    const instantItem = await uploadMediaFile(file, {
      folderId: targetFolderId,
      ownerId: state.user?.uid || "default",
    });
    state.files.unshift(instantItem);
  }

  saveWorkspaceCache();
  renderDashboard();
  const rootFolderName =
    (fileList[0]?.webkitRelativePath || "").split("/")[0] || "Folder";
  showToast(`Added folder "${rootFolderName}" (${fileList.length} files)`, "success");
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
