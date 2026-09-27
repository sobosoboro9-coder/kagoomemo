/* =============================================
   カゴメモ - メインスクリプト
   家計簿（収入・支出）・冷蔵庫管理の全機能

   ■ このアプリで使っている主なWeb API
     - Camera API (getUserMedia) … レシート撮影
     - Canvas API                … 撮影画像の取得・グラフ描画
     - SpeechRecognition API      … 音声で支出・食材を入力
     - Web Storage API            … データのローカル保存
     - Web Share API              … レポートのシェア
     - Blob API                   … CSV出力
     - Gemini API (外部)          … レシートのOCR・カテゴリ仕分け
============================================= */

/* =============================================
   ■ 0. 定数・設定
============================================= */

// =============================================
// Gemini APIキーをここに設定する
// 取得方法：https://aistudio.google.com/
// Googleアカウントでログイン→「Get API key」
// クレジットカード不要・無料枠あり
// ★注意：このキーを他人に渡したりGitHub等に公開しないこと
// =============================================
// APIキーはコードに直接書かず、設定画面で入力された値を
// localStorage（キー名 geminiApiKey）から読み込む。
// これにより、公開してもソースコードにキーが残らない。
function getGeminiApiKey() {
  return load('geminiApiKey', '') || '';
}

// 支出カテゴリ定義（家計簿・仕分けで共通使用）
const CATEGORIES = {
  food:      { label: '🥦 食料品',       color: '#f97316', budgetKey: 'budgetFood' },
  daily:     { label: '🧴 日用品',       color: '#fbbf24', budgetKey: 'budgetDaily' },
  medicine:  { label: '💊 医薬品・衛生', color: '#34d399', budgetKey: 'budgetMedicine' },
  electric:  { label: '💡 家電・雑貨',   color: '#60a5fa', budgetKey: 'budgetElectric' },
  transport: { label: '🚃 交通費',       color: '#a78bfa', budgetKey: 'budgetTransport' },
  fixed:     { label: '🏠 固定費',       color: '#f472b6', budgetKey: 'budgetFixed' },
  other:     { label: '📦 その他',       color: '#d1d5db', budgetKey: 'budgetOther' },
};

// 収入カテゴリ定義
const INCOME_CATEGORIES = {
  salary:       { label: '💼 給料・バイト代' },
  allowance:    { label: '🎁 お小遣い・仕送り' },
  bonus:        { label: '✨ 臨時収入' },
  other_income: { label: '📦 その他' },
};

// Geminiカテゴリ名→内部キーの変換マップ
const CATEGORY_MAP = {
  '食料品': 'food', '食品': 'food', '食材': 'food',
  '日用品': 'daily', '生活用品': 'daily',
  '医薬品': 'medicine', '衛生用品': 'medicine', '医薬品・衛生用品': 'medicine',
  '家電': 'electric', '雑貨': 'electric', '家電・雑貨': 'electric',
  '交通費': 'transport',
  '固定費': 'fixed',
  'その他': 'other',
};

// 読み取り結果を一時保存する変数
let lastReceiptResult = null;
// 連続読み取りキュー
let receiptQueue = [];

/* =============================================
   ■ 1. ユーティリティ
============================================= */

function showStatus(id, msg, type = 'info', duration = 4000) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="status-msg ${type}">${msg}</div>`;
  if (duration > 0) setTimeout(() => { el.innerHTML = ''; }, duration);
}

// Web Storage API：データを保存
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// Web Storage API：データを読み込み
function load(key, def = null) {
  const d = localStorage.getItem(key);
  if (!d) return def;
  try { return JSON.parse(d); } catch { return def; }
}

function today() {
  return new Date().toLocaleDateString('ja-JP');
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function monthLabel() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/* =============================================
   ■ 2. タブ切り替え
============================================= */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

/* =============================================
   ■ 3. 音声入力ユーティリティ（SpeechRecognition API）
============================================= */
function startSpeechRecognition(statusId, onResult) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showStatus(statusId, '❌ このブラウザは音声認識に対応していません', 'error');
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = false;
  recognition.interimResults = false;
  document.getElementById(statusId).innerHTML =
    '<span class="mic-indicator"></span>話しかけてください...';
  recognition.start();
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    document.getElementById(statusId).innerHTML = '';
    onResult(text);
  };
  recognition.onerror = () => {
    showStatus(statusId, '❌ 音声認識に失敗しました', 'error');
  };
  recognition.onend = () => {
    const el = document.getElementById(statusId);
    if (el && el.querySelector('.mic-indicator')) el.innerHTML = '';
  };
}

/* =============================================
   ■ 4. カメラユーティリティ（Camera API）
============================================= */
async function startCamera(videoId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }
  });
  const video = document.getElementById(videoId);
  video.srcObject = stream;
  return stream;
}

function stopCamera(stream, videoId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  const video = document.getElementById(videoId);
  if (video) video.srcObject = null;
}

// Canvas APIでビデオフレームをキャプチャ
function captureFrame(videoId, canvasId) {
  const video = document.getElementById(videoId);
  const canvas = document.getElementById(canvasId);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg');
}

/* =============================================
   ■ 5. Gemini API（OCR + カテゴリ仕分け）
============================================= */
async function analyzeReceiptWithGemini(imageDataUrl) {
  const GEMINI_API_KEY = getGeminiApiKey();
  if (!GEMINI_API_KEY) {
    showStatus('receipt-status',
      '⚠️ Gemini APIキーが未設定です。「設定」タブでAPIキーを入力してください', 'error');
    return null;
  }

  const base64Image = imageDataUrl.split(',')[1];

  const prompt = `このレシート画像を読み取り、以下のJSON形式のみで返してください。前置きや説明文は不要です。JSONのみ返してください。

{
  "storeName": "店名（わからなければnull）",
  "date": "購入日時（日付と時刻を含めて、例：2026/06/08 14:30、わからなければnull）",
  "total": 合計金額の数値（わからなければnull）,
  "items": [
    {
      "name": "商品名",
      "price": 価格の数値,
      "category": "以下のいずれか：食料品・日用品・医薬品・衛生用品・家電・雑貨・交通費・その他"
    }
  ]
}

カテゴリの判断基準：
- 食料品：食べ物・飲み物・お菓子・調味料など
- 日用品：シャンプー・洗剤・トイレットペーパー・洗濯用品など
- 医薬品・衛生用品：薬・マスク・絆創膏・消毒液など
- 家電・雑貨：電池・電球・文房具・キッチン用品など
- 交通費：交通系ICカードチャージ・切符など
- その他：上記に当てはまらないもの`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Image } }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
        })
      }
    );

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const code = errData?.error?.code;
      let errMsg = '❌ Gemini APIエラー：';
      if (code === 401) errMsg += 'APIキーが無効です';
      else if (code === 403) errMsg += 'アクセスが拒否されました。個人のGmailで取得したAPIキーを使用してください';
      else if (code === 429) errMsg += 'リクエスト制限に達しました。しばらく待ってください';
      else if (code === 404) errMsg += 'モデルが見つかりません';
      else errMsg += `ステータス：${response.status}`;
      showStatus('receipt-status', errMsg, 'error');
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      showStatus('receipt-status', '❌ 結果の解析に失敗しました', 'error');
      return null;
    }
    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    showStatus('receipt-status', `❌ 通信エラー：${error.message}`, 'error');
    return null;
  }
}

/* =============================================
   ■ 6. レシート読み取り結果の表示（カテゴリ別仕分け）
============================================= */
function handleGeminiResult(result) {
  if (!result || !result.items || result.items.length === 0) {
    showReceiptFallback(result);
    return;
  }
  lastReceiptResult = result;
  document.getElementById('receipt-preview').style.display = 'block';
  renderReceiptPreview();
  showStatus('receipt-status', '✅ 読み取り完了！商品名をタップして編集できます', 'success');
}

function showReceiptFallback(partial) {
  document.getElementById('receipt-preview').style.display = 'none';
  document.getElementById('receipt-status').innerHTML = `
    <div class="status-msg error">
      ❌ 読み取りに失敗しました。手動で入力してください。
      <div style="margin-top:10px;display:grid;gap:8px;">
        <input type="text" id="fallback-name" placeholder="店名（例：イオン）"
          value="${partial?.storeName || ''}"
          style="background:#fff;border:1.5px solid #fca5a5;" />
        <input type="number" id="fallback-amount" placeholder="金額（例：1580）"
          value="${partial?.total || ''}"
          style="background:#fff;border:1.5px solid #fca5a5;" />
        <select id="fallback-category" style="background:#fff;border:1.5px solid #fca5a5;">
          ${Object.entries(CATEGORIES).map(([k, c]) =>
            `<option value="${k}">${c.label}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="registerFallback()">記録する</button>
      </div>
    </div>`;
}

window.registerFallback = function() {
  const name   = document.getElementById('fallback-name')?.value;
  const amount = document.getElementById('fallback-amount')?.value;
  const cat    = document.getElementById('fallback-category')?.value;
  if (addExpense(name, amount, cat)) {
    document.getElementById('receipt-status').innerHTML = '';
    showStatus('receipt-status', '✅ 記録しました', 'success');
  } else {
    showStatus('receipt-status', '⚠️ 名前と金額を入力してください', 'error');
  }
};

/**
 * レシートの読み取り結果を編集可能な形式で表示する
 * 商品名・金額・カテゴリをその場で編集できる
 */
function renderReceiptPreview() {
  const result = lastReceiptResult;
  const previewContent = document.getElementById('receipt-preview-content');

  // 品目をカテゴリ別にグループ化
  const grouped = {};
  (result.items || []).forEach((item, idx) => {
    const catKey = CATEGORY_MAP[item.category] || 'other';
    if (!grouped[catKey]) grouped[catKey] = [];
    grouped[catKey].push({ ...item, idx });
  });

  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <div style="background:#fff;border-radius:8px;padding:10px;border:1px solid var(--border-soft);">
        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;">店名</div>
        <input type="text" value="${result.storeName || ''}"
          style="width:100%;font-size:0.88rem;font-weight:700;padding:2px 4px;"
          placeholder="店名を入力"
          onchange="lastReceiptResult.storeName = this.value" />
      </div>
      <div style="background:#fff;border-radius:8px;padding:10px;border:1px solid var(--border-soft);">
        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;">合計金額</div>
        <input type="number" value="${result.total || ''}"
          style="width:100%;font-size:1rem;font-weight:800;color:var(--accent);padding:2px 4px;font-family:Outfit,monospace;"
          placeholder="金額"
          onchange="lastReceiptResult.total = Number(this.value)" />
      </div>
    </div>
    <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:10px;">
      💡 商品名・金額・カテゴリをタップして編集できます
    </div>`;

  Object.keys(grouped).forEach(catKey => {
    const cat = CATEGORIES[catKey];
    const items = grouped[catKey];
    const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0), 0);

    html += `
      <div style="margin-bottom:12px;border-radius:10px;overflow:hidden;border:1.5px solid var(--border-soft);">
        <div style="padding:8px 12px;display:flex;justify-content:space-between;
          align-items:center;background:${cat.color}20;border-bottom:1px solid var(--border-soft);">
          <span style="font-size:0.82rem;font-weight:700;color:${cat.color};">${cat.label}</span>
          <span style="font-size:0.8rem;font-family:Outfit,monospace;font-weight:700;color:${cat.color};"
            id="subtotal-${catKey}">¥${subtotal.toLocaleString()}</span>
        </div>
        <div style="background:#fff;">
          ${items.map(item => `
            <div style="display:grid;grid-template-columns:1fr auto auto;gap:6px;
              align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-soft);">
              <input type="text" value="${item.name}"
                style="font-size:0.82rem;padding:3px 6px;width:100%;"
                placeholder="商品名"
                onchange="updateReceiptItem(${item.idx}, 'name', this.value)" />
              <input type="number" value="${item.price}"
                style="font-size:0.82rem;padding:3px 6px;width:75px;font-family:Outfit,monospace;text-align:right;"
                placeholder="金額"
                onchange="updateReceiptItem(${item.idx}, 'price', Number(this.value))" />
              <select style="font-size:0.72rem;padding:3px 4px;border-radius:6px;
                border:1.5px solid var(--border);background:var(--surface2);color:var(--text);"
                onchange="updateReceiptItem(${item.idx}, 'category', this.value, true)">
                ${Object.entries(CATEGORIES).map(([key, c]) => `
                  <option value="${c.label.split(' ').slice(-1)[0]}"
                    ${(CATEGORY_MAP[item.category] || 'other') === key ? 'selected' : ''}>
                    ${c.label}
                  </option>`).join('')}
              </select>
            </div>`).join('')}
          <button onclick="addReceiptItem('${catKey}')"
            style="width:100%;padding:6px;background:none;border:none;
            color:var(--accent);font-size:0.78rem;cursor:pointer;text-align:left;padding-left:12px;">
            ＋ 品目を追加
          </button>
        </div>
      </div>`;
  });

  previewContent.innerHTML = html;
}

function updateReceiptItem(idx, field, value, rerender = false) {
  if (!lastReceiptResult || !lastReceiptResult.items[idx]) return;
  lastReceiptResult.items[idx][field] = value;
  if (rerender) renderReceiptPreview();
}

function addReceiptItem(catKey) {
  if (!lastReceiptResult) return;
  const catLabel = Object.entries(CATEGORY_MAP).find(([, v]) => v === catKey)?.[0] || 'その他';
  lastReceiptResult.items.push({ name: '', price: 0, category: catLabel });
  renderReceiptPreview();
}

/* =============================================
   ■ 7. レシートからの登録処理
============================================= */

// レシートの重複判定キー：店名 + 日時 + 合計金額
function receiptSignature(result) {
  return [result.storeName || '', result.date || '', result.total ?? ''].join('|');
}

function isReceiptDuplicate(result) {
  if (!result.date) return false; // 日時不明なら判定しない
  const sig = receiptSignature(result);
  return load('registeredReceipts', []).includes(sig);
}

function markReceiptRegistered(result) {
  if (!result.date) return;
  const sig  = receiptSignature(result);
  const list = load('registeredReceipts', []);
  if (!list.includes(sig)) {
    list.push(sig);
    save('registeredReceipts', list);
  }
}

// レシート1件分を登録するユーティリティ
function registerReceiptResult(result) {
  const grouped = {};
  (result.items || []).forEach(item => {
    const catKey = CATEGORY_MAP[item.category] || 'other';
    grouped[catKey] = (grouped[catKey] || 0) + (Number(item.price) || 0);
  });
  if (Object.keys(grouped).length === 0 && result.total) {
    addExpense(result.storeName || 'レシート', result.total, 'other');
  } else {
    Object.entries(grouped).forEach(([catKey, amount]) => {
      if (amount > 0) addExpense(result.storeName || 'レシート', amount, catKey);
    });
  }
}

// キューのUI更新
function updateQueueBar() {
  const bar = document.getElementById('receipt-queue-bar');
  const cnt = document.getElementById('receipt-queue-count');
  if (receiptQueue.length > 0) {
    bar.style.display = 'flex';
    cnt.textContent = receiptQueue.length;
  } else {
    bar.style.display = 'none';
  }
}

// 家計簿に記録する（キューにあるものも含めてまとめて登録）
document.getElementById('btn-register-receipt').addEventListener('click', () => {
  const targets    = [...receiptQueue, ...(lastReceiptResult ? [lastReceiptResult] : [])];
  if (targets.length === 0) return;

  const dupTargets = targets.filter(r => isReceiptDuplicate(r));
  const newTargets = targets.filter(r => !isReceiptDuplicate(r));

  // 全件重複の場合は登録せず警告
  if (newTargets.length === 0) {
    const info = dupTargets[0].date ? `（${dupTargets[0].date}）` : '';
    showStatus('receipt-status',
      `⚠️ このレシートはすでに登録済みです${info}。日時が同じレシートは二重登録されません。`, 'error', 6000);
    return;
  }

  newTargets.forEach(r => {
    registerReceiptResult(r);
    markReceiptRegistered(r);
  });

  let msg = newTargets.length > 1
    ? `✅ ${newTargets.length}枚のレシートを記録しました！`
    : '✅ 家計簿に記録しました！';
  if (dupTargets.length > 0) {
    msg += `（${dupTargets.length}枚は重複のためスキップ）`;
  }

  receiptQueue = [];
  lastReceiptResult = null;
  updateQueueBar();
  showStatus('receipt-status', msg, 'success');
  document.getElementById('receipt-preview').style.display = 'none';
});

// さらに読む：現在のプレビューをキューに積んでリセット
document.getElementById('btn-more-receipt').addEventListener('click', () => {
  if (!lastReceiptResult) return;
  receiptQueue.push(lastReceiptResult);
  lastReceiptResult = null;
  document.getElementById('receipt-preview').style.display = 'none';
  updateQueueBar();
  showStatus('receipt-status',
    `📋 ${receiptQueue.length}枚 蓄積中。次のレシートを読み取ってください。`, 'success');
});

// まとめて登録ボタン（キューのみ）
document.getElementById('btn-register-all-receipts').addEventListener('click', () => {
  if (receiptQueue.length === 0) return;
  receiptQueue.forEach(registerReceiptResult);
  const count = receiptQueue.length;
  receiptQueue = [];
  updateQueueBar();
  showStatus('receipt-status', `✅ ${count}枚のレシートをまとめて記録しました！`, 'success');
});

// 食料品を冷蔵庫在庫に追加する
document.getElementById('btn-add-food-from-receipt').addEventListener('click', () => {
  if (!lastReceiptResult) return;
  const foodItems = (lastReceiptResult.items || [])
    .filter(item => CATEGORY_MAP[item.category] === 'food');
  if (foodItems.length === 0) {
    showStatus('receipt-status', '⚠️ 食料品が見つかりませんでした', 'error');
    return;
  }
  // 新しいレシート（重複なし）なら既存食材の個数を増やす
  const isNew = !isReceiptDuplicate(lastReceiptResult);
  foodItems.forEach(item => addFood(item.name, isNew));
  const note = isNew ? '' : '（重複レシートのため個数は増やしません）';
  showStatus('receipt-status',
    `🥬 ${foodItems.length}件の食料品を在庫に追加しました！${note}`, 'success');
});

/* =============================================
   ■ 8. レシート撮影UI
============================================= */

// タブ切り替え
document.querySelectorAll('.receipt-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.receipt-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.receipt-mode').forEach(m => m.style.display = 'none');
    document.getElementById('receipt-mode-' + tab.dataset.receipt).style.display = 'block';
    document.getElementById('receipt-preview').style.display = 'none';
  });
});

// カメラ起動
let receiptStream = null;
document.getElementById('btn-receipt-camera').addEventListener('click', async () => {
  try {
    receiptStream = await startCamera('receipt-video');
    document.getElementById('receipt-area').style.display = 'block';
    document.getElementById('btn-receipt-camera').style.display = 'none';
    document.getElementById('btn-stop-receipt').style.display = 'inline-block';
  } catch (e) {
    showStatus('receipt-status', '❌ カメラへのアクセスが拒否されました', 'error');
  }
});

// カメラ停止
document.getElementById('btn-stop-receipt').addEventListener('click', () => {
  stopCamera(receiptStream, 'receipt-video');
  receiptStream = null;
  document.getElementById('receipt-area').style.display = 'none';
  document.getElementById('btn-receipt-camera').style.display = 'inline-block';
  document.getElementById('btn-stop-receipt').style.display = 'none';
});

// 撮影してGeminiで読み取る
document.getElementById('btn-capture-receipt').addEventListener('click', async () => {
  const imageData = captureFrame('receipt-video', 'receipt-canvas');
  showStatus('receipt-status', '🤖 AIがレシートを読み取り中...', 'info', 0);
  const result = await analyzeReceiptWithGemini(imageData);
  handleGeminiResult(result);
});

// ファイルアップロード
document.getElementById('receipt-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleReceiptFile(file);
  e.target.value = '';
});

function handleReceiptFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showStatus('receipt-status', '❌ 画像ファイルを選択してください', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const imageDataUrl = e.target.result;
    document.getElementById('receipt-upload-img').src = imageDataUrl;
    document.getElementById('receipt-upload-preview').style.display = 'block';
    document.getElementById('receipt-drop-area').style.display = 'none';
    document.getElementById('receipt-preview').style.display = 'none';
    document.getElementById('btn-analyze-upload').onclick = async () => {
      showStatus('receipt-status', '🤖 AIがレシートを読み取り中...', 'info', 0);
      const result = await analyzeReceiptWithGemini(imageDataUrl);
      handleGeminiResult(result);
    };
  };
  reader.readAsDataURL(file);
}

// ドラッグ&ドロップ
const dropArea = document.getElementById('receipt-drop-area');
dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('dragover'); });
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleReceiptFile(file);
});

document.getElementById('btn-reset-upload').addEventListener('click', () => {
  document.getElementById('receipt-upload-preview').style.display = 'none';
  document.getElementById('receipt-drop-area').style.display = 'block';
  document.getElementById('receipt-preview').style.display = 'none';
  document.getElementById('receipt-file-input').value = '';
  lastReceiptResult = null;
});

/* =============================================
   ■ 9. 冷蔵庫管理（食材在庫）
   カンマ区切りで複数まとめて登録できる
============================================= */

let foodList = load('foodList', []);

// increment=true のとき、既存食材は個数を+1する（別日の新レシート由来）
function addFood(name, increment = false) {
  const names = name.split(/[,、，]/).map(n => n.trim()).filter(n => n);
  names.forEach(n => {
    const existing = foodList.find(f => f.name === n);
    if (existing) {
      if (increment) existing.qty = (existing.qty || 1) + 1;
    } else {
      foodList.push({ name: n, date: today(), qty: 1 });
    }
  });
  save('foodList', foodList);
  renderFoodList();
}

function renderFoodList() {
  const container = document.getElementById('food-list-items');
  if (foodList.length === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px 0;">在庫がありません</div>';
    return;
  }
  container.innerHTML = foodList.map((f, i) => {
    const qty = f.qty || 1;
    const qtyBadge = qty > 1
      ? `<span style="font-size:0.7rem;font-weight:700;background:#ffedd5;color:var(--accent);
          padding:1px 7px;border-radius:999px;margin-left:6px;">×${qty}</span>`
      : '';
    return `
      <div class="food-item">
        <div>
          <div class="food-item-name">${f.name}${qtyBadge}</div>
          <div class="food-item-date">登録日：${f.date}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteFood(${i})">削除</button>
      </div>`;
  }).join('');
}

function deleteFood(index) {
  foodList.splice(index, 1);
  save('foodList', foodList);
  renderFoodList();
}

document.getElementById('btn-add-food').addEventListener('click', () => {
  const val = document.getElementById('food-input').value;
  if (!val.trim()) return;
  addFood(val);
  document.getElementById('food-input').value = '';
});

document.getElementById('food-input').addEventListener('keypress', e => {
  if (e.key === 'Enter') { addFood(e.target.value); e.target.value = ''; }
});

document.getElementById('btn-voice-food').addEventListener('click', () => {
  startSpeechRecognition('voice-food-status', (text) => {
    addFood(text);
    showStatus('voice-food-status', `🎤 「${text}」を登録しました`, 'success');
  });
});

/* =============================================
   ■ 10. 家計簿機能（支出・収入）
============================================= */

// 支出データ（月ごとに保存・常に今月）
let expenses = load('expenses_' + monthKey(), []);
// 収入データ（月ごとに保存・常に今月）
let incomes = load('incomes_' + monthKey(), []);

// 閲覧中の月（初期値は今月）
let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth() + 1;
// 閲覧月のデータ（updateKakeiboで更新）
let viewExpenses = expenses;
let viewIncomes  = incomes;

function isCurrentMonthView() {
  const n = new Date();
  return viewYear === n.getFullYear() && viewMonth === n.getMonth() + 1;
}
function viewMonthKey() {
  return viewYear + '-' + String(viewMonth).padStart(2, '0');
}
function viewMonthLabel() {
  return `${viewYear}年${viewMonth}月`;
}

// --- 支出を追加 ---
function addExpense(name, amount, category) {
  name = name.trim();
  amount = Number(amount);
  if (!name || !amount || amount <= 0) return false;
  expenses.push({ name, amount, category, date: today() });
  save('expenses_' + monthKey(), expenses);
  updateKakeibo();
  return true;
}

// --- 収入を追加 ---
function addIncome(name, amount, category) {
  name = name.trim();
  amount = Number(amount);
  if (!name || !amount || amount <= 0) return false;
  incomes.push({ name, amount, category, date: today() });
  save('incomes_' + monthKey(), incomes);
  updateKakeibo();
  return true;
}

// --- 家計簿の表示を更新 ---
function updateKakeibo() {
  // 閲覧月のデータを取得
  viewExpenses = isCurrentMonthView() ? expenses : load('expenses_' + viewMonthKey(), []);
  viewIncomes  = isCurrentMonthView() ? incomes  : load('incomes_'  + viewMonthKey(), []);

  // 入力セクションの表示切り替え（過去月は非表示）
  const inputSection = document.getElementById('kakeibo-inputs');
  if (inputSection) inputSection.style.display = isCurrentMonthView() ? '' : 'none';

  // 次月ボタンのdisabled制御（今月より未来には進めない）
  const nextBtn = document.getElementById('btn-view-next-month');
  if (nextBtn) {
    nextBtn.disabled = isCurrentMonthView();
    nextBtn.style.opacity = isCurrentMonthView() ? '0.3' : '1';
  }

  const settings = load('settings', {});
  const budget = settings.budget || 0;
  const totalExpense = viewExpenses.reduce((s, e) => s + e.amount, 0);
  const totalIncome  = viewIncomes.reduce((s, e) => s + e.amount, 0);
  const balance = totalIncome - totalExpense;

  document.getElementById('summary-month').textContent = viewMonthLabel();

  // 収支バランス（プラスは黒字・マイナスは赤字）
  const balanceEl = document.getElementById('summary-balance');
  const noteEl = document.getElementById('summary-balance-note');
  balanceEl.textContent = (balance < 0 ? '-¥' : '¥') + Math.abs(balance).toLocaleString();
  balanceEl.className = 'summary-balance ' + (balance < 0 ? 'minus' : 'plus');
  if (totalIncome === 0 && totalExpense === 0) {
    noteEl.textContent = '';
  } else if (balance > 0) {
    noteEl.textContent = '🟢 黒字（収入が支出を上回っています）';
  } else if (balance < 0) {
    noteEl.textContent = '🔴 赤字（支出が収入を上回っています）';
  } else {
    noteEl.textContent = '⚪ 収支ぴったりです';
  }

  // 収入・支出の内訳
  document.getElementById('summary-income').textContent  = '¥' + totalIncome.toLocaleString();
  document.getElementById('summary-expense').textContent = '¥' + totalExpense.toLocaleString();

  // 予算バー（支出ベース）
  document.getElementById('summary-budget-text').textContent =
    budget > 0 ? `¥${budget.toLocaleString()}（残 ¥${(budget-totalExpense).toLocaleString()}）` : '未設定';
  const bar = document.getElementById('summary-budget-bar');
  if (budget > 0) {
    bar.style.width = Math.min((totalExpense / budget) * 100, 100) + '%';
    bar.className = 'budget-banner-bar' + (totalExpense >= budget ? ' over' : '');
  } else {
    bar.style.width = '0%';
  }

  updateCatBudgetBars(settings);
  drawCategoryChart();
  drawMonthlyChart();
  renderHistoryList();
  renderMonthComparison();
}

function updateCatBudgetBars(settings) {
  const card = document.getElementById('cat-budget-card');
  const container = document.getElementById('cat-budget-bars');
  const hasCatBudget = Object.values(CATEGORIES).some(c => settings[c.budgetKey] > 0);
  if (!hasCatBudget) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  container.innerHTML = Object.entries(CATEGORIES).map(([key, cat]) => {
    const catBudget = settings[cat.budgetKey] || 0;
    if (!catBudget) return '';
    const spent = viewExpenses.filter(e => e.category === key).reduce((s, e) => s + e.amount, 0);
    const rate = Math.min((spent / catBudget) * 100, 100);
    return `
      <div class="cat-budget-row">
        <div class="cat-budget-label">
          <span>${cat.label}</span>
          <span>¥${spent.toLocaleString()} / ¥${catBudget.toLocaleString()}</span>
        </div>
        <div class="cat-bar-wrap">
          <div class="cat-bar ${rate >= 100 ? 'over' : ''}"
            style="width:${rate}%;background:${cat.color};"></div>
        </div>
      </div>`;
  }).join('');
}

// Canvas APIでカテゴリ別円グラフ（支出）を描画
function drawCategoryChart() {
  const canvas = document.getElementById('category-chart');
  const ctx = canvas.getContext('2d');

  const size = Math.min(canvas.offsetWidth || 300, 300);
  canvas.width = canvas.offsetWidth || 300;
  canvas.height = size;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cats = Object.entries(CATEGORIES)
    .map(([key, cat]) => ({
      labelShort: cat.label.split(' ').slice(-1)[0],
      label: cat.label,
      color: cat.color,
      amount: viewExpenses.filter(e => e.category === key).reduce((s, e) => s + e.amount, 0)
    }))
    .filter(c => c.amount > 0);

  if (cats.length === 0) {
    ctx.fillStyle = '#a16207';
    ctx.font = '13px Noto Sans JP';
    ctx.textAlign = 'center';
    ctx.fillText('まだ支出データがありません', canvas.width / 2, canvas.height / 2);
    document.getElementById('category-legend').innerHTML = '';
    return;
  }

  const total = cats.reduce((s, c) => s + c.amount, 0);
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.38, innerRadius = size * 0.22;
  let startAngle = -Math.PI / 2;

  cats.forEach((cat) => {
    const sliceAngle = (cat.amount / total) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = cat.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    const percentage = Math.round((cat.amount / total) * 100);
    if (percentage >= 5) {
      const midAngle = startAngle + sliceAngle / 2;
      const labelR = (radius + innerRadius) / 2;
      const labelX = cx + Math.cos(midAngle) * labelR;
      const labelY = cy + Math.sin(midAngle) * labelR;
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(size * 0.04, 9)}px Outfit`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(percentage + '%', labelX, labelY);
    }
    startAngle = endAngle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.fillStyle = '#431407';
  ctx.font = `bold ${Math.max(size * 0.055, 11)}px Outfit`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('¥' + total.toLocaleString(), cx, cy - 8);
  ctx.font = `${Math.max(size * 0.038, 9)}px Noto Sans JP`;
  ctx.fillStyle = '#a16207';
  ctx.fillText('支出合計', cx, cy + 10);

  document.getElementById('category-legend').innerHTML = cats.map(c => {
    const pct = Math.round((c.amount / total) * 100);
    return `
      <div style="display:flex;align-items:center;gap:5px;font-size:0.72rem;">
        <div style="width:10px;height:10px;border-radius:50%;background:${c.color};flex-shrink:0;"></div>
        <span>${c.labelShort}：¥${c.amount.toLocaleString()}（${pct}%）</span>
      </div>`;
  }).join('');
}

// Canvas APIで月別の収支推移（収入＝薄い棒、支出＝折れ線）を描画
function drawMonthlyChart() {
  const canvas = document.getElementById('monthly-chart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 600;
  canvas.height = 180;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 過去6ヶ月の収入・支出を集計
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const exp = load('expenses_' + key, []).reduce((s, e) => s + e.amount, 0);
    const inc = load('incomes_' + key, []).reduce((s, e) => s + e.amount, 0);
    months.push({ label: `${d.getMonth() + 1}月`, expense: exp, income: inc });
  }

  const maxVal = Math.max(...months.map(m => Math.max(m.income, m.expense)), 1);
  const padL = 50, padR = 20, padT = 20, padB = 30;
  const chartW = canvas.width - padL - padR;
  const chartH = canvas.height - padT - padB;

  // 横グリッド線＋目盛り
  ctx.strokeStyle = '#ffedd5';
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(r => {
    const y = padT + chartH * (1 - r);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#a16207';
    ctx.font = '9px Outfit';
    ctx.textAlign = 'right';
    ctx.fillText('¥' + Math.round(maxVal * r / 1000) + 'k', padL - 4, y + 3);
  });

  const slotW = chartW / months.length;

  // 収入＝薄い緑の棒グラフ
  months.forEach((m, i) => {
    const barW = slotW * 0.45;
    const x = padL + slotW * i + (slotW - barW) / 2;
    const h = chartH * (m.income / maxVal);
    const y = padT + chartH - h;
    ctx.fillStyle = 'rgba(22,163,74,0.35)';
    ctx.fillRect(x, y, barW, h);
  });

  // 支出＝オレンジの折れ線
  ctx.beginPath();
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  months.forEach((m, i) => {
    const x = padL + slotW * i + slotW / 2;
    const y = padT + chartH * (1 - m.expense / maxVal);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 支出の点
  months.forEach((m, i) => {
    const x = padL + slotW * i + slotW / 2;
    const y = padT + chartH * (1 - m.expense / maxVal);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f97316'; ctx.fill();
    // 月ラベル
    ctx.fillStyle = '#431407';
    ctx.font = '9px Noto Sans JP';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x, padT + chartH + padB - 8);
  });
}

// --- 入出金履歴（収入＋支出をまとめて新しい順に表示） ---
function renderHistoryList() {
  const container = document.getElementById('history-list');
  const isCurrent = isCurrentMonthView();
  const items = [
    ...viewIncomes.map((e, idx) => ({ ...e, type: 'income', idx })),
    ...viewExpenses.map((e, idx) => ({ ...e, type: 'expense', idx })),
  ];
  if (items.length === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px 0;">まだ記録がありません</div>';
    return;
  }
  container.innerHTML = items.reverse().map(item => {
    const delBtn = isCurrent
      ? `<button class="btn btn-danger btn-sm" onclick="${item.type === 'income' ? 'deleteIncome' : 'deleteExpense'}(${item.idx})">削除</button>`
      : '';
    if (item.type === 'income') {
      const catLabel = INCOME_CATEGORIES[item.category]?.label || '収入';
      return `
        <div class="history-item income">
          <div class="history-info">
            <div class="hname">${item.name}</div>
            <div class="hdate">${item.date} ・ ${catLabel}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="history-amount income">+¥${item.amount.toLocaleString()}</div>
            ${delBtn}
          </div>
        </div>`;
    } else {
      const catLabel = CATEGORIES[item.category]?.label || 'その他';
      return `
        <div class="history-item expense ${item.category}">
          <div class="history-info">
            <div class="hname">${item.name}</div>
            <div class="hdate">${item.date} ・ ${catLabel}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="history-amount expense">-¥${item.amount.toLocaleString()}</div>
            ${delBtn}
          </div>
        </div>`;
    }
  }).join('');
}

function deleteExpense(index) {
  viewExpenses.splice(index, 1);
  save('expenses_' + viewMonthKey(), viewExpenses);
  updateKakeibo();
}

function deleteIncome(index) {
  viewIncomes.splice(index, 1);
  save('incomes_' + viewMonthKey(), viewIncomes);
  updateKakeibo();
}

// --- 支出の手動記録ボタン ---
document.getElementById('btn-add-expense').addEventListener('click', () => {
  const name = document.getElementById('expense-name').value;
  const amount = document.getElementById('expense-amount').value;
  const category = document.getElementById('expense-category').value;
  if (addExpense(name, amount, category)) {
    document.getElementById('expense-name').value = '';
    document.getElementById('expense-amount').value = '';
    showStatus('expense-status', `✅ 支出 ¥${Number(amount).toLocaleString()} を記録しました`, 'success');
  } else {
    showStatus('expense-status', '⚠️ 店名と金額を入力してください', 'error');
  }
});

// --- 収入の記録ボタン ---
document.getElementById('btn-add-income').addEventListener('click', () => {
  const name = document.getElementById('income-name').value;
  const amount = document.getElementById('income-amount').value;
  const category = document.getElementById('income-category').value;
  if (addIncome(name, amount, category)) {
    document.getElementById('income-name').value = '';
    document.getElementById('income-amount').value = '';
    showStatus('income-status', `✅ 収入 ¥${Number(amount).toLocaleString()} を記録しました`, 'success');
  } else {
    showStatus('income-status', '⚠️ 内容と金額を入力してください', 'error');
  }
});

// --- 支出の音声記録 ---
document.getElementById('btn-voice-expense').addEventListener('click', () => {
  startSpeechRecognition('voice-expense-status', (text) => {
    const numMatch = text.match(/(\d[\d,]*)/);
    let amount = 0;
    if (numMatch) amount = parseInt(numMatch[1].replace(',', ''));
    else {
      if (text.includes('千')) amount += 1000;
      if (text.includes('五百')) amount += 500;
      else if (text.includes('百')) amount += 100;
    }
    if (amount > 0) {
      const name = text.replace(/[0-9,一二三四五六七八九十百千万円で]/g, '').trim() || '音声入力';
      document.getElementById('expense-name').value = name;
      document.getElementById('expense-amount').value = amount;
      showStatus('voice-expense-status',
        `🎤 ¥${amount}を認識。確認して記録ボタンを押してください`, 'success');
    } else {
      showStatus('voice-expense-status', `🎤 金額が読み取れませんでした`, 'error');
    }
  });
});

// CSV出力（Blob API）：収入・支出をまとめて出力
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (viewExpenses.length === 0 && viewIncomes.length === 0) { alert('データがありません'); return; }
  const header = '日付,種別,内容,カテゴリ,金額\n';
  const incomeRows  = viewIncomes.map(e =>
    `${e.date},収入,${e.name},${INCOME_CATEGORIES[e.category]?.label || '収入'},${e.amount}`
  );
  const expenseRows = viewExpenses.map(e =>
    `${e.date},支出,${e.name},${CATEGORIES[e.category]?.label || 'その他'},-${e.amount}`
  );
  const rows = [...incomeRows, ...expenseRows].join('\n');
  const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `カゴメモ_${viewMonthKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// Web Share API：収支レポートをシェア
document.getElementById('btn-share-report').addEventListener('click', async () => {
  const totalExpense = viewExpenses.reduce((s, e) => s + e.amount, 0);
  const totalIncome  = viewIncomes.reduce((s, e) => s + e.amount, 0);
  const balance = totalIncome - totalExpense;
  let text = `📊 ${viewMonthLabel()}の家計レポート\n`;
  text += `収入：¥${totalIncome.toLocaleString()}\n`;
  text += `支出：¥${totalExpense.toLocaleString()}\n`;
  text += `収支：${balance < 0 ? '-¥' : '¥'}${Math.abs(balance).toLocaleString()}（${balance >= 0 ? '黒字' : '赤字'}）\n\n`;
  text += Object.entries(CATEGORIES).map(([key, cat]) => {
    const amt = viewExpenses.filter(e => e.category === key).reduce((s, e) => s + e.amount, 0);
    return amt > 0 ? `${cat.label}：¥${amt.toLocaleString()}` : '';
  }).filter(Boolean).join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: 'カゴメモ - 家計レポート', text }); } catch {}
  } else {
    navigator.clipboard.writeText(text).then(() => alert('クリップボードにコピーしました'));
  }
});

// 閲覧中の月のデータをリセット
document.getElementById('btn-clear-expenses').addEventListener('click', () => {
  const label = isCurrentMonthView() ? '今月' : viewMonthLabel();
  if (confirm(`${label}の収入・支出データをすべてリセットしますか？`)) {
    save('expenses_' + viewMonthKey(), []);
    save('incomes_'  + viewMonthKey(), []);
    if (isCurrentMonthView()) { expenses = []; incomes = []; }
    updateKakeibo();
  }
});

/* =============================================
   ■ 11. 固定費の自動計上（支払日ベース）

   仕組み：
   - 設定タブで「家賃・5万円・毎月1日」のように固定費を登録
   - アプリを開いたとき、支払日が過ぎていて
     かつ今月まだ計上されていない固定費を自動で支出に1回だけ追加
   - 「計上済み」の記録は postedFixed_年月 に保存して二重計上を防ぐ
============================================= */

// 登録された固定費の一覧を読み込み
let fixedCosts = load('fixedCosts', []);

/**
 * 固定費を1件追加する
 * @param {string} name  - 名称（例：家賃）
 * @param {number} amount - 金額
 * @param {string} category - カテゴリキー（既定は fixed）
 * @param {number} day   - 毎月の支払日（1〜31）
 */
function addFixedCost(name, amount, category, day) {
  name = String(name).trim();
  amount = Number(amount);
  day = Number(day);
  if (!name || !amount || amount <= 0) return false;
  if (!day || day < 1 || day > 31) day = 1;
  fixedCosts.push({ id: Date.now(), name, amount, category: category || 'fixed', day });
  save('fixedCosts', fixedCosts);
  applyFixedCosts();   // 追加直後にも判定（支払日を過ぎていれば即計上）
  renderFixedCostList();
  return true;
}

function deleteFixedCost(id) {
  fixedCosts = fixedCosts.filter(f => f.id !== id);
  save('fixedCosts', fixedCosts);
  renderFixedCostList();
}

/**
 * 固定費を自動計上する（支払日ベース）
 * 今日の日付が固定費の支払日以降で、かつ今月まだ計上していなければ
 * 支出として1回だけ追加する。
 */
function applyFixedCosts() {
  const mKey = monthKey();
  const todayDate = new Date().getDate();           // 今日が何日か
  const posted = load('postedFixed_' + mKey, []);   // 今月計上済みの固定費idリスト
  let postedCount = 0;

  fixedCosts.forEach(fc => {
    // 今月まだ計上していない && 支払日を過ぎている（または当日）
    const alreadyPosted = posted.includes(fc.id);
    const isDue = todayDate >= fc.day;
    if (!alreadyPosted && isDue) {
      // 支出として直接追加（addExpenseを使うと毎回saveされるので同等処理）
      expenses.push({
        name: fc.name,
        amount: fc.amount,
        category: fc.category || 'fixed',
        date: today(),
        fromFixed: true,   // 固定費由来の印
      });
      posted.push(fc.id);
      postedCount++;
    }
  });

  if (postedCount > 0) {
    save('expenses_' + mKey, expenses);
    save('postedFixed_' + mKey, posted);
  }
  return postedCount;
}

// 設定タブの固定費一覧を描画
function renderFixedCostList() {
  const container = document.getElementById('fixed-cost-list');
  if (!container) return;
  if (fixedCosts.length === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.82rem;text-align:center;padding:12px 0;">固定費は登録されていません</div>';
    return;
  }
  const posted = load('postedFixed_' + monthKey(), []);
  container.innerHTML = fixedCosts.map(fc => {
    const catLabel = CATEGORIES[fc.category]?.label || '🏠 固定費';
    const done = posted.includes(fc.id);
    return `
      <div class="fixed-item">
        <div class="fixed-info">
          <div class="fixed-name">${fc.name}
            ${done ? '<span class="fixed-posted-badge">今月計上済</span>' : '<span class="fixed-pending-badge">毎月'+fc.day+'日</span>'}
          </div>
          <div class="fixed-sub">${catLabel} ・ ¥${fc.amount.toLocaleString()} ・ 毎月${fc.day}日</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteFixedCost(${fc.id})">削除</button>
      </div>`;
  }).join('');
}

// 支払日プルダウン（1〜31日）を生成
(function buildFixedDayOptions() {
  const sel = document.getElementById('fixed-day');
  if (!sel) return;
  for (let d = 1; d <= 31; d++) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d + '日';
    sel.appendChild(opt);
  }
})();

// 固定費カテゴリ追加ピッカー
(function() {
  const btn = document.getElementById('btn-show-fixed-cat');
  const picker = document.getElementById('fixed-cat-picker');
  if (!btn || !picker) return;

  function renderPicker() {
    const sel = document.getElementById('fixed-category');
    const current = Array.from(sel.options).map(o => o.value);
    const available = Object.entries(CATEGORIES).filter(([key]) => !current.includes(key));
    if (available.length === 0) {
      picker.innerHTML =
        '<span style="font-size:0.75rem;color:var(--text-muted);">追加できるカテゴリはありません</span>';
      return;
    }
    picker.innerHTML = available.map(([key, cat]) =>
      `<button type="button" onclick="addFixedCatOption('${key}')"
        style="font-size:0.75rem;padding:4px 10px;border-radius:20px;
        border:1.5px solid ${cat.color};color:${cat.color};background:${cat.color}18;cursor:pointer;">
        ${cat.label}
      </button>`
    ).join('');
  }

  btn.addEventListener('click', () => {
    const opening = picker.style.display === 'none' || picker.style.display === '';
    picker.style.display = opening ? 'flex' : 'none';
    if (opening) renderPicker();
  });

  window.addFixedCatOption = function(key) {
    const sel = document.getElementById('fixed-category');
    const cat = CATEGORIES[key];
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cat.label;
    sel.insertBefore(opt, sel.lastElementChild); // 「その他」の直前に挿入
    sel.value = key;
    renderPicker();
  };
})();

// 固定費の登録ボタン
document.getElementById('btn-add-fixed').addEventListener('click', () => {
  const name = document.getElementById('fixed-name').value;
  const amount = document.getElementById('fixed-amount').value;
  const category = document.getElementById('fixed-category').value;
  const day = document.getElementById('fixed-day').value;
  if (addFixedCost(name, amount, category, day)) {
    document.getElementById('fixed-name').value = '';
    document.getElementById('fixed-amount').value = '';
    document.getElementById('fixed-day').value = '';
    showStatus('fixed-status', `✅ 固定費「${name}」を登録しました`, 'success');
    updateKakeibo();
  } else {
    showStatus('fixed-status', '⚠️ 名称・金額・支払日を正しく入力してください', 'error');
  }
});

/* =============================================
   ■ 12. 収支カレンダー
============================================= */

let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

function calFmt(amount) {
  return amount >= 1000 ? '¥' + Math.round(amount / 1000) + 'k' : '¥' + amount;
}

function renderCalendar() {
  const year  = calYear;
  const month = calMonth;
  const mKey  = year + '-' + String(month).padStart(2, '0');

  const monthExpenses = load('expenses_' + mKey, []);
  const monthIncomes  = load('incomes_'  + mKey, []);

  document.getElementById('calendar-header').textContent = `${year}年${month}月`;

  const dayMap = {};
  function toDay(dateStr) {
    const p = dateStr.split('/');
    return p.length === 3 ? Number(p[2]) : null;
  }
  monthExpenses.forEach(e => {
    const d = toDay(e.date); if (!d) return;
    if (!dayMap[d]) dayMap[d] = { expense: 0, income: 0, items: [] };
    dayMap[d].expense += e.amount;
    dayMap[d].items.push({ ...e, type: 'expense' });
  });
  monthIncomes.forEach(e => {
    const d = toDay(e.date); if (!d) return;
    if (!dayMap[d]) dayMap[d] = { expense: 0, income: 0, items: [] };
    dayMap[d].income += e.amount;
    dayMap[d].items.push({ ...e, type: 'income' });
  });

  const firstDow    = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const now         = new Date();
  const isCurMonth  = now.getFullYear() === year && now.getMonth() + 1 === month;
  const todayNum    = now.getDate();

  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  let html = '<div class="cal-grid">';

  DOW.forEach((w, i) => {
    const c = i === 0 ? '#ef4444' : i === 6 ? '#3b82f6' : 'var(--text-muted)';
    html += `<div class="cal-header-cell" style="color:${c};">${w}</div>`;
  });

  for (let i = 0; i < firstDow; i++) {
    html += '<div class="cal-cell empty"></div>';
  }

  // ヒートマップ用：月内の最大日次支出
  const maxDayExp = Math.max(1, ...Object.values(dayMap).map(d => d.expense));

  for (let d = 1; d <= daysInMonth; d++) {
    const dd       = dayMap[d];
    const dow      = (firstDow + d - 1) % 7;
    const isToday  = isCurMonth && d === todayNum;
    const numColor = isToday ? 'var(--accent)' : dow === 0 ? '#ef4444' : dow === 6 ? '#3b82f6' : 'var(--text)';
    // ヒートマップ背景（支出額に応じたオレンジの濃淡）
    const heat = dd && dd.expense > 0 ? (dd.expense / maxDayExp * 0.3).toFixed(2) : 0;
    const bg   = isToday
      ? 'background:#fff7ed;border-color:var(--accent);'
      : heat > 0 ? `background:rgba(249,115,22,${heat});` : '';
    html += `
      <div class="cal-cell" style="${bg}" onclick="showCalendarDay(${d})">
        <div class="cal-day-num" style="color:${numColor};${isToday ? 'font-weight:800;' : ''}">${d}</div>
        ${dd && dd.expense > 0 ? `<div class="cal-expense">${calFmt(dd.expense)}</div>` : ''}
        ${dd && dd.income  > 0 ? `<div class="cal-income">${calFmt(dd.income)}</div>`  : ''}
      </div>`;
  }

  html += '</div>';
  document.getElementById('calendar-grid').innerHTML = html;
  document.getElementById('calendar-day-detail').innerHTML = '';
}

function showCalendarDay(d) {
  const mKey = calYear + '-' + String(calMonth).padStart(2, '0');
  const monthExpenses = load('expenses_' + mKey, []);
  const monthIncomes  = load('incomes_'  + mKey, []);

  function toDay(dateStr) {
    const p = dateStr.split('/');
    return p.length === 3 ? Number(p[2]) : null;
  }

  const dayExpenses = monthExpenses.filter(e => toDay(e.date) === d);
  const dayIncomes  = monthIncomes.filter(e  => toDay(e.date) === d);

  const detail = document.getElementById('calendar-day-detail');

  if (dayExpenses.length === 0 && dayIncomes.length === 0) {
    detail.innerHTML =
      `<p style="color:var(--text-muted);font-size:0.83rem;text-align:center;padding:14px 0;">${calMonth}月${d}日の記録はありません</p>`;
    return;
  }

  const totalE = dayExpenses.reduce((s, e) => s + e.amount, 0);
  const totalI = dayIncomes.reduce((s, e)  => s + e.amount, 0);

  let html = `
    <div style="margin-top:16px;border-top:1.5px solid var(--border-soft);padding-top:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-weight:700;font-size:0.92rem;">${calMonth}月${d}日</span>
        <span style="font-size:0.82rem;font-family:Outfit,monospace;font-weight:700;">
          ${totalI > 0 ? `<span style="color:#16a34a;">+¥${totalI.toLocaleString()}</span>` : ''}
          ${totalI > 0 && totalE > 0 ? '&nbsp;/&nbsp;' : ''}
          ${totalE > 0 ? `<span style="color:#dc2626;">-¥${totalE.toLocaleString()}</span>` : ''}
        </span>
      </div>`;

  [...dayIncomes.map(e => ({ ...e, type: 'income' })),
   ...dayExpenses.map(e => ({ ...e, type: 'expense' }))].forEach(item => {
    const catLabel = item.type === 'income'
      ? (INCOME_CATEGORIES[item.category]?.label || '収入')
      : (CATEGORIES[item.category]?.label || 'その他');
    const color  = item.type === 'income' ? '#16a34a' : '#dc2626';
    const prefix = item.type === 'income' ? '+' : '-';
    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;
        padding:8px 0;border-bottom:1px solid var(--border-soft);font-size:0.83rem;">
        <div>
          <div style="font-weight:600;">${item.name}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">${catLabel}</div>
        </div>
        <div style="color:${color};font-weight:700;font-family:Outfit,monospace;white-space:nowrap;">
          ${prefix}¥${item.amount.toLocaleString()}
        </div>
      </div>`;
  });

  html += '</div>';
  detail.innerHTML = html;
}

document.getElementById('btn-cal-prev').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  renderCalendar();
});
document.getElementById('btn-cal-next').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  renderCalendar();
});

document.querySelector('.tab-btn[data-tab="calendar"]').addEventListener('click', renderCalendar);

/* =============================================
   ■ 13. 設定機能
============================================= */
function loadSettings() {
  const s = load('settings', {});
  if (s.budget)          document.getElementById('setting-budget').value = s.budget;
  if (s.budgetFood)      document.getElementById('setting-budget-food').value = s.budgetFood;
  if (s.budgetDaily)     document.getElementById('setting-budget-daily').value = s.budgetDaily;
  if (s.budgetMedicine)  document.getElementById('setting-budget-medicine').value = s.budgetMedicine;
  if (s.budgetElectric)  document.getElementById('setting-budget-electric').value = s.budgetElectric;
  if (s.budgetTransport) document.getElementById('setting-budget-transport').value = s.budgetTransport;
  if (s.budgetFixed)     document.getElementById('setting-budget-fixed').value = s.budgetFixed;
  if (s.budgetOther)     document.getElementById('setting-budget-other').value = s.budgetOther;
  // 保存済みのAPIキーがあれば入力欄に表示（一度入れれば次回から自動で入る）
  const savedKey = load('geminiApiKey', '');
  if (savedKey) document.getElementById('setting-api-key').value = savedKey;
}

document.getElementById('btn-save-settings').addEventListener('click', () => {
  const settings = {
    budget:          Number(document.getElementById('setting-budget').value) || 0,
    budgetFood:      Number(document.getElementById('setting-budget-food').value) || 0,
    budgetDaily:     Number(document.getElementById('setting-budget-daily').value) || 0,
    budgetMedicine:  Number(document.getElementById('setting-budget-medicine').value) || 0,
    budgetElectric:  Number(document.getElementById('setting-budget-electric').value) || 0,
    budgetTransport: Number(document.getElementById('setting-budget-transport').value) || 0,
    budgetFixed:     Number(document.getElementById('setting-budget-fixed').value) || 0,
    budgetOther:     Number(document.getElementById('setting-budget-other').value) || 0,
  };
  save('settings', settings);
  // APIキーは settings とは別のキーで保存する
  const apiKey = document.getElementById('setting-api-key').value.trim();
  save('geminiApiKey', apiKey);
  showStatus('settings-status', '✅ 設定を保存しました', 'success');
  updateKakeibo();
});

/* =============================================
   ■ 13. 家計簿タブの月ナビゲーション
============================================= */
document.getElementById('btn-view-prev-month').addEventListener('click', () => {
  viewMonth--;
  if (viewMonth < 1) { viewMonth = 12; viewYear--; }
  updateKakeibo();
});
document.getElementById('btn-view-next-month').addEventListener('click', () => {
  if (isCurrentMonthView()) return;
  viewMonth++;
  if (viewMonth > 12) { viewMonth = 1; viewYear++; }
  updateKakeibo();
});

/* =============================================
   ■ 14. 前月比較
============================================= */
function renderMonthComparison() {
  const container = document.getElementById('month-comparison-list');
  const title     = document.getElementById('month-comparison-title');
  if (!container) return;

  let prevYear = viewYear, prevMonth = viewMonth - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  const prevKey      = prevYear + '-' + String(prevMonth).padStart(2, '0');
  const prevExpenses = load('expenses_' + prevKey, []);

  if (title) title.textContent = `📊 前月比（${prevYear}年${prevMonth}月比）`;

  const rows = Object.entries(CATEGORIES).map(([key, cat]) => {
    const cur  = viewExpenses.filter(e => e.category === key).reduce((s, e) => s + e.amount, 0);
    const prev = prevExpenses.filter(e => e.category === key).reduce((s, e) => s + e.amount, 0);
    if (cur === 0 && prev === 0) return '';
    const diff  = cur - prev;
    const color = diff > 0 ? '#dc2626' : diff < 0 ? '#16a34a' : 'var(--text-muted)';
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '–';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;
        border-bottom:1px solid var(--border-soft);font-size:0.82rem;">
        <span style="flex:1;">${cat.label}</span>
        <span style="font-family:Outfit,monospace;color:var(--text-muted);font-size:0.76rem;white-space:nowrap;">
          ¥${cur.toLocaleString()}
        </span>
        <span style="font-weight:700;font-family:Outfit,monospace;color:${color};
          min-width:90px;text-align:right;white-space:nowrap;">
          ${arrow} ¥${Math.abs(diff).toLocaleString()}
        </span>
      </div>`;
  }).filter(Boolean).join('');

  container.innerHTML = rows ||
    `<div style="color:var(--text-muted);font-size:0.83rem;text-align:center;padding:12px 0;">
      ${prevYear}年${prevMonth}月のデータがありません
    </div>`;
}

/* =============================================
   ■ 15. 初期化
============================================= */
applyFixedCosts();
renderFoodList();
renderFixedCostList();
updateKakeibo();
loadSettings();
renderCalendar();
window.addEventListener('resize', () => { drawCategoryChart(); drawMonthlyChart(); });

/* =============================================
   ■ Service Worker の登録（PWA・オフライン対応）
   Cache APIを用いたオフラインキャッシュを有効にする。
   対応ブラウザでのみ登録され、非対応環境でも通常通り動作する。
============================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((reg) => {
        console.log('Service Worker 登録成功:', reg.scope);
      })
      .catch((err) => {
        console.log('Service Worker 登録失敗:', err);
      });
  });
}
