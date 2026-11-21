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
const civilShelterCache = new Map();
const disasterSearchCache = new Map();
const disasterRegionCountCache = new Map();
const disasterAllMessageCache = new Map();
const displayDisasterRegion = region => region === '전국' ? '기타' : region;
const nonLocalAgencyWords = /(?:한국도로공사|한국철도공사|공항철도|경찰청|경찰서|소방서|소방본부|소방재난본부|산불방지대책본부|산림청|산림항공본부|행정안전부|국토교통부|기상청|해양경찰청|해경|군부대|공군|육군|해군|교육청|농어촌공사|공단|보건소|병원|문화재단|전력공사|한전|가스공사)/;
const nonRegionPhrases = /(?:하시|주시|주십시|받으시|바라시|발생시|사용시|입산시|운행시|보행시|이동시|대피시|우천시|강우시|강설시|점검시|필요시|도착시|신고시|통제시|지속시|우리군|누수복구)$/;
// Names verified against Korea's 2026-10-01 administrative-dong boundaries.
const observedDisasterRegions = new Set(`
가평군 강남구 강동구 강릉시 강북구 강서구 강진군 강화군 거제시 거창군 검단구 경기도 경산시 경상북도 계룡시 계양구 고령군 고성군 고양시 고창군 고흥군 곡성군 과천시 관악구 광명시 광산구 광양시 광진구 괴산군 구례군 구로구 구리시 구미시 군산시 군위군 군포시 권선구 금산군 금정구 금천구 기장군 기흥구 김제시 김천시 김포시 김해시 남동구 남원시 노원구 논산시 단양군 단원구 달서구 달성군 담양군 당진시 대구광역시 대구시 대덕구 대전광역시 덕양구 덕진구 도봉구 동남구 동대문구 동두천시 동래구 동작구 동탄구 동해시 마산합포구 마포구 만세구 목포시 무안군 무주군 문경시 미추홀구 밀양시 보령시 보성군 보은군 봉화군 부산시 부산진구 부안군 부여군 부천시 부평구 분당구 사상구 사천시 사하구 산청군 삼척시 상당구 상록구 서귀포시 서대문구 서북구 서산시 서울시 서천군 서초구 서해구 성남시 성동구 성북구 성산구 성주군 세종시 세종특별자치시 소사구 송파구 수성구 수원시 순창군 순천시 시흥시 신안군 아산시 안동시 안산시 안성시 안양시 양구군 양산시 양양군 양천구 양평군 여수시 연수구 연천군 영광군 영덕군 영도구 영동군 영등포구 영암군 영양군 영월군 영종구 영천시 영통구 예산군 예천군 오산시 옥천군 옹진군 완도군 완주군 용산구 용인시 울릉군 울산광역시 울산시 울주군 울진군 원미구 유성구 은평구 음성군 의령군 의성군 의왕시 의정부시 의창구 이천시 익산시 인제군 인천시 일산동구 일산서구 임실군 장성군 장수군 장안구 장흥군 전국 전남광주통합특별시 전북특별자치도 정선군 정읍시 제물포구 제천시 종로구 중랑구 증평군 진도군 진안군 진천군 창녕군 창원시 처인구 천안시 철원군 청도군 청송군 청양군 청원구 춘천시 충청남도 칠곡군 태백시 태안군 통영시 팔달구 평창군 평택시 포천시 포항시 하남시 하동군 함안군 함양군 함평군 합천군 해남군 해운대구 홍성군 홍천군 화성시 화순군 화천군 횡성군 효행구 흥덕구
`.trim().split(/\s+/));
const validDisasterRegions = new Set([
  ...observedDisasterRegions,
  '강원특별자치도', '경상남도', '광주시', '부산광역시', '서울특별시',
  '인천광역시', '전남광주통합특별시', '제주시', '제주특별자치도', '충청북도',
]);
const regionAliases=new Map();
for(const region of validDisasterRegions){
  if(!/(?:시|군|구)$/.test(region)||/(?:특별시|광역시)$/.test(region))continue;
  const stem=region.replace(/(?:시|군|구)$/,'');
  if(!regionAliases.has(stem))regionAliases.set(stem,region);
  else if(regionAliases.get(stem)!==region)regionAliases.set(stem,null);
}
function regionAliasPattern(alias){
  return new RegExp(`(?:^|[,，\\s])${alias}(?:(?:군|시|구)(?=[()（）,，.。\\s]|$)|(?:[가-힣]{1,8}(?:읍|면|동))(?=[)）,，.。\\s]|$)|(?=[(（,，])|(?=\\s*(?:인근|지역|방면|일대|전역|주민))|$)`);
}

function extractMessageRegions(message) {
  const body = String(message).replace(/\s*\[[^\]]+\]\s*$/, '').replace(/20\d{2}[/.\-]\d{1,2}[/.\-]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/g, ' ');
  const hazardAt = body.search(/(?:산불|산사태|호우|폭염|한파|대설|강풍|태풍|침수|화재|지진|범람|대피|실종|발생|주의보|경보|통제)/);
  const locationBody = hazardAt >= 0 ? body.slice(0, Math.min(body.length, hazardAt + 90)) : body.slice(0, 150);
  const candidates = [];
  const parentheticalAreas=[...locationBody.matchAll(/[가-힣]{1,}(?:도|남|북)\s*\(([^)]{1,150})\)/g)].map(match=>match[1]);
  const parentheticalRegions=new Set();
  for(const area of parentheticalAreas){
    for(const [alias,region]of regionAliases){if(region&&regionAliasPattern(alias).test(area))parentheticalRegions.add(region);}
  }
  if(parentheticalRegions.size)return [...parentheticalRegions];
  const official = /(?:서울특별시|부산광역시|대구광역시|인천광역시|전남광주통합특별시|광주광역시|대전광역시|울산광역시|세종특별자치시|제주특별자치도|전북특별자치도|강원특별자치도|경기도|충청북도|충청남도|전라남도|경상북도|경상남도|[가-힣]{2,}(?:시|군|구))/g;
  for (const match of locationBody.matchAll(official)) {
    const value = match[0];
    const following = locationBody.slice(match.index + value.length, match.index + value.length + 3);
    if (!validDisasterRegions.has(value) || nonLocalAgencyWords.test(value) || nonRegionPhrases.test(value) || /청$/.test(value) || /(?:청|공사|공단|본부|경찰서|소방서)/.test(following)) continue;
    if (!/^(?:\s|[,，.。·:;()[\]\/]|은|는|이|가|을|를|에|에서|으로|로|과|와|민|전체|전역|일대|인근|지역|주민|호우|산불|한파|폭염|대설|강풍|태풍|침수|화재|지진|범람|대피|실종|통제|주의보|경보|예보|상황|예상)/.test(following)) continue;
    const isProvince = /(?:특별자치도|특별시|광역시|도)$/.test(value);
    candidates.push({ value, score: match.index + (isProvince ? 0 : 1000) });
  }
  const regionFirst = locationBody.match(/([가-힣]{2,}(?:시|군|구))\s+[^.。]{0,40}?(?:지역|전역|일대|인근)/);
  if (regionFirst && validDisasterRegions.has(regionFirst[1]) && !nonLocalAgencyWords.test(regionFirst[1]) && !nonRegionPhrases.test(regionFirst[1])) candidates.push({ value: regionFirst[1], score: 1200 });
  const directional = locationBody.match(/([가-힣]{2,}(?:시|군)?\s*(?:동부|서부|남부|북부|동북부|서북부|남부지역|북부지역))/);
  if (directional && validDisasterRegions.has(directional[1].replace(/\s+/g, '')) && !nonLocalAgencyWords.test(directional[1]) && !nonRegionPhrases.test(directional[1])) candidates.push({ value: directional[1].replace(/\s+/g, ''), score: 1300 });
  for(const [alias,region]of regionAliases){
    if(!region)continue;
    if(regionAliasPattern(alias).test(locationBody))candidates.push({value:region,score:1400});
  }
  const specific=[...new Set(candidates.filter(item=>!/(?:특별자치도|특별시|광역시|도)$/.test(item.value)).sort((a,b)=>a.score-b.score).map(item=>item.value))];
  if(specific.length)return specific;
  const provinces=[...new Set(candidates.sort((a,b)=>a.score-b.score).map(item=>item.value))];
  return provinces.length?provinces:['전국'];
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
    const extractedRegions = extractMessageRegions(message);
    const regions = extractedRegions.length===1&&extractedRegions[0]==='전국'&&validDisasterRegions.has(agency)?[agency]:extractedRegions;
    const region = regions[0] || '전국';
    entries.push({
      id: decodeHtml(number),
      region,
      regions,
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
  const pageSize = Math.max(7, Math.min(50, Number(url.searchParams.get('pageSize')) || 50));
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const keyword = (url.searchParams.get('keyword') || '').trim().slice(0, 80);
  const requestedRegion = (url.searchParams.get('region') || '').trim().slice(0, 80);
  const region = regionAliases.get(requestedRegion)||requestedRegion;
  const endDate = getKoreanDate(new Date());
  const startDate = getKoreanDate(new Date(Date.now() - (days - 1) * 86400000));
  try {
    const filteredSearch = Boolean((region && region !== '전국') || keyword);
    const sourceKeyword = keyword;
    const cacheKey = `${startDate}|${endDate}|${region}|${keyword}|${filteredSearch?'all':`page-${page}`}`;
    let sourceData = disasterSearchCache.get(cacheKey);
    if (sourceData && sourceData.expiresAt <= Date.now()) { disasterSearchCache.delete(cacheKey); sourceData = null; }
    if(!sourceData&&filteredSearch&&!keyword){
      const allData=disasterAllMessageCache.get(`${startDate}|${endDate}`);
      if(allData&&allData.expiresAt>Date.now()){
        const matches=allData.items.filter(item=>(region==='기타'?item.regions.includes('전국'):item.regions.includes(region)));
        sourceData={items:matches,sourceTotal:matches.length,expiresAt:allData.expiresAt};disasterSearchCache.set(cacheKey,sourceData);
      }
    }
    if (!sourceData) {
      const fetchSourcePage = async (sourcePage, sourcePageSize) => {
        const sourceUrl = new URL(disasterSource);
        sourceUrl.searchParams.set('currentPage', String(sourcePage));
        sourceUrl.searchParams.set('cntPerPage', String(sourcePageSize));
        sourceUrl.searchParams.set('pageSize', String(sourcePageSize));
        sourceUrl.searchParams.set('searchStartDttm', startDate);
        sourceUrl.searchParams.set('searchEndDttm', endDate);
        sourceUrl.searchParams.set('keyword', sourceKeyword);
        const upstream = await fetch(sourceUrl, {headers:{'User-Agent':'Mozilla/5.0 (compatible; DisasterMessageReader/1.0)'},redirect:'follow',signal:AbortSignal.timeout(15000)});
        if (!upstream.ok) throw new Error('upstream');
        const html = await upstream.text();
        const matchTotal = html.match(/<span[^>]*>([\d,]+)<\/span>\s*건의 게시물이 검색되었습니다/);
        return {items:parseDisasterRows(html),total:Number((matchTotal?.[1]||'0').replace(/,/g,''))};
      };
      const first = await fetchSourcePage(filteredSearch ? 1 : page, filteredSearch ? 50 : pageSize);
      if (filteredSearch) {
        const sourcePages = Math.max(1,Math.ceil(first.total/50));
        const sourcePageItems=new Map([[1,first.items]]);let cursor=2;
        async function worker(){
          while(cursor<=sourcePages){const nextPage=cursor++;const result=await fetchSourcePage(nextPage,50);sourcePageItems.set(nextPage,result.items);}
        }
        await Promise.all(Array.from({length:Math.min(4,sourcePages-1)},worker));
        const seenIds=new Set();const allItems=[...sourcePageItems.keys()].sort((a,b)=>a-b).flatMap(sourcePage=>sourcePageItems.get(sourcePage)||[]).filter(item=>{if(seenIds.has(item.id))return false;seenIds.add(item.id);return true;});
        if(!keyword){disasterAllMessageCache.set(`${startDate}|${endDate}`,{items:allItems,total:first.total,expiresAt:Date.now()+120000});while(disasterAllMessageCache.size>3)disasterAllMessageCache.delete(disasterAllMessageCache.keys().next().value);}
        sourceData={items:allItems.filter(item=>((!region||region==='전국')||(region==='기타'?item.regions.includes('전국'):item.regions.includes(region)))&&(!keyword||item.message.includes(keyword))),sourceTotal:first.total,expiresAt:Date.now()+120000};
        disasterSearchCache.set(cacheKey,sourceData);while(disasterSearchCache.size>40)disasterSearchCache.delete(disasterSearchCache.keys().next().value);
      } else {
        sourceData={items:first.items,sourceTotal:first.total,expiresAt:Date.now()+120000};
      }
    }
    const sourceTotal=sourceData.sourceTotal;
    const totalCount=filteredSearch?sourceData.items.length:sourceTotal;
    const pageCount=Math.max(1,Math.ceil(totalCount/pageSize));
    const pageItems=filteredSearch?sourceData.items.slice((page-1)*pageSize,page*pageSize):sourceData.items;
    const items=pageItems;
    const regionCounts = {};
    (filteredSearch?sourceData.items:items).forEach(item => { for(const regionName of item.regions){const displayRegion=displayDisasterRegion(regionName);regionCounts[displayRegion] = (regionCounts[displayRegion] || 0) + 1;} });
    sendJson(response, 200, {
      page,
      pageSize,
      pageCount,
      totalCount,
      nationalCount: totalCount,
      collectedCount: filteredSearch?totalCount:sourceTotal,
      complete: true,
      startDate,
      endDate,
      regions: [...observedDisasterRegions].map(displayDisasterRegion).filter((value,index,array)=>array.indexOf(value)===index).sort((a, b) => a.localeCompare(b, 'ko')),
      regionCounts,
      items: items.map(item=>({...item,region:displayDisasterRegion(item.region),regions:item.regions.map(displayDisasterRegion)})),
    });
  } catch {
    sendJson(response, 502, { error: '공식 재난문자 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

async function getDisasterRegionCounts(url, response) {
  const days=Math.max(1,Math.min(365,Number(url.searchParams.get('days'))||30));
  const endDate=getKoreanDate(new Date());const startDate=getKoreanDate(new Date(Date.now()-(days-1)*86400000));
  const key=`${startDate}|${endDate}`;const cached=disasterRegionCountCache.get(key);
  if(cached&&cached.expiresAt>Date.now()){sendJson(response,200,cached.data);return;}
  try{
    const fetchSourcePage=async page=>{
      const sourceUrl=new URL(disasterSource);sourceUrl.searchParams.set('currentPage',String(page));sourceUrl.searchParams.set('cntPerPage','50');sourceUrl.searchParams.set('pageSize','50');sourceUrl.searchParams.set('searchStartDttm',startDate);sourceUrl.searchParams.set('searchEndDttm',endDate);sourceUrl.searchParams.set('keyword','');
      const upstream=await fetch(sourceUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; DisasterMessageReader/1.0)'},redirect:'follow',signal:AbortSignal.timeout(15000)});if(!upstream.ok)throw new Error(`upstream_${upstream.status}`);
      const html=await upstream.text();const totalMatch=html.match(/<span[^>]*>([\d,]+)<\/span>\s*건의 게시물이 검색되었습니다/);return {items:parseDisasterRows(html),total:Number((totalMatch?.[1]||'0').replace(/,/g,''))};
    };
    const first=await fetchSourcePage(1);const sourcePages=Math.max(1,Math.ceil(first.total/50));const pages=new Map([[1,first.items]]);const failed=[];let cursor=2;
    async function worker(){while(cursor<=sourcePages){const page=cursor++;let success=false;for(let attempt=0;attempt<2&&!success;attempt++){try{pages.set(page,(await fetchSourcePage(page)).items);success=true}catch(error){if(attempt===1)failed.push(page);}}}}
    await Promise.all(Array.from({length:Math.min(8,sourcePages-1)},worker));
    const seen=new Set();const counts={};const allItems=[];let collected=0,multiRegionMessages=0,regionAssignments=0;
    [...pages.keys()].sort((a,b)=>a-b).forEach(page=>(pages.get(page)||[]).forEach(item=>{if(seen.has(item.id))return;seen.add(item.id);allItems.push(item);collected++;const regions=item.regions||[item.region||'전국'];if(regions.length>1)multiRegionMessages++;for(const regionName of regions){const region=displayDisasterRegion(regionName);counts[region]=(counts[region]||0)+1;regionAssignments++;}}));
    disasterAllMessageCache.set(key,{items:allItems,total:first.total,expiresAt:Date.now()+120000});while(disasterAllMessageCache.size>3)disasterAllMessageCache.delete(disasterAllMessageCache.keys().next().value);
    const result={startDate,endDate,expected:first.total,collected,regionAssignments,multiRegionMessages,complete:failed.length===0&&collected>=first.total,failedPages:failed,counts};
    disasterRegionCountCache.set(key,{data:result,expiresAt:Date.now()+120000});
    sendJson(response,200,result);
  }catch(error){sendJson(response,502,{error:'지역별 재난문자 수를 불러오지 못했어요. 다시 시도해 주세요.'});}
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
  const radiusKm = Math.max(1, Math.min(10, Number(url.searchParams.get('radiusKm')) || 10));
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
    const formatStepDistance = meters => meters < 1000
      ? `${Math.max(10, Math.round(meters / 10) * 10)}미터`
      : `${(meters / 1000).toFixed(1)}킬로미터`;
    const steps = (route.legs || []).flatMap(leg => leg.steps || []).map(step => {
      const maneuver = step.maneuver || {};
      const modifier = maneuver.modifier || '';
      const direction = modifier.includes('left') ? '왼쪽' : modifier.includes('right') ? '오른쪽' : modifier === 'straight' ? '직진' : '';
      const name = typeof step.name === 'string' ? step.name.trim() : '';
      const distance = Number(step.distance) > 20 ? formatStepDistance(Number(step.distance)) : '';
      if (maneuver.type === 'arrive') return '목적지에 도착했어요.';
      if (maneuver.type === 'depart') return `${name ? `${name} 방향으로 ` : ''}출발하세요${distance ? `. ${distance} 정도 가세요.` : '.'}`;
      if (maneuver.type === 'roundabout' || maneuver.type === 'rotary') {
        const exit = Number(maneuver.exit);
        return `${exit ? `회전교차로에서 ${exit}번째 출구로 나가세요` : '회전교차로를 지나가세요'}${name ? ` (${name})` : ''}.`;
      }
      if (maneuver.type === 'merge') return `${name ? `${name} 방향으로 ` : ''}길에 합류하세요${distance ? ` (${distance})` : ''}.`;
      if (maneuver.type === 'fork') return `${direction || '안내된 방향'} 갈림길로 가세요${name ? ` (${name})` : ''}${distance ? `, ${distance} 정도` : ''}.`;
      if (maneuver.type === 'turn' || maneuver.type === 'end of road') return `${direction || '앞쪽'}으로 돌아가세요${name ? ` (${name})` : ''}${distance ? `, ${distance} 정도` : ''}.`;
      if (maneuver.type === 'on ramp') return `${name ? `${name} 방향 ` : ''}진입로로 들어가세요${distance ? `, ${distance} 정도` : ''}.`;
      if (maneuver.type === 'off ramp') return `${name ? `${name} 방향 ` : ''}진출로로 빠져나가세요${distance ? `, ${distance} 정도` : ''}.`;
      return `${name ? `${name} 길을 따라 ` : ''}${distance ? `${distance} ` : ''}직진하세요.`;
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

async function translateWithMyMemory(text, source, target) {
  const locales = { ko: 'ko-KR', en: 'en-GB', 'zh-CN': 'zh-CN', vi: 'vi-VN', ne: 'ne-NP', tl: 'tl-PH', th: 'th-TH', ja: 'ja-JP' };
  const sourceLocale = locales[source];
  const targetLocale = locales[target];
  if (!sourceLocale || !targetLocale) throw new Error('translation_language_unsupported');
  const translateChunk = async (chunk) => {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', chunk);
    url.searchParams.set('langpair', `${sourceLocale}|${targetLocale}`);
    const upstream = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) throw new Error(`mymemory_${upstream.status}`);
    const result = await upstream.json();
    const translated = String(result.responseData?.translatedText || '').trim();
    if (result.responseStatus !== 200 || !translated) throw new Error('mymemory_translation_unavailable');
    return translated;
  };
  if (text.length <= 450) return translateChunk(text);
  const chunks = [];
  let remaining = text;
  while (remaining.length > 450) {
    let splitAt = Math.max(remaining.lastIndexOf('. ', 450), remaining.lastIndexOf('! ', 450), remaining.lastIndexOf('? ', 450), remaining.lastIndexOf('。', 450), remaining.lastIndexOf('\n', 450), remaining.lastIndexOf(' ', 450));
    if (splitAt < 180) splitAt = 450;
    else if (remaining[splitAt] === '.' || remaining[splitAt] === '!' || remaining[splitAt] === '?') splitAt += 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  const translatedChunks = [];
  for (const chunk of chunks) translatedChunks.push(await translateChunk(chunk.trim()));
  return translatedChunks.join(' ');
}

function hasTranslationScript(text, target) {
  const hangulShare = (text.match(/[가-힣]/g) || []).length / Math.max(1, text.length);
  const requiredScript = target === 'ne' ? /[\u0900-\u097F]/.test(text)
    : target === 'th' ? /[\u0E00-\u0E7F]/.test(text)
      : target === 'ja' ? /[\u3040-\u30FF]/.test(text)
        : target === 'zh-CN' ? /[\u4E00-\u9FFF]/.test(text)
          : true;
  return target === 'ko' || (hangulShare < 0.15 && requiredScript);
}

function classifyGeminiQuotaError(status, body) {
  const providerStatus = String(body?.error?.status || 'UNKNOWN');
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const violations = details.flatMap(detail => Array.isArray(detail?.violations) ? detail.violations : []);
  const quotaLimits = violations.slice(0, 4).map(item => ({
    quotaId: /^[A-Za-z0-9_.:-]{1,120}$/.test(String(item.quotaId || '')) ? item.quotaId : undefined,
    metric: /^[A-Za-z0-9_.:/-]{1,160}$/.test(String(item.quotaMetric || '')) ? item.quotaMetric : undefined,
    limit: Number.isFinite(Number(item.quotaValue)) ? Number(item.quotaValue) : undefined,
    window: /per[_ -]?day|daily|perday/i.test(`${item.quotaId || ''} ${item.quotaMetric || ''} ${item.description || ''}`) ? 'day'
      : /per[_ -]?minute|per[_ -]?second|perminute|persecond/i.test(`${item.quotaId || ''} ${item.quotaMetric || ''} ${item.description || ''}`) ? 'short-term' : undefined,
  })).filter(item => item.quotaId || item.metric || item.limit !== undefined || item.window);
  const quotaText = `${violations.map(item => `${item.quotaId || ''} ${item.quotaMetric || ''} ${item.description || ''}`).join(' ')} ${quotaLimits.map(item => `${item.quotaId || ''} ${item.metric || ''} ${item.window || ''}`).join(' ')}`.toLowerCase();
  const message = String(body?.error?.message || '').toLowerCase();
  const hasRetryInfo = details.some(detail => /RetryInfo$/.test(String(detail?.['@type'] || '')));
  const retryDelay = details.find(detail => /RetryInfo$/.test(String(detail?.['@type'] || '')))?.retryDelay;
  const retryMatch = typeof retryDelay === 'string' ? retryDelay.match(/([\d.]+)s/) : null;
  const retryAfterSeconds = retryMatch ? Math.ceil(Number(retryMatch[1])) : null;
  const dailyQuota = /per[_ -]?day|daily|free[_ -]?tier|monthly|billing|perday/.test(quotaText) || /current quota|daily quota|billing details|quota.*exceed/.test(message);
  const shortRateLimit = hasRetryInfo || /per[_ -]?(minute|second)|requests?[_ -]?per[_ -]?(minute|second)|tokens?[_ -]?per[_ -]?(minute|second)|rate[_ -]?limit/.test(quotaText);
  const reason = status === 429 && dailyQuota ? 'allocation_exhausted'
    : status === 429 && shortRateLimit ? 'temporary_rate_limit'
      : status === 429 ? 'rate_or_quota_unspecified'
        : status === 400 && /api key not valid|invalid api key/.test(message) ? 'invalid_api_key'
          : status === 403 ? 'permission_or_billing'
            : `provider_http_${status}`;
  return { httpStatus: status, providerStatus, reason, retryAfterSeconds, ...(quotaLimits.length ? { quotaLimits } : {}) };
}

let geminiRequestQueue = Promise.resolve();
let geminiLastRequestAt = 0;
let geminiCooldownUntil = 0;
let geminiCooldownDiagnostic = null;
async function pacedGeminiFetch(url, options) {
  const previous = geminiRequestQueue;
  let release;
  geminiRequestQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (geminiCooldownUntil > Date.now()) {
      const error = new Error('gemini_quota_cooldown');
      error.code = 'gemini_quota_cooldown';
      error.diagnostic = geminiCooldownDiagnostic;
      throw error;
    }
    const wait = Math.max(0, 4000 - (Date.now() - geminiLastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    geminiLastRequestAt = Date.now();
    return await fetch(url, options);
  } finally {
    release();
  }
}

function sendGeminiRateLimit(response, diagnostic) {
  const retryAfterSeconds = Math.max(1, Math.min(86400, Number(diagnostic?.retryAfterSeconds) || 4));
  response.writeHead(429, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(retryAfterSeconds), 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify({ error: '번역 요청이 잠시 제한됐어요.', diagnostic: { ...diagnostic, retryAfterSeconds } }));
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
    const cacheKey = `${source}\0${target}\0${text}`;
    if (cacheable && siteTranslationMemory.has(cacheKey)) {
      const cached = siteTranslationMemory.get(cacheKey);
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify([[[cached, text, null, null]]]));
      return;
    }
    if (geminiCooldownUntil > Date.now()) {
      sendGeminiRateLimit(response, { ...geminiCooldownDiagnostic, retryAfterSeconds: Math.ceil((geminiCooldownUntil - Date.now()) / 1000) });
      return;
    }
    const languageNames = { ko: 'Korean', en: 'English', 'zh-CN': 'Simplified Chinese', vi: 'Vietnamese', ne: 'Nepali', tl: 'Filipino', th: 'Thai', ja: 'Japanese' };
    const prompt = `Translate the following ${languageNames[source]} text into ${languageNames[target]}. Output only natural ${languageNames[target]}; do not repeat the source text. Preserve all facts, place names, numbers, emergency stages, negations, and every ZZI18N marker. Do not summarize, omit, or change safety meaning.\n\n${text}`;
    let translatedText = '';
    let lastStatus = 502;
    let retryAfterSeconds = 2;
    let rateLimited = false;
    let geminiDiagnostic = null;
    const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];
    for (const model of apiKey ? models : []) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const upstream = await pacedGeminiFetch(modelUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: Math.max(512, Math.min(3072, text.length * 2)), temperature: 0, ...(model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: 'MINIMAL' } } : {}) },
            }),
            signal: AbortSignal.timeout(25000),
          });
          if (!upstream.ok) {
            lastStatus = upstream.status;
            let providerError = null;
            try { providerError = await upstream.json(); } catch {}
            geminiDiagnostic = classifyGeminiQuotaError(upstream.status, providerError);
            if (upstream.status === 429) {
              retryAfterSeconds = Math.max(1, Math.min(86400, Number(upstream.headers.get('retry-after')) || geminiDiagnostic.retryAfterSeconds || retryAfterSeconds));
              rateLimited = true;
              geminiCooldownUntil = Date.now() + retryAfterSeconds * 1000;
              geminiCooldownDiagnostic = { ...geminiDiagnostic, retryAfterSeconds };
            }
            throw new Error(`gemini_${upstream.status}`);
          }
          const result = await upstream.json();
          const candidate = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || '';
          if (candidate && hasTranslationScript(candidate, target)) { translatedText = candidate; break; }
          lastStatus = 502;
        } catch (error) {
          if (error.code === 'gemini_quota_cooldown') {
            lastStatus = 429;
            rateLimited = true;
            geminiDiagnostic = error.diagnostic;
            retryAfterSeconds = Math.max(1, Math.ceil((geminiCooldownUntil - Date.now()) / 1000));
          }
          if (!error.name || error.name !== 'TimeoutError') lastStatus = Number(String(error.message).match(/gemini_(\d+)/)?.[1]) || lastStatus;
        }
        if (rateLimited || [400, 401, 403].includes(lastStatus)) break;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (translatedText || rateLimited || [400, 401, 403].includes(lastStatus)) break;
    }
    if (!translatedText && !rateLimited && geminiDiagnostic?.reason !== 'allocation_exhausted') {
      try {
        const fallback = await translateWithMyMemory(text, source, target);
        if (hasTranslationScript(fallback, target)) translatedText = fallback;
      } catch {
        translatedText = '';
      }
    }
    if (!translatedText) {
      const error = { error: '번역을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' };
      if (rateLimited) {
        const retrySeconds = Math.max(1, Math.min(86400, Number(geminiDiagnostic?.retryAfterSeconds) || retryAfterSeconds));
        sendGeminiRateLimit(response, { ...geminiDiagnostic, retryAfterSeconds: retrySeconds });
      } else sendJson(response, 502, geminiDiagnostic ? { ...error, diagnostic: geminiDiagnostic } : error);
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
    if (request.method === 'GET' && url.pathname === '/api/disaster-region-counts') {
      await getDisasterRegionCounts(url, response);
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
