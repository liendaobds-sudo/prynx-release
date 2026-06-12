import urllib.request
import json

try:
    with urllib.request.urlopen("http://localhost:8321/openapi.json") as response:
        openapi = json.loads(response.read().decode())
        paths = openapi.get("paths", {})
        for path in paths:
            print(path)
except Exception as e:
    print("Error:", e)
