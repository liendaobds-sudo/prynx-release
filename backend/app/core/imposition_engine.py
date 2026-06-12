import os
import subprocess
import asyncio
import platform
import logging
from typing import Optional, List

logger = logging.getLogger(__name__)

class ImpositionError(Exception):
    pass

class ImpositionEngine:
    """
    Core engine to interact with pdfcpu binary for imposition (booklet, n-up)
    """

    @staticmethod
    def get_binary_path() -> str:
        """Get the path to the pdfcpu executable depending on the OS."""
        if platform.system() == "Windows":
            # Relative to this file: backend/app/core/imposition_engine.py
            # Binary is at backend/bin/pdfcpu.exe
            base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            exe_path = os.path.join(base_dir, "bin", "pdfcpu.exe")
            if os.path.exists(exe_path):
                return exe_path
            logger.warning(f"Local pdfcpu.exe not found at {exe_path}. Falling back to system PATH.")
            return "pdfcpu.exe"
        else:
            # On Linux/Docker, it's installed globally via Dockerfile
            return "pdfcpu"

    @classmethod
    async def validate_pdf(cls, input_pdf: str) -> bool:
        """
        Validate PDF file before processing to prevent corrupted file errors.
        """
        binary = cls.get_binary_path()
        cmd = [binary, "validate", input_pdf]
        try:
            logger.info(f"Validating PDF: {input_pdf}")
            await cls._run_command(cmd)
            return True
        except ImpositionError as e:
            raise ImpositionError(f"PDF Validation Failed (File might be corrupted or password protected): {str(e)}")

    @classmethod
    async def process_booklet(
        cls, 
        input_pdf: str, 
        output_pdf: str, 
        n_up: int = 2,
        formsize: str = "A4",
        binding: str = "booklet",
        guides: bool = True,
        margin: int = 0,
        multifolio: bool = False,
        foliosize: int = 8
    ) -> bool:
        """
        Create a booklet from the input PDF.
        """
        binary = cls.get_binary_path()
        
        # Build description string
        guides_str = "on" if guides else "off"
        multifolio_str = "on" if multifolio else "off"
        
        desc = f"formsize:{formsize}, guides:{guides_str}, btype:{binding}, margin:{margin}, multifolio:{multifolio_str}"
        if multifolio:
            desc += f", foliosize:{foliosize}"
            
        cmd = [
            binary, 
            "booklet", 
            "--", 
            desc, 
            output_pdf, 
            str(n_up), 
            input_pdf
        ]
        
        return await cls._run_command(cmd)

    @classmethod
    async def process_nup(
        cls,
        input_pdf: str,
        output_pdf: str,
        n_up: int = 4,
        formsize: str = "A4",
        orientation: str = "rd", # right down
        border: bool = True,
        margin: int = 3
    ) -> bool:
        """
        Create an N-up layout (e.g. 4 pages on 1 sheet).
        """
        binary = cls.get_binary_path()
        
        border_str = "on" if border else "off"
        desc = f"formsize:{formsize}, orientation:{orientation}, border:{border_str}, margin:{margin}"
        
        cmd = [
            binary,
            "nup",
            "--",
            desc,
            output_pdf,
            str(n_up),
            input_pdf
        ]
        
        return await cls._run_command(cmd)

    @staticmethod
    async def _run_command(cmd: List[str]) -> bool:
        import subprocess
        try:
            logger.info(f"Running imposition command: {' '.join(cmd)}")
            proc = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                timeout=300
            )
            
            if proc.returncode != 0:
                err_msg = proc.stderr.decode('utf-8', errors='ignore').strip()
                if not err_msg:
                    err_msg = proc.stdout.decode('utf-8', errors='ignore').strip()
                full_err = f"Imposition failed. Exit code: {proc.returncode}. Error: {err_msg}"
                logger.error(full_err)
                raise ImpositionError(full_err)
                
            logger.info("pdfcpu executed successfully.")
            return True
        except ImpositionError:
            raise
        except Exception as e:
            err_msg = f"Unexpected error running pdfcpu: {str(e)}"
            logger.error(err_msg)
            raise ImpositionError(err_msg)
