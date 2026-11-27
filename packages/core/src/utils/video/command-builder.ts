import ffmpeg, { FfmpegCommand, FilterSpecification } from "fluent-ffmpeg";
import { readFile, rmdir } from "fs/promises";
import { join } from "path";
import type { VideoContext, TransformFunction } from "./types";
import { type VideoSettings } from "./config";
import { expectedOutputSeconds } from "../../eta";
import { extOf } from "../../url/media-types";
import { removeTempFile } from "../stage-source";

// The analysis pass accounts for roughly a quarter of the measured encode time.
const FIRST_PASS_FRACTION = 0.25;

/**
 * How far an encode has got. outputSeconds is the duration of the video being
 * produced (the source's, trimmed), which is what the fraction is measured
 * against.
 */
export interface EncodeProgress {
  fraction: number;
  outputSeconds: number;
}

/** "HH:MM:SS.xx", as ffmpeg prints durations and timemarks, in seconds */
function parseTimemark(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Builder class for constructing and executing ffmpeg commands
 * Provides a fluent interface for applying multiple transformations
 */
export class VideoCommandBuilder {
  private command: FfmpegCommand;
  private complexFilter: FilterSpecification[];
  private outputVideoStream: string;
  private context: VideoContext;
  private readonly timeoutSeconds: number;
  private cleanupFunctions: ((() => void) | (() => Promise<void>))[];

  constructor(
    context: VideoContext,
    settings: Pick<VideoSettings, "ffmpegThreads" | "ffmpegNiceness" | "ffmpegTimeoutSeconds">,
  ) {
    this.context = context;
    this.complexFilter = [];
    this.outputVideoStream = "0:v";
    this.timeoutSeconds = settings.ffmpegTimeoutSeconds;
    this.cleanupFunctions = [];
    this.command = ffmpeg(context.inputPath, { niceness: settings.ffmpegNiceness })
      .addOption("-threads", String(settings.ffmpegThreads));

    if (context.isImageOutput) {
      this.command.noAudio();
    } else {
      const format = extOf(context.outputPath);
      if (format === "mp4" || format === "mov") {
        this.command.addOption("-movflags", "+faststart");
      }
      this.command.addOption("-max_muxing_queue_size", "1024"); // Prevent buffer issues
    }
  }

  /**
   * Apply one or more transformation functions to the ffmpeg command
   * Returns this for method chaining
   */
  async apply(...transforms: TransformFunction[]): Promise<this> {
    for (const transform of transforms) {
      const response = await transform(
        this.command,
        this.outputVideoStream,
        this.context,
      );

      if (!response) continue;

      const { command, complexFilters, outputVideoStream, cleanupFunc } =
        response;

      if (command) this.command = command;
      if (complexFilters) this.complexFilter.push(...complexFilters);
      if (outputVideoStream) this.outputVideoStream = outputVideoStream;
      if (cleanupFunc) this.cleanupFunctions.push(cleanupFunc);
    }
    return this;
  }

  /**
   * Encode and return the output buffer. Both WebM passes share one timeout.
   */
  async execute(onProgress?: (progress: EncodeProgress) => void): Promise<Buffer> {
    const deadline = performance.now() + this.timeoutSeconds * 1_000;
    const { outputPath, tmpDir, isImageOutput } = this.context;
    const passLog = !isImageOutput && extOf(outputPath) === "webm"
      ? join(tmpDir, "vp9-pass")
      : undefined;
    const hasFilters = this.complexFilter.length > 0;

    try {
      if (hasFilters) {
        this.command
          .complexFilter(this.complexFilter)
          .addOption("-map", `[${this.outputVideoStream}]`);
      }

      if (passLog) {
        // Clone before assigning an output so fluent-ffmpeg keeps the video options.
        const firstPass = this.command.clone()
          .noAudio()
          .format("null")
          // The null muxer defaults to passthrough. Match WebM's frame sync.
          .addOption("-fps_mode", "vfr")
          .addOption("-pass", "1")
          .addOption("-passlogfile", passLog)
          .output("-");
        await this.runPass(firstPass, deadline, onProgress && (progress => {
          onProgress({
            ...progress,
            fraction: progress.fraction * FIRST_PASS_FRACTION,
          });
        }));
        this.command.addOption("-pass", "2").addOption("-passlogfile", passLog);
      }

      if (hasFilters && !isImageOutput) {
        this.command.addOption("-map", "0:a?");
      }
      this.command.output(outputPath);
      await this.runPass(this.command, deadline, passLog && onProgress ? progress => {
        onProgress({
          ...progress,
          fraction: FIRST_PASS_FRACTION + (1 - FIRST_PASS_FRACTION) * progress.fraction,
        });
      } : onProgress);
      return await readFile(outputPath);
    } finally {
      await removeTempFile(outputPath);
      if (passLog) await removeTempFile(`${passLog}-0.log`);
      try {
        await this.cleanup();
      } finally {
        await rmdir(tmpDir).catch(() => {});
      }
    }
  }

  private async runPass(
    command: FfmpegCommand,
    deadline: number,
    onProgress?: (progress: EncodeProgress) => void,
  ): Promise<void> {
    const remaining = deadline - performance.now();
    const timeoutMessage = `Video processing timeout: exceeded the ${this.timeoutSeconds}s limit. Try reducing video resolution or duration.`;
    if (remaining <= 0) throw new Error(timeoutMessage);

    return new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        command.kill("SIGKILL");
      }, remaining);

      const finish = (error?: unknown) => {
        clearTimeout(timeoutId);
        if (timedOut) reject(new Error(timeoutMessage));
        else if (error) reject(new Error(
          `Video processing failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
        else resolve();
      };

      command.once("start", (cmd) => {
        if (timedOut) command.kill("SIGKILL");
        else console.log(cmd);
      });

      if (onProgress) {
        let outputSeconds: number | null = null;
        command
          .once("codecData", (data: { duration?: string }) => {
            outputSeconds = expectedOutputSeconds(
              parseTimemark(data.duration),
              this.context.params,
            );
          })
          .on("progress", (progress: { timemark?: string }) => {
            const done = parseTimemark(progress.timemark);
            if (timedOut || !outputSeconds || done === null) return;
            onProgress({
              fraction: Math.min(1, Math.max(0, done / outputSeconds)),
              outputSeconds,
            });
          });
      }

      command.once("end", () => finish()).once("error", finish);
      try {
        command.run();
      } catch (error) {
        finish(error);
      }
    });
  }

  async cleanup(): Promise<void> {
    for (const func of this.cleanupFunctions) {
      await func();
    }
  }
}
