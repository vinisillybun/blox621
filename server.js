const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.json());

let cachedPosts = [];
let imageCache = {};
const MAX_EDITABLE_DIMENSION = 1024;

app.post('/fetch-posts', async (req, res) => {
  const { tags = 'rating:safe', page = 1, limit = 30 } = req.body;
  const maxLimit = 320;
  const validLimit = Math.min(Math.max(parseInt(limit) || 30, 1), maxLimit);

  try {
    const url = `https://e621.net/posts.json?limit=${validLimit}&page=${page}&tags=${encodeURIComponent(tags)}`;
    const headers = { 'User-Agent': 'RobloxGame/1.0 (by your_email@example.com)' };

    const response = await axios.get(url, { headers });
    cachedPosts = response.data.posts || [];
    imageCache = {};

    if (cachedPosts.length === 0) {
      return res.status(404).json({ error: 'No posts found', count: 0 });
    }

    res.json({ success: true, count: cachedPosts.length, posts: cachedPosts });
  } catch (err) {
    console.error('Error fetching posts:', err.message);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

app.post('/autocomplete-tags', async (req, res) => {
  const { query = '' } = req.body;
  if (!query || query.trim().length === 0) return res.json({ success: true, suggestions: [] });

  try {
    const cleanQuery = query.trim().replace(/[^\w\s-_]/g, '');
    const url = `https://e621.net/tags/autocomplete.json?search[name_matches]=${encodeURIComponent(cleanQuery)}*`;
    const headers = { 'User-Agent': 'RobloxGame/1.0 (by your_email@example.com)' };

    const response = await axios.get(url, { headers });
    const tags = response.data || [];

    const suggestions = tags.slice(0, 10).map(tag => ({
      name: tag.name,
      postCount: tag.post_count || 0,
      category: tag.category || 0
    }));

    res.json({ success: true, suggestions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch autocomplete suggestions', details: err.message });
  }
});

app.post('/get-image', async (req, res) => {
  const { postId, mode = 'sample' } = req.body;
  const post = cachedPosts.find(p => p.id === postId);
  
  if (!post) return res.status(404).json({ success: false, message: 'Post not found in cache' });

  if (imageCache[postId] && imageCache[postId][mode]) {
    return res.json({ success: true, ...imageCache[postId][mode] });
  }

  let fileUrl = mode === 'original' ? post.file?.url : (post.sample?.url || post.file?.url);
  if (!fileUrl) return res.json({ success: false, message: 'No file URL available' });

  try {
    const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    if (!originalWidth || !originalHeight) return res.json({ success: false, message: 'Could not read image dimensions' });

    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (mode === 'sample' && originalWidth > 850) {
      targetWidth = 850;
      targetHeight = Math.round(originalHeight * (850 / originalWidth));
    }

    if (targetWidth > MAX_EDITABLE_DIMENSION || targetHeight > MAX_EDITABLE_DIMENSION) {
      const scale = MAX_EDITABLE_DIMENSION / Math.max(targetWidth, targetHeight);
      targetWidth = Math.round(targetWidth * scale);
      targetHeight = Math.round(targetHeight * scale);
    }

    let pipeline = sharp(imageBuffer).ensureAlpha();
    if (targetWidth !== originalWidth || targetHeight !== originalHeight) {
      pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'fill' });
    }

    const processed = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixelData = processed.data.toString('base64');

    const responseData = {
      success: true,
      pixelData,
      width: processed.info.width,
      height: processed.info.height,
      originalWidth,
      originalHeight,
      postId: post.id,
      mode: mode
    };

    if (!imageCache[postId]) imageCache[postId] = {};
    imageCache[postId][mode] = responseData;

    res.json(responseData);
  } catch (err) {
    res.json({ success: false, message: 'Failed to process image' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
