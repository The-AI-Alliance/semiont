#!/usr/bin/env python3
"""
Generate favicon files in multiple formats from SVG source.
Requires: pip install cairosvg pillow
"""

import os
import sys
from pathlib import Path

try:
    import cairosvg
    from PIL import Image
except ImportError:
    print("Required packages not found. Please install:")
    print("  pip install cairosvg pillow")
    sys.exit(1)

# Paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
SVG_PATH = PROJECT_ROOT / "packages/react-ui/public/favicons/favicon.svg"
FAVICON_DIR = PROJECT_ROOT / "packages/react-ui/public/favicons"

# Ensure output directory exists
FAVICON_DIR.mkdir(parents=True, exist_ok=True)

# Sizes to generate
PNG_SIZES = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "favicon-48x48.png": 48,
    "favicon-64x64.png": 64,
    "favicon-96x96.png": 96,
    "favicon-128x128.png": 128,
    "apple-touch-icon.png": 180,
    "android-chrome-192x192.png": 192,
    "android-chrome-512x512.png": 512,
}

def svg_to_png(svg_path, png_path, size):
    """Convert SVG to PNG at specified size."""
    print(f"Generating {png_path.name} ({size}x{size})...")
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(png_path),
        output_width=size,
        output_height=size
    )

def create_ico(png_sizes_paths):
    """Create ICO file with multiple sizes."""
    print("Generating favicon.ico...")
    ico_path = FAVICON_DIR / "favicon.ico"

    # Load the required sizes for ICO
    images = []
    for size in [16, 32, 48]:
        png_name = f"favicon-{size}x{size}.png"
        png_path = FAVICON_DIR / png_name
        if png_path.exists():
            img = Image.open(png_path)
            images.append(img)

    if images:
        # Save as ICO with multiple sizes
        images[0].save(
            ico_path,
            format='ICO',
            sizes=[(16, 16), (32, 32), (48, 48)],
            append_images=images[1:]
        )
        print(f"Created {ico_path.name}")
    else:
        print("Warning: Could not create ICO file - missing required PNG sizes")

def main():
    if not SVG_PATH.exists():
        print(f"Error: SVG source not found at {SVG_PATH}")
        sys.exit(1)

    print(f"Using SVG source: {SVG_PATH}")
    print(f"Output directory: {FAVICON_DIR}")
    print()

    # Generate PNG files
    for filename, size in PNG_SIZES.items():
        png_path = FAVICON_DIR / filename
        svg_to_png(SVG_PATH, png_path, size)

    # Create ICO file
    create_ico(PNG_SIZES)

    print("\n✅ Favicon generation complete!")
    print(f"Files created in: {FAVICON_DIR}")

if __name__ == "__main__":
    main()