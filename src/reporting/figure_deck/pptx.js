"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SLIDE_W, SLIDE_H, ART_X, ART_Y, ART_W, ART_H, SLIDE_W_IN, SLIDE_H_IN } = require("./constants");
const { asArray, escapeXml, safeNumber } = require("./utils");
const { emu, slideAllTextBoxes } = require("./text_boxes");
const { pythonCommand, writePngWithPython } = require("./python_tools");

function crc32(buffer) {
  if (!crc32.table) {
    crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeZipStore(outputPath, entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ""), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    fileParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(outputPath, Buffer.concat(fileParts.concat(centralParts, end)));
}

function textRun(text, { size = 18, bold = false, color = "1f2937" } = {}) {
  return `<a:r><a:rPr lang="en-US" sz="${Math.round(size * 100)}"${bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
}

function textShape(id, name, x, y, w, h, lines, options = {}) {
  const rotation = options.rotation_degrees == null ? "" : ` rot="${Math.round(Number(options.rotation_degrees || 0) * 60000)}"`;
  const align = options.align ? `<a:pPr algn="${escapeXml(options.align)}" marL="0" indent="0"/>` : `<a:pPr marL="0" indent="0"/>`;
  const paragraphs = asArray(lines).map((line, index) => {
    const runOptions = {
      size: index === 0 && options.firstBold ? options.firstSize || options.size || 18 : options.size || 18,
      bold: index === 0 && options.firstBold ? true : Boolean(options.bold),
      color: options.color || "1f2937",
    };
    return `<a:p>${align}<a:r>${textRun(line, runOptions).replace(/^<a:r>|<\/a:r>$/g, "")}</a:r><a:endParaRPr lang="en-US" sz="${Math.round((options.size || 18) * 100)}"/></a:p>`;
  }).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${rotation}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function pictureShape(id, relId, x, y, w, h) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="SVG artwork ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function slideXml(slide, index) {
  const textBoxes = slideAllTextBoxes(slide)
    .map((box, boxIndex) =>
      textShape(2 + boxIndex, box.name || `Text ${boxIndex + 1}`, box.x, box.y, box.w, box.h, box.lines, {
        size: box.size || 12.5,
        firstBold: box.first_bold === true || box.firstBold === true,
        firstSize: box.first_size || box.size || 12.5,
        color: box.color || "334155",
        rotation_degrees: box.rotation_degrees,
        align: box.align,
      }),
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_W}" cy="${SLIDE_H}"/><a:chOff x="0" y="0"/><a:chExt cx="${SLIDE_W}" cy="${SLIDE_H}"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="99" name="Background"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_W}" cy="${SLIDE_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="fffaf0"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>${pictureShape(6, "rIdImage1", ART_X, ART_Y, ART_W, ART_H)}${textBoxes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideRels(mediaName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${escapeXml(mediaName)}"/></Relationships>`;
}

function contentTypes(slideCount) {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`;
}

function presentationXml(slideCount) {
  const ids = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="wide"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

function presentationRels(slideCount) {
  const slideRelsXml = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRelsXml}</Relationships>`;
}

function staticPptEntries(slideCount, title) {
  const now = new Date().toISOString();
  return [
    { name: "[Content_Types].xml", data: contentTypes(slideCount) },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>ResearchLab</dc:creator><cp:lastModifiedBy>ResearchLab</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ResearchLab</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slideCount}</Slides></Properties>` },
    { name: "ppt/presentation.xml", data: presentationXml(slideCount) },
    { name: "ppt/_rels/presentation.xml.rels", data: presentationRels(slideCount) },
    { name: "ppt/theme/theme1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ResearchLab"><a:themeElements><a:clrScheme name="ResearchLab"><a:dk1><a:srgbClr val="0f172a"/></a:dk1><a:lt1><a:srgbClr val="fffaf0"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="f8fafc"/></a:lt2><a:accent1><a:srgbClr val="0f766e"/></a:accent1><a:accent2><a:srgbClr val="d97706"/></a:accent2><a:accent3><a:srgbClr val="64748b"/></a:accent3><a:accent4><a:srgbClr val="dc2626"/></a:accent4><a:accent5><a:srgbClr val="2563eb"/></a:accent5><a:accent6><a:srgbClr val="7c2d12"/></a:accent6><a:hlink><a:srgbClr val="0f766e"/></a:hlink><a:folHlink><a:srgbClr val="475569"/></a:folHlink></a:clrScheme><a:fontScheme name="ResearchLab"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="ResearchLab"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>` },
    { name: "ppt/slideMasters/slideMaster1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>` },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
  ];
}

function buildPptx({ outputPath, slides, title }) {
  const entries = staticPptEntries(slides.length, title);
  slides.forEach((slide, index) => {
    const mediaName = slide.svg_file;
    entries.push(
      { name: `ppt/slides/slide${index + 1}.xml`, data: slideXml(slide, index) },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: slideRels(mediaName) },
      { name: `ppt/media/${mediaName}`, data: slide.svg },
    );
  });
  writeZipStore(outputPath, entries);
}

const PYTHON_PPTX_SCRIPT = String.raw`
import json
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

payload = json.loads(sys.stdin.read())

def rgb(value, fallback="334155"):
    raw = str(value or fallback).strip().lstrip("#")
    if len(raw) != 6:
        raw = fallback
    try:
        return RGBColor(int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    except Exception:
        return RGBColor(int(fallback[0:2], 16), int(fallback[2:4], 16), int(fallback[4:6], 16))

def inches(value):
    return Inches(float(value or 0))

def alignment(value):
    key = str(value or "").lower()
    if key in ("ctr", "center", "middle"):
        return PP_ALIGN.CENTER
    if key in ("r", "right", "end"):
        return PP_ALIGN.RIGHT
    return PP_ALIGN.LEFT

prs = Presentation()
prs.slide_width = inches(payload.get("slide_width", 13.333333))
prs.slide_height = inches(payload.get("slide_height", 7.5))
blank = prs.slide_layouts[6]

for slide_data in payload.get("slides", []):
    slide = prs.slides.add_slide(blank)
    background = slide.background.fill
    background.solid()
    background.fore_color.rgb = rgb(payload.get("background", "fffaf0"), "fffaf0")
    artwork_png_path = slide_data.get("artwork_png_path")
    if artwork_png_path:
        slide.shapes.add_picture(
            artwork_png_path,
            inches(slide_data.get("art_x", 0.85)),
            inches(slide_data.get("art_y", 1.12)),
            width=inches(slide_data.get("art_w", 7.75)),
            height=inches(slide_data.get("art_h", 4.45)),
        )
    for box in slide_data.get("text_boxes", []):
        shape = slide.shapes.add_textbox(
            inches(box.get("x", 0)),
            inches(box.get("y", 0)),
            inches(box.get("w", 1)),
            inches(box.get("h", 0.25)),
        )
        shape.name = str(box.get("name") or "text box")
        if box.get("rotation_degrees") is not None:
            shape.rotation = float(box.get("rotation_degrees") or 0)
        frame = shape.text_frame
        frame.clear()
        frame.word_wrap = True
        frame.margin_left = 0
        frame.margin_right = 0
        frame.margin_top = 0
        frame.margin_bottom = 0
        lines = box.get("lines") or [""]
        for index, line in enumerate(lines):
            paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
            paragraph.alignment = alignment(box.get("align"))
            paragraph.space_after = Pt(0)
            paragraph.space_before = Pt(0)
            run = paragraph.add_run()
            run.text = str(line)
            font = run.font
            size = float(box.get("first_size") or box.get("size") or 12.5) if index == 0 and box.get("first_bold") else float(box.get("size") or 12.5)
            font.size = Pt(size)
            font.name = "Aptos"
            font.bold = bool(box.get("first_bold")) if index == 0 else bool(box.get("bold"))
            font.color.rgb = rgb(box.get("color"), "334155")

prs.save(payload["output_path"])
`;

function buildPptxWithPython({ outputPath, deckDir, slides, title }) {
  const unrenderedArtwork = [];
  const payloadSlides = slides.map((slide) => {
    const baseName = slide.svg_file.replace(/\.svg$/i, "");
    const svgPath = path.join(deckDir, slide.svg_file);
    if (!fs.existsSync(svgPath)) fs.writeFileSync(svgPath, slide.svg, "utf8");
    const artworkPngPath = path.join(deckDir, `${baseName}-ppt-artwork.png`);
    // Build the slide without its picture when the artwork will not render.
    // Losing one image is a recorded defect; throwing here aborted the whole
    // document refresh, and with it the research pass that dispatches lanes.
    const renderedArtwork = writePngWithPython(svgPath, artworkPngPath);
    if (!renderedArtwork) {
      unrenderedArtwork.push({
        figure_id: slide.figure_id || null,
        svg_file: slide.svg_file,
        reason: "artwork PNG did not render or did not decode back after rendering",
      });
    }
    return {
      figure_id: slide.figure_id,
      artwork_png_path: renderedArtwork,
      art_x: ART_X,
      art_y: ART_Y,
      art_w: ART_W,
      art_h: ART_H,
      text_boxes: slideAllTextBoxes(slide).map((box) => ({
        name: box.name || "text box",
        x: safeNumber(box.x),
        y: safeNumber(box.y),
        w: safeNumber(box.w),
        h: safeNumber(box.h),
        lines: asArray(box.lines).map(String),
        size: safeNumber(box.size, 12.5),
        first_bold: box.first_bold === true || box.firstBold === true,
        first_size: box.first_size || box.firstSize || box.size || null,
        bold: box.bold === true,
        color: box.color || "334155",
        rotation_degrees: box.rotation_degrees == null ? null : safeNumber(box.rotation_degrees),
        align: box.align || null,
      })),
    };
  });
  const payload = {
    output_path: outputPath,
    title,
    slide_width: SLIDE_W_IN,
    slide_height: SLIDE_H_IN,
    background: "fffaf0",
    slides: payloadSlides,
  };
  try {
    execFileSync(pythonCommand(), ["-c", PYTHON_PPTX_SCRIPT], {
      input: JSON.stringify(payload),
      timeout: 120000,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].map((item) => String(item || "")).join("\n").trim();
    throw new Error(`python-pptx failed to build figure deck${detail ? `: ${detail}` : ""}`);
  }
  return {
    method: "python-pptx",
    embedded_artwork_format: "png",
    artwork_png_paths: payloadSlides.map((slide) => slide.artwork_png_path),
    unrendered_artwork: unrenderedArtwork,
  };
}

module.exports = {
  buildPptx,
  buildPptxWithPython,
};
