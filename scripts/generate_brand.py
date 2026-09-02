import base64
import os

assets_dir = r"c:\Users\Tms\Desktop\pravaah\apps\expo\assets"
favicon_path = os.path.join(assets_dir, "favicon.png")
brand_ts_path = r"c:\Users\Tms\Desktop\pravaah\apps\expo\lib\brand.ts"

with open(favicon_path, "rb") as f:
    b64 = base64.b64encode(f.read()).decode("utf-8")

data_uri = f"data:image/png;base64,{b64}"

content = f'''/**
 * Pravaah — Brand Assets & Web Metadata
 */

export const PRAVAAH_FAVICON_DATA_URI = "{data_uri}";
export const PRAVAAH_APP_TITLE = "Pravaah — Spoken English AI Coach";
'''

with open(brand_ts_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Successfully written", brand_ts_path)
