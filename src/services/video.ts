import { config } from '../utils/config';
import ffmpegStaticPath from 'ffmpeg-static';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strEnv, intEnv } from '../utils/env';
import { safeFetchBuffer } from '../utils/safe-fetch';

interface ProcessedVideo {
  uri: string;
  mimeType: string;
  inlineData: boolean;
}

/**
 * The ffmpeg binary.
 *
 * `ffmpeg-static` resolves to `null` when its post-install download did not run
 * (very common on Termux/Android, where the bundled binary is not runnable at
 * all). `FFMPEG_PATH` lets an operator point at a system ffmpeg instead, which
 * on Android is the only thing that actually works. Checked once, here, rather
 * than sprinkled through the call sites.
 */
const FFMPEG_BIN: string = strEnv('FFMPEG_PATH', '') || ffmpegStaticPath || '';

/** Wall-clock ceiling for a single compression/encode pass. */
const ENCODE_TIMEOUT_MS = 60_000;

/** Wall-clock ceiling for a `ffmpeg -i` probe (no output file). */
const PROBE_TIMEOUT_MS = 10_000;

/** Grace period between SIGTERM and SIGKILL when an encode overruns. */
const KILL_GRACE_MS = 2_000;

/**
 * How long to wait for the child's pipes to settle after it has exited.
 *
 * This has to be bounded, and not merely for tidiness. A killed process can
 * leave a grandchild alive holding the write end of stdout/stderr, in which
 * case `new Response(proc.stderr).text()` never resolves even though the child
 * itself is gone and `proc.exited` already resolved. Awaiting the drain
 * unconditionally turns a successful kill into an infinite hang — which is the
 * exact failure mode this function exists to prevent.
 */
const DRAIN_GRACE_MS = 2_000;

/**
 * Sentinel `exitCode` meaning "the child never reported an exit". Distinct from
 * any real exit code, so the caller can tell a kill apart from an ffmpeg error.
 */
const STILL_RUNNING_EXIT = -1;

/**
 * Minimal reader shape we rely on.
 *
 * Declared structurally rather than as `ReadableStreamDefaultReader<Uint8Array>`
 * because Bun's stream types add a `readMany` member the DOM lib's default
 * reader type does not declare, so naming the DOM type fails to typecheck.
 */
interface PipeReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

function acquireReader(stream: ReadableStream<Uint8Array>): PipeReader {
  return stream.getReader() as unknown as PipeReader;
}

/** Read a pipe to EOF as text, decoding incrementally so multi-byte chars survive chunk splits. */
async function drainText(reader: PipeReader): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Resolve to `fallback` if `promise` has not settled within `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cap on input duration, in seconds.
 *
 * Without this, a 40-minute video keeps libx264/libvpx busy for many minutes:
 * the process survives every timeout we set, the `finally` block unlinks the
 * output file *while the encoder is still writing to it*, and on Termux that
 * leaves orphaned processes burning CPU plus a corrupt temp file. Bounding the
 * duration is the difference between "we stop" and "we leak".
 *
 * Read from `VIDEO_MAX_INPUT_SECONDS` (default 60, minimum 1) rather than
 * hardcoded, so an operator with a genuinely long clip can raise it without
 * editing source — while the shipped default stays the conservative one.
 * Passed to ffmpeg as `-t`, so it is a hard cap: the encoder stops there even
 * if the input is longer, it is not a target to transcode up to.
 */
const MAX_INPUT_SECONDS = intEnv('VIDEO_MAX_INPUT_SECONDS', 60, { min: 1 });

/**
 * Module-level encode semaphore.
 *
 * ffmpeg is CPU-saturating and this bot runs on a phone. Without a cap, several
 * GIFs posted at once spawn several encoders and the whole process stalls.
 * One at a time is the safe default; two is the ceiling.
 */
const MAX_CONCURRENT_ENCODERS = 2;

interface FfmpegResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when we killed the process because it exceeded its deadline. */
  timedOut: boolean;
  signalCode: NodeJS.Signals | null;
  /** The exact argv handed to `Bun.spawn`, for logging. */
  argv: string[];
}

let activeEncoders = 0;
const encoderWaiters: Array<() => void> = [];

/**
 * Acquire an encode slot, waiting until one is free.
 *
 * The slot is reserved by `releaseEncoderSlot` *at handoff time*, not by the
 * waiter after it resumes. Reserving on resume would leave a window in which a
 * slot handed to a waiter has not yet been counted, and a fresh caller arriving
 * in that window would take it — letting the real concurrency exceed the cap.
 */
async function acquireEncoderSlot(): Promise<void> {
  if (activeEncoders < MAX_CONCURRENT_ENCODERS) {
    activeEncoders++;
    return;
  }
  await new Promise<void>((resolve) => {
    encoderWaiters.push(resolve);
  });
  // `activeEncoders` was already incremented by the releaser.
}

function releaseEncoderSlot(): void {
  const next = encoderWaiters.shift();
  if (next) {
    // Hand the slot straight over: keep the count as-is.
    next();
    return;
  }
  activeEncoders = Math.max(0, activeEncoders - 1);
}

/**
 * Run ffmpeg with an argv **array** and a hard deadline that KILLS the child.
 *
 * WHY NOT `Bun.$`
 * ---------------
 * The previous implementation built the whole command as one template string
 * and ran ``Bun.$`${cmd}` ``. A single interpolated string is passed as ONE argv
 * element, so Bun looked for a program literally named
 * `"/usr/bin/ffmpeg" -hide_banner -loglevel error -i ...` and returned
 * `command not found`. Every GIF posted by every user failed silently; the
 * surrounding 60-second `Promise.race` timeouts never even engaged because the
 * process never started. `Bun.spawn` with an argv array cannot have that bug.
 *
 * WHY WE KILL RATHER THAN ABANDON
 * -------------------------------
 * `Promise.race([spawn, timeout])` rejects the JS promise but leaves ffmpeg
 * running at 100% CPU, writing to a file the caller's `finally` is about to
 * `unlink`. On Android/Termux that leaks processes and corrupts temp files. The
 * deadline here escalates SIGTERM → SIGKILL and *awaits* the exit, so by the
 * time this returns the child is gone.
 *
 * Note there is no `2>&1`: the old calls redirected stderr into stdout while
 * the callers destructured `stderr`, so every ffmpeg diagnostic was silently
 * empty — which is precisely why the argv bug above went unnoticed for so long.
 */
async function runFfmpeg(args: string[], timeoutMs: number): Promise<FfmpegResult> {
  const argv = [FFMPEG_BIN, ...args];

  const proc = Bun.spawn({
    cmd: argv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  /**
   * Acquire readers and drain both pipes concurrently.
   *
   * Draining only one can deadlock a child that fills the other pipe's buffer,
   * so both start immediately.
   *
   * The readers are held (rather than consuming the streams via
   * `new Response(stream).text()`) because they are the only thing that can be
   * CANCELLED. If the child dies while a grandchild still holds the pipe write
   * end, the stream never ends; `Response.text()` then never settles, its
   * `Response` locks the stream, and the resulting live handle stops the Bun
   * process from exiting at all. Cancelling the readers releases the handle.
   */
  const stdoutReader = acquireReader(proc.stdout);
  const stderrReader = acquireReader(proc.stderr);
  const drainStdout = drainText(stdoutReader);
  const drainStderr = drainText(stderrReader);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const deadline = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already exited.
    }
    // Escalate if SIGTERM is ignored, and clear it once the child is gone.
    graceTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }, KILL_GRACE_MS);
  }, timeoutMs);

  try {
    // Wait for the exit first, on its own deadline — it can be short because a
    // child that exits releases its pipes.
    //
    // Then wait a bounded extra window for the drains. A killed child can leave a
    // grandchild holding the pipe write ends, in which case the drain never
    // finishes on its own; without this second bound a successful kill would
    // turn into an infinite hang. See DRAIN_GRACE_MS.
    let exitCode = await settleWithin(proc.exited, timeoutMs, STILL_RUNNING_EXIT);
    let stdout = '';
    let stderr = '';

    if (exitCode !== STILL_RUNNING_EXIT) {
      [stdout, stderr] = await Promise.all([
        settleWithin(drainStdout, DRAIN_GRACE_MS, ''),
        settleWithin(drainStderr, DRAIN_GRACE_MS, ''),
      ]);
    }

    if (exitCode === STILL_RUNNING_EXIT) {
      // Overran the deadline. The `deadline` timer has already sent SIGTERM (and
      // armed the SIGKILL escalation); give that a bounded moment to land, then
      // take the kill to SIGKILL ourselves.
      timedOut = true;
      exitCode = await settleWithin(proc.exited, KILL_GRACE_MS, STILL_RUNNING_EXIT);
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already exited between the wait and here.
      }
      if (exitCode === STILL_RUNNING_EXIT) {
        // Unkillable (already a zombie we cannot reap, or an uninterruptible
        // sleep). Report the overrun rather than pretending it succeeded.
        await settleWithin(proc.exited, DRAIN_GRACE_MS, STILL_RUNNING_EXIT);
      }
      [stdout, stderr] = await Promise.all([
        settleWithin(drainStdout, DRAIN_GRACE_MS, ''),
        settleWithin(drainStderr, DRAIN_GRACE_MS, ''),
      ]);
    }

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      signalCode: proc.signalCode ?? null,
      argv,
    };
  } finally {
    clearTimeout(deadline);
    if (graceTimer) clearTimeout(graceTimer);

    // Belt and braces: if anything above threw, the child must not outlive us.
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already exited.
    }

    // Cancel both readers unconditionally, including on the success path. A
    // reader that has already reached EOF is a no-op here; on the kill path this
    // is what releases the pipe handle so the process can still exit.
    await Promise.allSettled([
      stdoutReader.cancel().catch(() => {}),
      stderrReader.cancel().catch(() => {}),
    ]);
  }
}

/** Read a file into a Buffer. */
async function readFileBuffer(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer());
}

/** Host of a URL, for logging. Never throws and never includes the path. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Track every path we create so cleanup cannot miss one.
 *
 * The old `finally` unlinked a single `outputPath` variable that the re-encode
 * path *reassigned*, so on that branch the first-pass `output.webm`/`output.mp4`
 * was orphaned and the `mkdtemp` directory was never removed at all. An array
 * plus `rm(dir, { recursive: true })` closes both.
 */
class TempWorkspace {
  readonly dir: string;
  private readonly created: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
  }

  static async create(prefix: string): Promise<TempWorkspace> {
    return new TempWorkspace(await mkdtemp(join(tmpdir(), prefix)));
  }

  /** Reserve a path inside the workspace and remember it for cleanup. */
  path(name: string): string {
    const full = join(this.dir, name);
    this.created.push(full);
    return full;
  }

  async write(name: string, data: Buffer | Uint8Array): Promise<string> {
    const full = this.path(name);
    await writeFile(full, data);
    return full;
  }

  /**
   * Remove the directory and everything in it. A recursive `rm` subsumes the
   * per-file unlinks: any file ffmpeg created that we never named is swept up
   * too, which is what stops the temp dirs accumulating across restarts.
   */
  async cleanup(): Promise<void> {
    try {
      await rm(this.dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`⚠️  [VIDEO] Failed to remove temp dir ${this.dir}:`, error);
    }
  }
}

/**
 * Does this buffer start with a GIF87a / GIF89a magic number?
 *
 * The ffmpeg probe below is a *format* check, not a *content* check — ffmpeg
 * will happily read a polyglot file that is also valid HTML or a ZIP. Since the
 * bytes came from a URL, the magic number is the only thing that guarantees we
 * are about to hand a GIF to an encoder.
 */
function hasGifMagic(buffer: Buffer): boolean {
  if (buffer.length < 6) return false;
  const magic = buffer.subarray(0, 6).toString('latin1');
  return magic === 'GIF87a' || magic === 'GIF89a';
}

/**
 * Service for handling video content for Gemini API
 * Gemini 3 models support native video understanding via inline base64 data
 *
 * NOTE: We use inline base64 encoding instead of the File API because:
 * 1. The File API requires special resumable upload protocol (x-goog-upload-url headers)
 * 2. Most proxies (like llm.prolix.dev) don't support this proprietary protocol
 * 3. Inline data works through any standard HTTP proxy
 */
export class VideoService {
  /**
   * Check if video service is available (Gemini API key is configured)
   */
  isAvailable(): boolean {
    return config.gemini.enabled || config.openai.videoEnabled;
  }

  /**
   * Download video from URL (Discord CDN) and encode as base64
   * If video exceeds max size (default 50MB), compress it using configurable settings
   * Returns the video data for inline use in Gemini requests
   */
  async processVideo(videoUrl: string, mimeType?: string): Promise<ProcessedVideo | null> {
    if (!this.isAvailable()) {
      console.error('❌ [VIDEO] Video processing not available (set GEMINI_API_KEY or OPENAI_VIDEO_ENABLED=true)');
      return null;
    }

    if (!FFMPEG_BIN) {
      console.error('❌ [VIDEO] FFmpeg binary not found. Set FFMPEG_PATH or install ffmpeg-static.');
      return null;
    }

    // Handle GIFs separately - convert to WebM
    if (mimeType?.startsWith('image/gif')) {
      console.log(`🎬 [VIDEO] Detected GIF, routing to GIF converter...`);
      return this.convertGifToVideo(videoUrl);
    }

    // Download the video, capping the stream at the configured ceiling.
    //
    // The old code did `fetch(videoUrl)` with NO AbortSignal (unlike the GIF
    // path, which had one) and then `arrayBuffer()`'d the entire body BEFORE
    // comparing its length to `maxSizeMB`. A hostile or slow-loris URL therefore
    // had to deliver the whole payload before the limit was even consulted —
    // enough to OOM the bot process (fatal on a phone) or hang the turn forever.
    let contentType: string;
    let videoBuffer: Buffer;
    try {
      const download = await safeFetchBuffer(videoUrl, {
        maxBytes: getMaxVideoSize(),
        timeoutMs: 60_000,
        headers: { Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5' },
      });
      contentType = download.contentType.split(';')[0]?.trim() ?? '';
      videoBuffer = Buffer.from(download.buffer);
    } catch (error) {
      console.error('❌ [VIDEO] Failed to download video:', error instanceof Error ? error.message : error);
      return null;
    }

    // A declared content-type is not evidence — and a *wrong* one is a hard
    // reject, not a hint to be overridden.
    //
    // The old code took the response header verbatim and built
    // `data:${contentType};base64,...` from it, so a hostile embed URL could get
    // an HTML error page labelled `video/mp4` and have it forwarded to the model
    // vendor as "video". The rule here:
    //
    //   - server declared nothing  -> fall back to the caller's mimeType, which
    //                                  comes from Discord's own attachment record
    //   - server declared something we support -> use it
    //   - server declared anything else (text/html, application/json, ...)
    //                                  -> refuse outright
    //
    // Overriding a *declared* type with the caller's would reintroduce the
    // original bug in a subtler form: the body really is HTML, and relabelling
    // it does not make it a video.
    let effectiveType: string;
    if (!contentType) {
      effectiveType = mimeType ?? '';
      if (!effectiveType) {
        console.error('❌ [VIDEO] No content-type available from server or caller');
        return null;
      }
    } else {
      effectiveType = contentType;
    }

    if (!this.isSupportedVideoType(effectiveType)) {
      // Truncated: this line interpolates a server-controlled string, and the
      // same message is echoed to a public Discord channel by the log handler.
      console.error(
        `❌ [VIDEO] Refusing unsupported content type "${effectiveType.slice(0, 60)}"`,
      );
      return null;
    }

    let workspace: TempWorkspace | undefined;

    try {
      console.log(`🎥 [VIDEO] Downloaded ${videoBuffer.length} bytes (${effectiveType})`);

      // Check if compression is needed
      const maxVideoSize = getMaxVideoSize();
      if (videoBuffer.length > maxVideoSize) {
        console.log(`📦 [VIDEO] Video exceeds ${config.video.maxSizeMB}MB (${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB), compressing...`);

        workspace = await TempWorkspace.create('lumia-video-');
        const inputPath = await workspace.write('input.mp4', videoBuffer);
        const outputPath = workspace.path('output.mp4');

        // Compress video using FFmpeg with configurable settings
        // Use conditional scaling to only scale down, never up
        const targetRes = config.video.targetResolution;
        const crf = config.video.crf;
        console.log(`📦 [VIDEO] Compressing to max ${targetRes}p with CRF ${crf}...`);

        const startTime = Date.now();
        // Scale filter: only scale if input height >= target, otherwise keep original
        const scaleFilter = `scale='if(gte(ih,${targetRes}),-2,iw)':'if(gte(ih,${targetRes}),${targetRes},ih)'`;

        await acquireEncoderSlot();
        let result: FfmpegResult;
        try {
          result = await runFfmpeg(
            [
              '-hide_banner',
              '-loglevel', 'error',
              '-i', inputPath,
              // Bound the work: an unbounded encode is what leaked processes.
              '-t', String(MAX_INPUT_SECONDS),
              '-c:v', 'libx264',
              '-crf', String(crf),
              '-preset', 'fast',
              '-vf', `${scaleFilter},fps=30`,
              '-c:a', 'aac',
              '-b:a', '128k',
              '-movflags', '+faststart',
              '-y', outputPath,
            ],
            ENCODE_TIMEOUT_MS,
          );
        } finally {
          releaseEncoderSlot();
        }

        const duration = Date.now() - startTime;

        if (result.timedOut) {
          console.error(`⏱️  [VIDEO] FFmpeg compression exceeded ${ENCODE_TIMEOUT_MS}ms and was killed`);
          return null;
        }

        if (result.exitCode !== 0) {
          console.error(
            `❌ [VIDEO] FFmpeg compression failed (exit ${result.exitCode}, signal ${result.signalCode}):`,
            result.stderr.slice(0, 1000),
          );
          return null;
        }

        console.log(`✅ [VIDEO] Compression completed in ${duration}ms`);

        // Read compressed video
        const compressedBuffer = await readFileBuffer(outputPath);

        const originalSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);
        const compressedSizeMB = (compressedBuffer.length / 1024 / 1024).toFixed(2);
        const reduction = (((videoBuffer.length - compressedBuffer.length) / videoBuffer.length) * 100).toFixed(1);

        console.log(`📦 [VIDEO] Compressed: ${originalSizeMB}MB → ${compressedSizeMB}MB (${reduction}% reduction)`);

        if (compressedBuffer.length > maxVideoSize) {
          console.warn(`⚠️  [VIDEO] Compressed video still exceeds ${config.video.maxSizeMB}MB (${compressedSizeMB}MB), skipping...`);
          return null;
        }

        videoBuffer = compressedBuffer;
      }

      console.log(`🎥 [VIDEO] Encoding video as base64 for inline transmission...`);

      // Encode as base64 for inline transmission
      const base64Data = videoBuffer.toString('base64');

      console.log(`✅ [VIDEO] Video ready for inline transmission (${base64Data.length} chars base64, ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB)`);

      return {
        uri: `data:${effectiveType};base64,${base64Data}`,
        mimeType: effectiveType,
        inlineData: true,
      };
    } catch (error) {
      console.error('❌ [VIDEO] Error processing video:', error);
      return null;
    } finally {
      await workspace?.cleanup();
    }
  }

  /**
   * Process multiple videos
   */
  async processVideos(videos: { url: string; mimeType?: string }[]): Promise<ProcessedVideo[]> {
    const results: ProcessedVideo[] = [];

    for (const video of videos) {
      const processed = await this.processVideo(video.url, video.mimeType);
      if (processed) {
        results.push(processed);
      }
    }

    return results;
  }

  /**
   * Check if a MIME type is a supported video format
   */
  isSupportedVideoType(mimeType: string): boolean {
    const supportedTypes = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
      'video/mov',
      'image/gif', // GIFs are converted to WebM
    ];
    return supportedTypes.some(type => mimeType.toLowerCase().startsWith(type));
  }

  /**
   * Convert animated GIF to WebM video for better LLM processing
   * WebM is smaller, higher quality, and better supported than GIF for video understanding
   *
   * Uses `Bun.spawn` with an argv array, a semaphore, and hard kill-on-deadline.
   * See `runFfmpeg` for why the previous `Bun.$\`${commandString}\`` form could
   * never have worked.
   */
  async convertGifToVideo(gifUrl: string): Promise<ProcessedVideo | null> {
    const startTime = Date.now();

    if (!this.isAvailable()) {
      console.error('❌ [GIF] Video processing not available (set GEMINI_API_KEY or OPENAI_VIDEO_ENABLED=true)');
      return null;
    }

    if (!FFMPEG_BIN) {
      console.error('❌ [GIF] FFmpeg binary not found. Set FFMPEG_PATH or install ffmpeg-static.');
      return null;
    }

    let workspace: TempWorkspace | undefined;
    let useFallbackCodec = false;

    try {
      console.log(`🎬 [GIF] Starting GIF conversion process...`);
      // Host only: the path of a Discord CDN URL is an opaque signed token, and
      // logging even a prefix of a hostile URL puts attacker-chosen text into the
      // log stream.
      console.log(`🎬 [GIF] Downloading GIF from ${hostOf(gifUrl)}`);

      // Download the GIF, capping the stream.
      //
      // The old code fetched with a 30s AbortController but then
      // `arrayBuffer()`'d the whole body and only afterwards compared against
      // `maxGifSize = maxVideoSize * 3`. The cap was enforced on something that
      // was already fully in memory. The `content-length` short-circuit below is
      // a courtesy, not the control: the streaming cap in `safeFetchBuffer` is.
      const maxVideoSize = getMaxVideoSize();
      const maxGifSize = maxVideoSize * 3; // Allow GIFs up to 3x the video limit before conversion

      let gifBuffer: Buffer;
      try {
        const download = await safeFetchBuffer(gifUrl, {
          maxBytes: maxGifSize,
          timeoutMs: 30_000,
          headers: { Accept: 'image/gif,image/*;q=0.9,*/*;q=0.5' },
        });
        gifBuffer = Buffer.from(download.buffer);
      } catch (error) {
        if (error instanceof Error && error.name === 'ResponseTooLargeError') {
          console.error(`❌ [GIF] GIF exceeds the ${(maxGifSize / 1024 / 1024).toFixed(0)}MB limit`);
          return null;
        }
        console.error('❌ [GIF] GIF download failed:', error instanceof Error ? error.message : error);
        return null;
      }

      const originalSizeMB = (gifBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`🎬 [GIF] Downloaded ${gifBuffer.length} bytes (${originalSizeMB}MB)`);

      // Validate minimum size (prevents corrupted/empty files)
      if (gifBuffer.length < 100) {
        console.error(`❌ [GIF] GIF is too small (${gifBuffer.length} bytes), likely corrupted`);
        return null;
      }

      if (gifBuffer.length > maxVideoSize * 2) {
        console.warn(`⚠️  [GIF] GIF is very large (${originalSizeMB}MB), conversion may take time...`);
      }

      // Hard content gate BEFORE anything touches ffmpeg. See `hasGifMagic`.
      if (!hasGifMagic(gifBuffer)) {
        const seen = gifBuffer.subarray(0, 6).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
        console.error(`❌ [GIF] Not a GIF (magic bytes: "${seen}") — refusing to hand it to ffmpeg`);
        return null;
      }

      workspace = await TempWorkspace.create('lumia-gif-');
      const inputPath = await workspace.write('input.gif', gifBuffer);

      // Probe the GIF so a corrupt or truncated file fails before we commit to a
      // long encode.
      //
      // `ffmpeg -i file` with no output specified ALWAYS exits non-zero (there is
      // nothing to write), so the old `if (probeResult.exitCode !== 0)` was
      // unreachable — `Bun.$` threw a ShellError first, the `catch` swallowed it,
      // and the "validation" was a no-op. `.nothrow()` + parsing stderr for the
      // stream line is what makes this check actually do something.
      await acquireEncoderSlot();
      let probe: FfmpegResult;
      try {
        probe = await runFfmpeg(['-hide_banner', '-i', inputPath], PROBE_TIMEOUT_MS);
      } finally {
        releaseEncoderSlot();
      }

      if (probe.timedOut) {
        console.error(`⏱️  [GIF] GIF probe exceeded ${PROBE_TIMEOUT_MS}ms and was killed`);
        return null;
      }

      // ffmpeg prints its stream inventory to stderr. The non-zero exit is
      // expected (`-i` with no output has nothing to write); the absence of a GIF
      // video stream is the real failure.
      const probeOutput = `${probe.stdout}\n${probe.stderr}`;
      if (!/Stream #\d+:\d+[^\n]*Video: gif\b/i.test(probeOutput)) {
        console.error('❌ [GIF] ffmpeg found no GIF video stream in the downloaded file');
        // Diagnostics are logged, but the probe output describes attacker-supplied
        // bytes (filenames from the container, metadata), so it is length-capped.
        console.error(probeOutput.slice(0, 800));
        return null;
      }
      console.log(`✅ [GIF] Validated GIF format via ffmpeg probe`);

      // Convert GIF to WebM using FFmpeg
      // STRATEGY: Try VP9 first (better compression), fall back to H.264 if it fails
      const targetRes = config.video.targetResolution;
      let crf = Math.min(config.video.crf + 5, 35); // Slightly higher CRF for GIFs
      let conversionSuccessful = false;
      let attemptCount = 0;
      const maxAttempts = 2; // VP9 attempt + H.264 fallback

      // Registered up front so cleanup catches it whichever branch wins. The
      // attempt loop registers its own output file each iteration.
      let outputPath = workspace.path('output.webm');

      while (!conversionSuccessful && attemptCount < maxAttempts) {
        attemptCount++;
        useFallbackCodec = attemptCount > 1;

        const codec = useFallbackCodec ? 'libx264' : 'libvpx-vp9';
        const outputExt = useFallbackCodec ? 'mp4' : 'webm';
        outputPath = workspace.path(`output.${outputExt}`);

        console.log(`📦 [GIF] Conversion attempt ${attemptCount}/${maxAttempts}: Using ${codec} codec...`);

        const conversionStartTime = Date.now();

        const scaleFilter = `scale='if(gte(ih,${targetRes}),-2,iw)':'if(gte(ih,${targetRes}),${targetRes},ih)':flags=lanczos`;

        // Each argument is its own array element. No shell, no quoting, no
        // chance of the whole command collapsing into one argv slot.
        const codecArgs: string[] = useFallbackCodec
          ? ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast']
          : ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0'];

        await acquireEncoderSlot();
        let result: FfmpegResult;
        try {
          result = await runFfmpeg(
            [
              '-hide_banner',
              '-loglevel', 'error',
              '-i', inputPath,
              // Bound the input: an unbounded GIF encode is the leak.
              '-t', String(MAX_INPUT_SECONDS),
              ...codecArgs,
              '-vf', `${scaleFilter},fps=30`,
              ...(useFallbackCodec ? ['-movflags', '+faststart', '-pix_fmt', 'yuv420p'] : []),
              '-y', outputPath,
            ],
            ENCODE_TIMEOUT_MS,
          );
        } finally {
          releaseEncoderSlot();
        }

        const conversionDuration = Date.now() - conversionStartTime;

        if (result.timedOut) {
          console.error(`⏱️  [GIF] ${codec} conversion exceeded ${ENCODE_TIMEOUT_MS}ms and was killed`);
        } else if (result.exitCode === 0) {
          console.log(`✅ [GIF] Conversion completed in ${conversionDuration}ms using ${codec}`);
          conversionSuccessful = true;
        } else {
          // stderr is genuinely populated now that the `2>&1` redirect is gone.
          console.error(
            `❌ [GIF] ${codec} conversion failed (exit ${result.exitCode}, signal ${result.signalCode}):`,
            result.stderr.slice(0, 800),
          );
        }

        if (!conversionSuccessful) {
          if (attemptCount < maxAttempts) {
            console.log(`🔄 [GIF] Retrying with fallback codec...`);
            crf = Math.min(crf + 5, 40); // Increase compression for fallback
          } else {
            console.error(`❌ [GIF] All conversion attempts failed`);
            return null;
          }
        }
      }

      if (!conversionSuccessful || !outputPath) {
        console.error(`❌ [GIF] Conversion failed after ${attemptCount} attempts`);
        return null;
      }

      // Read converted video
      let outputBuffer = await readFileBuffer(outputPath);

      const outputSizeMB = (outputBuffer.length / 1024 / 1024).toFixed(2);
      const mimeType = useFallbackCodec ? 'video/mp4' : 'video/webm';
      const reduction = (((gifBuffer.length - outputBuffer.length) / gifBuffer.length) * 100).toFixed(1);

      console.log(`📦 [GIF] Converted: ${originalSizeMB}MB → ${outputSizeMB}MB (${reduction}% reduction) [${mimeType}]`);

      // If still too large, re-encode with higher compression
      if (outputBuffer.length > maxVideoSize) {
        console.log(`📦 [GIF] Output exceeds ${config.video.maxSizeMB}MB, re-encoding with higher compression...`);

        const highCompressionPath = workspace.path(`output_compressed.${useFallbackCodec ? 'mp4' : 'webm'}`);
        const fallbackRes = 480;
        const fallbackScaleFilter = `scale='if(gte(ih,${fallbackRes}),-2,iw)':'if(gte(ih,${fallbackRes}),${fallbackRes},ih)':flags=lanczos`;
        const fallbackCrf = useFallbackCodec ? 28 : 40;

        await acquireEncoderSlot();
        let reencode: FfmpegResult;
        try {
          reencode = await runFfmpeg(
            [
              '-hide_banner',
              '-loglevel', 'error',
              '-i', outputPath,
              '-t', String(MAX_INPUT_SECONDS),
              ...(useFallbackCodec
                ? ['-c:v', 'libx264', '-crf', String(fallbackCrf), '-preset', 'fast']
                : ['-c:v', 'libvpx-vp9', '-crf', String(fallbackCrf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-auto-alt-ref', '0']),
              '-vf', `${fallbackScaleFilter},fps=24`,
              ...(useFallbackCodec ? ['-movflags', '+faststart', '-pix_fmt', 'yuv420p'] : []),
              '-y', highCompressionPath,
            ],
            ENCODE_TIMEOUT_MS,
          );
        } finally {
          releaseEncoderSlot();
        }

        if (reencode.timedOut) {
          console.error(`⏱️  [GIF] Re-encode exceeded ${ENCODE_TIMEOUT_MS}ms and was killed`);
        } else if (reencode.exitCode === 0) {
          const compressedBuffer = await readFileBuffer(highCompressionPath);
          const compressedSizeMB = (compressedBuffer.length / 1024 / 1024).toFixed(2);

          console.log(`✅ [GIF] Re-encoded: ${outputSizeMB}MB → ${compressedSizeMB}MB`);

          if (compressedBuffer.length <= maxVideoSize) {
            // Note: `outputPath` is deliberately NOT reassigned here. The old
            // code did, which meant the `finally` unlinked only the second file
            // and orphaned the first. Both paths are registered in the
            // workspace, so a recursive `rm` clears them.
            outputBuffer = compressedBuffer;
          } else {
            console.warn(`⚠️  [GIF] Even compressed version exceeds ${config.video.maxSizeMB}MB (${compressedSizeMB}MB), skipping...`);
            return null;
          }
        } else {
          // Keep the first-pass output rather than failing outright.
          console.error(
            `❌ [GIF] Re-encoding failed (exit ${reencode.exitCode}, signal ${reencode.signalCode}):`,
            reencode.stderr.slice(0, 800),
          );
        }
      }

      // Final validation
      if (outputBuffer.length < 100) {
        console.error(`❌ [GIF] Output file is too small (${outputBuffer.length} bytes), likely corrupted`);
        return null;
      }

      console.log(`🎬 [GIF] Encoding as base64 for inline transmission...`);

      // Encode as base64 for inline transmission
      const base64Data = outputBuffer.toString('base64');

      const totalDuration = Date.now() - startTime;
      console.log(`✅ [GIF] Successfully converted GIF in ${totalDuration}ms (${base64Data.length} chars base64, ${(outputBuffer.length / 1024 / 1024).toFixed(2)}MB)`);

      return {
        uri: `data:${mimeType};base64,${base64Data}`,
        mimeType: mimeType,
        inlineData: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [GIF] Error converting GIF: ${errorMessage}`);

      // Log additional diagnostics
      if (errorMessage.includes('timeout')) {
        console.error(`⏱️  [GIF] This was a timeout error. The GIF may be too large or complex.`);
      }

      return null;
    } finally {
      await workspace?.cleanup();
    }
  }
}

/** Calculate max video size from config (converted to bytes) */
function getMaxVideoSize(): number {
  return config.video.maxSizeMB * 1024 * 1024;
}

export const videoService = new VideoService();
