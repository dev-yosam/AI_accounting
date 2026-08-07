"""
第一階段:圖片 -> PaddleOCR -> OCR JSON (命令列版本)

只做文字偵測與辨識,輸出文字內容、座標(bounding box)與信心分數,
不做任何語意理解(那是第二階段接 LLM 才要做的事)。

用法:
    python scripts\\ocr_to_json.py samples\\sample_receipt.png
    python scripts\\ocr_to_json.py samples\\sample_receipt.png --output output\\result.json
    python scripts\\ocr_to_json.py samples\\*.png --output-dir output

想要用手機直接拍照辨識,請改用 server\\main.py (網頁版)。
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.ocr_core import build_ocr_engine, run_ocr

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "output"


def main() -> None:
    parser = argparse.ArgumentParser(description="PaddleOCR 圖片轉 JSON 工具")
    parser.add_argument("images", nargs="+", help="圖片路徑,支援萬用字元 (例如 samples/*.png)")
    parser.add_argument("--output", type=str, default=None, help="單一圖片時指定輸出 JSON 檔路徑")
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(DEFAULT_OUTPUT_DIR),
        help="輸出資料夾 (預設: output/)",
    )
    parser.add_argument("--lang", type=str, default="en", help="OCR 語言,預設 en (英文/數字)")
    parser.add_argument(
        "--vis",
        action="store_true",
        help="額外儲存標示出文字框的辨識結果圖片",
    )
    args = parser.parse_args()

    image_paths: list[Path] = []
    for pattern in args.images:
        matched = glob.glob(pattern)
        image_paths.extend(Path(p) for p in (matched or [pattern]))

    if not image_paths:
        raise SystemExit("找不到符合的圖片檔案")

    output_dir = Path(args.output_dir)
    ocr = build_ocr_engine(lang=args.lang)

    for image_path in image_paths:
        if not image_path.exists():
            print(f"[跳過] 找不到檔案: {image_path}")
            continue

        print(f"處理中: {image_path}")
        result = run_ocr(ocr, image_path, output_dir, save_visualization=args.vis)

        if args.output and len(image_paths) == 1:
            out_path = Path(args.output)
        else:
            out_path = output_dir / f"{image_path.stem}.json"

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  -> 已輸出: {out_path}")


if __name__ == "__main__":
    main()
