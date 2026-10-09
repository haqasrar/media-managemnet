import {
  formatBytes,
  formatDateShort,
  formatRelativeTime,
  escapeHtml,
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
  decodeDataUrl,
} from "./ui-helpers.js?v=16";
import { hydrateMediaFilesFromVault } from "./firebase-client.js?v=15";

export function createClientPortalController({ rootEl, token, showToast }) {
  // Strictly lock this browser tab to the Client Portal so refreshing never opens the Studio Account
  try {
    sessionStorage.setItem("appex_client_portal_lock", token);
    window.__APPEX_CLIENT_PORTAL_LOCK__ = token;
  } catch {
    // ignore storage errors
  }

  let portalData = null;
  let passwordPromptInfo = null;
  let errorMessage = null;
  let enteredPassword = sessionStorage.getItem(`vellum_pass_${token}`) || "";
  let currentSubfolderId = null;
  let activeCategoryFilter = "ALL";
  let activeFileModal = null;
  let clientCodePreviewMode = "render";
  let cleanupVideoCanvas = null;
  let liveSyncTimer = null;
  let isDestroyed = false;
  let clientReviewerName =
    localStorage.getItem("vellum_client_reviewer_name") || "Client Reviewer";

  function cleanupPortal() {
    isDestroyed = true;
    if (liveSyncTimer) {
      clearInterval(liveSyncTimer);
      liveSyncTimer = null;
    }
    if (cleanupVideoCanvas) {
      cleanupVideoCanvas();
      cleanupVideoCanvas = null;
    }
    window.removeEventListener("storage", handleStorageSync);
  }

  function resolveLocalCachePortal(serverShare = null) {
    try {
      const raw = localStorage.getItem("appex_workspace_cache_v1");
      if (!raw) return null;
      const ws = JSON.parse(raw);
      const localShare = (ws.shares || []).find(
        (s) => s.token === token && s.isActive !== false
      );
      const share = localShare || serverShare;
      if (!share) return null;

      if (share.password && share.password !== enteredPassword) {
        return {
          status: 401,
          data: {
            requiresPassword: true,
            title: share.title,
            studioName: share.studioName,
            ownerName: share.ownerName,
            resourceType: share.resourceType,
          },
        };
      }

      const folders = ws.folders || [];
      const files = ws.files || [];
      let sharedFolders = [];
      let sharedFiles = [];

      if (share.resourceType === "FOLDER") {
        const allowed = new Set();
        if (share.folderId) allowed.add(share.folderId);
        if (serverShare?.folderId) allowed.add(serverShare.folderId);

        // Also match root folder by resourceName in case client & server had different IDs
        const targetName = String(
          share.resourceName || serverShare?.resourceName || share.title || ""
        )
          .trim()
          .toLowerCase();
        if (targetName) {
          for (const f of folders) {
            if (!f.isTrashed && String(f.name || "").trim().toLowerCase() === targetName) {
              allowed.add(f.id);
            }
          }
        }

        let added = true;
        while (added) {
          added = false;
          for (const f of folders) {
            if (!f.isTrashed && f.parentId && allowed.has(f.parentId) && !allowed.has(f.id)) {
              allowed.add(f.id);
              added = true;
            }
          }
        }
        sharedFolders = folders.filter((f) => !f.isTrashed && allowed.has(f.id));
        sharedFiles = files.filter(
          (f) => !f.isTrashed && f.folderId && allowed.has(f.folderId)
        );
      } else if (share.resourceType === "FILE") {
        const targetIds = new Set(
          [share.fileId, serverShare?.fileId].filter(Boolean)
        );
        const targetName = String(
          share.resourceName || serverShare?.resourceName || share.title || ""
        )
          .trim()
          .toLowerCase();
        sharedFiles = files.filter(
          (f) =>
            !f.isTrashed &&
            (targetIds.has(f.id) ||
              (targetName && String(f.name || "").trim().toLowerCase() === targetName))
        );
      }

      const fileIds = new Set(sharedFiles.map((f) => f.id));
      const feedback = (ws.feedback || []).filter((fb) => fileIds.has(fb.fileId));
      return {
        status: 200,
        data: { share, folders: sharedFolders, files: sharedFiles, feedback },
      };
    } catch {
      return null;
    }
  }

  function mergePortalDatasets(serverData, localData) {
    if (!serverData && !localData) return null;
    if (!serverData) return localData;
    if (!localData) return serverData;

    const share = { ...localData.share, ...serverData.share };

    // Determine canonical root folder ID for FOLDER shares
    const folderMap = new Map();
    for (const f of [...(serverData.folders || []), ...(localData.folders || [])]) {
      if (!f || !f.id) continue;
      if (!folderMap.has(f.id)) {
        folderMap.set(f.id, { ...f });
      }
    }

    // Determine root folder(s) matching share.folderId or share.resourceName
    const rootFolderName = String(share.resourceName || share.title || "")
      .trim()
      .toLowerCase();
    const rootFolderIds = new Set();
    if (share.folderId) rootFolderIds.add(share.folderId);
    for (const f of folderMap.values()) {
      if (rootFolderName && String(f.name || "").trim().toLowerCase() === rootFolderName) {
        rootFolderIds.add(f.id);
      }
    }

    const canonicalRootId =
      share.folderId || (rootFolderIds.size > 0 ? Array.from(rootFolderIds)[0] : null);

    // Deduplicate folders and normalize alias root folder IDs to canonicalRootId
    const mergedFolders = [];
    const seenFolderKey = new Set();
    for (const f of folderMap.values()) {
      const normalizedParentId =
        f.parentId && rootFolderIds.has(f.parentId) && f.id !== canonicalRootId
          ? canonicalRootId
          : f.parentId;
      const isRootAlias = rootFolderIds.has(f.id);
      const normalizedId = isRootAlias ? canonicalRootId : f.id;
      const key = isRootAlias
        ? `ROOT:${canonicalRootId}`
        : `${normalizedParentId || "root"}:${String(f.name || "").toLowerCase()}`;
      if (seenFolderKey.has(key)) continue;
      seenFolderKey.add(key);
      mergedFolders.push({
        ...f,
        id: normalizedId,
        parentId: isRootAlias ? f.parentId : normalizedParentId,
      });
    }

    // Merge files (prefer persistent non-blob URL if available, deduplicate by id or name+folderId)
    const fileByKey = new Map();
    const allCandidateFiles = [...(localData.files || []), ...(serverData.files || [])];
    for (const f of allCandidateFiles) {
      if (!f || !f.id) continue;
      const normalizedFolderId =
        f.folderId && rootFolderIds.has(f.folderId) ? canonicalRootId : f.folderId;
      const normalizedFile = { ...f, folderId: normalizedFolderId };
      const key = `${normalizedFolderId || "file"}:${String(f.name || "").toLowerCase()}:${f.sizeBytes || 0}`;
      const existing = fileByKey.get(f.id) || fileByKey.get(key);
      if (!existing) {
        fileByKey.set(f.id, normalizedFile);
        fileByKey.set(key, normalizedFile);
      } else {
        // Prefer non-blob URL or newer updated status
        const chosenUrl =
          existing.url && !existing.url.startsWith("blob:")
            ? existing.url
            : normalizedFile.url || existing.url;
        const mergedFile = {
          ...existing,
          ...normalizedFile,
          id: existing.id,
          folderId: normalizedFolderId || existing.folderId,
          url: chosenUrl,
        };
        fileByKey.set(existing.id, mergedFile);
        fileByKey.set(f.id, mergedFile);
        fileByKey.set(key, mergedFile);
      }
    }

    const uniqueFilesMap = new Map();
    for (const f of fileByKey.values()) {
      uniqueFilesMap.set(f.id, f);
    }
    const mergedFiles = Array.from(uniqueFilesMap.values()).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    // Merge feedback
    const feedbackMap = new Map();
    for (const fb of [...(serverData.feedback || []), ...(localData.feedback || [])]) {
      if (fb && fb.id) feedbackMap.set(fb.id, fb);
    }
    const mergedFeedback = Array.from(feedbackMap.values()).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    if (canonicalRootId && share.resourceType === "FOLDER") {
      share.folderId = canonicalRootId;
    }

    return {
      share,
      folders: mergedFolders,
      files: mergedFiles,
      feedback: mergedFeedback,
    };
  }

  function computeDatasetSignature(d) {
    if (!d) return "";
    const fSig = (d.files || [])
      .map((f) => `${f.id}:${f.approvalStatus}:${f.url?.slice(0, 24)}`)
      .join("|");
    const fldSig = (d.folders || []).map((f) => f.id).join("|");
    const fbSig = (d.feedback || []).length;
    return `${fSig}__${fldSig}__${fbSig}`;
  }

  async function fetchMergedPortalState(trackView = false) {
    const url = `/api/public/share/${encodeURIComponent(token)}${
      trackView ? "?track=1" : ""
    }`;
    let status = 404;
    let serverJson = null;

    try {
      const res = await fetch(url, {
        headers: enteredPassword ? { "x-share-password": enteredPassword } : {},
      });
      status = res.status;
      serverJson = await res.json();
    } catch {
      status = 0;
    }

    const localResolved = resolveLocalCachePortal(
      status >= 200 && status < 300 ? serverJson?.share : null
    );

    if (status === 401 && serverJson?.requiresPassword) {
      return { status: 401, data: serverJson };
    }
    if (status >= 200 && status < 300 && serverJson) {
      const merged = mergePortalDatasets(
        serverJson,
        localResolved?.status === 200 ? localResolved.data : null
      );
      if (merged?.files) {
        await hydrateMediaFilesFromVault(merged.files);
      }
      return { status: 200, data: merged };
    }
    if (localResolved) {
      if (localResolved.data?.files) {
        await hydrateMediaFilesFromVault(localResolved.data.files);
      }
      return localResolved;
    }
    return {
      status: status || 404,
      data: serverJson || { error: "Unable to load shared deliverable." },
    };
  }

  async function loadPortal(trackView = false) {
    try {
      const { status, data } = await fetchMergedPortalState(trackView);

      if (status === 401 && data.requiresPassword) {
        passwordPromptInfo = data;
        portalData = null;
        errorMessage = null;
        render();
        return;
      }

      if (status < 200 || status >= 300) {
        errorMessage = data.error || "Unable to load shared deliverable.";
        portalData = null;
        passwordPromptInfo = null;
        render();
        return;
      }

      passwordPromptInfo = null;
      errorMessage = null;
      portalData = data;
      if (
        currentSubfolderId === null &&
        data.share.resourceType === "FOLDER" &&
        data.share.folderId
      ) {
        currentSubfolderId = data.share.folderId;
      }
      // If a single file was shared, open it or showcase it immediately
      if (data.share.resourceType === "FILE" && data.files.length === 1 && !activeFileModal) {
        activeFileModal = data.files[0];
      }
      render();
    } catch (err) {
      errorMessage = err.message || "Network error loading client portal.";
      render();
    }
  }

  async function pollLiveFolderUpdates(notifyOnNewFiles = true) {
    if (isDestroyed || passwordPromptInfo || errorMessage || !portalData) return;
    // Avoid disrupting active typing in the review comment box
    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

    try {
      const prevCount = portalData.files?.length || 0;
      const prevSig = computeDatasetSignature(portalData);
      const { status, data } = await fetchMergedPortalState(false);
      if (status === 200 && data) {
        const nextSig = computeDatasetSignature(data);
        if (nextSig !== prevSig) {
          const nextCount = data.files?.length || 0;
          portalData = data;
          if (
            currentSubfolderId === null &&
            data.share.resourceType === "FOLDER" &&
            data.share.folderId
          ) {
            currentSubfolderId = data.share.folderId;
          }
          if (activeFileModal) {
            activeFileModal =
              data.files.find((f) => f.id === activeFileModal.id) || activeFileModal;
          }
          render();
          if (notifyOnNewFiles && nextCount > prevCount) {
            const diff = nextCount - prevCount;
            showToast(
              diff === 1
                ? "1 new deliverable synced to folder"
                : `${diff} new deliverables synced to folder`,
              "info"
            );
          }
        }
      }
    } catch {
      // silent background poll
    }
  }

  function handleStorageSync(e) {
    if (e.key === "appex_workspace_cache_v1") {
      pollLiveFolderUpdates(true);
    }
  }

  async function submitClientFeedback(fileId, status, commentText) {
    try {
      const res = await fetch(
        `/api/public/share/${encodeURIComponent(token)}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            clientName: clientReviewerName,
            status,
            comment: commentText,
          }),
        }
      );
      let updatedFile = null;
      let createdFeedback = null;
      if (res.ok) {
        const data = await res.json();
        updatedFile = data.file;
        createdFeedback = data.feedback;
      } else {
        createdFeedback = {
          id: `fb-${Math.random().toString(36).slice(2, 9)}`,
          shareId: portalData?.share?.id || token,
          fileId,
          clientName: clientReviewerName,
          status,
          comment: commentText,
          createdAt: new Date().toISOString(),
        };
      }

      // Update local state & localStorage workspace cache so studio view sees it immediately
      const fileIdx = portalData.files.findIndex((f) => f.id === fileId);
      if (fileIdx !== -1) {
        if (updatedFile) {
          portalData.files[fileIdx] = updatedFile;
        } else if (status === "APPROVED" || status === "CHANGES_REQUESTED") {
          portalData.files[fileIdx].approvalStatus = status;
        }
        if (activeFileModal && activeFileModal.id === fileId) {
          activeFileModal = portalData.files[fileIdx];
        }
      }
      if (createdFeedback) {
        portalData.feedback.unshift(createdFeedback);
      }

      try {
        const raw = localStorage.getItem("appex_workspace_cache_v1");
        if (raw) {
          const ws = JSON.parse(raw);
          if (Array.isArray(ws.files)) {
            const idx = ws.files.findIndex((f) => f.id === fileId);
            if (idx !== -1 && (status === "APPROVED" || status === "CHANGES_REQUESTED")) {
              ws.files[idx].approvalStatus = status;
            }
          }
          if (createdFeedback && Array.isArray(ws.feedback)) {
            ws.feedback.unshift(createdFeedback);
          }
          localStorage.setItem("appex_workspace_cache_v1", JSON.stringify(ws));
        }
      } catch {
        // ignore storage error
      }

      showToast(
        status === "APPROVED"
          ? "Deliverable marked as Approved"
          : status === "CHANGES_REQUESTED"
          ? "Revision request sent to studio"
          : "Review note posted",
        "success"
      );
      render();
    } catch (err) {
      showToast("Failed to save feedback", "error");
    }
  }

  async function triggerClientDownload(file) {
    if (!portalData?.share?.allowDownload) {
      showToast("Downloads are disabled on this view-only portal", "error");
      return;
    }
    try {
      await fetch(`/api/public/share/${encodeURIComponent(token)}/download`, {
        method: "POST",
      });
      portalData.share.downloadCount = (portalData.share.downloadCount || 0) + 1;
    } catch {
      // ignore counter error
    }
    const a = document.createElement("a");
    a.href = file.url;
    a.download = file.name;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Downloading ${file.name}`, "success");
    render();
  }

  async function triggerDownloadAllFiles(filesToDownload) {
    if (!portalData?.share?.allowDownload) {
      showToast("Downloads are disabled on this view-only portal", "error");
      return;
    }
    if (!filesToDownload || filesToDownload.length === 0) return;
    showToast(`Starting download of ${filesToDownload.length} deliverables…`, "success");
    for (let i = 0; i < filesToDownload.length; i++) {
      const f = filesToDownload[i];
      const a = document.createElement("a");
      a.href = f.url;
      a.download = f.name;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function render() {
    if (cleanupVideoCanvas) {
      cleanupVideoCanvas();
      cleanupVideoCanvas = null;
    }

    // 1. Error State
    if (errorMessage) {
      rootEl.innerHTML = `
        <div class="min-h-screen flex items-center justify-center p-6">
          <div class="glass-modal max-w-md w-full rounded-2xl p-8 text-center animate-modal">
            <div class="w-12 h-12 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-4 text-rose-400">
              <i data-lucide="shield-alert" class="w-6 h-6"></i>
            </div>
            <h1 class="text-lg font-semibold text-white mb-2">Delivery Link Unavailable</h1>
            <p class="text-sm text-slate-400 leading-relaxed mb-6">${escapeHtml(errorMessage)}</p>
            <button id="portal-retry-btn" class="glass-button px-4 py-2.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-2">
              <i data-lucide="refresh-cw" class="w-4 h-4"></i>
              Retry Loading Portal
            </button>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      document
        .getElementById("portal-retry-btn")
        ?.addEventListener("click", () => loadPortal(false));
      return;
    }

    // 2. Password Protected Gate
    if (passwordPromptInfo) {
      rootEl.innerHTML = `
        <div class="min-h-screen flex items-center justify-center p-6">
          <div class="glass-modal max-w-md w-full rounded-2xl p-8 animate-modal">
            <div class="flex items-center justify-between mb-6 pb-4 border-b border-white/[0.08]">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center">
                  <span class="w-2.5 h-2.5 rounded-sm bg-amber-400"></span>
                </div>
                <span class="text-xs font-mono-code uppercase tracking-widest text-slate-300">${escapeHtml(
                  passwordPromptInfo.studioName || "Tech Titans"
                )}</span>
              </div>
              <span class="text-[11px] font-mono-code text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">Protected Portal</span>
            </div>

            <h1 class="text-xl font-semibold text-white mb-1.5">${escapeHtml(
              passwordPromptInfo.title || "Client Deliverable"
            )}</h1>
            <p class="text-xs text-slate-400 mb-6">Shared by ${escapeHtml(
              passwordPromptInfo.ownerName || "Studio Director"
            )}. Enter the client access passcode to view and review files.</p>

            <form id="portal-password-form" class="space-y-4">
              <div>
                <label class="block text-xs font-medium text-slate-300 mb-1.5">Access Passcode</label>
                <input
                  id="portal-pass-input"
                  type="password"
                  required
                  placeholder="Enter portal passcode…"
                  class="glass-input w-full px-3.5 py-2.5 rounded-lg text-sm"
                />
              </div>
              <button type="submit" class="btn-studio-primary w-full py-2.5 rounded-lg text-sm flex items-center justify-center gap-2">
                <i data-lucide="unlock" class="w-4 h-4"></i>
                Unlock Client Portal
              </button>
            </form>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      document
        .getElementById("portal-password-form")
        ?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const val = document.getElementById("portal-pass-input").value.trim();
          enteredPassword = val;
          sessionStorage.setItem(`vellum_pass_${token}`, val);
          await loadPortal(true);
        });
      return;
    }

    if (!portalData) return;

    const { share, folders, files, feedback } = portalData;
    const totalBytes = files.reduce((acc, f) => acc + (Number(f.sizeBytes) || 0), 0);
    const approvedCount = files.filter((f) => f.approvalStatus === "APPROVED").length;

    if (share.resourceType === "FOLDER" && share.folderId && !currentSubfolderId) {
      currentSubfolderId = share.folderId;
    }

    // Filter subfolders and files for current folder view
    const visibleSubfolders =
      share.resourceType === "FOLDER"
        ? folders.filter((f) => String(f.parentId) === String(currentSubfolderId))
        : [];

    let visibleFiles =
      share.resourceType === "FOLDER"
        ? files.filter(
            (f) =>
              String(f.folderId) === String(currentSubfolderId) ||
              (String(currentSubfolderId) === String(share.folderId) && !f.folderId)
          )
        : files;

    if (activeCategoryFilter !== "ALL") {
      if (["IMAGE", "VIDEO", "DOCUMENT"].includes(activeCategoryFilter)) {
        visibleFiles = files.filter((f) => f.category === activeCategoryFilter);
      } else if (activeCategoryFilter === "APPROVED") {
        visibleFiles = files.filter((f) => f.approvalStatus === "APPROVED");
      } else if (activeCategoryFilter === "CHANGES_REQUESTED") {
        visibleFiles = files.filter((f) => f.approvalStatus === "CHANGES_REQUESTED");
      }
    }

    // Build folder breadcrumbs inside the shared folder
    const breadcrumbs = [];
    if (share.resourceType === "FOLDER" && share.folderId) {
      let ptr = folders.find((f) => String(f.id) === String(currentSubfolderId));
      const visited = new Set();
      while (ptr && !visited.has(ptr.id)) {
        visited.add(ptr.id);
        breadcrumbs.unshift(ptr);
        if (String(ptr.id) === String(share.folderId)) break;
        ptr = folders.find((f) => String(f.id) === String(ptr.parentId));
      }
    }

    rootEl.innerHTML = `
      <div class="min-h-screen flex flex-col">
        <!-- Top Frosted Glass Client Header (Strictly Isolated from Studio Account) -->
        <header class="glass-header sticky top-0 z-30 px-3.5 sm:px-6 py-3 sm:py-4">
          <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center shadow-inner p-1 shrink-0">
                <img
                  data-appex-logo="mark"
                  src="/assets/appex-logo.webp"
                  alt="Secure Sharing"
                  class="w-full h-full object-contain"
                />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                  <span class="text-[10px] sm:text-xs font-mono-code uppercase tracking-widest text-slate-400 truncate">${escapeHtml(
                    share.studioName || "Tech Titans"
                  )}</span>
                  <span class="text-slate-600">•</span>
                  <span class="text-[10px] sm:text-xs text-slate-400">Secure Sharing Client Portal</span>
                </div>
                <h1 class="text-sm sm:text-base font-semibold text-white tracking-tight truncate">${escapeHtml(
                  share.title
                )}</h1>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1.5 sm:gap-2.5 w-full sm:w-auto">
              ${
                share.resourceType === "FOLDER"
                  ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-[11px] font-mono-code bg-emerald-500/10 text-emerald-300 border border-emerald-500/20" title="New files uploaded to this folder appear automatically">
                      <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
                      <span>Live Sync</span>
                    </span>`
                  : ""
              }
              <button
                id="client-refresh-portal"
                class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 inline-flex items-center gap-1.5 hover:text-white"
                title="Sync latest studio uploads"
              >
                <i data-lucide="refresh-cw" class="w-3.5 h-3.5 text-slate-400"></i>
                <span>Sync</span>
              </button>
              ${
                share.allowDownload
                  ? `<span class="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                      <i data-lucide="download" class="w-3.5 h-3.5 shrink-0"></i>
                      <span>Downloads Permitted</span>
                    </span>`
                  : `<span class="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20">
                      <i data-lucide="eye" class="w-3.5 h-3.5 shrink-0"></i>
                      <span>View-Only</span>
                    </span>`
              }
              <span class="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/[0.04] text-slate-300 border border-white/[0.09]">
                <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i>
                <span>Verified Client Access</span>
              </span>
            </div>
          </div>
        </header>

        <!-- Main Deliverable Content -->
        <main class="flex-1 max-w-7xl w-full mx-auto px-3.5 sm:px-6 py-5 sm:py-8 animate-view">
          <!-- Deliverable Overview Hero Card -->
          <div class="glass-panel rounded-2xl p-4 sm:p-6 mb-6 sm:mb-8">
            <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-5 sm:gap-6">
              <div class="space-y-2 max-w-3xl">
                <div class="flex flex-wrap items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs text-slate-400">
                  <span class="font-mono-code uppercase tracking-wider text-amber-300/90">${
                    share.resourceType === "FOLDER" ? "SHARED FOLDER PACKAGE" : "SINGLE DELIVERABLE"
                  }</span>
                  <span>•</span>
                  <span>Prepared by <strong class="text-slate-200 font-medium">${escapeHtml(
                    share.ownerName || "Studio Director"
                  )}</strong></span>
                  ${
                    share.expiresAt
                      ? `<span>•</span><span>Valid until ${formatDateShort(share.expiresAt)}</span>`
                      : ""
                  }
                </div>
                <h2 class="text-xl sm:text-2xl font-semibold text-white tracking-tight">${escapeHtml(
                  share.title
                )}</h2>
                ${
                  share.description
                    ? `<p class="text-xs sm:text-sm text-slate-300/90 leading-relaxed">${escapeHtml(
                        share.description
                      )}</p>`
                    : `<p class="text-xs text-slate-400">Live studio delivery portal — inspect files, leave review notes, or download approved assets.</p>`
                }
              </div>

              <!-- Deliverable Metrics & Download All -->
              <div class="grid grid-cols-2 sm:flex sm:flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 shrink-0">
                <div class="glass-card px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl sm:min-w-[110px]">
                  <div class="text-[10px] sm:text-[11px] text-slate-400">Deliverables</div>
                  <div class="text-base sm:text-lg font-semibold text-white font-mono-code mt-0.5">${
                    files.length
                  } ${files.length === 1 ? "File" : "Files"}</div>
                </div>
                <div class="glass-card px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl sm:min-w-[110px]">
                  <div class="text-[10px] sm:text-[11px] text-slate-400">Package Size</div>
                  <div class="text-base sm:text-lg font-semibold text-white font-mono-code mt-0.5">${formatBytes(
                    totalBytes
                  )}</div>
                </div>
                <div class="glass-card px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl sm:min-w-[125px] col-span-2 sm:col-span-1">
                  <div class="text-[10px] sm:text-[11px] text-slate-400">Approved</div>
                  <div class="text-base sm:text-lg font-semibold text-emerald-400 font-mono-code mt-0.5">${approvedCount} / ${
      files.length
    }</div>
                </div>
                ${
                  share.allowDownload && files.length > 1
                    ? `<button
                        id="client-download-all-btn"
                        class="btn-studio-primary px-4 py-3 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-2 shadow-lg col-span-2 sm:col-span-1"
                      >
                        <i data-lucide="download-cloud" class="w-4 h-4"></i>
                        <span>Download All (${files.length})</span>
                      </button>`
                    : ""
                }
              </div>
            </div>
          </div>

          <!-- Breadcrumbs & Filter Bar -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-5 sm:mb-6">
            <div class="flex items-center gap-1.5 text-xs sm:text-sm flex-wrap">
              ${
                breadcrumbs.length > 0
                  ? breadcrumbs
                      .map(
                        (b, idx) => `
                    ${idx > 0 ? `<span class="text-slate-600">/</span>` : ""}
                    <button
                      data-portal-folder="${escapeHtml(b.id)}"
                      class="px-2.5 py-1 rounded-lg transition inline-flex items-center gap-1.5 ${
                        String(b.id) === String(currentSubfolderId) && activeCategoryFilter === "ALL"
                          ? "bg-white/10 text-white font-medium border border-white/15"
                          : "text-slate-400 hover:text-white hover:bg-white/5"
                      }"
                    >
                      <i data-lucide="folder" class="w-3.5 h-3.5 text-amber-400 shrink-0"></i>
                      <span class="truncate max-w-[140px] sm:max-w-none">${escapeHtml(b.name)}</span>
                    </button>
                  `
                      )
                      .join("")
                  : `<span class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Deliverable Files (${visibleFiles.length})</span>`
              }
            </div>

            <!-- Filter Pills (Horizontally scrollable on mobile) -->
            <div class="flex items-center gap-1.5 bg-white/[0.03] p-1 rounded-xl border border-white/[0.07] overflow-x-auto no-scrollbar w-full sm:w-auto">
              ${[
                { id: "ALL", label: "All Items" },
                { id: "IMAGE", label: "Images" },
                { id: "VIDEO", label: "Videos" },
                { id: "DOCUMENT", label: "Documents" },
                { id: "APPROVED", label: "Approved" },
                { id: "CHANGES_REQUESTED", label: "Needs Revision" },
              ]
                .map(
                  (tab) => `
                  <button
                    data-portal-filter="${tab.id}"
                    class="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 transition ${
                      activeCategoryFilter === tab.id
                        ? "bg-white text-slate-950 shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }"
                  >
                    ${tab.label}
                  </button>
                `
                )
                .join("")}
            </div>
          </div>

          <!-- Subfolders inside Shared Folder (if any) -->
          ${
            activeCategoryFilter === "ALL" && visibleSubfolders.length > 0
              ? `
            <div class="mb-6 sm:mb-8">
              <div class="text-xs font-mono-code uppercase tracking-wider text-slate-400 mb-3">Subfolders (${
                visibleSubfolders.length
              })</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4">
                ${visibleSubfolders
                  .map((fld) => {
                    const c = getFolderColorStyles(fld.color);
                    const subCount = files.filter((f) => f.folderId === fld.id).length;
                    return `
                      <div
                        data-open-subfolder="${escapeHtml(fld.id)}"
                        class="glass-card rounded-xl p-4 cursor-pointer flex items-center justify-between group"
                      >
                        <div class="flex items-center gap-3.5 min-w-0">
                          <div class="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0 ${
                            c.icon
                          }">
                            <i data-lucide="folder" class="w-5 h-5 fill-current opacity-80"></i>
                          </div>
                          <div class="min-w-0">
                            <div class="text-sm font-medium text-white truncate group-hover:text-amber-300 transition">${escapeHtml(
                              fld.name
                            )}</div>
                            <div class="text-xs text-slate-400 font-mono-code">${subCount} ${
                      subCount === 1 ? "deliverable" : "deliverables"
                    }</div>
                          </div>
                        </div>
                        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 group-hover:text-slate-200 transition shrink-0"></i>
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            </div>
          `
              : ""
          }

          <!-- Shared Media Files Grid -->
          <div>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
              ${
                visibleFiles.length === 0
                  ? `<div class="col-span-full glass-panel rounded-2xl p-8 sm:p-12 text-center space-y-3">
                      <div class="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto text-amber-300">
                        <i data-lucide="folder-sync" class="w-6 h-6"></i>
                      </div>
                      <div class="text-base font-medium text-white">
                        ${
                          files.length === 0
                            ? "Live Shared Folder Ready"
                            : "No deliverables match the selected filter"
                        }
                      </div>
                      <p class="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                        ${
                          files.length === 0
                            ? "This folder link is active and connected to the studio workspace. Any new files or subfolders uploaded into this folder will appear here automatically in real time."
                            : "Switch the filter bar above back to All Items to view all deliverables in this folder."
                        }
                      </p>
                    </div>`
                  : visibleFiles
                      .map((file, fileIdx) => {
                        const fileFeedbackCount = feedback.filter(
                          (fb) => fb.fileId === file.id
                        ).length;
                        return `
                          <div
                            data-deliverable-card="true"
                            data-inspect-file="${escapeHtml(file.id || file.name)}"
                            data-file-index="${fileIdx}"
                            data-file-name="${escapeHtml(file.name)}"
                            data-file-id="${escapeHtml(file.id || file.name)}"
                            class="glass-card rounded-2xl overflow-hidden flex flex-col group cursor-pointer hover:border-white/20 transition"
                          >
                            <!-- Media Thumbnail Area -->
                            <div
                              data-inspect-file="${escapeHtml(file.id || file.name)}"
                              data-file-index="${fileIdx}"
                              data-file-name="${escapeHtml(file.name)}"
                              data-file-id="${escapeHtml(file.id || file.name)}"
                              class="relative h-48 sm:h-52 bg-slate-950/70 border-b border-white/[0.07] overflow-hidden flex items-center justify-center cursor-pointer"
                            >
                              ${
                                file.category === "IMAGE"
                                  ? `<img src="${escapeHtml(
                                      file.posterUrl || file.url
                                    )}" alt="${escapeHtml(
                                      file.name
                                    )}" onerror="this.onerror=null;this.src='/sample-media/brand-stills.svg';" class="w-full h-full object-cover group-hover:scale-[1.02] transition duration-300" />`
                                  : file.category === "VIDEO"
                                  ? `<div class="w-full h-full relative flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-black">
                                      ${
                                        file.posterUrl
                                          ? `<img src="${escapeHtml(
                                              file.posterUrl
                                            )}" alt="${escapeHtml(
                                              file.name
                                            )}" class="w-full h-full object-cover opacity-80 group-hover:scale-[1.02] transition duration-300" />`
                                          : `<video src="${escapeHtml(
                                              file.url
                                            )}" muted playsinline preload="metadata" class="w-full h-full object-cover opacity-75 group-hover:scale-[1.02] transition duration-300"></video>`
                                      }
                                      <div class="absolute inset-0 flex items-center justify-center">
                                        <div class="w-12 h-12 rounded-full bg-white/15 backdrop-blur-md border border-white/30 flex items-center justify-center text-white group-hover:scale-105 transition">
                                          <i data-lucide="play" class="w-5 h-5 fill-current ml-0.5"></i>
                                        </div>
                                      </div>
                                    </div>`
                                  : isCodeFile(file.name, file.mimeType)
                                  ? renderCodeCardThumbnail(file)
                                  : `<div class="w-full h-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-slate-900/50 to-slate-950/90">
                                      <div class="w-12 h-14 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-300 mb-2">
                                        <i data-lucide="file-text" class="w-6 h-6"></i>
                                      </div>
                                      <span class="text-[11px] font-mono-code text-slate-400">${escapeHtml(
                                        file.metaLabel || "Document"
                                      )}</span>
                                    </div>`
                              }
                              <div class="absolute top-3 left-3 flex items-center gap-1.5">
                                ${renderCategoryBadge(file.category, file.name)}
                              </div>
                              <div class="absolute top-3 right-3">
                                ${renderApprovalBadge(file.approvalStatus)}
                              </div>
                            </div>

                            <!-- Card Body -->
                            <div class="p-3.5 sm:p-4 flex-1 flex flex-col justify-between space-y-3.5 sm:space-y-4">
                              <div>
                                <div class="text-sm font-medium text-white truncate" title="${escapeHtml(
                                  file.name
                                )}">${escapeHtml(file.name)}</div>
                                <div class="flex items-center gap-2 mt-1 text-xs text-slate-400 font-mono-code">
                                  <span>${formatBytes(file.sizeBytes)}</span>
                                  <span>•</span>
                                  <span class="truncate">${escapeHtml(file.metaLabel || file.mimeType)}</span>
                                </div>
                              </div>

                              <!-- Client Action Footer -->
                              <div class="pt-3 border-t border-white/[0.07] flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  data-inspect-file="${escapeHtml(file.id || file.name)}"
                                  data-file-index="${fileIdx}"
                                  data-file-name="${escapeHtml(file.name)}"
                                  data-file-id="${escapeHtml(file.id || file.name)}"
                                  class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 hover:text-white"
                                >
                                  <i data-lucide="maximize-2" class="w-3.5 h-3.5 text-slate-400"></i>
                                  <span>Inspect & Review</span>
                                  ${
                                    fileFeedbackCount > 0
                                      ? `<span class="ml-1 px-1.5 py-0.2 rounded bg-white/10 text-[10px] font-mono-code">${fileFeedbackCount}</span>`
                                      : ""
                                  }
                                </button>

                                <div class="flex items-center gap-1.5">
                                  ${
                                    share.allowFeedback
                                      ? `<button
                                          data-quick-approve="${escapeHtml(file.id)}"
                                          class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                                            file.approvalStatus === "APPROVED"
                                              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                              : "glass-button text-slate-300 hover:text-emerald-300"
                                          }"
                                          title="Mark Deliverable Approved"
                                        >
                                          <i data-lucide="check" class="w-3.5 h-3.5"></i>
                                        </button>`
                                      : ""
                                  }
                                  ${
                                    share.allowDownload
                                      ? `<button
                                          data-portal-download="${escapeHtml(file.id)}"
                                          class="glass-button px-2.5 py-1.5 rounded-lg text-xs text-slate-300 hover:text-white"
                                          title="Download File"
                                        >
                                          <i data-lucide="download" class="w-3.5 h-3.5"></i>
                                        </button>`
                                      : ""
                                  }
                                </div>
                              </div>
                            </div>
                          </div>
                        `;
                      })
                      .join("")
              }
            </div>
          </div>
        </main>

        <!-- Client Portal Footer -->
        <footer class="px-4 sm:px-6 py-4 border-t border-white/[0.06] text-center text-xs text-slate-400">
          <span>Secure Sharing • Team <strong class="text-slate-200">Tech Titans</strong>: </span>
          <span>Mohammad Asrar, Punit Badyal And Neyashri A</span>
        </footer>
      </div>

      ${activeFileModal ? renderClientFileModal(activeFileModal, share, feedback, clientReviewerName, visibleFiles) : ""}
    `;

    if (window.lucide) window.lucide.createIcons();
    enhanceAppexLogos();

    // Helper to open modal for a deliverable file
    const openFileModal = (targetFile) => {
      if (!targetFile) return;
      activeFileModal = targetFile;
      if (isCodeFile(targetFile.name, targetFile.mimeType)) {
        clientCodePreviewMode = isHtmlFile(targetFile.name) ? "render" : "code";
      }
      render();
    };

    // Infallible file target resolution: index -> name -> id
    const resolveFileTarget = (targetEl) => {
      if (!targetEl) return null;
      const el =
        targetEl.closest("[data-file-index]") ||
        targetEl.closest("[data-inspect-file]") ||
        targetEl.closest("[data-deliverable-card]") ||
        targetEl;

      // 1. Direct index in visibleFiles (fastest & 100% accurate)
      const idxAttr = el.getAttribute("data-file-index");
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== "" && !isNaN(Number(idxAttr))) {
        const idx = Number(idxAttr);
        if (visibleFiles && visibleFiles[idx]) {
          return visibleFiles[idx];
        }
      }

      // 2. File name lookup
      const nameAttr = el.getAttribute("data-file-name");
      if (nameAttr) {
        const byName =
          visibleFiles.find((f) => f && f.name === nameAttr) ||
          files.find((f) => f && f.name === nameAttr) ||
          portalData?.files?.find((f) => f && f.name === nameAttr);
        if (byName) return byName;
      }

      // 3. File ID / inspect-file fallback
      const fid = el.getAttribute("data-file-id") || el.getAttribute("data-inspect-file");
      if (fid && fid !== "undefined" && fid !== "null") {
        const byId =
          visibleFiles.find((f) => f && (String(f.id) === String(fid) || f.name === fid)) ||
          files.find((f) => f && (String(f.id) === String(fid) || f.name === fid)) ||
          portalData?.files?.find((f) => f && (String(f.id) === String(fid) || f.name === fid));
        if (byId) return byId;
      }

      return null;
    };

    const handleInspectClick = (e, triggerEl) => {
      if (e.target.closest("[data-quick-approve]") || e.target.closest("[data-portal-download]")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const targetFile = resolveFileTarget(triggerEl || e.target);
      if (targetFile) {
        openFileModal(targetFile);
      }
    };

    // Bind events
    document
      .getElementById("client-refresh-portal")
      ?.addEventListener("click", async () => {
        await pollLiveFolderUpdates(false);
        showToast("Synced latest deliverables from studio", "success");
      });

    document
      .getElementById("client-download-all-btn")
      ?.addEventListener("click", () => {
        triggerDownloadAllFiles(visibleFiles.length > 0 ? visibleFiles : files);
      });

    rootEl.querySelectorAll("[data-portal-folder]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentSubfolderId = btn.getAttribute("data-portal-folder");
        activeCategoryFilter = "ALL";
        render();
      });
    });

    rootEl.querySelectorAll("[data-open-subfolder]").forEach((card) => {
      card.addEventListener("click", () => {
        currentSubfolderId = card.getAttribute("data-open-subfolder");
        activeCategoryFilter = "ALL";
        render();
      });
    });

    rootEl.querySelectorAll("[data-portal-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeCategoryFilter = btn.getAttribute("data-portal-filter");
        render();
      });
    });

    // Make deliverable cards and inspect buttons clickable
    rootEl.querySelectorAll("[data-deliverable-card]").forEach((card) => {
      card.addEventListener("click", (e) => handleInspectClick(e, card));
    });
    rootEl.querySelectorAll("[data-inspect-file]").forEach((el) => {
      el.addEventListener("click", (e) => handleInspectClick(e, el));
    });

    rootEl.querySelectorAll("[data-quick-approve]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const fid = btn.getAttribute("data-quick-approve");
        await submitClientFeedback(
          fid,
          "APPROVED",
          "Approved directly from the Client Delivery Portal."
        );
      });
    });

    rootEl.querySelectorAll("[data-portal-download]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const fid = btn.getAttribute("data-portal-download");
        const target = files.find((f) => String(f.id) === String(fid) || f.name === fid);
        if (target) await triggerClientDownload(target);
      });
    });

    // Modal bindings
    if (activeFileModal) {
      document.getElementById("close-client-modal")?.addEventListener("click", () => {
        activeFileModal = null;
        render();
      });
      document.getElementById("client-modal-backdrop")?.addEventListener("click", (e) => {
        if (e.target.id === "client-modal-backdrop") {
          activeFileModal = null;
          render();
        }
      });

      // Carousel Prev / Next File Controls
      document.getElementById("modal-prev-file")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const currentIdx = visibleFiles.findIndex(
          (f) => f && (f.id === activeFileModal.id || f.name === activeFileModal.name)
        );
        if (currentIdx > 0) {
          openFileModal(visibleFiles[currentIdx - 1]);
        }
      });

      document.getElementById("modal-next-file")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const currentIdx = visibleFiles.findIndex(
          (f) => f && (f.id === activeFileModal.id || f.name === activeFileModal.name)
        );
        if (currentIdx >= 0 && currentIdx < visibleFiles.length - 1) {
          openFileModal(visibleFiles[currentIdx + 1]);
        }
      });
      document
        .getElementById("modal-client-download")
        ?.addEventListener("click", () => triggerClientDownload(activeFileModal));

      if (
        activeFileModal.category === "VIDEO" &&
        activeFileModal.url &&
        typeof activeFileModal.url === "string" &&
        activeFileModal.url.includes("studio-walkthrough.mp4")
      ) {
        cleanupVideoCanvas = mountSampleCinemaCanvas(
          document.getElementById("sample-cinema-canvas"),
          document.getElementById("sample-cinema-time"),
          document.getElementById("sample-cinema-scrubber"),
          document.getElementById("sample-cinema-play")
        );
      }

      if (isCodeFile(activeFileModal.name, activeFileModal.mimeType)) {
        if (!isHtmlFile(activeFileModal.name) || clientCodePreviewMode === "code") {
          const bodyEl = document.getElementById("code-viewer-body");
          const statsEl = document.getElementById("code-viewer-stats");
          const copyBtn = document.getElementById("btn-copy-code");
          if (bodyEl) {
            fetchAndRenderCodePreview(activeFileModal, bodyEl, statsEl, copyBtn);
          }
        }
      }

      document.getElementById("btn-portal-html-render")?.addEventListener("click", () => {
        clientCodePreviewMode = "render";
        render();
      });
      document.getElementById("btn-portal-html-code")?.addEventListener("click", () => {
        clientCodePreviewMode = "code";
        render();
      });

      document
        .getElementById("client-review-form")
        ?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const nameInput = document.getElementById("client-reviewer-name");
          const statusInput = document.querySelector(
            'input[name="client-review-status"]:checked'
          );
          const commentInput = document.getElementById("client-review-comment");
          if (nameInput?.value.trim()) {
            clientReviewerName = nameInput.value.trim();
            localStorage.setItem("vellum_client_reviewer_name", clientReviewerName);
          }
          const chosenStatus = statusInput ? statusInput.value : "COMMENT";
          const commentVal = commentInput ? commentInput.value.trim() : "";
          await submitClientFeedback(activeFileModal.id, chosenStatus, commentVal);
        });
    }
  }

  window.addEventListener("storage", handleStorageSync);
  liveSyncTimer = setInterval(() => {
    pollLiveFolderUpdates(true);
  }, 4000);

  loadPortal(true);
}

function renderClientFileModal(file, share, allFeedback, clientReviewerName) {
  if (!file) return "";
  const fileFeedback = (allFeedback || []).filter((fb) => fb && String(fb.fileId) === String(file.id));

  return `
    <div id="client-modal-backdrop" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 lg:p-8">
      <div class="glass-modal w-full max-w-6xl h-[92dvh] lg:h-[86vh] rounded-2xl overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row animate-modal">
        <!-- Left Media Stage -->
        <div class="flex-1 bg-slate-950/90 flex flex-col min-h-[250px] sm:min-h-[340px] lg:min-h-0 border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <div class="px-3.5 sm:px-5 py-3 sm:py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-2 sm:gap-4">
            <div class="flex items-center gap-2 min-w-0">
              ${renderCategoryBadge(file.category, file.name)}
              <span class="text-xs sm:text-sm font-medium text-white truncate max-w-[165px] sm:max-w-xs">${escapeHtml(
                file.name
              )}</span>
            </div>
            <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
              ${
                share.allowDownload
                  ? `<button id="modal-client-download" class="glass-button px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5">
                      <i data-lucide="download" class="w-3.5 h-3.5"></i>
                      <span class="hidden sm:inline">Download</span>
                    </button>`
                  : ""
              }
              <button id="close-client-modal" class="glass-button p-1.5 rounded-lg text-slate-400 hover:text-white">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <div class="flex-1 flex items-center justify-center p-3 sm:p-6 overflow-auto min-h-[210px]">
            ${
              file.category === "IMAGE"
                ? `<img src="${escapeHtml(file.url || '')}" alt="${escapeHtml(
                    file.name
                  )}" class="max-w-full max-h-[52vh] lg:max-h-full object-contain rounded-lg shadow-2xl" />`
                : file.category === "VIDEO"
                ? Boolean(file.url && typeof file.url === "string" && file.url.includes("studio-walkthrough.mp4"))
                  ? `<div class="w-full max-w-3xl space-y-3">
                      <canvas id="sample-cinema-canvas" width="960" height="540" class="w-full rounded-xl border border-white/10 shadow-2xl bg-black"></canvas>
                      <div class="glass-panel px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl flex items-center gap-3 sm:gap-4">
                        <button id="sample-cinema-play" type="button" class="btn-studio-primary px-3 py-1 rounded text-xs">Pause</button>
                        <input id="sample-cinema-scrubber" type="range" min="0" max="100" value="0" class="flex-1 accent-amber-400 cursor-pointer" />
                        <span id="sample-cinema-time" class="text-[11px] sm:text-xs font-mono-code text-slate-300">00:00:00 / 00:12:00</span>
                      </div>
                    </div>`
                  : `<video src="${escapeHtml(
                      file.url || ''
                    )}" controls autoplay playsinline class="max-w-full max-h-[52vh] lg:max-h-full rounded-xl border border-white/10 shadow-2xl"></video>`
                : isHtmlFile(file.name)
                ? `
                  <div class="w-full h-full flex flex-col space-y-2.5">
                    <div class="flex items-center justify-between px-1 shrink-0">
                      <div class="inline-flex rounded-lg bg-black/50 border border-white/10 p-0.5 text-xs font-mono-code">
                        <button id="btn-portal-html-render" type="button" class="px-2.5 py-1 rounded-md transition ${clientCodePreviewMode === 'code' ? 'text-slate-400 hover:text-white' : 'bg-white/15 text-white font-medium border border-white/10'}">
                          <span class="inline-flex items-center gap-1.5"><i data-lucide="eye" class="w-3.5 h-3.5 text-amber-400"></i> Rendered View</span>
                        </button>
                        <button id="btn-portal-html-code" type="button" class="px-2.5 py-1 rounded-md transition ${clientCodePreviewMode === 'code' ? 'bg-white/15 text-white font-medium border border-white/10' : 'text-slate-400 hover:text-white'}">
                          <span class="inline-flex items-center gap-1.5"><i data-lucide="code-2" class="w-3.5 h-3.5 text-emerald-400"></i> Source Code</span>
                        </button>
                      </div>
                      <span class="text-[11px] font-mono-code text-slate-400">HTML Review</span>
                    </div>
                    <div class="flex-1 min-h-0">
                      ${
                        clientCodePreviewMode === "code"
                          ? renderCodeViewerContainer(file)
                          : `<iframe src="${escapeHtml(file.url || '')}" class="w-full h-[48vh] lg:h-full rounded-xl border border-white/10 bg-white"></iframe>`
                      }
                    </div>
                  </div>
                `
                : isCodeFile(file.name, file.mimeType)
                ? renderCodeViewerContainer(file)
                : `<iframe src="${escapeHtml(
                    file.url || ''
                  )}" class="w-full h-[48vh] lg:h-full rounded-xl border border-white/10 bg-white"></iframe>`
            }
          </div>
        </div>

        <!-- Right Client Approval & Notes Sidebar -->
        <div class="w-full lg:w-96 flex flex-col bg-slate-950/50 min-h-0">
          <div class="p-4 sm:p-5 border-b border-white/[0.08] flex items-center justify-between">
            <div>
              <div class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Deliverable Status</div>
              <div class="mt-1.5">${renderApprovalBadge(file.approvalStatus)}</div>
            </div>
            <div class="text-right text-xs font-mono-code text-slate-400">
              <div>${formatBytes(file.sizeBytes)}</div>
              <div class="text-[11px] text-slate-500">${escapeHtml(
                file.metaLabel || ""
              )}</div>
            </div>
          </div>

          <!-- Feedback History -->
          <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
            <div class="text-xs font-mono-code uppercase tracking-wider text-slate-400 mb-2">Review & Revision Log (${
              fileFeedback.length
            })</div>
            ${
              fileFeedback.length === 0
                ? `<div class="glass-card rounded-xl p-4 text-xs text-slate-400">
                    No client revision notes logged for this file yet.
                  </div>`
                : fileFeedback
                    .map(
                      (fb) => `
                    <div class="glass-card rounded-xl p-3.5 space-y-1.5">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-xs font-semibold text-white">${escapeHtml(
                          fb.clientName
                        )}</span>
                        <span class="text-[11px] font-mono-code text-slate-500">${formatRelativeTime(
                          fb.createdAt
                        )}</span>
                      </div>
                      <div>${renderApprovalBadge(
                        fb.status === "COMMENT" ? "PENDING" : fb.status
                      )}</div>
                      ${
                        fb.comment
                          ? `<p class="text-xs text-slate-300 leading-relaxed pt-1">${escapeHtml(
                              fb.comment
                            )}</p>`
                          : ""
                      }
                    </div>
                  `
                    )
                    .join("")
            }
          </div>

          <!-- Submit Client Decision Form -->
          ${
            share.allowFeedback
              ? `
            <form id="client-review-form" class="p-4 sm:p-5 border-t border-white/[0.08] space-y-3 bg-white/[0.01]">
              <div>
                <label class="block text-[11px] text-slate-400 mb-1">Your Name / Organization</label>
                <input
                  id="client-reviewer-name"
                  type="text"
                  required
                  value="${escapeHtml(clientReviewerName)}"
                  class="glass-input w-full px-3 py-1.5 rounded-lg text-xs"
                />
              </div>
              <div class="grid grid-cols-2 gap-2">
                <label class="cursor-pointer">
                  <input type="radio" name="client-review-status" value="APPROVED" checked class="peer hidden" />
                  <div class="peer-checked:bg-emerald-500/20 peer-checked:border-emerald-500/40 peer-checked:text-emerald-300 glass-button py-2 px-3 rounded-lg text-xs font-medium text-center">
                    ✓ Approve File
                  </div>
                </label>
                <label class="cursor-pointer">
                  <input type="radio" name="client-review-status" value="CHANGES_REQUESTED" class="peer hidden" />
                  <div class="peer-checked:bg-rose-500/20 peer-checked:border-rose-500/40 peer-checked:text-rose-300 glass-button py-2 px-3 rounded-lg text-xs font-medium text-center">
                    ! Request Changes
                  </div>
                </label>
              </div>
              <div>
                <textarea
                  id="client-review-comment"
                  rows="2"
                  placeholder="Add revision notes, timecode feedback, or sign-off comments…"
                  class="glass-input w-full px-3 py-2 rounded-lg text-xs resize-none"
                ></textarea>
              </div>
              <button type="submit" class="btn-studio-primary w-full py-2.5 rounded-lg text-xs">
                Submit Client Review
              </button>
            </form>
          `
              : ""
          }
        </div>
      </div>
    </div>
  `;
}
