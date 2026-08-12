const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// On Render: YTDLP_CMD=yt-dlp (installed via pip, available as binary)
// On local Windows: falls back to python -m yt_dlp
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
// ROUTE 1: APPLE MUSIC SEARCH (iTunes API)
// ─────────────────────────────────────────────
app.get('/api/search/apple', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=20`;
    const r = await fetch(url);
    const data = await r.json();
    const results = data.results.map(t => ({
      id: String(t.trackId),
      title: t.trackName,
      artist: t.artistName,
      album: t.collectionName,
      duration: Math.round(t.trackTimeMillis / 1000),
      thumbnail: t.artworkUrl100.replace('100x100', '600x600'),
      source: 'apple',
      // NEVER use previewUrl — use title+artist for full stream
      streamQuery: `${t.trackName} ${t.artistName} full official audio`
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: YOUTUBE SEARCH
// ─────────────────────────────────────────────
app.get('/api/search/youtube', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    // Use yt-dlp to search YouTube
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
            videoId: item.id,
            streamQuery: item.title
          };
        } catch { return null; }
      }).filter(Boolean);
      res.json({ results });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 3: SPOTIFY SEARCH (via iTunes fallback with distinct results)
// ─────────────────────────────────────────────
app.get('/api/search/spotify', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    // Use iTunes API with different entity to get distinct results
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=musicTrack&limit=20&country=GB`;
    const r = await fetch(url);
    const data = await r.json();
    const results = data.results.map(t => ({
      id: `sp_${t.trackId}`,
      title: t.trackName,
      artist: t.artistName,
      album: t.collectionName,
      duration: Math.round(t.trackTimeMillis / 1000),
      thumbnail: (t.artworkUrl100 || '').replace('100x100', '600x600'),
      source: 'spotify',
      streamQuery: `${t.trackName} ${t.artistName} audio`
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4: FULL SONG STREAM (HTTP 206 Range support)
// ─────────────────────────────────────────────
app.get('/api/stream', async (req, res) => {
  const { q, videoId } = req.query;
  if (!q && !videoId) return res.status(400).json({ error: 'Missing query or videoId' });

  const searchTarget = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `ytsearch1:${q} official audio`;

  // Step 1: Get direct stream URL with Android player client to avoid datacenter IP blocks
  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    searchTarget,
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', 'ba[ext=m4a]/140/ba/bestaudio',
    '--get-url',
    '--no-playlist',
    '--no-warnings',
    '--quiet'
  ], { timeout: 30000 }, async (err, stdout) => {
    if (err || !stdout.trim()) {
      return res.status(502).json({ error: 'Could not resolve stream URL' });
    }

    const streamUrl = stdout.trim().split('\n')[0];

    try {
      const rangeHeader = req.headers['range'];
      const fetchHeaders = { 
        'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 11; gts6l)'
      };
      if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(); }, 15000);

      const streamRes = await fetch(streamUrl, { headers: fetchHeaders, signal: controller.signal });
      clearTimeout(timeout);

      // ── HTTP 206 Range support ──
      res.status(streamRes.status); // 206 or 200
      const headersToForward = [
        'content-type', 'content-length', 'content-range',
        'accept-ranges', 'cache-control'
      ];
      headersToForward.forEach(h => {
        const v = streamRes.headers.get(h);
        if (v) res.setHeader(h, v);
      });
      res.setHeader('accept-ranges', 'bytes');

      let isClosed = false;
      req.on('close', () => { isClosed = true; controller.abort(); });

      streamRes.body.on('data', chunk => {
        if (!isClosed && !res.writableEnded) res.write(chunk);
      });
      streamRes.body.on('end', () => {
        if (!isClosed && !res.writableEnded) res.end();
      });
      streamRes.body.on('error', () => {
        isClosed = true;
        if (!res.writableEnded) res.end();
      });
    } catch (fetchErr) {
      if (!res.headersSent) res.status(502).json({ error: fetchErr.message });
    }
  });
});

// ─────────────────────────────────────────────
// ROUTE 5: GET STREAM INFO (title, duration, thumbnail)
// ─────────────────────────────────────────────
app.get('/api/stream-info', (req, res) => {
  const { q, videoId } = req.query;
  if (!q && !videoId) return res.status(400).json({ error: 'Missing query' });

  const searchTarget = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `ytsearch1:${q} official audio`;

  execFile(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    searchTarget,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--quiet'
  ], { timeout: 30000 }, (err, stdout) => {
    if (err || !stdout.trim()) return res.status(502).json({ error: 'Not found' });
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      // Duration check: enforce minimum 120 seconds (no 30-sec previews)
      if (info.duration && info.duration < 120) {
        return res.status(422).json({ error: 'Track too short (preview detected)' });
      }
      res.json({
        id: info.id,
        title: info.title,
        artist: info.uploader || info.channel,
        duration: info.duration,
        thumbnail: info.thumbnail,
        videoId: info.id
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ─────────────────────────────────────────────
// ROUTE 6: DOWNLOAD (MP3 or MP4)
// ─────────────────────────────────────────────
const fs = require('fs');
app.get('/api/download', (req, res) => {
  const { q, videoId, format, quality, title } = req.query;
  if (!q && !videoId) return res.status(400).json({ error: 'Missing query' });

  const searchTarget = videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `ytsearch1:${q} official audio`;

  let fmtArg;
  let ext;
  if (format === 'mp4') {
    const qualityMap = { '1080': 'bestvideo[height<=1080]+bestaudio/best', '720': 'bestvideo[height<=720]+bestaudio/best', '480': 'bestvideo[height<=480]+bestaudio/best', '360': 'bestvideo[height<=360]+bestaudio/best' };
    fmtArg = qualityMap[quality] || qualityMap['720'];
    ext = 'mp4';
  } else {
    fmtArg = 'ba[ext=m4a]/140/ba/bestaudio';
    ext = 'mp3';
  }

  const safeTitle = (title || 'download').replace(/[<>:"/\\|?*]/g, '');
  const fileName = `${safeTitle}.${ext}`;
  const tempFile = path.join(__dirname, `temp_${Date.now()}_${Math.floor(Math.random()*10000)}.${ext}`);

  const child = spawn(YTDLP, [
    ...YTDLP_ARGS_PREFIX,
    searchTarget,
    '-f', fmtArg,
    '-o', tempFile,
    '--no-playlist',
    '--no-warnings',
    '--quiet'
  ]);

  let isClosed = false;
  req.on('close', () => { isClosed = true; child.kill(); });
  
  child.on('close', (code) => {
    if (isClosed) {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      return;
    }
    if (code !== 0 || !fs.existsSync(tempFile)) {
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      return;
    }
    res.download(tempFile, fileName, (err) => {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 Music Player Backend running at http://0.0.0.0:${PORT}\n`);
});
