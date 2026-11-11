const express = require("express");
const axios = require("axios");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
sharp.cache(false); // don't keep decoded originals in sharp's internal cache

// --- e621 config -----------------------------------------------------------
const USER_AGENT = "Blox621/1.0 (Roblox experience; contact: your_email@example.com)";
const E621_BASE = "https://e621.net";
const MAX_EDITABLE_DIMENSION = 1024; // Roblox EditableImage limit for ONE image (caps "original")
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 320;

const SAMPLE_MAX_DIMENSION = 850; // "longest side capped at 850"
const MIN_REQUEST_INTERVAL_MS = 1000;

// --- tiled full-resolution config ------------------------------------------
const TILE_SIZE = 1024; // one tile = one EditableImage on the client
const MAX_FULL_DIMENSION = 4096; // longest side of the stitched image (4096 -> up to 16 tiles, ~64 MB of textures)
const FULL_TTL_MS = 3 * 60 * 1000; // how long a downloaded original is kept for tile requests
const FULL_MAX_ENTRIES = 3; // encoded originals kept in memory (each up to 32 MB)

const TAG_CATEGORIES = ["artist", "copyright", "character", "species", "general", "meta", "lore"];
const VALID_MODES = new Set(["sample", "original"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- e621 request queue ----------------------------------------------------
// Every e621 API call goes through one promise chain so concurrent requests are
// spaced MIN_REQUEST_INTERVAL_MS apart (the old version let two callers both
// see "no wait needed" and fire together).
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

// --- per-session in-memory state -------------------------------------------
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, {posts: any[], cursor: number, tags: string, lastUsed: number}>} */
const sessions = new Map();

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { posts: [], cursor: 0, tags: "", lastUsed: Date.now() };
    sessions.set(sessionId, s);
  }
  s.lastUsed = Date.now();
  return s;
}

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

/**
 * Target (width, height) for a mode:
 *  - "sample":   longest side capped at SAMPLE_MAX_DIMENSION
 *  - "original": full size, but always capped at MAX_EDITABLE_DIMENSION
 * Uses the longest side so portrait images behave correctly.
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

/** Small, JSON-safe slice of an e621 post that the Roblox UI shows in its sidebar. */
function buildMeta(p) {
  const tags = {};
  for (const c of TAG_CATEGORIES) {
    tags[c] = Array.isArray(p.tags && p.tags[c]) ? p.tags[c] : [];
  }
  const flags = p.flags || {};
  const created = p.created_at ? Date.parse(p.created_at) : NaN;
  return {
    tags,
    rating: p.rating || "s",
    score: p.score && typeof p.score.total === "number" ? p.score.total : 0,
    favCount: p.fav_count || 0,
    ext: (p.file && p.file.ext) || "",
    fileSize: (p.file && p.file.size) || 0,
    createdAt: Number.isNaN(created) ? 0 : Math.floor(created / 1000), // unix seconds
    description: String(p.description || "").slice(0, 600),
    status: flags.deleted ? "Deleted" : flags.pending ? "Pending" : flags.flagged ? "Flagged" : "Active",
    commentCount: p.comment_count || 0,
  };
}

/**
 * Download one post's image and return the Roblox payload (raw RGBA as base64).
 * mode "original" falls back to the sample if the original isn't a static image.
 * Nothing is cached here: RGBA payloads are several MB each.
 */
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

  // e621 sometimes returns HTML error pages or non-static formats.
  if (!sniffImageType(imageBuffer)) {
    return { success: false, message: "Downloaded payload is not a supported image", postId: post.id };
  }

  const metadata = await sharp(imageBuffer).metadata();
  const originalWidth = post.width || metadata.width;
  const originalHeight = post.height || metadata.height;
  if (!metadata.width || !metadata.height) {
    return { success: false, message: "Could not read image dimensions", postId: post.id };
  }

  // Resize from the dimensions of the file we actually downloaded.
  const { targetWidth, targetHeight } = computeTargetSize(metadata.width, metadata.height, usedMode);

  // For animated GIFs/WebPs, take the first frame only.
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
    originalWidth, // true size of the e621 original, even if the texture is capped
    originalHeight,
    postId: post.id,
    mode: usedMode,
    meta: post.meta,
  };
}

// --- tiled full-resolution images ------------------------------------------
// A Roblox EditableImage is limited to 1024x1024, so a bigger picture is sent as
// a grid of TILE_SIZE tiles that the client stitches together. The downloaded
// original is kept briefly (encoded, a few MB) so the tile requests for one post
// don't each re-download it.

/** @type {Map<string, {at: number, promise: Promise<any>}>} */
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

  // resize() before extract() makes sharp crop AFTER resizing, so the tile
  // comes out of the already-scaled (<= MAX_FULL_DIMENSION) image.
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
    x: left, // tile position inside the stitched image, in pixels
    y: top,
    width: info.width,
    height: info.height,
    fullWidth: src.fullWidth, // size of the stitched image
    fullHeight: src.fullHeight,
    originalWidth: src.srcWidth,
    originalHeight: src.srcHeight,
    pixelData: data.toString("base64"),
  };
}

// --- routes ----------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Blox621", sessions: sessions.size, fullCache: fullCache.size });
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
      .map((p) => ({
        id: p.id,
        sampleUrl: p.sample && p.sample.url ? p.sample.url : null,
        fileUrl: p.file && p.file.url ? p.file.url : null,
        width: p.file ? p.file.width : null,
        height: p.file ? p.file.height : null,
        rating: p.rating,
        meta: buildMeta(p),
      }))
      .filter((p) => isSupportedUrl(p.sampleUrl) || isSupportedUrl(p.fileUrl));

    const session = getSession(sessionId);
    session.posts = slim;
    session.cursor = 0;
    session.tags = finalTags; // used by /artist-posts to keep the player's rating: filters

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

/** Fetch one specific post from the session cache (used for "Original" in the post view). */
app.post("/get-image", async (req, res) => {
  const { postId, mode = "sample", sessionId } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const cleanMode = VALID_MODES.has(mode) ? mode : "sample";

  const session = getSession(sessionId);
  const post = session.posts.find((p) => String(p.id) === String(postId));
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

/**
 * One 1024px tile of a post's full-resolution original.
 * Body: { sessionId, postId, tx, ty }  (tx = column, ty = row, both 0-based)
 * The first response (any tile) tells the client the grid size (cols/rows) and
 * the stitched size (fullWidth/fullHeight); each tile says where it goes (x/y).
 */
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
  const post = session.posts.find((p) => String(p.id) === String(postId));
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

// --- "From the Artist" thumbnails -------------------------------------------
const ARTIST_DEFAULT_LIMIT = 6;
const ARTIST_MAX_LIMIT = 12;
const ARTIST_TTL_MS = 3 * 60 * 1000;
const ARTIST_CACHE_MAX = 20;

// artist-category tags on e621 that are not real artists
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

const artistCache = new Map(); // key -> { at, posts }

/** Download one e621 preview (<=150px) and turn it into the same RGBA payload the Roblox client decodes. */
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

/**
 * Other posts by the open post's artist.
 * Body: { sessionId, postId, limit? }
 * Keeps any rating: filters from the player's own search so the panel never
 * shows a rating they filtered out.
 */
app.post("/artist-posts", async (req, res) => {
  const { postId, sessionId, limit = ARTIST_DEFAULT_LIMIT } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.json({ success: false, message: "sessionId required" });
  }
  const session = getSession(sessionId);
  const post = session.posts.find((p) => String(p.id) === String(postId));
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
    const cacheKey = `${query}|${cleanLimit}`;
    let list;
    const hit = artistCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ARTIST_TTL_MS) {
      list = hit.posts;
    } else {
      // ask for one extra so we can drop the post that is currently open
      const data = await e621Get("/posts.json", { tags: query, limit: cleanLimit + 1 });
      const raw = Array.isArray(data.posts) ? data.posts : [];
      const built = await Promise.all(raw.map((p) => buildThumb(p).catch(() => null)));
      list = built.filter(Boolean);

      if (artistCache.size >= ARTIST_CACHE_MAX) artistCache.delete(artistCache.keys().next().value);
      artistCache.set(cacheKey, { at: Date.now(), posts: list });
    }

    const posts = list.filter((p) => String(p.id) !== String(post.id)).slice(0, cleanLimit);
    res.json({ success: true, artist, posts });
  } catch (err) {
    console.error("artist-posts failed:", err.message, "post:", post.id);
    res.json({ success: false, message: "Failed to load artist posts", postId: post.id });
  }
});

// Tag autocomplete, with a short in-memory cache so typing doesn't hammer e621.
const AC_TTL_MS = 60 * 1000;
const AC_MAX_ENTRIES = 300;
const acCache = new Map(); // query -> { at, suggestions }

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
