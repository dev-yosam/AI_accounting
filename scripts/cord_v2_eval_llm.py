"""
用 CORD-v2 收據資料集評估「OCR + Gemini LLM 欄位擷取」的準確度。

跟 cord_v2_eval.py(規則版)是同一套評估邏輯,只是把
receipt_fields.extract_total_amount() 換成呼叫 Gemini 的
llm_field_extract.extract_fields_with_llm(),方便直接比較
「規則版」跟「LLM 版」兩份 precision/recall/F1。

會重複利用 cord_v2_eval.py 已經存好的 OCR 快取
(output/cord_v2/ocr/*.ocr.json),不會重新跑一次很慢的 OCR。

注意:CORD-v2 的 ground truth (gt_parse) 只有 menu / sub_total / total,
沒有商家名稱、日期這兩個欄位,所以這裡只能驗證 total_amount 的準確度;
merchant / date 這兩欄 LLM 一樣會擷取出來、存進 output/cord_v2/llm/*.json,
但沒有正確答案可以比對,不計入 precision/recall。

用法(需要先設定好 .env,見 .env.example):
    python scripts\\cord_v2_eval_llm.py
    python scripts\\cord_v2_eval_llm.py --sleep 6   (調整每次呼叫間隔,避免超過免費額度)
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.llm_field_extract import DEFAULT_MODEL, ReceiptFields, extract_fields_with_llm
from scripts.ocr_core import build_ocr_engine, run_ocr
from scripts.receipt_fields import get_ground_truth_total

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SAMPLES_DIR = PROJECT_ROOT / "samples" / "cord_v2"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "output" / "cord_v2"


def main() -> None:
    parser = argparse.ArgumentParser(description="用 CORD-v2 評估 OCR + Gemini 欄位擷取的準確度")
    parser.add_argument("--samples-dir", type=str, default=str(DEFAULT_SAMPLES_DIR))
    parser.add_argument("--output-dir", type=str, default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="要用哪個 Gemini 模型")
    parser.add_argument(
        "--sleep",
        type=float,
        default=4.5,
        help="每次呼叫 LLM 之間要等幾秒,避免超過免費方案的 RPM 限制(預設 4.5 秒)",
    )
    parser.add_argument("--no-ocr-cache", action="store_true", help="不使用 OCR 快取,強制重新跑 OCR")
    args = parser.parse_args()

    samples_dir = Path(args.samples_dir)
    images_dir = samples_dir / "images"
    gt_dir = samples_dir / "ground_truth"
    output_dir = Path(args.output_dir)
    ocr_output_dir = output_dir / "ocr"
    llm_output_dir = output_dir / "llm"
    llm_output_dir.mkdir(parents=True, exist_ok=True)

    image_paths = sorted(images_dir.glob("*.jpg"))
    if not image_paths:
        raise SystemExit(
            f"在 {images_dir} 找不到圖片,請先執行:\n  python scripts\\fetch_cord_v2_samples.py"
        )

    ocr = None

    def get_ocr():
        nonlocal ocr
        if ocr is None:
            print("載入 PaddleOCR 引擎中...")
            ocr = build_ocr_engine(lang="en")
        return ocr

    rows: list[dict] = []
    tp = fp = fn = 0
    skipped_no_gt = 0
    errors = 0

    for i, image_path in enumerate(image_paths):
        stem = image_path.stem
        gt_path = gt_dir / f"{stem}.json"
        if not gt_path.exists():
            print(f"[跳過] 找不到對應的 ground truth: {gt_path}")
            continue

        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        gt_total = get_ground_truth_total(gt)

        cache_path = ocr_output_dir / f"{stem}.ocr.json"
        if not args.no_ocr_cache and cache_path.exists():
            print(f"處理中: {image_path.name} (OCR 用快取)")
            ocr_result = json.loads(cache_path.read_text(encoding="utf-8"))
        else:
            print(f"處理中: {image_path.name} (重新跑 OCR)")
            ocr_result = run_ocr(get_ocr(), image_path, ocr_output_dir, save_visualization=False)
            ocr_output_dir.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(ocr_result, ensure_ascii=False), encoding="utf-8")

        lines = [line for page in ocr_result["pages"] for line in page["lines"]]

        try:
            fields: ReceiptFields = extract_fields_with_llm(lines, model=args.model)
        except Exception as exc:  # noqa: BLE001 - 單筆失敗不中止整批評估
            print(f"  [錯誤] LLM 擷取失敗: {exc}")
            errors += 1
            rows.append(
                {"id": stem, "predicted_total": None, "ground_truth_total": gt_total, "match": None, "error": str(exc)}
            )
            continue

        llm_json_path = llm_output_dir / f"{stem}.json"
        llm_json_path.write_text(fields.model_dump_json(indent=2, exclude_none=False), encoding="utf-8")

        pred_total = int(round(fields.total_amount)) if fields.total_amount is not None else None

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
                "merchant": fields.merchant,
                "date": fields.date,
            }
        )
        print(
            f"  merchant={fields.merchant!r} date={fields.date!r} "
            f"total={pred_total} (正確答案 {gt_total}) {status}"
        )

        if i < len(image_paths) - 1:
            time.sleep(args.sleep)

    evaluated = tp + fp + fn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    accuracy = tp / evaluated if evaluated > 0 else 0.0

    print("\n===== LLM 版金額欄位 (total_price) 評估結果 =====")
    print(f"圖片總數: {len(image_paths)}  (排除無 ground truth: {skipped_no_gt}, LLM 呼叫失敗: {errors})")
    print(f"納入評估的筆數: {evaluated}")
    print(f"TP: {tp}  FP: {fp}  FN: {fn}")
    print(f"Precision: {precision:.2%}")
    print(f"Recall:    {recall:.2%}")
    print(f"F1-score:  {f1:.2%}")
    print(f"Accuracy:  {accuracy:.2%}  ({tp}/{evaluated})")
    print(
        "\n注意:CORD-v2 沒有 merchant/date 的正確答案可以比對,"
        "上面只評估 total_amount;merchant/date 的擷取結果存在 output/cord_v2/llm/*.json 裡,"
        "可以肉眼抽查品質。"
    )

    report = {
        "dataset": "naver-clova-ix/cord-v2 (train split)",
        "method": "ocr + gemini llm",
        "model": args.model,
        "field": "total.total_price",
        "num_images": len(image_paths),
        "skipped_no_ground_truth": skipped_no_gt,
        "llm_errors": errors,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "accuracy": accuracy,
        "rows": rows,
    }
    report_path = output_dir / "eval_report_llm.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    csv_path = output_dir / "eval_report_llm.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f, fieldnames=["id", "predicted_total", "ground_truth_total", "match", "merchant", "date"]
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in ["id", "predicted_total", "ground_truth_total", "match", "merchant", "date"]})

    print(f"\n完整結果已輸出到:\n  {report_path}\n  {csv_path}\n  {llm_output_dir}\\ (每張收據的完整 LLM JSON)")


if __name__ == "__main__":
    main()
