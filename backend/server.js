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
// ROUTE 1: YOUTUBE SEARCH (Ultra-fast via ytsr + fallback)
// ─────────────────────────────────────────────
app.get('/api/search/youtube', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    // 1. Fast Node.js search via ytsr
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
    console.log(`[Search] ytsr error: ${e.message}, falling back to yt-dlp`);
  }

  // 2. Fallback search via yt-dlp
  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    `ytsearch15:${q}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--quiet'
  ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
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
// ROUTE 2: DOWNLOAD (MP3 / MP4)
// ─────────────────────────────────────────────
app.get('/api/download', (req, res) => {
  const { videoId, q, format, title } = req.query;
  if (!videoId && !q) return res.status(400).json({ error: 'Missing videoId or q' });

  const isMp4 = (format === 'mp4');
  const ext = isMp4 ? 'mp4' : 'mp3';
  const sanitizeTitle = (title || videoId || 'youtube_track').replace(/[/\\?%*:|"<>]/g, '_');
  const fileName = `${sanitizeTitle}.${ext}`;

  const target = videoId ? `https://www.youtube.com/watch?v=${videoId}` : `ytsearch1:${q}`;
  const tempFile = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

  const formatArg = isMp4 ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' : 'ba[ext=m4a]/ba/bestaudio';
  const postArgs = isMp4 ? [] : ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];

  const ytdlpArgs = [
    ...YTDLP_ARGS_PREFIX,
    target,
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', formatArg,
    ...postArgs,
    '-o', tempFile,
    '--no-playlist',
    '--no-warnings'
  ];

  execFile(YTDLP, ytdlpArgs, { timeout: 120000 }, (err) => {
    if (err || !fs.existsSync(tempFile)) {
      console.error(`[Download Error]:`, err);
      return res.status(502).json({ error: 'Download failed' });
    }

    res.download(tempFile, fileName, (dlErr) => {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔴 Aura YouTube Backend running on port ${PORT}\n`);
});
