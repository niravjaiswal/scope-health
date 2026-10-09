"""Document page images -> faithful transcription via a vision model."""
import base64, io, asyncio
from .util import log

DOC_MODELS = [("google/gemini-3.5-flash", {}), ("openai/gpt-6.1-sol", {})]

PROMPT = ("Transcribe this clinic document page exactly as printed. Keep every name, number, unit, date, code and "
          "table row verbatim (tables as 'col | col | col' rows, one per line). Include headers such as patient name, "
          "record number/MRN, report number, dates (collected/received/printed), sender/practice, title and any "
          "handwritten entries. Do not interpret, summarize or correct anything. If something is illegible write [illegible].")


def shrink(data, width=1300):
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if im.width > width:
            im = im.resize((width, int(im.height * width / im.width)))
        out = io.BytesIO(); im.save(out, format="JPEG", quality=80)
        return out.getvalue(), "image/jpeg"
    except Exception:
        return data, "image/png"


async def transcribe(llm, images, model_idx=0):
    content = [{"type": "text", "text": PROMPT}]
    for d in images:
        b, mt = shrink(d)
        content.append({"type": "image_url", "image_url": {"url": f"data:{mt};base64," + base64.b64encode(b).decode()}})
    for model, extra in DOC_MODELS[model_idx:]:
        r = await llm.chat(model, [{"role": "user", "content": content}], max_tokens=3000, timeout=40, extra=extra, tag="doc")
        if r and r["content"].strip():
            return r["content"].strip()
    return "ERROR: could not read document"
