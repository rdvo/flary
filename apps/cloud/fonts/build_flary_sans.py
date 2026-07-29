#!/usr/bin/env python3
"""Build the Flary Sans variable font."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._f_v_a_r import NamedInstance
from fontTools.varLib.instancer import instantiateVariableFont


FONT_DIR = Path(__file__).resolve().parent
UPSTREAM_FONT = FONT_DIR / "upstream" / "instrument-sans-variable.ttf"
OUTPUT_DIR = FONT_DIR.parent / "public" / "fonts"
OUTPUT_TTF = OUTPUT_DIR / "flary-sans-variable.ttf"
OUTPUT_WOFF2 = OUTPUT_DIR / "flary-sans-variable.woff2"

# Keep the face close to a neutral grotesk. The small width adjustment gives
# headings a compact rhythm without making body text look condensed.
FLARY_WIDTH = 98

# These alternates were drawn by the upstream type designer. Flary makes them
# the default voice. The standard double-storey "a" stays in place.
DEFAULT_FEATURES = (
    "ss01",  # round punctuation, dots, and diacritics
    "ss03",  # rounded y descender
    "ss04",  # crossed K arm and leg
    "ss05",  # straight R leg
    "ss06",  # angled M strokes
    "ss07",  # open G without a spur
    "ss08",  # extended J terminal
    "ss09",  # open Q tail
    "ss10",  # calmer 2 spine
)


def feature_substitutions(font: TTFont, feature_tag: str) -> dict[str, str]:
    """Return all single substitutions for one OpenType feature."""
    substitutions: dict[str, str] = {}
    gsub = font["GSUB"].table
    for feature_record in gsub.FeatureList.FeatureRecord:
        if feature_record.FeatureTag != feature_tag:
            continue
        for lookup_index in feature_record.Feature.LookupListIndex:
            lookup = gsub.LookupList.Lookup[lookup_index]
            for subtable in lookup.SubTable:
                mapping = getattr(subtable, "mapping", None)
                if mapping:
                    substitutions.update(mapping)
    return substitutions


def make_alternates_default(font: TTFont) -> int:
    """Copy the selected alternate outlines into the normal glyph slots."""
    mappings = [
        feature_substitutions(font, feature_tag)
        for feature_tag in DEFAULT_FEATURES
    ]
    glyf = font["glyf"]
    hmtx = font["hmtx"].metrics
    variations = font["gvar"].variations
    changed = 0

    # Run each base glyph through the selected features in shaping order. This
    # also finds combined forms such as a rounded-dot accented y.
    for glyph_name in font.getGlyphOrder():
        alternate_name = glyph_name
        for mapping in mappings:
            alternate_name = mapping.get(alternate_name, alternate_name)
        if alternate_name == glyph_name:
            continue
        if alternate_name not in glyf or alternate_name not in hmtx:
            continue

        glyf[glyph_name] = deepcopy(glyf[alternate_name])
        hmtx[glyph_name] = hmtx[alternate_name]
        if alternate_name in variations:
            variations[glyph_name] = deepcopy(variations[alternate_name])
        elif glyph_name in variations:
            del variations[glyph_name]
        changed += 1

    return changed


def replace_name(font: TTFont, name_id: int, value: str) -> None:
    """Set one name for Windows and macOS records."""
    table = font["name"]
    table.names = [record for record in table.names if record.nameID != name_id]
    table.setName(value, name_id, 3, 1, 0x409)
    table.setName(value, name_id, 1, 0, 0)


def rename_font(font: TTFont) -> None:
    """Replace upstream names and add correct derivative-font metadata."""
    names = {
        0: (
            "Copyright 2022 The Instrument Sans Project Authors. "
            "Flary Sans modifications copyright 2026 Flary contributors."
        ),
        1: "Flary Sans",
        2: "Regular",
        3: "2026;FLRY;FlarySans-Variable",
        4: "Flary Sans",
        5: "Version 1.000",
        6: "FlarySans-Variable",
        8: "Flary",
        9: "Rodrigo Fuenzalida; Flary contributors",
        10: (
            "A compact neo-grotesk for Flary interfaces. Derived from "
            "Instrument Sans and modified under the SIL Open Font License."
        ),
        11: "https://github.com/rdvo/flary",
        13: "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
        14: "https://openfontlicense.org",
        16: "Flary Sans",
        17: "Regular",
        25: "FlarySans",
    }
    for name_id, value in names.items():
        replace_name(font, name_id, value)

    font["OS/2"].achVendID = "FLRY"
    font["head"].fontRevision = 1.0


def set_named_instances(font: TTFont) -> None:
    """Add useful desktop instances to the remaining weight axis."""
    fvar = font["fvar"]
    fvar.instances = []
    for style_name, weight in (
        ("Regular", 400),
        ("Medium", 500),
        ("SemiBold", 600),
        ("Bold", 700),
    ):
        instance = NamedInstance()
        instance.subfamilyNameID = font["name"].addName(style_name)
        instance.postscriptNameID = font["name"].addName(
            f"FlarySans-{style_name}"
        )
        instance.coordinates = {"wght": weight}
        fvar.instances.append(instance)


def build() -> tuple[Path, Path, int]:
    """Build the desktop and web font files."""
    if not UPSTREAM_FONT.exists():
        raise FileNotFoundError(
            f"Missing upstream font: {UPSTREAM_FONT}. See fonts/README.md."
        )

    upstream = TTFont(UPSTREAM_FONT)
    font = instantiateVariableFont(
        upstream,
        {"wdth": FLARY_WIDTH},
        inplace=False,
        optimize=True,
    )
    changed_glyphs = make_alternates_default(font)
    rename_font(font)
    set_named_instances(font)

    axis_tags = [axis.axisTag for axis in font["fvar"].axes]
    if axis_tags != ["wght"]:
        raise RuntimeError(f"Unexpected variable axes: {axis_tags}")
    if changed_glyphs < 80:
        raise RuntimeError(
            f"Only {changed_glyphs} alternate glyphs changed; expected at least 80."
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT_TTF, reorderTables=False)

    web_font = TTFont(OUTPUT_TTF)
    web_font.flavor = "woff2"
    web_font.save(OUTPUT_WOFF2, reorderTables=False)
    return OUTPUT_TTF, OUTPUT_WOFF2, changed_glyphs


if __name__ == "__main__":
    built_ttf, built_woff2, alternate_count = build()
    print(f"Built {built_ttf.relative_to(Path.cwd())}")
    print(f"Built {built_woff2.relative_to(Path.cwd())}")
    print(f"Made {alternate_count} curated alternates default")
