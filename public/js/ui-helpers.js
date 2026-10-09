// Studio Formatting & UI Helpers
import { getMediaFromVault } from "./firebase-client.js";

export function formatBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

export function formatDateShort(isoString) {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export function formatRelativeTime(isoString) {
  if (!isoString) return "";
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return formatDateShort(isoString);
  } catch {
    return "";
  }
}

export function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const GOOGLE_LOGO_SVG = `
<svg class="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#4285F4" d="M23.49 12.275c0-.85-.075-1.675-.215-2.475H12v4.69h6.445c-.28 1.495-1.125 2.765-2.395 3.615v3.005h3.875c2.265-2.085 3.565-5.16 3.565-8.835z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.955-1.075 7.94-2.91l-3.875-3.005c-1.075.72-2.45 1.15-4.065 1.15-3.125 0-5.775-2.11-6.72-4.945H1.275v3.1A11.996 11.996 0 0 0 12 24z"/>
  <path fill="#FBBC05" d="M5.28 14.29a7.21 7.21 0 0 1 0-4.58V6.61H1.275a12.004 12.004 0 0 0 0 10.78l4.005-3.1z"/>
  <path fill="#EA4335" d="M12 4.765c1.76 0 3.34.605 4.585 1.795l3.435-3.435C17.95 1.19 15.235 0 12 0A11.996 11.996 0 0 0 1.275 6.61l4.005 3.1C6.225 6.875 8.875 4.765 12 4.765z"/>
</svg>`;

let cachedLogoData = null;
let logoPromise = null;

export function enhanceAppexLogos() {
  const applyToDom = (data) => {
    if (!data) return;
    document.querySelectorAll('img[data-appex-logo="mark"]').forEach((img) => {
      if (img.src !== data.markUrl) img.src = data.markUrl;
    });
    document.querySelectorAll('img[data-appex-logo="full"]').forEach((img) => {
      if (img.src !== data.fullUrl) img.src = data.fullUrl;
    });
    if (data.faviconUrl && document.head) {
      let iconEl = document.getElementById("appex-favicon") || document.querySelector('link[rel="icon"]');
      if (!iconEl) {
        iconEl = document.createElement("link");
        iconEl.id = "appex-favicon";
        iconEl.rel = "icon";
        document.head.appendChild(iconEl);
      }
      iconEl.type = "image/png";
      if (iconEl.href !== data.faviconUrl) iconEl.href = data.faviconUrl;

      let shortcutEl =
        document.getElementById("appex-shortcut-icon") ||
        document.querySelector('link[rel="shortcut icon"]');
      if (!shortcutEl) {
        shortcutEl = document.createElement("link");
        shortcutEl.id = "appex-shortcut-icon";
        shortcutEl.rel = "shortcut icon";
        document.head.appendChild(shortcutEl);
      }
      shortcutEl.type = "image/png";
      if (shortcutEl.href !== data.faviconUrl) shortcutEl.href = data.faviconUrl;
    }
  };

  if (cachedLogoData) {
    applyToDom(cachedLogoData);
    return;
  }

  if (!logoPromise) {
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const w = img.naturalWidth || 1024;
          const h = img.naturalHeight || 1024;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);

          const imgData = ctx.getImageData(0, 0, w, h);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            const maxC = Math.max(r, g, b);
            const isRedPlay = r > 60 && r - g > 25;
            if (!isRedPlay) {
              if (maxC <= 34) {
                d[i + 3] = 0;
              } else if (maxC < 62) {
                d[i + 3] = Math.round(((maxC - 34) / (62 - 34)) * 255);
              }
            }
          }
          ctx.putImageData(imgData, 0, 0);

          // Full logo cropped tightly around A + APPEX PRODUCTIONS
          const fullCanvas = document.createElement("canvas");
          const fx = Math.floor(w * 0.12);
          const fy = Math.floor(h * 0.08);
          const fw = Math.floor(w * 0.76);
          const fh = Math.floor(h * 0.82);
          fullCanvas.width = fw;
          fullCanvas.height = fh;
          fullCanvas.getContext("2d").drawImage(canvas, fx, fy, fw, fh, 0, 0, fw, fh);

          // Mark-only logo cropped tightly around the metallic "A" + red play triangle
          const markCanvas = document.createElement("canvas");
          const mx = Math.floor(w * 0.2);
          const my = Math.floor(h * 0.08);
          const mw = Math.floor(w * 0.6);
          const mh = Math.floor(h * 0.54);
          markCanvas.width = mw;
          markCanvas.height = mh;
          markCanvas.getContext("2d").drawImage(canvas, mx, my, mw, mh, 0, 0, mw, mh);

          // 64x64 Square Browser Tab Favicon with sleek studio badge background
          const favCanvas = document.createElement("canvas");
          favCanvas.width = 64;
          favCanvas.height = 64;
          const fctx = favCanvas.getContext("2d");
          fctx.fillStyle = "#080a0f";
          fctx.beginPath();
          if (typeof fctx.roundRect === "function") {
            fctx.roundRect(0, 0, 64, 64, 14);
          } else {
            fctx.rect(0, 0, 64, 64);
          }
          fctx.fill();
          fctx.strokeStyle = "rgba(255,255,255,0.18)";
          fctx.lineWidth = 2;
          fctx.stroke();
          fctx.drawImage(markCanvas, 0, 0, mw, mh, 5, 7, 54, 50);

          cachedLogoData = {
            fullUrl: fullCanvas.toDataURL("image/png"),
            markUrl: markCanvas.toDataURL("image/png"),
            faviconUrl: favCanvas.toDataURL("image/png"),
          };
          resolve(cachedLogoData);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = "/assets/appex-logo.webp";
    });
  }

  logoPromise.then(applyToDom);
}

export function getFolderColorStyles(color = "amber") {
  const map = {
    amber: {
      icon: "text-amber-400",
      badge: "bg-amber-500/10 text-amber-300 border-amber-500/20",
      dot: "bg-amber-400",
    },
    emerald: {
      icon: "text-emerald-400",
      badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
      dot: "bg-emerald-400",
    },
    blue: {
      icon: "text-sky-400",
      badge: "bg-sky-500/10 text-sky-300 border-sky-500/20",
      dot: "bg-sky-400",
    },
    rose: {
      icon: "text-rose-400",
      badge: "bg-rose-500/10 text-rose-300 border-rose-500/20",
      dot: "bg-rose-400",
    },
    slate: {
      icon: "text-slate-300",
      badge: "bg-slate-500/10 text-slate-300 border-slate-500/20",
      dot: "bg-slate-400",
    },
    stone: {
      icon: "text-stone-300",
      badge: "bg-stone-500/10 text-stone-300 border-stone-500/20",
      dot: "bg-stone-400",
    },
  };
  return map[color] || map.amber;
}

export function renderApprovalBadge(status = "PENDING") {
  if (status === "APPROVED") {
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/12 text-emerald-300 border border-emerald-500/25">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
      Approved
    </span>`;
  }
  if (status === "CHANGES_REQUESTED") {
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/12 text-rose-300 border border-rose-500/25">
      <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
      Revision Needed
    </span>`;
  }
  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-white/[0.05] text-slate-300 border border-white/[0.09]">
    <span class="w-1.5 h-1.5 rounded-full bg-amber-400/80"></span>
    Awaiting Review
  </span>`;
}

export function renderCategoryBadge(category = "IMAGE", filename = "") {
  if (category === "VIDEO") {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono-code uppercase tracking-wider bg-sky-500/15 text-sky-300 border border-sky-500/25">VIDEO</span>`;
  }
  if (category === "CODE" || isCodeFile(filename)) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono-code uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">CODE</span>`;
  }
  if (category === "DOCUMENT") {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono-code uppercase tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/25">DOC</span>`;
  }
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono-code uppercase tracking-wider bg-slate-500/20 text-slate-200 border border-white/10">IMAGE</span>`;
}

/**
 * Mounts an interactive 60fps Architectural Walkthrough Cinema Player
 * for the built-in sample 4K video so users can test video playback & scrubbing immediately.
 */
export function mountSampleCinemaCanvas(canvasEl, timeLabelEl, scrubberEl, playBtnEl) {
  if (!canvasEl) return () => {};
  const ctx = canvasEl.getContext("2d");
  let isPlaying = true;
  let progress = 0; // 0 to 12 seconds
  const duration = 12;
  let rafId = null;
  let lastTs = performance.now();

  function formatTimecode(sec) {
    const whole = Math.floor(sec);
    const frames = Math.floor((sec - whole) * 24);
    return `00:${String(whole).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
  }

  function drawFrame(t) {
    const w = canvasEl.width;
    const h = canvasEl.height;
    const norm = (t % duration) / duration;
    const panX = Math.sin(norm * Math.PI * 2) * 55;

    // Twilight sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.68);
    sky.addColorStop(0, "#070c17");
    sky.addColorStop(0.6, "#142238");
    sky.addColorStop(1, "#243752");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Distant fjord horizon
    ctx.fillStyle = "#0c1320";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.66);
    ctx.lineTo(w * 0.25 - panX * 0.3, h * 0.48);
    ctx.lineTo(w * 0.58 - panX * 0.3, h * 0.59);
    ctx.lineTo(w * 0.85 - panX * 0.3, h * 0.45);
    ctx.lineTo(w, h * 0.54);
    ctx.lineTo(w, h * 0.66);
    ctx.closePath();
    ctx.fill();

    // Pavilion warm glass volume with subtle camera glide
    const px = w * 0.18 + panX;
    const pw = w * 0.64;
    const py = h * 0.34;
    const ph = h * 0.31;

    const glow = ctx.createLinearGradient(px, py, px + pw, py + ph);
    glow.addColorStop(0, "rgba(251, 191, 36, 0.88)");
    glow.addColorStop(0.55, "rgba(245, 158, 11, 0.62)");
    glow.addColorStop(1, "rgba(234, 88, 12, 0.32)");
    ctx.fillStyle = glow;
    ctx.fillRect(px, py, pw, ph);

    // Roofline cantilever
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(px - 36, py - 14, pw + 72, 14);

    // Mullions
    ctx.fillStyle = "#0f172a";
    for (let i = 0; i <= 5; i++) {
      const mx = px + (pw / 5) * i;
      ctx.fillRect(mx - 4, py, 8, ph);
    }

    // Water reflection
    const water = ctx.createLinearGradient(0, h * 0.65, 0, h);
    water.addColorStop(0, "#0e1624");
    water.addColorStop(1, "#05070b");
    ctx.fillStyle = water;
    ctx.fillRect(0, h * 0.65, w, h * 0.35);

    ctx.fillStyle = "rgba(245, 158, 11, 0.18)";
    ctx.fillRect(px, h * 0.66, pw, h * 0.22);

    // Cinema Timecode Overlay
    ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
    ctx.fillRect(24, 24, 280, 34);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "13px 'JetBrains Mono', monospace";
    ctx.fillText(`REC • 4K UHD 24FPS • TC ${formatTimecode(t)}`, 36, 46);
  }

  function updateUi() {
    if (timeLabelEl) {
      timeLabelEl.textContent = `${formatTimecode(progress)} / 00:12:00`;
    }
    if (scrubberEl) {
      scrubberEl.value = String(Math.round((progress / duration) * 100));
    }
    if (playBtnEl) {
      playBtnEl.textContent = isPlaying ? "Pause" : "Play";
    }
  }

  function loop(now) {
    const dt = (now - lastTs) / 1000;
    lastTs = now;
    if (isPlaying) {
      progress = (progress + dt) % duration;
      drawFrame(progress);
      updateUi();
    }
    rafId = requestAnimationFrame(loop);
  }

  drawFrame(progress);
  updateUi();
  rafId = requestAnimationFrame(loop);

  if (playBtnEl) {
    playBtnEl.onclick = () => {
      isPlaying = !isPlaying;
      updateUi();
    };
  }
  if (scrubberEl) {
    scrubberEl.oninput = (e) => {
      progress = (Number(e.target.value) / 100) * duration;
      drawFrame(progress);
      updateUi();
    };
  }

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
  };
}

// ============================================================================
// CODE FILE PREVIEW & SYNTAX HELPERS
// ============================================================================

export const CODE_EXTENSIONS = new Set([
  "html", "htm", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "pyw",
  "java", "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "php", "rb", "go",
  "rs", "swift", "kt", "kts", "scala", "sql", "sh", "bash", "zsh", "ps1",
  "bat", "cmd", "css", "scss", "sass", "less", "json", "jsonc", "xml",
  "yaml", "yml", "toml", "ini", "env", "md", "markdown", "txt", "log",
  "dockerfile", "makefile", "vue", "svelte"
]);

export function isCodeFile(filename = "", mimeType = "") {
  if (!filename && !mimeType) return false;
  const name = String(filename || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (CODE_EXTENSIONS.has(ext)) return true;
  const lowerName = name.toLowerCase();
  if (lowerName === "dockerfile" || lowerName === "makefile" || lowerName.startsWith(".env")) return true;
  const lowerMime = String(mimeType || "").toLowerCase();
  if (lowerMime && (lowerMime.startsWith("text/") || lowerMime.includes("javascript") || lowerMime.includes("json") || lowerMime.includes("xml"))) return true;
  return false;
}

export function isHtmlFile(filename = "") {
  const name = String(filename || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return ext === "html" || ext === "htm";
}

export function getCodeLanguage(filename = "") {
  const name = String(filename || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const map = {
    html: "HTML", htm: "HTML",
    js: "JavaScript", jsx: "React JSX", mjs: "JavaScript", cjs: "CommonJS",
    ts: "TypeScript", tsx: "React TSX",
    py: "Python", pyw: "Python",
    java: "Java",
    c: "C", cpp: "C++", cc: "C++", cxx: "C++", h: "C Header", hpp: "C++ Header",
    cs: "C#", php: "PHP", rb: "Ruby", go: "Go", rs: "Rust",
    swift: "Swift", kt: "Kotlin", scala: "Scala",
    sql: "SQL", sh: "Shell", bash: "Bash", zsh: "Zsh", ps1: "PowerShell", bat: "Batch",
    css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
    json: "JSON", jsonc: "JSON", xml: "XML", yaml: "YAML", yml: "YAML",
    toml: "TOML", ini: "INI", env: "ENV", md: "Markdown", txt: "Plain Text", log: "Log"
  };
  return map[ext] || (ext ? ext.toUpperCase() : "Code");
}

export function lookupMimeType(filename = "", fallback = "application/octet-stream") {
  const name = String(filename || "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const map = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    cjs: "application/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    tsx: "text/plain; charset=utf-8",
    jsx: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    py: "text/plain; charset=utf-8",
    java: "text/plain; charset=utf-8",
    c: "text/plain; charset=utf-8",
    cpp: "text/plain; charset=utf-8",
    cs: "text/plain; charset=utf-8",
    php: "text/plain; charset=utf-8",
    rb: "text/plain; charset=utf-8",
    go: "text/plain; charset=utf-8",
    rs: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    sh: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
  };
  return map[ext] || fallback;
}

export function escapeCodeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function highlightCodeLine(rawCode = "", ext = "") {
  const isPythonOrShell = ["py", "sh", "bash", "yml", "yaml", "rb"].includes(ext);

  if (isPythonOrShell) {
    const hashIdx = rawCode.indexOf("#");
    if (hashIdx !== -1) {
      const codePart = rawCode.slice(0, hashIdx);
      const commentPart = rawCode.slice(hashIdx);
      return highlightCodeTokens(codePart, ext) + `<span class="text-slate-500 italic">${escapeCodeHtml(commentPart)}</span>`;
    }
  } else {
    const slashIdx = rawCode.indexOf("//");
    if (slashIdx !== -1) {
      const codePart = rawCode.slice(0, slashIdx);
      const commentPart = rawCode.slice(slashIdx);
      return highlightCodeTokens(codePart, ext) + `<span class="text-slate-500 italic">${escapeCodeHtml(commentPart)}</span>`;
    }
  }

  return highlightCodeTokens(rawCode, ext);
}

function highlightCodeTokens(code = "", ext = "") {
  let escaped = escapeCodeHtml(code);

  // String literals
  escaped = escaped.replace(/(["'`])((?:\\.|[^\\])*?)\1/g, '<span class="text-emerald-300">$1$2$1</span>');

  // Keywords
  const keywordsRegex = /\b(def|class|return|import|from|as|function|const|let|var|if|else|elif|for|while|try|catch|finally|throw|raise|async|await|yield|in|of|typeof|instanceof|new|this|self|public|private|protected|static|void|int|float|double|char|string|bool|boolean|struct|interface|type|enum|package|namespace|using|extends|implements|export|default|null|true|false|None|True|False|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|AND|OR|NOT)\b/g;
  escaped = escaped.replace(keywordsRegex, '<span class="text-pink-400 font-semibold">$1</span>');

  // Numbers
  escaped = escaped.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="text-amber-300">$1</span>');

  // Function calls
  escaped = escaped.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g, '<span class="text-sky-300">$1</span>');

  return escaped;
}

export function renderCodeCardThumbnail(file) {
  const lang = getCodeLanguage(file.name);
  return `
    <div class="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-b from-[#090d16] to-[#04060b] border border-white/[0.04] group-hover:border-emerald-500/20 transition relative">
      <div class="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center text-emerald-400 mb-2 shadow-inner group-hover:scale-105 transition">
        <i data-lucide="code-2" class="w-6 h-6"></i>
      </div>
      <div class="text-[11px] font-mono-code text-emerald-300 font-semibold tracking-wider">${escapeCodeHtml(lang)}</div>
      <span class="text-[10px] font-mono-code text-slate-400 mt-0.5 truncate max-w-[140px]">${escapeCodeHtml(file.metaLabel || "Source Code")}</span>
    </div>
  `;
}

export function renderCodeViewerContainer(file) {
  const lang = getCodeLanguage(file.name);
  return `
    <div class="w-full h-[50vh] lg:h-full rounded-xl border border-white/10 bg-[#080b11] flex flex-col overflow-hidden shadow-2xl">
      <!-- Code Stage Header -->
      <div class="px-3.5 sm:px-4 py-2.5 bg-black/60 border-b border-white/[0.08] flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block"></span>
          </div>
          <span class="ml-1.5 px-2 py-0.5 rounded text-[10px] font-mono-code font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 shrink-0">${escapeCodeHtml(lang)}</span>
          <span class="text-xs font-mono-code text-slate-300 truncate">${escapeCodeHtml(file.name)}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span id="code-viewer-stats" class="text-[10px] sm:text-[11px] font-mono-code text-slate-400">Loading code…</span>
          <button id="btn-copy-code" type="button" class="glass-button px-2 sm:px-2.5 py-1 rounded text-[10px] sm:text-[11px] font-mono-code text-slate-200 hover:text-white inline-flex items-center gap-1">
            <i data-lucide="copy" class="w-3 h-3"></i>
            <span>Copy</span>
          </button>
        </div>
      </div>
      <!-- Code Lines Body -->
      <div id="code-viewer-body" class="flex-1 overflow-auto bg-[#07090e] p-2 sm:p-3 text-slate-200">
        <div class="flex items-center justify-center h-full text-slate-400 text-xs font-mono-code gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
          <span>Loading code preview…</span>
        </div>
      </div>
    </div>
  `;
}

export async function fetchAndRenderCodePreview(file, containerEl, statsEl, copyBtnEl) {
  if (!containerEl) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  let text = file._cachedText || null;

  if (!text) {
    // 1. Try vault IndexedDB
    try {
      if (typeof getMediaFromVault === "function") {
        const rec = await getMediaFromVault(file.id, file.name);
        if (rec?.blob instanceof Blob) {
          text = await rec.blob.text();
        } else if (rec?.dataUrl) {
          text = decodeDataUrl(rec.dataUrl);
        }
      }
    } catch (e) {}

    // 2. Try fetching URL
    if (!text && file.url) {
      if (file.url.startsWith("data:")) {
        text = decodeDataUrl(file.url);
      } else {
        try {
          const res = await fetch(file.url);
          if (res.ok) {
            text = await res.text();
          }
        } catch (e) {}
      }
    }
  }

  if (text == null) {
    containerEl.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full p-8 text-center space-y-3">
        <i data-lucide="file-code" class="w-10 h-10 text-slate-500"></i>
        <div class="text-xs text-slate-400 font-mono-code">Code content cannot be read directly. Download the file to view.</div>
        <a href="${escapeCodeHtml(file.url)}" download="${escapeCodeHtml(file.name)}" class="btn-studio-primary px-4 py-1.5 rounded-lg text-xs font-mono-code">Download ${escapeCodeHtml(file.name)}</a>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  file._cachedText = text;

  const lines = text.split(/\r?\n/);
  if (statsEl) {
    statsEl.textContent = `${lines.length} lines • ${formatBytes(new Blob([text]).size)}`;
  }

  if (copyBtnEl) {
    copyBtnEl.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        const span = copyBtnEl.querySelector("span");
        if (span) span.textContent = "Copied!";
        setTimeout(() => {
          if (span) span.textContent = "Copy";
        }, 2000);
      } catch (err) {}
    };
  }

  // Render line numbers and code
  const lineNumbersHtml = lines
    .map((_, i) => `<div class="leading-6">${i + 1}</div>`)
    .join("");

  const codeLinesHtml = lines
    .map((line) => `<div class="leading-6">${highlightCodeLine(line, ext) || "&nbsp;"}</div>`)
    .join("");

  containerEl.innerHTML = `
    <div class="w-full flex min-w-full font-mono-code text-[11px] sm:text-xs leading-6">
      <div class="select-none py-1 px-3 sm:px-4 text-right text-slate-600 border-r border-white/10 shrink-0 font-mono-code bg-black/20">
        ${lineNumbersHtml}
      </div>
      <div class="py-1 px-3 sm:px-4 flex-1 overflow-x-auto text-slate-200 select-text whitespace-pre font-mono-code">
        ${codeLinesHtml}
      </div>
    </div>
  `;

  if (window.lucide) window.lucide.createIcons();
}

function decodeDataUrl(dataUrl = "") {
  try {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return null;
    const meta = dataUrl.slice(0, commaIdx);
    const data = dataUrl.slice(commaIdx + 1);
    if (meta.includes(";base64")) {
      return decodeURIComponent(escape(atob(data)));
    }
    return decodeURIComponent(data);
  } catch (e) {
    try {
      const commaIdx = dataUrl.indexOf(",");
      return atob(dataUrl.slice(commaIdx + 1));
    } catch {
      return null;
    }
  }
}
