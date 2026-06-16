import pikepdf
pdf = pikepdf.Pdf.open(r"d:\pdfcompare\test_36_out_lshape.pdf")
for i in [0, 1]:
    print(f"Page {i+1} contents:")
    contents = pdf.pages[i].Contents
    if isinstance(contents, pikepdf.Array):
        for c in contents:
            print(c.read_bytes().decode('utf-8', errors='ignore')[:200])
    else:
        print(contents.read_bytes().decode('utf-8', errors='ignore')[:200])
