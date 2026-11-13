const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const sourceUrl = 'https://file.localdata.go.kr/file/download/civil_defense_shelter_info/info';
const sourcePage = 'https://www.data.go.kr/data/15044951/fileData.do';
const shelterSampleUrl = 'https://www.safetydata.go.kr/disaster-data/downloadData';
const regionalShelterSite = 'https://life.ttpk.co.kr';
const cacheMs = 6 * 60 * 60 * 1000;
let shelterCache;
let cacheExpires = 0;
let cacheRequest;
const shelterSampleSources = {
  earthquake: {
    dataSn: 1339,
    name: '지진 옥외대피장소',
    source: '행정안전부 지진 옥외대피장소 공개 샘플',
    sourceUrl: 'https://www.data.go.kr/data/15138868/openapi.do'
  },
  tsunami: {
    dataSn: 1340,
    name: '지진해일 긴급대피장소',
    source: '행정안전부 지진해일 긴급대피장소 공개 샘플',
    sourceUrl: 'https://www.data.go.kr/data/15138870/openapi.do'
  }
};
const shelterSampleCache = new Map();
const shelterSampleRequests = new Map();
const regionalShelterTypes = {
  earthquake: {
    slug: 'shelter-eq',
    label: '지진 옥외대피장소',
    source: '행정안전부 안전데이터 API 기반 지진대피장소 지역별 공개목록',
    apiUrl: 'https://www.data.go.kr/data/15138868/openapi.do'
  },
  heat: {
    slug: 'shelter-heat',
    label: '무더위쉼터',
    source: '지역별 무더위쉼터 공개목록'
  },
  cold: {
    slug: 'shelter-cold',
    label: '한파쉼터',
    source: '지역별 한파쉼터 공개목록'
  }
};
const regionalShelterCache = new Map();
const regionalShelterRequests = new Map();
const reverseGeocodeCache = new Map();
const reverseGeocodeRequests = new Map();
const disasterMessageCache = new Map();
const disasterMessageRequests = new Map();
const disasterArchiveUrl = 'https://www.safetydata.go.kr/disaster-data/disasterNotification';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(value);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, '').trim()) || [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

async function loadShelters() {
  if (shelterCache && Date.now() < cacheExpires) return shelterCache;
  if (cacheRequest) return cacheRequest;

  cacheRequest = (async () => {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: 'text/csv,application/octet-stream,*/*',
        Referer: sourcePage,
        'User-Agent': 'Mozilla/5.0 (compatible; AnsimGil/1.0)'
      },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error('공식 대피시설 자료를 가져오지 못했습니다.');

    const buffer = Buffer.from(await response.arrayBuffer());
    const csv = new TextDecoder('euc-kr').decode(buffer);
    const rows = parseCsv(csv);
    const facilities = rows.flatMap((row) => {
      if (row['운영상태'] !== '사용중') return [];
      const lat = Number(row['위도(EPSG4326)']);
      const lon = Number(row['경도(EPSG4326)']);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

      return [{
        id: row['관리번호'],
        name: row['시설명'] || '이름이 등록되지 않은 시설',
        address: row['도로명전체주소'] || row['소재지전체주소'] || '주소 정보 없음',
        type: row['시설구분'],
        floor: row['시설위치(지상/지하)'],
        capacity: Number(row['최대수용인원']) || null,
        lat,
        lon
      }];
    });

    shelterCache = facilities;
    cacheExpires = Date.now() + cacheMs;
    return facilities;
  })();

  try {
    return await cacheRequest;
  } finally {
    cacheRequest = null;
  }
}

async function loadShelterSample(type) {
  const cached = shelterSampleCache.get(type);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  if (shelterSampleRequests.has(type)) return shelterSampleRequests.get(type);

  const request = (async () => {
    const source = shelterSampleSources[type];
    const response = await fetch(shelterSampleUrl, {
      method: 'POST',
      headers: {
        Accept: 'text/csv,application/json,*/*',
        'Content-Type': 'application/json',
        Referer: `https://www.safetydata.go.kr/disaster-data/view?dataSn=${source.dataSn}`,
        'User-Agent': 'Mozilla/5.0 (compatible; AnsimGil/1.0)'
      },
      body: JSON.stringify({ dataSn: source.dataSn }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error('공개 대피장소 샘플을 가져오지 못했습니다.');

    const rows = parseCsv(await response.text());
    const items = rows.flatMap((row) => {
      const columns = Object.values(row);
      const lat = Number(type === 'earthquake' ? columns[12] : columns[10]);
      const lon = Number(type === 'earthquake' ? columns[11] : columns[9]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const statusCode = type === 'tsunami' ? columns[6] : '';
      if (type === 'tsunami' && statusCode && statusCode !== 'Y') return [];

      const name = type === 'earthquake' ? columns[5] : columns[3];
      const address = type === 'earthquake'
        ? columns[13] || columns[9] || columns[4]
        : columns[7] || columns[11];
      const capacity = Number(type === 'earthquake' ? columns[6] : columns[4]);
      const altitude = Number(columns[5]);
      const sourceId = type === 'earthquake' ? columns[1] : columns[2];

      return [{
        id: `${type}-${sourceId || `${lat}-${lon}`}`,
        name: name || '이름이 등록되지 않은 대피장소',
        address: address || '주소 정보 없음',
        category: type,
        kindLabel: source.name,
        capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
        altitudeMeters: type === 'tsunami' && Number.isFinite(altitude) ? altitude : null,
        statusLabel: type === 'tsunami' && statusCode === 'Y' ? '자료상 사용 가능' : '',
        lat,
        lon
      }];
    });
    const data = {
      source: source.source,
      sourceUrl: source.sourceUrl,
      fetchedAt: new Date().toISOString(),
      sampleCount: items.length,
      sampleLimit: 100,
      temporary: true,
      items
    };
    shelterSampleCache.set(type, { data, expiresAt: Date.now() + cacheMs });
    return data;
  })();

  shelterSampleRequests.set(type, request);
  try {
    return await request;
  } finally {
    shelterSampleRequests.delete(type);
  }
}

function parseKoreanRegion(text) {
  const sido = text.match(/(?:서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청북도|충청남도|전북특별자치도|전라남도|경상북도|경상남도|제주특별자치도)/)?.[0];
  const places = [...text.matchAll(/([가-힣]+(?:시|군|구))/g)].map((match) => match[1]);
  const sigungu = places.find((place) => place === '창원시')
    || places.findLast((place) => place.endsWith('군'))
    || places.findLast((place) => place.endsWith('시'))
    || places.findLast((place) => place.endsWith('구'));
  return sido && sigungu ? { sido, sigungu } : null;
}

async function resolveKoreanRegion(lat, lon) {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.region;
  if (reverseGeocodeRequests.has(cacheKey)) return reverseGeocodeRequests.get(cacheKey);

  const request = (async () => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lon),
      zoom: '10',
      addressdetails: '1'
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; AnsimGil/1.0)'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error('지역을 확인하지 못했습니다.');
    const data = await response.json();
    const region = parseKoreanRegion(Object.values(data.address || {}).join(' '));
    if (region) reverseGeocodeCache.set(cacheKey, { region, expiresAt: Date.now() + cacheMs });
    return region;
  })();

  reverseGeocodeRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    reverseGeocodeRequests.delete(cacheKey);
  }
}

function uniqueShelterLocations(items) {
  const unique = new Map();
  for (const item of items) {
    const key = `${item.name.trim().toLocaleLowerCase('ko')}|${item.address.trim().replace(/\s+/g, ' ')}|${item.lat.toFixed(5)},${item.lon.toFixed(5)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

async function loadRegionalShelters(type, region) {
  const definition = regionalShelterTypes[type];
  if (!definition) throw new Error('지역별 대피시설 종류를 확인할 수 없습니다.');
  const cacheKey = `${type}:${region.sido}:${region.sigungu}`;
  const cached = regionalShelterCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  if (regionalShelterRequests.has(cacheKey)) return regionalShelterRequests.get(cacheKey);

  const request = (async () => {
    const sourceUrl = new URL(`/${definition.slug}/map`, regionalShelterSite);
    sourceUrl.searchParams.set('sido', region.sido);
    sourceUrl.searchParams.set('sigungu', region.sigungu);
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; AnsimGil/1.0)'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('지역별 대피장소 자료를 가져오지 못했습니다.');
    const html = await response.text();
    const mapData = html.match(/<script\b(?=[^>]*\bid="map-data")(?=[^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/i)?.[1];
    if (mapData === undefined) throw new Error('지역별 대피장소 자료 형식을 확인할 수 없습니다.');

    const items = uniqueShelterLocations(JSON.parse(mapData).flatMap((row) => {
      const lat = Number(row.lat);
      const lon = Number(row.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      return [{
        id: `${type}-${row._id}`,
        name: row._name || '이름이 등록되지 않은 대피장소',
        address: row._addr || '주소 정보 없음',
        category: type,
        kindLabel: definition.label,
        capacity: null,
        altitudeMeters: null,
        statusLabel: '',
        lat,
        lon
      }];
    }));
    const data = {
      source: definition.source,
      sourceUrl: sourceUrl.href,
      apiUrl: definition.apiUrl,
      regionName: `${region.sido} ${region.sigungu}`,
      scopeLabel: `${region.sigungu} ${definition.label} 전체 · ${items.length}곳`,
      fetchedAt: new Date().toISOString(),
      sampleCount: items.length,
      complete: true,
      temporary: false,
      items
    };
    regionalShelterCache.set(cacheKey, { data, expiresAt: Date.now() + cacheMs });
    return data;
  })();

  regionalShelterRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    regionalShelterRequests.delete(cacheKey);
  }
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function disasterRegionFromAgency(agency) {
  const cleaned = agency.trim().replace(/^[\s.·•]+|[\s.·•]+$/g, '');
  return cleaned.replace(/(특별자치도|특별자치시|광역시|특별시|도|시|군|구)청$/, '$1') || '지역 미상';
}

function parseDisasterArchivePage(html, pageNumber = 1) {
  const totalText = html.match(/총\s*<span[^>]*>\s*([\d,]+)\s*<\/span>\s*건/);
  const items = [];
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const id = row.match(/<td\b[^>]*class="[^"]*cell-no[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1]?.replace(/<[^>]*>/g, '').trim();
    const link = row.match(/<a\b[^>]*href="([^"]*disasterNotificationDetail[^\"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const createdAt = row.match(/<td\b[^>]*class="[^"]*cell-date[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1]?.replace(/<[^>]*>/g, '').trim();
    if (!id || !link || !createdAt) continue;

    const message = decodeHtml(link[2].replace(/<[^>]*>/g, '').trim());
    const agency = (message.match(/\[([^\]]+)\]\s*$/)?.[1] || '재난문자').trim().replace(/^[\s.·•]+|[\s.·•]+$/g, '') || '재난문자';
    const region = disasterRegionFromAgency(agency);
    const sourceId = new URL(link[1], 'https://www.safetydata.go.kr').searchParams.get('sn');
    items.push({
      id: sourceId || `${pageNumber}-${id}`,
      message,
      agency,
      region,
      createdAt,
      sourceUrl: new URL(link[1], 'https://www.safetydata.go.kr').href
    });
  }
  return { totalCount: totalText ? Number(totalText[1].replaceAll(',', '')) : items.length, items };
}

async function loadNationwideDisasterMessages(days) {
  const cached = disasterMessageCache.get(days);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  if (disasterMessageRequests.has(days)) return disasterMessageRequests.get(days);

  const request = (async () => {
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days + 1);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    const params = new URLSearchParams({
      searchStartDttm: startDate,
      searchEndDttm: endDate,
      keyword: '',
      currentPage: '1',
      cntPerPage: '1000',
      pageSize: '10'
    });
    const headers = {
      Accept: 'text/html',
      Referer: disasterArchiveUrl,
      'User-Agent': 'Mozilla/5.0 (compatible; AnsimGil/1.0)'
    };
    const fetchPage = async (page) => {
      const pageParams = new URLSearchParams(params);
      pageParams.set('currentPage', String(page));
      const response = await fetch(`${disasterArchiveUrl}?${pageParams}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('공개 재난문자 목록을 가져오지 못했습니다.');
      return parseDisasterArchivePage(await response.text(), page);
    };

    const firstPage = await fetchPage(1);
    const pageCount = Math.ceil(firstPage.totalCount / 1000);
    const pages = Array(pageCount);
    pages[0] = firstPage;
    let nextPage = 2;
    const workers = Array.from({ length: Math.min(4, Math.max(0, pageCount - 1)) }, async () => {
      while (nextPage <= pageCount) {
        const page = nextPage++;
        pages[page - 1] = await fetchPage(page);
      }
    });
    await Promise.all(workers);
    const items = pages.flatMap((page) => page?.items || []);
    const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
    const data = {
      source: '전국 재난안전데이터공유플랫폼 공개 재난문자 목록',
      startDate,
      endDate,
      fetchedAt: new Date().toISOString(),
      totalCount: firstPage.totalCount,
      collectedCount: uniqueItems.length,
      complete: uniqueItems.length === firstPage.totalCount,
      items: uniqueItems
    };
    disasterMessageCache.set(days, { data, expiresAt: Date.now() + 15 * 60 * 1000 });
    return data;
  })();

  disasterMessageRequests.set(days, request);
  try {
    return await request;
  } finally {
    disasterMessageRequests.delete(days);
  }
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeInstruction(step) {
  const maneuver = step.maneuver || {};
  const name = step.name ? ` (${step.name})` : '';
  if (maneuver.type === 'depart') return `출발하세요${name}.`;
  if (maneuver.type === 'arrive') return '목적지에 도착했어요.';
  if (maneuver.type === 'roundabout' || maneuver.type === 'rotary') {
    return `${maneuver.exit || '다음'}번째 출구로 나가세요${name}.`;
  }

  const directions = {
    left: '왼쪽으로 꺾으세요',
    right: '오른쪽으로 꺾으세요',
    straight: '계속 직진하세요',
    'slight left': '조금 왼쪽으로 가세요',
    'slight right': '조금 오른쪽으로 가세요',
    'sharp left': '왼쪽으로 크게 꺾으세요',
    'sharp right': '오른쪽으로 크게 꺾으세요',
    uturn: '유턴하세요'
  };
  return `${directions[maneuver.modifier] || '안내된 길을 따라가세요'}${name}.`;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/shelters' && request.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radiusKm = Math.min(30, Math.max(1, Number(url.searchParams.get('radiusKm')) || 8));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      sendJson(response, 400, { error: '위치 좌표를 확인해 주세요.' });
      return;
    }

    try {
      const facilities = await loadShelters();
      const nearby = facilities
        .map((facility) => ({ ...facility, distanceKm: distanceKm(lat, lon, facility.lat, facility.lon) }))
        .filter((facility) => facility.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 60);
      sendJson(response, 200, {
        source: '행정안전부 전국 민방위대피시설 공개자료',
        fetchedAt: new Date().toISOString(),
        activeCount: facilities.length,
        temporary: false,
        items: nearby.map((facility) => ({ ...facility, category: 'civil', kindLabel: '민방위 대피시설' }))
      });
    } catch (error) {
      sendJson(response, 502, { error: '공식 대피시설 자료를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    return;
  }

  if (url.pathname === '/api/shelter-samples' && request.method === 'GET') {
    const type = url.searchParams.get('type');
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radiusKm = Math.min(30, Math.max(1, Number(url.searchParams.get('radiusKm')) || 8));
    const areaName = (url.searchParams.get('area') || '').slice(0, 200);
    if (!shelterSampleSources[type] && !regionalShelterTypes[type]) {
      sendJson(response, 400, { error: '대피장소 종류를 확인해 주세요.' });
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      sendJson(response, 400, { error: '위치 좌표를 확인해 주세요.' });
      return;
    }

    try {
      let data;
      if (regionalShelterTypes[type]) {
        let region = parseKoreanRegion(areaName);
        if (!region) {
          try {
            region = await resolveKoreanRegion(lat, lon);
          } catch (error) {
            region = null;
          }
        }
        if (region) {
          try {
            data = await loadRegionalShelters(type, region);
          } catch (error) {
            if (!shelterSampleSources[type]) throw error;
            data = { ...(await loadShelterSample(type)), regionFallback: true };
          }
        }
      }
      if (!data && shelterSampleSources[type]) data = await loadShelterSample(type);
      if (!data) throw new Error('현재 지역을 확인할 수 없어 해당 대피시설을 찾지 못했어요. 장소를 지역 검색으로 지정해 주세요.');

      const nearby = data.items
        .map((facility) => ({ ...facility, distanceKm: distanceKm(lat, lon, facility.lat, facility.lon) }))
        .filter((facility) => facility.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 60);
      sendJson(response, 200, { ...data, items: nearby });
    } catch (error) {
      sendJson(response, 502, { error: error.message || '지역 대피시설 자료를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    return;
  }

  if (url.pathname === '/api/disaster-messages' && request.method === 'GET') {
    const requestedDays = Number(url.searchParams.get('days'));
    const days = [30, 90, 365].includes(requestedDays) ? requestedDays : 365;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize')) || 40));
    const keyword = (url.searchParams.get('keyword') || '').trim().slice(0, 80).toLocaleLowerCase('ko');
    const region = (url.searchParams.get('region') || '').trim().slice(0, 80);
    try {
      const archive = await loadNationwideDisasterMessages(days);
      const regions = [...new Set(archive.items.map((item) => item.region || disasterRegionFromAgency(item.agency)))].sort((a, b) => a.localeCompare(b, 'ko'));
      const filtered = archive.items.filter((item) => {
        const matchesKeyword = !keyword || `${item.message} ${item.agency} ${item.region}`.toLocaleLowerCase('ko').includes(keyword);
        const matchesRegion = !region || item.region === region;
        return matchesKeyword && matchesRegion;
      });
      const regionCounts = {};
      filtered.forEach((item) => {
        regionCounts[item.region] = (regionCounts[item.region] || 0) + 1;
      });
      const matches = region ? filtered : [...filtered].sort((a, b) => a.region.localeCompare(b.region, 'ko') || b.createdAt.localeCompare(a.createdAt));
      const pageCount = Math.ceil(matches.length / pageSize);
      const safePage = pageCount ? Math.min(page, pageCount) : 1;
      const items = matches.slice((safePage - 1) * pageSize, safePage * pageSize);
      sendJson(response, 200, {
        source: archive.source,
        startDate: archive.startDate,
        endDate: archive.endDate,
        fetchedAt: archive.fetchedAt,
        nationalCount: archive.totalCount,
        collectedCount: archive.collectedCount,
        complete: archive.complete,
        keyword,
        region,
        regions,
        regionCounts,
        totalCount: matches.length,
        page: safePage,
        pageSize,
        pageCount,
        items
      });
    } catch (error) {
      sendJson(response, 502, { error: '전국 공식 재난문자 자료를 모두 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    return;
  }

  if (url.pathname === '/api/directions' && request.method === 'GET') {
    const originLat = Number(url.searchParams.get('originLat'));
    const originLon = Number(url.searchParams.get('originLon'));
    const destLat = Number(url.searchParams.get('destLat'));
    const destLon = Number(url.searchParams.get('destLon'));
    const mode = url.searchParams.get('mode') === 'driving' ? 'driving' : 'foot';
    const coordinates = [originLat, originLon, destLat, destLon];
    if (coordinates.some((value) => !Number.isFinite(value)) || Math.abs(originLat) > 90 || Math.abs(destLat) > 90 || Math.abs(originLon) > 180 || Math.abs(destLon) > 180) {
      sendJson(response, 400, { error: '출발지와 도착지 위치를 확인해 주세요.' });
      return;
    }

    const base = mode === 'foot'
      ? 'https://routing.openstreetmap.de/routed-foot/route/v1/driving'
      : 'https://router.project-osrm.org/route/v1/driving';
    const routeUrl = `${base}/${originLon},${originLat};${destLon},${destLat}?overview=full&steps=true&geometries=geojson`;
    try {
      const routeResponse = await fetch(routeUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!routeResponse.ok) throw new Error('공개 경로 서비스를 사용할 수 없습니다.');
      const data = await routeResponse.json();
      const route = data.routes?.[0];
      if (data.code !== 'Ok' || !route?.geometry?.coordinates?.length) throw new Error('경로를 찾을 수 없습니다.');
      const steps = (route.legs?.[0]?.steps || []).map(routeInstruction).slice(0, 30);
      sendJson(response, 200, {
        mode,
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        coordinates: route.geometry.coordinates,
        steps
      });
    } catch (error) {
      sendJson(response, 502, { error: '경로를 찾지 못했어요. 현재 위치와 인터넷 연결을 확인해 주세요.' });
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (error) {
    response.writeHead(400).end();
    return;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    response.writeHead(404).end();
    return;
  }
  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8'
      : filePath.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : filePath.endsWith('.css') ? 'text/css; charset=utf-8'
          : filePath.endsWith('.webp') ? 'image/webp'
            : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(404).end();
  }
});

server.listen(port, '0.0.0.0');
