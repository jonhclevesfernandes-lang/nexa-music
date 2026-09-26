'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'nexa-dev-secret-change-me');

if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('JWT_SECRET é obrigatória em produção.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:']
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const STATIC_TRACKS = [
  ['aurora','Aurora Digital','Nexa Sessions','Frequências','Eletrônica',2026,24,'assets/covers/aurora.svg','api/demo-audio/aurora.wav'],
  ['neon','Cidade Neon','Lina Vale','Entre Luzes','Pop',2026,24,'assets/covers/neon.svg','api/demo-audio/neon.wav'],
  ['solar','Pulso Solar','Caio Lume','Órbita','Eletrônica',2026,24,'assets/covers/solar.svg','api/demo-audio/solar.wav'],
  ['noite','Depois da Meia-Noite','Mira','Noite Clara','Lo-fi',2026,24,'assets/covers/noite.svg','api/demo-audio/noite.wav'],
  ['oceano','Maré Azul','Nora Azul','Oceano Interno','Ambient',2026,24,'assets/covers/oceano.svg','api/demo-audio/oceano.wav'],
  ['horizonte','Linha do Horizonte','Theo Serra','Caminhos','Instrumental',2026,24,'assets/covers/horizonte.svg','api/demo-audio/horizonte.wav']
];

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tracks (
        id VARCHAR(80) PRIMARY KEY,
        title VARCHAR(180) NOT NULL,
        artist VARCHAR(180) NOT NULL,
        album VARCHAR(180) NOT NULL DEFAULT '',
        genre VARCHAR(100) NOT NULL DEFAULT '',
        year INTEGER,
        duration INTEGER NOT NULL DEFAULT 0,
        cover_path TEXT,
        audio_path TEXT,
        cover_data BYTEA,
        cover_mime VARCHAR(100),
        audio_data BYTEA,
        audio_mime VARCHAR(100),
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS favorites (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id VARCHAR(80) NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, track_id)
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(240) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id VARCHAR(80) NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (playlist_id, track_id)
      );

      CREATE TABLE IF NOT EXISTS history (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id VARCHAR(80) NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_history_user_played ON history(user_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position ON playlist_tracks(playlist_id, position);
    `);

    for (const t of STATIC_TRACKS) {
      await client.query(`
        INSERT INTO tracks (id,title,artist,album,genre,year,duration,cover_path,audio_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          title=EXCLUDED.title, artist=EXCLUDED.artist, album=EXCLUDED.album,
          genre=EXCLUDED.genre, year=EXCLUDED.year, duration=EXCLUDED.duration,
          cover_path=EXCLUDED.cover_path, audio_path=EXCLUDED.audio_path
      `, t);
    }

    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = String(process.env.ADMIN_PASSWORD || '');
    const adminName = String(process.env.ADMIN_NAME || 'Administrador Nexa').trim();
    if (adminEmail && adminPassword.length >= 8) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await client.query(`
        INSERT INTO users (name,email,password_hash,is_admin)
        VALUES ($1,$2,$3,TRUE)
        ON CONFLICT (email) DO UPDATE SET is_admin=TRUE
      `, [adminName, adminEmail, hash]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function publicUser(row) {
  return { id: String(row.id), name: row.name, email: row.email, isAdmin: Boolean(row.is_admin) };
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email, admin: Boolean(user.is_admin) }, JWT_SECRET, { expiresIn: '30d' });
}

function optionalAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try { req.auth = jwt.verify(token, JWT_SECRET); } catch (_) { req.auth = null; }
  next();
}

function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.auth?.sub) return res.status(401).json({ error: 'Faça login para continuar.' });
    next();
  });
}

async function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const { rows } = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.auth.sub]);
      if (!rows[0]?.is_admin) return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
      next();
    } catch (err) { next(err); }
  });
}

const authAttempts = new Map();
function authThrottle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const current = authAttempts.get(key) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > current.reset) { current.count = 0; current.reset = now + 10 * 60 * 1000; }
  current.count += 1;
  authAttempts.set(key, current);
  if (current.count > 40) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  next();
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function slugId() { return `trk_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`; }

app.get('/api/health', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, service: 'nexa-music', database: true, time: rows[0].now });
  } catch (err) { next(err); }
});

app.post('/api/auth/register', authThrottle, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'Informe seu nome.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });

    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,is_admin',
      [name, email, hash]
    );
    const user = rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
    next(err);
  }
});

app.post('/api/auth/login', authThrottle, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id,name,email,is_admin FROM users WHERE id=$1', [req.auth.sub]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) { next(err); }
});

app.put('/api/me', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Informe um nome válido.' });
    const { rows } = await pool.query(
      'UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING id,name,email,is_admin',
      [name, req.auth.sub]
    );
    res.json({ user: publicUser(rows[0]) });
  } catch (err) { next(err); }
});

app.get('/api/tracks', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id,title,artist,album,genre,year,duration,cover_path,audio_path,
             (cover_data IS NOT NULL) AS has_cover_data,
             (audio_data IS NOT NULL) AS has_audio_data
      FROM tracks ORDER BY created_at ASC, title ASC
    `);
    const tracks = rows.map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      genre: r.genre,
      year: r.year,
      duration: r.duration,
      cover: r.has_cover_data ? `/api/tracks/${encodeURIComponent(r.id)}/cover` : `/${r.cover_path}`,
      src: r.has_audio_data ? `/api/tracks/${encodeURIComponent(r.id)}/stream` : `/${r.audio_path}`
    }));
    res.json({ tracks });
  } catch (err) { next(err); }
});

function buildDemoWav(trackId, seconds = 24, sampleRate = 22050) {
  const presets = {
    aurora: [220.00, 329.63, 440.00],
    neon: [261.63, 392.00, 523.25],
    solar: [196.00, 293.66, 440.00],
    noite: [174.61, 261.63, 349.23],
    oceano: [146.83, 220.00, 293.66],
    horizonte: [164.81, 246.94, 329.63]
  };
  const freqs = presets[trackId] || presets.aurora;
  const frames = seconds * sampleRate;
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const pulse = Math.floor(t / 4) % freqs.length;
    const f = freqs[pulse];
    const fadeIn = Math.min(1, t / 0.35);
    const fadeOut = Math.min(1, (seconds - t) / 0.5);
    const env = Math.max(0, Math.min(fadeIn, fadeOut));
    const pad = Math.sin(2 * Math.PI * f * t) * 0.32;
    const harmony = Math.sin(2 * Math.PI * (f * 1.5) * t) * 0.12;
    const bass = Math.sin(2 * Math.PI * (f / 2) * t) * 0.14;
    const sample = Math.max(-1, Math.min(1, (pad + harmony + bass) * env));
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

app.get('/api/demo-audio/:file', (req, res) => {
  const id = String(req.params.file || '').replace(/\.wav$/i, '');
  const allowed = new Set(STATIC_TRACKS.map(t => t[0]));
  if (!allowed.has(id)) return res.status(404).end();
  const wav = buildDemoWav(id);
  res.type('audio/wav');
  res.set('Content-Length', String(wav.length));
  res.set('Accept-Ranges', 'none');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(wav);
});

app.get('/api/tracks/:id/cover', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT cover_data,cover_mime,cover_path FROM tracks WHERE id=$1', [req.params.id]);
    const t = rows[0];
    if (!t) return res.status(404).end();
    if (!t.cover_data) return res.redirect(302, `/${t.cover_path}`);
    res.type(t.cover_mime || 'image/jpeg').set('Cache-Control', 'public, max-age=86400').send(t.cover_data);
  } catch (err) { next(err); }
});

app.get('/api/tracks/:id/stream', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT audio_data,audio_mime,audio_path FROM tracks WHERE id=$1', [req.params.id]);
    const t = rows[0];
    if (!t) return res.status(404).end();
    if (!t.audio_data) return res.redirect(302, `/${t.audio_path}`);
    const data = t.audio_data;
    const total = data.length;
    const range = req.headers.range;
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(t.audio_mime || 'audio/mpeg');
    if (!range) return res.set('Content-Length', String(total)).status(200).send(data);
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) return res.status(416).end();
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return res.status(416).set('Content-Range', `bytes */${total}`).end();
    }
    const chunk = data.subarray(start, end + 1);
    res.status(206)
      .set('Content-Range', `bytes ${start}-${end}/${total}`)
      .set('Content-Length', String(chunk.length))
      .send(chunk);
  } catch (err) { next(err); }
});

async function getLibrary(userId) {
  const [fav, pls, pt, hist] = await Promise.all([
    pool.query('SELECT track_id FROM favorites WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
    pool.query('SELECT id,name,description FROM playlists WHERE user_id=$1 ORDER BY updated_at DESC,id DESC', [userId]),
    pool.query(`
      SELECT pt.playlist_id,pt.track_id,pt.position
      FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
      WHERE p.user_id=$1 ORDER BY pt.playlist_id,pt.position,pt.added_at
    `, [userId]),
    pool.query(`
      SELECT track_id, MAX(played_at) AS last_played
      FROM history WHERE user_id=$1 GROUP BY track_id
      ORDER BY last_played DESC LIMIT 20
    `, [userId])
  ]);
  const byPlaylist = new Map();
  for (const row of pt.rows) {
    const key = String(row.playlist_id);
    if (!byPlaylist.has(key)) byPlaylist.set(key, []);
    byPlaylist.get(key).push(row.track_id);
  }
  return {
    favorites: fav.rows.map(r => r.track_id),
    playlists: pls.rows.map(p => ({ id: String(p.id), name: p.name, description: p.description, trackIds: byPlaylist.get(String(p.id)) || [] })),
    recent: hist.rows.map(r => r.track_id)
  };
}

app.get('/api/library', requireAuth, async (req, res, next) => {
  try { res.json(await getLibrary(req.auth.sub)); } catch (err) { next(err); }
});

app.put('/api/favorites/:trackId', requireAuth, async (req, res, next) => {
  try {
    await pool.query('INSERT INTO favorites(user_id,track_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.auth.sub, req.params.trackId]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Música não encontrada.' });
    next(err);
  }
});

app.delete('/api/favorites/:trackId', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM favorites WHERE user_id=$1 AND track_id=$2', [req.auth.sub, req.params.trackId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/history', requireAuth, async (req, res, next) => {
  try {
    const trackId = String(req.body.trackId || '');
    if (!trackId) return res.status(400).json({ error: 'trackId obrigatório.' });
    await pool.query('INSERT INTO history(user_id,track_id) VALUES($1,$2)', [req.auth.sub, trackId]);
    await pool.query(`
      DELETE FROM history WHERE user_id=$1 AND id NOT IN (
        SELECT id FROM history WHERE user_id=$1 ORDER BY played_at DESC LIMIT 200
      )
    `, [req.auth.sub]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Música não encontrada.' });
    next(err);
  }
});

app.post('/api/playlists', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0,100);
    const description = String(req.body.description || '').trim().slice(0,240);
    if (!name) return res.status(400).json({ error: 'Informe o nome da playlist.' });
    const { rows } = await pool.query(
      'INSERT INTO playlists(user_id,name,description) VALUES($1,$2,$3) RETURNING id,name,description',
      [req.auth.sub, name, description]
    );
    res.status(201).json({ playlist: { id: String(rows[0].id), name: rows[0].name, description: rows[0].description, trackIds: [] } });
  } catch (err) { next(err); }
});

app.put('/api/playlists/:id', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0,100);
    const description = String(req.body.description || '').trim().slice(0,240);
    if (!name) return res.status(400).json({ error: 'Informe o nome da playlist.' });
    const { rows } = await pool.query(`
      UPDATE playlists SET name=$1,description=$2,updated_at=NOW()
      WHERE id=$3 AND user_id=$4 RETURNING id,name,description
    `, [name, description, req.params.id, req.auth.sub]);
    if (!rows[0]) return res.status(404).json({ error: 'Playlist não encontrada.' });
    res.json({ playlist: { id: String(rows[0].id), name: rows[0].name, description: rows[0].description } });
  } catch (err) { next(err); }
});

app.delete('/api/playlists/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM playlists WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.sub]);
    if (!result.rowCount) return res.status(404).json({ error: 'Playlist não encontrada.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/playlists/:id/tracks', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const trackId = String(req.body.trackId || '');
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM playlists WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.auth.sub]);
    if (!owner.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Playlist não encontrada.' }); }
    const pos = await client.query('SELECT COALESCE(MAX(position),-1)+1 AS n FROM playlist_tracks WHERE playlist_id=$1', [req.params.id]);
    await client.query(`
      INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES($1,$2,$3)
      ON CONFLICT (playlist_id,track_id) DO NOTHING
    `, [req.params.id, trackId, Number(pos.rows[0].n)]);
    await client.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(404).json({ error: 'Música não encontrada.' });
    next(err);
  } finally { client.release(); }
});

app.delete('/api/playlists/:id/tracks/:trackId', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(`
      DELETE FROM playlist_tracks pt
      USING playlists p
      WHERE pt.playlist_id=p.id AND p.id=$1 AND p.user_id=$2 AND pt.track_id=$3
    `, [req.params.id, req.auth.sub, req.params.trackId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Música não encontrada nessa playlist.' });
    await pool.query('UPDATE playlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'audio' && !file.mimetype.startsWith('audio/')) return cb(new Error('Arquivo de áudio inválido.'));
    if (file.fieldname === 'cover' && !file.mimetype.startsWith('image/')) return cb(new Error('Capa inválida.'));
    cb(null, true);
  }
});

app.post('/api/admin/tracks', requireAdmin, upload.fields([{ name:'audio',maxCount:1 },{ name:'cover',maxCount:1 }]), async (req, res, next) => {
  try {
    const audio = req.files?.audio?.[0];
    const cover = req.files?.cover?.[0];
    const title = String(req.body.title || '').trim().slice(0,180);
    const artist = String(req.body.artist || '').trim().slice(0,180);
    const album = String(req.body.album || '').trim().slice(0,180);
    const genre = String(req.body.genre || '').trim().slice(0,100);
    const year = Number(req.body.year || new Date().getFullYear());
    const duration = Math.max(0, Number(req.body.duration || 0));
    if (!title || !artist || !audio) return res.status(400).json({ error: 'Título, artista e arquivo de áudio são obrigatórios.' });
    const id = slugId();
    await pool.query(`
      INSERT INTO tracks(id,title,artist,album,genre,year,duration,cover_data,cover_mime,audio_data,audio_mime,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [id,title,artist,album,genre,year,duration,cover?.buffer || null,cover?.mimetype || null,audio.buffer,audio.mimetype,req.auth.sub]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

app.get('/api/admin/stats', requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM tracks) AS tracks,
        (SELECT COUNT(*) FROM playlists) AS playlists,
        (SELECT COUNT(*) FROM history) AS plays
    `);
    res.json({ stats: Object.fromEntries(Object.entries(rows[0]).map(([k,v]) => [k, Number(v)])) });
  } catch (err) { next(err); }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Falha no upload: ${err.message}` });
  if (/inválid[oa]/i.test(err.message || '')) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

initDb()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Nexa Music em http://0.0.0.0:${PORT}`)))
  .catch(err => {
    console.error('Falha ao inicializar banco:', err);
    process.exit(1);
  });
