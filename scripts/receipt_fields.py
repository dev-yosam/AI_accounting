"""
從 OCR 結果 (文字 + 座標) 猜測收據的「總金額」欄位。

這裡的邏輯跟 server/static/app.js 裡的 guessAmount() 概念一樣
(找 "total" 標籤文字,取離它最近的金額數字),但數字格式改成
印尼盾這類「千分位逗號/句點分隔、沒有小數點」的格式
(例如 "1,591,600"),不是 app.js 那邊針對澳幣 "$12.34" 寫的正規表達式。

之所以獨立成一個檔案,是因為之後如果要評估其他資料集
(不同幣別格式、不同語言),或是要換成 LLM 版的欄位擷取,
都可以直接替換這裡的函式,不用去動 ocr_core.py 或 app.js。
"""

from __future__ import annotations

import re
from typing import Any, Optional

MONEY_PATTERN = re.compile(r"\d{1,3}(?:[.,]\d{3})+|\d{4,}")

TOTAL_LABEL_RE = re.compile(r"\btotal\b", re.IGNORECASE)
GRAND_TOTAL_LABEL_RE = re.compile(r"grand\s*total", re.IGNORECASE)
# 有些收據不寫 "Total",只寫 "(Amount) Due" / "Balance Due",一樣代表應付總額
DUE_LABEL_RE = re.compile(r"\bdue\b", re.IGNORECASE)
# 顧客實際付的現金/找零,金額通常比總金額大(因為含找零),不能誤判成總金額
CASH_LABEL_RE = re.compile(r"\b(cash|tunai|tender(?:ed)?|bayar)\b", re.IGNORECASE)


def normalize_money(raw: str) -> Optional[int]:
    """把 "1,591,600" / "1.591.600" / "-45" 這類字串轉成整數。

    CORD-v2 是印尼盾 (Rupiah),沒有小數點,千分位分隔符號可能是逗號或句點,
    所以直接把逗號、句點視為千分位符號拿掉,只留數字本身。
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    negative = text.startswith("-")
    digits = re.sub(r"[^\d]", "", text)
    if not digits:
        return None
    value = int(digits)
    return -value if negative else value


def _line_center_y(box: Optional[list]) -> Optional[float]:
    if not box:
        return None
    ys = [point[1] for point in box]
    return sum(ys) / len(ys)


def _money_candidates_in_line(lines: list[dict[str, Any]]) -> list[tuple[dict[str, Any], int]]:
    money_lines = []
    for line in lines:
        text = line.get("text") or ""
        matches = MONEY_PATTERN.findall(text)
        values = [normalize_money(m) for m in matches]
        values = [v for v in values if v is not None]
        if values:
            money_lines.append((line, max(values)))
    return money_lines


def _nearest_money_line(
    label_lines: list[dict[str, Any]],
    money_lines: list[tuple[dict[str, Any], int]],
    max_dist: float = 120.0,
) -> Optional[tuple[dict[str, Any], int]]:
    best = None
    best_dist = float("inf")
    for label in label_lines:
        label_y = _line_center_y(label.get("box"))
        if label_y is None:
            continue
        for line, value in money_lines:
            line_y = _line_center_y(line.get("box"))
            if line_y is None:
                continue
            dist = abs(line_y - label_y)
            if dist < best_dist:
                best_dist = dist
                best = (line, value)
    return best if best_dist <= max_dist else None


def extract_total_amount(lines: list[dict[str, Any]]) -> Optional[int]:
    """從一組 OCR 文字行裡猜測「總金額」。

    規則(依優先順序):
    1. 先找「現金付款」(CASH/TUNAI/TENDERED)最近的金額,把它從候選池排除,
       避免後面誤把「顧客付的錢」或「找零」當成總金額
       (這兩者通常比總金額大,很容易被「取最大值」的後備規則誤抓)
    2. 找 "Grand Total" 標籤,取離它最近的金額
    3. 找單獨的 "Total"(排除含 "sub" 的行,避免跟 Sub-Total 搞混),取最近的金額
    4. 找任何含 "total" 字樣的行,取最近的金額
    5. 找 "(Amount) Due" 這類不寫 "total" 但同樣代表應付總額的標籤,取最近的金額
    6. 都找不到標籤的話,退而求其次取剩餘候選裡最大的金額數字
       (大部分收據的總金額會是排除現金付款後,金額裡最大的一個)
    """
    money_lines = _money_candidates_in_line(lines)
    if not money_lines:
        return None

    def find_labels(pattern: re.Pattern, exclude_kw: Optional[str] = None) -> list[dict[str, Any]]:
        result = []
        for line in lines:
            text = line.get("text") or ""
            if not pattern.search(text):
                continue
            if exclude_kw and exclude_kw in text.lower():
                continue
            result.append(line)
        return result

    cash_labels = find_labels(CASH_LABEL_RE)
    cash_match = _nearest_money_line(cash_labels, money_lines)
    if cash_match is not None:
        excluded_line = cash_match[0]
        money_lines = [(l, v) for l, v in money_lines if l is not excluded_line] or money_lines

    for label_lines in (
        find_labels(GRAND_TOTAL_LABEL_RE),
        find_labels(TOTAL_LABEL_RE, exclude_kw="sub"),
        find_labels(TOTAL_LABEL_RE),
        find_labels(DUE_LABEL_RE),
    ):
        match = _nearest_money_line(label_lines, money_lines)
        if match is not None:
            return match[1]

    return max(v for _, v in money_lines)


def get_ground_truth_total(gt: dict[str, Any]) -> Optional[int]:
    """從 CORD-v2 的 gt_parse 裡取出 total.total_price 當作正確答案。

    少數收據的 "total" 欄位在資料集裡是 list 而不是 dict(多個候選值),
    這裡一律取第一個有值的 total_price。

    規則版 (cord_v2_eval.py) 跟 LLM 版 (cord_v2_eval_llm.py) 的評估腳本
    都共用這個函式,確保兩邊拿去比對的「正確答案」是同一套邏輯算出來的。
    """
    gt_parse = gt.get("gt_parse", {})
    total = gt_parse.get("total")
    candidates = total if isinstance(total, list) else [total] if isinstance(total, dict) else []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        raw = item.get("total_price")
        if raw:
            value = normalize_money(raw)
            if value is not None:
                return value
    return None
