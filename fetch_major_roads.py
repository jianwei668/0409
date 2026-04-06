"""
从 OpenStreetMap Overpass API 拉取合肥市主要道路的中心点坐标并生成 KML 文件。
用于计算道路通达度评分（距主要道路越近，交通通达性越好）。
提取的道路类型：primary, secondary, tertiary（主干道/次干道/支路）。
"""

import json
import urllib.request
import xml.etree.ElementTree as ET
from xml.dom import minidom

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# 合肥市区范围（重点城区），提取道路中心点
# 只取 primary 和 secondary 以控制数据量
OVERPASS_QUERY = """
[out:json][timeout:120];
(
  way["highway"="primary"](31.6,117.0,32.05,117.55);
  way["highway"="secondary"](31.6,117.0,32.05,117.55);
  way["highway"="tertiary"](31.7,117.1,31.95,117.45);
);
out center;
"""


def fetch_roads():
    data = "data=" + urllib.request.quote(OVERPASS_QUERY)
    req = urllib.request.Request(OVERPASS_URL, data=data.encode("utf-8"), method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_road_points(elements):
    """提取每条道路的中心点坐标。"""
    points = []
    for el in elements:
        if el.get("type") != "way":
            continue
        center = el.get("center")
        if not center:
            continue
        tags = el.get("tags", {})
        name = tags.get("name", "")
        highway_type = tags.get("highway", "")
        points.append({
            "name": name or f"[{highway_type}]",
            "lat": center["lat"],
            "lon": center["lon"],
            "type": highway_type,
        })
    return points


def build_kml(points):
    kml_ns = "http://www.opengis.net/kml/2.2"
    kml = ET.Element("kml", xmlns=kml_ns)
    doc = ET.SubElement(kml, "Document")
    name_el = ET.SubElement(doc, "name")
    name_el.text = "合肥主要道路"

    for p in points:
        pm = ET.SubElement(doc, "Placemark")
        pm_name = ET.SubElement(pm, "name")
        pm_name.text = p["name"]
        desc = ET.SubElement(pm, "description")
        desc.text = f"道路类型: {p['type']}"
        point = ET.SubElement(pm, "Point")
        coords = ET.SubElement(point, "coordinates")
        coords.text = f"{p['lon']},{p['lat']},0"

    rough_string = ET.tostring(kml, encoding="unicode")
    reparsed = minidom.parseString(rough_string)
    return reparsed.toprettyxml(indent="  ", encoding=None)


def main():
    print("[1/3] 正在从 Overpass API 拉取合肥主要道路数据...")
    result = fetch_roads()
    elements = result.get("elements", [])
    print(f"      API 返回 {len(elements)} 条记录")

    print("[2/3] 提取道路中心点...")
    points = extract_road_points(elements)
    print(f"      提取 {len(points)} 个道路点")

    print("[3/3] 生成文件...")
    kml_text = build_kml(points)
    with open("major_roads.kml", "w", encoding="utf-8") as f:
        f.write(kml_text)

    with open("major_roads.json", "w", encoding="utf-8") as f:
        json.dump(points, f, ensure_ascii=False, indent=2)

    print(f"完成！major_roads.kml ({len(points)} 道路点)")


if __name__ == "__main__":
    main()
