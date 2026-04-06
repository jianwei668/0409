#!/usr/bin/env python3
"""Geocode Hefei land-price anchor areas with AMap and build seed KML.

Input CSV: hefei_land_price_seed_areas.csv
Output:
  - hefei_land_price_seed_points.csv
  - hefei_land_price_seed_points.kml
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple

GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"


def http_get_json(url: str) -> Dict:
    req = urllib.request.Request(url, headers={"User-Agent": "hefei-site-analysis/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True, help="AMap Web Service API key")
    parser.add_argument("--input", required=True, help="Seed CSV")
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--sleep", type=float, default=0.25)
    return parser.parse_args()


def geocode_one(key: str, query_text: str, city: str) -> Dict:
    params = {
        "key": key,
        "address": query_text,
        "city": city,
        "output": "JSON",
    }
    url = GEOCODE_URL + "?" + urllib.parse.urlencode(params)
    data = http_get_json(url)
    geocodes = data.get("geocodes") or []
    return geocodes[0] if geocodes else {}


def split_location(loc: str) -> Tuple[float, float]:
    lng, lat = loc.split(",")
    return float(lng), float(lat)


def xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def main() -> int:
    args = parse_args()
    in_path = Path(args.input)
    out_prefix = Path(args.output_prefix)
    rows: List[Dict] = []
    with in_path.open("r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for seed in reader:
            geo = geocode_one(args.key, seed["query_text"], seed["city"])
            time.sleep(args.sleep)
            if not geo or not geo.get("location"):
                seed.update({"lng_gcj02": "", "lat_gcj02": "", "matched_address": "", "matched_level": "", "adcode": ""})
                rows.append(seed)
                continue
            lng, lat = split_location(geo["location"])
            seed.update(
                {
                    "lng_gcj02": lng,
                    "lat_gcj02": lat,
                    "matched_address": geo.get("formatted_address", ""),
                    "matched_level": geo.get("level", ""),
                    "adcode": geo.get("adcode", ""),
                }
            )
            rows.append(seed)

    csv_path = out_prefix.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        fields = list(rows[0].keys()) if rows else []
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    kml_parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        "<Document>",
    ]
    for row in rows:
        if not row.get("lng_gcj02") or not row.get("lat_gcj02"):
            continue
        desc = "\n".join(
            [
                f"区域: {row['query_name']}",
                f"级别: {row['grade']}",
                f"地价: {row['benchmark_price_yuan_per_m2']} 元/平方米",
                f"亩价: {row['benchmark_price_wan_per_mu']} 万元/亩",
                f"匹配地址: {row.get('matched_address','')}",
                f"高德级别: {row.get('matched_level','')}",
                f"高德adcode: {row.get('adcode','')}",
            ]
        )
        kml_parts.extend(
            [
                "<Placemark>",
                f"<name>{xml_escape(row['query_name'])}</name>",
                f"<description>{xml_escape(desc)}</description>",
                "<Point>",
                f"<coordinates>{row['lng_gcj02']},{row['lat_gcj02']},0</coordinates>",
                "</Point>",
                "</Placemark>",
            ]
        )
    kml_parts.extend(["</Document>", "</kml>"])
    kml_path = out_prefix.with_suffix(".kml")
    kml_path.write_text("\n".join(kml_parts), encoding="utf-8")
    print(f"Saved {csv_path} and {kml_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
