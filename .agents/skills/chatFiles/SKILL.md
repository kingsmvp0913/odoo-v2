---
name: chatFiles
description: Use when a project-chat user asks you to hand them a downloadable file — Excel/CSV report, Word/PDF document, chart image, or a long SQL/text/JSON — covers where to save (the chat outbox path given in the prompt), allowed formats and limits, how to build each format with Traditional Chinese text, and how to revise a file from an earlier turn.
---

# chatFiles — 在專案對話裡交檔案給使用者

## 什麼時候用
- 使用者**明確要檔案**：「做成 Excel」「給我一份 PDF」「畫張圖」「把 SQL 存成檔」。
- 內容**明顯不適合貼在對話裡**：上百列的查詢結果、要轉交給別人的文件。
- 一般問答、幾行就講完的東西**不要做檔**。

## 放哪裡（硬規則）
- prompt 的【交付檔案】會給你本對話的**出貨箱**路徑。先 `mkdir -p <出貨箱>`，檔案**直接放在出貨箱這一層**。
- 回覆送出後，系統會把出貨箱這一層的檔案搬走、掛成那則回覆底下的下載按鈕。**你不用、也不要在回覆裡寫檔案路徑**。

- **有交檔案，回覆就不要再把資料貼一次**（不要貼查詢結果表格、清單、檔案全文）。使用者要的是下載按鈕，同一份資料貼兩次只是洗版。
  - 回覆只寫一兩句：做了什麼檔、幾筆、有沒有要注意的地方（例：「做好了，最近 10 筆叫修單，其中 5 筆沒填聯絡人。」）。
  - 使用者**同時明確要求**「也貼在對話裡」才貼。
- 不收、且會在回覆尾端標 ⚠ 的情況：
  - 子資料夾、捷徑／symlink
  - 副檔名不在下表，或內容與副檔名對不上（例：文字存成 `.xlsx`）
  - 單檔超過 25MB、一輪超過 5 個
- 檔名用使用者看得懂的名字（中文可），**一定要帶正確副檔名**，例：`2026年8月銷售明細.xlsx`。
- 不得把檔案寫到出貨箱以外的地方；不得把憑證、密碼、連線字串放進檔案。

## 允許的格式
| 種類 | 副檔名 |
|---|---|
| 試算表 | `.xlsx` `.csv` |
| 文件 | `.docx` `.pdf` |
| 純文字 | `.txt` `.md` `.json` `.xml` `.sql` `.log` |
| 圖片 | `.png` `.jpg` |

`.xls`／`.doc`／`.pptx` 不支援——使用者要的話說明改用 `.xlsx`／`.docx`。

## 怎麼做（python3，套件都已安裝）

**.xlsx**（openpyxl）
```python
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = '明細'
ws.append(['品名', '數量', '金額'])
for c in ws[1]: c.font = Font(bold=True)
for row in rows: ws.append(row)
ws.freeze_panes = 'A2'
wb.save(f'{outbox}/銷售明細.xlsx')
```

**.csv**：一律 `encoding='utf-8-sig'`——少了 BOM，使用者用 Excel 直接開中文會變亂碼。

**.docx**（python-docx）
```python
from docx import Document
doc = Document(); doc.add_heading('標題', level=1); doc.add_paragraph('內文')
t = doc.add_table(rows=1, cols=2); t.style = 'Table Grid'
doc.save(f'{outbox}/說明.docx')
```

**.pdf**（reportlab）：中文字型一定要嵌入（照下面找字型檔），段落要 `wordWrap='CJK'` 才會正確換行。
```python
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table
# 字型必須「嵌進」PDF：不嵌入的內建 CID 字型（MSung-Light）文字抽得出來，但沒裝那套字型的閱讀器畫面上中文是空白
for font_path, idx in [('/usr/share/fonts/truetype/arphic/uming.ttc', 2),              # AR PL UMing TW（容器內建）
                       (os.path.expanduser('~/.local/share/fonts/ntstcr.ttf'), 0)]:
    if os.path.exists(font_path):
        pdfmetrics.registerFont(TTFont('CJK', font_path, subfontIndex=idx)); break
else:
    raise SystemExit('找不到可嵌入的中文字型')   # 照實告訴使用者 PDF 做不出來，不要改用 MSung-Light
style = getSampleStyleSheet()['Normal']; style.fontName = 'CJK'; style.wordWrap = 'CJK'
doc = SimpleDocTemplate(f'{outbox}/報告.pdf', pagesize=A4)
doc.build([Paragraph('中文內容', style), Table([['欄1', '欄2']], style=[('FONTNAME', (0, 0), (-1, -1), 'CJK')])])
```

**.png 圖表**（matplotlib）
```python
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
# 字型名要跟 matplotlib 實際註冊到的一字不差，對不上會靜默退回 DejaVu、中文全變空白（.ttc 只認得到第一個 face，
# 所以 Noto CJK 在容器裡叫 JP 而不是 TC）。實測容器內這兩個名字都畫得出中文。
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK JP', 'AR PL UMing CN', 'Noto Sans CJK TC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
fig, ax = plt.subplots(figsize=(8, 4.5)); ax.bar(labels, values); ax.set_title('月營收')
fig.tight_layout(); fig.savefig(f'{outbox}/月營收.png', dpi=150)
```
中文若變方框或空白，代表字型名沒對上——用 `matplotlib.font_manager` 列出 `fontManager.ttflist` 的 `name` 看實際有哪些，別硬交一張看不懂的圖。

## 數字
金額、數量要四捨五入時用 `Decimal` + `ROUND_HALF_UP`，**不要用 `round()`**（銀行家捨入，30.5 會變 30）。

## 改前幾輪做過的檔
- 前幾輪的檔在**出貨箱的上一層** `<出貨箱>/../msg_<數字>/` 裡（磁碟檔名前面多了序號）。那一層是唯讀的，寫不進去是正常的。
- 讀進來修改後，**另存新檔到出貨箱這一層**，新按鈕會出現在這一輪的回覆；舊按鈕保持舊版，不會被蓋掉。

## 交出去之前
- 重新打開檢查一次（例：`load_workbook` 讀回列數、PDF 檔案大小 > 0）。
- 做失敗就照實說哪個檔沒做出來、為什麼，不要假裝附上了。
