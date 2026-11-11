const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.json());

// --- e621 config -----------------------------------------------------------
const USER_AGENT = "Blox621/1.0 (Roblox experience; contact: your_email@example.com)";
const E621_BASE = "https://e621.net";
const MAX_EDITABLE_DIMENSION = 1024; // Roblox EditableImage limit
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 320;

const SAMPLE_MAX_DIMENSION = 850; // "longest side capped at 850"
const MIN_REQUEST_INTERVAL_MS = 1000;
let lastRequestAt = 0;

async function e621Get(path, params = {}) {
  const now = Date.now();
  const wait = MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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
}

// --- per-session in-memory state -------------------------------------------
// Previously this was global, which meant two simultaneous players would
// clobber each other's cachedPosts and cursor, causing the first player's
// batch loop to drain the wrong (or empty) list.
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, {posts: any[], cursor: number, imageCache: Record<string, any>, lastUsed: number}>} */
const sessions = new Map();

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { posts: [], cursor: 0, imageCache: {}, lastUsed: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastUsed = Date.now();
  return s;
}

// Periodic sweep so old sessions don't leak memory.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}, 60 * 1000).unref?.();

// --- helpers ---------------------------------------------------------------

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

function isSupportedUrl(url) {
  return typeof url === "string" && IMAGE_EXT_RE.test(url);
}

function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

/**
 * Compute the target (width, height) for the given mode, honoring:
 *  - "sample" mode: longest side capped at SAMPLE_MAX_DIMENSION
 *  - always:        longest side capped at MAX_EDITABLE_DIMENSION
 * Uses the longest side (not just width) so portrait images behave correctly.
 */
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

// --- routes ----------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Blox621", sessions: sessions.size });
});

app.post("/fetch-posts", async (req, res) => {
  const { tags = "", page = 1, limit = DEFAULT_LIMIT, sessionId } = req.body || {};

  if (typeof sessionId !== "string" || sessionId.length === 0) {
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

    // Only keep posts with a static-image URL we can actually process.
    const slim = posts
      .map((p) => {
        const sampleUrl = p.sample && p.sample.url ? p.sample.url : null;
        const fileUrl = p.file && p.file.url ? p.file.url : null;
        return {
          id: p.id,
          sampleUrl,
          fileUrl,
          width: p.file ? p.file.width : null,
          height: p.file ? p.file.height : null,
          sampleWidth: p.sample ? p.sample.width : null,
          sampleHeight: p.sample ? p.sample.height : null,
          rating: p.rating,
        };
      })
      .filter((p) => isSupportedUrl(p.sampleUrl) || isSupportedUrl(p.fileUrl));

    const session = getSession(sessionId);
    session.posts = slim;
    session.cursor = 0;
    session.imageCache = {};

    res.json({ success: true, count: slim.length, posts: slim });
  } catch (err) {
    console.error("fetch-posts failed:", err.message);
    const status = err.status === 429 ? 429 : 500;
    res.status(status).json({ success: false, error: err.message, count: 0 });
  }
});

app.post("/get-next-image", async (req, res) => {
  const { mode = "sample", sessionId } = req.body || {};

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return res.json({ success: false, message: "sessionId required" });
  }

  const session = getSession(sessionId);

  if (session.posts.length === 0) {
    return res.json({ success: false, message: "No posts cached. Call /fetch-posts first." });
  }
  if (session.cursor >= session.posts.length) {
    return res.json({ success: false, message: "No more images in this batch." });
  }

  const post = session.posts[session.cursor];
  session.cursor += 1;

  const cacheKey = `${post.id}:${mode}`;
  if (session.imageCache[cacheKey]) {
    return res.json({ success: true, ...session.imageCache[cacheKey] });
  }

  const fileUrl = mode === "original" ? post.fileUrl : post.sampleUrl || post.fileUrl;
  if (!fileUrl) {
    return res.json({ success: false, message: "No file URL available" });
  }

  try {
    const imgRes = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      headers: { "User-Agent": USER_AGENT },
      timeout: 20000,
      maxContentLength: 32 * 1024 * 1024,
    });
    const imageBuffer = Buffer.from(imgRes.data);

    // Guard: e621 sometimes returns HTML error pages or non-static formats
    // (e.g. .webm) even when the URL looked like an image.
    const sniffed = sniffImageType(imageBuffer);
    if (!sniffed) {
      return res.json({
        success: false,
        message: "Downloaded payload is not a supported image",
        postId: post.id,
      });
    }

    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;
    if (!originalWidth || !originalHeight) {
      return res.json({ success: false, message: "Could not read image dimensions" });
    }

    const { targetWidth, targetHeight } = computeTargetSize(
      originalWidth,
      originalHeight,
      mode
    );

    // sharp: for animated GIFs/WebPs, take the first frame only.
    const processed = await sharp(imageBuffer, { animated: false })
      .ensureAlpha()
      .resize(targetWidth, targetHeight, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = processed;
    if (info.channels !== 4) {
      return res.json({
        success: false,
        message: `Expected 4 channels, got ${info.channels}`,
      });
    }

    const expectedBytes = info.width * info.height * 4;
    if (data.length !== expectedBytes) {
      return res.json({
        success: false,
        message: `Buffer size mismatch: ${data.length} vs ${expectedBytes}`,
      });
    }

    const payload = {
      success: true,
      pixelData: data.toString("base64"),
      width: info.width,
      height: info.height,
      originalWidth,
      originalHeight,
      postId: post.id,
      mode,
    };

    session.imageCache[cacheKey] = payload;
    res.json(payload);
  } catch (err) {
    console.error("get-next-image failed:", err.message, "url:", fileUrl);
    res.json({ success: false, message: "Failed to process image" });
  }
});

/** Kept for compatibility with anything that names a post explicitly. */
app.post("/get-image", async (req, res) => {
  const { postId, mode = "sample", sessionId } = req.body || {};

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return res.json({ success: false, message: "sessionId required" });
  }

  const session = getSession(sessionId);
  const index = session.posts.findIndex((p) => String(p.id) === String(postId));
  if (index === -1) {
    return res.json({ success: false, message: "Post not found in cache" });
  }
  session.cursor = index;
  return app._router.handle(
    Object.assign(req, {
      url: "/get-next-image",
      body: { mode, sessionId },
      method: "POST",
    }),
    res,
    () => res.json({ success: false, message: "Internal redirect failed" })
  );
});

app.post("/autocomplete-tags", async (req, res) => {
  const { query = "" } = req.body || {};
  if (!query || query.trim().length === 0) {
    return res.json({ success: true, suggestions: [] });
  }
  try {
    const cleanQuery = query.trim().replace(/[^\w\s\-_]/g, "");
    const data = await e621Get("/tags.json", {
      "search[name_matches]": `${cleanQuery}*`,
      limit: 10,
    });
    const tags = Array.isArray(data) ? data : Array.isArray(data.tags) ? data.tags : [];
    const suggestions = tags.slice(0, 10).map((t) => ({
      name: t.name,
      postCount: t.post_count || 0,
      category: t.category || 0,
    }));
    res.json({ success: true, suggestions });
  } catch (err) {
    console.error("autocomplete-tags failed:", err.message);
    res.json({ success: true, suggestions: [] });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
