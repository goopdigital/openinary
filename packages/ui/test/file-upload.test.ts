import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { uploadViaXhr } from "../src/file-uploader/upload-transport";
import {
  DEFAULT_ACCEPT,
  retryDelay,
  uploadMaxSize,
  validateFile,
} from "../src/file-uploader/use-file-upload";

test("rate-limit delays support headers and body fallbacks", () => {
  const now = Date.UTC(2026, 0, 1);
  const reset = String(now / 1000 + 12);
  const delay = (headers: HeadersInit, retryAfter?: unknown) =>
    retryDelay(new Headers(headers), retryAfter, now);

  assert.equal(
    delay({ "Retry-After": "5", "X-RateLimit-Reset": reset }, 7),
    5000,
  );
  assert.equal(
    delay({ "Retry-After": new Date(now + 6000).toUTCString() }),
    6000,
  );
  assert.equal(delay({}, 7), 7000);
  assert.equal(delay({ "Retry-After": "-1" }, 7), 7000);
  assert.equal(delay({ "Retry-After": "", "X-RateLimit-Reset": reset }), 12000);
  assert.equal(delay({ "X-RateLimit-Reset": reset }), 12000);
  assert.equal(
    delay({ "Retry-After": "invalid", "X-RateLimit-Reset": "NaN" }),
    1000,
  );
  assert.equal(delay({}, null), 1000);
});

test("only presigned uploads default to a client-side size cap", () => {
  const file = new File([], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: 55 * 1024 * 1024 });
  assert.match(
    validateFile(file, DEFAULT_ACCEPT, uploadMaxSize(undefined)) ?? "",
    /50MB/,
  );
  assert.equal(
    validateFile(file, DEFAULT_ACCEPT, uploadMaxSize("session")),
    null,
  );
  assert.match(
    validateFile(file, DEFAULT_ACCEPT, uploadMaxSize("session", 1024 * 1024)) ??
      "",
    /1MB/,
  );
  assert.match(
    validateFile(new File([], "notes.txt"), DEFAULT_ACCEPT, Infinity) ?? "",
    /not allowed/,
  );
});

class MockXhr {
  upload: {
    onload?: () => void;
    onprogress?: (
      event: Pick<ProgressEvent, "lengthComputable" | "loaded" | "total">,
    ) => void;
  } = {};
  onload?: () => void;
  onloadend?: () => void;
  onabort?: () => void;
  status = 201;
  responseText = '{"success":true}';
  withCredentials = false;
  method?: string;
  url?: string;
  body?: FormData;
  aborted = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: FormData) {
    this.body = body;
  }

  getResponseHeader(name: string) {
    return name === "Content-Type" ? "application/json" : null;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }
}

function mockXhr(t: TestContext) {
  const xhr = new MockXhr();
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "XMLHttpRequest",
  );
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    value: function () {
      return xhr;
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });
  return xhr;
}

test("XHR reports completed transfer before completing the request", async (t) => {
  const xhr = mockXhr(t);
  const events: (number | string)[] = [];
  const body = new FormData();
  const responsePromise = uploadViaXhr({
    url: "/api/upload",
    body,
    withCredentials: true,
    signal: new AbortController().signal,
    onProgress: (progress) => events.push(progress),
    onTransferComplete: () => events.push("processing"),
  }).then((response) => {
    events.push("response");
    return response;
  });

  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "/api/upload");
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.body, body);
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
  xhr.upload.onload?.();
  await Promise.resolve();
  assert.deepEqual(events, [33, "processing"]);

  xhr.onload?.();
  xhr.onloadend?.();
  const response = await responsePromise;
  assert.deepEqual(events, [33, "processing", "response"]);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(await response.text(), '{"success":true}');
});

test("the transport aborts an in-flight XHR and does not opt presigned uploads into credentials", async (t) => {
  const xhr = mockXhr(t);
  const controller = new AbortController();
  const response = uploadViaXhr({
    url: "/upload",
    body: new FormData(),
    withCredentials: false,
    signal: controller.signal,
    onProgress: () => {},
    onTransferComplete: () => {},
  });
  assert.equal(xhr.withCredentials, false);
  controller.abort();
  await assert.rejects(response, { name: "AbortError" });
  assert.equal(xhr.aborted, true);
});
