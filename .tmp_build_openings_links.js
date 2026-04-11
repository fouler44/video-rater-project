const fs = require('fs');
const path = require('path');

const inputPath = String.raw`C:\Users\angel\AppData\Roaming\Code\User\workspaceStorage\72b7978bbc0d12b6b46b4dc3f49b7228\GitHub.copilot-chat\chat-session-resources\3c5dd3bb-8235-4e88-9d10-cceb6dab0334\call_RY5fUjdzibBMNowTTimZCHh0__vscode-1775704356811\content.json`;
const outputMd = path.join(process.cwd(), 'tmp_openings_youtube_links.md');
const outputTsv = path.join(process.cwd(), 'tmp_openings_youtube_links.tsv');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRowsFromContent(content) {
  const startTag = '<untrusted-data-';
  const startIdx = content.indexOf(startTag);
  if (startIdx === -1) throw new Error('No untrusted-data tag found');
  const startJson = content.indexOf('\n[', startIdx);
  const endJson = content.indexOf('\n</untrusted-data-', startJson);
  if (startJson === -1 || endJson === -1) throw new Error('Could not locate JSON payload');
  const jsonText = content.slice(startJson + 1, endJson).trim();
  return JSON.parse(jsonText);
}

function cleanSongTitle(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  s = s.replace(/^R\d+\s*:\s*/i, '').trim();

  if (/^OP\s*\d+$/i.test(s)) return '';

  const quoted = s.match(/["“](.+?)["”]\s*(?:by\b|$)/i);
  if (quoted && quoted[1]) {
    s = quoted[1].trim();
  } else {
    const bySplit = s.split(/\s+by\s+/i);
    s = (bySplit[0] || s).trim();
  }

  s = s.replace(/\s*\(eps[^)]*\)\s*$/i, '').trim();
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function getOpIndex(label) {
  const m = String(label || '').trim().match(/^OP\s*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

async function fetchAnimeData(animeId) {
  const url = `https://api.jikan.moe/v4/anime/${animeId}/full`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.status === 429) {
        await sleep(700 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json?.data || {};
      const english = d.title_english || d.title || '';
      const openings = Array.isArray(d?.theme?.openings) ? d.theme.openings : [];
      return { english, openings };
    } catch (e) {
      if (attempt === 5) {
        return { english: '', openings: [] };
      }
      await sleep(500 * attempt);
    }
  }
  return { english: '', openings: [] };
}

(async () => {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const contentObj = JSON.parse(raw);
  const rows = parseRowsFromContent(contentObj.result)
    .sort((a, b) => Number(a.order_index) - Number(b.order_index));

  const uniqueAnimeIds = [...new Set(rows.map(r => Number(r.anime_id)).filter(Number.isFinite))];

  const animeMap = new Map();
  for (let i = 0; i < uniqueAnimeIds.length; i++) {
    const animeId = uniqueAnimeIds[i];
    const data = await fetchAnimeData(animeId);
    animeMap.set(animeId, data);
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`Fetched ${i + 1}/${uniqueAnimeIds.length} anime from Jikan...\n`);
    }
    await sleep(220);
  }

  const out = [];
  for (const row of rows) {
    const animeId = Number(row.anime_id);
    const info = animeMap.get(animeId) || { english: '', openings: [] };
    const animeTitleEnglish = (info.english || row.anime_title || '').trim();

    let songTitle = cleanSongTitle(row.opening_label);
    const opIndex = getOpIndex(row.opening_label);
    if (!songTitle && opIndex && Array.isArray(info.openings) && info.openings.length >= opIndex) {
      songTitle = cleanSongTitle(info.openings[opIndex - 1]);
    }
    if (!songTitle && Array.isArray(info.openings) && info.openings.length > 0) {
      songTitle = cleanSongTitle(info.openings[0]);
    }
    if (!songTitle) songTitle = String(row.opening_label || '').trim();

    const query = `${animeTitleEnglish} ${songTitle} uhd`;
    const youtubeSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    out.push({
      order_index: Number(row.order_index),
      anime_title: animeTitleEnglish,
      opening_label: songTitle,
      youtube_search_url: youtubeSearchUrl,
    });
  }

  const mdLines = [];
  mdLines.push('| order_index | anime_title | opening_label | youtube_search |');
  mdLines.push('|---:|---|---|---|');
  for (const r of out) {
    const t = String(r.anime_title).replace(/\|/g, '\\|');
    const o = String(r.opening_label).replace(/\|/g, '\\|');
    mdLines.push(`| ${r.order_index} | ${t} | ${o} | [YouTube](<${r.youtube_search_url}>) |`);
  }

  const tsvLines = [];
  tsvLines.push('order_index\tanime_title\topening_label\tyoutube_search_url');
  for (const r of out) {
    const safe = [r.order_index, r.anime_title, r.opening_label, r.youtube_search_url]
      .map(v => String(v).replace(/[\t\r\n]+/g, ' ').trim());
    tsvLines.push(safe.join('\t'));
  }

  fs.writeFileSync(outputMd, mdLines.join('\n'), 'utf8');
  fs.writeFileSync(outputTsv, tsvLines.join('\n'), 'utf8');

  console.log(`DONE\nRows: ${out.length}\nMD: ${outputMd}\nTSV: ${outputTsv}`);
})();
