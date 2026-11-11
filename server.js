const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.json());

let cachedPosts = [];
let currentIndex = 0;

const MAX_DIMENSION = 1024;

app.post('/fetch-posts', async (req, res) => {
  const { tags = 'rating:safe', page = 1, limit = 30 } = req.body;

  const maxLimit = 320;
  const validLimit = Math.min(Math.max(parseInt(limit) || 30, 1), maxLimit);

  try {
    const url = `https://e621.net/posts.json?limit=${validLimit}&page=${page}&tags=${encodeURIComponent(tags)}`;
    const headers = { 'User-Agent': 'RobloxGame/1.0 (by your_email@example.com)' };

    const response = await axios.get(url, { headers });
    cachedPosts = response.data.posts || [];
    currentIndex = 0;

    if (cachedPosts.length === 0) {
      console.log('No posts found for tags:', tags);
      return res.status(404).json({ error: 'No posts found', count: 0 });
    }

    console.log(`Fetched ${cachedPosts.length} posts`);
    res.json({ success: true, count: cachedPosts.length });

  } catch (err) {
    console.error('Error fetching posts:', err.message);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

app.post('/autocomplete-tags', async (req, res) => {
  const { query = '' } = req.body;

  if (!query || query.trim().length === 0) {
    return res.json({ success: true, suggestions: [] });
  }

  try {
    const cleanQuery = query.trim().replace(/[^\w\s-_]/g, '');

    const url = `https://e621.net/tags/autocomplete.json?search[name_matches]=${encodeURIComponent(cleanQuery)}*`;
    const headers = { 'User-Agent': 'RobloxGame/1.0 (by your_email@example.com)' };

    console.log('Autocomplete request for:', cleanQuery);

    const response = await axios.get(url, { headers });
    const tags = response.data || [];

    const suggestions = tags.slice(0, 10).map(tag => ({
      name: tag.name,
      postCount: tag.post_count || 0,
      category: tag.category || 0
    }));

    res.json({ success: true, suggestions });

  } catch (err) {
    console.error('Error fetching autocomplete:', err.message);
    console.error('Query was:', query);
    res.status(500).json({ error: 'Failed to fetch autocomplete suggestions', details: err.message });
  }
});

app.post('/get-next-image', async (req, res) => {
  while (currentIndex < cachedPosts.length) {
    const post = cachedPosts[currentIndex];
    const fileUrl = post.file?.url;

    if (fileUrl && !/\.(mp4|webm|gif)$/i.test(fileUrl)) {
      break;
    }
    currentIndex++;
  }

  if (currentIndex >= cachedPosts.length) {
    return res.json({ success: false, message: 'No more images' });
  }

  const post = cachedPosts[currentIndex];
  const fileUrl = post.sample?.url || post.file?.url;

  if (!fileUrl) {
    currentIndex++;
    return res.json({ success: false, message: 'No file URL available' });
  }

  try {
    const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);

    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    if (!originalWidth || !originalHeight) {
      currentIndex++;
      return res.json({ success: false, message: 'Could not read image dimensions' });
    }

    const longestSide = Math.max(originalWidth, originalHeight);
    const needsResize = longestSide > MAX_DIMENSION;

    let pipeline = sharp(imageBuffer).ensureAlpha();

    if (needsResize) {
      const scale = MAX_DIMENSION / longestSide;
      const targetWidth = Math.round(originalWidth * scale);
      const targetHeight = Math.round(originalHeight * scale);
      pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'fill' });
    }

    const processed = await pipeline.raw().toBuffer({ resolveWithObject: true });

    const pixelData = processed.data.toString('base64');

    currentIndex++;

    res.json({
      success: true,
      pixelData,
      width: processed.info.width,
      height: processed.info.height,
      originalWidth,
      originalHeight,
      rating: post.rating,
      postId: post.id,
      score: post.score?.total || 0,
      favorites: post.fav_count || 0,
      comments: post.comment_count || 0,
      remaining: cachedPosts.length - currentIndex
    });

  } catch (err) {
    console.warn('Failed to process image:', fileUrl, err.message);
    currentIndex++;
    return res.json({ success: false, message: 'Failed to process image' });
  }
});

app.listen(PORT, () => {
  console.log(`Image server running on port ${PORT}`);
});
