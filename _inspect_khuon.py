import glob, os, sys
import pikepdf

tmp = os.environ.get("TEMP") or os.environ.get("TMP")
files = glob.glob(os.path.join(tmp, "prynx_khuon_*.pdf"))
print(f"Found {len(files)} khuon files\n")

def scan(path):
    print("=" * 70)
    print(os.path.basename(path), f"({os.path.getsize(path)} bytes)")
    try:
        pdf = pikepdf.open(path)
    except Exception as e:
        print("  OPEN ERROR:", e)
        return
    # look for Filespecs / external file references anywhere
    ext_refs = []
    img_linked = []
    img_embedded = 0
    for obj in pdf.objects:
        try:
            d = obj
            if isinstance(d, pikepdf.Dictionary):
                t = str(d.get("/Type", ""))
                st = str(d.get("/Subtype", ""))
                if t == "/Filespec" or "/F" in d and t == "/Filespec":
                    ext_refs.append(("Filespec", str(d.get("/F", "")), str(d.get("/UF", ""))))
                if "/Ref" in d:
                    ext_refs.append(("RefXObject", repr(d.get("/Ref"))))
                if st == "/Image":
                    if "/F" in d:  # external file stream
                        img_linked.append(str(d.get("/F", "")))
                    else:
                        img_embedded += 1
                if st == "/Form" and "/Ref" in d:
                    ext_refs.append(("FormRef", repr(d.get("/Ref"))))
        except Exception:
            pass
    # scan annotations for Link/Filespec
    for pi, page in enumerate(pdf.pages):
        annots = page.get("/Annots")
        if annots:
            for a in annots:
                try:
                    if str(a.get("/Subtype","")) == "/Link" or "/FS" in a:
                        ext_refs.append(("Annot", pi, repr(dict(a))))
                except Exception:
                    pass
    print(f"  embedded images: {img_embedded}; linked images: {len(img_linked)} {img_linked}")
    print(f"  external refs: {len(ext_refs)}")
    for r in ext_refs[:20]:
        print("    ->", r)
    # Also search raw decompressed content for 'nup_' and '.pdf'
    hits = set()
    for obj in pdf.objects:
        try:
            if isinstance(obj, pikepdf.Stream):
                data = obj.read_bytes()
                if b"nup_" in data or b".pdf" in data:
                    import re
                    for m in re.findall(rb"[\w\-. ]*\.pdf", data)[:5]:
                        hits.add(m.decode("latin-1", "replace"))
        except Exception:
            pass
    if hits:
        print("  .pdf strings inside streams:", hits)
    pdf.close()

for f in sorted(files):
    scan(f)
