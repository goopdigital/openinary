"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FileUploader } from "../file-uploader/file-uploader";
import { invalidateStorage } from "../hooks/use-storage-tree";
import { useOpeninary } from "../provider/openinary-provider";

export function UploadSection({ uploadToFolder }: { uploadToFolder?: string }) {
  const { apiBaseUrl, readOnly, uploadTransport, uploadDirectoryPathField } =
    useOpeninary();
  const queryClient = useQueryClient();

  if (readOnly) return null;

  return (
    <FileUploader
      baseUrl={apiBaseUrl}
      authMode="session"
      folder={uploadToFolder}
      transport={uploadTransport}
      directoryPathField={uploadDirectoryPathField}
      allowDirectoryUpload
      onFileSuccess={() => invalidateStorage(queryClient)}
    />
  );
}
