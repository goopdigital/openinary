import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { enginePathsIn } from "../../config/paths";
import { VideoCommandBuilder } from "./command-builder";
import { detectVideoSettings } from "./config";
import { transformVideo } from "./index";
import { applyQuality } from "./quality";

const hasFfmpeg = (() => {
  try {
    for (const binary of ["ffmpeg", "ffprobe"]) {
      execFileSync(binary, ["-version"], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
})();
const options = { skip: !hasFfmpeg && "ffmpeg or ffprobe not installed" };
const settings = detectVideoSettings({ ffmpegThreads: 1, ffmpegNiceness: 0 }).settings;

function createVideo(path: string, withAudio: boolean, pixelFormat = "yuv420p", duration = "0.5") {
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10",
    ...(withAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"] : []),
    "-t", duration, "-c:v", "libx264", "-pix_fmt", pixelFormat,
    ...(withAudio ? ["-c:a", "aac"] : ["-an"]),
    path,
  ]);
}

for (const extension of ["mp4", "mov"]) {
  for (const withAudio of [true, false]) {
    test(`resized WebP thumbnail from ${extension} ${withAudio ? "with" : "without"} audio`, options, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "thumbnail-test-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const source = join(dir, `source.${extension}`);
      createVideo(source, withAudio);

      const buffer = await transformVideo(source, {
        format: "webp", thumbnailTime: 0, width: 64, height: 64, crop: "fill",
      }, { storage: null, paths: enginePathsIn(dir), settings });

      const image = await sharp(buffer).metadata();
      assert.equal(image.format, "webp");
      assert.equal(image.width, 64);
      assert.equal(image.height, 64);
      const { data } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.ok(data[0]! > 200 && data[1]! < 30 && data[2]! < 30, "thumbnail contains the source's red frame");
    });
  }

  test(`JPEG thumbnail without resize from ${extension} with audio`, options, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "thumbnail-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, `source.${extension}`);
    createVideo(source, true);

    const buffer = await transformVideo(source, { format: "jpg", thumbnailTime: 0 }, {
      storage: null, paths: enginePathsIn(dir), settings,
    });

    const image = await sharp(buffer).metadata();
    assert.equal(image.format, "jpeg");
    assert.equal(image.width, 160);
    assert.equal(image.height, 90);
  });

  test(`resized video from ${extension} uses MP4 encoding defaults and preserves audio`, options, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "thumbnail-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, `source.${extension}`);
    createVideo(source, true, "yuv444p");

    const buffer = await transformVideo(source, { format: "mp4", width: 64, height: 64, crop: "fill" }, {
      storage: null, paths: enginePathsIn(dir), settings,
    });
    const output = join(dir, "output.mp4");
    await writeFile(output, buffer);
    const { streams } = JSON.parse(execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,profile,pix_fmt,width,height",
      "-of", "json", output,
    ], { encoding: "utf8" }));
    const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.profile, "High");
    assert.equal(video.pix_fmt, "yuv420p");
    assert.equal(video.width, 64);
    assert.equal(video.height, 64);
    assert.ok(streams.some((stream: { codec_type: string; codec_name: string }) =>
      stream.codec_type === "audio" && stream.codec_name === "aac"));
    const moov = buffer.indexOf("moov");
    const mdat = buffer.indexOf("mdat");
    assert.ok(moov >= 0 && mdat > moov, "MP4 metadata precedes media data for fast start");
  });
}

test("trimmed and resized WebM runs two VP9 passes and retains Opus audio", options, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webm-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.mp4");
  createVideo(source, true);
  const log = t.mock.method(console, "log", () => {});

  const buffer = await transformVideo(source, {
    format: "webm", width: 64, height: 64, crop: "fill", startOffset: 0.1, endOffset: 0.4,
  }, { storage: null, paths: enginePathsIn(dir), settings });

  const commands = log.mock.calls.map(({ arguments: [line] }) => String(line))
    .filter((line) => line.startsWith("ffmpeg "));
  assert.equal(commands.length, 2);
  assert.match(commands[0], / -an .* -pass 1 /);
  assert.match(commands[1], / -acodec libopus .* -pass 2 /);
  for (const command of commands) {
    assert.match(command, / -crf 31 .* -deadline good -cpu-used 3 /);
  }
  const passLog = commands[0].match(/ -passlogfile (.+) -$/)?.[1];
  assert.ok(passLog);
  assert.ok(commands[1].includes(`-passlogfile ${passLog} `));
  await assert.rejects(stat(dirname(passLog)), { code: "ENOENT" });

  const output = join(dir, "output.webm");
  await writeFile(output, buffer);
  const { streams } = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames",
    "-of", "json", output,
  ], { encoding: "utf8" }));
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  assert.equal(video.codec_name, "vp9");
  assert.equal(video.width, 64);
  assert.equal(video.height, 64);
  assert.equal(video.nb_read_frames, "3");
  assert.ok(streams.some((stream: { codec_type: string; codec_name: string }) =>
    stream.codec_type === "audio" && stream.codec_name === "opus"));
});

test("a configured WebM timeout stops encoding and removes the work directory", options, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webm-timeout-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.mp4");
  createVideo(source, false, "yuv420p", "3");
  const workDir = await mkdtemp(join(dir, "encode-"));
  const builder = new VideoCommandBuilder({
    inputPath: source,
    outputPath: join(workDir, "output.webm"),
    tmpDir: workDir,
    params: {},
    isImageOutput: false,
    isThumbnail: false,
  }, { ...settings, ffmpegTimeoutSeconds: 1 });

  await builder.apply(
    (command) => ({ command: command.inputOptions("-re") }),
    applyQuality,
  );
  await assert.rejects(builder.execute(), /Video processing timeout: exceeded the 1s limit/);
  await assert.rejects(stat(workDir), { code: "ENOENT" });
});
