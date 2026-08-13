const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const ytsr = require('ytsr');
const path = require('path');
const fs = require('fs');

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
// ROUTE 1: YOUTUBE SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/youtube', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const searchRes = await ytsr(q, { limit: 20 });
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
      return res.json({ results });
    }
  } catch (e) {
    console.log(`[Search] ytsr error: ${e.message}`);
  }

  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    `ytsearch15:${q}`,
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
    res.json({ results });
  });
});

// ─────────────────────────────────────────────
// ROUTE 1B: YOUTUBE MUSIC SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/ytmusic', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const queryWithMusic = q.toLowerCase().includes('song') || q.toLowerCase().includes('music') ? q : `${q} song`;

  try {
    const searchRes = await ytsr(queryWithMusic, { limit: 20 });
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
      return res.json({ results });
    }
  } catch (e) {
    console.log(`[YTMusic] ytsr error: ${e.message}`);
  }

  res.json({ results: [] });
});

// ─────────────────────────────────────────────
// ROUTE 1C: SPOTIFY SEARCH (AUDIO MP3 ONLY)
// ─────────────────────────────────────────────
app.get('/api/search/spotify', async (req, res) => {
  const { q } = req.query;
  const searchQuery = q ? `${q} spotify audio` : 'top spotify songs audio 2026';

  try {
    const searchRes = await ytsr(searchQuery, { limit: 20 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    const results = items.map(item => ({
      id: item.id,
      title: item.title ? item.title.replace(/official audio|lyric video/gi, '').trim() : 'Spotify Track',
      artist: item.author ? item.author.name : 'Spotify Artist',
      duration: 0,
      thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      source: 'spotify',
      videoId: item.id,
      isAudioOnly: true
    }));
    return res.json({ results });
  } catch (e) {
    console.log(`[Spotify Search Error]: ${e.message}`);
    return res.json({ results: [] });
  }
});

// ─────────────────────────────────────────────
// ROUTE 1D: APPLE MUSIC SEARCH (AUDIO MP3 ONLY)
// ─────────────────────────────────────────────
app.get('/api/search/applemusic', async (req, res) => {
  const { q } = req.query;
  const searchQuery = q ? `${q} apple music audio` : 'top apple music charts 2026';

  try {
    const searchRes = await ytsr(searchQuery, { limit: 20 });
    const items = (searchRes.items || []).filter(i => i.type === 'video');

    const results = items.map(item => ({
      id: item.id,
      title: item.title ? item.title.replace(/official audio|lyric video/gi, '').trim() : 'Apple Music Track',
      artist: item.author ? item.author.name : 'Apple Music Artist',
      duration: 0,
      thumbnail: item.bestThumbnail ? item.bestThumbnail.url : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      source: 'applemusic',
      videoId: item.id,
      isAudioOnly: true
    }));
    return res.json({ results });
  } catch (e) {
    console.log(`[Apple Music Search Error]: ${e.message}`);
    return res.json({ results: [] });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: DOWNLOAD (MP3 / MP4 Instant Pipe Stream)
// ─────────────────────────────────────────────
app.get('/api/download', (req, res) => {
  const { videoId, q, format, title } = req.query;
  if (!videoId && !q) return res.status(400).json({ error: 'Missing videoId or q' });

  const isMp4 = (format === 'mp4');
  const ext = isMp4 ? 'mp4' : 'mp3';
  const mime = isMp4 ? 'video/mp4' : 'audio/mpeg';
  const sanitizeTitle = (title || videoId || 'song_track').replace(/[/\\?%*:|"<>]/g, '_');
  const fileName = `${sanitizeTitle}.${ext}`;

  const target = videoId ? `https://www.youtube.com/watch?v=${videoId}` : `ytsearch1:${q}`;
  const formatArg = isMp4 ? 'best[ext=mp4]/best' : 'ba/bestaudio/best';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');

  const ytdlpArgs = [
    ...YTDLP_ARGS_PREFIX,
    target,
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', formatArg,
    '-o', '-',
    '--no-playlist',
    '--no-warnings',
    '--quiet'
  ];

  const proc = spawn(YTDLP, ytdlpArgs);
  proc.stdout.pipe(res);

  req.on('close', () => {
    proc.kill();
  });

  proc.on('error', (err) => {
    console.error(`[Download Error]:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔴 Aura YouTube Backend running on port ${PORT}\n`);
});
