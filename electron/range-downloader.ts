import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Session } from "electron";
import {
  INTERNAL_REQUEST_HEADER_TOKEN,
  isFingerprintSessionInstalled,
  registerSessionHeaderOverride,
  unregisterSessionHeaderOverride,
} from "./fingerprint";

export const INITIAL_RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const MIN_MULTITHREAD_BYTES = 512 * 1024;
const MAX_CHUNKS_PER_STREAM = 32;
const DEFAULT_LARGE_CHUNK_BYTES = 4 * 1024 * 1024;

export class RangeUrlExpiredError extends Error {
  constructor(
    public readonly statusCode: number,
    message = `链接已失效或拒绝访问 (HTTP ${statusCode})`
  ) {
    super(message);
    this.name = "RangeUrlExpiredError";
  }
}

export class RangeHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly hasDownloadedAnyBytes: boolean,
    message: string
  ) {
    super(message);
    this.name = "RangeHttpError";
  }
}

export type ChunkState = {
  index: number;
  start: number;
  end: number;
  downloaded: number;
  done: boolean;
  active: boolean;
};

export type RangeStreamSpec = {
  url: string;
  partPath: string;
  refererCandidates: Array<string | undefined>;
  extraHeaders?: Record<string, string>;
  concurrency: number;
};

export type StreamProgressInfo = {
  downloadedBytes: number;
  totalBytes: number | null;
};

export function parseContentRangeHeader(
  header: string | null
): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const match = header.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (total !== null && (!Number.isFinite(total) || total <= 0)) return null;
  return { start, end, total };
}

export function planRemainingChunks(
  startOffset: number,
  endOffset: number,
  concurrency: number,
  startIndex: number
): ChunkState[] {
  if (endOffset < startOffset) return [];
  const remaining = endOffset - startOffset + 1;
  let chunkSize: number;
  if (remaining <= 16 * 1024 * 1024) {
    const targetWorkers = Math.max(1, concurrency);
    chunkSize = Math.max(512 * 1024, Math.ceil(remaining / targetWorkers));
  } else {
    chunkSize = Math.max(
      DEFAULT_LARGE_CHUNK_BYTES,
      Math.ceil(remaining / Math.max(1, MAX_CHUNKS_PER_STREAM - startIndex))
    );
  }
  const chunks: ChunkState[] = [];
  let cursor = startOffset;
  let index = startIndex;
  while (cursor <= endOffset) {
    const chunkEnd = Math.min(endOffset, cursor + chunkSize - 1);
    chunks.push({
      index,
      start: cursor,
      end: chunkEnd,
      downloaded: 0,
      done: false,
      active: false,
    });
    cursor = chunkEnd + 1;
    index += 1;
  }
  return chunks;
}

async function writeChunkWithBackpressure(
  writer: ReturnType<typeof createWriteStream>,
  chunk: Uint8Array
): Promise<void> {
  if (writer.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      writer.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      writer.off("drain", onDrain);
      reject(error);
    };
    writer.once("drain", onDrain);
    writer.once("error", onError);
  });
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message === "Aborted";
  }
  return false;
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SingleStreamTransfer {
  private url: string;
  private partPath: string;
  private refererCandidates: Array<string | undefined>;
  private extraHeaders: Record<string, string>;
  private readonly concurrency: number;
  private mode: "uninitialized" | "chunked" | "sequential" = "uninitialized";
  private totalBytes: number | null = null;
  private sequentialOffset = 0;
  private chunks: ChunkState[] = [];
  private activeReferer: string | undefined;
  private resolvedReferer = false;
  private completed = false;
  private contentType: string | null = null;

  constructor(
    private readonly targetSession: Session,
    private readonly userAgent: string,
    spec: RangeStreamSpec,
    private readonly callbacks?: {
      onProgress?: () => void;
      onInitialHeaders?: (info: {
        contentType: string | null;
        totalBytes: number | null;
      }) => Promise<{ partPath?: string } | void> | { partPath?: string } | void;
    }
  ) {
    this.url = spec.url;
    this.partPath = spec.partPath;
    this.refererCandidates = [...spec.refererCandidates];
    this.extraHeaders = { ...(spec.extraHeaders ?? {}) };
    this.concurrency = Math.max(1, spec.concurrency);
  }

  getPartPath(): string {
    return this.partPath;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  getProgress(): StreamProgressInfo {
    if (this.mode === "chunked") {
      let downloaded = 0;
      for (const chunk of this.chunks) {
        downloaded += chunk.downloaded;
      }
      return {
        downloadedBytes: downloaded,
        totalBytes: this.totalBytes,
      };
    }
    return {
      downloadedBytes: this.sequentialOffset,
      totalBytes: this.totalBytes,
    };
  }

  updateEndpoint(next: {
    url: string;
    refererCandidates?: Array<string | undefined>;
    extraHeaders?: Record<string, string>;
  }): void {
    this.url = next.url;
    if (next.refererCandidates) {
      this.refererCandidates = [...next.refererCandidates];
      this.resolvedReferer = false;
      this.activeReferer = undefined;
    }
    if (next.extraHeaders) {
      this.extraHeaders = { ...next.extraHeaders };
    }
  }

  private buildSafeOverrides(candidateReferer: string | undefined): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders)) {
      const lower = key.toLowerCase();
      if (
        lower === "user-agent" ||
        lower === "range" ||
        lower === "host" ||
        lower === "cookie" ||
        lower === "connection" ||
        lower === "content-length" ||
        lower === "referer" ||
        lower.startsWith("sec-ch-ua")
      ) {
        continue;
      }
      overrides[key] = value;
    }
    if (candidateReferer) {
      overrides.Referer = candidateReferer;
    }
    return overrides;
  }

  private async fetchSingle(
    candidateReferer: string | undefined,
    rangeHeader: string | undefined,
    signal: AbortSignal
  ): Promise<Response> {
    const canInjectOverrides = isFingerprintSessionInstalled(this.targetSession);
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
    };
    if (rangeHeader) {
      headers.Range = rangeHeader;
    }

    let headerToken: string | undefined;
    if (canInjectOverrides) {
      const overrides = this.buildSafeOverrides(candidateReferer);
      if (Object.keys(overrides).length > 0) {
        headerToken = randomUUID();
        registerSessionHeaderOverride(headerToken, overrides);
        headers[INTERNAL_REQUEST_HEADER_TOKEN] = headerToken;
      }
    }

    try {
      return await this.targetSession.fetch(this.url, {
        headers,
        signal,
      });
    } finally {
      if (headerToken) unregisterSessionHeaderOverride(headerToken);
    }
  }

  private async fetchWithFallback(
    rangeHeader: string | undefined,
    signal: AbortSignal
  ): Promise<Response> {
    const canInject = isFingerprintSessionInstalled(this.targetSession);
    const candidates: Array<string | undefined> = this.resolvedReferer
      ? [this.activeReferer]
      : canInject
        ? (this.refererCandidates.length > 0 ? this.refererCandidates : [undefined])
        : [undefined];

    let lastError: unknown = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const hasMore = i < candidates.length - 1;
      try {
        const response = await this.fetchSingle(candidate, rangeHeader, signal);
        if (hasMore && (response.status === 401 || response.status === 403)) {
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        this.activeReferer = candidate;
        this.resolvedReferer = true;
        return response;
      } catch (error) {
        lastError = error;
        if (isAbortError(error, signal)) throw error;
        const msg = error instanceof Error ? error.message : "";
        if (hasMore && /ERR_BLOCKED_BY_CLIENT/i.test(msg)) {
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("下载请求失败");
  }

  private validateContentType(contentType: string | null): void {
    if (!contentType) return;
    if (/text\/html/i.test(contentType)) {
      throw new Error("直链返回了网页内容（链接可能已失效或需先触发播放），请点击“重新解析”后再试");
    }
    if (/application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/dash\+xml/i.test(contentType)) {
      throw new Error("当前地址是流媒体列表而非直链，请点击“重新解析”后重新选择清晰度");
    }
  }

  private async consumeChunkResponse(
    handle: FileHandle,
    chunk: ChunkState,
    response: Response,
    signal: AbortSignal
  ): Promise<void> {
    if (!response.body) {
      throw new Error("服务器未返回响应流");
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal.aborted) throw new Error("Aborted");
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const expectedTotal = chunk.end - chunk.start + 1;
        const remaining = expectedTotal - chunk.downloaded;
        if (remaining <= 0) break;

        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        const writeOffset = chunk.start + chunk.downloaded;
        let written = 0;
        while (written < slice.byteLength) {
          const writeResult = await handle.write(
            slice,
            written,
            slice.byteLength - written,
            writeOffset + written
          );
          if (writeResult.bytesWritten <= 0) {
            throw new Error("写入下载文件失败");
          }
          written += writeResult.bytesWritten;
        }
        chunk.downloaded += slice.byteLength;
        this.callbacks?.onProgress?.();

        if (chunk.downloaded >= expectedTotal) {
          break;
        }
      }
      if (chunk.downloaded >= chunk.end - chunk.start + 1) {
        chunk.done = true;
      } else if (!signal.aborted) {
        throw new Error(`分块 ${chunk.index} 数据未传输完整 (${chunk.downloaded}/${chunk.end - chunk.start + 1})`);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }

  private async runChunkWorker(
    handle: FileHandle,
    signal: AbortSignal,
    initialChunk?: { chunk: ChunkState; response: Response }
  ): Promise<void> {
    if (initialChunk) {
      const { chunk, response } = initialChunk;
      try {
        await this.consumeChunkResponse(handle, chunk, response, signal);
      } finally {
        chunk.active = false;
      }
    }

    while (!signal.aborted) {
      const nextChunk = this.chunks.find((c) => !c.done && !c.active);
      if (!nextChunk) break;
      nextChunk.active = true;
      try {
        let attempts = 0;
        while (!nextChunk.done && !signal.aborted) {
          attempts += 1;
          const startPos = nextChunk.start + nextChunk.downloaded;
          const rangeHeader = `bytes=${startPos}-${nextChunk.end}`;
          let response: Response | null = null;
          try {
            response = await this.fetchWithFallback(rangeHeader, signal);
            if (response.status === 401 || response.status === 403 || response.status === 410) {
              await response.body?.cancel().catch(() => undefined);
              throw new RangeUrlExpiredError(response.status);
            }
            if (response.status !== 206 && !(response.status === 200 && startPos === 0 && nextChunk.end + 1 === this.totalBytes)) {
              const status = response.status;
              await response.body?.cancel().catch(() => undefined);
              throw new RangeHttpError(status, this.getProgress().downloadedBytes > 0, `服务器返回 HTTP ${status}`);
            }
            await this.consumeChunkResponse(handle, nextChunk, response, signal);
          } catch (error) {
            if (isAbortError(error, signal) || error instanceof RangeUrlExpiredError) {
              throw error;
            }
            if (attempts >= 3) {
              throw error;
            }
            await sleepWithAbort(attempts * 350, signal);
          }
        }
      } finally {
        nextChunk.active = false;
      }
    }
  }

  private async streamSequential(
    response: Response,
    append: boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!response.body) {
      throw new Error("服务器未返回响应流");
    }
    const reader = response.body.getReader();
    const writer = createWriteStream(this.partPath, { flags: append ? "a" : "w" });
    try {
      while (true) {
        if (signal.aborted) throw new Error("Aborted");
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        await writeChunkWithBackpressure(writer, value);
        this.sequentialOffset += value.byteLength;
        this.callbacks?.onProgress?.();
      }
      await new Promise<void>((resolve, reject) => {
        writer.end(() => resolve());
        writer.once("error", reject);
      });
      this.completed = true;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      writer.destroy();
      throw error;
    }
  }

  async run(externalSignal: AbortSignal): Promise<void> {
    if (this.completed) return;

    const workerAbort = new AbortController();
    const onExternalAbort = () => workerAbort.abort();
    if (externalSignal.aborted) {
      workerAbort.abort();
      throw new Error("Aborted");
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });

    try {
      if (this.mode === "uninitialized") {
        let initialResponse = await this.fetchWithFallback(
          `bytes=0-${INITIAL_RANGE_CHUNK_BYTES - 1}`,
          workerAbort.signal
        );
        if (initialResponse.status === 416) {
          await initialResponse.body?.cancel().catch(() => undefined);
          initialResponse = await this.fetchWithFallback(undefined, workerAbort.signal);
        }

        if (!initialResponse.ok || !initialResponse.body) {
          const status = initialResponse.status;
          await initialResponse.body?.cancel().catch(() => undefined);
          if (status === 401 || status === 403 || status === 410) {
            throw new RangeHttpError(status, false, `服务器返回 HTTP ${status}`);
          }
          throw new RangeHttpError(status, false, `服务器返回 HTTP ${status}`);
        }

        this.contentType = initialResponse.headers.get("content-type");
        this.validateContentType(this.contentType);

        const contentRange = initialResponse.status === 206
          ? parseContentRangeHeader(initialResponse.headers.get("content-range"))
          : null;

        if (initialResponse.status === 206 && contentRange && contentRange.total !== null) {
          this.totalBytes = contentRange.total;
          const headerResult = await this.callbacks?.onInitialHeaders?.({
            contentType: this.contentType,
            totalBytes: this.totalBytes,
          });
          if (headerResult?.partPath) {
            this.partPath = headerResult.partPath;
          }

          this.mode = "chunked";
          const firstEnd = Math.min(contentRange.end, this.totalBytes - 1);
          const firstChunk: ChunkState = {
            index: 0,
            start: 0,
            end: firstEnd,
            downloaded: 0,
            done: false,
            active: true,
          };
          const remaining = firstEnd + 1 < this.totalBytes
            ? planRemainingChunks(
                firstEnd + 1,
                this.totalBytes - 1,
                this.totalBytes >= MIN_MULTITHREAD_BYTES ? Math.max(1, this.concurrency - 1) : 1,
                1
              )
            : [];
          this.chunks = [firstChunk, ...remaining];

          const handle = await fs.open(this.partPath, "w+");
          try {
            await handle.truncate(this.totalBytes).catch(() => undefined);
            const workerCount =
              this.totalBytes >= MIN_MULTITHREAD_BYTES && this.chunks.length > 1
                ? Math.min(this.concurrency, this.chunks.length)
                : 1;
            const workers: Promise<void>[] = [
              this.runChunkWorker(handle, workerAbort.signal, {
                chunk: firstChunk,
                response: initialResponse,
              }),
            ];
            for (let i = 1; i < workerCount; i += 1) {
              workers.push(this.runChunkWorker(handle, workerAbort.signal));
            }
            const results = await Promise.allSettled(workers);
            const firstRejection = results.find(
              (r): r is PromiseRejectedResult => r.status === "rejected"
            );
            if (firstRejection) {
              workerAbort.abort();
              throw firstRejection.reason;
            }
            if (this.chunks.every((c) => c.done)) {
              this.completed = true;
            }
          } finally {
            workerAbort.abort();
            await handle.close().catch(() => undefined);
          }
          return;
        }

        // Sequential fallback (server returned 200 or 206 without total size)
        const totalHeader = Number(initialResponse.headers.get("content-length") ?? "0");
        this.totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
        const headerResult = await this.callbacks?.onInitialHeaders?.({
          contentType: this.contentType,
          totalBytes: this.totalBytes,
        });
        if (headerResult?.partPath) {
          this.partPath = headerResult.partPath;
        }
        this.mode = "sequential";
        this.sequentialOffset = 0;
        await this.streamSequential(initialResponse, false, workerAbort.signal);
        return;
      }

      if (this.mode === "chunked") {
        let openFlags = "r+";
        try {
          await fs.stat(this.partPath);
        } catch {
          openFlags = "w+";
          for (const chunk of this.chunks) {
            chunk.downloaded = 0;
            chunk.done = false;
            chunk.active = false;
          }
        }
        for (const chunk of this.chunks) {
          chunk.active = false;
        }
        const remainingChunks = this.chunks.filter((c) => !c.done);
        if (remainingChunks.length === 0) {
          this.completed = true;
          return;
        }

        const handle = await fs.open(this.partPath, openFlags);
        try {
          if (openFlags === "w+" && this.totalBytes) {
            await handle.truncate(this.totalBytes).catch(() => undefined);
          }
          const workerCount = Math.min(this.concurrency, remainingChunks.length);
          const workers: Promise<void>[] = [];
          for (let i = 0; i < workerCount; i += 1) {
            workers.push(this.runChunkWorker(handle, workerAbort.signal));
          }
          const results = await Promise.allSettled(workers);
          const firstRejection = results.find(
            (r): r is PromiseRejectedResult => r.status === "rejected"
          );
          if (firstRejection) {
            workerAbort.abort();
            throw firstRejection.reason;
          }
          if (this.chunks.every((c) => c.done)) {
            this.completed = true;
          }
        } finally {
          workerAbort.abort();
          await handle.close().catch(() => undefined);
        }
        return;
      }

      // Resume sequential mode
      let canAppend = false;
      if (this.sequentialOffset > 0) {
        try {
          const stat = await fs.stat(this.partPath);
          if (stat.size >= this.sequentialOffset) {
            canAppend = true;
          } else {
            this.sequentialOffset = 0;
          }
        } catch {
          this.sequentialOffset = 0;
        }
      }

      const rangeHeader = canAppend && this.sequentialOffset > 0
        ? `bytes=${this.sequentialOffset}-`
        : undefined;
      const response = await this.fetchWithFallback(rangeHeader, workerAbort.signal);
      if (response.status === 401 || response.status === 403 || response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        throw new RangeUrlExpiredError(response.status);
      }
      if (!response.ok || !response.body) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        throw new RangeHttpError(status, this.sequentialOffset > 0, `服务器返回 HTTP ${status}`);
      }

      const appendMode = canAppend && response.status === 206;
      if (!appendMode) {
        this.sequentialOffset = 0;
      }
      await this.streamSequential(response, appendMode, workerAbort.signal);
    } finally {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
