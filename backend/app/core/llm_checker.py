import logging
import httpx
import re
from typing import List

logger = logging.getLogger(__name__)

# The System Prompt is highly tuned for the Prepress Proofing scenario
SYSTEM_PROMPT = """Bạn là chuyên gia soát lỗi chế bản in ấn (Proofreader). 
Dưới đây là một phần nội dung bóc tách từ file thiết kế PDF gốc. 
Nhiệm vụ của bạn là rà soát và CHỈ phát hiện/liệt kê những từ/cụm từ bị sai chính tả Tiếng Việt hoặc sai ngữ cảnh nghiêm trọng (ví dụ: 'chuẩn pay' thay vì 'chuẩn bay').
Nếu toàn bộ đoạn văn bản hoàn toàn không có lỗi, hãy báo về chuỗi rỗng: "".
TUYỆT ĐỐI KHÔNG giải thích dài dòng, KHÔNG chào hỏi. Đi thẳng vào việc liệt kê các cụm từ sai."""

class LLMChecker:
    """
    Handles the execution of spelling and grammar verification.
    Acts as the 'Final Gatekeeper' by identifying human-derived typos in text.
    """
    
    @staticmethod
    def preprocess_text(text: str) -> str:
        """Sanitizes text by removing CID font artifacts and redundant spaces."""
        text = re.sub(r'\(cid:\d+\)', '', text)
        return re.sub(r'\s+', ' ', text).strip()

    @staticmethod
    def check_text_cloud(text: str, api_key: str, provider: str = "deepseek") -> List[str]:
        """Calls Cloud APIs based on explicit provider."""
        text = LLMChecker.preprocess_text(text)
        if not text or not api_key:
            return []
            
        try:
            with httpx.Client(timeout=60.0) as client:
                if provider == "gemini" or api_key.startswith("AIza"):
                    # Google Gemini API
                    response = client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}",
                        headers={"Content-Type": "application/json"},
                        json={
                            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                            "contents": [{"parts": [{"text": f"Văn bản cần soát lỗi:\n\n{text}"}]}],
                            "generationConfig": {"temperature": 0.0}
                        }
                    )
                    response.raise_for_status()
                    data = response.json()
                    
                    try:
                        reply = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                    except (KeyError, IndexError):
                        reply = ""
                elif provider == "openai":
                    # OpenAI ChatGPT API
                    response = client.post(
                        "https://api.openai.com/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "model": "gpt-4o-mini",
                            "messages": [
                                {"role": "system", "content": SYSTEM_PROMPT},
                                {"role": "user", "content": f"Văn bản cần soát lỗi:\n\n{text}"}
                            ],
                            "temperature": 0.0
                        }
                    )
                    response.raise_for_status()
                    data = response.json()
                    reply = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                else:
                    # Default: DeepSeek API
                    response = client.post(
                        "https://api.deepseek.com/chat/completions",
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "model": "deepseek-chat",
                            "messages": [
                                {"role": "system", "content": SYSTEM_PROMPT},
                                {"role": "user", "content": f"Văn bản cần soát lỗi:\n\n{text}"}
                            ],
                            "temperature": 0.0
                        }
                    )
                    response.raise_for_status()
                    data = response.json()
                    reply = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                
                # If the AI says 'empty' or finds no errors, just return empty list
                if not reply or reply.lower() in ['""', "''", "không có lỗi", "no errors"]:
                    return []
                    
                # Split the raw list into lines 
                return [line.strip("- ") for line in reply.split("\n") if line.strip()]

        except Exception as e:
            logger.error(f"Cloud API Error: {e}")
            return [f"Lỗi kết nối API ({provider}): {str(e)}"]

