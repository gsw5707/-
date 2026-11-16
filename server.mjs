import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(root, 'data');
const feedbackFile = path.join(dataDirectory, 'understanding-feedback.json');
const coreValidationFile = path.join(dataDirectory, 'core-info-validation.json');
const disasterSource = 'https://www.safetydata.go.kr/disaster-data/disasterNotification';
const localDataOrigin = 'https://file.localdata.go.kr';
const publicFacilityOrigin = 'https://life.ttpk.co.kr';
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
let coreValidationRecords = null;
let coreValidationSaveQueue = Promise.resolve();
const siteTranslationMemory = new Map();
const knownRegions = new Set();
const civilShelterCache = new Map();
const nonLocalAgencyWords = /(?:한국도로공사|한국철도공사|공항철도|경찰청|경찰서|소방서|소방본부|소방재난본부|산불방지대책본부|산림청|산림항공본부|행정안전부|국토교통부|기상청|해양경찰청|해경|군부대|공군|육군|해군|교육청|농어촌공사|공단|보건소|병원|문화재단|전력공사|한전|가스공사)/;
const nonRegionPhrases = /(?:하시|주시|주십시|받으시|바라시|발생시|사용시|입산시|운행시|보행시|이동시|대피시|우천시|강우시|강설시|점검시|필요시|도착시|신고시|통제시|지속시|우리군|누수복구)$/;

function extractMessageRegion(message) {
  const body = String(message).replace(/\s*\[[^\]]+\]\s*$/, '').replace(/20\d{2}[/.\-]\d{1,2}[/.\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g, ' ');
  const hazardAt = body.search(/(?:산불|산사태|호우|폭염|한파|대설|강풍|태풍|침수|화재|지진|범람|대피|실종|발생|주의보|경보|통제)/);
  const locationBody = hazardAt >= 0 ? body.slice(0, Math.min(body.length, hazardAt + 90)) : body.slice(0, 150);
  const candidates = [];
  const official = /(?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|제주특별자치도|전북특별자치도|강원특별자치도|경기도|충청북도|충청남도|전라남도|경상북도|경상남도|[가-힣]{2,}(?:시|군|구))/g;
  for (const match of locationBody.matchAll(official)) {
    const value = match[0];
    const following = locationBody.slice(match.index + value.length, match.index + value.length + 3);
    if (nonLocalAgencyWords.test(value) || nonRegionPhrases.test(value) || /청$/.test(value) || /(?:청|공사|공단|본부|경찰서|소방서)/.test(following)) continue;
    if (!/^(?:\s|[,，.。·:;()[\]\/]|은|는|이|가|을|를|에|에서|으로|로|과|와|민|전체|전역|일대|인근|지역|주민|호우|산불|한파|폭염|대설|강풍|태풍|침수|화재|지진|범람|대피|실종|통제|주의보|경보|예보|상황|예상)/.test(following)) continue;
    const isProvince = /(?:특별자치도|특별시|광역시|도)$/.test(value);
    candidates.push({ value, score: match.index + (isProvince ? 0 : 1000) });
  }
  const regionFirst = locationBody.match(/([가-힣]{2,}(?:시|군|구))\s+[^.。]{0,40}?(?:지역|전역|일대|인근)/);
  if (regionFirst && !nonLocalAgencyWords.test(regionFirst[1]) && !nonRegionPhrases.test(regionFirst[1])) candidates.push({ value: regionFirst[1], score: 1200 });
  const directional = locationBody.match(/([가-힣]{2,}(?:시|군)?\s*(?:동부|서부|남부|북부|동북부|서북부|남부지역|북부지역))/);
  if (directional && !nonLocalAgencyWords.test(directional[1]) && !nonRegionPhrases.test(directional[1])) candidates.push({ value: directional[1].replace(/\s+/g, ''), score: 1300 });
  const specific = candidates.filter(item => !/(?:특별자치도|특별시|광역시|도)$/.test(item.value)).sort((a, b) => b.score - a.score)[0];
  const region = specific?.value || candidates.sort((a, b) => b.score - a.score)[0]?.value;
  return region || '전국';
}

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

async function loadCoreValidationRecords() {
  if (coreValidationRecords) return coreValidationRecords;
  try {
    const stored = JSON.parse(await readFile(coreValidationFile, 'utf8'));
    coreValidationRecords = Array.isArray(stored) ? stored : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    coreValidationRecords = [];
    await saveCoreValidationRecords(coreValidationRecords);
  }
  return coreValidationRecords;
}

function normalizeCoreValidationRecord(payload, existing = null) {
  const checks = {};
  for (const key of ['target', 'place', 'time', 'number', 'risk', 'action', 'prohibition']) {
    const value = payload.checks?.[key];
    checks[key] = ['○', '△', '✕'].includes(value) ? value : '';
  }
  const judgment = ['review', 'pass', 'error'].includes(payload.judgment) ? payload.judgment : '';
  const recheckStatus = ['pending', 'pass', 'error'].includes(payload.recheckStatus) ? payload.recheckStatus : '';
  const text = value => typeof value === 'string' ? value.trim().slice(0, 10000) : '';
  return {
    id: existing?.id || randomUUID(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disasterType: text(payload.disasterType).slice(0, 80),
    original: text(payload.original),
    simplified: text(payload.simplified),
    checks,
    judgment,
    correctionBefore: text(payload.correctionBefore),
    correctionAfter: text(payload.correctionAfter),
    recheckStatus,
    recheckResult: text(payload.recheckResult),
  };
}

function saveCoreValidationRecords(records) {
  coreValidationSaveQueue = coreValidationSaveQueue.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${coreValidationFile}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, coreValidationFile);
  });
  return coreValidationSaveQueue;
}

async function handleCoreValidation(request, response, url) {
  const records = await loadCoreValidationRecords();
  if (request.method === 'GET' && url.pathname === '/api/core-info-validation') {
    sendJson(response, 200, { records });
    return;
  }
  if (request.method === 'DELETE') {
    const match = url.pathname.match(/^\/api\/core-info-validation\/([\w-]+)$/);
    const index = match ? records.findIndex(record => record.id === match[1]) : -1;
    if (index < 0) {
      sendJson(response, 404, { error: '검증 기록을 찾을 수 없어요.' });
      return;
    }
    records.splice(index, 1);
    await saveCoreValidationRecords(records);
    sendJson(response, 200, { ok: true });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === 'too_large' ? 413 : 400, { error: '검증 기록을 읽지 못했어요.' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/core-info-validation') {
    const record = normalizeCoreValidationRecord(payload);
    if (!record.disasterType || !record.original || !record.simplified) {
      sendJson(response, 400, { error: '재난 유형, 원문, 순화문을 입력해 주세요.' });
      return;
    }
    records.push(record);
    await saveCoreValidationRecords(records);
    sendJson(response, 201, { record });
    return;
  }
  const match = url.pathname.match(/^\/api\/core-info-validation\/([\w-]+)$/);
  if (!match) {
    sendJson(response, 404, { error: '검증 기록을 찾을 수 없어요.' });
    return;
  }
  const index = records.findIndex(record => record.id === match[1]);
  if (index < 0) {
    sendJson(response, 404, { error: '검증 기록을 찾을 수 없어요.' });
    return;
  }
  if (request.method === 'PATCH') {
    const updated = normalizeCoreValidationRecord(payload, records[index]);
    if (!updated.disasterType || !updated.original || !updated.simplified) {
      sendJson(response, 400, { error: '재난 유형, 원문, 순화문을 입력해 주세요.' });
      return;
    }
    records[index] = updated;
    await saveCoreValidationRecords(records);
    sendJson(response, 200, { record: updated });
    return;
  }
  sendJson(response, 405, { error: '지원하지 않는 요청이에요.' });
}

function cleanPreview(value) {
  let text = value
    .replace(/실종(?:된)?\s*[^.。]{0,50}?(?:찾습니다|찾고 있습니다)/g, '실종자 수색 안내 (개인정보 제외)')
    .replace(/\b(?:01[016789]|0[2-6][1-5])[-. ]?\d{3,4}[-. ]?\d{4}\b/g, ' ')
    .replace(/\b\d{6}-[1-4]\d{6}\b/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/([동리읍면])\s*\d{1,5}(?:-\d{1,5})?/g, '$1')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (/실종자 수색 안내 \(개인정보 제외\)/.test(text)) text = '실종자 수색 안내 (개인정보 제외)';
  return text;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 50000) {
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

function decodeHtml(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function getKoreanDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDisasterRows(html) {
  const entries = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const row = rowMatch[1];
    const number = row.match(/<td[^>]*class="cell-no"[^>]*>([\s\S]*?)<\/td>/i)?.[1];
    const subject = row.match(/<td[^>]*class="[^"]*cell-subject[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const createdAt = row.match(/<td[^>]*class="cell-date"[^>]*>([\s\S]*?)<\/td>/i)?.[1];
    if (!number || !subject || !createdAt) continue;
    const message = decodeHtml(subject[2]);
    const agency = message.match(/\[([^\]]+)\]\s*$/)?.[1]?.trim() || '';
    const region = extractMessageRegion(message);
    knownRegions.add(region);
    entries.push({
      id: decodeHtml(number),
      region,
      createdAt: decodeHtml(createdAt),
      agency,
      message,
      sourceUrl: new URL(subject[1], 'https://www.safetydata.go.kr').toString(),
    });
  }
  return entries;
}

async function getDisasterMessages(url, response) {
  const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
  const pageSize = Math.max(10, Math.min(50, Number(url.searchParams.get('pageSize')) || 50));
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const keyword = (url.searchParams.get('keyword') || '').trim().slice(0, 80);
  const region = (url.searchParams.get('region') || '').trim().slice(0, 80);
  const endDate = getKoreanDate(new Date());
  const startDate = getKoreanDate(new Date(Date.now() - (days - 1) * 86400000));
  const sourceKeyword = region && region !== '전국' ? region : keyword;
  const sourceUrl = new URL(disasterSource);
  sourceUrl.searchParams.set('currentPage', String(page));
  sourceUrl.searchParams.set('cntPerPage', String(pageSize));
  sourceUrl.searchParams.set('pageSize', String(pageSize));
  sourceUrl.searchParams.set('searchStartDttm', startDate);
  sourceUrl.searchParams.set('searchEndDttm', endDate);
  sourceUrl.searchParams.set('keyword', sourceKeyword);

  try {
    const upstream = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DisasterMessageReader/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) {
      sendJson(response, 502, { error: '공식 재난문자 목록에 연결하지 못했어요.' });
      return;
    }
    const html = await upstream.text();
    const matchTotal = html.match(/<span[^>]*>([\d,]+)<\/span>\s*건의 게시물이 검색되었습니다/);
    const sourceTotal = Number((matchTotal?.[1] || '0').replace(/,/g, ''));
    let items = parseDisasterRows(html);
    if (region && region !== '전국') items = items.filter(item => item.region === region && (!keyword || item.message.includes(keyword)));
    else if (keyword) items = items.filter(item => item.message.includes(keyword));
    const regionCounts = {};
    items.forEach(item => { regionCounts[item.region] = (regionCounts[item.region] || 0) + 1; });
    const totalCount = region && region !== '전국' || keyword ? items.length : sourceTotal;
    const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    sendJson(response, 200, {
      page,
      pageSize,
      pageCount,
      totalCount,
      nationalCount: sourceTotal,
      collectedCount: sourceTotal,
      complete: true,
      startDate,
      endDate,
      regions: [...knownRegions].sort((a, b) => a.localeCompare(b, 'ko')),
      regionCounts,
      items,
    });
  } catch {
    sendJson(response, 502, { error: '공식 재난문자 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); value = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function getProvince(latitude, longitude, area = '') {
  const byName = [
    ['서울특별시', '6110000'], ['부산광역시', '6260000'], ['대구광역시', '6270000'],
    ['인천광역시', '6280000'], ['전남광주통합특별시', '6130000'], ['광주광역시', '6290000'],
    ['대전광역시', '6300000'], ['울산광역시', '6310000'], ['세종특별자치시', '5690000'],
    ['경기도', '6410000'], ['강원특별자치도', '6530000'], ['강원도', '6530000'],
    ['충청북도', '6430000'], ['충청남도', '6440000'], ['전북특별자치도', '6540000'],
    ['전라북도', '6540000'], ['전라남도', '6460000'], ['경상북도', '6470000'],
    ['경상남도', '6480000'], ['제주특별자치도', '6500000'],
  ];
  const named = byName.find(([name]) => area.includes(name));
  if (named) return named[1];
  const bounds = [
    ['6110000', 37.4, 37.72, 126.75, 127.22], ['6280000', 36.9, 37.95, 124.4, 126.8],
    ['6260000', 34.8, 35.45, 128.7, 129.35], ['6270000', 35.58, 36.05, 128.3, 128.9],
    ['6290000', 35.0, 35.3, 126.6, 127.0], ['6300000', 36.2, 36.5, 127.2, 127.5],
    ['6310000', 35.3, 35.75, 128.95, 129.5], ['5690000', 36.4, 36.7, 127.1, 127.4],
    ['6500000', 32.9, 33.7, 125.9, 127.0], ['6530000', 37.0, 38.65, 127.4, 129.6],
    ['6430000', 36.0, 37.25, 127.3, 128.7], ['6440000', 35.8, 37.1, 125.8, 127.5],
    ['6540000', 35.2, 36.2, 126.3, 127.9], ['6460000', 34.0, 35.5, 125.0, 127.7],
    ['6470000', 35.5, 37.3, 128.0, 130.0], ['6480000', 34.5, 36.1, 127.5, 129.5],
    ['6410000', 36.8, 38.3, 126.3, 127.9], ['6410000', 35.9, 37.2, 127.5, 128.6],
  ];
  return bounds.find(([, south, north, west, east]) => latitude >= south && latitude <= north && longitude >= west && longitude <= east)?.[0] || '6410000';
}

async function downloadCivilShelters(orgCode) {
  if (civilShelterCache.has(orgCode)) return civilShelterCache.get(orgCode);
  const promise = (async () => {
    const headers = { 'Referer': 'https://www.data.go.kr/data/15044951/fileData.do', 'User-Agent': 'Mozilla/5.0' };
    const landing = await fetch(`${localDataOrigin}/file/civil_defense_shelter_info/info`, { headers, signal: AbortSignal.timeout(20000) });
    if (!landing.ok) throw new Error('공개 민방위 시설 자료에 연결하지 못했어요.');
    const cookies = landing.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const download = await fetch(`${localDataOrigin}/file/download/civil_defense_shelter_info/info?orgCode=${orgCode}_ALL`, {
      headers: { ...headers, Cookie: cookies },
      signal: AbortSignal.timeout(30000),
    });
    if (!download.ok) throw new Error('민방위 시설 공개 파일을 내려받지 못했어요.');
    const text = new TextDecoder('euc-kr').decode(await download.arrayBuffer());
    const [header = [], ...rows] = csvRows(text);
    const columns = new Map(header.map((name, index) => [name.replace(/^\uFEFF/, '').trim(), index]));
    const value = (row, name) => row[columns.get(name)]?.trim() || '';
    const facilities = rows.map(row => ({
      id: value(row, '관리번호'),
      name: value(row, '시설명'),
      address: value(row, '도로명전체주소') || value(row, '소재지전체주소'),
      lat: Number(value(row, '위도(EPSG4326)')),
      lon: Number(value(row, '경도(EPSG4326)')),
      floor: value(row, '시설위치(지상/지하)'),
      capacity: Number(value(row, '최대수용인원')) || null,
      statusLabel: value(row, '운영상태'),
      kindLabel: '민방위 대피시설',
    })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon) && item.name && !/해제|폐지/.test(item.statusLabel));
    return facilities;
  })();
  civilShelterCache.set(orgCode, promise);
  try { return await promise; }
  catch (error) { civilShelterCache.delete(orgCode); throw error; }
}

async function getNearbyShelters(url, response, samples = false) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radiusKm = Math.max(1, Math.min(30, Number(url.searchParams.get('radiusKm')) || 8));
  const type = samples ? url.searchParams.get('type') : 'civil';
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    sendJson(response, 400, { error: '현재 위치나 지도 위치를 확인해 주세요.' });
    return;
  }
  try {
    let facilities;
    let sourceUrl;
    let scopeLabel;
    if (type === 'tsunami') {
      const data = JSON.parse(await readFile(path.join(root, 'tsunami-shelters.json'), 'utf8'));
      facilities = data.items.map(item => ({ ...item, kindLabel: '지진해일 긴급대피장소' }));
      sourceUrl = data.sourceUrl;
      scopeLabel = `전국 지진해일 긴급대피장소 · ${facilities.length}곳`;
    } else if (type === 'civil') {
      const orgCode = getProvince(lat, lon, url.searchParams.get('area') || '');
      facilities = await downloadCivilShelters(orgCode);
      sourceUrl = 'https://www.data.go.kr/data/15044951/fileData.do';
      scopeLabel = '전국 행정안전부 민방위 대피시설';
    } else {
      const slugByType = { earthquake: 'shelter-eq', heat: 'shelter-heat', cold: 'shelter-cold' };
      const slug = slugByType[type];
      if (!slug) {
        sendJson(response, 400, { error: '해당 재난의 공개 대피소 자료를 찾지 못했어요.' });
        return;
      }
      const latitudeDelta = radiusKm * 1.4 / 111;
      const longitudeDelta = radiusKm * 1.4 / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      const params = new URLSearchParams({
        swLat: String(lat - latitudeDelta), swLng: String(lon - longitudeDelta),
        neLat: String(lat + latitudeDelta), neLng: String(lon + longitudeDelta),
      });
      const upstream = await fetch(`${publicFacilityOrigin}/${slug}/api/in-bounds?${params}`, {
        headers: { 'Referer': `${publicFacilityOrigin}/${slug}/map`, 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000),
      });
      const data = await upstream.json();
      if (!upstream.ok || !data.success || !Array.isArray(data.data)) throw new Error('전국 공개 대피시설을 불러오지 못했어요.');
      facilities = data.data.map(item => ({
        id: item._id,
        name: item._name,
        address: item._addr || item._address || '',
        lat: Number(item.lat),
        lon: Number(item.lng),
        kindLabel: type === 'earthquake' ? '지진 옥외대피장소' : type === 'heat' ? '무더위쉼터' : '한파쉼터',
        statusLabel: item._status || '',
      })).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
      sourceUrl = `${publicFacilityOrigin}/${slug}/map`;
      scopeLabel = type === 'earthquake' ? '전국 지진 옥외대피장소' : type === 'heat' ? '전국 무더위쉼터' : '전국 한파쉼터';
    }

    const items = facilities.map(item => ({
      ...item,
      distanceKm: distanceKm({ lat, lon }, { lat: item.lat, lon: item.lon }),
    })).filter(item => item.distanceKm <= radiusKm).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 60);
    const regions = [...new Set(facilities.map(item => item.address.match(/^(.*?(?:특별자치도|특별자치시|광역시|특별시|도|시|군|구))/)?.[1]).filter(Boolean))];
    sendJson(response, 200, {
      items,
      sampleCount: facilities.length,
      regionName: regions.find(region => (url.searchParams.get('area') || '').includes(region)) || regions[0] || '전국 공개목록',
      scopeLabel,
      sourceUrl,
      temporary: false,
    });
  } catch (error) {
    sendJson(response, 502, { error: error.message || '공개 대피시설을 불러오지 못했어요.' });
  }
}

async function getDirections(url, response) {
  const originLat = Number(url.searchParams.get('originLat'));
  const originLon = Number(url.searchParams.get('originLon'));
  const destLat = Number(url.searchParams.get('destLat'));
  const destLon = Number(url.searchParams.get('destLon'));
  const mode = url.searchParams.get('mode') === 'driving' ? 'driving' : 'foot';
  if (![originLat, originLon, destLat, destLon].every(Number.isFinite)) {
    sendJson(response, 400, { error: '현재 위치와 대피소 위치를 확인해 주세요.' });
    return;
  }
  const profile = mode === 'foot' ? 'https://routing.openstreetmap.de/routed-foot/route/v1/foot' : 'https://router.project-osrm.org/route/v1/driving';
  const routeUrl = `${profile}/${originLon},${originLat};${destLon},${destLat}?overview=full&steps=true&geometries=geojson`;
  try {
    const upstream = await fetch(routeUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EasyDisasterMap/1.0)' }, signal: AbortSignal.timeout(20000) });
    const data = await upstream.json();
    const route = data.routes?.[0];
    if (!upstream.ok || data.code !== 'Ok' || !route) {
      sendJson(response, 404, { error: '이 위치 사이의 길을 찾지 못했어요. 다른 대피소를 선택해 주세요.' });
      return;
    }
    const steps = (route.legs || []).flatMap(leg => leg.steps || []).map(step => {
      const maneuver = step.maneuver || {};
      const direction = maneuver.modifier === 'left' ? '왼쪽으로' : maneuver.modifier === 'right' ? '오른쪽으로' : maneuver.modifier?.includes('left') ? '왼쪽으로' : maneuver.modifier?.includes('right') ? '오른쪽으로' : '';
      const instruction = maneuver.type === 'depart' ? '출발하세요' : maneuver.type === 'arrive' ? '목적지에 도착했어요' : maneuver.type === 'turn' ? `${direction || '앞으로'} 가세요` : maneuver.type === 'roundabout' || maneuver.type === 'rotary' ? '회전교차로를 지나가세요' : maneuver.type === 'merge' ? '길에 합류하세요' : maneuver.type === 'fork' ? `${direction || '안내된 방향으로'} 가세요` : maneuver.type === 'continue' ? '계속 곧장 가세요' : '안내된 길을 따라가세요';
      const name = typeof step.name === 'string' ? step.name.trim() : '';
      return name ? `${name}에서 ${instruction}` : instruction;
    }).slice(0, 30);
    sendJson(response, 200, {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      coordinates: route.geometry.coordinates,
      steps,
      mode,
    });
  } catch {
    sendJson(response, 502, { error: '길 안내를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

function splitSpeechText(text, limit = 180) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = Math.max(...['。', '！', '？', '।', '.', '!', '?', ';', ',', '，', '、', ' '].map(separator => remaining.lastIndexOf(separator, limit)));
    if (splitAt < limit * 0.55) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function synthesizeSpeech(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === 'too_large' ? 413 : 400, { error: '읽을 내용을 확인해 주세요.' });
    return;
  }
  const language = payload.language;
  const text = typeof payload.text === 'string' ? payload.text.replace(/\s+/g, ' ').trim() : '';
  const voiceLocales = { ko: 'ko', en: 'en', 'zh-CN': 'zh-CN', vi: 'vi', ne: 'ne', tl: 'fil', th: 'th', ja: 'ja' };
  if (!voiceLocales[language] || !text || text.length > 2400) {
    sendJson(response, 400, { error: '지원하지 않는 음성 언어이거나 읽을 내용이 너무 길어요.' });
    return;
  }
  try {
  const chunks = splitSpeechText(text);
    const audioParts = [];
    for (const chunk of chunks) {
      const url = new URL('https://translate.google.com/translate_tts');
      url.searchParams.set('ie', 'UTF-8');
      url.searchParams.set('client', 'tw-ob');
      url.searchParams.set('tl', voiceLocales[language]);
      url.searchParams.set('q', chunk);
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) throw new Error('speech_unavailable');
      audioParts.push(Buffer.from(await upstream.arrayBuffer()));
    }
    const audio = Buffer.concat(audioParts);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': audio.length,
      'Content-Type': 'audio/mpeg',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(audio);
  } catch {
    sendJson(response, 502, { error: '음성을 만들지 못했어요. 다시 눌러 주세요.' });
  }
}

async function translateText(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === 'too_large' ? 413 : 400, { error: '번역할 내용을 확인해 주세요.' });
    return;
  }
  const languages = new Set(['ko', 'en', 'zh-CN', 'vi', 'ne', 'tl', 'th', 'ja']);
  const text = typeof payload.text === 'string' ? payload.text : '';
  const source = payload.source || 'ko';
  const target = payload.target;
  const cacheable = payload.cacheable === true;
  if (!text.trim() || text.length > 5000 || !languages.has(source) || !languages.has(target)) {
    sendJson(response, 400, { error: '번역할 내용이나 언어를 확인해 주세요.' });
    return;
  }
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      sendJson(response, 503, { error: '화면 번역 키가 아직 설정되지 않았어요.' });
      return;
    }
    const cacheKey = `${source}\0${target}\0${text}`;
    if (cacheable && siteTranslationMemory.has(cacheKey)) {
      const cached = siteTranslationMemory.get(cacheKey);
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify([[[cached, text, null, null]]]));
      return;
    }
    const languageNames = { ko: 'Korean', en: 'English', 'zh-CN': 'Simplified Chinese', vi: 'Vietnamese', ne: 'Nepali', tl: 'Filipino', th: 'Thai', ja: 'Japanese' };
    const prompt = `Translate the following ${languageNames[source]} text into ${languageNames[target]}. Output only natural ${languageNames[target]}; do not repeat the source text. Preserve all facts, place names, numbers, emergency stages, negations, and every ZZI18N marker. Do not summarize, omit, or change safety meaning.\n\n${text}`;
    let translatedText = '';
    let lastStatus = 502;
    const models = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const upstream = await fetch(modelUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: Math.max(512, Math.min(3072, text.length * 2)), temperature: 0, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
            }),
            signal: AbortSignal.timeout(25000),
          });
          if (!upstream.ok) { lastStatus = upstream.status; throw new Error(`gemini_${upstream.status}`); }
          const result = await upstream.json();
          const candidate = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || '';
          const hangulShare = (candidate.match(/[가-힣]/g) || []).length / Math.max(1, candidate.length);
          const containsRequiredScript = target === 'ne' ? /[\u0900-\u097F]/.test(candidate) : target === 'th' ? /[\u0E00-\u0E7F]/.test(candidate) : target === 'ja' ? /[\u3040-\u30FF]/.test(candidate) : target === 'zh-CN' ? /[\u4E00-\u9FFF]/.test(candidate) : true;
          if (candidate && (target === 'ko' || (hangulShare < 0.15 && containsRequiredScript))) { translatedText = candidate; break; }
          lastStatus = 502;
        } catch (error) {
          if (!error.name || error.name !== 'TimeoutError') lastStatus = Number(String(error.message).match(/gemini_(\d+)/)?.[1]) || lastStatus;
        }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (translatedText) break;
    }
    if (!translatedText) {
      sendJson(response, lastStatus === 429 ? 429 : 502, { error: '번역을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    const translated = [[[translatedText, text, null, null]]];
    if (cacheable) {
      siteTranslationMemory.set(cacheKey, translatedText);
      while (siteTranslationMemory.size > 6000) siteTranslationMemory.delete(siteTranslationMemory.keys().next().value);
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(translated));
  } catch (error) {
    sendJson(response, 502, { error: '번역을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

async function recordFeedback(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === 'too_large' ? 413 : 400, { error: '올바른 피드백 내용을 보내 주세요.' });
    return;
  }

  const languages = new Set(['ko', 'en', 'zh-CN', 'vi', 'ne', 'tl', 'th', 'ja']);
  const text = typeof payload.text === 'string' ? cleanPreview(payload.text) : '';
  if (!text || !languages.has(payload.language) || !['understood', 'difficult'].includes(payload.vote)) {
    sendJson(response, 400, { error: '피드백 내용을 확인해 주세요.' });
    return;
  }

  const hash = createHash('sha256').update(`${payload.language}\0${text}`).digest('hex');
  const records = await loadFeedback();
  const record = records[hash] || { text, language: payload.language, sourceVersion: 2, understood: 0, difficult: 0 };
  record.sourceVersion = 2;
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
      entries: entries.map(entry => ({ ...entry, sourceKind: entry.sourceVersion === 2 ? 'original' : 'legacy-simplified' })),
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
    if (url.pathname === '/api/core-info-validation' || url.pathname.startsWith('/api/core-info-validation/')) {
      if (['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
        await handleCoreValidation(request, response, url);
        return;
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/speech') {
      await synthesizeSpeech(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/translate') {
      await translateText(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/disaster-messages') {
      await getDisasterMessages(url, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/shelters') {
      await getNearbyShelters(url, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/shelter-samples') {
      await getNearbyShelters(url, response, true);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/directions') {
      await getDirections(url, response);
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
