"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  File as FileIcon,
  Film,
  FolderOpen,
  ImageIcon,
  RotateCw,
  UploadCloud,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DEFAULT_ACCEPT,
  isUploadPending,
  uploadMaxSize,
  useFileUpload,
  type FileUploadState,
  type UseFileUploadOptions,
} from "@/components/openinary/use-file-upload";

export type FileUploaderProps = UseFileUploadOptions & {
  /** Enable the directory picker on session-based uploaders. */
  allowDirectoryUpload?: boolean;
  /** Upload automatically as soon as files are added. Default false. */
  autoUpload?: boolean;
  disabled?: boolean;
  className?: string;
};

const statusLabels = {
  idle: "Waiting to upload",
  queued: "Waiting to upload",
  processing: "Processing and saving…",
  retrying: "Waiting to retry…",
  success: "Uploaded",
  aborted: "Cancelled",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function acceptAttribute(accept: Record<string, string[]>): string {
  return Array.from(new Set(Object.values(accept).flat())).join(",");
}

function FileThumbnail({ file }: { file: FileUploadState }) {
  if (file.previewUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={file.previewUrl}
        alt={file.name}
        className="size-10 shrink-0 rounded-md object-cover"
      />
    );
  }
  const Icon = file.file.type.startsWith("video/")
    ? Film
    : file.file.type.startsWith("image/")
      ? ImageIcon
      : FileIcon;
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
      <Icon className="size-5 text-muted-foreground" />
    </div>
  );
}

export function FileUploader({
  allowDirectoryUpload = false,
  autoUpload = false,
  disabled = false,
  className,
  ...options
}: FileUploaderProps) {
  const { accept = DEFAULT_ACCEPT, maxFiles, multiple = true } = options;
  const maxSize = uploadMaxSize(options.authMode, options.maxSize);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const directoryRef = React.useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [emptyDirectory, setEmptyDirectory] = React.useState(false);

  const {
    files,
    isUploading,
    addFiles,
    removeFile,
    upload,
    retry,
    abort,
    clear,
  } = useFileUpload(options);

  const handleFiles = React.useCallback(
    (list: FileList | File[], directory = false) => {
      const added = addFiles(list, directory);
      setEmptyDirectory(directory && !added.length);
      if (autoUpload && added.some((f) => f.status === "idle")) {
        void upload();
      }
    },
    [addFiles, autoUpload, upload],
  );

  const openPicker = React.useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const onDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      if (event.dataTransfer.files?.length) {
        handleFiles(event.dataTransfer.files);
      }
    },
    [disabled, handleFiles],
  );

  const hasPending = files.some((f) => f.status === "idle");
  const limits = [
    Number.isFinite(maxSize) && `Up to ${formatBytes(maxSize)} per file`,
    maxFiles && `max ${maxFiles} file${maxFiles > 1 ? "s" : ""}`,
  ].filter(Boolean);

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-4", className)}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Upload files. Click to browse or drop files here."
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input px-6 py-10 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isDragging && "border-primary bg-accent",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:bg-accent/50",
        )}
      >
        <UploadCloud className="size-8 text-muted-foreground" />
        <div className="text-sm font-medium">
          Drag &amp; drop files here, or{" "}
          <span className="text-primary underline underline-offset-4">
            browse
          </span>
        </div>
        {limits.length > 0 && (
          <p className="text-xs text-muted-foreground">{limits.join(" · ")}</p>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple={multiple}
        accept={acceptAttribute(accept)}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {allowDirectoryUpload && options.authMode === "session" && multiple && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={directoryRef}
            type="file"
            hidden
            multiple
            disabled={disabled}
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files, true);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => directoryRef.current?.click()}
          >
            <FolderOpen className="size-4" />
            Select folder
          </Button>
          {emptyDirectory && (
            <span role="status" className="text-xs text-muted-foreground">
              No files were added from this folder.
            </span>
          )}
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex max-h-[min(16rem,40dvh)] flex-col gap-2 overflow-y-auto">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
            >
              <FileThumbnail file={file} />

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="truncate text-sm font-medium"
                    title={file.relativePath ?? file.name}
                  >
                    {file.relativePath ?? file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                  </span>
                </div>

                {file.status === "uploading" && (
                  <>
                    <Progress
                      aria-label={`Uploading ${file.relativePath ?? file.name}`}
                      value={file.progress || undefined}
                      className={cn(
                        "h-1.5",
                        file.progress === 0 && "animate-pulse",
                      )}
                    />
                    <span className="text-xs text-muted-foreground">
                      {file.progress > 0
                        ? `Uploading ${file.progress}%`
                        : "Uploading…"}
                    </span>
                  </>
                )}

                {file.status === "error" && (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle className="size-3" />
                    <span>Failed. {file.error}</span>
                  </span>
                )}

                {file.status !== "uploading" && file.status !== "error" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {file.status === "success" && (
                      <CheckCircle2 className="size-3 text-green-600" />
                    )}
                    {statusLabels[file.status]}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {isUploadPending(file.status) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Cancel upload"
                    onClick={() => abort(file.id)}
                  >
                    <X className="size-4" />
                  </Button>
                ) : (
                  <>
                    {(file.status === "error" || file.status === "aborted") &&
                      !file.validationError && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label="Retry upload"
                          disabled={disabled}
                          onClick={() => void retry(file.id)}
                        >
                          <RotateCw className="size-4" />
                        </Button>
                      )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label="Remove file"
                      onClick={() => removeFile(file.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && !autoUpload && (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={clear}
            disabled={isUploading}
          >
            Clear
          </Button>
          <Button
            type="button"
            onClick={() => void upload()}
            disabled={disabled || isUploading || !hasPending}
          >
            {isUploading ? "Uploading…" : "Upload files"}
          </Button>
        </div>
      )}
    </div>
  );
}
