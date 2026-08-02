// Fetch recent uploads for a YouTube channel by scraping the channel page.
// Primary path for Signal — the RSS feed endpoint (feeds/videos.xml) is blocked
// by many corporate proxies. The channel HTML page loads fine and contains
// a JSON blob (`ytInitialData`) with the recent uploads grid.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25_000;

/**
 * @returns {Promise<Array<{videoId, title, link, pubDate: null, publishedRel, viewCountText}>>}
 */
export async function fetchChannelUploads(channelId, { limit = 30 } = {}) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
        'accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for channel page`);
    html = await res.text();
  } finally {
    clearTimeout(t);
  }

  return extractVideos(html, limit);
}

/**
 * Parse `ytInitialData` JSON from channel HTML, traverse to the videos grid,
 * return uploads. Falls back to regex scan if traversal fails.
 */
export function extractVideos(html, limit = 30) {
  const data = extractInitialData(html);

  // Happy path: structured traversal of ytInitialData.
  if (data) {
    const items = traverseVideosTab(data, limit);
    if (items.length) return items;
  }

  // Fallback: regex scan. Less reliable but survives structure changes.
  return regexVideoScan(html, limit);
}

function extractInitialData(html) {
  // YouTube injects: `var ytInitialData = {...};` before `</script>`.
  // Non-greedy up to the closing brace before `;<`.
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function traverseVideosTab(data, limit) {
  // Walk the entire tabs tree; multiple tab shapes can carry a video grid.
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const candidates = [
    ...tabs.filter((t) => t?.tabRenderer?.selected),
    ...tabs,
  ];
  for (const tab of candidates) {
    const items = harvestGridFromTab(tab?.tabRenderer?.content, limit);
    if (items.length) return items;
  }
  return [];
}

function harvestGridFromTab(content, limit) {
  if (!content) return [];
  const items = [];
  // 1. richGridRenderer (modern Videos tab)
  const grid = content?.richGridRenderer?.contents;
  if (Array.isArray(grid)) {
    for (const cell of grid) {
      const v = cell?.richItemRenderer?.content?.videoRenderer
        || cell?.videoRenderer;
      if (v?.videoId) items.push(renderToItem(v));
      if (items.length >= limit) return items;
    }
  }
  // 2. sectionListRenderer → itemSectionRenderer → gridRenderer (older layout)
  const sections = content?.sectionListRenderer?.contents || [];
  for (const section of sections) {
    const shelf = section?.itemSectionRenderer?.contents || [];
    for (const s of shelf) {
      const cells = s?.gridRenderer?.items
        || s?.shelfRenderer?.content?.horizontalListRenderer?.items
        || s?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items
        || [];
      for (const c of cells) {
        const v = c?.gridVideoRenderer || c?.videoRenderer;
        if (v?.videoId) items.push(renderToItem(v));
        if (items.length >= limit) return items;
      }
    }
  }
  return items;
}

function renderToItem(v) {
  const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
  const publishedRel = v.publishedTimeText?.simpleText || '';
  const viewCountText = v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '';
  return {
    videoId: v.videoId,
    title,
    link: `https://www.youtube.com/watch?v=${v.videoId}`,
    pubDate: null,
    publishedRel,
    viewCountText,
  };
}

function regexVideoScan(html, limit) {
  const items = [];
  const seen = new Set();
  // `[\s\S]{0,3000}?` is greedy-safe: spans nested braces (thumbnails etc.)
  // but won't escape the videoRenderer block.
  const re = /"videoRenderer":\s*\{[\s\S]{0,3000}?"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,3000}?"title":\s*\{[\s\S]{0,400}?(?:"runs":\[\{"text":"([^"\\]+)"|"simpleText":"([^"\\]+)")/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    items.push({
      videoId: m[1],
      title: (m[2] || m[3] || '').trim(),
      link: `https://www.youtube.com/watch?v=${m[1]}`,
      pubDate: null,
      publishedRel: '',
      viewCountText: '',
    });
    if (items.length >= limit) break;
  }
  // Last-ditch: just harvest distinct videoIds even if we can't pair with titles.
  if (!items.length) {
    const idRe = /"videoId":"([A-Za-z0-9_-]{11})"/g;
    while ((m = idRe.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      items.push({
        videoId: m[1],
        title: `(title unavailable) ${m[1]}`,
        link: `https://www.youtube.com/watch?v=${m[1]}`,
        pubDate: null,
        publishedRel: '',
        viewCountText: '',
      });
      if (items.length >= limit) break;
    }
  }
  return items;
}
