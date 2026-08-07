"""
共用的 PaddleOCR 核心邏輯。

同時給命令列工具 (ocr_to_json.py) 與網頁伺服器 (server/main.py) 使用,
避免兩邊各寫一份重複的辨識邏輯。

只做文字偵測與辨識,輸出文字內容、座標(bounding box)與信心分數,
不做任何語意理解(那是第二階段接 LLM 才要做的事)。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from paddleocr import PaddleOCR


def build_ocr_engine(lang: str = "en") -> PaddleOCR:
    """建立 PaddleOCR 引擎。

    lang="en" 適合英文/數字為主的澳洲收據、帳單;
    如果文件含中文,可改成 lang="ch"。
    """
    return PaddleOCR(
        lang=lang,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        # PaddlePaddle 3.3.x 的 oneDNN + PIR 執行模式在 CPU 上有已知 bug
        # (ConvertPirAttribute2RuntimeAttribute not support ArrayAttribute),
        # 關閉 oneDNN 可繞過此問題。詳見:
        # https://github.com/PaddlePaddle/PaddleOCR/issues/18162
        enable_mkldnn=False,
    )


def result_to_plain_dict(result: Any, image_path: str) -> dict:
    """把 PaddleOCR 的 predict() 結果轉成精簡、好讀的 JSON 結構。

    包含每一段文字的:
      - text: 辨識出來的文字
      - confidence: 信心分數 (0~1)
      - box: 四個角點座標 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
    """
    res = result.json.get("res", {})
    texts = res.get("rec_texts", [])
    scores = res.get("rec_scores", [])
    polys = res.get("rec_polys", res.get("dt_polys", []))

    lines = []
    for i, text in enumerate(texts):
        score = float(scores[i]) if i < len(scores) else None
        poly = polys[i] if i < len(polys) else None
        box = [[float(x), float(y)] for x, y in poly] if poly is not None else None
        lines.append({"text": text, "confidence": score, "box": box})

    return {
        "image_path": image_path,
        "line_count": len(lines),
        "lines": lines,
    }


def run_ocr(
    ocr: PaddleOCR,
    image_path: Path,
    output_dir: Path,
    save_visualization: bool = False,
) -> dict:
    """對單一圖片執行 OCR,回傳整理過的結果字典。

    save_visualization=True 時,會額外把標框圖存到 output_dir,
    並在回傳值的 "vis_paths" 裡列出存檔路徑。
    """
    results = ocr.predict(str(image_path))

    output_dir.mkdir(parents=True, exist_ok=True)
    combined: dict[str, Any] = {"image_path": str(image_path), "pages": []}
    vis_paths: list[Path] = []

    for page_idx, page_result in enumerate(results):
        page_dict = result_to_plain_dict(page_result, str(image_path))
        combined["pages"].append(page_dict)

        if save_visualization:
            vis_path = output_dir / f"{image_path.stem}_page{page_idx}_vis.png"
            page_result.save_to_img(str(vis_path))
            vis_paths.append(vis_path)

    combined["vis_paths"] = [str(p) for p in vis_paths]
    return combined
