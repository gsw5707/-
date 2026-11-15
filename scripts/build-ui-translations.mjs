import { readFile, writeFile } from 'node:fs/promises';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required');

const languages = ['en', 'zh-CN', 'vi', 'ne', 'tl', 'th', 'ja'];
const files = ['index.html', 'dictionary.json', 'difficult-words.json'];
const checkpointUrl = new URL('../data/ui-translation-build.json', import.meta.url);
const sources = new Set();
const decodeEntities = value => value
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

function addSource(value) {
  const text = decodeEntities(value);
  if (!/[가-힣]/.test(text) || text.length < 2 || text.length > 260 || /ZZI18N|\$\{|\b(?:https?:\/\/|data:image)/.test(text)) return;
  sources.add(text);
}

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const withoutCode = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
for (const match of withoutCode.matchAll(/>([^<>]+)</g)) addSource(match[1]);
for (const match of withoutCode.matchAll(/(?:placeholder|aria-label|title|alt)="([^"]+)"/g)) addSource(match[1]);
for (const pattern of [/'((?:\\.|[^'\\])*)'/g,/"((?:\\.|[^"\\])*)"/g,/`((?:\\.|[^`\\])*)`/g]) {
  for (const match of html.matchAll(pattern)) if (!match[1].includes('${')) addSource(match[1]);
}
for (const file of files.slice(1)) {
  const data = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  for (const entry of data) for (const value of Object.values(entry)) if (typeof value === 'string') addSource(value);
}

const originals = [...sources].sort((a, b) => a.localeCompare(b, 'ko'));
let translations = Object.fromEntries(languages.map(language => [language, {}]));
try {
  const saved = JSON.parse(await readFile(checkpointUrl, 'utf8'));
  if (saved && typeof saved === 'object') translations = { ...translations, ...saved };
} catch (error) {}
const chunks = [];
for (let index = 0; index < originals.length; index += 18) chunks.push(originals.slice(index, index + 18));
process.stdout.write(`Preparing ${originals.length} unique UI strings.\n`);

async function translateBatch(batch, attempt = 0) {
  const languageList = languages.map(language => `${language}: ${({en:'English', 'zh-CN':'Simplified Chinese', vi:'Vietnamese', ne:'Nepali', tl:'Filipino', th:'Thai', ja:'Japanese'})[language]}`).join(', ');
  const prompt = [
    `Translate every Korean user-interface string below into all these languages: ${languageList}.`,
    'Return only a JSON object. Use each language code as a key and an array of strings as its value.',
    'Each language array must have exactly one translation per input in the same order.',
    'Keep meaning, safety instructions, numbers, punctuation, and placeholders unchanged.',
    'Use simple, natural wording for disaster information. Do not add explanations.',
    JSON.stringify(batch),
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: Object.fromEntries(languages.map(language => [language, { type: 'ARRAY', items: { type: 'STRING' } }])),
        required: languages,
      },
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: 'MINIMAL' },
    },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      return translateBatch(batch, attempt + 1);
    }
    const error = new Error(`Translation failed (${response.status}): ${detail}`);
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  const translated = JSON.parse(text || 'null');
  const valid = translated && languages.every(language => Array.isArray(translated[language]) && translated[language].length === batch.length && translated[language].every(value => typeof value === 'string' && value.trim()));
  if (!valid) {
    if (batch.length > 1 && attempt < 2) {
      const middle = Math.ceil(batch.length / 2);
      return [await translateBatch(batch.slice(0, middle), attempt + 1), await translateBatch(batch.slice(middle), attempt + 1)];
    }
    throw new Error(`Translation response did not match ${batch.length} source strings`);
  }
  return Object.fromEntries(languages.map(language => [language, translated[language].map(value => value.trim())]));
}

for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += 1) {
  const batch = chunks[batchIndex];
  if (languages.every(language => batch.every(source => typeof translations[language][source] === 'string'))) continue;
  const translated = await translateBatch(batch);
  languages.forEach(language => batch.forEach((source, index) => { translations[language][source] = translated[language][index]; }));
  await writeFile(checkpointUrl, `${JSON.stringify(translations)}\n`);
  process.stdout.write(`Batch ${batchIndex + 1}/${chunks.length}: ${Object.values(translations).reduce((sum, items) => sum + Object.keys(items).length, 0)} translations\n`);
  const limit = Number(process.env.UI_TRANSLATION_BATCH_LIMIT);
  if (limit > 0 && batchIndex + 1 >= limit) break;
}

await writeFile(new URL('../ui-translations.json', import.meta.url), `${JSON.stringify({ version: 1, languages: translations }, null, 2)}\n`);
process.stdout.write(`Saved ${originals.length} strings for ${languages.length} languages.\n`);
