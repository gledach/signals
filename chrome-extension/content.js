// Content script — runs on all pages.
// Extracts page text + selection for the side panel and AI classification.
// Site-specific extractors strip noise (nav, ads, sidebars) for cleaner AI input.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_TEXT') {
    const pageText = extractPageText();
    sendResponse({
      pageText,
      selectedText: window.getSelection()?.toString()?.trim() || '',
      url: location.href,
      title: document.title,
    });
    return true;
  }

  if (msg.type === 'GET_SELECTION') {
    sendResponse({
      selectedText: window.getSelection()?.toString()?.trim() || '',
    });
    return true;
  }
});

// ─── Site-specific extractors ───
// Each returns cleaned text or null to fall through to generic.

const siteExtractors = {
  'linkedin.com': extractLinkedIn,
  'twitter.com': extractTwitterX,
  'x.com': extractTwitterX,
  'github.com': extractGitHub,
};

function extractLinkedIn() {
  // Post / article detail page
  const post = document.querySelector('.feed-shared-update-v2__description') ||
               document.querySelector('.update-components-text') ||
               document.querySelector('[data-test-id="main-feed-activity-content"]');

  // LinkedIn article (Pulse / newsletter)
  const article = document.querySelector('.article-content') ||
                  document.querySelector('.reader-article-content');

  // Company page "About" section
  const about = document.querySelector('.org-top-card-summary-info-list') ||
                document.querySelector('.org-about-us-organization-description');

  // Profile page
  const profile = document.querySelector('.pv-top-card') ||
                  document.querySelector('.scaffold-layout__main');

  const target = article || post || about || profile;
  if (!target) return null;

  const clone = target.cloneNode(true);

  // Strip LinkedIn noise
  const junk = [
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
    'svg', 'iframe', 'img', 'video', 'button',
    // LinkedIn-specific junk
    '.feed-shared-social-actions',      // like/comment/share bar
    '.social-details-social-counts',    // "42 likes · 3 comments"
    '.feed-shared-actor__sub-description', // "promoted"
    '.artdeco-card__actions',           // card action buttons
    '.msg-overlay-list-bubble',         // messaging widget
    '.ad-banner-container',             // ads
    '.feed-shared-navigation',          // feed nav tabs
    '.global-nav',                      // top nav bar
    '.scaffold-layout__aside',          // right sidebar
    '.feed-follows-module',             // "people also viewed"
    '.feed-shared-update-v2__commentary--hide', // truncated "...see more"
    '[data-ad-banner]',                 // promoted posts
    '.premium-upsell',                  // premium upsell
    '.artdeco-modal',                   // modals
    '.share-box',                       // "start a post" box
  ];

  junk.forEach(sel => {
    try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
  });

  let text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > 30 ? text.slice(0, 6000) : null;
}

function extractTwitterX() {
  // Tweet detail
  const tweet = document.querySelector('[data-testid="tweetText"]');
  // Thread — multiple tweets
  const thread = document.querySelectorAll('[data-testid="tweetText"]');

  if (thread.length > 1) {
    const texts = [...thread].map(el => el.innerText?.trim()).filter(Boolean);
    const combined = texts.join('\n\n');
    return combined.length > 20 ? combined.slice(0, 6000) : null;
  }

  if (tweet) {
    const text = tweet.innerText?.trim();
    return text && text.length > 10 ? text.slice(0, 6000) : null;
  }

  return null;
}

function extractGitHub() {
  // README
  const readme = document.querySelector('#readme article') ||
                 document.querySelector('.markdown-body');
  // Issue / PR body
  const issue = document.querySelector('.js-comment-body') ||
                document.querySelector('.comment-body');
  // Repo description
  const desc = document.querySelector('.f4.my-3') ||
               document.querySelector('[itemprop="about"]');

  const target = readme || issue || desc;
  if (!target) return null;

  const clone = target.cloneNode(true);
  ['nav', 'header', 'footer', 'script', 'style', 'svg', 'img', 'video'].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });

  let text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > 20 ? text.slice(0, 6000) : null;
}

// ─── Main extractor ───

function extractPageText() {
  // Try site-specific extractor first
  const host = location.hostname.replace(/^www\./, '');
  for (const [domain, extractor] of Object.entries(siteExtractors)) {
    if (host === domain || host.endsWith('.' + domain)) {
      const result = extractor();
      if (result) return result;
    }
  }

  // Generic fallback
  const main = document.querySelector('article') ||
               document.querySelector('main') ||
               document.querySelector('[role="main"]') ||
               document.body;

  if (!main) return '';

  const clone = main.cloneNode(true);

  for (const tag of ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'svg', 'iframe', 'img', 'video']) {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  }

  let text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 6000);
}
