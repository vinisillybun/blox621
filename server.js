const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.json());

// --- e621 config -----------------------------------------------------------
// A descriptive User-Agent with REAL contact info is required by e621.
// Default library UAs and browser impersonation get blocked (403).
const USER_AGENT = "Blox621/1.0 (Roblox experience; contact: your_email@example.com)";
const E621_BASE = "https://e621.net";
const MAX_EDITABLE_DIMENSION = 1024; // Roblox EditableImage limit
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 320;

// e621 hard limit is 2 req/s; they ask for <= 1 req/s sustained.
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
    validateStatus: () => true, // handle codes ourselves
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

// --- in-memory state -------------------------------------------------------
// The Roblox client never sends a postId, so the server hands out posts in
// order from the last search: /fetch-posts primes this, /get-next-image drains it.
let cachedPosts = [];
let cursor = 0;
let imageCache = {}; // postId+mode -> response payload

function resetCache() {
  cachedPosts = [];
  cursor = 0;
  imageCache = {};
}

// --- routes ----------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Blox621", posts: cachedPosts.length });
});

/**
 * Search posts. Body: { tags?: string|string[], page?: number, limit?: number }
 * Response shape the Roblox script expects: { success, count, posts }
 */
app.post("/fetch-posts", async (req, res) => {
  const { tags = "", page = 1, limit = DEFAULT_LIMIT } = req.body || {};

  const tagString = Array.isArray(tags) ? tags.join(" ") : String(tags || "");
  const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cleanPage = Math.max(parseInt(page, 10) || 1, 1);

  // Always default to safe content unless the caller asked otherwise.
  const finalTags = tagString.trim().length > 0 ? tagString : "rating:safe";

  try {
    const data = await e621Get("/posts.json", {
      tags: finalTags,
      limit: cleanLimit,
      page: cleanPage,
    });

    const posts = Array.isArray(data.posts) ? data.posts : [];
    resetCache();
    cachedPosts = posts;

    if (posts.length === 0) {
      return res.json({ success: true, count: 0, posts: [] });
    }

    // Only send the client what it needs: id and the URLs it may request.
    const slim = posts.map((p) => ({
      id: p.id,
      sampleUrl: p.sample && p.sample.url ? p.sample.url : null,
      fileUrl: p.file && p.file.url ? p.file.url : null,
      width: p.file ? p.file.width : null,
      height: p.file ? p.file.height : null,
      sampleWidth: p.sample ? p.sample.width : null,
      sampleHeight: p.sample ? p.sample.height : null,
      rating: p.rating,
    }));

    res.json({ success: true, count: slim.length, posts: slim });
  } catch (err) {
    console.error("fetch-posts failed:", err.message);
    const status = err.status === 429 ? 429 : 500;
    res.status(status).json({ success: false, error: err.message, count: 0 });
  }
});

/**
 * Hand out the next image in the cached post list.
 * Body: { mode?: "sample" | "original" }  -- matches the Roblox client.
 * Response: { success, pixelData, width, height, originalWidth, originalHeight, postId, mode }
 */
app.post("/get-next-image", async (req, res) => {
  const { mode = "sample" } = req.body || {};

  if (cachedPosts.length === 0) {
    return res.json({ success: false, message: "No posts cached. Call /fetch-posts first." });
  }
  if (cursor >= cachedPosts.length) {
    return res.json({ success: false, message: "No more images in this batch." });
  }

  const post = cachedPosts[cursor];
  cursor += 1;

  const cacheKey = `${post.id}:${mode}`;
  if (imageCache[cacheKey]) {
    return res.json({ success: true, ...imageCache[cacheKey] });
  }

  const fileUrl =
    mode === "original" ? post.fileUrl : post.sampleUrl || post.fileUrl;
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

    // Read the REAL dimensions of the bytes we just downloaded.
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;
    if (!originalWidth || !originalHeight) {
      return res.json({ success: false, message: "Could not read image dimensions" });
    }

    // Work out a target size that respects BOTH the 850px sample cap and the
    // 1024px EditableImage cap, scaled proportionally.
    let scale = 1;
    if (mode === "sample" && originalWidth > 850) {
      scale = 850 / originalWidth;
    }
    let targetWidth = Math.round(originalWidth * scale);
    let targetHeight = Math.round(originalHeight * scale);

    const largest = Math.max(targetWidth, targetHeight);
    if (largest > MAX_EDITABLE_DIMENSION) {
      const capScale = MAX_EDITABLE_DIMENSION / largest;
      targetWidth = Math.round(targetWidth * capScale);
      targetHeight = Math.round(targetHeight * capScale);
    }

    // .raw() with ensureAlpha() gives RGBA — exactly 4 bytes per pixel.
    const processed = await sharp(imageBuffer)
      .ensureAlpha()
      .resize(targetWidth, targetHeight, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = processed;
    if (info.channels !== 4) {
      return res.json({ success: false, message: `Expected 4 channels, got ${info.channels}` });
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

    imageCache[cacheKey] = payload;
    res.json(payload);
  } catch (err) {
    console.error("get-next-image failed:", err.message);
    res.json({ success: false, message: "Failed to process image" });
  }
});

/** Kept for compatibility with anything that names a post explicitly. */
app.post("/get-image", async (req, res) => {
  const { postId, mode = "sample" } = req.body || {};
  const index = cachedPosts.findIndex((p) => String(p.id) === String(postId));
  if (index === -1) {
    return res.json({ success: false, message: "Post not found in cache" });
  }
  cursor = index; // let /get-next-image pick it up
  return app._router.handle(
    Object.assign(req, { url: "/get-next-image", body: { mode }, method: "POST" }),
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
