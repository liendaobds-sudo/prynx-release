import json
import urllib.request

req = urllib.request.Request("http://127.0.0.1:8321/api/imposition/pdf-meta", data=json.dumps({"path": r"D:\pdfcompare\backend\results"}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
try:
    res = urllib.request.urlopen(req)
    print(res.getcode(), res.read().decode())
except Exception as e:
    print(e)
