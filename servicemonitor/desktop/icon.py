"""Runtime icon drawing (used by the tray and the build script)."""

from __future__ import annotations

from PIL import Image, ImageDraw

STATUS_COLORS = {
    "ok": (34, 197, 94, 255),
    "error": (239, 68, 68, 255),
    "unknown": (245, 158, 11, 255),
    "off": (148, 163, 184, 255),
}
ACCENT = (129, 140, 248, 255)
BACKGROUND = (15, 23, 42, 255)


def create_icon(size: int = 64, status: str = "unknown") -> Image.Image:
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(canvas * 0.22)
    draw.rounded_rectangle(
        (0, 0, canvas - 1, canvas - 1),
        radius=radius,
        fill=BACKGROUND,
    )
    draw.rounded_rectangle(
        (int(canvas * 0.06), int(canvas * 0.06), int(canvas * 0.94), int(canvas * 0.94)),
        radius=int(radius * 0.82),
        outline=(51, 65, 85, 255),
        width=max(1, int(canvas * 0.025)),
    )

    # Heartbeat line
    width = max(2, int(canvas * 0.075))
    points = [
        (int(canvas * 0.18), int(canvas * 0.52)),
        (int(canvas * 0.34), int(canvas * 0.52)),
        (int(canvas * 0.42), int(canvas * 0.33)),
        (int(canvas * 0.53), int(canvas * 0.68)),
        (int(canvas * 0.62), int(canvas * 0.45)),
        (int(canvas * 0.82), int(canvas * 0.45)),
    ]
    draw.line(points, fill=ACCENT, width=width, joint="curve")

    # Status dot
    color = STATUS_COLORS.get(status, STATUS_COLORS["unknown"])
    margin = int(canvas * 0.16)
    dot_radius = int(canvas * 0.14)
    cx, cy = canvas - margin, canvas - margin
    draw.ellipse(
        (cx - dot_radius - width, cy - dot_radius - width, cx + dot_radius + width, cy + dot_radius + width),
        fill=BACKGROUND,
    )
    draw.ellipse((cx - dot_radius, cy - dot_radius, cx + dot_radius, cy + dot_radius), fill=color)

    return image.resize((size, size), Image.Resampling.LANCZOS)
