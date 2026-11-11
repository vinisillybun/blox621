// ============================================================================
// PATCH for server.js  (3 small changes)
// Your Roblox ImagesRequestHandler already calls POST /get-thumbs in chunks of
// 12 (3 in flight), but the server had no such route, so no grid cards arrived.
// ============================================================================

// ---------------------------------------------------------------------------
// CHANGE 1 — replace your existing slimPost() with this version.
// It also keeps the preview URL so thumbnails can be built later.
// ---------------------------------------------------------------------------
function slimPost(p) {
  return {
    id: p.id,
    previewUrl: p.preview && p.preview.url ? p.preview.url : null,
    sampleUrl: p.sample && p.sample.url ? p.sample.url : null,
    fileUrl: p.file && p.file.url ? p.file.url : null,
    width: p.file ? p.file.width : null,
    height: p.file ? p.file.height : null,
    rating: p.rating,
    meta: buildMeta(p),
  };
}

// ---------------------------------------------------------------------------
// CHANGE 2 — in the /fetch-posts route, replace the whole
//   const slim = posts.map((p) => ({ ... })).filter(...)
// block with:
// ---------------------------------------------------------------------------
//   const slim = posts
//     .map(slimPost)
//     .filter((p) => isSupportedUrl(p.sampleUrl) || isSupportedUrl(p.fileUrl));
//
// (slimPost is a function declaration, so it is hoisted and can be used there
//  even though it is defined further down the file.)

// ---------------------------------------------------------------------------
// CHANGE 3 — add this block anywhere above app.listen(...)
// ---------------------------------------------------------------------------
const THUMB_MAX_DIMENSION = 150;
const THUMB_CHUNK_MAX = 24; // hard cap per request
const THUMB_CONCURRENCY = 6; // simultaneous downloads from static1.e621.net

/** Small pool so a 320-post page never opens hundreds of sockets at once. */
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

/** Grid thumbnail for one cached post: raw RGBA, longest side <= 150px. */
async function buildGridThumb(post, index) {
  // e621's preview is already <=150px; fall back to the sample if it is missing.
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
    index: index + 1, // client uses this as LayoutOrder
    postId: post.id,
    width: info.width,
    height: info.height,
    // size of the sample the post view will lay out with (client scales to 850)
    originalWidth: post.width || info.width,
    originalHeight: post.height || info.height,
    pixelData: data.toString("base64"),
    meta: post.meta,
  };
}

/**
 * Body: { sessionId, start, count }
 * Returns grid thumbnails for session.posts[start .. start+count-1].
 */
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
