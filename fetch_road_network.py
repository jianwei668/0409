"""
从 OpenStreetMap Overpass API 拉取合肥市区主要道路的线段几何，
输出 GeoJSON FeatureCollection 文件（road_network.json），
供前端作为独立路网矢量图层展示。

道路类型：motorway, trunk, primary, secondary, tertiary
输出坐标系：GCJ-02（与高德底图瓦片一致）
原始数据坐标系：WGS-84（OpenStreetMap），脚本自动转换为 GCJ-02。
"""

import json
import math
import urllib.request

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# 合肥市区范围（覆盖整个建成区）
# motorway / trunk / primary / secondary 全域拉取
# tertiary 限核心城区以控制数据量
OVERPASS_QUERY = """
[out:json][timeout:180];
(
  way["highway"="motorway"](31.5,116.8,32.2,117.7);
  way["highway"="trunk"](31.5,116.8,32.2,117.7);
  way["highway"="primary"](31.5,116.8,32.2,117.7);
  way["highway"="secondary"](31.6,116.9,32.1,117.6);
  way["highway"="tertiary"](31.7,117.05,31.95,117.5);
);
out geom;
"""

# ---- WGS-84 → GCJ-02 坐标转换 ----
_A = 6378245.0
_EE = 0.00669342162296594


def _out_of_china(lat, lon):
    return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _transform_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lon(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat, lon):
    if _out_of_china(lat, lon):
        return lat, lon
    dlat = _transform_lat(lon - 105.0, lat - 35.0)
    dlon = _transform_lon(lon - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlon = (dlon * 180.0) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return lat + dlat, lon + dlon


def fetch_roads():
    data = "data=" + urllib.request.quote(OVERPASS_QUERY)
    req = urllib.request.Request(OVERPASS_URL, data=data.encode("utf-8"), method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_geojson(elements):
    """将 Overpass way 元素转为 GeoJSON FeatureCollection，坐标从 WGS-84 转换为 GCJ-02。"""
    features = []
    for el in elements:
        if el.get("type") != "way":
            continue
        geometry_nodes = el.get("geometry")
        if not geometry_nodes:
            continue

        tags = el.get("tags", {})
        highway_type = tags.get("highway", "")
        name = tags.get("name", "")

        coordinates = []
        for node in geometry_nodes:
            gcj_lat, gcj_lon = wgs84_to_gcj02(node["lat"], node["lon"])
            coordinates.append([round(gcj_lon, 7), round(gcj_lat, 7)])

        if len(coordinates) < 2:
            continue

        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "highway": highway_type,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coordinates,
            },
        }
        features.append(feature)

    return {"type": "FeatureCollection", "features": features}


def main():
    print("[1/3] 正在从 Overpass API 拉取合肥市区路网数据（含线段几何）...")
    result = fetch_roads()
    elements = result.get("elements", [])
    print(f"      获取到 {len(elements)} 条道路要素")

    print("[2/3] 正在生成 GeoJSON FeatureCollection...")
    geojson = build_geojson(elements)
    print(f"      转换为 {len(geojson['features'])} 条 LineString 要素")

    out_path = "road_network.json"
    print(f"[3/3] 写入 {out_path} ...")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    size_kb = len(json.dumps(geojson, ensure_ascii=False)) / 1024
    print(f"完成！文件大小约 {size_kb:.0f} KB，共 {len(geojson['features'])} 条道路。")


if __name__ == "__main__":
    main()
