// Тянет товары сообщества VK, скачивает фото в img/market и пишет kits.json.
// Запуск: VK_TOKEN=... node scripts/fetch-kits.mjs  (Node 18+)
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GROUP_ID = 211294353;          // vk.com/market-211294353
const OWNER_ID = -GROUP_ID;
const API_VERSION = '5.199';
const IMG_DIR = 'img/market';
const MAX_IMG_WIDTH = 1280;          // берём самый большой размер, но не больше этого
const TOKEN = process.env.VK_TOKEN;

if (!TOKEN) {
  console.error('Не задан VK_TOKEN (секрет репозитория).');
  process.exit(1);
}

async function vk(method, params = {}) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('access_token', TOKEN);
  url.searchParams.set('v', API_VERSION);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.error_code} ${json.error.error_msg}`);
  return json.response;
}

// 1) список товаров постранично
async function fetchList() {
  const items = [];
  for (let offset = 0; ; offset += 200) {
    const r = await vk('market.get', { owner_id: OWNER_ID, count: 200, offset, extended: 1 });
    items.push(...r.items);
    if (offset + 200 >= r.count || r.items.length === 0) break;
  }
  return items.filter(i => i.availability === 0); // 0 = товар доступен
}

// 2) полные карточки (в них фото в нескольких размерах); при сбое остаёмся на данных из списка
async function fetchFull(list) {
  const full = new Map();
  try {
    for (let i = 0; i < list.length; i += 100) {
      const ids = list.slice(i, i + 100).map(x => `${OWNER_ID}_${x.id}`).join(',');
      const r = await vk('market.getById', { item_ids: ids, extended: 1 });
      for (const it of r.items ?? r) full.set(it.id, it);
    }
  } catch (e) {
    console.warn('market.getById не сработал, беру миниатюры из списка:', e.message);
  }
  return full;
}

function pickPhoto(item) {
  const photo = item.photos?.[0];
  if (photo?.sizes?.length) {
    const sorted = [...photo.sizes].sort((a, b) => b.width - a.width);
    const best = sorted.find(s => s.width <= MAX_IMG_WIDTH) ?? sorted[sorted.length - 1];
    return { url: best.url, key: photo.id ?? item.id };
  }
  if (item.thumb_photo) return { url: item.thumb_photo, key: 't' };
  return null;
}

async function downloadTo(file, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`фото ${url}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const clean = (t = '') => String(t).replace(/\r/g, '').trim();

async function main() {
  await mkdir(IMG_DIR, { recursive: true });
  const list = await fetchList();
  const full = await fetchFull(list);
  const existing = new Set(await readdir(IMG_DIR));
  const used = new Set();
  const out = [];

  for (const base of list) {
    const item = full.get(base.id) ?? base;
    const photo = pickPhoto(item) ?? pickPhoto(base);
    let image = null;
    if (photo) {
      const name = `${item.id}_${photo.key}.jpg`;
      const file = path.posix.join(IMG_DIR, name);
      used.add(name);
      if (!existing.has(name)) {
        try { await downloadTo(file, photo.url); } catch (e) { console.warn(e.message); }
      }
      image = file;
    }
    out.push({
      id: item.id,
      title: clean(item.title),
      description: clean(item.description).slice(0, 600),
      price: item.price?.text ?? '',
      image,
      url: `https://vk.com/market-${GROUP_ID}?w=product-${GROUP_ID}_${item.id}`,
    });
  }

  // удаляем фото товаров, которых больше нет
  for (const name of existing) if (!used.has(name)) await unlink(path.join(IMG_DIR, name));

  await writeFile('kits.json', JSON.stringify({ items: out }, null, 2) + '\n');
  console.log(`Готово: ${out.length} товаров.`);
}

main().catch(e => { console.error(e); process.exit(1); });
