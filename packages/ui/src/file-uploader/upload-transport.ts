/** A single multipart request. A transport should honour the abort signal. */
export interface UploadTransportRequest {
  url: string;
  body: FormData;
  withCredentials: boolean;
  headers?: HeadersInit;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  onTransferComplete: () => void;
}

export interface UploadTransportResponse {
  status: number;
  headers: Pick<Headers, "get">;
  text(): Promise<string>;
}

export type UploadTransport = (
  request: UploadTransportRequest,
) => Promise<UploadTransportResponse>;

export const uploadViaXhr: UploadTransport = ({
  url,
  body,
  withCredentials,
  headers,
  signal,
  onProgress,
  onTransferComplete,
}) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = withCredentials;
    if (headers)
      new Headers(headers).forEach((value, name) =>
        xhr.setRequestHeader(name, value),
      );

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.upload.onload = onTransferComplete;

    xhr.onload = () =>
      resolve({
        status: xhr.status,
        headers: { get: (name) => xhr.getResponseHeader(name) },
        text: async () => xhr.responseText,
      });
    xhr.onerror = () =>
      reject(new Error("Network error, check the API URL and CORS settings"));
    xhr.ontimeout = () => reject(new Error("Upload request timed out"));
    xhr.onabort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    try {
      xhr.send(body);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
    }
  });
