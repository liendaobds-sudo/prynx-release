import sqlite3, json

conn = sqlite3.connect('d:/pdfcompare/backend/data/pdfcompare.db')
c = conn.cursor()
c.execute("SELECT diff_regions FROM page_results ORDER BY rowid DESC LIMIT 1")
row = c.fetchone()
regions = json.loads(row[0])
print(f"Total: {len(regions)} regions\n")
for i, r in enumerate(regions):
    px = f"px({r.get('x')},{r.get('y')},{r.get('width')},{r.get('height')})"
    nm = f"norm({r.get('nx','?')},{r.get('ny','?')},{r.get('nw','?')},{r.get('nh','?')})"
    print(f"R{i}: {px}  {nm}  {r.get('severity')}")
conn.close()
