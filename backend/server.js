const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const ytsr = require('ytsr');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

const YTDLP_CMD = process.env.YTDLP_CMD || null;
const YTDLP = YTDLP_CMD || 'python';
const YTDLP_ARGS_PREFIX = YTDLP_CMD ? [] : ['-m', 'yt_dlp'];

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// ─────────────────────────────────────────────
// LIGHTNING FAST IN-MEMORY SEARCH CACHE (0ms SPEED)
// ─────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function getCachedResults(key) {
  if (searchCache.has(key)) {
    const entry = searchCache.get(key);
    if (Date.now() - entry.timestamp < CACHE_TTL) {
      console.log(`[Cache Hit - 0ms]: ${key}`);
      return entry.results;
    }
    searchCache.delete(key);
  }
  return null;
}

function setCachedResults(key, results) {
  if (results && results.length > 0) {
    searchCache.set(key, { timestamp: Date.now(), results });
  }
}

// FAST PUBLIC YOUTUBE SEARCH FETCH HELPER (300ms FAST RESPONSE)
function fetchFastYoutubeApi(query) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const url = `https://inv.tux.pizza/api/v1/search?q=${encoded}&type=video`;
    
    const req = https.get(url, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data) && data.length > 0) {
            const results = data.slice(0, 15).map(item => ({
              id: item.videoId,
              title: item.title,
              artist: item.author || 'YouTube',
              duration: item.lengthSeconds || 0,
              thumbnail: (item.videoThumbnails && item.videoThumbnails.length > 0) 
                ? item.videoThumbnails[0].url 
                : `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
              source: 'youtube',
              videoId: item.videoId
            }));
            return resolve(results);
          }
        } catch(e){}
        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─────────────────────────────────────────────
// ROUTE 1: YOUTUBE SEARCH (LIGHTNING FAST)
// ─────────────────────────────────────────────
app.get('/api/search/youtube', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const cacheKey = `yt:${q.toLowerCase().trim()}`;
  const cached = getCachedResults(cacheKey);
  if (cached) return res.json({ results: cached });

  // Try Fast API first (300ms)
  const fastResults = await fetchFastYoutubeApi(q);
  if (fastResults && fastResults.length > 0) {
    setCachedResults(cacheKey, fastResults);
    return res.json({ results: fastResults });
  }

  // Fallback to ytsr with limit 15 for faster scraping
  try {
    const searchRes = await ytsr(q, { limit: 15 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    if (items.length > 0) {
      const results = items.map(item => {
        let durSec = 0;
        if (item.duration) {
          const parts = item.duration.split(':').map(Number);
          if (parts.length === 2) durSec = parts[0] * 60 + parts[1];
          else if (parts.length === 3) durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return {
          id: item.id,
          title: item.title,
          artist: item.author ? item.author.name : 'YouTube',
          duration: durSec,
          thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          source: 'youtube',
          videoId: item.id
        };
      });
      setCachedResults(cacheKey, results);
      return res.json({ results });
    }
  } catch (e) {
    console.log(`[Search] ytsr error: ${e.message}`);
  }

  // Fallback to yt-dlp flat playlist
  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    `ytsearch12:${q}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--quiet'
  ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.json({ results: [] });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const results = lines.map(line => {
      try {
        const item = JSON.parse(line);
        return {
          id: item.id,
          title: item.title,
          artist: item.uploader || item.channel || 'YouTube',
          duration: item.duration || 0,
          thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          source: 'youtube',
          videoId: item.id
        };
      } catch { return null; }
    }).filter(Boolean);
    setCachedResults(cacheKey, results);
    res.json({ results });
  });
});

// ─────────────────────────────────────────────
// ROUTE 1B: YOUTUBE MUSIC SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/ytmusic', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const queryWithMusic = q.toLowerCase().includes('song') || q.toLowerCase().includes('music') ? q : `${q} official audio`;
  const cacheKey = `ytm:${queryWithMusic.toLowerCase().trim()}`;
  const cached = getCachedResults(cacheKey);
  if (cached) return res.json({ results: cached });

  const fastResults = await fetchFastYoutubeApi(queryWithMusic);
  if (fastResults && fastResults.length > 0) {
    const formatted = fastResults.map(item => ({
      ...item,
      title: item.title ? item.title.replace(/\(Official Audio\)/gi, '').replace(/\[Official Audio\]/gi, '').trim() : item.title,
      source: 'ytmusic',
      isAudioOnly: true
    }));
    setCachedResults(cacheKey, formatted);
    return res.json({ results: formatted });
  }

  try {
    const searchRes = await ytsr(queryWithMusic, { limit: 15 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    if (items.length > 0) {
      const results = items.map(item => {
        let durSec = 0;
        if (item.duration) {
          const parts = item.duration.split(':').map(Number);
          if (parts.length === 2) durSec = parts[0] * 60 + parts[1];
          else if (parts.length === 3) durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return {
          id: item.id,
          title: item.title ? item.title.replace(/\(Official Audio\)/gi, '').replace(/\[Official Audio\]/gi, '').trim() : 'Track',
          artist: item.author ? item.author.name : 'YouTube Music',
          duration: durSec,
          thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          source: 'ytmusic',
          videoId: item.id,
          isAudioOnly: true
        };
      });
      setCachedResults(cacheKey, results);
      return res.json({ results });
    }
  } catch (e) {
    console.log(`[YTMusic] ytsr error: ${e.message}`);
  }

  res.json({ results: [] });
});

// ─────────────────────────────────────────────
// ROUTE 1C: SPOTIFY SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/spotify', async (req, res) => {
  const { q } = req.query;
  const cleanQ = (q || '').replace(/spotify/gi, '').trim();
  const searchQuery = cleanQ ? `${cleanQ} official audio` : 'top global audio songs 2026';
  
  const cacheKey = `sp:${searchQuery.toLowerCase().trim()}`;
  const cached = getCachedResults(cacheKey);
  if (cached) return res.json({ results: cached });

  const fastResults = await fetchFastYoutubeApi(searchQuery);
  if (fastResults && fastResults.length > 0) {
    const formatted = fastResults.map(item => ({
      ...item,
      title: item.title ? item.title.replace(/official audio|lyric video|official video/gi, '').trim() : item.title,
      artist: item.artist || 'Spotify Artist',
      source: 'spotify',
      isAudioOnly: true
    }));
    setCachedResults(cacheKey, formatted);
    return res.json({ results: formatted });
  }

  try {
    const searchRes = await ytsr(searchQuery, { limit: 15 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    const results = items.map(item => ({
      id: item.id,
      title: item.title ? item.title.replace(/official audio|lyric video|official video/gi, '').trim() : 'Spotify Track',
      artist: item.author ? item.author.name : 'Spotify Artist',
      duration: 0,
      thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      source: 'spotify',
      videoId: item.id,
      isAudioOnly: true
    }));
    setCachedResults(cacheKey, results);
    return res.json({ results });
  } catch (e) {
    console.log(`[Spotify Search Error]: ${e.message}`);
    return res.json({ results: [] });
  }
});

// ─────────────────────────────────────────────
// ROUTE 1D: APPLE MUSIC SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/applemusic', async (req, res) => {
  const { q } = req.query;
  const cleanQ = (q || '').replace(/apple music/gi, '').trim();
  const searchQuery = cleanQ ? `${cleanQ} official audio` : 'top charts audio songs 2026';

  const cacheKey = `ap:${searchQuery.toLowerCase().trim()}`;
  const cached = getCachedResults(cacheKey);
  if (cached) return res.json({ results: cached });

  const fastResults = await fetchFastYoutubeApi(searchQuery);
  if (fastResults && fastResults.length > 0) {
    const formatted = fastResults.map(item => ({
      ...item,
      title: item.title ? item.title.replace(/official audio|lyric video|official video/gi, '').trim() : item.title,
      artist: item.artist || 'Apple Music Artist',
      source: 'applemusic',
      isAudioOnly: true
    }));
    setCachedResults(cacheKey, formatted);
    return res.json({ results: formatted });
  }

  try {
    const searchRes = await ytsr(searchQuery, { limit: 15 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    const results = items.map(item => ({
      id: item.id,
      title: item.title ? item.title.replace(/official audio|lyric video|official video/gi, '').trim() : 'Apple Music Track',
      artist: item.author ? item.author.name : 'Apple Music Artist',
      duration: 0,
      thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      source: 'applemusic',
      videoId: item.id,
      isAudioOnly: true
    }));
    setCachedResults(cacheKey, results);
    return res.json({ results });
  } catch (e) {
    console.log(`[Apple Music Search Error]: ${e.message}`);
    return res.json({ results: [] });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2A: DIRECT AUDIO STREAM (FOR HTML5 PLAYBACK)
// ─────────────────────────────────────────────
app.get('/api/stream/audio', (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).send('Missing videoId');

  const target = `https://www.youtube.com/watch?v=${videoId}`;

  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    target,
    '-f', 'ba/b/best',
    '-g',
    '--no-check-certificates',
    '--no-warnings',
    '--quiet'
  ], (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(404).send('Audio stream not available');
    }
    const directUrl = stdout.trim().split('\n')[0];
    res.redirect(302, directUrl);
  });
});

// ─────────────────────────────────────────────
// ROUTE 2B: DOWNLOAD STREAM & REDIRECT
// ─────────────────────────────────────────────
app.get('/api/download', (req, res) => {
  const { videoId, q, format } = req.query;
  if (!videoId && !q) return res.status(400).send('Missing parameters');

  const isMp4 = (format === 'mp4');
  const target = videoId ? `https://www.youtube.com/watch?v=${videoId}` : `ytsearch1:${q}`;
  const formatArg = isMp4 ? 'b[ext=mp4]/b/best' : 'ba/b/best';

  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    target,
    '-f', formatArg,
    '-g',
    '--no-check-certificates',
    '--no-warnings',
    '--quiet'
  ], (err, stdout) => {
    if (err || !stdout.trim()) {
      const fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`;
      return res.redirect(302, fallbackUrl);
    }
    const directMediaUrl = stdout.trim().split('\n')[0];
    res.redirect(302, directMediaUrl);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔴 Aura YouTube Backend running on port ${PORT}\n`);
});
