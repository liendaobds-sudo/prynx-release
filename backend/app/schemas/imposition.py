from pydantic import BaseModel, Field
from typing import Optional

class ImpositionConfig(BaseModel):
    mode: str = Field("booklet", description="Mode of imposition: 'booklet' or 'nup'")
    n_up: int = Field(2, description="Number of pages per sheet side. E.g. 2 for standard booklet, 4 for 4-up.")
    formsize: str = Field("A4", description="Output paper size (e.g. A3, A4, SRA3)")
    binding: str = Field("booklet", description="Binding type: 'booklet', 'perfectbound', or 'advanced'")
    guides: bool = True
    margin: int = 0
    multifolio: bool = False
    foliosize: int = 8
    orientation: str = Field("rd", description="Orientation for N-up (rd, dr, ld, dl)")
    border: bool = True

class ImpositionRequest(BaseModel):
    # Depending on how the file is passed. It could be a file ID or we upload directly.
    # In this case, we usually upload directly via Form data in FastAPI, so this schema 
    # might just be for type checking JSON if needed, or we use Form() parameters.
    pass

class ImpositionResponse(BaseModel):
    success: bool
    message: str
    download_url: Optional[str] = None
