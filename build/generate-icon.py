"""Generate jimaku-translator application icon as ICO (256/128/64/48/32/16) + PNG (512)."""

from PIL import Image, ImageDraw
import os

SIZE = 256


def draw_icon(size: int) -> Image.Image:
    s = size / SIZE
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background rounded rectangle
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(48 * s), fill=(26, 26, 46))

    # Audio waveform (5 thick bars, centered upper)
    cx, cy = size // 2, int(96 * s)
    bar_w = max(3, int(12 * s))
    bar_spacing = int(24 * s)
    half_heights = [16, 40, 52, 36, 20]

    for i, hh in enumerate(half_heights):
        x = cx + (i - 2) * bar_spacing
        half = int(hh * s)
        t = i / (len(half_heights) - 1)
        r_c = int(99 + (167 - 99) * t)
        g_c = int(102 + (139 - 102) * t)
        b_c = int(241 + (250 - 241) * t)
        draw.rounded_rectangle(
            [x - bar_w // 2, cy - half, x + bar_w // 2, cy + half],
            radius=bar_w // 2,
            fill=(r_c, g_c, b_c),
        )

    # Subtitle bar
    bar_x = int(32 * s)
    bar_y = int(168 * s)
    bar_w_total = int(192 * s)
    bar_h = int(56 * s)
    bar_r = int(12 * s)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w_total, bar_y + bar_h],
        radius=bar_r,
        fill=(15, 22, 41, 230),
        outline=(74, 222, 128, 153),
        width=max(1, int(3 * s)),
    )

    # Three subtitle lines
    lines = [
        (56, 182, 144, 6, (74, 222, 128, 230)),
        (72, 196, 112, 6, (74, 222, 128, 128)),
        (64, 210, 128, 6, (167, 139, 250, 128)),
    ]
    for lx, ly, lw, lh, color in lines:
        rx = int(lx * s)
        ry = int(ly * s)
        rw = int(lw * s)
        rh = max(2, int(lh * s))
        rr = rh // 2
        draw.rounded_rectangle([rx, ry, rx + rw, ry + rh], radius=rr, fill=color)

    return img


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # 512px PNG for macOS (electron-builder requires >= 512x512)
    png_img = draw_icon(512)
    png_path = os.path.join(script_dir, "icon.png")
    png_img.save(png_path)
    print(f"Saved {png_path}")

    sizes = [256, 128, 64, 48, 32, 16]
    images = [draw_icon(sz) for sz in sizes]

    # Save ICO with all sizes
    ico_path = os.path.join(script_dir, "icon.ico")
    images[0].save(ico_path, format="ICO", sizes=[(sz, sz) for sz in sizes], append_images=images[1:])
    print(f"Saved {ico_path}")


if __name__ == "__main__":
    main()
