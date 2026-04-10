"""
从 OpenStreetMap Overpass API 拉取合肥市土地利用 (landuse) 多边形数据，
按用地类型分色生成 KML 文件。
"""

import json
import urllib.request
import xml.etree.ElementTree as ET
from xml.dom import minidom

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# 合肥主城区 bounding box (适当缩小以减少数据量)
# 南纬31.65 北纬32.05, 西经116.95 东经117.55
BBOX = "31.65,116.95,32.05,117.55"

OVERPASS_QUERY = f"""
[out:json][timeout:120][maxsize:104857600];
(
  way["landuse"~"residential|commercial|industrial|retail|farmland|forest|recreation_ground|construction"]({BBOX});
  relation["landuse"~"residential|commercial|industrial|retail|farmland|forest|recreation_ground|construction"]({BBOX});
);
out body;
>;
out skel qt;
"""

# KML 颜色格式: AABBGGRR (alpha-blue-green-red)
LANDUSE_STYLES = {
    "residential":        {"name": "居住用地",   "lineColor": "cc0080ff", "polyColor": "5000a5ff"},
    "commercial":         {"name": "商业用地",   "lineColor": "cc0000e0", "polyColor": "500000e0"},
    "industrial":         {"name": "工业用地",   "lineColor": "cc808080", "polyColor": "50808080"},
    "retail":             {"name": "零售用地",   "lineColor": "ccff80ff", "polyColor": "50ff80ff"},
    "farmland":           {"name": "农业用地",   "lineColor": "cc00cc66", "polyColor": "5000cc66"},
    "forest":             {"name": "林地",       "lineColor": "cc008040", "polyColor": "50008040"},
    "recreation_ground":  {"name": "休闲绿地",   "lineColor": "cc00ff80", "polyColor": "5000ff80"},
    "construction":       {"name": "建设用地",   "lineColor": "cc0080c0", "polyColor": "500080c0"},
}


def fetch_overpass():
    data = "data=" + urllib.request.quote(OVERPASS_QUERY)
    req = urllib.request.Request(OVERPASS_URL, data=data.encode("utf-8"), method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_node_index(elements):
    """建立 node id → (lat, lon) 的索引。"""
    nodes = {}
    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
    return nodes


def resolve_way_coords(way, nodes):
    """将 way 的节点 ID 列表转换为坐标列表。"""
    coords = []
    for nid in way.get("nodes", []):
        if nid in nodes:
            lat, lon = nodes[nid]
            coords.append((lon, lat))
    return coords


def resolve_relation_coords(relation, ways_dict, nodes):
    """将 relation 的 outer 成员转换为坐标列表（简化：只取第一个 outer ring）。"""
    for member in relation.get("members", []):
        if member.get("role") == "outer" and member.get("type") == "way":
            wid = member["ref"]
            if wid in ways_dict:
                return resolve_way_coords(ways_dict[wid], nodes)
    return []


def extract_polygons(elements):
    """从 Overpass 结果中提取多边形。"""
    nodes = build_node_index(elements)
    ways_dict = {}
    for el in elements:
        if el["type"] == "way":
            ways_dict[el["id"]] = el

    polygons = []
    for el in elements:
        tags = el.get("tags", {})
        landuse = tags.get("landuse", "")
        if not landuse or landuse not in LANDUSE_STYLES:
            continue

        name = tags.get("name", LANDUSE_STYLES[landuse]["name"])

        if el["type"] == "way":
            coords = resolve_way_coords(el, nodes)
        elif el["type"] == "relation":
            coords = resolve_relation_coords(el, ways_dict, nodes)
        else:
            continue

        if len(coords) < 3:
            continue

        polygons.append({
            "name": name,
            "landuse": landuse,
            "coords": coords,
        })

    return polygons


def build_kml(polygons):
    kml_ns = "http://www.opengis.net/kml/2.2"
    kml = ET.Element("kml", xmlns=kml_ns)
    doc = ET.SubElement(kml, "Document")
    name_el = ET.SubElement(doc, "name")
    name_el.text = "合肥市土地利用规划"
    
    # 添加SRS信息，明确指定使用WGS84坐标系
    extended_data = ET.SubElement(doc, "ExtendedData")
    schema_data = ET.SubElement(extended_data, "SchemaData", schemaUrl="#SRS")
    data = ET.SubElement(schema_data, "SimpleData", name="SRS")
    data.text = "WGS84"
    
    # 添加Schema定义
    schema = ET.SubElement(doc, "Schema", name="SRS", id="SRS")
    ET.SubElement(schema, "SimpleField", name="SRS", type="string")

    # 为每种用地定义样式
    for lu_type, style_def in LANDUSE_STYLES.items():
        style = ET.SubElement(doc, "Style", id=f"style_{lu_type}")

        line_style = ET.SubElement(style, "LineStyle")
        lc = ET.SubElement(line_style, "color")
        lc.text = style_def["lineColor"]
        lw = ET.SubElement(line_style, "width")
        lw.text = "1"

        poly_style = ET.SubElement(style, "PolyStyle")
        pc = ET.SubElement(poly_style, "color")
        pc.text = style_def["polyColor"]
        fill_el = ET.SubElement(poly_style, "fill")
        fill_el.text = "1"
        outline_el = ET.SubElement(poly_style, "outline")
        outline_el.text = "1"

    # 按用地类型分 Folder
    by_type = {}
    for p in polygons:
        by_type.setdefault(p["landuse"], []).append(p)

    for lu_type, polys in by_type.items():
        folder = ET.SubElement(doc, "Folder")
        folder_name = ET.SubElement(folder, "name")
        folder_name.text = LANDUSE_STYLES[lu_type]["name"]

        for p in polys:
            pm = ET.SubElement(folder, "Placemark")
            pm_name = ET.SubElement(pm, "name")
            pm_name.text = p["name"]
            style_url = ET.SubElement(pm, "styleUrl")
            style_url.text = f"#style_{p['landuse']}"

            polygon_el = ET.SubElement(pm, "Polygon")
            outer = ET.SubElement(polygon_el, "outerBoundaryIs")
            ring = ET.SubElement(outer, "LinearRing")
            coords_el = ET.SubElement(ring, "coordinates")
            coords_text = " ".join(f"{lon},{lat},0" for lon, lat in p["coords"])
            coords_el.text = coords_text

    rough_string = ET.tostring(kml, encoding="unicode")
    reparsed = minidom.parseString(rough_string)
    return reparsed.toprettyxml(indent="  ", encoding=None)


def main():
    print("[1/3] 正在从 Overpass API 拉取合肥市土地利用数据...")
    print(f"      查询范围: {BBOX}")
    result = fetch_overpass()
    elements = result.get("elements", [])
    print(f"      API 返回 {len(elements)} 条记录")

    print("[2/3] 解析多边形...")
    polygons = extract_polygons(elements)
    print(f"      共提取 {len(polygons)} 个多边形")

    # 统计各类型数量
    type_counts = {}
    for p in polygons:
        lu = p["landuse"]
        type_counts[lu] = type_counts.get(lu, 0) + 1
    for lu, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        label = LANDUSE_STYLES[lu]["name"]
        print(f"        {label}: {count}")

    print("[3/3] 生成 KML 文件...")
    kml_text = build_kml(polygons)
    with open("landuse.kml", "w", encoding="utf-8") as f:
        f.write(kml_text)

    # 同时输出精简 JSON 供参考
    json_data = []
    for p in polygons:
        json_data.append({
            "name": p["name"],
            "landuse": p["landuse"],
            "vertexCount": len(p["coords"]),
        })
    with open("landuse_summary.json", "w", encoding="utf-8") as f:
        json.dump(json_data, f, ensure_ascii=False, indent=2)

    print(f"完成！landuse.kml ({len(polygons)} 个多边形)")


if __name__ == "__main__":
    main()
