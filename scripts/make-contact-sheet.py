#!/usr/bin/env python3
"""Create a deterministic Pillow contact sheet from ordered PNG inputs."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


GUTTER = 16
LABEL_HEIGHT = 24
BACKGROUND = "#d1d5db"
LABEL_BACKGROUND = "#252525"


def page_id(index):
    return f"P{index:02d}"


def text_position(draw, label, font, width):
    bounds = draw.textbbox((0, 0), label, font=font)
    return ((width - (bounds[2] - bounds[0])) // 2, (LABEL_HEIGHT - (bounds[3] - bounds[1])) // 2)


def make_contact_sheet(inputs, output, columns, thumb_width):
    """Write ordered image paths as a labeled PNG contact sheet and return its path."""
    sources = [Path(item) for item in inputs]
    destination = Path(output)
    if not sources:
        raise ValueError("At least one input image is required")
    if columns < 1:
        raise ValueError("columns must be at least 1")
    if thumb_width < 1:
        raise ValueError("thumb_width must be at least 1")

    font = ImageFont.load_default()
    sample = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    if any(sample.textbbox((0, 0), page_id(index), font=font)[2] + 4 > thumb_width for index in range(1, len(sources) + 1)):
        raise ValueError("thumb_width is too small for the page labels")

    thumbnails = []
    for source in sources:
        with Image.open(source) as image:
            image.load()
            if image.width < 1 or image.height < 1:
                raise ValueError(f"Input image has invalid dimensions: {source}")
            height = max(1, round(thumb_width * image.height / image.width))
            thumbnails.append(image.convert("RGB").resize((thumb_width, height), Image.Resampling.LANCZOS))

    rows = [thumbnails[index:index + columns] for index in range(0, len(thumbnails), columns)]
    row_heights = [max(image.height for image in row) + LABEL_HEIGHT for row in rows]
    width = columns * thumb_width + (columns + 1) * GUTTER
    height = sum(row_heights) + (len(rows) + 1) * GUTTER
    sheet = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    source_index = 0
    top = GUTTER
    for row, row_height in zip(rows, row_heights):
        for column, thumbnail in enumerate(row):
            left = GUTTER + column * (thumb_width + GUTTER)
            sheet.paste(thumbnail, (left, top))
            label_top = top + thumbnail.height
            draw.rectangle((left, label_top, left + thumb_width - 1, label_top + LABEL_HEIGHT - 1), fill=LABEL_BACKGROUND)
            label = page_id(source_index + 1)
            draw.text((left + text_position(draw, label, font, thumb_width)[0], label_top + text_position(draw, label, font, thumb_width)[1]), label, fill="white", font=font)
            source_index += 1
        top += row_height + GUTTER

    destination.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(destination, format="PNG")
    return str(destination)


def expand_inputs(items):
    paths = []
    for item in items:
        path = Path(item)
        if path.is_dir():
            paths.extend(sorted(path.glob("*.png"), key=lambda candidate: candidate.name.casefold()))
        else:
            paths.append(path)
    return paths


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description="Create a Pillow slide contact sheet")
    parser.add_argument("--input", nargs="+", required=True, help="Ordered PNG files or directories containing PNGs")
    parser.add_argument("--output", required=True, help="Output PNG path")
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--thumb-width", type=int, default=320)
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    output = make_contact_sheet(
        expand_inputs(arguments.input),
        arguments.output,
        columns=arguments.columns,
        thumb_width=arguments.thumb_width,
    )
    print(output)


if __name__ == "__main__":
    main()
