"""
從 Hugging Face 的 CORD-v2 收據資料集 (naver-clova-ix/cord-v2) 抓前 N 筆資料,
存成本機散檔,方便後續拿現有的 OCR pipeline 來測試、評估。

CORD-v2 是用 datasets 套件包成 parquet 檔釋出的,圖片跟正確答案 (ground_truth,
內含 gt_parse 結構化欄位) 是包在同一列資料裡,沒辦法直接右鍵另存新檔,所以用
Hugging Face 公開的 datasets-server API 把資料「匯出」成散檔:

    - <output-dir>/images/0000.jpg ~ 0019.jpg          原始收據圖片
    - <output-dir>/ground_truth/0000.json ~ 0019.json  對應的正確答案 (gt_parse 等)

用法:
    python scripts\\fetch_cord_v2_samples.py
    python scripts\\fetch_cord_v2_samples.py --count 20 --split train
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "samples" / "cord_v2"

DATASET = "naver-clova-ix/cord-v2"
FIRST_ROWS_API = "https://datasets-server.huggingface.co/first-rows"


def fetch_rows(split: str, count: int) -> list[dict]:
    """呼叫 datasets-server 的 first-rows API 取得前面幾筆資料的中繼資訊。

    這個 API 一次最多回傳約 100 筆 (含圖片預覽網址跟 ground_truth 字串),
    對於只想抓前 20~30 筆的情境已經足夠,不需要用到會下載整包 parquet 的
    datasets 套件。
    """
    resp = requests.get(
        FIRST_ROWS_API,
        params={"dataset": DATASET, "config": "default", "split": split},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    rows = data.get("rows", [])
    if len(rows) < count:
        raise SystemExit(
            f"first-rows API 只回傳 {len(rows)} 筆,不夠 {count} 筆。"
            "可以改用 datasets 套件下載完整資料集,或降低 --count。"
        )
    return rows[:count]


def main() -> None:
    parser = argparse.ArgumentParser(description="下載 CORD-v2 前 N 筆資料成散檔")
    parser.add_argument("--count", type=int, default=20, help="要抓幾筆 (預設 20)")
    parser.add_argument("--split", type=str, default="train", help="train/validation/test")
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(DEFAULT_OUTPUT_DIR),
        help=f"輸出資料夾 (預設: {DEFAULT_OUTPUT_DIR})",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    images_dir = output_dir / "images"
    gt_dir = output_dir / "ground_truth"
    images_dir.mkdir(parents=True, exist_ok=True)
    gt_dir.mkdir(parents=True, exist_ok=True)

    print(f"正在向 datasets-server 要 {DATASET} ({args.split} split) 前 {args.count} 筆資料...")
    rows = fetch_rows(args.split, args.count)

    for i, item in enumerate(rows):
        row = item["row"]
        image_info = row["image"]
        gt_raw = row["ground_truth"]

        image_url = image_info["src"]
        image_bytes = requests.get(image_url, timeout=60).content
        image_path = images_dir / f"{i:04d}.jpg"
        image_path.write_bytes(image_bytes)

        gt_obj = json.loads(gt_raw) if isinstance(gt_raw, str) else gt_raw
        gt_path = gt_dir / f"{i:04d}.json"
        gt_path.write_text(json.dumps(gt_obj, ensure_ascii=False, indent=2), encoding="utf-8")

        print(f"  [{i + 1}/{len(rows)}] 已存: {image_path.name} + {gt_path.name}")

    print(f"完成,共 {len(rows)} 筆,輸出到: {output_dir}")


if __name__ == "__main__":
    main()
