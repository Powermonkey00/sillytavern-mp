const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();

// --- config loader ---
const CFG_PATH = path.resolve(__dirname, 'config.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

const cfg = readJSON(CFG_PATH) || {};

// precedence: ENV > config.json > default
const ST_DATA = path.resolve(
  process.env.ST_DATA || cfg.ST_DATA || cfg.st_data ||
  'C:/SillyTavern-1.13.2/data/default-user'
);

const PORT = Number(process.env.PORT || cfg.PORT || cfg.port || 3000);

// optional: log what was chosen
console.log('[CFG] ST_DATA =', ST_DATA);
console.log('[CFG] PORT    =', PORT);

const CH_DIR = path.join(ST_DATA, 'characters');
const LB_DIR = path.join(ST_DATA, 'lorebooks');
const GROUPS_DIR = path.join(ST_DATA, 'groups');

let chatHistory = [];
let queuedMessages = [];

// -------- middleware --------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
app.use(express.static('public'));

// Serve ST assets (so avatars/PNGs work)
if (fs.existsSync(ST_DATA)) {
  app.use('/assets', express.static(ST_DATA));
  console.log(`[MP] Serving ST assets from: ${ST_DATA}`);
} else {
  console.warn(`[MP] ST_DATA does not exist: ${ST_DATA}`);
}

// ======= Chat endpoints (unchanged) =======
app.post('/set-chat', (req, res) => {
  chatHistory = req.body;
  res.send('Chat history received and stored successfully');
});
app.get('/get-chat', (req, res) => res.json(chatHistory));
app.post('/queue-message', (req, res) => {
  queuedMessages.push(req.body);
  console.log('Queued message:', req.body);
  res.send('Message queued successfully');
});
app.get('/queued-messages', (req, res) => {
  res.json(queuedMessages);
  queuedMessages = [];
});

// ======= Helpers =======
function readJSONSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir).filter(f => exts.some(e => f.toLowerCase().endsWith(e)));
  } catch {
    return [];
  }
}

// --- PNG metadata parsing (tEXt / zTXt / iTXt) ---
function parsePngTextChunks(buf) {
  const CHUNK = {
    IHDR: 0x49484452, IDAT: 0x49444154, IEND: 0x49454E44,
    tEXt: 0x74455874, zTXt: 0x7A545874, iTXt: 0x69545874
  };
  let pos = 8; // skip PNG sig

  const out = []; // {keyword, text}

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.readUInt32BE(pos); pos += 4;
    const dataStart = pos;
    const dataEnd = pos + len;

    if (dataEnd > buf.length) break;

    if (type === CHUNK.tEXt) {
      // tEXt: keyword\0text
      const zero = buf.indexOf(0x00, dataStart);
      if (zero !== -1 && zero < dataEnd) {
        const keyword = buf.slice(dataStart, zero).toString('utf8');
        const text = buf.slice(zero + 1, dataEnd).toString('latin1'); // spec says ISO-8859-1
        out.push({ keyword, text });
      }
    } else if (type === CHUNK.zTXt) {
      // zTXt: keyword\0compression_method, compressed_text
      let p = dataStart;
      const zero = buf.indexOf(0x00, p);
      if (zero !== -1 && zero < dataEnd) {
        const keyword = buf.slice(p, zero).toString('utf8');
        p = zero + 1;
        const compMethod = buf[p]; p += 1;
        const compData = buf.slice(p, dataEnd);
        if (compMethod === 0) {
          try {
            const text = zlib.inflateSync(compData).toString('utf8');
            out.push({ keyword, text });
          } catch {}
        }
      }
    } else if (type === CHUNK.iTXt) {
      // iTXt: keyword\0 compFlag compMethod language\0 translated\0 text
      let p = dataStart;
      const zero1 = buf.indexOf(0x00, p);
      if (zero1 !== -1 && zero1 < dataEnd) {
        const keyword = buf.slice(p, zero1).toString('utf8');
        p = zero1 + 1;
        const compFlag = buf[p]; p += 1;
        const compMethod = buf[p]; p += 1;
        // languageTag
        const zero2 = buf.indexOf(0x00, p);
        if (zero2 === -1 || zero2 >= dataEnd) { /* malformed */ }
        else {
          // skip language tag and translated keyword
          p = zero2 + 1;
          const zero3 = buf.indexOf(0x00, p);
          if (zero3 !== -1 && zero3 < dataEnd) {
            p = zero3 + 1;
            const textData = buf.slice(p, dataEnd);
            try {
              const text = compFlag ? zlib.inflateSync(textData).toString('utf8')
                                    : textData.toString('utf8');
              out.push({ keyword, text });
            } catch {}
          }
        }
      }
    }

    // skip CRC
    pos = dataEnd + 4;
    if (type === CHUNK.IEND) break;
  }

  return out;
}

// Try to extract ST/AI-Card JSON from PNG (common keywords: "chara", sometimes "character")
function readPngCardJSON(pngFile) {
  try {
    const buf = fs.readFileSync(pngFile);
    const chunks = parsePngTextChunks(buf);

    // Search likely keys first
    const preferredKeys = ['chara', 'character', 'ai_character', 'json', 'profile'];
    for (const key of preferredKeys) {
      const hit = chunks.find(c => c.keyword.toLowerCase() === key);
      if (hit && hit.text) {
        const text = hit.text.trim();
        try { return JSON.parse(text); } catch { /* fallthrough */ }
      }
    }

    // Otherwise try any chunk that parses as JSON
    for (const c of chunks) {
      try { return JSON.parse(c.text); } catch {}
    }
  } catch {}
  return null;
}

// ======= Characters (PNG + JSON) =======
app.get('/characters', (req, res) => {
  const jsonFiles = listFiles(CH_DIR, ['.json']);
  const pngFiles  = listFiles(CH_DIR, ['.png']);

  const list = [];

  // JSON cards
  for (const f of jsonFiles) {
    const j = readJSONSafe(path.join(CH_DIR, f)) || {};
    list.push({
      id: f,
      kind: 'json',
      name: j.name || j.data?.name || path.basename(f, '.json'),
      tags: j.tags || j.data?.tags || [],
      description: j.description || j.data?.description || '',
      avatar: j.avatar || j.data?.avatar || j.profile_picture
        ? `/assets/avatars/${j.avatar || j.data?.avatar || j.profile_picture}`
        : null
    });
  }

  // PNG cards
  for (const f of pngFiles) {
    const full = path.join(CH_DIR, f);
    const j = readPngCardJSON(full) || {};
    list.push({
      id: f,
      kind: 'png',
      name: j.name || j.data?.name || path.basename(f, '.png'),
      tags: j.tags || j.data?.tags || [],
      description: j.description || j.data?.description || '',
      avatar: `/assets/characters/${f}` // use the card image as avatar preview
    });
  }

  // Sort by name for sanity
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json(list);
});

app.get('/characters/:id', (req, res) => {
  const id = req.params.id;
  const jsonPath = path.join(CH_DIR, id);
  const pngPath  = path.join(CH_DIR, id);

  // prevent path traversal
  if (!jsonPath.startsWith(CH_DIR) || !pngPath.startsWith(CH_DIR)) {
    return res.status(400).send('Bad path');
  }

  if (fs.existsSync(jsonPath) && id.toLowerCase().endsWith('.json')) {
    const j = readJSONSafe(jsonPath);
    if (!j) return res.status(500).send('Bad JSON');
    return res.json(j);
  }

  if (fs.existsSync(pngPath) && id.toLowerCase().endsWith('.png')) {
    const j = readPngCardJSON(pngPath);
    if (!j) return res.status(404).send('No embedded JSON in PNG');
    return res.json(j);
  }

  return res.status(404).send('Not found');
});
function getCharSummaryByFile(fileName) {
  // returns { id, name, avatar, kind } from characters/<file>
  const lower = fileName.toLowerCase();
  const full = path.join(CH_DIR, fileName);
  if (!full.startsWith(CH_DIR) || !fs.existsSync(full)) return null;

  if (lower.endsWith('.json')) {
    const j = readJSONSafe(full) || {};
    return {
      id: fileName,
      kind: 'json',
      name: j.name || j.data?.name || path.basename(fileName, '.json'),
      avatar: j.avatar || j.data?.avatar || j.profile_picture
        ? `/assets/avatars/${j.avatar || j.data?.avatar || j.profile_picture}`
        : null,
    };
  }

  if (lower.endsWith('.png')) {
    const j = readPngCardJSON(full) || {};
    return {
      id: fileName,
      kind: 'png',
      name: j.name || j.data?.name || path.basename(fileName, '.png'),
      avatar: `/assets/characters/${fileName}`,
    };
  }

  return null;
}

function coerceEntries(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object') return Object.values(obj); // handles {"0":{...}}
  return [];
}

function getTriggerKeys(e) {
  return (e.keys || e.key || e.keywords || e.triggers || []);
}

// Attempt to resolve a group avatar path like "img/ai4.png"
function resolveAssetPath(rel) {
  if (!rel) return null;
  const cand = path.join(ST_DATA, rel);
  if (fs.existsSync(cand)) return '/assets/' + rel.replace(/\\/g,'/');
  const inGroups = path.join(GROUPS_DIR, rel);
  if (fs.existsSync(inGroups)) {
    const sub = path.relative(ST_DATA, inGroups).replace(/\\/g,'/');
    return '/assets/' + sub;
  }

  return null;
}

// ======= Lorebooks from worlds/ =======
const WORLDS_DIR = path.join(ST_DATA, 'worlds');

function summarizeLorebook(id, displayName, j) {
  const entries = coerceEntries(j?.entries) || coerceEntries(j?.lorebook?.entries);
  const sample = [];
  for (const e of entries.slice(0, 3)) {
    const k = getTriggerKeys(e);
    if (Array.isArray(k)) {
      for (const s of k) { if (sample.length < 10) sample.push(s); else break; }
    }

    if (sample.length >= 10) break;
  }

  return {
    id,
    name: j?.name || displayName || id,
    entries: entries.length || 0,
    keys: sample
  };
}

function findLorebooksInWorlds() {
  const out = [];
  if (!fs.existsSync(WORLDS_DIR)) return out;

  // A) worlds/<WorldName>.json
  for (const f of fs.readdirSync(WORLDS_DIR).filter(x => x.toLowerCase().endsWith('.json'))) {
    const full = path.join(WORLDS_DIR, f);
    const j = readJSONSafe(full);
    if (!j) { console.warn('[MP] Bad lorebook JSON (file):', full); continue; }
    out.push(summarizeLorebook(path.basename(f, '.json'), path.basename(f, '.json'), j));
  }

  // B) worlds/<WorldName>/lorebook.json
  for (const d of fs.readdirSync(WORLDS_DIR, { withFileTypes: true }).filter(x => x.isDirectory())) {
    const lb = path.join(WORLDS_DIR, d.name, 'lorebook.json');
    if (!fs.existsSync(lb)) continue;
    const j = readJSONSafe(lb);
    if (!j) { console.warn('[MP] Bad lorebook JSON (dir):', lb); continue; }
    out.push(summarizeLorebook(d.name, d.name, j));
  }

  return out;
}

app.get('/lorebooks', (req, res) => {
  res.json(findLorebooksInWorlds());
});

app.get('/lorebooks/:id', (req, res) => {
  const byFile = path.join(WORLDS_DIR, req.params.id + '.json');
  const byDir  = path.join(WORLDS_DIR, req.params.id, 'lorebook.json');

  if (!byFile.startsWith(WORLDS_DIR) || !byDir.startsWith(WORLDS_DIR))
    return res.status(400).send('Bad path');

  const pick = fs.existsSync(byFile) ? byFile : (fs.existsSync(byDir) ? byDir : null);
  if (!pick) return res.status(404).send('Not found');

  const j = readJSONSafe(pick);
  if (!j) return res.status(500).send('Bad JSON');

  const entries = coerceEntries(j.entries) || coerceEntries(j.lorebook?.entries);
  // Normalize triggers to `keys` for the client
  const norm = entries.map(e => ({
    ...e,
    keys: getTriggerKeys(e),
  }));

  return res.json({ ...j, entries: norm });
});

// ======= Groups =======
function listGroupFiles() {
  try { return fs.readdirSync(GROUPS_DIR).filter(f => f.toLowerCase().endsWith('.json')); }
  catch { return []; }
}

const SETTINGS_FILE = path.join(ST_DATA, 'settings.json');

app.get('/personas', (req, res) => {
  const settings = readJSONSafe(SETTINGS_FILE) || {};
  const map = settings.power_user?.personas || {};
  const names = Object.values(map).filter(Boolean).sort((a,b)=>a.localeCompare(b));
  res.json(names);
});

app.get('/groups', (req, res) => {
  const files = listGroupFiles();
  const out = files.map(f => {
    const j = readJSONSafe(path.join(GROUPS_DIR, f)) || {};
    return {
      id: j.id || path.basename(f, '.json'),
      file: f,
      name: j.name || path.basename(f, '.json'),
      members: Array.isArray(j.members) ? j.members.length : 0,
      disabled: Array.isArray(j.disabled_members) ? j.disabled_members.length : 0,
      avatar: resolveAssetPath(j.avatar_url) || null,
      allow_self_responses: !!j.allow_self_responses,
      generation_mode: j.generation_mode ?? null,
    };
  });
  res.json(out);
});

app.get('/groups/:id', (req, res) => {
  // allow either group id or file name
  const byFile = path.join(GROUPS_DIR, req.params.id.endsWith('.json') ? req.params.id : req.params.id + '.json');
  let file = byFile;
  if (!fs.existsSync(file)) {
    // try find by matching "id" field
    const hit = listGroupFiles().find(f => {
      const j = readJSONSafe(path.join(GROUPS_DIR, f)) || {};
      return (j.id && j.id.toString() === req.params.id);
    });
    if (hit) file = path.join(GROUPS_DIR, hit);
  }

  if (!file.startsWith(GROUPS_DIR) || !fs.existsSync(file)) return res.status(404).send('Not found');

  const g = readJSONSafe(file) || {};
  const members = (g.members || []).map(getCharSummaryByFile).filter(Boolean);
  const disabled = new Set((g.disabled_members || []).map(x => x.toLowerCase()));

  // mark disabled
  members.forEach(m => { if (disabled.has(m.id.toLowerCase())) m.disabled = true; });

  res.json({
    id: g.id || path.basename(file, '.json'),
    name: g.name || path.basename(file, '.json'),
    avatar: resolveAssetPath(g.avatar_url) || null,
    allow_self_responses: !!g.allow_self_responses,
    activation_strategy: g.activation_strategy ?? null,
    generation_mode: g.generation_mode ?? null,
    chat_id: g.chat_id || null,
    members
  });
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
