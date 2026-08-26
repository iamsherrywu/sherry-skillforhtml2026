import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "make-contact-sheet.py"


def load_contact_sheet_module():
    spec = importlib.util.spec_from_file_location("make_contact_sheet", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ContactSheetTests(unittest.TestCase):
    def test_contact_sheet_uses_two_columns_and_ordered_page_labels(self):
        module = load_contact_sheet_module()
        with tempfile.TemporaryDirectory(prefix="sherry-contact-sheet-") as temporary:
            root = Path(temporary)
            inputs = []
            for name, color in (("first.png", "#d92d20"), ("second.png", "#12b76a"), ("third.png", "#2e90fa")):
                source = root / name
                Image.new("RGB", (320, 180), color).save(source)
                inputs.append(source)
            output = root / "contact.png"

            result = module.make_contact_sheet(inputs, output, columns=2, thumb_width=160)

            self.assertEqual(Path(result), output)
            with Image.open(output) as sheet:
                self.assertEqual(sheet.size, (368, 276))
                self.assertEqual(sheet.getpixel((96, 61)), (217, 45, 32))
                self.assertEqual(sheet.getpixel((272, 61)), (18, 183, 106))
                self.assertEqual(sheet.getpixel((96, 191)), (46, 144, 250))
                self.assert_labels(sheet, [(16, 106, "P01"), (192, 106, "P02"), (16, 236, "P03")])

    def assert_labels(self, sheet, labels):
        font = ImageFont.load_default()
        for left, top, label in labels:
            expected = Image.new("RGB", (160, 24), "#252525")
            draw = ImageDraw.Draw(expected)
            bounds = draw.textbbox((0, 0), label, font=font)
            draw.text(((160 - (bounds[2] - bounds[0])) // 2, (24 - (bounds[3] - bounds[1])) // 2), label, fill="white", font=font)
            actual = sheet.crop((left, top, left + 160, top + 24)).convert("RGB")
            self.assertIsNone(ImageChops.difference(actual, expected).getbbox())


if __name__ == "__main__":
    unittest.main()
