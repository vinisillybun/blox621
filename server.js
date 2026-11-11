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
    // Clean the query - remove special characters that might cause issues
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
  // Skip videos/gifs and find the next valid image
  while (currentIndex < cachedPosts.length) {
    const post = cachedPosts[currentIndex];
    const fileUrl = post.file?.url;

    if (fileUrl && !/\.(mp4|webm|gif)$/i.test(fileUrl)) {
      break; // Found a valid image
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

    // Get original image metadata
    const metadata = await sharp(imageBuffer).metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    // Resize to 512x512 with optimizations for Roblox
    const resizedBuffer = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert to base64 in smaller chunks to avoid memory issues
    const pixelData = resizedBuffer.data.toString('base64');

    currentIndex++;

    res.json({
      success: true,
      pixelData,
      width: resizedBuffer.info.width,
      height: resizedBuffer.info.height,
      originalWidth: originalWidth,
      originalHeight: originalHeight,
      sampleWidth: post.sample?.width || originalWidth,
      sampleHeight: post.sample?.height || originalHeight,
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
