"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function pythonCommand() {
  if (process.env.RESEARCHLAB_PYTHON) return process.env.RESEARCHLAB_PYTHON;
  const venvPython = path.join(process.cwd(), ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) return venvPython;
  const venvPythonWin = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPythonWin)) return venvPythonWin;
  return "python3";
}

const PYTHON_SVG_TO_PNG_SCRIPT = String.raw`
import base64
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

payload = json.loads(sys.stdin.read())
svg_path = payload["svg_path"]
png_path = payload["png_path"]

def local_name(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag

def number(value, default=0.0):
    if value is None:
        return default
    match = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(match.group(0)) if match else default

def parse_color(value, opacity=1.0):
    if not value or value == "none":
        return None
    value = str(value).strip()
    if value.startswith("#") and len(value) == 7:
        return (
            int(value[1:3], 16),
            int(value[3:5], 16),
            int(value[5:7], 16),
            max(0, min(255, int(round(255 * opacity)))),
        )
    return None

def viewbox(root, fallback_w=1600, fallback_h=900):
    raw = root.attrib.get("viewBox", "")
    vals = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", raw)]
    if len(vals) == 4 and vals[2] > 0 and vals[3] > 0:
        return vals[2], vals[3]
    return number(root.attrib.get("width"), fallback_w), number(root.attrib.get("height"), fallback_h)

def font_for(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, max(1, int(round(size))))
        except Exception:
            pass
    return ImageFont.load_default()

def draw_alpha(base, fn):
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fn(draw)
    base.alpha_composite(overlay)

def stroke_fill(elem, inherited_opacity=1.0):
    opacity = number(elem.attrib.get("opacity"), 1.0) * inherited_opacity
    fill_opacity = number(elem.attrib.get("fill-opacity"), 1.0) * opacity
    stroke_opacity = number(elem.attrib.get("stroke-opacity"), 1.0) * opacity
    fill = parse_color(elem.attrib.get("fill"), fill_opacity)
    stroke = parse_color(elem.attrib.get("stroke"), stroke_opacity)
    return fill, stroke, max(1, int(round(number(elem.attrib.get("stroke-width"), 1))))

def transform_point(x, y, tx):
    sx, sy, ox, oy = tx
    return ox + x * sx, oy + y * sy

def render_svg(root, width, height, tx=None):
    image = Image.new("RGBA", (int(round(width)), int(round(height))), (255, 255, 255, 0))
    vb_w, vb_h = viewbox(root, width, height)
    sx = width / vb_w if vb_w else 1.0
    sy = height / vb_h if vb_h else 1.0
    render_children(root, image, (sx, sy, 0.0, 0.0))
    return image

def href_value(elem):
    for key, value in elem.attrib.items():
        if key == "href" or key.endswith("}href"):
            return value
    return ""

def draw_text(elem, base, tx):
    text = "".join(elem.itertext())
    if not text:
        return
    sx, sy, ox, oy = tx
    x, y = transform_point(number(elem.attrib.get("x")), number(elem.attrib.get("y")), tx)
    size = number(elem.attrib.get("font-size"), 12) * (sx + sy) / 2.0
    bold = str(elem.attrib.get("font-weight", "")).lower() in {"600", "700", "bold"}
    font = font_for(size, bold)
    fill = parse_color(elem.attrib.get("fill"), number(elem.attrib.get("opacity"), 1.0)) or (51, 65, 85, 255)
    anchor = elem.attrib.get("text-anchor", "start")
    draw = ImageDraw.Draw(base)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    left = x - (tw / 2 if anchor == "middle" else tw if anchor == "end" else 0)
    top = y - size * 0.86
    transform = elem.attrib.get("transform", "")
    match = re.search(r"rotate\((-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)", transform)
    if not match:
        draw.text((left, top), text, font=font, fill=fill)
        return
    angle = float(match.group(1))
    cx, cy = transform_point(float(match.group(2)), float(match.group(3)), tx)
    text_img = Image.new("RGBA", (max(1, int(math.ceil(tw + 8))), max(1, int(math.ceil(th + 8)))), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_img)
    text_draw.text((4, 4), text, font=font, fill=fill)
    rotated = text_img.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    base.alpha_composite(rotated, (int(round(cx - rotated.width / 2)), int(round(cy - rotated.height / 2))))

def render_children(root, base, tx):
    for elem in list(root):
        name = local_name(elem.tag)
        if name == "svg":
            render_children(elem, base, tx)
        elif name == "rect":
            sx, sy, ox, oy = tx
            x, y = transform_point(number(elem.attrib.get("x")), number(elem.attrib.get("y")), tx)
            w = number(elem.attrib.get("width")) * sx
            h = number(elem.attrib.get("height")) * sy
            radius = max(0, number(elem.attrib.get("rx")) * (sx + sy) / 2.0)
            fill, stroke, stroke_width = stroke_fill(elem)
            def op(draw):
                box = [x, y, x + w, y + h]
                if radius > 0:
                    if fill: draw.rounded_rectangle(box, radius=radius, fill=fill)
                    if stroke: draw.rounded_rectangle(box, radius=radius, outline=stroke, width=stroke_width)
                else:
                    if fill: draw.rectangle(box, fill=fill)
                    if stroke: draw.rectangle(box, outline=stroke, width=stroke_width)
            draw_alpha(base, op)
        elif name == "line":
            x1, y1 = transform_point(number(elem.attrib.get("x1")), number(elem.attrib.get("y1")), tx)
            x2, y2 = transform_point(number(elem.attrib.get("x2")), number(elem.attrib.get("y2")), tx)
            _, stroke, stroke_width = stroke_fill(elem)
            if stroke:
                draw_alpha(base, lambda draw: draw.line([x1, y1, x2, y2], fill=stroke, width=stroke_width))
        elif name == "circle":
            sx, sy, ox, oy = tx
            cx, cy = transform_point(number(elem.attrib.get("cx")), number(elem.attrib.get("cy")), tx)
            r = number(elem.attrib.get("r")) * (sx + sy) / 2.0
            fill, stroke, stroke_width = stroke_fill(elem)
            def op(draw):
                box = [cx - r, cy - r, cx + r, cy + r]
                if fill: draw.ellipse(box, fill=fill)
                if stroke: draw.ellipse(box, outline=stroke, width=stroke_width)
            draw_alpha(base, op)
        elif name == "image":
            href = href_value(elem)
            if not href.startswith("data:image/svg+xml;base64,"):
                continue
            embedded = base64.b64decode(href.split(",", 1)[1])
            child_root = ET.parse(BytesIO(embedded)).getroot()
            sx, sy, ox, oy = tx
            x, y = transform_point(number(elem.attrib.get("x")), number(elem.attrib.get("y")), tx)
            w = number(elem.attrib.get("width")) * sx
            h = number(elem.attrib.get("height")) * sy
            child_image = render_svg(child_root, w, h)
            base.alpha_composite(child_image, (int(round(x)), int(round(y))))
        elif name == "text":
            draw_text(elem, base, tx)

root = ET.parse(svg_path).getroot()
width, height = viewbox(root)
canvas = Image.new("RGBA", (int(round(width)), int(round(height))), (255, 255, 255, 255))
render_children(root, canvas, (1.0, 1.0, 0.0, 0.0))
# Name the partial file per process so two renderers never collide on it,
# and state the format: PIL infers it from the extension, which this is not.
partial_path = "%s.%d.partial" % (png_path, os.getpid())
canvas.convert("RGB").save(partial_path, format="PNG")
# Decode the file back before it takes the final name. A truncated write
# still produces a file, and a caller that only checks existence will hand
# it on as artwork -- which is how one unreadable image killed a cycle.
with Image.open(partial_path) as written:
    written.load()
# Atomic, so a reader in another process never opens a half-written file.
os.replace(partial_path, png_path)
`;

function writePngWithPython(svgPath, pngPath) {
  try {
    execFileSync(pythonCommand(), ["-c", PYTHON_SVG_TO_PNG_SCRIPT], {
      input: JSON.stringify({ svg_path: svgPath, png_path: pngPath }),
      timeout: 20000,
      stdio: ["pipe", "ignore", "ignore"],
    });
    // The renderer verified the bytes before giving them this name, so an
    // existing file here is a decodable one.
    return fs.existsSync(pngPath) ? pngPath : null;
  } catch {
    return null;
  }
}

const PYTHON_IMAGE_QUALITY_SCRIPT = String.raw`
import json
import math
import sys

from PIL import Image

payload = json.loads(sys.stdin.read())
image_path = payload["image_path"]
minimum_width = int(payload.get("minimum_width", 1200))
minimum_height = int(payload.get("minimum_height", 675))
minimum_bbox_width_fraction = float(payload.get("minimum_bbox_width_fraction", 0.68))
minimum_bbox_height_fraction = float(payload.get("minimum_bbox_height_fraction", 0.48))
minimum_dark_pixel_ratio = float(payload.get("minimum_dark_pixel_ratio", 0.003))

image = Image.open(image_path).convert("RGB")
width, height = image.size
pixels = image.load()

corner_samples = []
corner_size = max(8, min(width, height) // 80)
corner_ranges = [
    (0, corner_size, 0, corner_size),
    (width - corner_size, width, 0, corner_size),
    (0, corner_size, height - corner_size, height),
    (width - corner_size, width, height - corner_size, height),
]
for x0, x1, y0, y1 in corner_ranges:
    for y in range(max(0, y0), min(height, y1)):
        for x in range(max(0, x0), min(width, x1)):
            corner_samples.append(pixels[x, y])
if corner_samples:
    bg = tuple(sorted(sample[channel] for sample in corner_samples)[len(corner_samples) // 2] for channel in range(3))
else:
    bg = (255, 250, 240)

content_threshold = 16
dark_pixels = 0
content_pixels = 0
min_x, min_y = width, height
max_x, max_y = -1, -1
for y in range(height):
    for x in range(width):
        r, g, b = pixels[x, y]
        distance = max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2]))
        luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if distance > content_threshold:
            content_pixels += 1
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
        if luminance < 205 and distance > 10:
            dark_pixels += 1

if max_x >= min_x and max_y >= min_y:
    bbox_width = max_x - min_x + 1
    bbox_height = max_y - min_y + 1
else:
    bbox_width = 0
    bbox_height = 0

area = max(1, width * height)
metrics = {
    "width": width,
    "height": height,
    "background_rgb": bg,
    "content_pixel_ratio": content_pixels / area,
    "dark_pixel_ratio": dark_pixels / area,
    "content_bbox": [min_x, min_y, max_x, max_y] if bbox_width and bbox_height else None,
    "content_bbox_width_fraction": bbox_width / max(1, width),
    "content_bbox_height_fraction": bbox_height / max(1, height),
}
issues = []
if width < minimum_width or height < minimum_height:
    issues.append("rendered manuscript image resolution is below target")
if metrics["content_bbox_width_fraction"] < minimum_bbox_width_fraction:
    issues.append("rendered figure content does not occupy enough horizontal image area")
if metrics["content_bbox_height_fraction"] < minimum_bbox_height_fraction:
    issues.append("rendered figure content does not occupy enough vertical image area")
# Light-theme figures can be valid with low dark ink if they still have
# substantial non-background content and occupy the panel. Treat low dark
# ink as a blankness signal only when total content is also very sparse.
if metrics["dark_pixel_ratio"] < minimum_dark_pixel_ratio and metrics["content_pixel_ratio"] < 0.02:
    issues.append("rendered figure has too little non-background ink and may be blank or unreadable")

metrics["passed"] = len(issues) == 0
metrics["issues"] = issues
print(json.dumps(metrics))
`;

function evaluateRenderedImageQuality(imagePath) {
  if (!imagePath || !fs.existsSync(String(imagePath))) {
    return {
      passed: false,
      issues: ["rendered manuscript PNG is missing"],
    };
  }
  try {
    const output = execFileSync(pythonCommand(), ["-c", PYTHON_IMAGE_QUALITY_SCRIPT], {
      input: JSON.stringify({ image_path: imagePath }),
      timeout: 20000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch (error) {
    const detail = [error.stdout, error.stderr].map((item) => String(item || "")).join("\n").trim();
    return {
      passed: false,
      issues: [`rendered manuscript image QA failed${detail ? `: ${detail.slice(0, 240)}` : ""}`],
    };
  }
}

module.exports = {
  pythonCommand,
  writePngWithPython,
  evaluateRenderedImageQuality,
};
