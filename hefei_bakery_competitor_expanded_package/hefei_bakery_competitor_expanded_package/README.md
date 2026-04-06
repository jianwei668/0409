# 合肥烘焙竞争门店扩展数据包

这包数据按“先能用于选址评分，再逐步补全”的思路整理。

## 文件说明
- `bakery_competitor_combined_active.csv`：现有项目中的詹记 30 点 + 本轮新增的活跃烘焙竞争点。
- `bakery_competitor_combined_active.kml`：上面数据里**已有坐标**的点，能直接导入你的地图项目。
- `bakery_active_non_zhanji_curated.csv`：本轮新增的非詹记烘焙竞争点清单，含状态、地址、坐标方法、可信度。
- `bakery_active_non_zhanji_curated.kml`：新增点里已有坐标的那部分。
- `bakery_historical_or_inactive.csv`：历史或疑似停业品牌/门店，默认建议不要参与竞争评分。
- `bakery_brand_watchlist.csv`：已确认在合肥烘焙市场活跃/被提及，但本轮没补齐门店级地址的品牌观察名单。
- `bakery_competitor_geocode_seed.csv`：仍缺坐标的地址种子，后续可继续 geocode。
- `zhanji_existing_project_points.csv`：从你上传项目 `zhanji_all.kml` 提取出的 30 个现有点位明细。
- `geocode_bakery_seed_nominatim.py`：把 seed CSV 继续补坐标的脚本。

## 当前规模
- 现有项目詹记/桃酥类点位：30
- 本轮新增的非詹记活跃烘焙竞争点：18
- 其中已带 WGS84 坐标、可直接上图的新增点：6
- 合并后活跃竞争点总数（含詹记）：48

## 建议用法
1. 先把 `bakery_competitor_combined_active.kml` 直接导入项目，立刻参与竞争评分。
2. 再把 `bakery_competitor_geocode_seed.csv` 跑 geocode，补更多点位。
3. 历史/疑似停业层（如巴莉甜甜、丰蝶来）单独保留，不建议默认计入竞争分。

## 评分层建议
- 直接竞争：鲍师傅、仟吉、超港、蓝塔、采蝶轩、Noah'sBakery、面包好了、甜嘟嘟、Le Monde、HOT CRUSH、Eyeable 等。
- 历史/停业：默认排除；如果要做“商圈烘焙历史密度”才单独开启。
