/* ==========================================================================
   拍照快速記帳 - 前端邏輯
   資料全部存在手機瀏覽器的 IndexedDB,不接伺服器資料庫。
   OCR 辨識才會呼叫伺服器 /api/ocr,辨識完的文字仍是在手機上手動確認/存檔。
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* IndexedDB 存取層                                                        */
/* ---------------------------------------------------------------------- */
const DB_NAME = 'receipt_ledger_db';
const DB_VERSION = 2;
const RECORDS_STORE = 'records';
const CATEGORIES_STORE = 'categories';

const DEFAULT_CATEGORIES = [
  { name: '餐飲', nameEn: 'Food', icon: '🍜', color: '#D9C1B8', type: 'expense', keywords: ['cafe', 'restaurant', 'food', 'kitchen', 'maccas', 'mcdonald', 'kfc', 'coffee', 'pizza', 'sushi', 'bakery', 'noodle'] },
  { name: '交通', nameEn: 'Transport', icon: '🚗', color: '#7A8B99', type: 'expense', keywords: ['shell', 'bp', 'caltex', 'ampol', 'uber', 'taxi', 'fuel', 'petrol', 'parking', 'metro', 'train', '7-eleven', 'express'] },
  { name: '超市/日用品', nameEn: 'Groceries', icon: '🛒', color: '#A8B5A0', type: 'expense', keywords: ['coles', 'woolworths', 'aldi', 'iga', 'supermarket'] },
  { name: '購物', nameEn: 'Shopping', icon: '🛍️', color: '#C9B58C', type: 'expense', keywords: ['kmart', 'target', 'uniqlo', 'myer', 'david jones', 'amazon', 'big w'] },
  { name: '娛樂', nameEn: 'Entertainment', icon: '🎬', color: '#A79BB0', type: 'expense', keywords: ['cinema', 'netflix', 'spotify', 'event', 'ticket'] },
  { name: '醫療', nameEn: 'Health', icon: '💊', color: '#8FA8A0', type: 'expense', keywords: ['pharmacy', 'chemist', 'clinic', 'hospital', 'doctor'] },
  { name: '居家帳單', nameEn: 'Bills', icon: '🏠', color: '#B8A99A', type: 'expense', keywords: ['electricity', 'water', 'gas', 'rent', 'internet', 'telstra', 'optus'] },
  { name: '其他', nameEn: 'Other', icon: '📦', color: '#ADA79E', type: 'expense', keywords: [] },
  { name: '薪水', nameEn: 'Salary', icon: '💰', color: '#8FA57C', type: 'income', keywords: [] },
  { name: '退款', nameEn: 'Refund', icon: '↩️', color: '#93A9B8', type: 'income', keywords: ['refund'] },
  { name: '其他收入', nameEn: 'Other Income', icon: '📥', color: '#B0A8AE', type: 'income', keywords: [] },
];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        const store = db.createObjectStore(RECORDS_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(CATEGORIES_STORE)) {
        const catStore = db.createObjectStore(CATEGORIES_STORE, { keyPath: 'id', autoIncrement: true });
        DEFAULT_CATEGORIES.forEach(cat => catStore.add(cat));
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function addRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readwrite');
    const req = tx.objectStore(RECORDS_STORE).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updateRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readwrite');
    const req = tx.objectStore(RECORDS_STORE).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readwrite');
    tx.objectStore(RECORDS_STORE).delete(id);
    txDone(tx).then(resolve).catch(reject);
  });
}

async function getAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readonly');
    const req = tx.objectStore(RECORDS_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllCategories() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CATEGORIES_STORE, 'readonly');
    const req = tx.objectStore(CATEGORIES_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addCategory(category) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CATEGORIES_STORE, 'readwrite');
    const req = tx.objectStore(CATEGORIES_STORE).add(category);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------------------- */
/* 共用小工具                                                              */
/* ---------------------------------------------------------------------- */
let allCategories = [];

async function refreshCategoriesCache() {
  allCategories = await getAllCategories();
  return allCategories;
}

function categoryById(id) {
  if (id === null || id === undefined) return null;
  return allCategories.find(c => c.id === id) || null;
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toFixed(2);
}

function parseDateParts(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: m, day: d };
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function guessCategory(merchantText, type) {
  const text = (merchantText || '').toLowerCase();
  if (!text) return null;
  const candidates = allCategories.filter(c => c.type === type);
  for (const cat of candidates) {
    for (const kw of (cat.keywords || [])) {
      if (kw && text.includes(kw.toLowerCase())) return cat.id;
    }
  }
  return null;
}

function populateCategorySelect(selectEl, type, selectedId) {
  const options = allCategories.filter(c => c.type === type);
  selectEl.innerHTML = '';

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '未分類 (Uncategorized)';
  selectEl.appendChild(noneOpt);

  options.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = String(cat.id);
    opt.textContent = `${cat.icon} ${cat.name} (${cat.nameEn || ''})`;
    selectEl.appendChild(opt);
  });

  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ 新增分類 New Category';
  selectEl.appendChild(newOpt);

  selectEl.value = selectedId !== null && selectedId !== undefined ? String(selectedId) : '';
}

/* ---------------------------------------------------------------------- */
/* 新增分類 Modal                                                          */
/* ---------------------------------------------------------------------- */
const categoryModal = document.getElementById('categoryModal');
const newCategoryIcon = document.getElementById('newCategoryIcon');
const newCategoryName = document.getElementById('newCategoryName');
const newCategoryColor = document.getElementById('newCategoryColor');
const newCategoryConfirmBtn = document.getElementById('newCategoryConfirmBtn');
const newCategoryCancelBtn = document.getElementById('newCategoryCancelBtn');

let categoryModalResolver = null;
let categoryModalType = 'expense';

function openCategoryModal(type) {
  categoryModalType = type;
  newCategoryIcon.value = '';
  newCategoryName.value = '';
  newCategoryColor.value = '#A8B5A0';
  categoryModal.style.display = 'flex';
  return new Promise(resolve => { categoryModalResolver = resolve; });
}

newCategoryConfirmBtn.addEventListener('click', async () => {
  const name = newCategoryName.value.trim();
  if (!name) {
    newCategoryName.focus();
    return;
  }
  const newCat = {
    name,
    nameEn: '',
    icon: newCategoryIcon.value.trim() || '🏷️',
    color: newCategoryColor.value,
    type: categoryModalType,
    keywords: [],
  };
  const id = await addCategory(newCat);
  categoryModal.style.display = 'none';
  if (categoryModalResolver) categoryModalResolver(id);
});

newCategoryCancelBtn.addEventListener('click', () => {
  categoryModal.style.display = 'none';
  if (categoryModalResolver) categoryModalResolver(null);
});

async function handleCategorySelectChange(selectEl, type) {
  if (selectEl.value === '__new__') {
    const newId = await openCategoryModal(type);
    await refreshCategoriesCache();
    populateCategorySelect(selectEl, type, newId || '');
  }
}

/* ---------------------------------------------------------------------- */
/* 導航切換 (總覽 / 新增紀錄 / 紀錄)                                        */
/* ---------------------------------------------------------------------- */
const navButtons = document.querySelectorAll('.nav-btn');
const dashboardView = document.getElementById('dashboardView');
const addView = document.getElementById('addView');
const ledgerView = document.getElementById('ledgerView');

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    navButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    dashboardView.style.display = view === 'dashboard' ? 'block' : 'none';
    addView.style.display = view === 'add' ? 'block' : 'none';
    ledgerView.style.display = view === 'ledger' ? 'block' : 'none';
    if (view === 'dashboard') renderDashboard();
    if (view === 'ledger') renderLedger();
  });
});

/* 新增紀錄:拍照辨識 / 手動輸入 子分頁 */
const addTabButtons = document.querySelectorAll('.tab-btn[data-addtab]');
const scanSubView = document.getElementById('scanSubView');
const manualSubView = document.getElementById('manualSubView');

addTabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    addTabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.addtab;
    scanSubView.style.display = tab === 'scan' ? 'block' : 'none';
    manualSubView.style.display = tab === 'manual' ? 'block' : 'none';
    document.getElementById('saveRecordSection').style.display = 'none';
  });
});

/* ---------------------------------------------------------------------- */
/* 拍照辨識                                                                */
/* ---------------------------------------------------------------------- */
const cameraBtn = document.getElementById('cameraBtn');
const galleryBtn = document.getElementById('galleryBtn');
const cameraInput = document.getElementById('cameraInput');
const galleryInput = document.getElementById('galleryInput');
const statusEl = document.getElementById('status');
const emptyHint = document.getElementById('emptyHint');
const resultSection = document.getElementById('resultSection');
const listSection = document.getElementById('listSection');
const originalImg = document.getElementById('originalImg');
const visImg = document.getElementById('visImg');
const lineList = document.getElementById('lineList');
const lineCount = document.getElementById('lineCount');
const copyBtn = document.getElementById('copyBtn');
const jsonBtn = document.getElementById('jsonBtn');
const imgTabButtons = document.querySelectorAll('.tab-btn[data-imgtab]');

const saveRecordSection = document.getElementById('saveRecordSection');
const amountInput = document.getElementById('amountInput');
const merchantInput = document.getElementById('merchantInput');
const categorySelect = document.getElementById('categorySelect');
const dateInput = document.getElementById('dateInput');
const noteInput = document.getElementById('noteInput');
const saveRecordBtn = document.getElementById('saveRecordBtn');
const saveStatusEl = document.getElementById('saveStatus');

let lastPages = null;
let currentFile = null;

cameraBtn.addEventListener('click', () => cameraInput.click());
galleryBtn.addEventListener('click', () => galleryInput.click());
cameraInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
galleryInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

imgTabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    imgTabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.imgtab === 'original') {
      originalImg.style.display = 'block';
      visImg.style.display = 'none';
    } else {
      originalImg.style.display = 'none';
      visImg.style.display = 'block';
    }
  });
});

function setStatus(zh, en = '', isError = false) {
  statusEl.innerHTML = en ? `${zh}<span class="status-en">${en}</span>` : zh;
  statusEl.classList.toggle('error', isError);
}

function confClass(score) {
  if (score === null || score === undefined) return 'conf-mid';
  if (score >= 0.95) return 'conf-high';
  if (score >= 0.8) return 'conf-mid';
  return 'conf-low';
}

async function handleFile(file) {
  if (!file) return;
  currentFile = file;

  emptyHint.style.display = 'none';
  resultSection.style.display = 'block';
  listSection.style.display = 'none';
  saveRecordSection.style.display = 'none';
  saveStatusEl.textContent = '';
  originalImg.src = URL.createObjectURL(file);
  originalImg.style.display = 'block';
  visImg.style.display = 'none';
  imgTabButtons.forEach(b => b.classList.remove('active'));
  imgTabButtons[0].classList.add('active');

  setStatus('辨識中,請稍候(第一次可能需要幾十秒暖機)...', 'Recognizing, please wait (first run may take tens of seconds)...');

  const formData = new FormData();
  formData.append('file', file, file.name || 'photo.jpg');

  try {
    const resp = await fetch('/api/ocr', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '辨識失敗');

    lastPages = data.pages;
    if (data.vis_image_url) visImg.src = data.vis_image_url;

    renderLines(data.pages);
    await prefillSaveForm(data.pages);
    setStatus('辨識完成 ✓', 'Done ✓');
  } catch (err) {
    setStatus('發生錯誤: ' + err.message, 'Error: ' + err.message, true);
  }
}

function renderLines(pages) {
  const lines = (pages || []).flatMap(p => p.lines || []);
  lineCount.innerHTML = `共 ${lines.length} 行 <span class="en-inline">(${lines.length} lines)</span>`;
  lineList.innerHTML = '';

  if (lines.length === 0) {
    lineList.innerHTML = '<p style="color:var(--muted);">沒有偵測到文字<br><span class="status-en">No text detected</span></p>';
  }

  lines.forEach(line => {
    const row = document.createElement('div');
    row.className = 'line-item';
    const textEl = document.createElement('div');
    textEl.className = 'line-text';
    textEl.textContent = line.text;
    const badge = document.createElement('span');
    badge.className = 'confidence-badge ' + confClass(line.confidence);
    badge.textContent = line.confidence !== null && line.confidence !== undefined
      ? (line.confidence * 100).toFixed(1) + '%'
      : 'N/A';
    row.appendChild(textEl);
    row.appendChild(badge);
    lineList.appendChild(row);
  });

  listSection.style.display = 'block';
}

copyBtn.addEventListener('click', () => {
  if (!lastPages) return;
  const text = lastPages.flatMap(p => (p.lines || []).map(l => l.text)).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    setStatus('已複製全部文字到剪貼簿 ✓', 'Copied all text to clipboard ✓');
  }).catch(() => {
    setStatus('複製失敗,請手動選取文字', 'Copy failed, please select the text manually', true);
  });
});

jsonBtn.addEventListener('click', () => {
  if (!lastPages) return;
  const win = window.open('', '_blank');
  win.document.write('<pre style="white-space:pre-wrap;word-break:break-all;padding:16px;">' +
    JSON.stringify(lastPages, null, 2).replace(/</g, '&lt;') + '</pre>');
});

/* ---------------------------------------------------------------------- */
/* 金額/日期規則猜測(不用 LLM)                                             */
/* ---------------------------------------------------------------------- */
function extractMoney(text) {
  const m = text.replace(/,/g, '').match(/\$?\s?(\d{1,4}\.\d{2})\b/);
  return m ? parseFloat(m[1]) : null;
}

function lineCenterY(line) {
  if (!line.box || line.box.length === 0) return null;
  const ys = line.box.map(p => p[1]);
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

function guessAmount(lines) {
  const moneyLines = lines.map(l => ({ line: l, value: extractMoney(l.text) })).filter(x => x.value !== null);
  if (moneyLines.length === 0) return '';

  const totalLabelLines = lines.filter(l => /\btotal\b/i.test(l.text));
  if (totalLabelLines.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const label of totalLabelLines) {
      const labelY = lineCenterY(label);
      if (labelY === null) continue;
      for (const m of moneyLines) {
        const y = lineCenterY(m.line);
        if (y === null) continue;
        const dist = Math.abs(y - labelY);
        if (dist < bestDist) { bestDist = dist; best = m; }
      }
    }
    if (best && bestDist < 80) return best.value.toFixed(2);
  }

  const max = moneyLines.reduce((a, b) => (b.value > a.value ? b : a));
  return max.value.toFixed(2);
}

function guessDateISO(lines) {
  const dateRegex = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/;
  for (const line of lines) {
    const m = line.text.match(dateRegex);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
      d = d.padStart(2, '0');
      mo = mo.padStart(2, '0');
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}-${mo}-${d}`;
    }
  }
  return todayISO();
}

function guessMerchant(lines) {
  const candidate = lines.find(l => l.text && l.text.trim().length >= 2);
  return candidate ? candidate.text.trim() : '';
}

async function prefillSaveForm(pages) {
  const lines = (pages || []).flatMap(p => p.lines || []);
  const merchantGuess = guessMerchant(lines);

  amountInput.value = guessAmount(lines);
  merchantInput.value = merchantGuess;
  dateInput.value = guessDateISO(lines);
  noteInput.value = '';

  await refreshCategoriesCache();
  const guessedCatId = guessCategory(merchantGuess, 'expense');
  populateCategorySelect(categorySelect, 'expense', guessedCatId);

  saveRecordSection.style.display = 'block';
}

categorySelect.addEventListener('change', () => handleCategorySelectChange(categorySelect, 'expense'));

/* ---------------------------------------------------------------------- */
/* 產生照片(壓縮後存進 IndexedDB,同時作為清單縮圖與詳情頁大圖用)              */
/* ---------------------------------------------------------------------- */
function makePhotoDataUrl(file, maxSize = 900, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxSize) {
        height = Math.round(height * (maxSize / width));
        width = maxSize;
      } else if (height > maxSize) {
        width = Math.round(width * (maxSize / height));
        height = maxSize;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------------------------------------------------------------------- */
/* 儲存紀錄(拍照辨識來源)                                                   */
/* ---------------------------------------------------------------------- */
saveRecordBtn.addEventListener('click', async () => {
  const amount = parseFloat(amountInput.value);
  if (isNaN(amount)) {
    saveStatusEl.textContent = '請輸入有效金額 / Please enter a valid amount';
    saveStatusEl.classList.add('error');
    return;
  }

  saveStatusEl.classList.remove('error');
  saveStatusEl.textContent = '儲存中... / Saving...';

  try {
    const photo = currentFile ? await makePhotoDataUrl(currentFile) : '';
    const ocrText = lastPages ? lastPages.flatMap(p => (p.lines || []).map(l => l.text)).join('\n') : '';
    const categoryId = categorySelect.value ? Number(categorySelect.value) : null;

    await addRecord({
      type: 'expense',
      amount,
      merchant: merchantInput.value.trim() || '(未命名 / Untitled)',
      categoryId,
      date: dateInput.value || todayISO(),
      note: noteInput.value.trim(),
      photo,
      ocrText,
      source: 'scan',
      createdAt: new Date().toISOString(),
    });

    saveStatusEl.textContent = '已存入記帳紀錄 ✓ / Saved to ledger ✓';
  } catch (err) {
    saveStatusEl.textContent = '儲存失敗: ' + err.message;
    saveStatusEl.classList.add('error');
  }
});

/* ---------------------------------------------------------------------- */
/* 手動輸入記帳                                                            */
/* ---------------------------------------------------------------------- */
const manualTypeButtons = document.querySelectorAll('.type-btn[data-type]');
const manualAmountInput = document.getElementById('manualAmountInput');
const manualMerchantInput = document.getElementById('manualMerchantInput');
const manualCategorySelect = document.getElementById('manualCategorySelect');
const manualDateInput = document.getElementById('manualDateInput');
const manualNoteInput = document.getElementById('manualNoteInput');
const manualSaveBtn = document.getElementById('manualSaveBtn');
const manualSaveStatus = document.getElementById('manualSaveStatus');

let manualType = 'expense';

manualTypeButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    manualTypeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    manualType = btn.dataset.type;
    await refreshCategoriesCache();
    populateCategorySelect(manualCategorySelect, manualType, null);
  });
});

manualCategorySelect.addEventListener('change', () => handleCategorySelectChange(manualCategorySelect, manualType));

async function initManualForm() {
  manualDateInput.value = todayISO();
  await refreshCategoriesCache();
  populateCategorySelect(manualCategorySelect, manualType, null);
}

manualSaveBtn.addEventListener('click', async () => {
  const amount = parseFloat(manualAmountInput.value);
  if (isNaN(amount) || amount < 0) {
    manualSaveStatus.textContent = '請輸入有效金額 / Please enter a valid amount';
    manualSaveStatus.classList.add('error');
    return;
  }

  manualSaveStatus.classList.remove('error');
  manualSaveStatus.textContent = '儲存中... / Saving...';

  try {
    const categoryId = manualCategorySelect.value ? Number(manualCategorySelect.value) : null;
    await addRecord({
      type: manualType,
      amount,
      merchant: manualMerchantInput.value.trim() || (manualType === 'income' ? '(未命名收入)' : '(未命名支出)'),
      categoryId,
      date: manualDateInput.value || todayISO(),
      note: manualNoteInput.value.trim(),
      photo: '',
      ocrText: '',
      source: 'manual',
      createdAt: new Date().toISOString(),
    });

    manualSaveStatus.textContent = '已存入記帳紀錄 ✓ / Saved to ledger ✓';
    manualAmountInput.value = '';
    manualMerchantInput.value = '';
    manualNoteInput.value = '';
  } catch (err) {
    manualSaveStatus.textContent = '儲存失敗: ' + err.message;
    manualSaveStatus.classList.add('error');
  }
});

/* ---------------------------------------------------------------------- */
/* 紀錄清單頁:搜尋 / 篩選 / 列表                                            */
/* ---------------------------------------------------------------------- */
const searchInput = document.getElementById('searchInput');
const filterToggleBtn = document.getElementById('filterToggleBtn');
const filterPanel = document.getElementById('filterPanel');
const filterType = document.getElementById('filterType');
const filterCategory = document.getElementById('filterCategory');
const filterDateFrom = document.getElementById('filterDateFrom');
const filterDateTo = document.getElementById('filterDateTo');
const filterAmountMin = document.getElementById('filterAmountMin');
const filterAmountMax = document.getElementById('filterAmountMax');
const filterClearBtn = document.getElementById('filterClearBtn');
const ledgerList = document.getElementById('ledgerList');
const ledgerEmpty = document.getElementById('ledgerEmpty');
const ledgerTotal = document.getElementById('ledgerTotal');
const ledgerCount = document.getElementById('ledgerCount');

filterToggleBtn.addEventListener('click', () => {
  const isOpen = filterPanel.style.display === 'block';
  filterPanel.style.display = isOpen ? 'none' : 'block';
  filterToggleBtn.classList.toggle('active', !isOpen);
});

function populateFilterCategoryOptions() {
  filterCategory.innerHTML = '<option value="all">全部分類 All</option>';
  allCategories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = String(cat.id);
    opt.textContent = `${cat.icon} ${cat.name}`;
    filterCategory.appendChild(opt);
  });
}

[searchInput, filterType, filterCategory, filterDateFrom, filterDateTo, filterAmountMin, filterAmountMax].forEach(el => {
  el.addEventListener('input', () => renderLedger());
  el.addEventListener('change', () => renderLedger());
});

filterClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  filterType.value = 'all';
  filterCategory.value = 'all';
  filterDateFrom.value = '';
  filterDateTo.value = '';
  filterAmountMin.value = '';
  filterAmountMax.value = '';
  renderLedger();
});

function applyFilters(records) {
  const search = searchInput.value.trim().toLowerCase();
  const type = filterType.value;
  const catFilter = filterCategory.value;
  const dateFrom = filterDateFrom.value;
  const dateTo = filterDateTo.value;
  const amountMin = filterAmountMin.value !== '' ? parseFloat(filterAmountMin.value) : null;
  const amountMax = filterAmountMax.value !== '' ? parseFloat(filterAmountMax.value) : null;

  return records.filter(r => {
    if (search) {
      const haystack = `${r.merchant || ''} ${r.note || ''} ${r.ocrText || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (type !== 'all' && (r.type || 'expense') !== type) return false;
    if (catFilter !== 'all') {
      const wantId = catFilter === '' ? null : Number(catFilter);
      if ((r.categoryId ?? null) !== wantId) return false;
    }
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo && r.date > dateTo) return false;
    if (amountMin !== null && (r.amount || 0) < amountMin) return false;
    if (amountMax !== null && (r.amount || 0) > amountMax) return false;
    return true;
  });
}

async function renderLedger() {
  await refreshCategoriesCache();
  populateFilterCategoryOptions();
  // populateFilterCategoryOptions resets value, so restore previous selection if still valid
  const records = await getAllRecords();
  const filtered = applyFilters(records);
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const netTotal = filtered.reduce((sum, r) => {
    const amt = r.amount || 0;
    return sum + ((r.type || 'expense') === 'income' ? amt : -amt);
  }, 0);
  ledgerTotal.textContent = (netTotal < 0 ? '-' : '') + '$' + Math.abs(netTotal).toFixed(2);
  ledgerTotal.style.color = netTotal < 0 ? 'var(--expense-color)' : 'var(--income-color)';
  ledgerCount.innerHTML = `共 ${filtered.length} 筆 <span class="en-inline">(${filtered.length} records)</span>`;

  ledgerList.innerHTML = '';
  ledgerEmpty.style.display = filtered.length === 0 ? 'block' : 'none';

  filtered.forEach(record => {
    const row = document.createElement('div');
    row.className = 'ledger-item';

    const cat = categoryById(record.categoryId);

    if (record.photo) {
      const thumb = document.createElement('img');
      thumb.className = 'ledger-thumb';
      thumb.src = record.photo;
      row.appendChild(thumb);
    } else {
      const iconBox = document.createElement('div');
      iconBox.className = 'ledger-cat-icon';
      iconBox.style.background = cat ? cat.color : 'var(--stone)';
      iconBox.textContent = cat ? cat.icon : '📝';
      row.appendChild(iconBox);
    }

    const info = document.createElement('div');
    info.className = 'ledger-info';
    const merchantEl = document.createElement('div');
    merchantEl.className = 'ledger-merchant';
    merchantEl.textContent = record.merchant || '(未命名)';
    const metaEl = document.createElement('div');
    metaEl.className = 'ledger-meta';
    metaEl.innerHTML = `<span>${record.date || ''}</span>`;
    if (cat) {
      const chip = document.createElement('span');
      chip.className = 'cat-chip';
      chip.style.background = cat.color;
      chip.textContent = `${cat.icon} ${cat.name}`;
      metaEl.appendChild(chip);
    }
    info.appendChild(merchantEl);
    info.appendChild(metaEl);

    const amountEl = document.createElement('div');
    const isIncome = (record.type || 'expense') === 'income';
    amountEl.className = 'ledger-amount ' + (isIncome ? 'income' : 'expense');
    amountEl.textContent = (isIncome ? '+' : '-') + '$' + (record.amount || 0).toFixed(2);

    row.appendChild(info);
    row.appendChild(amountEl);
    row.addEventListener('click', () => openDetailModal(record.id));
    ledgerList.appendChild(row);
  });
}

/* ---------------------------------------------------------------------- */
/* 紀錄詳情 Modal                                                          */
/* ---------------------------------------------------------------------- */
const detailModal = document.getElementById('detailModal');
const detailCloseBtn = document.getElementById('detailCloseBtn');
const detailImage = document.getElementById('detailImage');
const detailNoPhoto = document.getElementById('detailNoPhoto');
const detailType = document.getElementById('detailType');
const detailAmount = document.getElementById('detailAmount');
const detailMerchant = document.getElementById('detailMerchant');
const detailCategory = document.getElementById('detailCategory');
const detailDate = document.getElementById('detailDate');
const detailNote = document.getElementById('detailNote');
const detailOcrDetails = document.getElementById('detailOcrDetails');
const detailOcrText = document.getElementById('detailOcrText');
const detailSaveBtn = document.getElementById('detailSaveBtn');
const detailDeleteBtn = document.getElementById('detailDeleteBtn');
const detailStatus = document.getElementById('detailStatus');

let currentDetailId = null;

async function openDetailModal(id) {
  const records = await getAllRecords();
  const record = records.find(r => r.id === id);
  if (!record) return;
  currentDetailId = id;
  detailStatus.textContent = '';
  detailStatus.classList.remove('error');

  const photo = record.photo || record.thumbnail || '';
  if (photo) {
    detailImage.src = photo;
    detailImage.style.display = 'block';
    detailNoPhoto.style.display = 'none';
  } else {
    detailImage.style.display = 'none';
    detailNoPhoto.style.display = 'block';
  }

  const type = record.type || 'expense';
  detailType.value = type;
  detailAmount.value = record.amount;
  detailMerchant.value = record.merchant || '';
  detailDate.value = record.date || todayISO();
  detailNote.value = record.note || '';

  await refreshCategoriesCache();
  populateCategorySelect(detailCategory, type, record.categoryId ?? null);

  if (record.ocrText) {
    detailOcrDetails.style.display = 'block';
    detailOcrText.textContent = record.ocrText;
  } else {
    detailOcrDetails.style.display = 'none';
  }

  detailModal.style.display = 'flex';
}

detailType.addEventListener('change', async () => {
  await refreshCategoriesCache();
  populateCategorySelect(detailCategory, detailType.value, null);
});

detailCategory.addEventListener('change', () => handleCategorySelectChange(detailCategory, detailType.value));

function closeDetailModal() {
  detailModal.style.display = 'none';
  currentDetailId = null;
}

detailCloseBtn.addEventListener('click', closeDetailModal);
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeDetailModal();
});

detailSaveBtn.addEventListener('click', async () => {
  const amount = parseFloat(detailAmount.value);
  if (isNaN(amount) || amount < 0) {
    detailStatus.textContent = '請輸入有效金額 / Please enter a valid amount';
    detailStatus.classList.add('error');
    return;
  }

  const records = await getAllRecords();
  const record = records.find(r => r.id === currentDetailId);
  if (!record) return;

  record.type = detailType.value;
  record.amount = amount;
  record.merchant = detailMerchant.value.trim() || '(未命名)';
  record.categoryId = detailCategory.value ? Number(detailCategory.value) : null;
  record.date = detailDate.value || todayISO();
  record.note = detailNote.value.trim();

  await updateRecord(record);
  detailStatus.classList.remove('error');
  detailStatus.textContent = '已更新 ✓ / Updated ✓';
  await renderLedger();
  await renderDashboard();
});

detailDeleteBtn.addEventListener('click', async () => {
  if (!confirm('確定要刪除這筆紀錄嗎?\nDelete this record?')) return;
  await deleteRecord(currentDetailId);
  closeDetailModal();
  await renderLedger();
  await renderDashboard();
});

/* ---------------------------------------------------------------------- */
/* Dashboard                                                               */
/* ---------------------------------------------------------------------- */
const monthLabel = document.getElementById('monthLabel');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');
const monthExpenseTotal = document.getElementById('monthExpenseTotal');
const monthExpenseDelta = document.getElementById('monthExpenseDelta');
const monthIncomeTotal = document.getElementById('monthIncomeTotal');
const monthIncomeDelta = document.getElementById('monthIncomeDelta');
const donutChart = document.getElementById('donutChart');
const donutLegend = document.getElementById('donutLegend');
const donutEmpty = document.getElementById('donutEmpty');
const dailyBarChart = document.getElementById('dailyBarChart');
const statsGrid = document.getElementById('statsGrid');

const now = new Date();
let dashYear = now.getFullYear();
let dashMonth = now.getMonth() + 1; // 1-12

prevMonthBtn.addEventListener('click', () => {
  dashMonth--;
  if (dashMonth < 1) { dashMonth = 12; dashYear--; }
  renderDashboard();
});

nextMonthBtn.addEventListener('click', () => {
  dashMonth++;
  if (dashMonth > 12) { dashMonth = 1; dashYear++; }
  renderDashboard();
});

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function filterByMonth(records, year, month) {
  return records.filter(r => {
    const parts = parseDateParts(r.date);
    return parts && parts.year === year && parts.month === month;
  });
}

function computeDelta(current, previous) {
  if (previous === 0) return current === 0 ? null : Infinity;
  return ((current - previous) / previous) * 100;
}

function renderDeltaEl(el, delta) {
  if (delta === null) {
    el.textContent = '';
    el.className = 'summary-card-delta';
    return;
  }
  if (delta === Infinity) {
    el.textContent = '較上月新增';
    el.className = 'summary-card-delta up';
    return;
  }
  const sign = delta >= 0 ? '+' : '';
  el.textContent = `${sign}${delta.toFixed(1)}% 較上月`;
  el.className = 'summary-card-delta ' + (delta >= 0 ? 'up' : 'down');
}

async function renderDashboard() {
  const records = await getAllRecords();
  await refreshCategoriesCache();

  monthLabel.textContent = `${dashYear} 年 ${dashMonth} 月`;

  const thisMonthRecords = filterByMonth(records, dashYear, dashMonth);
  let prevYear = dashYear, prevMonth = dashMonth - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  const prevMonthRecords = filterByMonth(records, prevYear, prevMonth);

  const expenseRecords = thisMonthRecords.filter(r => (r.type || 'expense') === 'expense');
  const incomeRecords = thisMonthRecords.filter(r => r.type === 'income');
  const prevExpenseTotal = prevMonthRecords.filter(r => (r.type || 'expense') === 'expense').reduce((s, r) => s + (r.amount || 0), 0);
  const prevIncomeTotal = prevMonthRecords.filter(r => r.type === 'income').reduce((s, r) => s + (r.amount || 0), 0);

  const expenseTotal = expenseRecords.reduce((s, r) => s + (r.amount || 0), 0);
  const incomeTotal = incomeRecords.reduce((s, r) => s + (r.amount || 0), 0);

  monthExpenseTotal.textContent = fmtMoney(expenseTotal);
  monthIncomeTotal.textContent = fmtMoney(incomeTotal);
  renderDeltaEl(monthExpenseDelta, computeDelta(expenseTotal, prevExpenseTotal));
  renderDeltaEl(monthIncomeDelta, computeDelta(incomeTotal, prevIncomeTotal));

  renderDonutChart(expenseRecords, expenseTotal);
  renderDailyBarChart(expenseRecords, dashYear, dashMonth);
  renderStats(expenseRecords, expenseTotal, dashYear, dashMonth);
}

function renderDonutChart(expenseRecords, expenseTotal) {
  if (expenseRecords.length === 0 || expenseTotal === 0) {
    donutChart.style.background = 'var(--bg)';
    donutLegend.innerHTML = '';
    donutEmpty.style.display = 'block';
    return;
  }
  donutEmpty.style.display = 'none';

  const groups = new Map();
  expenseRecords.forEach(r => {
    const key = r.categoryId ?? 'none';
    if (!groups.has(key)) groups.set(key, 0);
    groups.set(key, groups.get(key) + (r.amount || 0));
  });

  const items = Array.from(groups.entries()).map(([key, amount]) => {
    const cat = key === 'none' ? null : categoryById(Number(key));
    return {
      name: cat ? cat.name : '未分類',
      icon: cat ? cat.icon : '📝',
      color: cat ? cat.color : '#C9C4BC',
      amount,
    };
  }).sort((a, b) => b.amount - a.amount);

  let cumulative = 0;
  const stops = items.map(item => {
    const start = (cumulative / expenseTotal) * 100;
    cumulative += item.amount;
    const end = (cumulative / expenseTotal) * 100;
    return `${item.color} ${start}% ${end}%`;
  }).join(', ');
  donutChart.style.background = `conic-gradient(${stops})`;

  donutLegend.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const pct = ((item.amount / expenseTotal) * 100).toFixed(0);
    row.innerHTML = `
      <span class="legend-dot" style="background:${item.color}"></span>
      <span class="legend-name">${item.icon} ${item.name}</span>
      <span class="legend-amount">${fmtMoney(item.amount)} (${pct}%)</span>
    `;
    donutLegend.appendChild(row);
  });
}

function renderDailyBarChart(expenseRecords, year, month) {
  const totalDays = daysInMonth(year, month);
  const daily = new Array(totalDays).fill(0);
  expenseRecords.forEach(r => {
    const parts = parseDateParts(r.date);
    if (parts) daily[parts.day - 1] += (r.amount || 0);
  });
  const max = Math.max(...daily, 0.01);

  dailyBarChart.innerHTML = '';
  daily.forEach((amount, idx) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const heightPct = Math.max((amount / max) * 100, amount > 0 ? 4 : 0);
    col.title = `${idx + 1} 日: ${fmtMoney(amount)}`;
    col.innerHTML = `<div class="bar-fill" style="height:${heightPct}%"></div><div class="bar-label">${idx + 1}</div>`;
    dailyBarChart.appendChild(col);
  });
}

function renderStats(expenseRecords, expenseTotal, year, month) {
  const amounts = expenseRecords.map(r => r.amount || 0);
  const maxExpense = amounts.length ? Math.max(...amounts) : 0;
  const daysWithRecords = new Set(expenseRecords.map(r => r.date)).size;

  const isCurrentRealMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const divisor = isCurrentRealMonth ? now.getDate() : daysInMonth(year, month);
  const avgDaily = expenseTotal / Math.max(divisor, 1);

  statsGrid.innerHTML = `
    <div class="stat-item">
      <div class="stat-label">最大一筆支出 <span class="field-en">Biggest expense</span></div>
      <div class="stat-value">${fmtMoney(maxExpense)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">平均每日花費 <span class="field-en">Avg / day</span></div>
      <div class="stat-value">${fmtMoney(avgDaily)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">有記帳天數 <span class="field-en">Days recorded</span></div>
      <div class="stat-value">${daysWithRecords} 天</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">紀錄筆數 <span class="field-en">Records</span></div>
      <div class="stat-value">${expenseRecords.length} 筆</div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* 初始化                                                                  */
/* ---------------------------------------------------------------------- */
(async function init() {
  await refreshCategoriesCache();
  await initManualForm();
  await renderDashboard();
})();
