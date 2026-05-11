import express from "express";
import multer from "multer";
import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const logDir = path.join(dataDir, "logs");
const logFile = path.join(logDir, "app.jsonl");
const historyFile = path.join(dataDir, "history.json");
const distDir = path.join(rootDir, "dist");
const defaultApiBaseUrl = "http://dev.gravity.ind.in:8001";
const deletePassword = "Gravity";
const maxPdfFileSize = 200 * 1024 * 1024;
const parserTimeoutMs = 30 * 60 * 1000;
const chapterExtractionTimeoutMs = 8 * 60 * 1000;
const chapterExtractionConcurrency = 2;
const sseHeartbeatMs = 20 * 1000;
const externalApiDispatcher = new Agent({
  connectTimeout: 60 * 1000,
  headersTimeout: parserTimeoutMs,
  bodyTimeout: parserTimeoutMs
});

const app = express();
const port = Number(process.env.PORT || 3001);

await ensureDataFiles();

app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  const startedAt = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api")) {
      return;
    }

    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logEvent(level, "http.request_finished", "API request finished", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
});

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
    fileSize: maxPdfFileSize
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
      return;
    }
    logEvent("warn", "upload.rejected", "Rejected non-PDF upload", {
      requestId: _req.requestId,
      filename: file.originalname || "",
      mimeType: file.mimetype || ""
    });
    cb(new Error("Only PDF files are supported."));
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, requestId: req.requestId });
});

app.get("/api/history", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const records = await readHistory();
    logEvent("info", "history.load_succeeded", "History records loaded", {
      requestId: req.requestId,
      recordCount: records.length,
      durationMs: Date.now() - startedAt
    });
    res.json({
      records: records.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    });
  } catch (error) {
    logEvent("error", "history.load_failed", "History records could not be loaded", {
      requestId: req.requestId,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error)
    });
    next(error);
  }
});

app.post("/api/uploads", upload.single("file"), async (req, res, next) => {
  const wantsStream = req.headers.accept?.includes("text/event-stream");
  const emit = wantsStream ? createSseEmitter(res) : () => {};

  if (!req.file) {
    const entry = logUploadEvent(emit, "warn", "upload.rejected", "Upload request did not include a PDF file", {
      requestId: req.requestId
    });
    if (wantsStream) {
      emit("error", { error: "Missing PDF file.", requestId: entry.requestId });
      emit.stop?.();
      safeEnd(res);
    } else {
      res.status(400).json({ error: "Missing PDF file.", requestId: entry.requestId });
    }
    return;
  }

  const apiBaseUrl = normalizeApiBaseUrl(req.body.apiBaseUrl);

  try {
    logUploadEvent(emit, "info", "upload.accepted", "PDF upload accepted", {
      requestId: req.requestId,
      filename: req.file.originalname,
      storedFilename: req.file.filename,
      fileSize: req.file.size,
      apiBaseHost: getApiBaseHost(apiBaseUrl)
    });

    const record = await processUploadedPdf({
      file: req.file,
      apiBaseUrl,
      emit,
      requestId: req.requestId
    });

    logUploadEvent(emit, "info", "upload.request_completed", "Upload request completed", {
      requestId: req.requestId,
      recordId: record.id,
      filename: record.originalFilename,
      fileSize: record.fileSize,
      status: record.status,
      auditableCount: record.auditables.length,
      failedChapterCount: record.chapterResults.filter((chapter) => chapter.error).length
    });

    if (wantsStream) {
      emit("complete", { record });
      emit.stop?.();
      safeEnd(res);
    } else {
      res.json({ record });
    }
  } catch (error) {
    const entry = logUploadEvent(emit, "error", "upload.request_failed", "Upload request failed", {
      requestId: req.requestId,
      filename: req.file.originalname,
      fileSize: req.file.size,
      error: summarizeError(error)
    });
    if (wantsStream) {
      emit("error", { error: error instanceof Error ? error.message : String(error), requestId: entry.requestId });
      emit.stop?.();
      safeEnd(res);
    } else {
      next(error);
    }
  }
});

app.patch("/api/history/:recordId/auditables/:auditableId", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const { recordId, auditableId } = req.params;
    const records = await readHistory();
    const record = records.find((item) => item.id === recordId);

    if (!record) {
      logEvent("warn", "review.update_rejected", "History record not found for review update", {
        requestId: req.requestId,
        recordId,
        auditableId,
        durationMs: Date.now() - startedAt
      });
      res.status(404).json({ error: "History record not found.", requestId: req.requestId });
      return;
    }

    const row = record.auditables.find((item) => item.id === auditableId);
    if (!row) {
      logEvent("warn", "review.update_rejected", "Auditable row not found for review update", {
        requestId: req.requestId,
        recordId,
        auditableId,
        durationMs: Date.now() - startedAt
      });
      res.status(404).json({ error: "Auditable not found.", requestId: req.requestId });
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
    if (Object.hasOwn(req.body, "systemReviewStatus")) {
      row.systemReviewStatus = validateReviewStatus(req.body.systemReviewStatus);
    }
    if (Object.hasOwn(req.body, "remark")) {
      row.remark = typeof req.body.remark === "string" ? req.body.remark : "";
    }
    row.reviewUpdatedAt = new Date().toISOString();
    await writeHistory(records);
    logEvent("info", "review.update_succeeded", "Review row updated", {
      requestId: req.requestId,
      recordId,
      auditableId,
      updatedFields: getReviewUpdateFields(req.body),
      durationMs: Date.now() - startedAt
    });
    res.json({ record, auditable: row });
  } catch (error) {
    logEvent("error", "review.update_failed", "Review row update failed", {
      requestId: req.requestId,
      recordId: req.params.recordId,
      auditableId: req.params.auditableId,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error)
    });
    next(error);
  }
});

app.delete("/api/history", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    if (req.body?.password !== deletePassword) {
      logEvent("warn", "history.delete_rejected", "Delete history rejected because password was invalid", {
        requestId: req.requestId,
        durationMs: Date.now() - startedAt
      });
      res.status(401).json({ error: "Invalid password.", requestId: req.requestId });
      return;
    }

    await writeHistory([]);
    await clearUploadsDirectory();
    logEvent("info", "history.delete_succeeded", "History and uploaded PDFs deleted", {
      requestId: req.requestId,
      durationMs: Date.now() - startedAt
    });
    res.json({ ok: true });
  } catch (error) {
    logEvent("error", "history.delete_failed", "History delete failed", {
      requestId: req.requestId,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error)
    });
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

app.use((error, req, res, _next) => {
  const message = error instanceof Error ? error.message : String(error);
  const uploadTooLarge = isUploadTooLargeError(error);
  const status = uploadTooLarge
    ? 413
    : message.includes("Only PDF") || message.includes("Missing")
      ? 400
      : 500;
  const responseMessage = uploadTooLarge
    ? `PDF is too large. Maximum supported size is ${formatBytes(maxPdfFileSize)}.`
    : message;
  logEvent(status >= 500 ? "error" : "warn", "http.request_failed", "API request failed", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode: status,
    maxFileSize: uploadTooLarge ? maxPdfFileSize : undefined,
    error: summarizeError(error, true)
  });
  res.status(status).json({ error: responseMessage, requestId: req.requestId });
});

app.listen(port, () => {
  console.log(`Circular Auditable Review server running at http://127.0.0.1:${port}`);
});

async function processUploadedPdf({ file, apiBaseUrl, emit, requestId }) {
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
  const apiBaseHost = getApiBaseHost(apiBaseUrl);
  const uploadLog = (level, event, message, fields = {}) =>
    logUploadEvent(emit, level, event, message, {
      requestId,
      recordId: baseRecord.id,
      filename: file.originalname,
      storedFilename: file.filename,
      fileSize: file.size,
      apiBaseHost,
      ...fields
    });

  try {
    uploadLog("info", "upload.processing_started", "PDF processing started");
    emit("progress", {
      phase: "parsing",
      message: "Parsing circular PDF",
      done: 0,
      total: 0
    });

    const parsed = await parseCircularPdf(file.path, file.originalname, apiBaseUrl, uploadLog);
    const metaWithChapters = parsed.document_meta || {};
    const chapters = Array.isArray(metaWithChapters.chapter_details) ? metaWithChapters.chapter_details : [];
    const { chapter_details: _chapterDetails, ...documentMeta } = metaWithChapters;

    baseRecord.documentMeta = documentMeta;

    if (!chapters.length) {
      baseRecord.status = "empty";
      baseRecord.error = "No chapter details were returned by the parser.";
      const saved = await saveProcessedRecord(baseRecord, uploadLog);
      uploadLog("warn", "parse.no_chapters", "Parser returned no chapter details", {
        status: saved.status,
        auditableCount: 0,
        chapterCount: 0
      });
      emit("progress", {
        phase: "empty",
        message: baseRecord.error,
        done: 0,
        total: 0
      });
      return saved;
    }

    const chapterResults = new Array(chapters.length);
    const auditableRowsByChapter = new Array(chapters.length).fill(null).map(() => []);
    let completedChapters = 0;
    let nextChapterIndex = 0;

    uploadLog("info", "chapter.extraction_queue_started", "Chapter extraction queue started", {
      chapterCount: chapters.length,
      concurrency: chapterExtractionConcurrency
    });

    async function processChapter(index) {
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
        done: completedChapters,
        total: chapters.length,
        chapter: chapterContext
      });

      if (!String(chapter?.chapter_text || "").trim()) {
        result.error = "Chapter text is blank.";
        chapterResults[index] = result;
        uploadLog("warn", "chapter.extraction_skipped", `Skipped blank chapter ${index + 1} of ${chapters.length}`, {
          chapter: chapterContext,
          chapterIndex: index + 1,
          chapterCount: chapters.length
        });
        completedChapters += 1;
        emit("progress", {
          phase: "extracting",
          message: `Completed ${completedChapters} of ${chapters.length} chapters`,
          done: completedChapters,
          total: chapters.length,
          chapter: chapterContext
        });
        return;
      }

      try {
        uploadLog("info", "chapter.extraction_started", `Extracting chapter ${index + 1} of ${chapters.length}`, {
          chapter: chapterContext,
          chapterIndex: index + 1,
          chapterCount: chapters.length,
          concurrency: chapterExtractionConcurrency
        });
        const extraction = await extractAuditablesForChapterWithRetry(
          documentMeta,
          chapter,
          apiBaseUrl,
          uploadLog,
          chapterContext,
          index + 1,
          chapters.length
        );
        const points = Array.isArray(extraction.auditable_points) ? extraction.auditable_points : [];
        result.auditable_points = points.map(removeEmbeddings);
        result.non_auditable = Array.isArray(extraction.non_auditable) ? extraction.non_auditable : [];
        auditableRowsByChapter[index] = result.auditable_points.map((point) => ({
          id: randomUUID(),
          source: chapterContext,
          auditable: point,
          reviewStatus: "unmarked",
          penaltyReviewStatus: "unmarked",
          deadlineReviewStatus: "unmarked",
          systemReviewStatus: "unmarked",
          remark: "",
          reviewUpdatedAt: null
        }));
        uploadLog("info", "chapter.extraction_succeeded", `Extracted chapter ${index + 1} of ${chapters.length}`, {
          chapter: chapterContext,
          chapterIndex: index + 1,
          chapterCount: chapters.length,
          auditableCount: result.auditable_points.length,
          nonAuditableCount: result.non_auditable.length
        });
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        uploadLog("warn", "chapter.extraction_failed", `Chapter ${index + 1} extraction failed`, {
          chapter: chapterContext,
          chapterIndex: index + 1,
          chapterCount: chapters.length,
          error: summarizeError(error)
        });
      }

      chapterResults[index] = result;
      completedChapters += 1;
      emit("progress", {
        phase: "extracting",
        message: `Completed ${completedChapters} of ${chapters.length} chapters`,
        done: completedChapters,
        total: chapters.length,
        chapter: chapterContext
      });
    }

    async function runChapterWorker(workerIndex) {
      while (nextChapterIndex < chapters.length) {
        const index = nextChapterIndex;
        nextChapterIndex += 1;
        uploadLog("debug", "chapter.worker_claimed", `Worker ${workerIndex} claimed chapter ${index + 1}`, {
          workerIndex,
          chapterIndex: index + 1,
          chapterCount: chapters.length
        });
        await processChapter(index);
      }
    }

    const workerCount = Math.min(chapterExtractionConcurrency, chapters.length);
    await Promise.all(Array.from({ length: workerCount }, (_item, index) => runChapterWorker(index + 1)));

    const orderedChapterResults = chapterResults.map((chapter, index) => chapter || {
      ...pickChapterContext(chapters[index]),
      auditable_points: [],
      non_auditable: [],
      error: "Chapter was not processed."
    });
    const auditables = auditableRowsByChapter.flat();
    const failedChapters = orderedChapterResults.filter((chapter) => chapter.error);
    baseRecord.chapterResults = orderedChapterResults;
    baseRecord.auditables = auditables;
    baseRecord.status = failedChapters.length
      ? "partial_failure"
      : auditables.length
        ? "completed"
        : "empty";
    baseRecord.error = failedChapters.length
      ? `${failedChapters.length} chapter(s) could not be extracted.`
      : "";

    const saved = await saveProcessedRecord(baseRecord, uploadLog);
    uploadLog(failedChapters.length ? "warn" : "info", "upload.processing_finished", "PDF processing finished", {
      status: saved.status,
      chapterCount: chapters.length,
      failedChapterCount: failedChapters.length,
      auditableCount: auditables.length
    });
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
    const saved = await saveProcessedRecord(baseRecord, uploadLog);
    uploadLog("error", "upload.processing_failed", "PDF processing failed", {
      status: saved.status,
      error: summarizeError(error)
    });
    emit("progress", {
      phase: "failed",
      message: baseRecord.error,
      done: 0,
      total: 0
    });
    return saved;
  }
}

async function parseCircularPdf(filePath, originalFilename, apiBaseUrl, uploadLog) {
  const formData = new UndiciFormData();
  const blob = await openAsBlob(filePath, { type: "application/pdf" });
  formData.append("file", blob, originalFilename || "circular.pdf");
  const startedAt = Date.now();
  uploadLog("info", "parse.started", "Circular parser API request started", {
    endpoint: "/api-discovery/circular-upload/pdf",
    timeoutMs: parserTimeoutMs
  });

  let response;
  try {
    response = await fetchWithTimeout(`${apiBaseUrl}/api-discovery/circular-upload/pdf`, {
      method: "POST",
      body: formData
    }, parserTimeoutMs);
  } catch (error) {
    const normalizedError = normalizeFetchError(error, parserTimeoutMs, "Circular parser API request");
    uploadLog("error", "parse.failed", "Circular parser API request failed", {
      endpoint: "/api-discovery/circular-upload/pdf",
      durationMs: Date.now() - startedAt,
      timeoutMs: parserTimeoutMs,
      error: summarizeError(normalizedError)
    });
    throw normalizedError;
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    uploadLog("error", "parse.failed", "Circular parser API request returned an error", {
      endpoint: "/api-discovery/circular-upload/pdf",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      responseKeys: getObjectKeys(body),
      error: summarizeApiFailure(body, `Circular parse failed: ${response.status}`)
    });
    throw new Error(body?.error || body?.detail || `Circular parse failed: ${response.status}`);
  }

  const chapters = Array.isArray(body?.document_meta?.chapter_details) ? body.document_meta.chapter_details : [];
  uploadLog("info", "parse.succeeded", "Circular parser API request succeeded", {
    endpoint: "/api-discovery/circular-upload/pdf",
    statusCode: response.status,
    durationMs: Date.now() - startedAt,
    chapterCount: chapters.length,
    documentMetaFieldCount: body?.document_meta && typeof body.document_meta === "object"
      ? Object.keys(body.document_meta).length
      : 0
  });
  return body;
}

async function extractAuditablesForChapterWithRetry(
  documentMeta,
  chapter,
  apiBaseUrl,
  uploadLog,
  chapterContext,
  chapterIndex,
  chapterCount
) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await extractAuditablesForChapter(
        documentMeta,
        chapter,
        apiBaseUrl,
        uploadLog,
        chapterContext,
        attempt,
        chapterIndex,
        chapterCount
      );
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxAttempts && isRetryableExtractionError(error);
      uploadLog(shouldRetry ? "warn" : "error", shouldRetry ? "chapter.extraction_retry_scheduled" : "chapter.extraction_no_retry", shouldRetry
        ? `Retrying chapter ${chapterIndex} extraction`
        : `No retry for chapter ${chapterIndex} extraction`, {
        chapter: chapterContext,
        chapterIndex,
        chapterCount,
        attempt,
        maxAttempts,
        retryable: isRetryableExtractionError(error),
        error: summarizeError(error)
      });

      if (!shouldRetry) {
        throw error;
      }

      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

async function extractAuditablesForChapter(
  documentMeta,
  chapter,
  apiBaseUrl,
  uploadLog,
  chapterContext,
  attempt,
  chapterIndex,
  chapterCount
) {
  const startedAt = Date.now();
  const endpoint = "/api-discovery/auditable-extraction";
  uploadLog("info", "external_api.extraction_started", "Auditable extraction API request started", {
    endpoint,
    chapter: chapterContext,
    chapterIndex,
    chapterCount,
    attempt,
    timeoutMs: chapterExtractionTimeoutMs
  });

  let response;
  try {
    response = await fetchWithTimeout(`${apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_meta: documentMeta,
        chapter_details: chapter,
        history: []
      })
    }, chapterExtractionTimeoutMs);
  } catch (error) {
    const normalizedError = normalizeFetchError(error, chapterExtractionTimeoutMs, "Auditable extraction API request");
    uploadLog("error", "external_api.extraction_failed", "Auditable extraction API request failed", {
      endpoint,
      chapter: chapterContext,
      chapterIndex,
      chapterCount,
      attempt,
      durationMs: Date.now() - startedAt,
      timeoutMs: chapterExtractionTimeoutMs,
      error: summarizeError(normalizedError)
    });
    throw new ExternalApiError(normalizedError.message, {
      retryable: true,
      cause: normalizedError
    });
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    const message = body?.error || body?.detail || `Auditable extraction failed: ${response.status}`;
    const retryable = response.status === 429 || response.status >= 500;
    uploadLog("error", "external_api.extraction_failed", "Auditable extraction API request returned an error", {
      endpoint,
      chapter: chapterContext,
      chapterIndex,
      chapterCount,
      attempt,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      responseKeys: getObjectKeys(body),
      retryable,
      error: summarizeApiFailure(body, `Auditable extraction failed: ${response.status}`)
    });
    throw new ExternalApiError(message, {
      statusCode: response.status,
      retryable
    });
  }

  uploadLog("info", "external_api.extraction_succeeded", "Auditable extraction API request succeeded", {
    endpoint,
    chapter: chapterContext,
    chapterIndex,
    chapterCount,
    attempt,
    statusCode: response.status,
    durationMs: Date.now() - startedAt,
    auditableCount: Array.isArray(body?.auditable_points) ? body.auditable_points.length : 0,
    nonAuditableCount: Array.isArray(body?.non_auditable) ? body.non_auditable.length : 0
  });
  return body;
}

class ExternalApiError extends Error {
  constructor(message, { statusCode, retryable, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ExternalApiError";
    this.statusCode = statusCode;
    this.retryable = Boolean(retryable);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  return undiciFetch(url, {
    ...options,
    dispatcher: externalApiDispatcher,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function normalizeFetchError(error, timeoutMs, operation) {
  if (isTimeoutError(error)) {
    const timeoutError = new Error(`${operation} timed out after ${formatDuration(timeoutMs)}.`);
    timeoutError.name = "TimeoutError";
    return timeoutError;
  }
  return error;
}

function isRetryableExtractionError(error) {
  if (error instanceof ExternalApiError) {
    return error.retryable;
  }
  return isTimeoutError(error) || error instanceof TypeError;
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeEnd(res) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  try {
    res.end();
  } catch {
    // The browser may have disconnected during a long-running upload.
  }
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
  let closed = false;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const emit = (event, data) => {
    if (closed || res.destroyed || res.writableEnded) {
      return false;
    }
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      closed = true;
      clearInterval(heartbeat);
      return false;
    }
  };

  const heartbeat = setInterval(() => {
    emit("heartbeat", { timestamp: new Date().toISOString() });
  }, sseHeartbeatMs);
  heartbeat.unref?.();

  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });

  emit.stop = () => {
    closed = true;
    clearInterval(heartbeat);
  };
  emit.isClosed = () => closed;

  return emit;
}

function logUploadEvent(emit, level, event, message, fields = {}) {
  const entry = logEvent(level, event, message, fields);
  emit("log", toUploadDiagnostic(entry));
  return entry;
}

function logEvent(level, event, message, fields = {}) {
  const entry = sanitizeLogEntry({
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    ...fields
  });

  void writeLogEntry(entry);

  if (entry.level === "warn" || entry.level === "error") {
    const line = JSON.stringify(entry);
    if (entry.level === "warn") {
      console.warn(line);
    } else {
      console.error(line);
    }
  }

  return entry;
}

async function writeLogEntry(entry) {
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write diagnostic log", summarizeError(error));
  }
}

function sanitizeLogEntry(entry) {
  const sanitized = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      continue;
    }
    sanitized[key] = sanitizeLogValue(key, value);
  }
  return sanitized;
}

function sanitizeLogValue(key, value, depth = 0) {
  if (isSensitiveLogKey(key)) {
    return undefined;
  }
  if (value === null || value === undefined) {
    return value === undefined ? undefined : null;
  }
  if (typeof value === "string") {
    return truncateLogString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 3) {
    return "[object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeLogValue(key, item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (isSensitiveLogKey(childKey)) {
        continue;
      }
      const nextValue = sanitizeLogValue(childKey, childValue, depth + 1);
      if (nextValue !== undefined) {
        sanitized[childKey] = nextValue;
      }
    }
    return sanitized;
  }
  return String(value);
}

function isSensitiveLogKey(key) {
  return new Set([
    "password",
    "remark",
    "remarks",
    "chapter_text",
    "auditable_point_text",
    "reason",
    "penalty",
    "deadline",
    "embeddings",
    "fileBuffer",
    "body",
    "document_meta",
    "chapter_details",
    "auditable_points",
    "non_auditable"
  ]).has(key);
}

function truncateLogString(value) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 500)}...` : singleLine;
}

function summarizeError(error, includeStack = false) {
  const summary = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? truncateLogString(error.message) : truncateLogString(String(error))
  };
  if (error instanceof ExternalApiError) {
    summary.statusCode = error.statusCode || null;
    summary.retryable = error.retryable;
  }
  const cause = summarizeErrorCause(error);
  if (cause) {
    summary.cause = cause;
  }
  if (includeStack && error instanceof Error && error.stack) {
    summary.stack = truncateLogString(error.stack).slice(0, 2000);
  }
  return summary;
}

function summarizeErrorCause(error, depth = 0) {
  if (!error || typeof error !== "object" || depth >= 4) {
    return null;
  }

  const cause = error.cause;
  if (!cause) {
    return summarizeAggregateErrors(error, depth);
  }

  return summarizeThrowable(cause, depth + 1);
}

function summarizeThrowable(value, depth) {
  if (!value || depth >= 4) {
    return null;
  }

  if (value instanceof Error || typeof value === "object") {
    const summary = {};
    const name = value instanceof Error ? value.name : value.name;
    const message = value instanceof Error ? value.message : value.message;
    if (name) {
      summary.name = truncateLogString(String(name));
    }
    if (message) {
      summary.message = truncateLogString(String(message));
    }

    for (const field of ["code", "errno", "syscall", "address", "port", "host", "hostname", "localAddress", "localPort"]) {
      if (Object.hasOwn(value, field) && value[field] !== undefined && value[field] !== null) {
        summary[field] = sanitizeLogValue(field, value[field]);
      }
    }

    const nestedCause = summarizeErrorCause(value, depth);
    if (nestedCause) {
      summary.cause = nestedCause;
    }

    const aggregateErrors = summarizeAggregateErrors(value, depth);
    if (aggregateErrors) {
      summary.errors = aggregateErrors;
    }

    return Object.keys(summary).length ? summary : null;
  }

  return { message: truncateLogString(String(value)) };
}

function summarizeAggregateErrors(error, depth) {
  if (!error || typeof error !== "object" || !Array.isArray(error.errors) || depth >= 3) {
    return null;
  }

  return error.errors
    .slice(0, 4)
    .map((item) => summarizeThrowable(item, depth + 1))
    .filter(Boolean);
}

function summarizeApiFailure(body, fallback) {
  const message = typeof body?.error === "string"
    ? body.error
    : typeof body?.detail === "string"
      ? body.detail
      : fallback;
  return {
    message: truncateLogString(message),
    responseKeys: getObjectKeys(body)
  };
}

function getObjectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.keys(value).slice(0, 12).join(",");
}

function toUploadDiagnostic(entry) {
  const { timestamp, level, event, message, requestId, recordId, chapter, ...rest } = entry;
  const details = {};

  for (const [key, value] of Object.entries(rest)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      details[key] = value;
    } else if (key === "error" && value && typeof value === "object" && typeof value.message === "string") {
      details.errorMessage = value.message;
    }
  }

  return {
    timestamp,
    level,
    event,
    message,
    requestId,
    recordId,
    chapter,
    details
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

async function saveProcessedRecord(record, uploadLog) {
  try {
    const saved = await appendHistory(record);
    uploadLog("info", "history.record_saved", "History record saved", {
      status: saved.status,
      auditableCount: saved.auditables.length,
      chapterCount: saved.chapterResults.length,
      failedChapterCount: saved.chapterResults.filter((chapter) => chapter.error).length
    });
    return saved;
  } catch (error) {
    uploadLog("error", "history.record_save_failed", "History record could not be saved", {
      status: record.status,
      error: summarizeError(error)
    });
    throw error;
  }
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
  if (!isValidReviewStatus(row.systemReviewStatus)) {
    row.systemReviewStatus = "unmarked";
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

function getApiBaseHost(apiBaseUrl) {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return truncateLogString(apiBaseUrl);
  }
}

function getReviewUpdateFields(body) {
  return ["reviewStatus", "penaltyReviewStatus", "deadlineReviewStatus", "systemReviewStatus", "remark"]
    .filter((field) => Object.hasOwn(body, field))
    .join(",");
}

function isUploadTooLargeError(error) {
  return Boolean(error && typeof error === "object" && error.code === "LIMIT_FILE_SIZE");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} bytes`;
}

function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / 60000);
  if (minutes >= 1) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(milliseconds / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
