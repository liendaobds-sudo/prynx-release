import re
with open('d:/pdfcompare/1. dev -  Nô lệ bình bài.jsx', 'r', encoding='utf-8') as f:
    text = f.read()

for match in re.finditer(r'function\s+([A-Za-z0-9_]*layout[A-Za-z0-9_]*|[A-Za-z0-9_]*gang[A-Za-z0-9_]*|[A-Za-z0-9_]*arrange[A-Za-z0-9_]*)\s*\(', text, re.IGNORECASE):
    print(match.group(0))

print("\n--- Modes ---")
for match in re.finditer(r'function\s+(handle[A-Za-z0-9_]+Mode)\s*\(', text, re.IGNORECASE):
    print(match.group(0))
