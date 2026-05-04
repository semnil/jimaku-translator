"""Generate jimaku-translator application icon as ICO (Windows) + ICNS (macOS) + PNG (fallback)."""

from PIL import Image, ImageDraw
import json
import os
import shutil
import subprocess
import sys

SIZE = 256


def draw_icon(size: int, corner_radius_at_256: int = 58) -> Image.Image:
    s = size / SIZE
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # macOS Tahoe Liquid Glass squircle ratio (~22.5%) is the default; Windows
    # ICO callers pass 48 (the legacy ratio) since Liquid Glass masking is
    # macOS-only and a tighter corner reads better in the taskbar.
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=int(corner_radius_at_256 * s),
        fill=(26, 26, 46),
    )

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


ICONSET_SPECS = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def build_icns(script_dir: str) -> None:
    """Generate icon.icns via iconutil (kept as a fallback for tools that don't
    read Asset Catalogs)."""
    if sys.platform != "darwin":
        print("[icns] skipping iconutil (not macOS)")
        return
    if shutil.which("iconutil") is None:
        print("[icns] iconutil not found; skipping ICNS generation")
        return

    iconset_dir = os.path.join(script_dir, "icon.iconset")
    if os.path.isdir(iconset_dir):
        shutil.rmtree(iconset_dir)
    os.makedirs(iconset_dir)

    for filename, px in ICONSET_SPECS:
        draw_icon(px).save(os.path.join(iconset_dir, filename))

    icns_path = os.path.join(script_dir, "icon.icns")
    subprocess.run(
        ["iconutil", "--convert", "icns", iconset_dir, "--output", icns_path],
        check=True,
    )
    shutil.rmtree(iconset_dir)
    print(f"Saved {icns_path}")


def build_assets_car(script_dir: str) -> None:
    """Build a Tahoe-native AppIcon.icon bundle and compile it into Assets.car
    via actool. The legacy .xcassets/AppIcon.appiconset path produces a
    "Icon Image" Asset Catalog which Tahoe still treats as a pre-Big Sur icon
    and wraps in a Liquid Glass fallback plate. The .icon bundle path produces
    "IconGroup/IconImageStack/PackedImage" entries that the Tahoe shell
    recognises as a native Liquid Glass icon, so no bezel is drawn."""
    if sys.platform != "darwin":
        print("[assets.car] skipping actool (not macOS)")
        return
    actool = shutil.which("actool")
    if actool is None:
        try:
            actool = subprocess.run(
                ["xcrun", "--find", "actool"], check=True, capture_output=True, text=True
            ).stdout.strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            print("[assets.car] actool not found; skipping")
            return

    icon_bundle = os.path.join(script_dir, "AppIcon.icon")
    assets_dir = os.path.join(icon_bundle, "Assets")
    if os.path.isdir(icon_bundle):
        shutil.rmtree(icon_bundle)
    os.makedirs(assets_dir)

    # Render full icon (1024 px) as a single layer image. The .icon bundle's
    # `fill` provides the background, and the layer holds the waveform +
    # subtitle artwork on top. We re-use draw_icon() rather than splitting the
    # design across multiple layers — Tahoe still renders a native Liquid Glass
    # icon as long as the bundle structure is valid.
    body = draw_icon(1024)
    body.save(os.path.join(assets_dir, "Body.png"))

    # extended-srgb floats for our (26, 26, 46) navy background
    bg_color = "extended-srgb:{:.5f},{:.5f},{:.5f},1.00000".format(
        26 / 255, 26 / 255, 46 / 255
    )
    icon_json = {
        "fill": {"automatic-gradient": bg_color},
        "groups": [
            {
                "layers": [
                    {"image-name": "Body.png", "name": "Body"},
                ],
                "shadow": {"kind": "neutral", "opacity": 0.5},
                "translucency": {"enabled": True, "value": 0.5},
            }
        ],
        "supported-platforms": {
            "circles": ["watchOS"],
            "squares": "shared",
        },
    }
    with open(os.path.join(icon_bundle, "icon.json"), "w") as f:
        json.dump(icon_json, f, indent=2)

    out_dir = os.path.join(script_dir, "assets-build")
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    partial_plist = os.path.join(out_dir, "partial.plist")

    subprocess.run(
        [
            actool,
            icon_bundle,
            "--compile", out_dir,
            "--platform", "macosx",
            "--target-device", "mac",
            "--minimum-deployment-target", "12.0",
            "--app-icon", "AppIcon",
            "--include-all-app-icons",
            "--enable-on-demand-resources", "NO",
            "--development-region", "en",
            "--output-partial-info-plist", partial_plist,
        ],
        check=True,
    )

    car_src = os.path.join(out_dir, "Assets.car")
    if not os.path.isfile(car_src):
        raise RuntimeError(f"actool did not produce {car_src}")
    car_dst = os.path.join(script_dir, "Assets.car")
    shutil.copyfile(car_src, car_dst)
    shutil.rmtree(out_dir)
    shutil.rmtree(icon_bundle)
    print(f"Saved {car_dst}")


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # 1024px PNG kept as a portable fallback (CI image, unsigned builds, etc.).
    png_img = draw_icon(1024)
    png_path = os.path.join(script_dir, "icon.png")
    png_img.save(png_path)
    print(f"Saved {png_path}")

    sizes = [256, 128, 64, 48, 32, 16]
    images = [draw_icon(sz, corner_radius_at_256=48) for sz in sizes]

    # Save ICO with all sizes
    ico_path = os.path.join(script_dir, "icon.ico")
    images[0].save(ico_path, format="ICO", sizes=[(sz, sz) for sz in sizes], append_images=images[1:])
    print(f"Saved {ico_path}")

    build_icns(script_dir)
    build_assets_car(script_dir)


if __name__ == "__main__":
    main()
