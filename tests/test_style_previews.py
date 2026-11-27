import json
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
STYLE_ROOT = ROOT / "assets" / "style-pool"


class StylePreviewTests(unittest.TestCase):
    def test_readme_previews_decode_completely_at_slide_size(self):
        registry = json.loads((STYLE_ROOT / "registry.json").read_text(encoding="utf-8"))
        for style in registry["styles"]:
            with self.subTest(style=style["id"]):
                preview = STYLE_ROOT / style["id"] / "preview.png"
                # Header dimensions and file size alone cannot detect broken IDAT chunks.
                with Image.open(preview) as image:
                    self.assertEqual(image.format, "PNG")
                    image.verify()
                # Reopen after verify() to require the entire image to decompress.
                with Image.open(preview) as image:
                    image.load()
                    self.assertEqual(image.size, (1280, 720))


if __name__ == "__main__":
    unittest.main()
