import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(root, 'data');
const feedbackFile = path.join(dataDirectory, 'understanding-feedback.json');
const port = Number(process.env.PORT) || 3000;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

let feedbackRecords = null;
let saveQueue = Promise.resolve();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function loadFeedback() {
  if (feedbackRecords) return feedbackRecords;
  try {
    const stored = JSON.parse(await readFile(feedbackFile, 'utf8'));
    feedbackRecords = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    feedbackRecords = {};
  }
  return feedbackRecords;
}

function cleanPreview(value) {
  return value
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b\d+(?:[.:,-]\d+)*\b/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 12000) {
        reject(new Error('too_large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

async function recordFeedback(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === 'too_large' ? 413 : 400, { error: '올바른 피드백 내용을 보내 주세요.' });
    return;
  }

  const languages = new Set(['ko', 'en', 'zh-CN', 'vi', 'ne', 'tl', 'th']);
  const text = typeof payload.text === 'string' ? cleanPreview(payload.text) : '';
  if (!text || !languages.has(payload.language) || !['understood', 'difficult'].includes(payload.vote)) {
    sendJson(response, 400, { error: '피드백 내용을 확인해 주세요.' });
    return;
  }

  const hash = createHash('sha256').update(`${payload.language}\0${text}`).digest('hex');
  const records = await loadFeedback();
  const record = records[hash] || { text, language: payload.language, understood: 0, difficult: 0 };
  record[payload.vote] += 1;
  records[hash] = record;

  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${feedbackFile}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, feedbackFile);
  });
  try {
    await saveQueue;
    sendJson(response, 200, { ok: true, understood: record.understood, difficult: record.difficult });
  } catch {
    sendJson(response, 500, { error: '응답을 저장하지 못했어요. 다시 시도해 주세요.' });
  }
}

async function getFeedbackSummary(response) {
  try {
    const records = await loadFeedback();
    const entries = Object.values(records).sort((a, b) => (b.difficult + b.understood) - (a.difficult + a.understood));
    sendJson(response, 200, {
      total: entries.reduce((sum, entry) => sum + entry.difficult + entry.understood, 0),
      entries,
    });
  } catch {
    sendJson(response, 500, { error: '피드백 통계를 불러오지 못했어요.' });
  }
}

async function serveStatic(pathname, request, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: '잘못된 주소예요.' });
    return;
  }
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  if (relativePath.split(/[\\/]/).some(part => part.startsWith('.')) || relativePath === 'data' || relativePath.startsWith('data/')) {
    sendJson(response, 404, { error: '페이지를 찾을 수 없어요.' });
    return;
  }
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) || filePath.startsWith(`${dataDirectory}${path.sep}`)) {
    sendJson(response, 404, { error: '페이지를 찾을 수 없어요.' });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': content.length,
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      sendJson(response, 404, { error: '페이지를 찾을 수 없어요.' });
      return;
    }
    sendJson(response, 500, { error: '페이지를 불러오지 못했어요.' });
  }
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'POST' && url.pathname === '/api/feedback') {
      await recordFeedback(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/feedback/summary') {
      await getFeedbackSummary(response);
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(url.pathname, request, response);
      return;
    }
    sendJson(response, 405, { error: '지원하지 않는 요청이에요.' });
  } catch {
    if (!response.headersSent) sendJson(response, 500, { error: '요청을 처리하지 못했어요.' });
    else response.destroy();
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Easy disaster message app listening on ${port}`);
});
