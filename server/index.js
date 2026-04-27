import express from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const historyFile = path.join(dataDir, "history.json");
const distDir = path.join(rootDir, "dist");
const defaultApiBaseUrl = "http://dev.gravity.ind.in:8001";
const deletePassword = "Gravity";

const app = express();
const port = Number(process.env.PORT || 3001);

await ensureDataFiles();

app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const safeName = sanitizeFilename(file.originalname || "circular.pdf");
      cb(null, `${Date.now()}-${randomUUID()}-${safeName}`);
    }
  }),
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PDF files are supported."));
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/history", async (_req, res, next) => {
  try {
    const records = await readHistory();
    res.json({
      records: records.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/uploads", upload.single("file"), async (req, res, next) => {
  const wantsStream = req.headers.accept?.includes("text/event-stream");
  const emit = wantsStream ? createSseEmitter(res) : () => {};

  if (!req.file) {
    if (wantsStream) {
      emit("error", { error: "Missing PDF file." });
      res.end();
    } else {
      res.status(400).json({ error: "Missing PDF file." });
    }
    return;
  }

  const apiBaseUrl = normalizeApiBaseUrl(req.body.apiBaseUrl);

  try {
    const record = await processUploadedPdf({
      file: req.file,
      apiBaseUrl,
      emit
    });

    if (wantsStream) {
      emit("complete", { record });
      res.end();
    } else {
      res.json({ record });
    }
  } catch (error) {
    if (wantsStream) {
      emit("error", { error: error instanceof Error ? error.message : String(error) });
      res.end();
    } else {
      next(error);
    }
  }
});

app.patch("/api/history/:recordId/auditables/:auditableId", async (req, res, next) => {
  try {
    const { recordId, auditableId } = req.params;
    const records = await readHistory();
    const record = records.find((item) => item.id === recordId);

    if (!record) {
      res.status(404).json({ error: "History record not found." });
      return;
    }

    const row = record.auditables.find((item) => item.id === auditableId);
    if (!row) {
      res.status(404).json({ error: "Auditable not found." });
      return;
    }

    normalizeReviewRow(row);

    if (Object.hasOwn(req.body, "reviewStatus")) {
      row.reviewStatus = validateReviewStatus(req.body.reviewStatus);
    }
    if (Object.hasOwn(req.body, "penaltyReviewStatus")) {
      row.penaltyReviewStatus = validateReviewStatus(req.body.penaltyReviewStatus);
    }
    if (Object.hasOwn(req.body, "deadlineReviewStatus")) {
      row.deadlineReviewStatus = validateReviewStatus(req.body.deadlineReviewStatus);
    }
    if (Object.hasOwn(req.body, "remark")) {
      row.remark = typeof req.body.remark === "string" ? req.body.remark : "";
    }
    row.reviewUpdatedAt = new Date().toISOString();
    await writeHistory(records);
    res.json({ record, auditable: row });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/history", async (req, res, next) => {
  try {
    if (req.body?.password !== deletePassword) {
      res.status(401).json({ error: "Invalid password." });
      return;
    }

    await writeHistory([]);
    await clearUploadsDirectory();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

try {
  await fs.access(distDir);
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/uploads")) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
} catch {
  // Vite serves the frontend during development.
}

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("Only PDF") || message.includes("Missing") ? 400 : 500;
  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`Circular Auditable Review server running at http://127.0.0.1:${port}`);
});

async function processUploadedPdf({ file, apiBaseUrl, emit }) {
  const uploadedAt = new Date().toISOString();
  const publicPdfPath = `/uploads/${file.filename}`;
  const baseRecord = {
    id: randomUUID(),
    originalFilename: file.originalname,
    storedFilename: file.filename,
    pdfPath: publicPdfPath,
    uploadedAt,
    fileSize: file.size,
    apiBaseUrl,
    status: "failed",
    error: "",
    documentMeta: {},
    chapterResults: [],
    auditables: []
  };

  try {
    emit("progress", {
      phase: "parsing",
      message: "Parsing circular PDF",
      done: 0,
      total: 0
    });

    const parsed = await parseCircularPdf(file.path, file.originalname, apiBaseUrl);
    const metaWithChapters = parsed.document_meta || {};
    const chapters = Array.isArray(metaWithChapters.chapter_details) ? metaWithChapters.chapter_details : [];
    const { chapter_details: _chapterDetails, ...documentMeta } = metaWithChapters;

    baseRecord.documentMeta = documentMeta;

    if (!chapters.length) {
      baseRecord.status = "empty";
      baseRecord.error = "No chapter details were returned by the parser.";
      const saved = await appendHistory(baseRecord);
      emit("progress", {
        phase: "empty",
        message: baseRecord.error,
        done: 0,
        total: 0
      });
      return saved;
    }

    const chapterResults = [];
    const auditables = [];

    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const chapterContext = pickChapterContext(chapter);
      const result = {
        ...chapterContext,
        auditable_points: [],
        non_auditable: []
      };

      emit("progress", {
        phase: "extracting",
        message: `Extracting chapter ${index + 1} of ${chapters.length}`,
        done: index,
        total: chapters.length,
        chapter: chapterContext
      });

      if (!String(chapter?.chapter_text || "").trim()) {
        result.error = "Chapter text is blank.";
        chapterResults.push(result);
        emit("progress", {
          phase: "extracting",
          message: `Skipped blank chapter ${index + 1} of ${chapters.length}`,
          done: index + 1,
          total: chapters.length,
          chapter: chapterContext
        });
        continue;
      }

      try {
        const extraction = await extractAuditablesForChapter(documentMeta, chapter, apiBaseUrl);
        const points = Array.isArray(extraction.auditable_points) ? extraction.auditable_points : [];
        result.auditable_points = points.map(removeEmbeddings);
        result.non_auditable = Array.isArray(extraction.non_auditable) ? extraction.non_auditable : [];

        for (const point of result.auditable_points) {
          auditables.push({
            id: randomUUID(),
            source: chapterContext,
            auditable: point,
            reviewStatus: "unmarked",
            penaltyReviewStatus: "unmarked",
            deadlineReviewStatus: "unmarked",
            remark: "",
            reviewUpdatedAt: null
          });
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }

      chapterResults.push(result);
      emit("progress", {
        phase: "extracting",
        message: `Extracted chapter ${index + 1} of ${chapters.length}`,
        done: index + 1,
        total: chapters.length,
        chapter: chapterContext
      });
    }

    const failedChapters = chapterResults.filter((chapter) => chapter.error);
    baseRecord.chapterResults = chapterResults;
    baseRecord.auditables = auditables;
    baseRecord.status = failedChapters.length
      ? "partial_failure"
      : auditables.length
        ? "completed"
        : "empty";
    baseRecord.error = failedChapters.length
      ? `${failedChapters.length} chapter(s) could not be extracted.`
      : "";

    const saved = await appendHistory(baseRecord);
    emit("progress", {
      phase: saved.status,
      message: saved.error || "Extraction complete",
      done: chapters.length,
      total: chapters.length
    });
    return saved;
  } catch (error) {
    baseRecord.status = "failed";
    baseRecord.error = error instanceof Error ? error.message : String(error);
    const saved = await appendHistory(baseRecord);
    emit("progress", {
      phase: "failed",
      message: baseRecord.error,
      done: 0,
      total: 0
    });
    return saved;
  }
}

async function parseCircularPdf(filePath, originalFilename, apiBaseUrl) {
  const formData = new FormData();
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: "application/pdf" });
  formData.append("file", blob, originalFilename || "circular.pdf");

  const response = await fetch(`${apiBaseUrl}/api-discovery/circular-upload/pdf`, {
    method: "POST",
    body: formData
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(body?.error || body?.detail || `Circular parse failed: ${response.status}`);
  }

  return body;
}

async function extractAuditablesForChapter(documentMeta, chapter, apiBaseUrl) {
  const response = await fetch(`${apiBaseUrl}/api-discovery/auditable-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_meta: documentMeta,
      chapter_details: chapter,
      history: []
    })
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(body?.error || body?.detail || `Auditable extraction failed: ${response.status}`);
  }

  return body;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function createSseEmitter(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

function pickChapterContext(chapter) {
  return {
    chapter_number: chapter?.chapter_number,
    chapter_name: chapter?.chapter_name,
    from_page: chapter?.from_page,
    to_page: chapter?.to_page
  };
}

function removeEmbeddings(point) {
  if (!point || typeof point !== "object") {
    return point;
  }
  const { embeddings: _embeddings, ...rest } = point;
  return rest;
}

function validateReviewStatus(value) {
  const allowed = new Set(["unmarked", "correct", "partially_correct", "incorrect"]);
  if (allowed.has(value)) {
    return value;
  }
  throw new Error("Invalid review status.");
}

function normalizeApiBaseUrl(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultApiBaseUrl;
  return raw.replace(/\/+$/, "");
}

async function ensureDataFiles() {
  await fs.mkdir(uploadDir, { recursive: true });
  try {
    await fs.access(historyFile);
  } catch {
    await writeHistory([]);
  }
}

async function readHistory() {
  await ensureDataFiles();
  const content = await fs.readFile(historyFile, "utf8");
  if (!content.trim()) {
    return [];
  }
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? normalizeHistoryRecords(parsed) : [];
}

async function writeHistory(records) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(historyFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

async function appendHistory(record) {
  const records = await readHistory();
  records.push(record);
  await writeHistory(records);
  return record;
}

async function clearUploadsDirectory() {
  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedDataDir = path.resolve(dataDir);
  if (!resolvedUploadDir.startsWith(resolvedDataDir)) {
    throw new Error("Upload directory safety check failed.");
  }

  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.mkdir(uploadDir, { recursive: true });
}

function sanitizeFilename(filename) {
  const fallback = "circular.pdf";
  const safe = path.basename(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || fallback;
}

function normalizeHistoryRecords(records) {
  return records.map((record) => ({
    ...record,
    auditables: Array.isArray(record.auditables) ? record.auditables.map(normalizeReviewRow) : []
  }));
}

function normalizeReviewRow(row) {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (!isValidReviewStatus(row.reviewStatus)) {
    row.reviewStatus = "unmarked";
  }
  if (!isValidReviewStatus(row.penaltyReviewStatus)) {
    row.penaltyReviewStatus = "unmarked";
  }
  if (!isValidReviewStatus(row.deadlineReviewStatus)) {
    row.deadlineReviewStatus = "unmarked";
  }
  if (typeof row.remark !== "string") {
    row.remark = "";
  }
  if (!Object.hasOwn(row, "reviewUpdatedAt")) {
    row.reviewUpdatedAt = null;
  }
  return row;
}

function isValidReviewStatus(value) {
  return ["unmarked", "correct", "partially_correct", "incorrect"].includes(value);
}
