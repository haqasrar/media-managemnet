import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FIVE_GB_BYTES = 5 * 1024 * 1024 * 1024;
const TMP_DB_FILE = "/tmp/appex-studios-db.json";

function readDb() {
  try {
    if (fs.existsSync(TMP_DB_FILE)) {
      const raw = fs.readFileSync(TMP_DB_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.folders) && Array.isArray(parsed.files)) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return { folders: [], files: [], shares: [], feedback: [] };
}

function writeDb(data) {
  try {
    fs.writeFileSync(TMP_DB_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function classifyMimeType(mimeType = "", filename = "") {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(filename).toLowerCase();
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

function getDefaultMetaLabel(category, mimeType, filename) {
  const ext = path.extname(filename).replace(".", "").toUpperCase();
  if (category === "IMAGE") return `${ext || "RAW"} • High-Res Still`;
  if (category === "VIDEO") return `${ext || "MP4"} • Studio Video Stream`;
  return `${ext || "DOC"} • Project Document`;
}

function getDescendantFolderIds(rootFolderId, allFolders) {
  const result = new Set([rootFolderId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of allFolders) {
      if (f.parentId && result.has(f.parentId) && !result.has(f.id)) {
        result.add(f.id);
        added = true;
      }
    }
  }
  return result;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function handler(event) {
  const method = event.httpMethod || "GET";
  let pathname = event.path || "/";
  if (pathname.startsWith("/.netlify/functions/api")) {
    const suffix = pathname.replace("/.netlify/functions/api", "");
    pathname = suffix.startsWith("/api") ? suffix : `/api${suffix}`;
  }

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    headers[k.toLowerCase()] = v;
  }
  const query = event.queryStringParameters || {};

  // 1. /api/config
  if (pathname === "/api/config" && method === "GET") {
    const apiKey =
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
      process.env.FIREBASE_API_KEY ||
      "";
    const projectId =
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      "";
    const storageBucket =
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
      process.env.FIREBASE_STORAGE_BUCKET ||
      "";
    const authDomain =
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
      process.env.FIREBASE_AUTH_DOMAIN ||
      (projectId ? `${projectId}.firebaseapp.com` : "");
    const appId =
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID ||
      process.env.FIREBASE_APP_ID ||
      "";

    return jsonResponse(200, {
      firebaseConfig:
        apiKey && projectId
          ? { apiKey, authDomain, projectId, storageBucket, appId }
          : null,
      storageQuotaBytes: FIVE_GB_BYTES,
    });
  }

  // 2. /api/workspace
  if (pathname === "/api/workspace" && method === "GET") {
    const db = readDb();
    const activeFiles = db.files.filter((f) => !f.isTrashed);
    const storageUsedBytes = activeFiles.reduce(
      (acc, f) => acc + (Number(f.sizeBytes) || 0),
      0
    );
    return jsonResponse(200, {
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
  }

  // 3. /api/folders
  if (pathname === "/api/folders" && method === "POST") {
    const body = parseBody(event);
    const db = readDb();
    const now = new Date().toISOString();
    const newFolder = {
      id: `fld-${crypto.randomBytes(5).toString("hex")}`,
      name: (body.name || "Untitled Folder").trim(),
      parentId: body.parentId || null,
      color: body.color || "amber",
      ownerId: body.ownerId || "default",
      isStarred: false,
      isTrashed: false,
      createdAt: now,
      updatedAt: now,
    };
    db.folders.unshift(newFolder);
    writeDb(db);
    return jsonResponse(201, { folder: newFolder });
  }

  if (pathname.startsWith("/api/folders/") && (method === "PATCH" || method === "DELETE")) {
    const folderId = pathname.replace("/api/folders/", "");
    const db = readDb();
    const idx = db.folders.findIndex((f) => f.id === folderId);
    if (idx === -1) return jsonResponse(404, { error: "Folder not found" });

    if (method === "DELETE") {
      db.folders.splice(idx, 1);
      db.files = db.files.filter((f) => f.folderId !== folderId);
      writeDb(db);
      return jsonResponse(200, { deleted: true });
    }

    const body = parseBody(event);
    db.folders[idx] = {
      ...db.folders[idx],
      ...body,
      updatedAt: new Date().toISOString(),
    };
    writeDb(db);
    return jsonResponse(200, { folder: db.folders[idx] });
  }

  // 4. /api/upload
  if (pathname === "/api/upload" && method === "POST") {
    const rawName = decodeURIComponent(headers["x-file-name"] || "upload.bin");
    const mimeType = headers["x-file-type"] || "application/octet-stream";
    const folderId = headers["x-folder-id"] || null;
    const ownerId = headers["x-owner-id"] || "default";
    const customMeta = headers["x-meta-label"]
      ? decodeURIComponent(headers["x-meta-label"])
      : "";

    const buffer = event.body
      ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
      : Buffer.alloc(0);

    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const category = classifyMimeType(mimeType, rawName);
    const now = new Date().toISOString();

    const newFile = {
      id: `file-${crypto.randomBytes(5).toString("hex")}`,
      name: rawName,
      originalName: rawName,
      mimeType,
      category,
      sizeBytes: buffer.length,
      url: dataUrl,
      storagePath: `cloud/${rawName}`,
      storageProvider: "cloud",
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
    db.files.unshift(newFile);
    writeDb(db);
    return jsonResponse(201, { file: newFile });
  }

  // 5. /api/files
  if (pathname === "/api/files" && method === "POST") {
    const body = parseBody(event);
    const db = readDb();
    const now = new Date().toISOString();
    const category = classifyMimeType(body.mimeType, body.name);
    const newFile = {
      id: `file-${crypto.randomBytes(5).toString("hex")}`,
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
      metaLabel: body.metaLabel || getDefaultMetaLabel(category, body.mimeType, body.name),
      approvalStatus: "PENDING",
      isStarred: false,
      isTrashed: false,
      createdAt: now,
      updatedAt: now,
    };
    db.files.unshift(newFile);
    writeDb(db);
    return jsonResponse(201, { file: newFile });
  }

  if (pathname.startsWith("/api/files/") && (method === "PATCH" || method === "DELETE")) {
    const fileId = pathname.replace("/api/files/", "");
    const db = readDb();
    const idx = db.files.findIndex((f) => f.id === fileId);
    if (idx === -1) return jsonResponse(404, { error: "File not found" });

    if (method === "DELETE") {
      db.files.splice(idx, 1);
      writeDb(db);
      return jsonResponse(200, { deleted: true });
    }

    const body = parseBody(event);
    db.files[idx] = {
      ...db.files[idx],
      ...body,
      updatedAt: new Date().toISOString(),
    };
    writeDb(db);
    return jsonResponse(200, { file: db.files[idx] });
  }

  // 6. /api/shares
  if (pathname === "/api/shares" && method === "POST") {
    const body = parseBody(event);
    const db = readDb();
    const now = new Date();
    const slugBase = (body.title || body.resourceName || "client-portal")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const shortHash = crypto.randomBytes(3).toString("hex");
    const token = `${slugBase}-${shortHash}`;

    let expiresAt = null;
    if (body.expiresInDays && Number(body.expiresInDays) > 0) {
      expiresAt = new Date(
        now.getTime() + Number(body.expiresInDays) * 86400000
      ).toISOString();
    }

    const newShare = {
      id: `shr-${crypto.randomBytes(5).toString("hex")}`,
      token,
      title: (body.title || body.resourceName || "Client Delivery").trim(),
      description: (body.description || "").trim(),
      resourceType: body.resourceType === "FOLDER" ? "FOLDER" : "FILE",
      folderId: body.folderId || null,
      fileId: body.fileId || null,
      resourceName: body.resourceName || "Shared Deliverable",
      ownerId: body.ownerId || "default",
      ownerName: body.ownerName || "Studio Creator",
      studioName: body.studioName || "Appex Studios",
      allowDownload: body.allowDownload !== false,
      allowFeedback: body.allowFeedback !== false,
      password: body.password ? String(body.password).trim() : null,
      expiresAt,
      viewCount: 0,
      downloadCount: 0,
      isActive: true,
      createdAt: now.toISOString(),
    };

    db.shares.unshift(newShare);
    writeDb(db);

    return jsonResponse(201, {
      share: {
        ...newShare,
        hasPassword: Boolean(newShare.password),
      },
    });
  }

  if (pathname.startsWith("/api/shares/") && (method === "PATCH" || method === "DELETE")) {
    const shareId = pathname.replace("/api/shares/", "");
    const db = readDb();
    const idx = db.shares.findIndex((s) => s.id === shareId);
    if (idx === -1) return jsonResponse(404, { error: "Share link not found" });

    if (method === "DELETE") {
      db.shares.splice(idx, 1);
      writeDb(db);
      return jsonResponse(200, { deleted: true });
    }

    const body = parseBody(event);
    db.shares[idx] = {
      ...db.shares[idx],
      ...body,
    };
    writeDb(db);
    return jsonResponse(200, {
      share: {
        ...db.shares[idx],
        hasPassword: Boolean(db.shares[idx].password),
      },
    });
  }

  // 7. /api/public/share/:token
  if (pathname.startsWith("/api/public/share/")) {
    const parts = pathname.replace("/api/public/share/", "").split("/");
    const token = parts[0];
    const subAction = parts[1] || null;
    const db = readDb();
    const shareIdx = db.shares.findIndex((s) => s.token === token && s.isActive);

    if (shareIdx === -1) {
      return jsonResponse(404, {
        error: "This client link does not exist or has been revoked by the studio.",
      });
    }

    const share = db.shares[shareIdx];
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
      return jsonResponse(410, {
        error: "This client delivery link has expired. Please request an updated link from the studio.",
      });
    }

    if (subAction === "feedback" && method === "POST") {
      if (!share.allowFeedback) {
        return jsonResponse(403, { error: "Client feedback is disabled for this link." });
      }
      const body = parseBody(event);
      const fileIdx = db.files.findIndex((f) => f.id === body.fileId);
      if (fileIdx === -1) return jsonResponse(404, { error: "Target file not found" });

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
      return jsonResponse(201, { feedback: entry, file: db.files[fileIdx] });
    }

    if (subAction === "download" && method === "POST") {
      if (!share.allowDownload) {
        return jsonResponse(403, { error: "Downloads are disabled on this view-only portal." });
      }
      db.shares[shareIdx].downloadCount = (db.shares[shareIdx].downloadCount || 0) + 1;
      writeDb(db);
      return jsonResponse(200, { downloadCount: db.shares[shareIdx].downloadCount });
    }

    if (!subAction && method === "GET") {
      const providedPassword = headers["x-share-password"] || query.password || "";
      if (share.password && share.password !== providedPassword) {
        return jsonResponse(401, {
          requiresPassword: true,
          title: share.title,
          studioName: share.studioName,
          ownerName: share.ownerName,
          resourceType: share.resourceType,
        });
      }

      if (query.track === "1") {
        db.shares[shareIdx].viewCount = (db.shares[shareIdx].viewCount || 0) + 1;
        writeDb(db);
      }

      let sharedFolders = [];
      let sharedFiles = [];

      if (share.resourceType === "FOLDER" && share.folderId) {
        const allowedFolderIds = getDescendantFolderIds(share.folderId, db.folders);
        sharedFolders = db.folders.filter(
          (f) => !f.isTrashed && allowedFolderIds.has(f.id)
        );
        sharedFiles = db.files.filter(
          (f) => !f.isTrashed && f.folderId && allowedFolderIds.has(f.folderId)
        );
      } else if (share.resourceType === "FILE" && share.fileId) {
        sharedFiles = db.files.filter((f) => !f.isTrashed && f.id === share.fileId);
      }

      const fileIds = new Set(sharedFiles.map((f) => f.id));
      const relevantFeedback = db.feedback.filter((fb) => fileIds.has(fb.fileId));

      return jsonResponse(200, {
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
    }
  }

  return jsonResponse(404, { error: "API route not found" });
}
