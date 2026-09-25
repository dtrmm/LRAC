// split_measures.mjs  — v5 (full-render crop + TAB only, multi-track)
//
// Рендерит .gp3/.gp4/.gp5/.gpx/.gp/.gp7/musicxml — ТОЛЬКО TAB стан.
// Все эффекты (слайды, бенды, вибрато) берутся из оригинального GP-файла.
//
// Можно рендерить ОДНУ дорожку или ДВЕ дорожки друг под другом в одной
// картинке такта (например: сверху гитарный рифф, снизу вокальный таб).
// Для этого в trackIndex передаётся список через запятую: "0,1" —
// порядок в списке = порядок сверху вниз (первый индекс — верхняя дорожка).
//
// node split_measures.mjs <song.gp5> [outDir] [trackIndex=0] [scale=1.5] [mp3Path]
//
// Примеры:
//   node split_measures.mjs song.gp5                  # только дорожка 0
//   node split_measures.mjs song.gp5 out 2             # только дорожка 2
//   node split_measures.mjs song.gp5 out 0,1           # дорожка 0 сверху, дорожка 1 снизу
//   node split_measures.mjs song.gp5 out 1,0 1.5 mp3   # дорожка 1 сверху, дорожка 0 снизу + mp3

import * as alphaTab from '@coderline/alphatab';
import * as alphaSkia from '@coderline/alphaskia';
import { Jimp } from 'jimp';
import sharp from 'sharp';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI ──────────────────────────────────────────────────────────────────────
const inputPath  = process.argv[2];
const outDir     = process.argv[3] || 'out';
const trackArg   = process.argv[4] ?? '0';
// "0" -> [0]  (одна дорожка)
// "0,1" -> [0, 1]  (две дорожки: первая = верх, вторая = низ)
const trackIndices = trackArg.split(',').map(s => Number(s.trim()));
const scale      = Number(process.argv[5] ?? 1.5);
const mp3Path    = process.argv[6] || null;

if (!inputPath) {
  console.error('Использование: node split_measures.mjs <song.gp5> [outDir] [trackIndex(es)=0] [scale=1.5] [mp3Path]');
  console.error('  trackIndex(es): одна дорожка "0" или две через запятую "0,1" (первая — сверху, вторая — снизу)');
  process.exit(1);
}
if (trackIndices.some(n => Number.isNaN(n))) {
  console.error('Некорректный trackIndex(es):', trackArg, '— ожидается число или два числа через запятую, например "0,1"');
  process.exit(1);
}
if (trackIndices.length > 2) {
  console.error('Поддерживается максимум 2 дорожки одновременно, получено:', trackIndices.length);
  process.exit(1);
}
if (mp3Path && !fs.existsSync(mp3Path)) { console.error('MP3 не найден:', mp3Path); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

// ─── 1. alphaSkia ─────────────────────────────────────────────────────────────
const FONT_PATH = path.join(__dirname, 'node_modules/@coderline/alphatab/dist/font/Bravura.otf');
alphaTab.Environment.enableAlphaSkia(fs.readFileSync(FONT_PATH).buffer, alphaSkia);

function makeSettings() {
  const s = new alphaTab.Settings();
  s.core.engine            = 'skia';
  s.core.includeNoteBounds = true;
  s.display.layoutMode     = alphaTab.LayoutMode.Page;
  s.display.scale          = scale;
  s.display.staveProfile   = alphaTab.StaveProfile.Tab; // только TAB, без нотного стана
  return s;
}

// ─── 2. Загрузка ──────────────────────────────────────────────────────────────
function loadScore(filePath, settings) {
  if (filePath.endsWith('.tex')) {
    const imp = new alphaTab.importer.AlphaTexImporter();
    imp.initFromString(fs.readFileSync(filePath, 'utf-8').trim(), settings);
    return imp.readScore();
  }
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(fs.readFileSync(filePath)), settings
  );
}

const settings = makeSettings();
const score    = loadScore(inputPath, settings);
const rawTitle  = score.title || path.basename(inputPath, path.extname(inputPath)) || 'measure';
const safeTitle = rawTitle.replace(/[^\w\-\u0400-\u04FF ]/g, '').trim().replace(/\s+/g, '_') || 'measure';

console.log(`📄 "${score.title || '(без названия)'}" → файлы: "${safeTitle}_NNN.png"`);
console.log(`🎵 Тактов: ${score.masterBars.length}`);
console.log(`🎸 Дорожки в файле:`);
score.tracks.forEach((t, i) => console.log(`   [${i}] ${t.name || '(без имени)'}`));

for (const idx of trackIndices) {
  if (idx < 0 || idx >= score.tracks.length) {
    console.error(`\n❌ Дорожка с индексом ${idx} не существует (всего дорожек: ${score.tracks.length}).`);
    process.exit(1);
  }
}
console.log(
  trackIndices.length === 2
    ? `➡️  Рендерим 2 дорожки в одной карточке: сверху [${trackIndices[0]}] "${score.tracks[trackIndices[0]].name}", снизу [${trackIndices[1]}] "${score.tracks[trackIndices[1]].name}"`
    : `➡️  Рендерим 1 дорожку: [${trackIndices[0]}] "${score.tracks[trackIndices[0]].name}"`
);

// ─── 3. Полный рендер ─────────────────────────────────────────────────────────
function renderToPng(scoreObj, width) {
  const renderer = new alphaTab.rendering.ScoreRenderer(settings);
  renderer.width = width;
  let ids = [];
  renderer.preRender.on(() => { ids = []; });
  renderer.partialLayoutFinished.on(r => ids.push(r.id));
  const canvas = new alphaSkia.AlphaSkiaCanvas();
  renderer.renderFinished.on(r => {
    canvas.beginRender(r.totalWidth, r.totalHeight);
    canvas.color = alphaSkia.AlphaSkiaCanvas.rgbaToColor(255, 255, 255, 255);
    canvas.fillRect(0, 0, r.totalWidth, r.totalHeight);
    for (const id of ids) renderer.renderResult(id);
  });
  renderer.partialRenderFinished.on(r => {
    canvas.drawImage(r.renderResult, r.x, r.y, r.width, r.height);
    r.renderResult[Symbol.dispose]();
  });
  // alphaTab рендерит дорожки в ТОМ ЖЕ ПОРЯДКЕ, в котором даны индексы —
  // первая дорожка в trackIndices попадает сверху, вторая (если есть) — снизу.
  renderer.renderScore(scoreObj, trackIndices);
  const img   = canvas.endRender();
  const bytes = Buffer.from(img.toPng());
  img[Symbol.dispose](); canvas[Symbol.dispose]();
  return { bytes, boundsLookup: renderer.boundsLookup };
}

const FULL_WIDTH = 1400;
console.log('⏳ Рендеринг полной партитуры...');
const { bytes: fullPng, boundsLookup } = renderToPng(score, FULL_WIDTH);
fs.writeFileSync(path.join(outDir, '_full.png'), fullPng);
console.log('✅ Полный рендер: _full.png');

// ─── 4. Карта темпов ─────────────────────────────────────────────────────────
function buildTempoMap(sc) {
  let tempo = sc.tempo;
  return sc.masterBars.map(mb => {
    if (mb.tempoAutomations?.length) {
      const t = mb.tempoAutomations.find(a => a.type === 0);
      if (t) tempo = t.value;
    }
    return Math.round(tempo);
  });
}
const tempoMap = buildTempoMap(score);

// ─── 5. Обрезка барлайнов ─────────────────────────────────────────────────────
//
// Ключевые наблюдения из анализа реального GP-файла (Jimi.gp):
//
//  ● isFirstOfLine-такты: кроп начинается прямо НА барлайне → барлайн в x=0..2
//  ● Остальные такты: кроп начинается ПОСЛЕ барлайна, но правый барлайн слегка
//    заходит в последние 1-3px.
//  ● Нотные элементы (бенды, дуги слайдов) дают до 32% плотности в отдельных
//    столбцах → старый порог 0.20 их ловил и срезал ноты.
//  ● Барлайн: 38-70%+ плотности в пределах первых/последних 8px кропа.
//
//  РЕШЕНИЕ: искать только в первых/последних EDGE_PX пикселей, порог 0.25.
//  За этой зоной начинаются ноты — туда не заходим.

const BARLINE_THRESHOLD = 0.25;
const EDGE_PX           = 8;

function colDarkRatio(data, w, h, x) {
  let dark = 0;
  for (let y = 0; y < h; y++) {
    const i = (y * w + x) * 4;
    if (data[i] < 80 && data[i+1] < 80 && data[i+2] < 80) dark++;
  }
  return dark / h;
}

// Убираем барлайн справа: сканируем последние EDGE_PX пикселей,
// отрезаем от самого левого плотного столбца до правого края.
async function trimRightBarLine(jimpImg) {
  const { width: w, height: h, data } = jimpImg.bitmap;
  let leftmostBarlineCol = -1;
  for (let x = w - 1; x >= Math.max(0, w - EDGE_PX); x--) {
    if (colDarkRatio(data, w, h, x) >= BARLINE_THRESHOLD) leftmostBarlineCol = x;
  }
  if (leftmostBarlineCol < 0) return jimpImg;
  return jimpImg.crop({ x: 0, y: 0, w: leftmostBarlineCol, h });
}

// Убираем барлайн слева: сканируем первые EDGE_PX пикселей,
// отрезаем от x=0 до самого правого плотного столбца включительно.
async function trimLeftBarLine(jimpImg) {
  const { width: w, height: h, data } = jimpImg.bitmap;
  let rightmostBarlineCol = -1;
  for (let x = 0; x < Math.min(w, EDGE_PX); x++) {
    if (colDarkRatio(data, w, h, x) >= BARLINE_THRESHOLD) rightmostBarlineCol = x;
  }
  if (rightmostBarlineCol < 0) return jimpImg;
  const newX = rightmostBarlineCol + 1;
  return newX < w ? jimpImg.crop({ x: newX, y: 0, w: w - newX, h }) : jimpImg;
}

// ─── 6. Темп/метр overlay (Sharp + SVG, левый нижний угол) ─────────────────
// Применяется ко ВСЕМ тактам — так каждая карточка гарантированно имеет
// темп и метр. Текст размещается в НИЖНЕМ ЛЕВОМ углу (ниже последней линии
// стана, там есть свободное пространство ~30-60px). Фон прозрачный.
async function addHeaderOverlay(pngBuf, bpm, tsNum, tsDen) {
  const meta = await sharp(pngBuf).metadata();
  const imgW = meta.width, imgH = meta.height;

  // Шрифты: пропорциональны высоте изображения
  const bpmFz = Math.max(7,  Math.round(imgH * 0.038));  // ~10px при h=264
  const tsFz  = Math.max(10, Math.round(imgH * 0.056));  // ~15px при h=264

  // Позиции снизу вверх (y = baseline текста в SVG)
  const margin  = 5;
  const tsDenY  = imgH - margin;           // знаменатель у самого дна
  const tsNumY  = tsDenY - tsFz - 2;       // числитель над знаменателем
  const bpmY    = tsNumY - bpmFz - 4;      // темп над размером

  // Прозрачный SVG — нет фонового прямоугольника, только текст
  const svg = Buffer.from(
    `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="4" y="${bpmY}"   font-family="Georgia,serif" font-size="${bpmFz}" fill="#444">&#x2669;=${bpm}</text>` +
    `<text x="4" y="${tsNumY}" font-family="Georgia,serif" font-size="${tsFz}"  font-weight="bold" fill="#222">${tsNum}</text>` +
    `<text x="4" y="${tsDenY}" font-family="Georgia,serif" font-size="${tsFz}"  font-weight="bold" fill="#222">${tsDen}</text>` +
    `</svg>`
  );

  return await sharp(pngBuf)
    .composite([{ input: svg, left: 0, top: 0 }])
    .png().toBuffer();
}

// ─── 7. Нарезка тактов ───────────────────────────────────────────────────────
// Вертикальные границы кропа каждого такта = [sysY - TOP_PAD, sysY + sysH + BOT_PAD],
// где sysY/sysH — это system.realBounds.y/.h из boundsLookup. Важно: когда рендерятся
// 2 дорожки (trackIndices.length === 2), alphaTab сам увеличивает высоту system
// (sysH) так, чтобы в неё поместились ОБЕ дорожки — верхняя и нижняя дорожки
// вырезаются автоматически, отдельно ничего сшивать не нужно.
//
// ЕСЛИ НИЖНЯЯ ДОРОЖКА ОБРЕЗАЕТСЯ (не помещается в карточку) — увеличивай BOT_PAD.
// ЕСЛИ ВЕРХНЯЯ ДОРОЖКА / ТЕМП НЕ ПОМЕЩАЮТСЯ СВЕРХУ — увеличивай TOP_PAD.
//
//   TOP_PAD — берём с запасом чтобы захватить темп/заголовок над стаффом
//   BOT_PAD — минимальный, чтобы не попал watermark alphaTab;
//             при 2 дорожках может понадобиться значение побольше (например 20-40),
//             т.к. подпись темпа/метра (addHeaderOverlay) рисуется поверх низа
//             картинки и может перекрыть нижнюю дорожку, если места мало.
const TOP_PAD = Math.round(30 * scale);  // ~45px при scale=1.5
const BOT_PAD = 14;  // увеличен — нужно место для текста темп/метра снизу

const fullImg = await Jimp.read(path.join(outDir, '_full.png'));
const imgW    = fullImg.width;
const imgH    = fullImg.height;






const measures = [];
for (const system of boundsLookup.staffSystems) {
  const sysY     = system.realBounds.y;
  const sysH     = system.realBounds.h;
  const sysRight = system.realBounds.x + system.realBounds.w;
  const sorted   = system.bars.slice().sort((a, b) => a.realBounds.x - b.realBounds.x);
  for (let i = 0; i < sorted.length; i++) {
    const mb   = sorted[i];
    const next = sorted[i + 1];
    // левая граница: mb.realBounds.x — исключает системную скобку
    const leftX  = mb.realBounds.x;
    const rightX = next ? next.realBounds.x : sysRight;
    const cropY  = Math.max(0, Math.floor(sysY - TOP_PAD));
    const cropH  = Math.min(
      Math.min(imgH) - cropY,
      Math.ceil(sysH + TOP_PAD + BOT_PAD)
    );
    measures.push({
      index: mb.index,
      isFirstOfLine: mb.isFirstOfLine,
      x: Math.max(0, Math.floor(leftX)),
      y: cropY,
      w: Math.min(imgW, Math.ceil(rightX - leftX)),
      h: cropH,
    });
  }
}
measures.sort((a, b) => a.index - b.index);

console.log(`\n⏳ Нарезка ${measures.length} тактов...`);
const fileNames = [];

for (const m of measures) {
  const safeCropW = Math.min(m.w, imgW - m.x);
  const safeCropH = Math.min(m.h, imgH - m.y);
  if (safeCropW <= 0 || safeCropH <= 0) continue;

  let cropped = fullImg.clone().crop({ x: m.x, y: m.y, w: safeCropW, h: safeCropH });

  // Убираем левый и правый барлайны
  cropped = await trimLeftBarLine(cropped);
  cropped = await trimRightBarLine(cropped);

  let buf = await cropped.getBuffer('image/png');

  // Добавляем темп/метр на ВСЕ такты (внизу слева — не перекрывает ноты)
  {
    const mb  = score.masterBars[m.index];
    const bpm = tempoMap[m.index];
    try {
      buf = await addHeaderOverlay(buf, bpm, mb.timeSignatureNumerator, mb.timeSignatureDenominator);
    } catch (e) {
      console.warn(`\n  ⚠️  Overlay не удался для такта ${m.index + 1}: ${e.message}`);
    }
  }

  const fileName = `${safeTitle}_${String(m.index + 1).padStart(3, '0')}.png`;
  fs.writeFileSync(path.join(outDir, fileName), buf);
  fileNames.push({ index: m.index, fileName });
  process.stdout.write(`\r  ✔ ${m.index + 1}/${score.masterBars.length}`);
}
console.log('\n');

// ─── 8. Нарезка MP3 ──────────────────────────────────────────────────────────
function buildTimings(sc, tMap) {
  let t = 0;
  return sc.masterBars.map((mb, i) => {
    const bpm = tMap[i];
    const dur = mb.timeSignatureNumerator * (60 / bpm) * (4 / mb.timeSignatureDenominator);
    const start = t; t += dur;
    return { startSec: start, durationSec: dur };
  });
}

const mp3FileNames = new Array(score.masterBars.length).fill(null);
if (mp3Path) {
  const timings = buildTimings(score, tempoMap);
  console.log('✂️  Нарезка MP3...');
  for (const { index: i, fileName: imgFile } of fileNames) {
    const t    = timings[i];
    const name = imgFile.replace('.png', '.mp3');
    const out  = path.join(outDir, name);
    try {
      execSync(
        `ffmpeg -y -loglevel error ` +
        `-i "${mp3Path}" -ss ${t.startSec.toFixed(6)} ` +
        `-t ${t.durationSec.toFixed(6)} ` +
        `"${out}"`,
        { stdio: 'pipe' }
      );
      mp3FileNames[i] = name;
      process.stdout.write(`\r  ✔ ${i + 1}/${score.masterBars.length}`);
    } catch (e) { console.warn(`\n  ⚠️  Такт ${i + 1}: MP3 — ${e.message}`); }
  }
  console.log('\n');
}

// ─── 9. Cloze ─────────────────────────────────────────────────────────────────
const clozeText = fileNames.map(({ index: i, fileName: fn }, ordinal) => {
  const img = `<img src="${fn}">`;
  const snd = mp3FileNames[i] ? `[sound:${mp3FileNames[i]}]` : '';
  return `{{c${ordinal + 1}::${img}${snd}}}`;
}).join(' ');
fs.writeFileSync(path.join(outDir, '_cloze.txt'), clozeText);

console.log(`✅ Готово: ${fileNames.length} тактов → "${outDir}/"`);
if (mp3Path) console.log(`🎧 MP3: ${mp3FileNames.filter(Boolean).length}/${score.masterBars.length}`);
console.log(`📋 Cloze: ${path.join(outDir, '_cloze.txt')}`);
