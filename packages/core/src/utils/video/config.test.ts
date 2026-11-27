import assert from "node:assert/strict";
import test from "node:test";
import { detectVideoSettings } from "./config";

test("FFmpeg timeout defaults to five minutes and accepts a positive integer override", () => {
  assert.equal(detectVideoSettings().settings.ffmpegTimeoutSeconds, 300);
  assert.equal(detectVideoSettings({ ffmpegTimeoutSeconds: 900 }).settings.ffmpegTimeoutSeconds, 900);
});

test("invalid FFmpeg timeouts fall back to five minutes", () => {
  for (const ffmpegTimeoutSeconds of [0, -1, 0.5, NaN, Infinity, 2_147_484]) {
    assert.equal(detectVideoSettings({ ffmpegTimeoutSeconds }).settings.ffmpegTimeoutSeconds, 300);
  }
});
