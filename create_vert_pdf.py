import pikepdf

# Create a PDF with text (Vertical)
doc = pikepdf.Pdf.new()
page = doc.add_blank_page(page_size=(153.07, 255.12))
page.trimbox = [0, 0, 153.07, 255.12]

# Draw some text
stream = b"BT /F1 24 Tf 10 50 Td (VERTICAL) Tj ET"
page.contents_add(pikepdf.Stream(doc, stream))

# Add font
font = pikepdf.Dictionary(
    Type=pikepdf.Name.Font,
    Subtype=pikepdf.Name.Type1,
    BaseFont=pikepdf.Name.Helvetica
)
if "/Resources" not in page:
    page.Resources = pikepdf.Dictionary()
if "/Font" not in page.Resources:
    page.Resources.Font = pikepdf.Dictionary()
page.Resources.Font.F1 = font

doc.save("test_vert_in.pdf")
