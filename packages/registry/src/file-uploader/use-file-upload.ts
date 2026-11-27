"use client";

import * as React from "react";

import { type UploadTransport, uploadViaXhr } from "./upload-transport";

/** A presigned signature minted by your backend via `POST /upload/sign`. */
export interface SignedUpload {
  signature: string;
  /** Unix timestamp (seconds) after which the signature is no longer valid. */
  expires: number;
  /** Folder the signature is scoped to. The upload is sent to this folder. */
  folder: string;
}

/** A file successfully stored by the Openinary API. */
export interface UploadedFile {
  filename: string;
  /** Stored path (may be de-duplicated / renamed by the server). */
  path: string;
  size: number;
  /** Transformation URL prefix, e.g. `/t/{path}`. Prefix with your baseUrl. */
  url: string;
  prewarmedUrls?: string[];
  queuedTransformationUrls?: string[];
}

export type FileUploadStatus =
  | "idle"
  | "queued"
  | "uploading"
  | "processing"
  | "retrying"
  | "success"
  | "error"
  | "aborted";

export interface FileUploadState {
  /** Stable client-generated id. */
  id: string;
  file: File;
  name: string;
  size: number;
  relativePath?: string;
  status: FileUploadStatus;
  /** 0–100. */
  progress: number;
  /** Object URL for image previews (revoked automatically). */
  previewUrl?: string;
  error?: string;
  validationError?: boolean;
  result?: UploadedFile;
}

export interface UploadFileError {
  file: FileUploadState;
  message: string;
}

/** Default accepted types, mirroring the Openinary API's ALLOWED_TYPES. */
export const DEFAULT_ACCEPT: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/avif": [".avif"],
  "image/gif": [".gif"],
  "image/heic": [".heic", ".heif"],
  "image/heif": [".heic", ".heif"],
  "image/vnd.adobe.photoshop": [".psd"],
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
};

/** Default max file size for presigned uploads: 50 MB. */
export const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

type UploadAuth =
  | {
      authMode?: "presigned";
      /** Called once per batch and again for retries. The signature sets the destination folder. */
      sign: () => Promise<SignedUpload> | SignedUpload;
      folder?: never;
      directoryPathField?: never;
    }
  | {
      authMode: "session";
      sign?: never;
      folder?: string;
      /** Self-hosted uploads use `names`. Cloud accepts the full directory in `folder`. */
      directoryPathField?: "names" | "folder";
    };

export type UseFileUploadOptions = UploadAuth & {
  /** Openinary API URL. Falls back to NEXT_PUBLIC_OPENINARY_URL. */
  baseUrl?: string;
  transformations?: string[];
  accept?: Record<string, string[]>;
  /** Bytes. Defaults to 50 MB for presigned uploads and the server limit for sessions. */
  maxSize?: number;
  /** Client-side cap on the number of files. */
  maxFiles?: number;
  multiple?: boolean;
  /** Max concurrent uploads. Defaults to 3. */
  concurrency?: number;
  transport?: UploadTransport;
  /** Called as each file is stored. */
  onFileSuccess?: (file: UploadedFile) => void;
  /** Called with the successful results when a batch or manual retry finishes. */
  onSuccess?: (files: UploadedFile[]) => void;
  onError?: (error: UploadFileError) => void;
  onProgress?: (file: FileUploadState, progress: number) => void;
};

export function uploadMaxSize(
  authMode: UploadAuth["authMode"],
  maxSize?: number,
) {
  return maxSize ?? (authMode === "session" ? Infinity : DEFAULT_MAX_SIZE);
}

export function isUploadPending(status: FileUploadStatus) {
  return (
    status === "queued" ||
    status === "uploading" ||
    status === "processing" ||
    status === "retrying"
  );
}

function validateFileType(file: File, accept: Record<string, string[]>) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  // Browsers may report an empty or generic MIME type for a supported extension.
  if (Object.values(accept).some((extensions) => extensions.includes(ext))) {
    return null;
  }
  return `File type not allowed (${file.type || ext || "unknown"})`;
}

export function validateFile(
  file: File,
  accept: Record<string, string[]>,
  maxSize: number,
): string | null {
  if (file.size > maxSize) {
    const mb = (maxSize / (1024 * 1024)).toFixed(0);
    return `File exceeds the maximum size of ${mb}MB`;
  }
  return validateFileType(file, accept);
}

type UploadResponse = {
  success?: boolean;
  files?: UploadedFile[];
  errors?: { error?: string }[];
  error?: string;
  retryAfter?: number;
};

function nonNegativeNumber(value: unknown) {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" &&
    number >= 0 &&
    number <= Number.MAX_SAFE_INTEGER / 1000
    ? number
    : undefined;
}

export function retryDelay(
  headers: Pick<Headers, "get">,
  retryAfter: unknown,
  now = Date.now(),
) {
  const header = headers.get("Retry-After");
  const headerSeconds = nonNegativeNumber(header);
  if (headerSeconds !== undefined) return Math.max(1000, headerSeconds * 1000);

  // Retry-After also permits an HTTP date. Avoid interpreting malformed numeric
  // headers as dates (Date.parse can treat strings such as "-1" as years).
  const date =
    header && /[a-z]{3},?\s/i.test(header) ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) return Math.max(1000, date - now);

  const bodySeconds = nonNegativeNumber(retryAfter);
  if (bodySeconds !== undefined) return Math.max(1000, bodySeconds * 1000);

  const resetSeconds = nonNegativeNumber(headers.get("X-RateLimit-Reset"));
  return Math.max(1000, (resetSeconds ?? 0) * 1000 - now);
}

function waitForRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

const MAX_ATTEMPTS = 3;

async function uploadFile(
  file: FileUploadState,
  options: UseFileUploadOptions,
  authorize: (attempt: number) => Promise<SignedUpload> | undefined,
  signal: AbortSignal,
  update: (patch: Partial<FileUploadState>) => void,
  onProgress: (progress: number) => void,
) {
  const baseUrl =
    options.baseUrl ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_OPENINARY_URL
      : undefined) ??
    "";
  const transport = options.transport ?? uploadViaXhr;

  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const authorization = authorize(attempt);
    const signed = authorization && (await abortable(authorization, signal));
    signal.throwIfAborted();

    const form = new FormData();
    form.append("files", file.file, file.name);
    let folder = signed?.folder ?? options.folder ?? "";
    if (file.relativePath) {
      if (options.directoryPathField === "folder") {
        const directory = file.relativePath.slice(
          0,
          file.relativePath.lastIndexOf("/"),
        );
        folder = [folder, directory].filter(Boolean).join("/");
      } else {
        form.append("names", file.relativePath);
      }
    }
    form.append("folder", folder);
    if (signed) {
      form.append("signature", signed.signature);
      form.append("expires", String(signed.expires));
    }
    for (const t of options.transformations ?? [])
      form.append("transformations", t);

    update({ status: "uploading", progress: 0, error: undefined });
    const response = await transport({
      url: `${baseUrl.replace(/\/+$/, "")}/upload`,
      body: form,
      withCredentials: options.authMode === "session",
      signal,
      onProgress,
      onTransferComplete: () => update({ status: "processing", progress: 100 }),
    });
    let body: UploadResponse | null = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      // An intermediary can return HTML or an empty response.
    }
    signal.throwIfAborted();

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      update({ status: "retrying", progress: 0 });
      // Browsers coerce larger timeouts to a near-immediate timer.
      let remaining = retryDelay(response.headers, body?.retryAfter);
      while (remaining > 0) {
        const delay = Math.min(remaining, 2_147_483_647);
        await waitForRetry(delay, signal);
        remaining -= delay;
      }
      continue;
    }

    if (
      response.status >= 200 &&
      response.status < 300 &&
      body?.success &&
      body.files?.[0]
    ) {
      return body.files[0];
    }
    throw new Error(
      body?.error ||
        body?.errors?.[0]?.error ||
        `Upload failed (HTTP ${response.status})`,
    );
  }
}

interface UploadJob {
  controller: AbortController;
  path: string;
  started: boolean;
  run: () => Promise<UploadedFile | null>;
  resolve: (result: UploadedFile | null) => void;
  reject: (error: unknown) => void;
}

export function useFileUpload(options: UseFileUploadOptions) {
  const {
    authMode,
    accept = DEFAULT_ACCEPT,
    maxSize = uploadMaxSize(authMode),
    maxFiles,
    multiple = true,
    concurrency = 3,
  } = options;

  const [files, setFiles] = React.useState<FileUploadState[]>([]);
  // Events can enqueue, cancel or add files before React commits the next render.
  const filesRef = React.useRef<FileUploadState[]>([]);
  const jobsRef = React.useRef(new Map<string, UploadJob>());
  const activePathsRef = React.useRef(new Set<string>());
  const mountedRef = React.useRef(false);
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });

  const updateFile = React.useCallback(
    (id: string, patch: Partial<FileUploadState>) => {
      const index = filesRef.current.findIndex((file) => file.id === id);
      if (index < 0) return;
      const next = filesRef.current.slice();
      const updated = { ...next[index], ...patch };
      next[index] = updated;
      filesRef.current = next;
      setFiles(next);
      return updated;
    },
    [],
  );

  const cancelJob = React.useCallback((id: string) => {
    const job = jobsRef.current.get(id);
    if (!job) return;
    if (!job.started) {
      jobsRef.current.delete(id);
      job.resolve(null);
    }
    job.controller.abort();
  }, []);

  const reset = React.useCallback(() => {
    for (const id of jobsRef.current.keys()) cancelJob(id);
    for (const file of filesRef.current) {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    }
    filesRef.current = [];
  }, [cancelJob]);

  React.useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reset();
    };
  }, [reset]);

  const clear = React.useCallback(() => {
    reset();
    setFiles([]);
  }, [reset]);

  const addFiles = React.useCallback(
    (incoming: FileList | File[], directory = false): FileUploadState[] => {
      const candidates = Array.from(incoming).filter(
        (file) =>
          file.name !== ".DS_Store" &&
          (!directory || !validateFileType(file, accept)),
      );
      const existing = multiple ? filesRef.current.length : 0;
      const capacity =
        maxFiles === undefined ? Infinity : Math.max(0, maxFiles - existing);
      const selected = (multiple ? candidates : candidates.slice(-1)).slice(
        0,
        capacity,
      );
      if (!selected.length) return [];
      if (!multiple) clear();

      const added = selected.map((file): FileUploadState => {
        const error = validateFile(file, accept, maxSize);
        return {
          id: Math.random().toString(36).slice(2) + Date.now().toString(36),
          file,
          name: file.name,
          size: file.size,
          relativePath: directory
            ? file.webkitRelativePath || undefined
            : undefined,
          status: error ? "error" : "idle",
          progress: 0,
          previewUrl:
            !error && file.type.startsWith("image/")
              ? URL.createObjectURL(file)
              : undefined,
          error: error ?? undefined,
          validationError: !!error,
        };
      });

      filesRef.current = [...filesRef.current, ...added];
      setFiles(filesRef.current);
      return added;
    },
    [accept, clear, maxSize, multiple, maxFiles],
  );

  const removeFile = React.useCallback(
    (id: string) => {
      const file = filesRef.current.find((file) => file.id === id);
      if (!file) return;
      cancelJob(id);
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      filesRef.current = filesRef.current.filter((file) => file.id !== id);
      setFiles(filesRef.current);
    },
    [cancelJob],
  );

  const abort = React.useCallback(
    (id: string) => {
      const file = filesRef.current.find((file) => file.id === id);
      if (!file || !isUploadPending(file.status)) return;
      cancelJob(id);
      updateFile(id, { status: "aborted" });
    },
    [cancelJob, updateFile],
  );

  const pumpQueue = React.useCallback(function pumpQueue() {
    if (!mountedRef.current) return;
    const configured = optionsRef.current.concurrency ?? 3;
    const limit = Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : 3;
    const activePaths = activePathsRef.current;
    for (const [id, job] of jobsRef.current) {
      if (activePaths.size >= limit) break;
      if (job.started || activePaths.has(job.path)) continue;
      job.started = true;
      activePaths.add(job.path);
      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          jobsRef.current.delete(id);
          activePaths.delete(job.path);
          pumpQueue();
        });
    }
  }, []);

  React.useEffect(() => {
    pumpQueue();
  }, [concurrency, pumpQueue]);

  const enqueue = React.useCallback(
    (pending: FileUploadState[]) => {
      const settings = optionsRef.current;
      const sign = settings.sign;
      let batchSignature: Promise<SignedUpload> | undefined;
      const authorize = (attempt: number) => {
        if (!sign) return;
        if (attempt > 1) return Promise.resolve().then(sign);
        batchSignature ??= Promise.resolve().then(sign);
        return batchSignature;
      };

      const uploads = pending.map(
        (file) =>
          new Promise<UploadedFile | null>((resolve, reject) => {
            const controller = new AbortController();
            const { signal } = controller;
            // Let the server finish deduplicating same-name files before starting the next one.
            // The API can change the extension during processing, so group by the path stem.
            const path = (file.relativePath ?? file.name)
              .replace(/\.[^./]+$/, "")
              .normalize("NFC")
              .toLowerCase();
            const update = (patch: Partial<FileUploadState>) =>
              signal.aborted ? undefined : updateFile(file.id, patch);
            jobsRef.current.set(file.id, {
              controller,
              path,
              started: false,
              resolve,
              reject,
              run: async () => {
                let result: UploadedFile;
                try {
                  result = await uploadFile(
                    file,
                    settings,
                    authorize,
                    signal,
                    update,
                    (progress) => {
                      const current = update({ progress });
                      if (current)
                        optionsRef.current.onProgress?.(current, progress);
                    },
                  );
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : "Upload failed";
                  const current = update({ status: "error", error: message });
                  if (current)
                    optionsRef.current.onError?.({ file: current, message });
                  return null;
                }
                const current = update({
                  status: "success",
                  progress: 100,
                  result,
                });
                if (current) optionsRef.current.onFileSuccess?.(result);
                return current ? result : null;
              },
            });
          }),
      );
      const ids = new Set(pending.map((file) => file.id));
      filesRef.current = filesRef.current.map((file) =>
        ids.has(file.id)
          ? { ...file, status: "queued", progress: 0, error: undefined }
          : file,
      );
      setFiles(filesRef.current);
      pumpQueue();
      return Promise.all(uploads);
    },
    [pumpQueue, updateFile],
  );

  const upload = React.useCallback(async (): Promise<UploadedFile[]> => {
    const pending = filesRef.current.filter(
      (file) => file.status === "idle" && !jobsRef.current.has(file.id),
    );
    if (!pending.length) return [];
    const results = (await enqueue(pending)).filter(
      (result) => result !== null,
    );
    if (results.length && mountedRef.current)
      optionsRef.current.onSuccess?.(results);
    return results;
  }, [enqueue]);

  const retry = React.useCallback(
    async (id: string): Promise<UploadedFile | null> => {
      const file = filesRef.current.find((file) => file.id === id);
      if (
        !file ||
        file.validationError ||
        jobsRef.current.has(id) ||
        (file.status !== "error" && file.status !== "aborted")
      )
        return null;
      const [result] = await enqueue([file]);
      if (result && mountedRef.current)
        optionsRef.current.onSuccess?.([result]);
      return result;
    },
    [enqueue],
  );

  return {
    files,
    isUploading: files.some((file) => isUploadPending(file.status)),
    addFiles,
    removeFile,
    upload,
    retry,
    abort,
    clear,
  };
}
