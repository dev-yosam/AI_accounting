"""
方案 A:PaddleOCR 網頁伺服器版。

讓手機瀏覽器可以直接拍照上傳照片,呼叫這台電腦上跑的 PaddleOCR 做辨識,
即時看到文字、座標、信心分數的結果。目前 **不含 LLM** 語意理解那一階段。

啟動方式(在專案根目錄執行):
    .\\venv\\Scripts\\python.exe -m uvicorn server.main:app --host 0.0.0.0 --port 8000

啟動後:
    - 這台電腦上用瀏覽器打開 http://127.0.0.1:8000 即可測試
    - 手機(需與電腦連在同一個 Wi-Fi)用瀏覽器打開 http://<這台電腦的區網IP>:8000
"""

from __future__ import annotations

import shutil
import sys
import uuid
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from scripts.ocr_core import build_ocr_engine, run_ocr

UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
STATIC_DIR = Path(__file__).resolve().parent / "static"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB,避免手機原圖過大拖垮辨識速度

app = FastAPI(title="PaddleOCR 手機拍照辨識 (第一階段,不含 LLM)")

# 提供 index.html 引用的 style.css / app.js 等靜態檔案
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_ocr_engine = None


def get_ocr_engine():
    """延遲載入 PaddleOCR 引擎,並在伺服器存活期間重複使用,避免每次上傳都重新載入模型。"""
    global _ocr_engine
    if _ocr_engine is None:
        _ocr_engine = build_ocr_engine(lang="en")
    return _ocr_engine


@app.on_event("startup")
def _warm_up_model() -> None:
    # 伺服器啟動時就先把模型載入好,第一次手機上傳時才不用多等模型載入的時間。
    get_ocr_engine()


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html_path = STATIC_DIR / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.post("/api/ocr")
async def ocr_endpoint(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "請上傳圖片檔案")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    unique_id = uuid.uuid4().hex[:8]
    suffix = Path(file.filename or "photo.jpg").suffix or ".jpg"
    saved_name = f"{timestamp}_{unique_id}{suffix}"
    saved_path = UPLOAD_DIR / saved_name

    size = 0
    with saved_path.open("wb") as out_file:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out_file.close()
                saved_path.unlink(missing_ok=True)
                raise HTTPException(413, "圖片太大,請重新拍攝或壓縮後再試 (上限 20MB)")
            out_file.write(chunk)

    try:
        ocr = get_ocr_engine()
        result = run_ocr(ocr, saved_path, OUTPUT_DIR, save_visualization=True)
    except Exception as exc:  # noqa: BLE001 - 直接把錯誤訊息回傳給前端方便除錯
        raise HTTPException(500, f"辨識失敗: {exc}") from exc

    vis_url = None
    if result.get("vis_paths"):
        vis_filename = Path(result["vis_paths"][0]).name
        vis_url = f"/api/output-image/{vis_filename}"

    return {
        "original_image_url": f"/api/upload-image/{saved_name}",
        "vis_image_url": vis_url,
        "pages": result["pages"],
    }


@app.get("/api/upload-image/{filename}")
def get_upload_image(filename: str) -> FileResponse:
    path = UPLOAD_DIR / filename
    if not path.exists() or path.parent != UPLOAD_DIR:
        raise HTTPException(404, "找不到檔案")
    return FileResponse(path)


@app.get("/api/output-image/{filename}")
def get_output_image(filename: str) -> FileResponse:
    path = OUTPUT_DIR / filename
    if not path.exists() or path.parent != OUTPUT_DIR:
        raise HTTPException(404, "找不到檔案")
    return FileResponse(path)
