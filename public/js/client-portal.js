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
} from "./ui-helpers.js";

export function createClientPortalController({ rootEl, token, onNavigateDashboard, showToast }) {
  let portalData = null;
  let passwordPromptInfo = null;
  let errorMessage = null;
  let enteredPassword = sessionStorage.getItem(`vellum_pass_${token}`) || "";
  let currentSubfolderId = null;
  let activeCategoryFilter = "ALL";
  let activeFileModal = null;
  let cleanupVideoCanvas = null;
  let clientReviewerName =
    localStorage.getItem("vellum_client_reviewer_name") || "Client Reviewer";

  async function loadPortal(trackView = false) {
    try {
      const url = `/api/public/share/${encodeURIComponent(token)}${
        trackView ? "?track=1" : ""
      }`;
      const res = await fetch(url, {
        headers: enteredPassword ? { "x-share-password": enteredPassword } : {},
      });
      const data = await res.json();

      if (res.status === 401 && data.requiresPassword) {
        passwordPromptInfo = data;
        portalData = null;
        errorMessage = null;
        render();
        return;
      }

      if (!res.ok) {
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
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Could not submit review", "error");
        return;
      }

      // Update local state
      const fileIdx = portalData.files.findIndex((f) => f.id === fileId);
      if (fileIdx !== -1 && data.file) {
        portalData.files[fileIdx] = data.file;
        if (activeFileModal && activeFileModal.id === fileId) {
          activeFileModal = data.file;
        }
      }
      portalData.feedback.unshift(data.feedback);
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
            <button id="portal-back-studio" class="glass-button px-4 py-2.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-2">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
              Return to Studio Workspace
            </button>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      document.getElementById("portal-back-studio")?.addEventListener("click", onNavigateDashboard);
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
                  passwordPromptInfo.studioName || "Appex Studios"
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

    // Filter subfolders and files for current folder view
    const visibleSubfolders =
      share.resourceType === "FOLDER"
        ? folders.filter((f) => f.parentId === currentSubfolderId)
        : [];

    let visibleFiles =
      share.resourceType === "FOLDER"
        ? files.filter((f) => f.folderId === currentSubfolderId)
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
      let ptr = folders.find((f) => f.id === currentSubfolderId);
      while (ptr) {
        breadcrumbs.unshift(ptr);
        if (ptr.id === share.folderId) break;
        ptr = folders.find((f) => f.id === ptr.parentId);
      }
    }

    rootEl.innerHTML = `
      <div class="min-h-screen flex flex-col">
        <!-- Top Frosted Glass Client Header -->
        <header class="glass-header sticky top-0 z-30 px-6 py-4">
          <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-3.5">
              <div class="w-9 h-9 rounded-xl bg-[#080a0f]/90 border border-white/20 flex items-center justify-center shadow-inner p-1 shrink-0">
                <img
                  data-appex-logo="mark"
                  src="/assets/appex-logo.webp"
                  alt="Appex Studios"
                  class="w-full h-full object-contain"
                />
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-xs font-mono-code uppercase tracking-widest text-slate-400">${escapeHtml(
                    share.studioName
                  )}</span>
                  <span class="text-slate-600">•</span>
                  <span class="text-xs text-slate-400">Client Review Portal</span>
                </div>
                <h1 class="text-base font-semibold text-white tracking-tight">${escapeHtml(
                  share.title
                )}</h1>
              </div>
            </div>

            <div class="flex items-center gap-3">
              ${
                share.allowDownload
                  ? `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                      <i data-lucide="download" class="w-3.5 h-3.5"></i>
                      Downloads Permitted
                    </span>`
                  : `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20">
                      <i data-lucide="eye" class="w-3.5 h-3.5"></i>
                      View-Only Protection
                    </span>`
              }
              <button
                id="client-switch-studio"
                class="glass-button px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-300 inline-flex items-center gap-2"
                title="Switch back to Creator Studio Dashboard"
              >
                <i data-lucide="layout-grid" class="w-3.5 h-3.5 text-slate-400"></i>
                <span>Creator Studio View</span>
              </button>
            </div>
          </div>
        </header>

        <!-- Main Deliverable Content -->
        <main class="flex-1 max-w-7xl w-full mx-auto px-6 py-8 animate-view">
          <!-- Deliverable Overview Hero Card -->
          <div class="glass-panel rounded-2xl p-6 mb-8">
            <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div class="space-y-2 max-w-3xl">
                <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span class="font-mono-code uppercase tracking-wider text-amber-300/90">${
                    share.resourceType === "FOLDER" ? "SHARED FOLDER PACKAGE" : "SINGLE DELIVERABLE"
                  }</span>
                  <span>•</span>
                  <span>Prepared by <strong class="text-slate-200 font-medium">${escapeHtml(
                    share.ownerName
                  )}</strong></span>
                  ${
                    share.expiresAt
                      ? `<span>•</span><span>Valid until ${formatDateShort(share.expiresAt)}</span>`
                      : ""
                  }
                </div>
                <h2 class="text-2xl font-semibold text-white tracking-tight">${escapeHtml(
                  share.title
                )}</h2>
                ${
                  share.description
                    ? `<p class="text-sm text-slate-300/90 leading-relaxed">${escapeHtml(
                        share.description
                      )}</p>`
                    : ""
                }
              </div>

              <!-- Deliverable Metrics -->
              <div class="flex flex-wrap items-center gap-3 shrink-0">
                <div class="glass-card px-4 py-3 rounded-xl min-w-[110px]">
                  <div class="text-[11px] text-slate-400">Deliverables</div>
                  <div class="text-lg font-semibold text-white font-mono-code mt-0.5">${
                    files.length
                  } ${files.length === 1 ? "File" : "Files"}</div>
                </div>
                <div class="glass-card px-4 py-3 rounded-xl min-w-[110px]">
                  <div class="text-[11px] text-slate-400">Package Size</div>
                  <div class="text-lg font-semibold text-white font-mono-code mt-0.5">${formatBytes(
                    totalBytes
                  )}</div>
                </div>
                <div class="glass-card px-4 py-3 rounded-xl min-w-[125px]">
                  <div class="text-[11px] text-slate-400">Approved</div>
                  <div class="text-lg font-semibold text-emerald-400 font-mono-code mt-0.5">${approvedCount} / ${
      files.length
    }</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Breadcrumbs & Filter Bar -->
          <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div class="flex items-center gap-1.5 text-sm flex-wrap">
              ${
                breadcrumbs.length > 0
                  ? breadcrumbs
                      .map(
                        (b, idx) => `
                    ${idx > 0 ? `<span class="text-slate-600">/</span>` : ""}
                    <button
                      data-portal-folder="${escapeHtml(b.id)}"
                      class="px-2.5 py-1 rounded-lg transition ${
                        b.id === currentSubfolderId && activeCategoryFilter === "ALL"
                          ? "bg-white/10 text-white font-medium border border-white/15"
                          : "text-slate-400 hover:text-white hover:bg-white/5"
                      }"
                    >
                      ${escapeHtml(b.name)}
                    </button>
                  `
                      )
                      .join("")
                  : `<span class="text-xs font-mono-code uppercase tracking-wider text-slate-400">Deliverable Files</span>`
              }
            </div>

            <!-- Filter Pills -->
            <div class="flex flex-wrap items-center gap-1.5 bg-white/[0.03] p-1 rounded-xl border border-white/[0.07]">
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
                    class="px-3 py-1.5 rounded-lg text-xs font-medium transition ${
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
            <div class="mb-8">
              <div class="text-xs font-mono-code uppercase tracking-wider text-slate-400 mb-3">Subfolders (${
                visibleSubfolders.length
              })</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                          <div class="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center ${
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
                        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 group-hover:text-slate-200 transition"></i>
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
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              ${
                visibleFiles.length === 0
                  ? `<div class="col-span-full glass-panel rounded-2xl p-12 text-center text-slate-400 text-sm">
                      No deliverables match the current filter in this folder.
                    </div>`
                  : visibleFiles
                      .map((file) => {
                        const fileFeedbackCount = feedback.filter(
                          (fb) => fb.fileId === file.id
                        ).length;
                        return `
                          <div class="glass-card rounded-2xl overflow-hidden flex flex-col group">
                            <!-- Media Thumbnail Area -->
                            <div
                              data-inspect-file="${escapeHtml(file.id)}"
                              class="relative h-52 bg-slate-950/70 border-b border-white/[0.07] cursor-pointer overflow-hidden flex items-center justify-center"
                            >
                              ${
                                file.category === "IMAGE"
                                  ? `<img src="${escapeHtml(file.url)}" alt="${escapeHtml(
                                      file.name
                                    )}" class="w-full h-full object-cover group-hover:scale-[1.02] transition duration-300" />`
                                  : file.category === "VIDEO"
                                  ? `<div class="w-full h-full relative flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-black">
                                      <img src="/sample-media/oslo-pavilion.svg" alt="" class="w-full h-full object-cover opacity-55 group-hover:scale-[1.02] transition duration-300" />
                                      <div class="absolute inset-0 flex items-center justify-center">
                                        <div class="w-12 h-12 rounded-full bg-white/15 backdrop-blur-md border border-white/30 flex items-center justify-center text-white group-hover:scale-105 transition">
                                          <i data-lucide="play" class="w-5 h-5 fill-current ml-0.5"></i>
                                        </div>
                                      </div>
                                    </div>`
                                  : `<div class="w-full h-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-slate-900/50 to-slate-950/90">
                                      <div class="w-12 h-14 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-300 mb-2">
                                        <i data-lucide="file-text" class="w-6 h-6"></i>
                                      </div>
                                      <span class="text-[11px] font-mono-code text-slate-400">${escapeHtml(
                                        file.metaLabel || "PDF Document"
                                      )}</span>
                                    </div>`
                              }
                              <div class="absolute top-3 left-3 flex items-center gap-1.5">
                                ${renderCategoryBadge(file.category)}
                              </div>
                              <div class="absolute top-3 right-3">
                                ${renderApprovalBadge(file.approvalStatus)}
                              </div>
                            </div>

                            <!-- Card Body -->
                            <div class="p-4 flex-1 flex flex-col justify-between space-y-4">
                              <div>
                                <div class="text-sm font-medium text-white truncate" title="${escapeHtml(
                                  file.name
                                )}">${escapeHtml(file.name)}</div>
                                <div class="flex items-center gap-2 mt-1 text-xs text-slate-400 font-mono-code">
                                  <span>${formatBytes(file.sizeBytes)}</span>
                                  <span>•</span>
                                  <span>${escapeHtml(file.metaLabel || file.mimeType)}</span>
                                </div>
                              </div>

                              <!-- Client Action Footer -->
                              <div class="pt-3 border-t border-white/[0.07] flex items-center justify-between gap-2">
                                <button
                                  data-inspect-file="${escapeHtml(file.id)}"
                                  class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
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
      </div>

      ${activeFileModal ? renderClientFileModal(activeFileModal, share, feedback, clientReviewerName) : ""}
    `;

    if (window.lucide) window.lucide.createIcons();
    enhanceAppexLogos();

    // Bind events
    document
      .getElementById("client-switch-studio")
      ?.addEventListener("click", onNavigateDashboard);

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

    rootEl.querySelectorAll("[data-inspect-file]").forEach((el) => {
      el.addEventListener("click", () => {
        const fid = el.getAttribute("data-inspect-file");
        activeFileModal = files.find((f) => f.id === fid) || null;
        render();
      });
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
        const target = files.find((f) => f.id === fid);
        if (target) await triggerClientDownload(target);
      });
    });

    // Modal bindings
    if (activeFileModal) {
      document.getElementById("close-client-modal")?.addEventListener("click", () => {
        activeFileModal = null;
        render();
      });
      document
        .getElementById("modal-client-download")
        ?.addEventListener("click", () => triggerClientDownload(activeFileModal));

      if (
        activeFileModal.category === "VIDEO" &&
        activeFileModal.url.includes("studio-walkthrough.mp4")
      ) {
        cleanupVideoCanvas = mountSampleCinemaCanvas(
          document.getElementById("sample-cinema-canvas"),
          document.getElementById("sample-cinema-time"),
          document.getElementById("sample-cinema-scrubber"),
          document.getElementById("sample-cinema-play")
        );
      }

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

  loadPortal(true);
}

function renderClientFileModal(file, share, allFeedback, clientReviewerName) {
  const fileFeedback = allFeedback.filter((fb) => fb.fileId === file.id);

  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 lg:p-8">
      <div class="glass-modal w-full max-w-6xl h-[86vh] rounded-2xl overflow-hidden flex flex-col lg:flex-row animate-modal">
        <!-- Left Media Stage -->
        <div class="flex-1 bg-slate-950/90 flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-white/[0.08]">
          <div class="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-4">
            <div class="flex items-center gap-2.5 min-w-0">
              ${renderCategoryBadge(file.category)}
              <span class="text-sm font-medium text-white truncate">${escapeHtml(
                file.name
              )}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${
                share.allowDownload
                  ? `<button id="modal-client-download" class="glass-button px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 inline-flex items-center gap-1.5">
                      <i data-lucide="download" class="w-3.5 h-3.5"></i>
                      Download
                    </button>`
                  : ""
              }
              <button id="close-client-modal" class="glass-button p-1.5 rounded-lg text-slate-400 hover:text-white">
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
                      <canvas id="sample-cinema-canvas" width="960" height="540" class="w-full rounded-xl border border-white/10 shadow-2xl bg-black"></canvas>
                      <div class="glass-panel px-4 py-2.5 rounded-xl flex items-center gap-4">
                        <button id="sample-cinema-play" type="button" class="btn-studio-primary px-3 py-1 rounded text-xs">Pause</button>
                        <input id="sample-cinema-scrubber" type="range" min="0" max="100" value="0" class="flex-1 accent-amber-400 cursor-pointer" />
                        <span id="sample-cinema-time" class="text-xs font-mono-code text-slate-300">00:00:00 / 00:12:00</span>
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

        <!-- Right Client Approval & Notes Sidebar -->
        <div class="w-full lg:w-96 flex flex-col bg-slate-950/50 min-h-0">
          <div class="p-5 border-b border-white/[0.08] flex items-center justify-between">
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
          <div class="flex-1 overflow-y-auto p-5 space-y-3">
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
            <form id="client-review-form" class="p-5 border-t border-white/[0.08] space-y-3 bg-white/[0.01]">
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
              <button type="submit" class="btn-studio-primary w-full py-2 rounded-lg text-xs">
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
