import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

const FIVE_GB_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB Firebase Free Tier

// Ensure directories exist
for (const dir of [DATA_DIR, PUBLIC_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Parse .env or .env.local if present
function loadEnvFile() {
  const envVars = {};
  for (const file of [".env.local", ".env"]) {
    const fullPath = path.join(__dirname, file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (val) envVars[key] = val;
        }
      }
    }
  }
  return envVars;
}

// Initial clean production workspace state
function getInitialSeedData() {
  return {
    folders: [],
    files: [],
    shares: [],
    feedback: [],
  };
}

const LEGACY_SAMPLE_FILE_IDS = new Set(["file-1", "file-2", "file-3", "file-4"]);
const LEGACY_SAMPLE_FOLDER_IDS = new Set(["fld-1", "fld-2", "fld-3"]);
const LEGACY_SAMPLE_SHARE_IDS = new Set(["shr-sample-folder-1"]);
const LEGACY_SAMPLE_FEEDBACK_IDS = new Set(["fb-1", "fb-2"]);

function sanitizeDb(parsed = {}) {
  const files = (Array.isArray(parsed.files) ? parsed.files : []).filter(
    (f) => f && f.id && !LEGACY_SAMPLE_FILE_IDS.has(f.id)
  );
  const usedFolders = new Set(files.map((f) => f.folderId).filter(Boolean));
  const folders = (Array.isArray(parsed.folders) ? parsed.folders : []).filter(
    (fld) => fld && fld.id && (!LEGACY_SAMPLE_FOLDER_IDS.has(fld.id) || usedFolders.has(fld.id))
  );
  const shares = (Array.isArray(parsed.shares) ? parsed.shares : []).filter(
    (s) => s && s.id && !LEGACY_SAMPLE_SHARE_IDS.has(s.id)
  );
  const feedback = (Array.isArray(parsed.feedback) ? parsed.feedback : []).filter(
    (fb) => fb && fb.id && !LEGACY_SAMPLE_FEEDBACK_IDS.has(fb.id)
  );
  return { folders, files, shares, feedback };
}

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const seed = getInitialSeedData();
      fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), "utf-8");
      return seed;
    }
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    return sanitizeDb(JSON.parse(raw));
  } catch (err) {
    console.error("Failed reading DB, re-initializing:", err);
    return getInitialSeedData();
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function classifyMimeType(mimeType = "", filename = "") {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (
    lowerMime.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp", ".avif", ".tiff"].includes(ext)
  ) {
    return "IMAGE";
  }
  if (
    [".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"].includes(ext) ||
    (lowerMime.startsWith("video/") && ext !== ".ts")
  ) {
    return "VIDEO";
  }
  return "DOCUMENT";
}

function getDefaultMetaLabel(category, mimeType, filename) {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  const upperExt = ext.toUpperCase() || "FILE";
  if (category === "IMAGE") return `${upperExt} • High-Res Image`;
  if (category === "VIDEO") return `${upperExt} • Video Stream`;

  const codeExtMap = {
    html: "HTML • Web Document",
    htm: "HTML • Web Document",
    js: "JS • JavaScript",
    jsx: "JSX • React Component",
    ts: "TS • TypeScript",
    tsx: "TSX • React Component",
    py: "PY • Python Code",
    css: "CSS • Stylesheet",
    scss: "SCSS • Stylesheet",
    json: "JSON • Data File",
    java: "JAVA • Java Source",
    c: "C • C Source",
    cpp: "CPP • C++ Source",
    h: "H • Header File",
    hpp: "HPP • C++ Header",
    cs: "CS • C# Source",
    php: "PHP • PHP Script",
    rb: "RB • Ruby Script",
    go: "GO • Go Source",
    rs: "RS • Rust Source",
    sql: "SQL • Database Script",
    sh: "SH • Shell Script",
    bat: "BAT • Batch Script",
    ps1: "PS1 • PowerShell Script",
    xml: "XML • XML File",
    yaml: "YAML • Config File",
    yml: "YML • Config File",
    md: "MD • Markdown Doc",
    txt: "TXT • Plain Text",
  };

  if (codeExtMap[ext]) {
    return codeExtMap[ext];
  }

  return `${upperExt} • Document`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf-8");
        resolve(str ? JSON.parse(str) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Generate bespoke architectural & product SVG photography for built-in samples
function getSampleSvg(name) {
  if (name === "oslo-pavilion.svg") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0a111f"/>
          <stop offset="55%" stop-color="#182740"/>
          <stop offset="100%" stop-color="#2c3e55"/>
        </linearGradient>
        <linearGradient id="warmGlow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.9"/>
          <stop offset="50%" stop-color="#f59e0b" stop-opacity="0.65"/>
          <stop offset="100%" stop-color="#ea580c" stop-opacity="0.25"/>
        </linearGradient>
        <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#111926"/>
          <stop offset="100%" stop-color="#06090e"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="680" fill="url(#sky)"/>
      <circle cx="1220" cy="210" r="240" fill="#38bdf8" opacity="0.06"/>
      <!-- Distant Fjord Mountains -->
      <polygon points="0,680 0,520 280,430 590,560 950,410 1320,510 1600,450 1600,680" fill="#0f1724"/>
      <!-- Cantilevered Glass Pavilion Structure -->
      <rect x="240" y="340" width="1120" height="24" fill="#cbd5e1"/>
      <rect x="220" y="330" width="1160" height="10" fill="#f8fafc"/>
      <!-- Warm Lit Glass Volume -->
      <rect x="290" y="364" width="1020" height="296" fill="url(#warmGlow)"/>
      <!-- Architectural Mullions & Columns -->
      <g fill="#0f172a" opacity="0.85">
        <rect x="290" y="364" width="14" height="296"/>
        <rect x="490" y="364" width="8" height="296"/>
        <rect x="690" y="364" width="8" height="296"/>
        <rect x="890" y="364" width="12" height="296"/>
        <rect x="1090" y="364" width="8" height="296"/>
        <rect x="1296" y="364" width="14" height="296"/>
        <rect x="290" y="520" width="1020" height="6"/>
      </g>
      <!-- Interior Minimalist Stair & Gallery Silhouette -->
      <polygon points="520,660 720,522 760,522 560,660" fill="#1e293b" opacity="0.85"/>
      <!-- Concrete Plinth -->
      <rect x="180" y="660" width="1240" height="32" fill="#334155"/>
      <!-- Fjord Water Reflection -->
      <rect y="692" width="1600" height="308" fill="url(#water)"/>
      <rect x="290" y="692" width="1020" height="190" fill="url(#warmGlow)" opacity="0.24"/>
      <g fill="#090d14" opacity="0.55">
        <rect x="200" y="720" width="1200" height="4"/>
        <rect x="260" y="756" width="1080" height="6"/>
        <rect x="310" y="802" width="980" height="8"/>
        <rect x="380" y="855" width="840" height="12"/>
      </g>
      <text x="60" y="945" fill="#94a3b8" font-family="monospace" font-size="18" letter-spacing="3">OSLO FJORD PAVILION • EXT_DUSK_01 • 6000x4000 RAW</text>
    </svg>`;
  }

  if (name === "atrium-light.svg") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%">
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1e242d"/>
          <stop offset="100%" stop-color="#0d1015"/>
        </linearGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f8fafc" stop-opacity="0.38"/>
          <stop offset="60%" stop-color="#e2e8f0" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#94a3b8" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#wall)"/>
      <!-- Board-formed Concrete Lines -->
      <g stroke="#ffffff" stroke-opacity="0.05" stroke-width="2">
        <line x1="200" y1="0" x2="200" y2="820"/>
        <line x1="400" y1="0" x2="400" y2="820"/>
        <line x1="600" y1="0" x2="600" y2="820"/>
        <line x1="800" y1="0" x2="800" y2="820"/>
        <line x1="1000" y1="0" x2="1000" y2="820"/>
        <line x1="1200" y1="0" x2="1200" y2="820"/>
        <line x1="1400" y1="0" x2="1400" y2="820"/>
      </g>
      <!-- Skylight Architectural Cutout & Sunbeams -->
      <polygon points="480,0 820,0 1380,820 880,820" fill="url(#beam)"/>
      <polygon points="880,0 1120,0 1560,820 1240,820" fill="url(#beam)" opacity="0.7"/>
      <!-- Minimalist Monolith Bench -->
      <rect x="640" y="730" width="460" height="55" fill="#334155"/>
      <rect x="640" y="730" width="460" height="6" fill="#cbd5e1" opacity="0.6"/>
      <rect x="680" y="785" width="40" height="35" fill="#0f172a"/>
      <rect x="1020" y="785" width="40" height="35" fill="#0f172a"/>
      <!-- Polished Concrete Floor -->
      <rect y="820" width="1600" height="180" fill="#090b0f"/>
      <polygon points="880,820 1380,820 1520,1000 960,1000" fill="#f8fafc" opacity="0.08"/>
      <text x="60" y="945" fill="#94a3b8" font-family="monospace" font-size="18" letter-spacing="3">ATRIUM LIGHT STUDY 04 • NATURAL DAYLIGHT • ISO 64</text>
    </svg>`;
  }

  if (name === "facade-detail.svg") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%">
      <rect width="1600" height="1000" fill="#0c1118"/>
      <g stroke="#334155" stroke-width="3">
        <rect x="120" y="80" width="420" height="840" fill="#131c29"/>
        <rect x="580" y="80" width="440" height="840" fill="#172233"/>
        <rect x="1060" y="80" width="420" height="840" fill="#111926"/>
      </g>
      <!-- Brushed Anodized Mullions -->
      <rect x="545" y="60" width="30" height="880" fill="#64748b"/>
      <rect x="1025" y="60" width="30" height="880" fill="#64748b"/>
      <rect x="100" y="485" width="1400" height="26" fill="#475569"/>
      <!-- Diagonal Sky Reflection -->
      <polygon points="580,80 890,80 580,480" fill="#38bdf8" opacity="0.1"/>
      <polygon points="1060,511 1480,511 1480,920" fill="#f59e0b" opacity="0.08"/>
      <text x="120" y="965" fill="#94a3b8" font-family="monospace" font-size="18" letter-spacing="3">ANODIZED CURTAIN WALL DETAIL • 90MM TILT-SHIFT</text>
    </svg>`;
  }

  // Default: chronograph-macro.svg
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%">
    <defs>
      <radialGradient id="dial" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#1e2636"/>
        <stop offset="70%" stop-color="#0e131b"/>
        <stop offset="100%" stop-color="#07090d"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="#080a0e"/>
    <!-- Brushed Steel Bezel -->
    <circle cx="800" cy="500" r="390" fill="none" stroke="#475569" stroke-width="36"/>
    <circle cx="800" cy="500" r="370" fill="url(#dial)" stroke="#94a3b8" stroke-width="2"/>
    <!-- Subdials -->
    <circle cx="650" cy="500" r="92" fill="#0b0f17" stroke="#334155" stroke-width="2"/>
    <circle cx="950" cy="500" r="92" fill="#0b0f17" stroke="#334155" stroke-width="2"/>
    <circle cx="800" cy="645" r="82" fill="#0b0f17" stroke="#334155" stroke-width="2"/>
    <!-- Indices -->
    <g stroke="#e2e8f0" stroke-width="6" stroke-linecap="round">
      <line x1="800" y1="165" x2="800" y2="210"/>
      <line x1="800" y1="790" x2="800" y2="835"/>
      <line x1="465" y1="500" x2="510" y2="500"/>
      <line x1="1090" y1="500" x2="1135" y2="500"/>
    </g>
    <!-- Watch Hands -->
    <line x1="800" y1="500" x2="690" y2="320" stroke="#f8fafc" stroke-width="14" stroke-linecap="round"/>
    <line x1="800" y1="500" x2="1010" y2="375" stroke="#cbd5e1" stroke-width="10" stroke-linecap="round"/>
    <line x1="800" y1="560" x2="800" y2="205" stroke="#f59e0b" stroke-width="3"/>
    <circle cx="800" cy="500" r="16" fill="#f59e0b"/>
    <circle cx="800" cy="500" r="6" fill="#0f172a"/>
    <text x="800" y="340" text-anchor="middle" fill="#94a3b8" font-family="monospace" font-size="16" letter-spacing="6">ATELIER GENÈVE</text>
    <text x="60" y="945" fill="#94a3b8" font-family="monospace" font-size="18" letter-spacing="3">CALIBRE 89 MACRO • 100MM F/2.8 • FOCUS STACK</text>
  </svg>`;
}

// Generate a real, valid PDF document byte buffer for in-browser PDF previewing
function generateSamplePdfBuffer() {
  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 612 792] /Contents 6 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];

  const streamContent = [
    "BT",
    "/F1 18 Tf 54 720 Td (TECH TITANS - DELIVERABLE SPECIFICATION) Tj",
    "/F2 11 Tf 0 -28 Td (Project: 01 - Nordic Pavilion Architectural Documentation) Tj",
    "0 -18 Td (Prepared for: Client Review & Sign-Off Portal) Tj",
    "0 -32 Td /F1 13 Tf (1. Deliverable Package Overview) Tj",
    "/F2 11 Tf 0 -20 Td (- Exterior Dusk Master Still: 6000 x 4000 px, 16-bit TIFF / SVG Preview) Tj",
    "0 -16 Td (- Atrium Natural Daylight Study: 4800 x 3200 px, Color Calibrated) Tj",
    "0 -16 Td (- Curtain Wall Mullion Detail: 4500 x 3000 px, Architectural Ortho) Tj",
    "0 -16 Td (- Director Walkthrough Cut: 4K UHD 24fps Master Stream) Tj",
    "0 -32 Td /F1 13 Tf (2. Client Review & Approval Protocol) Tj",
    "/F2 11 Tf 0 -20 Td (Please inspect each asset in the Secure Sharing Client Portal by Team Tech Titans.) Tj",
    "0 -16 Td (Use the 'Approve Deliverable' or 'Request Revision' controls on the right panel) Tj",
    "0 -16 Td (to log frame-accurate or print-retouching notes directly to our studio workspace.) Tj",
    "0 -32 Td /F1 13 Tf (3. Storage & Delivery Security) Tj",
    "/F2 11 Tf 0 -20 Td (Hosted via Firebase Cloud Storage with Google OAuth 2.0 Studio Verification.) Tj",
    "ET",
  ].join("\n");

  const streamObj = `6 0 obj << /Length ${Buffer.byteLength(streamContent)} >>\nstream\n${streamContent}\nendstream\nendobj`;
  const body = [...lines, streamObj].join("\n") + "\n";
  const trailer = `xref\n0 7\n0000000000 65535 f \ntrailer << /Size 7 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(body)}\n%%EOF`;
  return Buffer.from(body + trailer, "utf-8");
}

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonc": "application/json; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".cc": "text/plain; charset=utf-8",
  ".cxx": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".hpp": "text/plain; charset=utf-8",
  ".cs": "text/plain; charset=utf-8",
  ".php": "text/plain; charset=utf-8",
  ".rb": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".swift": "text/plain; charset=utf-8",
  ".kt": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".bash": "text/plain; charset=utf-8",
  ".zsh": "text/plain; charset=utf-8",
  ".bat": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".env": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function serveFileWithRange(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (start >= total || end >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": total,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// Collect all descendant folder IDs for a shared folder
function getDescendantFolderIds(rootFolderId, allFolders) {
  const result = new Set([rootFolderId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of allFolders) {
      if (!f.isTrashed && f.parentId && result.has(f.parentId) && !result.has(f.id)) {
        result.add(f.id);
        added = true;
      }
    }
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);
    const method = req.method || "GET";

    // ------------------------------------------------------------------------
    // 1. Built-in Sample Media Assets (/sample-media/*)
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/sample-media/") && method === "GET") {
      const assetName = pathname.replace("/sample-media/", "");
      if (assetName.endsWith(".svg")) {
        const svg = getSampleSvg(assetName);
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(svg);
        return;
      }
      if (assetName.endsWith(".pdf")) {
        const pdfBuf = generateSamplePdfBuffer();
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${assetName}"`,
          "Content-Length": pdfBuf.length,
        });
        res.end(pdfBuf);
        return;
      }
      if (assetName === "studio-walkthrough.mp4") {
        // Redirect to a reliable fast stream or synthesized canvas video fallback handled in client
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // ------------------------------------------------------------------------
    // 2. API: Config & Firebase Environment
    // ------------------------------------------------------------------------
    if (pathname === "/api/config" && method === "GET") {
      const env = loadEnvFile();
      const apiKey =
        env.NEXT_PUBLIC_FIREBASE_API_KEY ||
        env.FIREBASE_API_KEY ||
        process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
        "";
      const projectId =
        env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
        env.FIREBASE_PROJECT_ID ||
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
        "";
      const storageBucket =
        env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
        env.FIREBASE_STORAGE_BUCKET ||
        process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
        "";
      const authDomain =
        env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
        env.FIREBASE_AUTH_DOMAIN ||
        (projectId ? `${projectId}.firebaseapp.com` : "");
      const appId =
        env.NEXT_PUBLIC_FIREBASE_APP_ID || env.FIREBASE_APP_ID || "";

      sendJson(res, 200, {
        firebaseConfig:
          apiKey && projectId
            ? { apiKey, authDomain, projectId, storageBucket, appId }
            : null,
        storageQuotaBytes: FIVE_GB_BYTES,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // 3. API: Workspace State
    // ------------------------------------------------------------------------
    if (pathname === "/api/workspace" && method === "GET") {
      const db = readDb();
      const activeFiles = db.files.filter((f) => !f.isTrashed);
      const storageUsedBytes = activeFiles.reduce(
        (acc, f) => acc + (Number(f.sizeBytes) || 0),
        0
      );
      sendJson(res, 200, {
        folders: db.folders,
        files: db.files,
        shares: db.shares.map((s) => ({
          ...s,
          hasPassword: Boolean(s.password),
        })),
        feedback: db.feedback,
        storageUsedBytes,
        storageQuotaBytes: FIVE_GB_BYTES,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // 3b. API: Full Workspace Sync (/api/sync)
    // ------------------------------------------------------------------------
    if (pathname === "/api/sync" && method === "POST") {
      const body = await readJsonBody(req);
      const db = readDb();

      const mergeCollection = (targetArr, incomingArr = []) => {
        const map = new Map();
        for (const item of targetArr) {
          if (item && item.id) map.set(item.id, item);
        }
        for (const inc of incomingArr) {
          if (!inc || !inc.id) continue;
          const existing = map.get(inc.id);
          if (!existing) {
            targetArr.unshift(inc);
            map.set(inc.id, inc);
          } else {
            // Keep server /uploads/ URL if existing has it and incoming has blob:
            const keepUrl =
              existing.url && !existing.url.startsWith("blob:")
                ? existing.url
                : inc.url || existing.url;
            Object.assign(existing, inc, { url: keepUrl });
          }
        }
      };

      mergeCollection(db.folders, body.folders);
      mergeCollection(db.files, body.files);
      mergeCollection(db.shares, body.shares);
      mergeCollection(db.feedback, body.feedback);
      writeDb(db);

      sendJson(res, 200, {
        folders: db.folders,
        files: db.files,
        shares: db.shares.map((s) => ({
          ...s,
          hasPassword: Boolean(s.password),
        })),
        feedback: db.feedback,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // 4. API: Folders CRUD
    // ------------------------------------------------------------------------
    if (pathname === "/api/folders" && method === "POST") {
      const body = await readJsonBody(req);
      const db = readDb();
      const now = new Date().toISOString();
      const folderId = body.id || `fld-${crypto.randomBytes(5).toString("hex")}`;
      const existingIdx = db.folders.findIndex((f) => f.id === folderId);
      const newFolder = {
        id: folderId,
        name: (body.name || "Untitled Folder").trim(),
        parentId: body.parentId || null,
        color: body.color || "amber",
        ownerId: body.ownerId || "default",
        isStarred: Boolean(body.isStarred),
        isTrashed: Boolean(body.isTrashed),
        createdAt: body.createdAt || now,
        updatedAt: now,
      };
      if (existingIdx !== -1) {
        db.folders[existingIdx] = newFolder;
      } else {
        db.folders.unshift(newFolder);
      }
      writeDb(db);
      sendJson(res, 201, { folder: newFolder });
      return;
    }

    if (pathname.startsWith("/api/folders/") && (method === "PATCH" || method === "DELETE")) {
      const folderId = pathname.replace("/api/folders/", "");
      const db = readDb();
      const idx = db.folders.findIndex((f) => f.id === folderId);
      if (idx === -1) {
        sendJson(res, 404, { error: "Folder not found" });
        return;
      }

      if (method === "DELETE") {
        db.folders.splice(idx, 1);
        db.files = db.files.filter((f) => f.folderId !== folderId);
        writeDb(db);
        sendJson(res, 200, { deleted: true });
        return;
      }

      const body = await readJsonBody(req);
      db.folders[idx] = {
        ...db.folders[idx],
        ...body,
        updatedAt: new Date().toISOString(),
      };
      writeDb(db);
      sendJson(res, 200, { folder: db.folders[idx] });
      return;
    }

    // ------------------------------------------------------------------------
    // 5. API: Direct Local Media Binary Upload (/api/upload)
    // ------------------------------------------------------------------------
    if (pathname === "/api/upload" && method === "POST") {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (contentType.includes("application/json")) {
        const body = await readJsonBody(req);
        const providedFileId = body.id || req.headers["x-file-id"] || "";
        const rawName =
          body.name ||
          decodeURIComponent(req.headers["x-file-name"] || "upload.bin");
        const mimeType =
          body.mimeType || req.headers["x-file-type"] || "application/octet-stream";
        const folderId =
          body.folderId !== undefined
            ? body.folderId
            : req.headers["x-folder-id"] || null;
        const ownerId = body.ownerId || req.headers["x-owner-id"] || "default";
        const category = classifyMimeType(mimeType, rawName);
        const now = new Date().toISOString();
        const finalFileId =
          providedFileId || `file-${crypto.randomBytes(5).toString("hex")}`;

        const newFile = {
          id: finalFileId,
          name: rawName,
          originalName: rawName,
          mimeType,
          category,
          sizeBytes: Number(body.sizeBytes) || 0,
          url: body.dataUrl || "/sample-media/brand-stills.svg",
          posterUrl: body.posterUrl || null,
          storagePath: `cloud/${rawName}`,
          storageProvider: "cloud",
          folderId: folderId === "null" || !folderId ? null : folderId,
          ownerId,
          metaLabel: getDefaultMetaLabel(category, mimeType, rawName),
          approvalStatus: "PENDING",
          isStarred: false,
          isTrashed: false,
          createdAt: now,
          updatedAt: now,
        };

        const db = readDb();
        const existingIdx = db.files.findIndex((f) => f.id === finalFileId);
        if (existingIdx !== -1) {
          db.files[existingIdx] = {
            ...db.files[existingIdx],
            ...newFile,
            approvalStatus: db.files[existingIdx].approvalStatus || "PENDING",
          };
        } else {
          db.files.unshift(newFile);
        }
        writeDb(db);
        sendJson(res, 201, { file: newFile });
        return;
      }

      const providedFileId = req.headers["x-file-id"] || "";
      const rawName = decodeURIComponent(req.headers["x-file-name"] || "upload.bin");
      const mimeType = req.headers["x-file-type"] || "application/octet-stream";
      const folderId = req.headers["x-folder-id"] || null;
      const ownerId = req.headers["x-owner-id"] || "default";
      const customMeta = req.headers["x-meta-label"]
        ? decodeURIComponent(req.headers["x-meta-label"])
        : "";

      const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedFilename = `${Date.now()}-${safeName}`;
      const destPath = path.join(UPLOADS_DIR, storedFilename);

      const writeStream = fs.createWriteStream(destPath);
      let sizeBytes = 0;

      await new Promise((resolve, reject) => {
        req.on("data", (chunk) => {
          sizeBytes += chunk.length;
          writeStream.write(chunk);
        });
        req.on("end", () => {
          writeStream.end();
          resolve();
        });
        req.on("error", reject);
      });

      const category = classifyMimeType(mimeType, rawName);
      const now = new Date().toISOString();
      const finalFileId =
        providedFileId || `file-${crypto.randomBytes(5).toString("hex")}`;
      const newFile = {
        id: finalFileId,
        name: rawName,
        originalName: rawName,
        mimeType,
        category,
        sizeBytes,
        url: `/uploads/${storedFilename}`,
        storagePath: `uploads/${storedFilename}`,
        storageProvider: "local",
        folderId: folderId === "null" || !folderId ? null : folderId,
        ownerId,
        metaLabel: customMeta || getDefaultMetaLabel(category, mimeType, rawName),
        approvalStatus: "PENDING",
        isStarred: false,
        isTrashed: false,
        createdAt: now,
        updatedAt: now,
      };

      const db = readDb();
      const existingIdx = db.files.findIndex((f) => f.id === finalFileId);
      if (existingIdx !== -1) {
        db.files[existingIdx] = newFile;
      } else {
        db.files.unshift(newFile);
      }
      writeDb(db);

      sendJson(res, 201, { file: newFile });
      return;
    }

    // ------------------------------------------------------------------------
    // 6. API: Register Firebase Cloud Storage File & File CRUD (/api/files)
    // ------------------------------------------------------------------------
    if (pathname === "/api/files" && method === "POST") {
      const body = await readJsonBody(req);
      const db = readDb();
      const now = new Date().toISOString();
      const category = classifyMimeType(body.mimeType, body.name);
      const finalFileId =
        body.id || `file-${crypto.randomBytes(5).toString("hex")}`;
      const newFile = {
        id: finalFileId,
        name: body.name,
        originalName: body.name,
        mimeType: body.mimeType || "application/octet-stream",
        category,
        sizeBytes: Number(body.sizeBytes) || 0,
        url: body.url,
        storagePath: body.storagePath || "",
        storageProvider: body.storageProvider || "firebase",
        folderId: body.folderId || null,
        ownerId: body.ownerId || "default",
        metaLabel:
          body.metaLabel || getDefaultMetaLabel(category, body.mimeType, body.name),
        approvalStatus: body.approvalStatus || "PENDING",
        isStarred: Boolean(body.isStarred),
        isTrashed: Boolean(body.isTrashed),
        createdAt: body.createdAt || now,
        updatedAt: now,
      };
      const existingIdx = db.files.findIndex((f) => f.id === finalFileId);
      if (existingIdx !== -1) {
        db.files[existingIdx] = newFile;
      } else {
        db.files.unshift(newFile);
      }
      writeDb(db);
      sendJson(res, 201, { file: newFile });
      return;
    }

    if (pathname.startsWith("/api/files/") && (method === "PATCH" || method === "DELETE")) {
      const fileId = pathname.replace("/api/files/", "");
      const db = readDb();
      const idx = db.files.findIndex((f) => f.id === fileId);
      if (idx === -1) {
        sendJson(res, 404, { error: "File not found" });
        return;
      }

      if (method === "DELETE") {
        const target = db.files[idx];
        if (target.storageProvider === "local" && target.url.startsWith("/uploads/")) {
          const diskPath = path.join(PUBLIC_DIR, target.url);
          if (fs.existsSync(diskPath)) {
            try {
              fs.unlinkSync(diskPath);
            } catch {
              // ignore unlink error
            }
          }
        }
        db.files.splice(idx, 1);
        writeDb(db);
        sendJson(res, 200, { deleted: true });
        return;
      }

      const body = await readJsonBody(req);
      db.files[idx] = {
        ...db.files[idx],
        ...body,
        updatedAt: new Date().toISOString(),
      };
      writeDb(db);
      sendJson(res, 200, { file: db.files[idx] });
      return;
    }

    // ------------------------------------------------------------------------
    // 7. API: Client Share Links CRUD (/api/shares)
    // ------------------------------------------------------------------------
    if (pathname === "/api/shares" && method === "POST") {
      const body = await readJsonBody(req);
      const db = readDb();
      const now = new Date();

      const slugBase = (body.title || body.resourceName || "client-portal")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24);
      const shortHash = crypto.randomBytes(3).toString("hex");
      const token = body.token || `${slugBase}-${shortHash}`;

      let expiresAt = body.expiresAt || null;
      if (!expiresAt && body.expiresInDays && Number(body.expiresInDays) > 0) {
        expiresAt = new Date(
          now.getTime() + Number(body.expiresInDays) * 86400000
        ).toISOString();
      }

      const shareId = body.id || `shr-${crypto.randomBytes(5).toString("hex")}`;
      const newShare = {
        id: shareId,
        token,
        title: (body.title || body.resourceName || "Client Delivery").trim(),
        description: (body.description || "").trim(),
        resourceType: body.resourceType === "FOLDER" ? "FOLDER" : "FILE",
        folderId: body.folderId || null,
        fileId: body.fileId || null,
        resourceName: body.resourceName || "Shared Deliverable",
        ownerId: body.ownerId || "default",
        ownerName: body.ownerName || "Studio Creator",
        studioName: body.studioName || "Tech Titans",
        allowDownload: body.allowDownload !== false,
        allowFeedback: body.allowFeedback !== false,
        password: body.password ? String(body.password).trim() : null,
        expiresAt,
        viewCount: 0,
        downloadCount: 0,
        isActive: true,
        createdAt: now.toISOString(),
      };

      const existingIdx = db.shares.findIndex(
        (s) => s.id === shareId || s.token === token
      );
      if (existingIdx !== -1) {
        db.shares[existingIdx] = newShare;
      } else {
        db.shares.unshift(newShare);
      }
      writeDb(db);

      sendJson(res, 201, {
        share: {
          ...newShare,
          hasPassword: Boolean(newShare.password),
        },
      });
      return;
    }

    if (pathname.startsWith("/api/shares/") && (method === "PATCH" || method === "DELETE")) {
      const shareId = pathname.replace("/api/shares/", "");
      const db = readDb();
      const idx = db.shares.findIndex((s) => s.id === shareId);
      if (idx === -1) {
        sendJson(res, 404, { error: "Share link not found" });
        return;
      }

      if (method === "DELETE") {
        db.shares.splice(idx, 1);
        writeDb(db);
        sendJson(res, 200, { deleted: true });
        return;
      }

      const body = await readJsonBody(req);
      db.shares[idx] = {
        ...db.shares[idx],
        ...body,
      };
      writeDb(db);
      sendJson(res, 200, {
        share: {
          ...db.shares[idx],
          hasPassword: Boolean(db.shares[idx].password),
        },
      });
      return;
    }

    // ------------------------------------------------------------------------
    // 8. API: Public Client Share Portal (/api/public/share/:token)
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/api/public/share/")) {
      const parts = pathname.replace("/api/public/share/", "").split("/");
      const token = parts[0];
      const subAction = parts[1] || null;
      const db = readDb();
      const shareIdx = db.shares.findIndex((s) => s.token === token && s.isActive);

      if (shareIdx === -1) {
        sendJson(res, 404, {
          error: "This client link does not exist or has been revoked by the studio.",
        });
        return;
      }

      const share = db.shares[shareIdx];

      // Check expiration
      if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
        sendJson(res, 410, {
          error: "This client delivery link has expired. Please request an updated link from the studio.",
        });
        return;
      }

      // POST /api/public/share/:token/feedback
      if (subAction === "feedback" && method === "POST") {
        if (!share.allowFeedback) {
          sendJson(res, 403, { error: "Client feedback is disabled for this link." });
          return;
        }
        const body = await readJsonBody(req);
        const fileIdx = db.files.findIndex((f) => f.id === body.fileId);
        if (fileIdx === -1) {
          sendJson(res, 404, { error: "Target file not found" });
          return;
        }

        const status = ["APPROVED", "CHANGES_REQUESTED", "COMMENT"].includes(body.status)
          ? body.status
          : "COMMENT";

        if (status === "APPROVED" || status === "CHANGES_REQUESTED") {
          db.files[fileIdx].approvalStatus = status;
          db.files[fileIdx].updatedAt = new Date().toISOString();
        }

        const entry = {
          id: `fb-${crypto.randomBytes(5).toString("hex")}`,
          fileId: body.fileId,
          fileName: db.files[fileIdx].name,
          shareToken: token,
          clientName: (body.clientName || "Client Reviewer").trim(),
          status,
          comment: (body.comment || "").trim(),
          createdAt: new Date().toISOString(),
        };

        db.feedback.unshift(entry);
        writeDb(db);
        sendJson(res, 201, {
          feedback: entry,
          file: db.files[fileIdx],
        });
        return;
      }

      // POST /api/public/share/:token/download
      if (subAction === "download" && method === "POST") {
        if (!share.allowDownload) {
          sendJson(res, 403, { error: "Downloads are disabled on this view-only portal." });
          return;
        }
        db.shares[shareIdx].downloadCount = (db.shares[shareIdx].downloadCount || 0) + 1;
        writeDb(db);
        sendJson(res, 200, { downloadCount: db.shares[shareIdx].downloadCount });
        return;
      }

      // GET /api/public/share/:token
      if (!subAction && method === "GET") {
        const providedPassword =
          req.headers["x-share-password"] || parsedUrl.searchParams.get("password") || "";

        if (share.password && share.password !== providedPassword) {
          sendJson(res, 401, {
            requiresPassword: true,
            title: share.title,
            studioName: share.studioName,
            ownerName: share.ownerName,
            resourceType: share.resourceType,
          });
          return;
        }

        if (parsedUrl.searchParams.get("track") === "1") {
          db.shares[shareIdx].viewCount = (db.shares[shareIdx].viewCount || 0) + 1;
          writeDb(db);
        }

        let sharedFolders = [];
        let sharedFiles = [];

        if (share.resourceType === "FOLDER" && share.folderId) {
          const allowedFolderIds = getDescendantFolderIds(share.folderId, db.folders);
          // Also include any folder with matching resourceName in case IDs differed earlier
          if (share.resourceName) {
            for (const f of db.folders) {
              if (!f.isTrashed && f.name === share.resourceName) {
                const extraIds = getDescendantFolderIds(f.id, db.folders);
                for (const eid of extraIds) allowedFolderIds.add(eid);
              }
            }
          }
          sharedFolders = db.folders.filter(
            (f) => !f.isTrashed && allowedFolderIds.has(f.id)
          );
          sharedFiles = db.files.filter(
            (f) => !f.isTrashed && f.folderId && allowedFolderIds.has(f.folderId)
          );
        } else if (share.resourceType === "FILE" && share.fileId) {
          sharedFiles = db.files.filter(
            (f) =>
              !f.isTrashed &&
              (f.id === share.fileId ||
                (share.resourceName && f.name === share.resourceName))
          );
        }

        const fileIds = new Set(sharedFiles.map((f) => f.id));
        const relevantFeedback = db.feedback.filter((fb) => fileIds.has(fb.fileId));

        sendJson(res, 200, {
          share: {
            id: share.id,
            token: share.token,
            title: share.title,
            description: share.description,
            resourceType: share.resourceType,
            folderId: share.folderId,
            fileId: share.fileId,
            resourceName: share.resourceName,
            ownerName: share.ownerName,
            studioName: share.studioName,
            allowDownload: share.allowDownload,
            allowFeedback: share.allowFeedback,
            expiresAt: share.expiresAt,
            viewCount: db.shares[shareIdx].viewCount,
            downloadCount: db.shares[shareIdx].downloadCount,
            createdAt: share.createdAt,
          },
          folders: sharedFolders,
          files: sharedFiles,
          feedback: relevantFeedback,
        });
        return;
      }
    }

    // ------------------------------------------------------------------------
    // 9. Serve Static Files & Uploaded Media
    // ------------------------------------------------------------------------
    if (pathname.startsWith("/uploads/")) {
      const targetFile = path.join(PUBLIC_DIR, pathname);
      const ext = path.extname(targetFile).toLowerCase();
      const mime = MIME_MAP[ext] || "application/octet-stream";
      serveFileWithRange(req, res, targetFile, mime);
      return;
    }

    const staticCandidate = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (
      pathname !== "/" &&
      fs.existsSync(staticCandidate) &&
      fs.statSync(staticCandidate).isFile()
    ) {
      const ext = path.extname(staticCandidate).toLowerCase();
      const mime = MIME_MAP[ext] || "application/octet-stream";
      serveFileWithRange(req, res, staticCandidate, mime);
      return;
    }

    // SPA routes (/ , /login , /dashboard , /share/:token)
    const indexHtmlPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexHtmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(indexHtmlPath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Tech Titans Media Portal running at: http://localhost:${PORT}`);
  console.log(`  Client Share Portal Demo URL:          http://localhost:${PORT}/share/nordic-pavilion-review\n`);
});
