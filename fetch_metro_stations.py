"""
从 OpenStreetMap Overpass API 拉取合肥市所有已运营地铁站并生成 KML 文件。
只保留 station=subway 且不含 proposed / construction 标记的站点（即实际运营站点）。
"""

import json
import urllib.request
import xml.etree.ElementTree as ET
from xml.dom import minidom

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# 用合肥市经纬度范围框代替 area 查询，更可靠
OVERPASS_QUERY = """
[out:json][timeout:60];
(
  node["station"="subway"](31.0,116.6,32.5,117.9);
);
out body;
"""


def fetch_stations():
    data = "data=" + urllib.request.quote(OVERPASS_QUERY)
    req = urllib.request.Request(OVERPASS_URL, data=data.encode("utf-8"), method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def filter_active_stations(elements):
    """保留已运营站点，排除 proposed / construction。"""
    stations = []
    seen_names = set()
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("proposed") == "yes" or tags.get("construction") == "yes":
            continue
        if "proposed:railway" in tags:
            continue
        name = tags.get("name", "")
        if not name:
            continue
        lat = el["lat"]
        lon = el["lon"]
        # 去重（同名站点只保留一个）
        key = name
        if key in seen_names:
            continue
        seen_names.add(key)
        stations.append({
            "name": name,
            "lat": lat,
            "lon": lon,
            "name_en": tags.get("name:en", ""),
        })
    return stations


def build_kml(stations):
    kml_ns = "http://www.opengis.net/kml/2.2"
    kml = ET.Element("kml", xmlns=kml_ns)
    doc = ET.SubElement(kml, "Document")
    name_el = ET.SubElement(doc, "name")
    name_el.text = "合肥地铁站"

    # 定义样式
    style = ET.SubElement(doc, "Style", id="metroStation")
    icon_style = ET.SubElement(style, "IconStyle")
    color_el = ET.SubElement(icon_style, "color")
    color_el.text = "ff0000ff"
    scale_el = ET.SubElement(icon_style, "scale")
    scale_el.text = "1.0"
    icon_el = ET.SubElement(icon_style, "Icon")
    href_el = ET.SubElement(icon_el, "href")
    href_el.text = "http://maps.google.com/mapfiles/kml/shapes/rail.png"

    for s in stations:
        pm = ET.SubElement(doc, "Placemark")
        pm_name = ET.SubElement(pm, "name")
        pm_name.text = s["name"]
        style_url = ET.SubElement(pm, "styleUrl")
        style_url.text = "#metroStation"
        desc = ET.SubElement(pm, "description")
        desc.text = f"地铁站: {s['name']}"
        if s["name_en"]:
            desc.text += f" ({s['name_en']})"
        point = ET.SubElement(pm, "Point")
        coords = ET.SubElement(point, "coordinates")
        coords.text = f"{s['lon']},{s['lat']},0"

    rough_string = ET.tostring(kml, encoding="unicode")
    reparsed = minidom.parseString(rough_string)
    return reparsed.toprettyxml(indent="  ", encoding=None)


def main():
    print("[1/3] 正在从 Overpass API 拉取合肥地铁站数据...")
    result = fetch_stations()
    elements = result.get("elements", [])
    print(f"      API 返回 {len(elements)} 条记录")

    print("[2/3] 过滤已运营站点...")
    stations = filter_active_stations(elements)
    print(f"      保留 {len(stations)} 个已运营站点")

    print("[3/3] 生成 KML 文件...")
    kml_text = build_kml(stations)
    with open("metro_stations.kml", "w", encoding="utf-8") as f:
        f.write(kml_text)

    # 同时输出 JSON 供参考
    with open("metro_stations.json", "w", encoding="utf-8") as f:
        json.dump(stations, f, ensure_ascii=False, indent=2)

    print(f"完成！metro_stations.kml ({len(stations)} 站)")


if __name__ == "__main__":
    main()
