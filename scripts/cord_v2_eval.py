"""
用 CORD-v2 收據資料集評估目前 OCR + 金額欄位擷取的準確度。

流程:
    1. 讀取 samples/cord_v2/images/*.jpg (用 fetch_cord_v2_samples.py 先下載好)
    2. 對每張圖跑現有的 PaddleOCR pipeline (scripts/ocr_core.py)
    3. 用 scripts/receipt_fields.py 的規則猜總金額 (total_price)
    4. 跟 samples/cord_v2/ground_truth/*.json 的正確答案比對
    5. 算出 precision / recall / F1 / accuracy,輸出報表

用法:
    python scripts\\cord_v2_eval.py
    python scripts\\cord_v2_eval.py --vis   (額外輸出標框圖,方便肉眼核對辨識錯誤)
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.ocr_core import build_ocr_engine, run_ocr
from scripts.receipt_fields import extract_total_amount, get_ground_truth_total

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SAMPLES_DIR = PROJECT_ROOT / "samples" / "cord_v2"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "output" / "cord_v2"


def main() -> None:
    parser = argparse.ArgumentParser(description="用 CORD-v2 評估 OCR + 金額擷取的準確度")
    parser.add_argument("--samples-dir", type=str, default=str(DEFAULT_SAMPLES_DIR))
    parser.add_argument("--output-dir", type=str, default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--vis", action="store_true", help="額外輸出標框圖,方便肉眼核對辨識錯誤")
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="不使用快取的 OCR 結果,強制重新跑一次 OCR (預設會重複利用上次的辨識結果,只有調整欄位擷取規則時可以秒重跑)",
    )
    args = parser.parse_args()

    samples_dir = Path(args.samples_dir)
    images_dir = samples_dir / "images"
    gt_dir = samples_dir / "ground_truth"
    output_dir = Path(args.output_dir)
    ocr_output_dir = output_dir / "ocr"
    output_dir.mkdir(parents=True, exist_ok=True)

    image_paths = sorted(images_dir.glob("*.jpg"))
    if not image_paths:
        raise SystemExit(
            f"在 {images_dir} 找不到圖片,請先執行:\n"
            f"  python scripts\\fetch_cord_v2_samples.py"
        )

    ocr = None  # 延遲載入,如果所有圖片都能吃快取,就完全不需要載入 PaddleOCR

    def get_ocr():
        nonlocal ocr
        if ocr is None:
            print("載入 PaddleOCR 引擎中...")
            ocr = build_ocr_engine(lang="en")
        return ocr

    rows: list[dict] = []
    tp = fp = fn = 0
    skipped_no_gt = 0

    for image_path in image_paths:
        stem = image_path.stem
        gt_path = gt_dir / f"{stem}.json"
        if not gt_path.exists():
            print(f"[跳過] 找不到對應的 ground truth: {gt_path}")
            continue

        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        gt_total = get_ground_truth_total(gt)

        cache_path = ocr_output_dir / f"{stem}.ocr.json"
        if not args.no_cache and cache_path.exists():
            print(f"處理中: {image_path.name} (使用快取的 OCR 結果)")
            result = json.loads(cache_path.read_text(encoding="utf-8"))
        else:
            print(f"處理中: {image_path.name}")
            result = run_ocr(get_ocr(), image_path, ocr_output_dir, save_visualization=args.vis)
            ocr_output_dir.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

        lines = [line for page in result["pages"] for line in page["lines"]]

        pred_total = extract_total_amount(lines)

        if gt_total is None:
            skipped_no_gt += 1
            match: Optional[bool] = None
            status = "(無 ground truth,不計入評估)"
        else:
            match = pred_total is not None and pred_total == gt_total
            if match:
                tp += 1
                status = "OK"
            elif pred_total is not None:
                fp += 1
                status = "NG (擷取到錯誤金額)"
            else:
                fn += 1
                status = "NG (沒擷取到金額)"

        rows.append(
            {
                "id": stem,
                "predicted_total": pred_total,
                "ground_truth_total": gt_total,
                "match": match,
            }
        )
        print(f"  預測: {pred_total}  正確答案: {gt_total}  {status}")

    evaluated = tp + fp + fn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    accuracy = tp / evaluated if evaluated > 0 else 0.0

    print("\n===== 金額欄位 (total_price) 評估結果 =====")
    print(f"圖片總數: {len(image_paths)}  (排除無 ground truth: {skipped_no_gt})")
    print(f"納入評估的筆數: {evaluated}")
    print(f"TP (擷取且正確): {tp}")
    print(f"FP (擷取但金額錯誤): {fp}")
    print(f"FN (該有卻沒擷取到): {fn}")
    print(f"Precision: {precision:.2%}")
    print(f"Recall:    {recall:.2%}")
    print(f"F1-score:  {f1:.2%}")
    print(f"Accuracy:  {accuracy:.2%}  ({tp}/{evaluated})")

    report = {
        "dataset": "naver-clova-ix/cord-v2 (train split)",
        "field": "total.total_price",
        "num_images": len(image_paths),
        "skipped_no_ground_truth": skipped_no_gt,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "accuracy": accuracy,
        "rows": rows,
    }
    report_path = output_dir / "eval_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_path = output_dir / "eval_report.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "predicted_total", "ground_truth_total", "match"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n完整結果已輸出到:\n  {report_path}\n  {csv_path}")


if __name__ == "__main__":
    main()
