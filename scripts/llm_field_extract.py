"""
用 Google Gemini API,把 OCR 辨識出來的文字轉成結構化欄位 JSON
(商家、日期、幣別、小計、稅金、總金額)。

跟 receipt_fields.py 的規則式 extract_total_amount() 是兩種不同的作法:
- receipt_fields.py:純規則(找 "Total" 標籤、取最近的金額),免費、快、
  但遇到沒見過的收據格式(例如寫 "Due" 不寫 "Total")就要手動補規則
- 這裡:交給 LLM 用語意理解去猜,遇到新格式不用手動加規則,
  但需要外部 API、有 rate limit、且結果不是 100% 決定性的

用法(需要先設定 .env,見 .env.example):
    from scripts.llm_field_extract import extract_fields_with_llm
    fields = extract_fields_with_llm(lines)  # lines 是 ocr_core.run_ocr() 回傳的 lines
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import errors as genai_errors
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")

SYSTEM_INSTRUCTION = """\
你是一個從收據 OCR 文字中擷取結構化欄位的工具。
輸入是 PaddleOCR 辨識出來的文字行,大致按照收據上從上到下的閱讀順序排列。

規則:
1. total_amount 是顧客實際應付的「總金額」,標籤通常是 Total / Grand Total /
   (Amount) Due,不是 Subtotal,也不是 Cash / Tunai / Tendered
   (顧客付的現金,可能比總金額多,不要跟總金額搞混)。
2. subtotal_amount 是加稅/服務費之前的小計,tax_amount 是稅金或服務費。
3. merchant 是店家/商家名稱,通常在收據最上方。
4. date 請轉成 YYYY-MM-DD 格式;如果年份只有兩位數,用常理判斷世紀;
   完全看不出日期就填 null。
5. currency 填三碼幣別代碼(例如 IDR、AUD、TWD),看不出來就填 null。
6. 金額欄位只填數字本身(不含幣別符號、千分位逗號)。
7. 任何欄位如果有多個候選值、或完全看不出來,請填 null,不要用猜的硬填一個值。
"""


class ReceiptFields(BaseModel):
    merchant: Optional[str] = Field(default=None, description="店家/商家名稱")
    date: Optional[str] = Field(default=None, description="交易日期,YYYY-MM-DD")
    currency: Optional[str] = Field(default=None, description="三碼幣別代碼,例如 IDR/AUD/TWD")
    subtotal_amount: Optional[float] = Field(default=None, description="小計(加稅前)")
    tax_amount: Optional[float] = Field(default=None, description="稅金或服務費")
    total_amount: Optional[float] = Field(default=None, description="應付總金額")


_client: Optional[genai.Client] = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "找不到 GEMINI_API_KEY。請複製 .env.example 成 .env,"
                "填入你自己的 Gemini API key (https://aistudio.google.com/apikey 免費申請)。"
            )
        _client = genai.Client(api_key=api_key)
    return _client


def lines_to_ocr_text(lines: list[dict[str, Any]]) -> str:
    """把 OCR lines 依原本偵測順序接成純文字,一行一個文字框。"""
    return "\n".join((line.get("text") or "").strip() for line in lines if line.get("text"))


def extract_fields_with_llm(
    lines: list[dict[str, Any]],
    model: str = DEFAULT_MODEL,
    max_retries: int = 3,
) -> ReceiptFields:
    """呼叫 Gemini,把 OCR 文字轉成結構化欄位。

    遇到 429 (rate limit) 會用指數退避重試幾次;其他錯誤直接往外拋出,
    呼叫端可以決定要跳過這筆還是中止。
    """
    client = get_client()
    ocr_text = lines_to_ocr_text(lines)

    last_error: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=model,
                contents=f"收據 OCR 文字如下:\n\n{ocr_text}",
                config={
                    "system_instruction": SYSTEM_INSTRUCTION,
                    "response_mime_type": "application/json",
                    "response_schema": ReceiptFields,
                    "temperature": 0,
                },
            )
            if response.parsed is not None:
                return response.parsed
            return ReceiptFields.model_validate_json(response.text)
        except genai_errors.ClientError as exc:
            last_error = exc
            if getattr(exc, "code", None) == 429 and attempt < max_retries - 1:
                wait_s = 2 ** attempt * 5
                print(f"  [rate limit] 等 {wait_s} 秒後重試 ({attempt + 1}/{max_retries})...")
                time.sleep(wait_s)
                continue
            raise

    raise last_error  # pragma: no cover - 理論上不會走到這裡
