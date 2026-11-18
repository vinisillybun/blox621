const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { pipeline } = require("stream/promises");

let ffmpegPath = "ffmpeg";
try {
  ffmpegPath = require("ffmpeg-static") || "ffmpeg";
} catch (err) {
  console.warn("ffmpeg-static is not installed, falling back to ffmpeg from PATH");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
sharp.cache(false);

const USER_AGENT = "Blox621/1.0 (Roblox experience; contact: your_email@example.com)";
const E621_BASE = "https://e621.net";
const MAX_EDITABLE_DIMENSION = 1024;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 320;

const SAMPLE_MAX_DIMENSION = 850;
const MIN_REQUEST_INTERVAL_MS = 1000;

const TILE_SIZE = 1024;
const MAX_FULL_DIMENSION = 4096;
const FULL_TTL_MS = 3 * 60 * 1000;
const FULL_MAX_ENTRIES = 3;

const GIF_MAX_FRAMES = 120;
const GIF_MAX_DIMENSION = 850;
const GIF_KEEP_BYTES = 128 * 1024 * 1024;
const GIF_WORK_BYTES = 192 * 1024 * 1024;
const GIF_CHUNK_BYTES = 4 * 1024 * 1024;
const GIF_PIXEL_LIMIT = 1000000000;
const GIF_TTL_MS = 3 * 60 * 1000;
const GIF_MAX_ENTRIES = 1;

const VIDEO_MAX_DIMENSION = 400;
const VIDEO_MAX_FPS = 12;
const VIDEO_MIN_FPS = 5;
const VIDEO_MAX_FRAMES = 360;
const VIDEO_KEEP_BYTES = 96 * 1024 * 1024;
const VIDEO_FIRST_CHUNK_BYTES = 2 * 1024 * 1024;
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
const VIDEO_WAIT_MS = 15000;
const VIDEO_TTL_MS = 3 * 60 * 1000;
const VIDEO_MAX_ENTRIES = 1;
const VIDEO_DOWNLOAD_LIMIT = 100 * 1024 * 1024;

const TAG_CATEGORIES = ["artist", "copyright", "character", "species", "general", "meta", "lore"];
const VALID_MODES = new Set(["sample", "original"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let queue = Promise.resolve();

function e621Get(path, params = {}) {
  const run = async () => {
    const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await axios.get(E621_BASE + path, {
      params,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (res.status === 429 || res.status === 503) {
      const err = new Error("Rate limited by e621");
      err.status = 429;
      throw err;
    }
    if (res.status === 403) {
      const err = new Error("Forbidden by e621 (check User-Agent)");
      err.status = 403;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`e621 returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.data;
  };

  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

const sessions = new Map();

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { posts: [], extra: new Map(), cursor: 0, tags: "", lastUsed: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastUsed = Date.now();
  return s;
}

const EXTRA_MAX = 60;
function findPost(session, postId) {
  const key = String(postId);
  return session.posts.find((p) => String(p.id) === key) || session.extra.get(key) || null;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}, 60 * 1000).unref?.();

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm)(\?|$)/i;

function isSupportedUrl(url) {
  return typeof url === "string" && IMAGE_EXT_RE.test(url);
}

function isVideoUrl(url) {
  return typeof url === "string" && VIDEO_EXT_RE.test(url);
}

function validSessionId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 100;
}

function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "webp";
  return null;
}

function computeTargetSize(originalWidth, originalHeight, mode) {
  let scale = 1;
  const longest = Math.max(originalWidth, originalHeight);

  if (mode === "sample" && longest > SAMPLE_MAX_DIMENSION) {
    scale = SAMPLE_MAX_DIMENSION / longest;
  }

  let targetWidth = Math.max(1, Math.round(originalWidth * scale));
  let targetHeight = Math.max(1, Math.round(originalHeight * scale));

  const largestTarget = Math.max(targetWidth, targetHeight);
  if (largestTarget > MAX_EDITABLE_DIMENSION) {
    const capScale = MAX_EDITABLE_DIMENSION / largestTarget;
    targetWidth = Math.max(1, Math.round(targetWidth * capScale));
    targetHeight = Math.max(1, Math.round(targetHeight * capScale));
  }

  return { targetWidth, targetHeight };
}

function buildMeta(p) {
  const tags = {};
  for (const c of TAG_CATEGORIES) {
    tags[c] = Array.isArray(p.tags && p.tags[c]) ? p.tags[c] : [];
  }
  const flags = p.flags || {};
  const created = p.created_at ? Date.parse(p.created_at) : NaN;
  const ext = String((p.file && p.file.ext) || "").toLowerCase();
  const isVideo = ext === "mp4" || ext === "webm";
  const duration = Number(p.duration);
  return {
    tags,
    rating: p.rating || "s",
    score: p.score && typeof p.score.total === "number" ? p.score.total : 0,
    favCount: p.fav_count || 0,
    ext,
    animated: ext === "gif",
    video: isVideo,
    hasSound: isVideo && tags.meta.includes("sound"),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : 0,
    fileSize: (p.file && p.file.size) || 0,
    createdAt: Number.isNaN(created) ? 0 : Math.floor(created / 1000),
    description: String(p.description || "").slice(0, 600),
    status: flags.deleted ? "Deleted" : flags.pending ? "Pending" : flags.flagged ? "Flagged" : "Active",
    commentCount: p.comment_count || 0,
  };
}

function pickVideoSource(p) {
  const ext = String((p.file && p.file.ext) || "").toLowerCase();
  if (ext !== "mp4" && ext !== "webm") return null;

  const alternates = (p.sample && p.sample.alternates) || {};
  for (const key of ["480p", "720p"]) {
    const alt = alternates[key];
    if (!alt) continue;
    const urls = [alt.url, ...(Array.isArray(alt.urls) ? alt.urls : [])].filter(isVideoUrl);
    const url = urls.find((u) => /\.webm(\?|$)/i.test(u)) || urls[0];
    if (url) {
      return {
        url,
        ext: url.match(VIDEO_EXT_RE)[1].toLowerCase(),
        width: alt.width,
        height: alt.height,
      };
    }
  }

  const fileUrl = p.file && p.file.url;
  if (isVideoUrl(fileUrl)) {
    return { url: fileUrl, ext, width: p.file.width, height: p.file.height };
  }
  return null;
}

function slimPost(p) {
  return {
    id: p.id,
    previewUrl: p.preview && p.preview.url ? p.preview.url : null,
    sampleUrl: p.sample && p.sample.url ? p.sample.url : null,
    fileUrl: p.file && p.file.url ? p.file.url : null,
    video: pickVideoSource(p),
    width: p.file ? p.file.width : null,
    height: p.file ? p.file.height : null,
    rating: p.rating,
    meta: buildMeta(p),
  };
}

async function buildPayload(post, mode) {
  const wantOriginal = mode === "original" && isSupportedUrl(post.fileUrl);
  const fileUrl = wantOriginal
    ? post.fileUrl
    : isSupportedUrl(post.sampleUrl)
    ? post.sampleUrl
    : post.fileUrl;
  const usedMode = wantOriginal ? "original" : "sample";

  if (!fileUrl) {
    return { success: false, message: "No file URL available", postId: post.id };
  }

  const imgRes = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT },
    timeout: 30000,
    maxContentLength: 32 * 1024 * 1024,
  });
  const imageBuffer = Buffer.from(imgRes.data);

  if (!sniffImageType(imageBuffer)) {
    return { success: false, message: "Downloaded payload is not a supported image", postId: post.id };
  }

  const metadata = await sharp(imageBuffer).metadata();
  const originalWidth = post.width || metadata.width;
  const originalHeight = post.height || metadata.height;
  if (!metadata.width || !metadata.height) {
    return { success: false, message: "Could not read image dimensions", postId: post.id };
  }

  const { targetWidth, targetHeight } = computeTargetSize(metadata.width, metadata.height, usedMode);

  const { data, info } = await sharp(imageBuffer, { animated: false })
    .ensureAlpha()
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    return { success: false, message: `Expected 4 channels, got ${info.channels}`, postId: post.id };
  }
  if (data.length !== info.width * info.height * 4) {
    return { success: false, message: "Buffer size mismatch", postId: post.id };
  }

  return {
    success: true,
    pixelData: data.toString("base64"),
    width: info.width,
    height: info.height,
    originalWidth,
    originalHeight,
    postId: post.id,
    mode: usedMode,
    meta: post.meta,
  };
}

const fullCache = new Map();

function trimFullCache() {
  const cutoff = Date.now() - FULL_TTL_MS;
  for (const [k, e] of fullCache) {
    if (e.at < cutoff) fullCache.delete(k);
  }
  while (fullCache.size > FULL_MAX_ENTRIES) {
    fullCache.delete(fullCache.keys().next().value);
  }
}

function getFullSource(sessionId, post) {
  const key = `${sessionId}:${post.id}`;
  trimFullCache();

  const hit = fullCache.get(key);
  if (hit) {
    hit.at = Date.now();
    return hit.promise;
  }

  const promise = (async () => {
    if (!isSupportedUrl(post.fileUrl)) throw new Error("No static original available");

    const imgRes = await axios.get(post.fileUrl, {
      responseType: "arraybuffer",
      headers: { "User-Agent": USER_AGENT },
      timeout: 45000,
      maxContentLength: 32 * 1024 * 1024,
    });
    const buf = Buffer.from(imgRes.data);
    if (!sniffImageType(buf)) throw new Error("Downloaded payload is not a supported image");

    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");

    const longest = Math.max(meta.width, meta.height);
    const scale = longest > MAX_FULL_DIMENSION ? MAX_FULL_DIMENSION / longest : 1;
    const fullWidth = Math.max(1, Math.round(meta.width * scale));
    const fullHeight = Math.max(1, Math.round(meta.height * scale));

    return {
      buf,
      srcWidth: meta.width,
      srcHeight: meta.height,
      fullWidth,
      fullHeight,
      cols: Math.ceil(fullWidth / TILE_SIZE),
      rows: Math.ceil(fullHeight / TILE_SIZE),
    };
  })();

  const entry = { at: Date.now(), promise };
  fullCache.set(key, entry);
  promise.catch(() => {
    if (fullCache.get(key) === entry) fullCache.delete(key);
  });
  return promise;
}

async function buildTile(sessionId, post, tx, ty) {
  const src = await getFullSource(sessionId, post);

  if (tx < 0 || ty < 0 || tx >= src.cols || ty >= src.rows) {
    return { success: false, message: "Tile out of range", postId: post.id, tx, ty };
  }

  const left = tx * TILE_SIZE;
  const top = ty * TILE_SIZE;
  const width = Math.min(TILE_SIZE, src.fullWidth - left);
  const height = Math.min(TILE_SIZE, src.fullHeight - top);

  let img = sharp(src.buf, { animated: false });
  if (src.fullWidth !== src.srcWidth || src.fullHeight !== src.srcHeight) {
    img = img.resize(src.fullWidth, src.fullHeight, { fit: "fill" });
  }

  const { data, info } = await img
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4 || data.length !== info.width * info.height * 4) {
    return { success: false, message: "Tile buffer mismatch", postId: post.id, tx, ty };
  }

  return {
    success: true,
    postId: post.id,
    tx,
    ty,
    cols: src.cols,
    rows: src.rows,
    x: left,
    y: top,
    width: info.width,
    height: info.height,
    fullWidth: src.fullWidth,
    fullHeight: src.fullHeight,
    originalWidth: src.srcWidth,
    originalHeight: src.srcHeight,
    pixelData: data.toString("base64"),
  };
}

const gifCache = new Map();

function trimGifCache() {
  const cutoff = Date.now() - GIF_TTL_MS;
  for (const [k, e] of gifCache) {
    if (e.at < cutoff) gifCache.delete(k);
  }
  while (gifCache.size > GIF_MAX_ENTRIES) {
    gifCache.delete(gifCache.keys().next().value);
  }
}

function getGifSource(sessionId, post) {
  const key = `${sessionId}:${post.id}`;
  trimGifCache();

  const hit = gifCache.get(key);
  if (hit) {
    hit.at = Date.now();
    return hit.promise;
  }

  const promise = (async () => {
    if (!isSupportedUrl(post.fileUrl)) throw new Error("No GIF available");

    const imgRes = await axios.get(post.fileUrl, {
      responseType: "arraybuffer",
      headers: { "User-Agent": USER_AGENT },
      timeout: 45000,
      maxContentLength: 32 * 1024 * 1024,
    });
    const buf = Buffer.from(imgRes.data);
    if (sniffImageType(buf) !== "gif") throw new Error("Downloaded payload is not a GIF");

    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");

    const pages = Math.max(meta.pages || 1, 1);
    const rawDelays = Array.isArray(meta.delay) ? meta.delay : [];
    const step = Math.max(1, Math.ceil(pages / GIF_MAX_FRAMES));

    const indices = [];
    const delays = [];
    for (let i = 0; i < pages; i += step) {
      let ms = 0;
      for (let j = i; j < Math.min(i + step, pages); j++) {
        const d = rawDelays[j];
        ms += d > 10 ? d : 100;
      }
      indices.push(i);
      delays.push(ms / 1000);
    }

    const pixels = meta.width * meta.height;
    const longest = Math.max(meta.width, meta.height);
    const scale = Math.min(
      1,
      GIF_MAX_DIMENSION / longest,
      Math.sqrt(GIF_KEEP_BYTES / (4 * indices.length * pixels)),
      Math.sqrt(GIF_WORK_BYTES / (4 * pages * pixels))
    );
    const width = Math.max(1, Math.round(meta.width * scale));
    const height = Math.max(1, Math.round(meta.height * scale));
    const frameBytes = width * height * 4;

    const { data, info } = await sharp(buf, { animated: true, pages: -1, limitInputPixels: GIF_PIXEL_LIMIT })
      .ensureAlpha()
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 4 || data.length !== frameBytes * pages) {
      throw new Error("Animated buffer size mismatch");
    }

    const frames = indices.map((i) => Buffer.from(data.subarray(i * frameBytes, (i + 1) * frameBytes)));

    return {
      frames,
      delays,
      width,
      height,
      srcWidth: meta.width,
      srcHeight: meta.height,
      duration: delays.reduce((a, b) => a + b, 0),
    };
  })();

  const entry = { at: Date.now(), promise };
  gifCache.set(key, entry);
  promise.catch(() => {
    if (gifCache.get(key) === entry) gifCache.delete(key);
  });
  return promise;
}

async function buildGifFrames(sessionId, post, start) {
  const src = await getGifSource(sessionId, post);
  const total = src.frames.length;

  if (start < 0 || start >= total) {
    return { success: false, message: "Frame out of range", postId: post.id, start };
  }

  const perChunk = Math.max(1, Math.floor(GIF_CHUNK_BYTES / (src.width * src.height * 4)));
  const end = Math.min(total, start + perChunk);

  return {
    success: true,
    postId: post.id,
    start,
    count: end - start,
    nextIndex: end,
    total,
    width: src.width,
    height: src.height,
    delays: src.delays,
    duration: src.duration,
    originalWidth: src.srcWidth,
    originalHeight: src.srcHeight,
    frames: src.frames.slice(start, end).map((f) => f.toString("base64")),
  };
}

const videoCache = new Map();

function stopVideoEntry(entry) {
  if (entry.proc && !entry.done) {
    try {
      entry.proc.kill("SIGKILL");
    } catch (err) {
      console.warn("could not stop ffmpeg:", err.message);
    }
  }
}

function trimVideoCache() {
  const cutoff = Date.now() - VIDEO_TTL_MS;
  for (const [k, e] of videoCache) {
    if (e.at < cutoff) {
      stopVideoEntry(e);
      videoCache.delete(k);
    }
  }
  while (videoCache.size > VIDEO_MAX_ENTRIES) {
    const oldestKey = videoCache.keys().next().value;
    stopVideoEntry(videoCache.get(oldestKey));
    videoCache.delete(oldestKey);
  }
}

function finishVideo(entry, err) {
  if (entry.done) return;
  if (err) entry.error = err;
  entry.done = true;
  if (entry.tmpFile) fs.unlink(entry.tmpFile, () => {});
  entry.events.emit("progress");
}

function spawnFfmpeg(entry, input, maxFrames) {
  const viaPipe = input === "pipe:0";
  const args = [
    "-v", "error",
    "-i", input,
    "-an",
    "-sn",
    "-vf", `fps=${entry.fps.toFixed(3)},scale=${entry.width}:${entry.height}:flags=fast_bilinear`,
    "-frames:v", String(maxFrames),
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "pipe:1",
  ];
  const proc = spawn(ffmpegPath, args, { stdio: [viaPipe ? "pipe" : "ignore", "pipe", "pipe"] });
  entry.proc = proc;

  let carry = Buffer.alloc(0);
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    while (carry.length >= entry.frameBytes && entry.frames.length < maxFrames) {
      entry.frames.push(Buffer.from(carry.subarray(0, entry.frameBytes)));
      carry = carry.subarray(entry.frameBytes);
    }
    entry.events.emit("progress");
  });
  proc.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  proc.on("error", (err) => finishVideo(entry, err));
  proc.on("close", (code) => {
    if (entry.frames.length === 0) {
      finishVideo(entry, new Error(stderr.trim().slice(-300) || `ffmpeg exited with code ${code}`));
    } else {
      finishVideo(entry);
    }
  });
  if (viaPipe) proc.stdin.on("error", () => {});

  return proc;
}

function runVideo(entry, source, maxFrames) {
  const viaPipe = source.ext === "webm";

  (async () => {
    const res = await axios.get(source.url, {
      responseType: "stream",
      headers: { "User-Agent": USER_AGENT },
      timeout: 30000,
    });

    if (entry.done) {
      res.data.destroy();
      return;
    }

    let received = 0;
    res.data.on("data", (chunk) => {
      received += chunk.length;
      if (received > VIDEO_DOWNLOAD_LIMIT) res.data.destroy(new Error("Video is too large"));
    });

    if (viaPipe) {
      const proc = spawnFfmpeg(entry, "pipe:0", maxFrames);
      await pipeline(res.data, proc.stdin);
    } else {
      entry.tmpFile = path.join(
        os.tmpdir(),
        `blox621-${Date.now()}-${Math.random().toString(36).slice(2)}.${source.ext}`
      );
      await pipeline(res.data, fs.createWriteStream(entry.tmpFile));
      if (entry.done) return;
      spawnFfmpeg(entry, entry.tmpFile, maxFrames);
    }
  })().catch((err) => {
    if (entry.frames.length === 0) {
      stopVideoEntry(entry);
      finishVideo(entry, err);
    }
  });
}

function startVideo(post) {
  const source = post.video;
  if (!source || !source.url) throw new Error("No video available");

  const srcWidth = Number(source.width) || Number(post.width) || 0;
  const srcHeight = Number(source.height) || Number(post.height) || 0;
  if (!srcWidth || !srcHeight) throw new Error("Could not read video dimensions");

  const scale = Math.min(1, VIDEO_MAX_DIMENSION / Math.max(srcWidth, srcHeight));
  const width = Math.max(2, Math.round(srcWidth * scale));
  const height = Math.max(2, Math.round(srcHeight * scale));
  const frameBytes = width * height * 4;
  const maxFrames = Math.max(1, Math.min(VIDEO_MAX_FRAMES, Math.floor(VIDEO_KEEP_BYTES / frameBytes)));

  const duration = (post.meta && post.meta.duration) || 0;
  const fps = duration > 0
    ? Math.min(VIDEO_MAX_FPS, Math.max(VIDEO_MIN_FPS, maxFrames / duration))
    : VIDEO_MAX_FPS;

  const entry = {
    at: Date.now(),
    frames: [],
    done: false,
    error: null,
    proc: null,
    tmpFile: null,
    events: new EventEmitter(),
    width,
    height,
    frameBytes,
    fps,
    delay: 1 / fps,
    duration,
    expected: duration > 0 ? Math.min(maxFrames, Math.ceil(duration * fps)) : 0,
    srcWidth: Number(post.width) || srcWidth,
    srcHeight: Number(post.height) || srcHeight,
  };
  entry.events.setMaxListeners(50);

  runVideo(entry, source, maxFrames);
  return entry;
}

function getVideoSource(sessionId, post) {
  const key = `${sessionId}:${post.id}`;
  trimVideoCache();

  const hit = videoCache.get(key);
  if (hit) {
    hit.at = Date.now();
    return hit;
  }

  const entry = startVideo(post);
  videoCache.set(key, entry);
  return entry;
}

function waitForFrames(src, need) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      src.events.off("progress", check);
      resolve();
    };
    const check = () => {
      if (src.frames.length >= need || src.done) finish();
    };
    const timer = setTimeout(finish, VIDEO_WAIT_MS);
    src.events.on("progress", check);
    check();
  });
}

async function buildVideoFrames(sessionId, post, start) {
  const src = getVideoSource(sessionId, post);
  const budget = start === 0 ? VIDEO_FIRST_CHUNK_BYTES : VIDEO_CHUNK_BYTES;
  const perChunk = Math.max(1, Math.floor(budget / src.frameBytes));

  await waitForFrames(src, start + perChunk);

  if (src.error && src.frames.length <= start) throw src.error;

  const end = Math.max(start, Math.min(src.frames.length, start + perChunk));
  const finished = src.done && end >= src.frames.length;

  return {
    success: true,
    postId: post.id,
    start,
    count: end - start,
    nextIndex: end,
    done: finished,
    total: finished ? src.frames.length : src.expected,
    width: src.width,
    height: src.height,
    fps: src.fps,
    delay: src.delay,
    duration: src.duration,
    originalWidth: src.srcWidth,
    originalHeight: src.srcHeight,
    frames: src.frames.slice(start, end).map((f) => f.toString("base64")),
  };
}

const THUMB_MAX_DIMENSION = 150;
const THUMB_CHUNK_MAX = 24;
const THUMB_CONCURRENCY = 6;

let thumbActive = 0;
const thumbWaiters = [];
async function withThumbSlot(fn) {
  if (thumbActive >= THUMB_CONCURRENCY) {
    await new Promise((resolve) => thumbWaiters.push(resolve));
  }
  thumbActive++;
  try {
    return await fn();
  } finally {
    thumbActive--;
    const next = thumbWaiters.shift();
    if (next) next();
  }
}

async function buildGridThumb(post, index) {
  const url = isSupportedUrl(post.previewUrl)
    ? post.previewUrl
    : isSupportedUrl(post.sampleUrl)
    ? post.sampleUrl
    : post.fileUrl;
  if (!isSupportedUrl(url)) return null;

  const imgRes = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT },
    timeout: 15000,
    maxContentLength: 8 * 1024 * 1024,
  });
  const buf = Buffer.from(imgRes.data);
  if (!sniffImageType(buf)) return null;

  const { data, info } = await sharp(buf, { animated: false })
    .ensureAlpha()
    .resize(THUMB_MAX_DIMENSION, THUMB_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) return null;

  return {
    success: true,
    mode: "thumb",
    index: index + 1,
    postId: post.id,
    width: info.width,
    height: info.height,
    originalWidth: post.width || info.width,
    originalHeight: post.height || info.height,
    pixelData: data.toString("base64"),
    meta: post.meta,
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Blox621",
    sessions: sessions.size,
    fullCache: fullCache.size,
    gifCache: gifCache.size,
    videoCache: videoCache.size,
  });
});

app.post("/fetch-posts", async (req, res) => {
  const { tags = "", page = 1, limit = DEFAULT_LIMIT, sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.status(400).json({ success: false, error: "sessionId required", count: 0 });
  }

  const tagString = Array.isArray(tags) ? tags.join(" ") : String(tags || "");
  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cleanPage = Math.max(parseInt(page, 10) || 1, 1);
  const finalTags = tagString.trim().length > 0 ? tagString : "rating:safe";

  try {
    const data = await e621Get("/posts.json", {
      tags: finalTags,
      limit: cleanLimit,
      page: cleanPage,
    });

    const posts = Array.isArray(data.posts) ? data.posts : [];

    const slim = posts
      .map(slimPost)
      .filter((p) => isSupportedUrl(p.sampleUrl) || isSupportedUrl(p.fileUrl) || p.video);

    const session = getSession(sessionId);
    session.posts = slim;
    session.cursor = 0;
    session.tags = finalTags;

    res.json({
      success: true,
      count: slim.length,
      posts: slim.map((p) => ({ id: p.id, rating: p.rating })),
    });
  } catch (err) {
    console.error("fetch-posts failed:", err.message);
    res.status(err.status === 429 ? 429 : 500).json({ success: false, error: err.message, count: 0 });
  }
});

const COUNT_TTL_MS = 5 * 60 * 1000;
const COUNT_CACHE_MAX = 100;
const countCache = new Map();

app.post("/post-count", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const tags = getSession(sessionId).tags || "rating:safe";

  const hit = countCache.get(tags);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) {
    return res.json({ success: true, total: hit.total });
  }

  try {
    const data = await e621Get("/posts/count.json", { tags });
    const raw = data && data.count !== undefined ? data.count : data && data.counts && data.counts.posts;
    const total = Number(raw);
    if (!Number.isFinite(total) || total < 0) {
      return res.json({ success: false, message: "Unexpected count response" });
    }
    if (countCache.size >= COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
    countCache.set(tags, { at: Date.now(), total });
    res.json({ success: true, total });
  } catch (err) {
    console.error("post-count failed:", err.message);
    res.json({ success: false, message: "Failed to count posts" });
  }
});

app.post("/get-thumbs", async (req, res) => {
  const { sessionId, start = 0, count = 12 } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const session = getSession(sessionId);
  if (session.posts.length === 0) {
    return res.json({ success: false, message: "No posts cached. Call /fetch-posts first." });
  }

  const from = Math.max(parseInt(start, 10) || 0, 0);
  const n = Math.min(Math.max(parseInt(count, 10) || 12, 1), THUMB_CHUNK_MAX);
  const slice = session.posts.slice(from, from + n);
  if (slice.length === 0) {
    return res.json({ success: true, images: [] });
  }

  const results = await Promise.all(
    slice.map((post, i) =>
      withThumbSlot(() => buildGridThumb(post, from + i)).catch((err) => {
        console.error("thumb failed:", err.message, "post:", post.id);
        return null;
      })
    )
  );

  res.json({ success: true, images: results.filter(Boolean) });
});

app.post("/get-next-image", async (req, res) => {
  const { mode = "sample", sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const cleanMode = VALID_MODES.has(mode) ? mode : "sample";

  const session = getSession(sessionId);
  if (session.posts.length === 0) {
    return res.json({ success: false, message: "No posts cached. Call /fetch-posts first." });
  }
  if (session.cursor >= session.posts.length) {
    return res.json({ success: false, message: "No more images in this batch." });
  }

  const post = session.posts[session.cursor];
  session.cursor += 1;

  try {
    res.json(await buildPayload(post, cleanMode));
  } catch (err) {
    console.error("get-next-image failed:", err.message, "post:", post.id);
    res.json({ success: false, message: "Failed to process image", postId: post.id });
  }
});

app.post("/get-image", async (req, res) => {
  const { postId, mode = "sample", sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const cleanMode = VALID_MODES.has(mode) ? mode : "sample";

  const session = getSession(sessionId);
  const post = findPost(session, postId);
  if (!post) {
    return res.json({ success: false, message: "Post not found in cache", postId });
  }

  try {
    res.json(await buildPayload(post, cleanMode));
  } catch (err) {
    console.error("get-image failed:", err.message, "post:", post.id);
    res.json({ success: false, message: "Failed to process image", postId: post.id });
  }
});

app.post("/get-tile", async (req, res) => {
  const { postId, tx, ty, sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const col = Number.isInteger(tx) ? tx : parseInt(tx, 10);
  const row = Number.isInteger(ty) ? ty : parseInt(ty, 10);
  if (!Number.isInteger(col) || !Number.isInteger(row)) {
    return res.json({ success: false, message: "tx and ty required", postId });
  }

  const session = getSession(sessionId);
  const post = findPost(session, postId);
  if (!post) {
    return res.json({ success: false, message: "Post not found in cache", postId });
  }

  try {
    res.json(await buildTile(sessionId, post, col, row));
  } catch (err) {
    console.error("get-tile failed:", err.message, "post:", post.id, "tile:", col, row);
    res.json({ success: false, message: "Failed to process tile", postId: post.id, tx: col, ty: row });
  }
});

app.post("/get-gif-frames", async (req, res) => {
  const { postId, start, sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const from = Number.isInteger(start) ? start : parseInt(start, 10);
  if (!Number.isInteger(from) || from < 0) {
    return res.json({ success: false, message: "start required", postId });
  }

  const session = getSession(sessionId);
  const post = findPost(session, postId);
  if (!post) {
    return res.json({ success: false, message: "Post not found in cache", postId });
  }

  try {
    res.json(await buildGifFrames(sessionId, post, from));
  } catch (err) {
    console.error("get-gif-frames failed:", err.message, "post:", post.id, "start:", from);
    res.json({ success: false, message: "Failed to process GIF", postId: post.id, start: from });
  }
});

app.post("/get-video-frames", async (req, res) => {
  const { postId, start, sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const from = Number.isInteger(start) ? start : parseInt(start, 10);
  if (!Number.isInteger(from) || from < 0) {
    return res.json({ success: false, message: "start required", postId });
  }

  const session = getSession(sessionId);
  const post = findPost(session, postId);
  if (!post) {
    return res.json({ success: false, message: "Post not found in cache", postId });
  }

  try {
    res.json(await buildVideoFrames(sessionId, post, from));
  } catch (err) {
    console.error("get-video-frames failed:", err.message, "post:", post.id, "start:", from);
    res.json({ success: false, message: "Failed to process video", postId: post.id, start: from });
  }
});

const ARTIST_DEFAULT_LIMIT = 6;
const ARTIST_MAX_LIMIT = 12;
const ARTIST_TTL_MS = 3 * 60 * 1000;
const ARTIST_CACHE_MAX = 20;

const NON_ARTIST_TAGS = new Set([
  "conditional_dnp",
  "unknown_artist",
  "anonymous_artist",
  "unknown_artist_signature",
  "avoid_posting",
  "sound_warning",
  "epilepsy_warning",
  "third-party_edit",
  "editor_notes",
]);

const artistCache = new Map();

async function buildThumb(p) {
  const url = p.preview && p.preview.url;
  if (!isSupportedUrl(url)) return null;

  const imgRes = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": USER_AGENT },
    timeout: 15000,
    maxContentLength: 4 * 1024 * 1024,
  });
  const buf = Buffer.from(imgRes.data);
  if (!sniffImageType(buf)) return null;

  const { data, info } = await sharp(buf, { animated: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== info.width * info.height * 4) return null;

  return {
    id: p.id,
    rating: p.rating || "s",
    score: p.score && typeof p.score.total === "number" ? p.score.total : 0,
    favCount: p.fav_count || 0,
    commentCount: p.comment_count || 0,
    width: info.width,
    height: info.height,
    pixelData: data.toString("base64"),
  };
}

async function similarArtistPosts(postId, limit, ratingTokens, artist) {
  try {
    const sim = await e621Get(`/posts/${postId}/similar/artist.json`, { limit });
    const ids = (Array.isArray(sim && sim.results) ? sim.results : [])
      .map((r) => r.post_id)
      .filter(Number.isInteger);

    if (ids.length) {
      const data = await e621Get("/posts.json", {
        tags: ["id:" + ids.join(","), ...ratingTokens].join(" "),
        limit: ids.length,
      });
      const byId = new Map((Array.isArray(data.posts) ? data.posts : []).map((p) => [p.id, p]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((p) => p && !(p.flags && p.flags.deleted));
      if (ordered.length) return ordered;
    }
  } catch (err) {
    console.warn("similar/artist failed, falling back to tag search:", err.message);
  }

  const data = await e621Get("/posts.json", {
    tags: [artist, ...ratingTokens].join(" "),
    limit: limit + 1,
  });
  return Array.isArray(data.posts) ? data.posts : [];
}

app.post("/artist-posts", async (req, res) => {
  const { postId, sessionId, limit = ARTIST_DEFAULT_LIMIT } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const session = getSession(sessionId);
  const post = findPost(session, postId);
  if (!post) {
    return res.json({ success: false, message: "Post not found in cache", postId });
  }

  const artists = ((post.meta && post.meta.tags && post.meta.tags.artist) || []).filter(
    (t) => !NON_ARTIST_TAGS.has(t)
  );
  if (artists.length === 0) {
    return res.json({ success: true, artist: null, posts: [] });
  }
  const artist = artists[0];

  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || ARTIST_DEFAULT_LIMIT, 1), ARTIST_MAX_LIMIT);
  const ratingTokens = String(session.tags || "")
    .split(/\s+/)
    .filter((t) => /^[-~]?rating:/i.test(t));
  const query = [artist, ...ratingTokens].join(" ");

  try {
    const cacheKey = `${post.id}|${query}|${cleanLimit}`;
    let list;
    const hit = artistCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ARTIST_TTL_MS) {
      list = hit.posts;
    } else {
      const raw = await similarArtistPosts(post.id, cleanLimit + 1, ratingTokens, artist);
      const built = await Promise.all(
        raw.map(async (p) => {
          const slim = slimPost(p);
          if (!isSupportedUrl(slim.sampleUrl) && !isSupportedUrl(slim.fileUrl) && !slim.video) return null;
          const thumb = await buildThumb(p).catch(() => null);
          return thumb ? { thumb, slim } : null;
        })
      );
      list = built.filter(Boolean);

      if (artistCache.size >= ARTIST_CACHE_MAX) artistCache.delete(artistCache.keys().next().value);
      artistCache.set(cacheKey, { at: Date.now(), posts: list });
    }

    const entries = list.filter((e) => String(e.slim.id) !== String(post.id)).slice(0, cleanLimit);

    for (const e of entries) {
      const key = String(e.slim.id);
      session.extra.delete(key);
      session.extra.set(key, e.slim);
    }
    while (session.extra.size > EXTRA_MAX) session.extra.delete(session.extra.keys().next().value);

    res.json({ success: true, artist, posts: entries.map((e) => e.thumb) });
  } catch (err) {
    console.error("artist-posts failed:", err.message, "post:", post.id);
    res.json({ success: false, message: "Failed to load artist posts", postId: post.id });
  }
});

const AC_TTL_MS = 60 * 1000;
const AC_MAX_ENTRIES = 300;
const acCache = new Map();

app.post("/autocomplete-tags", async (req, res) => {
  const { query = "" } = req.body || {};
  const cleanQuery = String(query)
    .trim()
    .toLowerCase()
    .replace(/[^\w\-()]/g, "")
    .slice(0, 40);

  if (cleanQuery.length < 2) {
    return res.json({ success: true, suggestions: [] });
  }

  const hit = acCache.get(cleanQuery);
  if (hit && Date.now() - hit.at < AC_TTL_MS) {
    return res.json({ success: true, suggestions: hit.suggestions });
  }

  try {
    const data = await e621Get("/tags.json", {
      "search[name_matches]": `${cleanQuery}*`,
      "search[order]": "count",
      "search[hide_empty]": "true",
      limit: 10,
    });
    const tags = Array.isArray(data) ? data : Array.isArray(data.tags) ? data.tags : [];
    const suggestions = tags.slice(0, 10).map((t) => ({
      name: t.name,
      postCount: t.post_count || 0,
      category: t.category || 0,
    }));

    if (acCache.size >= AC_MAX_ENTRIES) acCache.delete(acCache.keys().next().value);
    acCache.set(cleanQuery, { at: Date.now(), suggestions });

    res.json({ success: true, suggestions });
  } catch (err) {
    console.error("autocomplete-tags failed:", err.message);
    res.json({ success: true, suggestions: [] });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
