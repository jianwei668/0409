# 合肥近似地价代理数据包（非官方网页抓取版）

这个包是给“先选址，再打分”做 **地价代理层** 的。

## 里面有什么

- `hefei_nonofficial_land_price_proxy_districts_2026.csv`
  - 区级近似地价代理值（用住宅挂牌均价做代理）
- `hefei_nonofficial_land_price_proxy_hotspots_2026.csv`
  - 热点/板块/高值社区锚点，适合直接做单点评分附近匹配
- `hefei_nonofficial_land_price_proxy_hotspots_geocode_seed.csv`
  - 已整理成适合 geocode 的种子表
- `hefei_nonofficial_land_price_proxy_hotspots_2026.json`
  - 前端可直接加载的 JSON
- `geocode_land_price_anchors_amap.py`
  - 把种子表 geocode 成 KML 的脚本（需要你自己的高德 Web 服务 Key）

## 这套数据怎么理解

这不是官方基准地价，也不是评估报告。
它是把这些站点上的“房价/挂牌价/商圈均价/社区均价”抓下来，作为 **地价和商圈成熟度的近似代理值**：

- 中国房价行情（creprice）
- 房天下
- 安居客
- 58同城
- 高德地图（只用于板块锚点地址，不用于价格）

适合你现在这种：
- 地图里先选一个点
- 再根据权重评分
- 地价只需要“相对高低”而不是法律意义上的精确地价

## 推荐你怎么用

### 方案 A：最快上线
直接用 `hefei_nonofficial_land_price_proxy_hotspots_2026.csv`

逻辑：
1. 用户选址
2. 找最近的 1~3 个热点锚点
3. 取它们的 `proxy_price_yuan_per_m2`
4. 计算 `proxy_score_cost_first_0_100` 或 `proxy_score_commercial_first_0_100`

### 方案 B：生成地图点图层

```bash
python geocode_land_price_anchors_amap.py   --key 你的高德Web服务Key   --input hefei_nonofficial_land_price_proxy_hotspots_geocode_seed.csv   --output-prefix hefei_nonofficial_land_price_proxy_hotspots_points
```

输出：
- `hefei_nonofficial_land_price_proxy_hotspots_points.csv`
- `hefei_nonofficial_land_price_proxy_hotspots_points.kml`

把 KML 放进你项目目录后，就能作为“地价代理层”参与评分。

## 字段说明

- `proxy_price_yuan_per_m2`：近似价格代理值
- `proxy_score_commercial_first_0_100`：越高表示越适合“商圈优先/成熟度优先”
- `proxy_score_cost_first_0_100`：越高表示越适合“成本优先”
- `suggested_grade_6_high_to_low`：我按价格高低粗分的 1~6 档，1 最高、6 最低

## 使用提醒

- 不同网站的统计口径不完全一样，适合做**排序和分层**，不适合做正式估值
- 热点板块值比区级均值更适合你现在的选址评分
- 若你后面补到了更好的租金/商铺数据，可以替换掉 `proxy_price_yuan_per_m2`
