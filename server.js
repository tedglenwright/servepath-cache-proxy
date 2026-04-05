// server.js — ServePath Caching Proxy (Railway-Ready)
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { createServer } = require('http');

// Config — all from env vars (safe & Railway-friendly)
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SERVEPATH_API_KEY;
const API_URL = 'https://api.servepath.ai/v1/chat/completions';
const CACHE_DIR = process.env.CACHE_DIR 
  ? path.join(process.env.CACHE_DIR, 'cache') 
  : '/tmp/cache';

// Ensure cache dir exists
async function initCache() {
  try {
    await fs.access(CACHE_DIR);
  } catch {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    console.log(`✅ Cache directory created: ${CACHE_DIR}`);
  }
}

// Generate deterministic cache key
function getCacheKey(query) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ model: query.model, messages: query.messages }));
  return hash.digest('hex').slice(0, 16);
}

// Read cached response
async function getCachedResponse(cacheKey) {
  try {
    const data = await fs.readFile(path.join(CACHE_DIR, `${cacheKey}.json`), 'utf8');
    console.log(`⚡ Cache hit: ${cacheKey}`);
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

// Write to cache
async function saveToCache(cacheKey, response) {
  try {
    await fs.writeFile(
      path.join(CACHE_DIR, `${cacheKey}.json`),
      JSON.stringify(response, null, 2),
      'utf8'
    );
    console.log(`💾 Cached: ${cacheKey}`);
  } catch (e) {
    console.warn(`⚠️  Cache write failed:`, e.message);
  }
}

// Append model attribution to response content
function appendAttribution(response) {
  try {
    const resolved = response.servepath_resolved || response.model || 'unknown';
    if (response.choices && response.choices[0] && response.choices[0].message) {
      const content = response.choices[0].message.content;
      if (content && !content.includes('\u2014 ')) {
        response.choices[0].message.content = content + `\n\n\u2014 ${resolved}`;
      }
    }
  } catch(e) {}
  return response;
}

// Forward request to ServePath
function makeApiRequest(query, res) {
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ServePath-Cache-Proxy/1.0'
    }
  };

  const req = https.request(API_URL, options, (apiRes) => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'application/json',
      'X-Cache': 'MISS',
      'X-Proxy': 'servepath-cache-proxy'
    });

    apiRes.pipe(res);

    // Cache on 200 success only
    if (apiRes.statusCode === 200) {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', async () => {
        try {
          const json = appendAttribution(JSON.parse(body));
          const cacheKey = getCacheKey(query);
          await saveToCache(cacheKey, json);
          res.setHeader('X-Cache', 'MISS → STORED');
        } catch (e) {
          console.warn('⚠️  Failed to parse or cache response:', e.message);
        }
      });
    }
  });

  req.on('error', (e) => {
    console.error('❌ API request failed:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: upstream error');
  });

  req.write(JSON.stringify(query));
  req.end();
}

// HTTP server
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Parse incoming JSON
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const query = JSON.parse(body);

      // Validate required fields
      if (!API_KEY) {
        console.error('🚨 Missing SERVEPATH_API_KEY — aborting');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Error: SERVEPATH_API_KEY not configured');
        return;
      }

      if (!query.model || !Array.isArray(query.messages)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: model and messages required');
        return;
      }

      // Normalize bare model names — e.g. "all" → "servepath/all"
      if (query.model === 'all') query.model = 'servepath/all';
      if (query.model === 'servepath') query.model = 'servepath/all';
      console.log(`🔀 Model resolved: ${query.model}`);

      // Try cache first
      const cacheKey = getCacheKey(query);
      const cached = await getCachedResponse(cacheKey);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
          'X-Proxy': 'servepath-cache-proxy'
        });
        res.end(JSON.stringify(appendAttribution(cached)));
        return;
      }

      // Cache miss → forward to ServePath
      makeApiRequest(query, res);
    } catch (e) {
      console.error('💥 Request parsing error:', e.message);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: invalid JSON');
    }
  });
});

// Start server
initCache().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Cache proxy running on port ${PORT}`);
    console.log(`🔗 API endpoint: https://<your-railway-url>/v1/chat/completions`);
  });
}).catch(console.error);
