import pikepdf

# Create a PDF with text
doc = pikepdf.Pdf.new()
page = doc.add_blank_page(page_size=(255.12, 153.07))
page.trimbox = [0, 0, 255.12, 153.07]

# Draw some text
stream = b"BT /F1 24 Tf 10 50 Td (FRONT SIDE) Tj ET"
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

doc.save("test_text_in.pdf")
