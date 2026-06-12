import pikepdf
import sys
import re

pdf_path = r"C:\Users\Khanh Pham\Desktop\16 trang.pdf"

try:
    pdf = pikepdf.open(pdf_path)
    print(f"Total pages: {len(pdf.pages)}")
    
    for i in range(min(5, len(pdf.pages))):
        print(f"--- PAGE {i} ---")
        page = pdf.pages[i]
        
        # In pikepdf, page.Contents can be an Array or Stream
        contents = b""
        if "/Contents" in page:
            c = page.Contents
            if isinstance(c, pikepdf.Array):
                for stream in c:
                    contents += stream.read_bytes()
            else:
                contents = c.read_bytes()
                
        print(f"Content length: {len(contents)}")
        
        # print first 500 bytes of content stream
        print("Content preview (first 200 bytes):")
        print(contents[:200])
        
        if re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[kK](?:\s|$)', contents):
            print("FOUND CMYK operator (k/K)!")
        if re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[rgRG](?:\s|$)', contents):
            print("FOUND RGB operator (rg/RG)!")
        if re.search(b'(?:\s|^)[0-9.]+\s+[gG](?:\s|$)', contents):
            print("FOUND Gray operator (g/G)!")
            
except Exception as e:
    print("Error:", e)
