# PaddleOCR JSON 辨識專案

用 [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 辨識收據/發票圖片,
輸出文字、座標(bounding box)、信心分數的 JSON,並可選擇性接 LLM 做結構化欄位擷取。

## 專案結構

```
paddleocr-json/
├── venv/                 # Python 虛擬環境
├── scripts/
│   ├── ocr_core.py             # 共用的 PaddleOCR 邏輯 (CLI 與伺服器共用)
│   ├── ocr_to_json.py          # 命令列工具:圖片 -> JSON
│   ├── receipt_fields.py       # 規則式欄位擷取
│   ├── llm_field_extract.py    # Gemini LLM 欄位擷取
│   ├── fetch_cord_v2_samples.py
│   ├── cord_v2_eval.py         # 規則式 vs CORD-v2 評估
│   └── cord_v2_eval_llm.py     # LLM vs CORD-v2 評估
├── server/               # 網頁伺服器,手機可直接拍照上傳辨識
│   ├── main.py
│   ├── static/           # index.html / style.css / app.js
│   ├── uploads/          # 手機上傳的原始照片 (自動產生)
│   └── output/           # 辨識結果的標框圖 (自動產生)
├── samples/              # 測試/輸入圖片
└── output/               # CLI 辨識結果 (JSON + 標框圖)
```

## 安裝

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip
.\venv\Scripts\python.exe -m pip install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
.\venv\Scripts\python.exe -m pip install paddleocr fastapi "uvicorn[standard]" python-multipart
```

第一次執行辨識時,程式會自動下載模型檔(存到 `C:\Users\<你>\.paddlex\official_models\`),
之後就可以離線使用,不需要再連網。

> 注意:PaddlePaddle 3.3.x 在 CPU + oneDNN 下有已知 bug
> ([PaddleOCR#18162](https://github.com/PaddlePaddle/PaddleOCR/issues/18162)),
> `scripts/ocr_core.py` 已用 `enable_mkldnn=False` 繞過。

## 用法一:命令列(在電腦上跑)

```powershell
.\venv\Scripts\python.exe scripts\ocr_to_json.py samples\你的圖片.jpg --vis
```

- `--vis`:額外輸出標示文字框的圖片,方便肉眼核對
- `--output-dir`:指定輸出資料夾(預設 `output/`)
- `--lang`:OCR 語言,預設 `en`(英文/數字),中文文件可改 `ch`
- 支援萬用字元一次處理多張:`samples\*.jpg`

結果會輸出到 `output\<檔名>.json`,格式:

```json
{
  "pages": [
    {
      "line_count": 11,
      "lines": [
        { "text": "WOOLWORTHS", "confidence": 0.999, "box": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] }
      ]
    }
  ]
}
```

## 用法二:網頁伺服器(方案 A,手機拍照直接看結果)

啟動伺服器:

```powershell
.\venv\Scripts\python.exe -m uvicorn server.main:app --host 0.0.0.0 --port 8000
```

- **這台電腦上測試**:瀏覽器打開 `http://127.0.0.1:8000`
- **手機上使用**:手機需要**連到跟這台電腦相同的區域網路**,瀏覽器打開
  `http://<這台電腦的區網IP>:8000`(IP 可用 `ipconfig` 查看 Wi-Fi 介面卡的 IPv4 位址)

網頁功能:拍照或從相簿選圖 → 自動上傳辨識 → 顯示每行文字、信心分數(綠/黃/紅),
可切換看原圖或標框結果圖,並可一鍵複製全部文字或查看原始 JSON。

### 手機連不上的排解方式

1. **確認手機和電腦連同一個 Wi-Fi**(不能一個用行動網路、一個用 Wi-Fi)
2. **Windows 防火牆**:第一次啟動伺服器時,Windows 可能會跳出「允許此應用程式通過防火牆」的提示,要點允許;
   如果沒跳出來,需要手動到「Windows Defender 防火牆」→「進階設定」→「輸入規則」新增一條允許 TCP 8000 的規則
   (或以系統管理員身分執行 PowerShell,執行 `New-NetFirewallRule -DisplayName "PaddleOCR-8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow`)
3. **公司/學校 Wi-Fi 可能有「用戶隔離 (Client Isolation)」**:同一個 Wi-Fi 底下的裝置彼此看不到,
   這種情況換成手機熱點分享網路給電腦、或改用家用 Wi-Fi 通常可以解決

## 已知的辨識瑕疵

- OCR 有時會把形似字元認錯,例如 `0/O`、`Q/G`(如 `QTY` 讀成 `GTY`)
- 拍攝時若有手指或雜物入鏡,可能出現極低信心分數(如 < 0.3)的假陽性偵測,
  後續處理建議直接濾掉信心分數過低的行

## 第二階段:接 LLM 做結構化欄位擷取

把 OCR 輸出的純文字,交給 [Google Gemini](https://aistudio.google.com/) 做語意理解,
轉成商家、日期、幣別、小計、稅金、總金額的結構化 JSON。

### 設定 API key(一次性)

1. 去 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 免費申請一個 Gemini API key
   (不需要信用卡,免費額度對測試用途綽綽有餘)
2. 複製 `.env.example` 成 `.env`,把 `GEMINI_API_KEY` 換成你剛申請的 key

```powershell
Copy-Item .env.example .env
notepad .env   # 貼上你自己的 key,存檔
```

`.env` 已經在 `.gitignore` 裡,不會被 commit 上 git,可以放心把專案分享給別人
(對方要跑 LLM 的部分,需要自己申請一組 key 填進他自己的 `.env`)。

### 用法

```powershell
.\venv\Scripts\python.exe scripts\cord_v2_eval_llm.py
```

- `scripts/llm_field_extract.py`:呼叫 Gemini,用 `response_schema` 強制輸出
  `merchant` / `date` / `currency` / `subtotal_amount` / `tax_amount` / `total_amount`
  這幾個欄位的合法 JSON
- `scripts/cord_v2_eval_llm.py`:沿用 `cord_v2_eval.py` 的 OCR 快取;每張收據的 LLM 輸出存在
  `output\cord_v2\llm\*.json`,評估報表存在 `output\cord_v2\eval_report_llm.json` / `.csv`
- 預設模型 `gemini-flash-lite-latest`,可以用 `--model` 換成別的模型
- 免費方案有 RPM 限制,腳本每筆之間會等 4.5 秒,跑 20 張圖約 1~2 分鐘;遇到 429 會自動重試

> CORD-v2 的正確答案只有 `total`,沒有商家名稱、日期,所以評估報表只驗證了
> `total_amount`;`merchant` / `date` 的結果會存下來,但要肉眼抽查品質。

## 用公開資料集評估辨識準確度(CORD-v2)

除了自己拍的收據,也可以用學術界常用的收據資料集
[CORD-v2](https://huggingface.co/datasets/naver-clova-ix/cord-v2) 來測試,
它每張收據都有正確答案(商家品項、小計、總金額等結構化欄位),
可以拿來算 precision / recall / F1,而不是只能肉眼檢查。

```powershell
# 1. 下載前 20 筆資料 (圖片 + 正確答案),存到 samples\cord_v2\
.\venv\Scripts\python.exe scripts\fetch_cord_v2_samples.py --count 20

# 2. 跑 OCR + 猜「總金額」欄位,跟正確答案比對,算出 precision/recall/F1
.\venv\Scripts\python.exe scripts\cord_v2_eval.py --vis
```

- `scripts/receipt_fields.py`:規則式擷取「總金額」欄位(找 "Total" 標籤取最近的金額,
  並排除現金付款/找零金額)
- `scripts/cord_v2_eval.py` 會把 OCR 結果快取到 `output\cord_v2\ocr\*.ocr.json`,重跑會比較快
  (要重新跑 OCR 的話加 `--no-cache`)
- 結果輸出到 `output\cord_v2\eval_report.json` / `.csv`,含每張圖的預測值、正確答案、是否命中

> 目前只評估「總金額」單一欄位,且規則是針對這 20 筆調的,建議另外抓一批
> 沒用過的資料(例如第 21~50 筆)重新測一次,數字才更可信。
