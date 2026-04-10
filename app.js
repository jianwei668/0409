/**
 * 服务业选址分析系统
 * 增强版：支持 KML/KMZ 导入 + CSV人口数据加载 + 热力图生成 + 卫星影像叠加显示
 * 本次改造：
 * 1. 启动时自动加载目录中的内置 KML 文件
 * 2. 使用图层树统一控制内置KML、外部导入图层、手工绘制图层
 * 3. 新增"商圈店VS社区店"分组，接入宿州路店和大兴新居店独立 KML
 * 4. 热力图数据改为按图层可见性和热力参与状态动态计算
 * 5. 人口数据与人口热力图改为读取 01原始数据CSV，并直接使用其中的 GCJ-02 坐标列
 */

// WGS84 转 GCJ-02 坐标转换函数
function wgs84ToGcj02(lng, lat) {
    var pi = 3.1415926535897932384626;
    var a = 6378245.0;
    var ee = 0.00669342162296594323;
    
    if (outOfChina(lng, lat)) {
        return [lng, lat];
    }
    
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * pi;
    var magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
    var mgLat = lat + dLat;
    var mgLng = lng + dLng;
    return [mgLng, mgLat];
}

function transformLat(x, y) {
    var pi = 3.1415926535897932384626;
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * pi) + 40.0 * Math.sin(y / 3.0 * pi)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * pi) + 320 * Math.sin(y * pi / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    var pi = 3.1415926535897932384626;
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * pi) + 40.0 * Math.sin(x / 3.0 * pi)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * pi) + 300.0 * Math.sin(x * pi / 30.0)) * 2.0 / 3.0;
    return ret;
}

function outOfChina(lng, lat) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}

let map;
let drawnItems;
let layers = {};
let layerIdCounter = 0;

// ====== 热力图相关全局变量 ======
let heatLayer = null;
let heatmapVisible = true;
let importedHeatPoints = [];
let manualHeatPoints = [];
let heatmapRebuildHandle = null;
let heatmapPeakMarker = null;
let populationPointRenderer = null;
let populationHourlyPointSets = {};
let mapLayoutRefreshTimers = [];
let mapContainerResizeObserver = null;

// 热力图导入模式：'replace' = 覆盖，'append' = 累积
let heatImportMode = 'replace';
let currentBaseLayerLabel = '街道地图';
let layerSearchTerm = '';

const SOURCE_KIND_NAMES = {
    populationDensity: '人口数据',
    zhanji: '詹记',
    roadNetwork: '路网图层',
    builtinKml: '土地利用规划图层',
    importedKml: '外部导入KML',
    drawn: '手工绘制'
};

const SOURCE_KIND_PANES = {
    populationDensity: {
        name: 'populationDensityPane',
        zIndex: 410
    },
    zhanji: {
        name: 'zhanjiPane',
        zIndex: 420
    },
    roadNetwork: {
        name: 'roadNetworkPane',
        zIndex: 405
    },
    builtinKml: {
        name: 'builtinKmlPane',
        zIndex: 440
    }
};

// 路网图层样式配置（按道路等级分色分粗细）
const ROAD_NETWORK_STYLES = {
    motorway:  { color: '#e74c3c', weight: 4, opacity: 0.85 },
    trunk:     { color: '#e67e22', weight: 3.5, opacity: 0.80 },
    primary:   { color: '#f39c12', weight: 3, opacity: 0.75 },
    secondary: { color: '#3498db', weight: 2.5, opacity: 0.70 },
    tertiary:  { color: '#95a5a6', weight: 2, opacity: 0.60 },
    _default:  { color: '#bdc3c7', weight: 1.5, opacity: 0.50 }
};
const ROAD_NETWORK_FILE = 'road_network.json';

// 目录中的内置 KML 清单（浏览器无法直接枚举目录，因此需要显式清单）
const AUTO_LOAD_KML_FILES = [
    { fileName: 'zhanji_all.kml', sourceKind: 'zhanji', displayName: '詹记', visible: false },
    { fileName: 'landuse.kml', sourceKind: 'builtinKml', displayName: '土地利用规划', visible: true, heatIncluded: false }
];

const POPULATION_HOURS = Array.from({ length: 24 }, function(_, hour) {
    return String(hour).padStart(2, '0');
});
const POPULATION_CSV_FILES = POPULATION_HOURS.map(function(hour) {
    return `01原始数据CSV/合肥市_20260328${hour}.csv`;
});
const POPULATION_LAYER_NAME = '人口数据';
const POPULATION_POINT_MIN_ZOOM = 13;
const POPULATION_POINT_POPUP_MIN_ZOOM = 16;
const POPULATION_VIEW_PADDING = 0.08;
const POPULATION_VIEW_RENDER_DELAY_MS = 200;
const POPULATION_VIEW_TARGET_POINT_COUNT = 800;
const POPULATION_VIEW_MAX_POINT_COUNT = 1200;
const POPULATION_VIEW_MAX_GRID_SIZE = 0.012;
const HEATMAP_REBUILD_DELAY_MS = 150;
const HEATMAP_REFERENCE_ZOOM = 13;
const HEATMAP_MAX_RADIUS = 140;
const HEATMAP_MAX_BLUR = 96;
const HEATMAP_PEAK_PANE_NAME = 'heatmapPeakPane';
const HEATMAP_PEAK_PANE_Z_INDEX = 460;
const TABLET_DESIGN_WIDTH = 1366;
const TABLET_DESIGN_HEIGHT = 768;
const HEATMAP_STYLE_PROFILES = [
    {
        name: '城市总览',
        maxZoom: 12,
        colorLabel: '深蓝-湖蓝-亮黄-橙红',
        opacityBoost: 0.04,
        contrastQuantile: 0.92,
        gradient: {
            0.08: '#173b73',
            0.26: '#1f6fba',
            0.44: '#00a6d6',
            0.60: '#ffe066',
            0.78: '#ff9f1c',
            1.0: '#cd2f2a'
        }
    },
    {
        name: '城区对比',
        maxZoom: 15,
        colorLabel: '靛蓝-亮蓝-黄橙-高热红',
        opacityBoost: 0.08,
        contrastQuantile: 0.86,
        gradient: {
            0.08: '#202a78',
            0.24: '#2563eb',
            0.42: '#00a6d6',
            0.58: '#ffe066',
            0.76: '#ff8c42',
            1.0: '#c62828'
        }
    },
    {
        name: '街区定位',
        maxZoom: Number.POSITIVE_INFINITY,
        colorLabel: '深紫-亮蓝-黄橙-洋红高热',
        opacityBoost: 0.12,
        contrastQuantile: 0.78,
        gradient: {
            0.08: '#2d1b69',
            0.22: '#355cde',
            0.38: '#00b8d9',
            0.54: '#ffe066',
            0.72: '#ff9f1c',
            1.0: '#d81b60'
        }
    }
];
const POPULATION_WEIGHT_STRATEGY = '热力图按空间点密度生成，不使用 value 权重；CSV 中的 value 仅作信息展示';
let selectedPopulationHours = new Set(['14']);
const POPULATION_FIXED_HOUR_LABEL = '某周六下午 14:00';

function cancelScheduledMapLayoutRefresh() {
    mapLayoutRefreshTimers.forEach(function(timerId) {
        window.clearTimeout(timerId);
    });
    mapLayoutRefreshTimers = [];
}

function updateViewportCssVariables(viewportSize = getViewportSize()) {
    const viewportHeight = Math.max(1, Math.round(viewportSize.height));
    document.documentElement.style.setProperty('--app-viewport-height', `${viewportHeight}px`);
}

function scheduleMapLayoutRefresh(delays = [0, 180, 520]) {
    if (!map) {
        return;
    }

    cancelScheduledMapLayoutRefresh();

    delays.forEach(function(delay) {
        const timerId = window.setTimeout(function() {
            if (!map) {
                return;
            }

            window.requestAnimationFrame(function() {
                if (!map) {
                    return;
                }

                map.invalidateSize(false);
                refreshDynamicLayerViews();
            });
        }, delay);

        mapLayoutRefreshTimers.push(timerId);
    });
}

function observeMapContainerResize() {
    if (typeof ResizeObserver === 'undefined') {
        return;
    }

    const mapElement = document.getElementById('map');
    if (!mapElement) {
        return;
    }

    if (mapContainerResizeObserver) {
        mapContainerResizeObserver.disconnect();
    }

    mapContainerResizeObserver = new ResizeObserver(function(entries) {
        if (!entries.length || !map) {
            return;
        }

        scheduleMapLayoutRefresh([0, 120]);
    });

    mapContainerResizeObserver.observe(mapElement);
}

function getAllLayerEntries() {
    return Object.values(layers);
}

function getViewportSize() {
    if (window.visualViewport) {
        return {
            width: window.visualViewport.width,
            height: window.visualViewport.height
        };
    }

    return {
        width: window.innerWidth,
        height: window.innerHeight
    };
}

function shouldUseTabletFixedLayout(viewportSize) {
    // 禁用等比缩放，改用真正的 CSS 响应式布局
    return false;
}

function syncTabletLayoutMode() {
    if (!document.body) {
        return;
    }

    const viewportSize = getViewportSize();
    updateViewportCssVariables(viewportSize);
    const useFixedLayout = shouldUseTabletFixedLayout(viewportSize);

    document.body.classList.toggle('tablet-fixed-layout', useFixedLayout);

    const scale = useFixedLayout
        ? Math.min(viewportSize.width / TABLET_DESIGN_WIDTH, viewportSize.height / TABLET_DESIGN_HEIGHT)
        : 1;

    document.documentElement.style.setProperty('--tablet-scale', scale.toFixed(4));

    scheduleMapLayoutRefresh();
}

function initResponsiveLayout() {
    syncTabletLayoutMode();

    window.addEventListener('resize', syncTabletLayoutMode);
    window.addEventListener('orientationchange', function() {
        syncTabletLayoutMode();
        scheduleMapLayoutRefresh([120, 320, 720]);
    });

    window.addEventListener('load', function() {
        syncTabletLayoutMode();
        scheduleMapLayoutRefresh([0, 220, 720]);
    });

    window.addEventListener('pageshow', function() {
        syncTabletLayoutMode();
        scheduleMapLayoutRefresh([0, 220, 720]);
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncTabletLayoutMode);
        window.visualViewport.addEventListener('scroll', syncTabletLayoutMode);
    }

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function() {
            syncTabletLayoutMode();
            scheduleMapLayoutRefresh([0, 180, 520]);
        });
    }

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            syncTabletLayoutMode();
            scheduleMapLayoutRefresh([0, 180, 520]);
        }
    });

    updateViewportCssVariables();
}

function getCurrentHeatmapStyleProfile() {
    const zoom = map ? map.getZoom() : HEATMAP_REFERENCE_ZOOM;
    return getHeatmapStyleProfile(zoom);
}

function refreshHeatmapStyleForCurrentZoom() {
    if (!map || !heatLayer) {
        return;
    }

    const styleProfile = getCurrentHeatmapStyleProfile();

    if (typeof heatLayer.setOptions === 'function') {
        heatLayer.setOptions({ gradient: styleProfile.gradient });
    }

    if (typeof heatLayer.redraw === 'function') {
        heatLayer.redraw();
    }

    if (heatmapPeakMarker && map.hasLayer(heatmapPeakMarker)) {
        updateHeatmapPeakMarker(getHeatmapPeakPoint(getAllHeatPoints()), styleProfile);
    }
}

function getSourceKindName(sourceKind) {
    return SOURCE_KIND_NAMES[sourceKind] || '未知来源';
}

function getLayerPaneName(sourceKind) {
    const paneConfig = SOURCE_KIND_PANES[sourceKind];
    return paneConfig ? paneConfig.name : undefined;
}

function addLayerEntryToMap(entry) {
    if (!entry || !entry.layer) return;

    if (typeof entry.attachToMap === 'function') {
        entry.attachToMap();
        return;
    }

    drawnItems.addLayer(entry.layer);
}

function removeLayerEntryFromMap(entry) {
    if (!entry || !entry.layer) return;

    if (typeof entry.detachFromMap === 'function') {
        entry.detachFromMap();
        return;
    }

    drawnItems.removeLayer(entry.layer);
}

function getLayerBounds(entry) {
    if (!entry) return null;

    if (entry.bounds && typeof entry.bounds.isValid === 'function' && entry.bounds.isValid()) {
        return entry.bounds;
    }

    if (entry.type === 'marker' && entry.layer && typeof entry.layer.getLatLng === 'function') {
        const latLng = entry.layer.getLatLng();
        return L.latLngBounds(latLng, latLng);
    }

    if (entry.layer && typeof entry.layer.getBounds === 'function') {
        const bounds = entry.layer.getBounds();
        if (bounds && bounds.isValid()) {
            return bounds;
        }
    }

    return null;
}

function refreshDynamicLayerViews() {
    getAllLayerEntries().forEach(entry => {
        if (typeof entry.refreshViewport === 'function') {
            entry.refreshViewport();
        }
    });
}

function ensureLayerPanes() {
    Object.values(SOURCE_KIND_PANES).forEach(function(paneConfig) {
        if (!map.getPane(paneConfig.name)) {
            map.createPane(paneConfig.name);
        }

        map.getPane(paneConfig.name).style.zIndex = String(paneConfig.zIndex);
    });

    if (!map.getPane(HEATMAP_PEAK_PANE_NAME)) {
        map.createPane(HEATMAP_PEAK_PANE_NAME);
    }

    map.getPane(HEATMAP_PEAK_PANE_NAME).style.zIndex = String(HEATMAP_PEAK_PANE_Z_INDEX);
}

function withLayerPane(options, paneName) {
    if (!paneName) return options;

    return {
        ...options,
        pane: paneName
    };
}

function getVisibleHeatPointCollections() {
    const visibleImported = [];
    const visibleManual = [];

    getAllLayerEntries().forEach(entry => {
        const participatesInHeat = entry.heatIncluded !== false
            && (entry.visible !== false || entry.includeHeatWhenHidden === true);
        if (!participatesInHeat) return;

        if (entry.sourceKind !== 'drawn' && Array.isArray(entry.heatPoints)) {
            visibleImported.push(...entry.heatPoints);
        }

        if (entry.sourceKind === 'drawn' && entry.type === 'marker' && entry.layer && entry.layer._heatPoint) {
            visibleManual.push(entry.layer._heatPoint);
        }
    });

    return {
        imported: visibleImported,
        manual: visibleManual
    };
}

/**
 * 获取当前所有热力点（按图层可见状态动态汇总）
 */
function getAllHeatPoints() {
    const visibleCollections = getVisibleHeatPointCollections();
    importedHeatPoints = visibleCollections.imported;
    manualHeatPoints = visibleCollections.manual;
    return [...importedHeatPoints, ...manualHeatPoints];
}

function getHeatmapAggregationGridSize(zoom) {
    if (zoom >= 18) {
        return 0.0022;
    }

    if (zoom >= 17) {
        return 0.002;
    }

    if (zoom >= 16) {
        return 0.0018;
    }

    if (zoom >= 15) {
        return 0.0018;
    }

    if (zoom >= 14) {
        return 0.0024;
    }

    if (zoom >= 13) {
        return 0.0032;
    }

    return 0.0048;
}

function getHeatmapStyleProfile(zoom) {
    return HEATMAP_STYLE_PROFILES.find(function(profile) {
        return zoom <= profile.maxZoom;
    }) || HEATMAP_STYLE_PROFILES[HEATMAP_STYLE_PROFILES.length - 1];
}

function aggregateHeatPointsByGrid(points, gridSize) {
    if (!gridSize || points.length <= 80) {
        return points;
    }

    const cellMap = new Map();

    points.forEach(function(point) {
        const lat = Number(point[0]);
        const lng = Number(point[1]);
        const intensity = Number(point[2]) || 1;

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return;
        }

        const latCell = Math.round(lat / gridSize);
        const lngCell = Math.round(lng / gridSize);
        const cellKey = `${latCell}:${lngCell}`;

        let aggregatedPoint = cellMap.get(cellKey);
        if (!aggregatedPoint) {
            aggregatedPoint = {
                latSum: 0,
                lngSum: 0,
                intensity: 0
            };
            cellMap.set(cellKey, aggregatedPoint);
        }

        aggregatedPoint.latSum += lat * intensity;
        aggregatedPoint.lngSum += lng * intensity;
        aggregatedPoint.intensity += intensity;
    });

    return Array.from(cellMap.values()).map(function(point) {
        return [
            point.latSum / point.intensity,
            point.lngSum / point.intensity,
            point.intensity
        ];
    });
}

function buildHeatmapDisplayPointState(points, zoom) {
    const gridSize = getHeatmapAggregationGridSize(zoom);
    const aggregatedPoints = aggregateHeatPointsByGrid(points, gridSize);

    return {
        points: aggregatedPoints,
        gridSize: gridSize,
        gridSizeMeters: Math.round(gridSize * 111000)
    };
}

function getHeatmapIntensityAtQuantile(points, quantile) {
    if (!points.length) {
        return 1;
    }

    const intensities = points
        .map(function(point) {
            return Number(point[2]) || 1;
        })
        .sort(function(left, right) {
            return left - right;
        });

    const index = Math.min(
        intensities.length - 1,
        Math.max(0, Math.floor((intensities.length - 1) * quantile))
    );

    return intensities[index] || 1;
}

function getHeatmapPeakPoint(points) {
    return points.reduce(function(currentPeak, point) {
        if (!currentPeak) {
            return point;
        }

        return (Number(point[2]) || 1) > (Number(currentPeak[2]) || 1) ? point : currentPeak;
    }, null);
}

function getAdaptiveHeatmapRadius(baseRadius, zoom) {
    const zoomDelta = Math.max(0, zoom - HEATMAP_REFERENCE_ZOOM);
    const scale = Math.pow(1.6, zoomDelta);
    return Math.max(baseRadius, Math.min(HEATMAP_MAX_RADIUS, Math.round(baseRadius * scale)));
}

function getAdaptiveHeatmapBlur(baseBlur, zoom) {
    const zoomDelta = Math.max(0, zoom - HEATMAP_REFERENCE_ZOOM);
    const scale = Math.pow(1.4, zoomDelta);
    return Math.max(baseBlur, Math.min(HEATMAP_MAX_BLUR, Math.round(baseBlur * scale)));
}

function cancelScheduledHeatmapRebuild() {
    if (!heatmapRebuildHandle) {
        return;
    }

    window.clearTimeout(heatmapRebuildHandle);
    heatmapRebuildHandle = null;
}

function scheduleHeatmapRebuild(options = {}) {
    cancelScheduledHeatmapRebuild();

    const delay = options.immediate === true ? 0 : HEATMAP_REBUILD_DELAY_MS;
    heatmapRebuildHandle = window.setTimeout(function() {
        heatmapRebuildHandle = null;
        rebuildHeatmap();
    }, delay);
}

function removeHeatmapPeakMarker() {
    if (!heatmapPeakMarker) {
        return;
    }

    if (map && map.hasLayer(heatmapPeakMarker)) {
        map.removeLayer(heatmapPeakMarker);
    }

    heatmapPeakMarker = null;
}

function updateHeatmapPeakMarker(peakPoint, styleProfile) {
    removeHeatmapPeakMarker();

    if (!map || !peakPoint) {
        return;
    }

    heatmapPeakMarker = L.circleMarker([peakPoint[0], peakPoint[1]], {
        pane: HEATMAP_PEAK_PANE_NAME,
        radius: 10,
        color: '#811d3a',
        weight: 3,
        fillColor: '#fff7ed',
        fillOpacity: 0.95
    });

    heatmapPeakMarker.bindTooltip(`峰值区 · ${styleProfile.name}`, {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'heat-peak-tooltip'
    });

    heatmapPeakMarker.bindPopup(`
        <div class="custom-popup">
            <strong>当前峰值热点</strong>
            <p>档位方案：${styleProfile.name}</p>
            <p>热力强度：${formatPopulationDisplayNumber(Number(peakPoint[2]) || 1)}</p>
            <p>GCJ-02：${Number(peakPoint[1]).toFixed(6)}, ${Number(peakPoint[0]).toFixed(6)}</p>
        </div>
    `);

    if (heatmapVisible) {
        heatmapPeakMarker.addTo(map);
    }
}


function updateDashboardStats() {
    getAllHeatPoints();

    const basemapEl = document.getElementById('currentBasemapLabel');
    const heatStatusEl = document.getElementById('currentHeatStatus');

    if (basemapEl) basemapEl.textContent = currentBaseLayerLabel;

    if (heatStatusEl) {
        if (!heatLayer) {
            heatStatusEl.textContent = '未生成';
        } else {
            heatStatusEl.textContent = heatmapVisible ? '显示中' : '已隐藏';
        }
    }
}

function setSystemStatus(message, tone = 'info') {
    const statusEl = document.getElementById('systemStatus');
    if (!statusEl) return;

    const iconMap = {
        info: 'fa-circle-info',
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        loading: 'fa-circle-notch fa-spin'
    };

    const icon = iconMap[tone] || iconMap.info;
    statusEl.innerHTML = `<i class="fas ${icon}"></i> ${message}`;
    statusEl.dataset.tone = tone;
}

function updateBaseLayerLabel(label) {
    currentBaseLayerLabel = label;
    updateDashboardStats();
}

function setAllTreeSections(open) {
    document.querySelectorAll('#layersList details.tree-section').forEach(section => {
        section.open = open;
    });
}

function setSectionVisibility(sourceKind, visible) {
    const entries = getAllLayerEntries().filter(entry => entry.sourceKind === sourceKind);

    // 懒加载的图层需要逐个加载
    if (visible) {
        const lazyKmlEntries = entries.filter(e => e._lazyKml && !e._lazyLoaded);
        const lazyRoadEntries = entries.filter(e => e._lazyRoadNetwork && !e._lazyLoaded);
        const readyEntries = entries.filter(e => (!e._lazyKml && !e._lazyRoadNetwork) || e._lazyLoaded);

        readyEntries.forEach(entry => {
            entry.visible = true;
            addLayerEntryToMap(entry);
        });

        const lazyPromises = [];

        if (lazyKmlEntries.length > 0) {
            updateInfoPanel(`正在加载 ${lazyKmlEntries.length} 个图层...`);
            lazyPromises.push(
                Promise.all(lazyKmlEntries.map(entry => ensureKmlLayerLoaded(entry))).then(function() {
                    lazyKmlEntries.forEach(entry => {
                        entry.visible = true;
                        addLayerEntryToMap(entry);
                        _syncLanduseLegend(entry, true);
                    });
                })
            );
        }

        if (lazyRoadEntries.length > 0) {
            updateInfoPanel('正在加载路网...');
            lazyPromises.push(
                Promise.all(lazyRoadEntries.map(entry => ensureRoadNetworkLoaded(entry))).then(function() {
                    lazyRoadEntries.forEach(entry => {
                        entry.visible = true;
                        addLayerEntryToMap(entry);
                    });
                })
            );
        }

        if (lazyPromises.length > 0) {
            Promise.all(lazyPromises).then(function() {
                updateLayersList();
                rebuildHeatmap();
                updateInfoPanel(`${getSourceKindName(sourceKind)} 已全部显示`);
            });
        }
    } else {
        entries.forEach(entry => {
            entry.visible = false;
            removeLayerEntryFromMap(entry);
            _syncLanduseLegend(entry, false);
        });
    }

    updateLayersList();
    rebuildHeatmap();
    updateInfoPanel(`${getSourceKindName(sourceKind)} 已${visible ? '全部显示' : '全部隐藏'}`);
}

function initUiEnhancements() {
    const searchInput = document.getElementById('layerSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            layerSearchTerm = this.value.trim().toLowerCase();
            updateLayersList();
        });
    }

    const expandBtn = document.getElementById('expandAllLayers');
    if (expandBtn) {
        expandBtn.addEventListener('click', function() {
            setAllTreeSections(true);
        });
    }

    const collapseBtn = document.getElementById('collapseAllLayers');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', function() {
            setAllTreeSections(false);
        });
    }

    updateDashboardStats();
}

/**
 * 初始化地图和相关功能
 */
function initMap() {
    map = L.map('map', {
        center: [31.8206, 117.2272],
        zoom: 10,
        minZoom: 2,
        maxZoom: 18,
        zoomControl: false,
        maxBoundsViscosity: 0.8,
        preferCanvas: true,
        zoomAnimation: true,
        fadeAnimation: true,
        markerZoomAnimation: false
    });

    L.control.zoom({
        zoomInTitle: '放大',
        zoomOutTitle: '缩小'
    }).addTo(map);

    ensureLayerPanes();
    populationPointRenderer = L.canvas({ padding: 0.5 });

    const commonTileLayerOptions = {
        subdomains: ['1', '2', '3', '4'],
        attribution: '&copy; 高德地图',
        maxZoom: 18,
        keepBuffer: 2,
        updateWhenIdle: true,
        updateWhenZooming: false,
        detectRetina: false
    };

    const amapStreetLayer = L.tileLayer(
        'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}',
        commonTileLayerOptions
    );

    const amapSatelliteLayer = L.tileLayer(
        'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=6&x={x}&y={y}&z={z}',
        commonTileLayerOptions
    );

    const amapLabelLayer = L.tileLayer(
        'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=8&x={x}&y={y}&z={z}',
        commonTileLayerOptions
    );

    const baseLayers = {
        '街道地图': amapStreetLayer,
        '卫星影像': amapSatelliteLayer,
        '混合地图': L.layerGroup([amapSatelliteLayer, amapLabelLayer])
    };

    baseLayers['街道地图'].addTo(map);
    observeMapContainerResize();

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // 汉化 Leaflet Draw 工具栏
    L.drawLocal.draw.toolbar.actions.title = '取消绘制';
    L.drawLocal.draw.toolbar.actions.text = '取消';
    L.drawLocal.draw.toolbar.finish.title = '完成绘制';
    L.drawLocal.draw.toolbar.finish.text = '完成';
    L.drawLocal.draw.toolbar.undo.title = '撤销上一个点';
    L.drawLocal.draw.toolbar.undo.text = '撤销';
    L.drawLocal.draw.toolbar.buttons.polyline = '画线段';
    L.drawLocal.draw.toolbar.buttons.polygon = '画多边形';
    L.drawLocal.draw.toolbar.buttons.rectangle = '画矩形';
    L.drawLocal.draw.toolbar.buttons.circle = '画圆形';
    L.drawLocal.draw.toolbar.buttons.circlemarker = '画圆点标记';
    L.drawLocal.draw.toolbar.buttons.marker = '放置标记';
    L.drawLocal.draw.handlers.polyline.tooltip.start = '点击开始画线';
    L.drawLocal.draw.handlers.polyline.tooltip.cont = '点击继续画线';
    L.drawLocal.draw.handlers.polyline.tooltip.end = '点击最后一个点完成';
    L.drawLocal.draw.handlers.polygon.tooltip.start = '点击开始画多边形';
    L.drawLocal.draw.handlers.polygon.tooltip.cont = '点击继续画多边形';
    L.drawLocal.draw.handlers.polygon.tooltip.end = '点击第一个点闭合多边形';
    L.drawLocal.draw.handlers.rectangle.tooltip.start = '按住拖动画矩形';
    L.drawLocal.draw.handlers.circle.tooltip.start = '按住拖动画圆形';
    L.drawLocal.draw.handlers.circlemarker = L.drawLocal.draw.handlers.circlemarker || {};
    L.drawLocal.draw.handlers.circlemarker.tooltip = L.drawLocal.draw.handlers.circlemarker.tooltip || {};
    L.drawLocal.draw.handlers.circlemarker.tooltip.start = '点击地图放置圆点标记';
    L.drawLocal.draw.handlers.marker.tooltip.start = '点击地图放置标记';
    L.drawLocal.draw.handlers.simpleshape = L.drawLocal.draw.handlers.simpleshape || {};
    L.drawLocal.draw.handlers.simpleshape.tooltip = L.drawLocal.draw.handlers.simpleshape.tooltip || {};
    L.drawLocal.draw.handlers.simpleshape.tooltip.end = '松开鼠标完成';
    L.drawLocal.edit.toolbar.actions.save.title = '保存修改';
    L.drawLocal.edit.toolbar.actions.save.text = '保存';
    L.drawLocal.edit.toolbar.actions.cancel.title = '取消编辑';
    L.drawLocal.edit.toolbar.actions.cancel.text = '取消';
    L.drawLocal.edit.toolbar.actions.clearAll = L.drawLocal.edit.toolbar.actions.clearAll || {};
    L.drawLocal.edit.toolbar.actions.clearAll.title = '清除全部';
    L.drawLocal.edit.toolbar.actions.clearAll.text = '全部清除';
    L.drawLocal.edit.toolbar.buttons.edit = '编辑图层';
    L.drawLocal.edit.toolbar.buttons.editDisabled = '没有可编辑的图层';
    L.drawLocal.edit.toolbar.buttons.remove = '删除图层';
    L.drawLocal.edit.toolbar.buttons.removeDisabled = '没有可删除的图层';
    L.drawLocal.edit.handlers.edit.tooltip.text = '拖动节点编辑图形';
    L.drawLocal.edit.handlers.edit.tooltip.subtext = '点击取消撤销修改';
    L.drawLocal.edit.handlers.remove.tooltip.text = '点击要删除的图形';

    const drawControl = new L.Control.Draw({
        position: 'topleft',
        draw: {
            polyline: {
                shapeOptions: {
                    color: '#3498db',
                    weight: 4
                }
            },
            polygon: {
                allowIntersection: false,
                drawError: {
                    color: '#e74c3c',
                    message: '<strong>错误</strong> 不能绘制相交多边形!'
                },
                shapeOptions: {
                    color: '#2ecc71'
                }
            },
            circle: {
                shapeOptions: {
                    color: '#f39c12'
                }
            },
            rectangle: {
                shapeOptions: {
                    color: '#9b59b6'
                }
            },
            marker: true
        },
        edit: {
            featureGroup: drawnItems,
            edit: false,
            remove: true
        }
    });

    map.addControl(drawControl);

    L.control.scale({
        imperial: false,
        position: 'bottomleft'
    }).addTo(map);

    // ---------- 土地利用图例 ----------
    const landuseLegendCtrl = L.control({ position: 'bottomright' });
    landuseLegendCtrl.onAdd = function () {
        const div = L.DomUtil.create('div', 'landuse-legend');
        const items = [
            { color: '#ffa500', label: '居住用地' },
            { color: '#e00000', label: '商业用地' },
            { color: '#808080', label: '工业用地' },
            { color: '#ff80ff', label: '零售用地' },
            { color: '#66cc00', label: '农业用地' },
            { color: '#408000', label: '林地' },
            { color: '#80ff00', label: '休闲绿地' },
            { color: '#c08000', label: '建设用地' }
        ];
        div.innerHTML = '<strong>土地利用图例</strong>' +
            items.map(function (it) {
                return '<div class="landuse-legend-item">' +
                    '<span class="landuse-legend-swatch" style="background:' + it.color + '"></span>' +
                    it.label + '</div>';
            }).join('');
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    window._landuseLegendCtrl = landuseLegendCtrl;
    window._landuseLegendVisible = false;

    updateBaseLayerLabel('街道地图');

    map.on(L.Draw.Event.CREATED, onDrawCreated);
    map.on(L.Draw.Event.EDITED, onDrawEdited);
    map.on(L.Draw.Event.DELETED, onDrawDeleted);
    map.on('moveend', refreshDynamicLayerViews);
    map.on('zoomend', function() {
        refreshDynamicLayerViews();
        refreshHeatmapStyleForCurrentZoom();
    });
    // zoomend 不再自动重建热力图，L.heatLayer 内置缩放自适应

    map.on('draw:drawstart', function() {
        updateInfoPanel('正在绘制...');
    });

    const hefeiBounds = L.latLngBounds(
        [31.25, 116.55],
        [32.20, 117.95]
    );

    map.setMaxBounds(hefeiBounds);
    map.fitBounds(hefeiBounds);
    scheduleMapLayoutRefresh([0, 220, 720]);

    // 修复平板设备首次加载时地图不渲染的问题
    scheduleMapLayoutRefresh([1000, 2000, 3000]);
    window.addEventListener('load', function() {
        scheduleMapLayoutRefresh([0, 300, 800, 1500]);
    }, { once: true });
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            scheduleMapLayoutRefresh([0, 200]);
        }
    });
}

/**
 * 热力图初始化事件
 */
function initHeatmapControls() {
    const radiusSlider = document.getElementById('heatRadius');
    const blurSlider = document.getElementById('heatBlur');
    const opacitySlider = document.getElementById('heatMinOpacity');

    if (radiusSlider) {
        radiusSlider.addEventListener('input', function() {
            document.getElementById('heatRadiusValue').textContent = this.value;
        });
    }

    if (blurSlider) {
        blurSlider.addEventListener('input', function() {
            document.getElementById('heatBlurValue').textContent = this.value;
        });
    }

    if (opacitySlider) {
        opacitySlider.addEventListener('input', function() {
            document.getElementById('heatMinOpacityValue').textContent = this.value;
        });
    }

    const rebuildBtn = document.getElementById('rebuildHeatmap');
    if (rebuildBtn) {
        rebuildBtn.addEventListener('click', function() {
            rebuildHeatmap();
        });
    }

    const clearHeatmapBtn = document.getElementById('clearHeatmapBtn');
    if (clearHeatmapBtn) {
        clearHeatmapBtn.addEventListener('click', function() {
            clearHeatmap();
        });
    }
}

function setHeatImportMode(mode) {
    if (mode !== 'replace' && mode !== 'append') return;

    heatImportMode = mode;
    const modeText = mode === 'replace' ? '覆盖模式' : '累积模式';
    updateInfoPanel(`热力图导入模式已切换为：${modeText}`);
}

/**
 * 根据当前热力点重建热力图
 */
function rebuildHeatmap() {
    const allHeatPoints = getAllHeatPoints();

    if (!allHeatPoints || allHeatPoints.length === 0) {
        if (heatLayer && map.hasLayer(heatLayer)) {
            map.removeLayer(heatLayer);
        }
        heatLayer = null;
        removeHeatmapPeakMarker();
        updateHeatmapInfo('暂无点数据，无法生成热力图');
        updateDashboardStats();
        return;
    }

    const radiusEl = document.getElementById('heatRadius');
    const blurEl = document.getElementById('heatBlur');
    const opacityEl = document.getElementById('heatMinOpacity');
    const radius = radiusEl ? parseInt(radiusEl.value, 10) : 25;
    const blur = blurEl ? parseInt(blurEl.value, 10) : 18;
    const minOpacity = opacityEl ? parseFloat(opacityEl.value) : 0.35;
    const peakPoint = getHeatmapPeakPoint(allHeatPoints);
    const styleProfile = getCurrentHeatmapStyleProfile();

    if (heatLayer && map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
    }

    heatLayer = L.heatLayer(allHeatPoints, {
        radius: radius,
        blur: blur,
        minOpacity: minOpacity,
        maxZoom: 18,
        gradient: styleProfile.gradient
    });

    updateHeatmapPeakMarker(peakPoint, styleProfile);

    if (heatmapVisible) {
        heatLayer.addTo(map);
    }

    updateHeatmapInfo(`
        <div class="info-row"><span class="info-label">热力点数量:</span><span>${allHeatPoints.length}</span></div>
        <div class="info-row"><span class="info-label">导入点:</span><span>${importedHeatPoints.length}</span></div>
        <div class="info-row"><span class="info-label">手动画点:</span><span>${manualHeatPoints.length}</span></div>
        <div class="info-row"><span class="info-label">模式:</span><span>${heatImportMode === 'replace' ? '覆盖模式' : '累积模式'}</span></div>
        <div class="info-row"><span class="info-label">色带方案:</span><span>${styleProfile.name}</span></div>
        <div class="info-row"><span class="info-label">颜色重点:</span><span>${styleProfile.colorLabel}</span></div>
        <div class="info-row"><span class="info-label">半径:</span><span>${radius}</span></div>
        <div class="info-row"><span class="info-label">模糊:</span><span>${blur}</span></div>
        <div class="info-row"><span class="info-label">最小透明度:</span><span>${minOpacity}</span></div>
        <div class="info-row"><span class="info-label">峰值强度:</span><span>${formatPopulationDisplayNumber(Number(peakPoint && peakPoint[2]) || 1)}</span></div>
    `);

    updateDashboardStats();
    updateInfoPanel(`热力图已生成，共 ${allHeatPoints.length} 个点`);
}

function toggleHeatmap() {
    if (!heatLayer) {
        alert('当前没有热力图，请先导入KML点数据');
        return;
    }

    if (map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
        if (heatmapPeakMarker && map.hasLayer(heatmapPeakMarker)) {
            map.removeLayer(heatmapPeakMarker);
        }
        heatmapVisible = false;
        updateDashboardStats();
        updateInfoPanel('热力图已隐藏');
    } else {
        heatLayer.addTo(map);
        if (heatmapPeakMarker) {
            heatmapPeakMarker.addTo(map);
        }
        heatmapVisible = true;
        updateDashboardStats();
        updateInfoPanel('热力图已显示');
    }
}

function clearHeatmap() {
    cancelScheduledHeatmapRebuild();
    removeHeatmapPeakMarker();

    getAllLayerEntries().forEach(entry => {
        entry.heatIncluded = false;
    });

    importedHeatPoints = [];
    manualHeatPoints = [];

    if (heatLayer && map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
    }

    heatLayer = null;
    updateHeatmapInfo('暂无热力图数据');
    updateDashboardStats();
    updateInfoPanel('热力图已清空（已取消所有图层的热力参与）');
}

function updateHeatmapInfo(html) {
    const el = document.getElementById('heatmapInfo');
    if (!el) return;
    const normalized = typeof html === 'string' && html.trim().startsWith('<')
        ? html
        : `<div class="empty-state">${html}</div>`;
    el.innerHTML = normalized;
    updateDashboardStats();
}

function extractHeatPointsFromGeoJSON(geoJSON) {
    const points = [];

    if (!geoJSON || !geoJSON.features) return points;

    geoJSON.features.forEach(feature => {
        if (!feature.geometry) return;

        const geom = feature.geometry;
        const coords = geom.coordinates;

        if (geom.type === 'Point') {
            points.push([coords[1], coords[0], 1]);
        } else if (geom.type === 'MultiPoint') {
            coords.forEach(pt => {
                points.push([pt[1], pt[0], 1]);
            });
        }
    });

    return points;
}

function onDrawCreated(event) {
    const layer = event.layer;
    const type = event.layerType;
    const id = `layer_${layerIdCounter++}`;

    drawnItems.addLayer(layer);

    let name = getLayerTypeName(type) + layerIdCounter;

    if (type === 'marker') {
        const markerName = prompt('请输入标记名称:', name);
        const markerDescription = prompt('请输入标记描述(可选):', '');

        if (markerName) {
            name = markerName;
            highlightMarker(layer);

            if (markerDescription) {
                layer.bindPopup(`<div class="custom-popup"><strong>${markerName}</strong><p>${markerDescription}</p></div>`);
            }
        }

        const latLng = layer.getLatLng();
        layer._heatPoint = [latLng.lat, latLng.lng, 1];
    }

    layers[id] = {
        id: id,
        layer: layer,
        type: type,
        name: name,
        created: new Date().toLocaleString(),
        visible: true,
        heatIncluded: true,
        sourceKind: 'drawn'
    };

    layer.on('click', function(e) {
        showLayerInfo(id);
        L.DomEvent.stopPropagation(e);
    });

    updateLayersList();
    showMeasurementInfo(layer, type);
    rebuildHeatmap();
    updateInfoPanel(`已创建 ${name}`);
}

function highlightMarker(marker) {
    const icon = marker.getIcon();
    const defaultIcon = icon || new L.Icon.Default();

    const pulseIcon = L.divIcon({
        html: '<div class="marker-pulse"></div><div class="marker-icon"></div>',
        className: 'custom-marker-icon',
        iconSize: [30, 30],
        iconAnchor: [15, 30]
    });

    marker.setIcon(pulseIcon);

    setTimeout(function() {
        marker.setIcon(defaultIcon);
    }, 5000);
}

function onDrawEdited(event) {
    const editedLayers = event.layers;
    let heatNeedRebuild = false;

    editedLayers.eachLayer(function(layer) {
        const id = Object.keys(layers).find(key => layers[key].layer === layer);
        if (id) {
            const entry = layers[id];
            showMeasurementInfo(layer, entry.type);

            if (entry.type === 'marker' && layer.getLatLng) {
                const latLng = layer.getLatLng();
                layer._heatPoint = [latLng.lat, latLng.lng, 1];
                heatNeedRebuild = true;
            }
        }
    });

    if (heatNeedRebuild) {
        rebuildHeatmap();
    }

    updateInfoPanel('图层已编辑');
}

function onDrawDeleted(event) {
    const deletedLayers = event.layers;

    deletedLayers.eachLayer(function(layer) {
        const id = Object.keys(layers).find(key => layers[key].layer === layer);
        if (id) {
            delete layers[id];
        }
    });

    rebuildHeatmap();
    updateLayersList();
    updateInfoPanel('图层已删除');
}

function getLayerTypeName(type) {
    const typeNames = {
        marker: '标记点',
        circle: '圆形',
        polygon: '多边形',
        polyline: '线段',
        rectangle: '矩形',
        kmlgroup: 'KML图层',
        populationgroup: '人口点图层'
    };
    return typeNames[type] || type;
}

function showMeasurementInfo(layer, type) {
    let measurementText = '';

    if (type === 'marker') {
        const latLng = layer.getLatLng();
        measurementText = `
            <div class="info-row"><span class="info-label">纬度:</span><span>${latLng.lat.toFixed(6)}</span></div>
            <div class="info-row"><span class="info-label">经度:</span><span>${latLng.lng.toFixed(6)}</span></div>
        `;
    } else if (type === 'circle') {
        const latLng = layer.getLatLng();
        const radius = layer.getRadius();
        const area = Math.PI * radius * radius;

        measurementText = `
            <div class="info-row"><span class="info-label">中心点:</span><span>${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}</span></div>
            <div class="info-row"><span class="info-label">半径:</span><span>${radius.toFixed(2)} 米</span></div>
            <div class="info-row"><span class="info-label">面积:</span><span>${formatArea(area)}</span></div>
        `;
    } else if (type === 'polygon' || type === 'rectangle') {
        const latlngs = layer.getLatLngs()[0];
        const area = L.GeometryUtil.geodesicArea(latlngs);
        const perimeter = calculatePerimeter(latlngs);

        measurementText = `
            <div class="info-row"><span class="info-label">周长:</span><span>${formatLength(perimeter)}</span></div>
            <div class="info-row"><span class="info-label">面积:</span><span>${formatArea(area)}</span></div>
        `;
    } else if (type === 'polyline') {
        const latlngs = layer.getLatLngs();
        const length = calculatePolylineLength(latlngs);

        measurementText = `
            <div class="info-row"><span class="info-label">长度:</span><span>${formatLength(length)}</span></div>
        `;
    }

    const measureEl = document.getElementById('measurementResults');
    if (measureEl) measureEl.innerHTML = measurementText;
}

function calculatePerimeter(latlngs) {
    let perimeter = 0;
    for (let i = 0; i < latlngs.length; i++) {
        const j = (i + 1) % latlngs.length;
        perimeter += latlngs[i].distanceTo(latlngs[j]);
    }
    return perimeter;
}

function calculatePolylineLength(latlngs) {
    let length = 0;
    for (let i = 0; i < latlngs.length - 1; i++) {
        length += latlngs[i].distanceTo(latlngs[i + 1]);
    }
    return length;
}

function formatLength(length) {
    if (length >= 1000) {
        return (length / 1000).toFixed(2) + ' 公里';
    }
    return length.toFixed(2) + ' 米';
}

function formatArea(area) {
    if (area >= 1000000) {
        return (area / 1000000).toFixed(2) + ' 平方公里';
    }
    if (area >= 10000) {
        return (area / 10000).toFixed(2) + ' 公顷';
    }
    return area.toFixed(2) + ' 平方米';
}

function updateLayersList() {
    const layersListElement = document.getElementById('layersList');
    layersListElement.innerHTML = '';

    const allEntries = getAllLayerEntries();
    const query = layerSearchTerm;

    if (allEntries.length === 0) {
        layersListElement.innerHTML = '<div class="empty-state">当前还没有图层。可以先导入 KML，或直接在地图上开始标绘。</div>';
        updateDashboardStats();
        return;
    }

    const sections = [
        {
            key: 'populationDensity',
            title: '人口数据',
            icon: 'fas fa-chart-area',
            items: allEntries.filter(entry => entry.sourceKind === 'populationDensity')
        },
        {
            key: 'roadNetwork',
            title: '路网图层',
            icon: 'fas fa-road',
            items: allEntries.filter(entry => entry.sourceKind === 'roadNetwork')
        },
        {
            key: 'builtinKml',
            title: '土地利用规划图层',
            icon: 'fas fa-map',
            items: allEntries.filter(entry => entry.sourceKind === 'builtinKml')
        },
        {
            key: 'importedKml',
            title: '外部导入图层',
            icon: 'fas fa-file-import',
            items: allEntries.filter(entry => entry.sourceKind === 'importedKml')
        },
        {
            key: 'drawn',
            title: '手工绘制图层',
            icon: 'fas fa-pen-ruler',
            items: allEntries.filter(entry => entry.sourceKind === 'drawn')
        },
        {
            key: 'zhanji',
            title: '詹记',
            icon: 'fas fa-store',
            items: allEntries.filter(entry => entry.sourceKind === 'zhanji')
        }
    ];

    let renderedSections = 0;

    sections.forEach(section => {
        const filteredItems = section.items
            .filter(entry => !query || entry.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

        if (filteredItems.length === 0) return;
        renderedSections += 1;

        const sectionNode = document.createElement('details');
        sectionNode.className = 'tree-section';
        sectionNode.open = true;

        const summary = document.createElement('summary');
        summary.className = 'tree-summary';
        summary.innerHTML = `
            <span><i class="${section.icon}"></i> ${section.title}</span>
            <span class="tree-count">${filteredItems.length}</span>
        `;
        sectionNode.appendChild(summary);

        const tools = document.createElement('div');
        tools.className = 'tree-section-tools';
        const showAllBtn = document.createElement('button');
        showAllBtn.className = 'tree-tool-btn';
        showAllBtn.innerHTML = '<i class="fas fa-eye"></i> 开';
        showAllBtn.onclick = function() {
            setSectionVisibility(section.key, true);
        };
        const hideAllBtn = document.createElement('button');
        hideAllBtn.className = 'tree-tool-btn';
        hideAllBtn.innerHTML = '<i class="fas fa-eye-slash"></i> 关';
        hideAllBtn.onclick = function() {
            setSectionVisibility(section.key, false);
        };
        tools.appendChild(showAllBtn);
        tools.appendChild(hideAllBtn);
        sectionNode.appendChild(tools);

        const content = document.createElement('div');
        content.className = 'tree-section-content';
        filteredItems.forEach(layerEntry => {
            content.appendChild(createTreeLayerNode(layerEntry));
        });

        sectionNode.appendChild(content);
        layersListElement.appendChild(sectionNode);
    });

    if (renderedSections === 0) {
        layersListElement.innerHTML = '<div class="empty-state">没有匹配到图层，请尝试更换关键词。</div>';
    }

    updateDashboardStats();
}

function createTreeLayerNode(layerEntry) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    if (layerEntry.sourceKind === 'populationDensity') {
        node.classList.add('tree-node-density');
    }
    if (layerEntry.sourceKind === 'zhanji') {
        node.classList.add('tree-node-zhanji');
    }
    if (layerEntry.sourceKind === 'builtinKml') {
        node.classList.add('tree-node-builtin');
    }

    const topRow = document.createElement('div');
    topRow.className = 'tree-node-row';

    const left = document.createElement('label');
    left.className = 'tree-node-main';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layerEntry.visible !== false;
    checkbox.addEventListener('change', function(e) {
        setLayerVisibility(layerEntry.id, e.target.checked);
    });

    const icon = document.createElement('i');
    icon.className = getLayerIcon(layerEntry);

    const nameWrapper = document.createElement('span');
    nameWrapper.className = 'tree-node-name-wrap';

    const name = document.createElement('span');
    name.className = 'tree-node-name';
    name.textContent = layerEntry.name;

    nameWrapper.appendChild(name);

    const metaText = getLayerMetaText(layerEntry);
    if (metaText) {
        const meta = document.createElement('span');
        meta.className = 'tree-node-meta';
        meta.textContent = metaText;
        nameWrapper.appendChild(meta);
    }

    left.appendChild(checkbox);
    left.appendChild(icon);
    left.appendChild(nameWrapper);

    const controls = document.createElement('div');
    controls.className = 'layer-controls';

    const zoomBtn = document.createElement('button');
    zoomBtn.innerHTML = '<i class="fas fa-search-plus"></i>';
    zoomBtn.title = '缩放至图层';
    zoomBtn.onclick = function(e) {
        e.stopPropagation();
        zoomToLayer(layerEntry.id);
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
    deleteBtn.title = '删除图层';
    deleteBtn.onclick = function(e) {
        e.stopPropagation();
        deleteLayer(layerEntry.id);
    };

    controls.appendChild(zoomBtn);
    controls.appendChild(deleteBtn);

    topRow.appendChild(left);
    topRow.appendChild(controls);
    node.appendChild(topRow);

    const children = buildTreeChildren(layerEntry);
    if (children) {
        node.appendChild(children);
    }

    node.addEventListener('click', function(e) {
        if (e.target.closest('button') || e.target.matches('input')) return;
        showLayerInfo(layerEntry.id);
    });

    return node;
}

function buildTreeChildren(layerEntry) {
    return null;
}

function getLayerMetaText(layerEntry) {
    return '';
}

function getLayerIcon(layerEntry) {
    const typeIcons = {
        marker: 'fas fa-map-marker-alt',
        circle: 'far fa-circle',
        polygon: 'fas fa-draw-polygon',
        polyline: 'fas fa-route',
        rectangle: 'far fa-square'
    };

    const sourceIcons = {
        populationDensity: 'fas fa-chart-area',
        zhanji: 'fas fa-store',
        builtinKml: 'fas fa-map',
        importedKml: 'fas fa-file-import',
        drawn: 'fas fa-pen-ruler'
    };

    if (layerEntry.type === 'kmlgroup') {
        return sourceIcons[layerEntry.sourceKind] || 'fas fa-layer-group';
    }

    return typeIcons[layerEntry.type] || 'fas fa-layer-group';
}

function showLayerInfo(id) {
    const layerEntry = layers[id];
    if (!layerEntry) return;

    const featureCount = typeof layerEntry.featureCount === 'number'
        ? layerEntry.featureCount
        : (layerEntry.subLayers ? layerEntry.subLayers.length : null);

    let infoHtml = `
        <div class="info-row"><span class="info-label">名称:</span><span>${layerEntry.name}</span></div>
        <div class="info-row"><span class="info-label">类型:</span><span>${getLayerTypeName(layerEntry.type)}</span></div>
        <div class="info-row"><span class="info-label">来源:</span><span>${getSourceKindName(layerEntry.sourceKind)}</span></div>
        <div class="info-row"><span class="info-label">显示状态:</span><span>${layerEntry.visible === false ? '隐藏' : '显示'}</span></div>
        <div class="info-row"><span class="info-label">热力参与:</span><span>${layerEntry.heatIncluded === false ? '否' : '是'}</span></div>
        <div class="info-row"><span class="info-label">创建时间:</span><span>${layerEntry.created}</span></div>
    `;

    if (featureCount !== null) {
        infoHtml += `<div class="info-row"><span class="info-label">包含要素:</span><span>${featureCount} 个</span></div>`;
    }

    if (layerEntry.coordinateSystem) {
        infoHtml += `<div class="info-row"><span class="info-label">显示坐标系:</span><span>${layerEntry.coordinateSystem}</span></div>`;
    }

    if (layerEntry.timeWindowLabel) {
        infoHtml += `<div class="info-row"><span class="info-label">当前时段:</span><span>${layerEntry.timeWindowLabel}</span></div>`;
    }

    if (layerEntry.dataSource) {
        infoHtml += `<div class="info-row"><span class="info-label">数据来源:</span><span>${layerEntry.dataSource}</span></div>`;
    }

    if (layerEntry.weightStrategy) {
        infoHtml += `<div class="info-row"><span class="info-label">权重策略:</span><span>${layerEntry.weightStrategy}</span></div>`;
    }

    if (layerEntry.weightSummary) {
        infoHtml += `
            <div class="info-row"><span class="info-label">总权重:</span><span>${layerEntry.weightSummary.total}</span></div>
            <div class="info-row"><span class="info-label">最大权重:</span><span>${layerEntry.weightSummary.max}</span></div>
            <div class="info-row"><span class="info-label">最小权重:</span><span>${layerEntry.weightSummary.min}</span></div>
        `;
    }

    if (layerEntry.type === 'populationgroup') {
        infoHtml += `<div class="info-row"><span class="info-label">当前视窗渲染:</span><span>${formatPopulationDisplayNumber(layerEntry.renderedPointCount || 0)} 个</span></div>`;
    }

    if (layerEntry.type === 'kmlgroup' && layerEntry.subLayers) {
        if (layerEntry.heatPoints) {
            infoHtml += `<div class="info-row"><span class="info-label">热力点数量:</span><span>${layerEntry.heatPoints.length}</span></div>`;
        }
    } else if (layerEntry.type === 'populationgroup' && layerEntry.heatPoints) {
        infoHtml += `<div class="info-row"><span class="info-label">热力点数量:</span><span>${layerEntry.heatPoints.length}</span></div>`;
    }

    // 检查infoPanel元素是否存在
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) {
        infoPanel.innerHTML = infoHtml;
    }

    if (layerEntry.type === 'kmlgroup' || layerEntry.type === 'populationgroup') {
        const bounds = getLayerBounds(layerEntry);
        if (bounds && bounds.isValid()) {
            const northEast = bounds.getNorthEast();
            const southWest = bounds.getSouthWest();

            // 检查measurementResults元素是否存在
            const measureEl = document.getElementById('measurementResults');
            if (measureEl) measureEl.innerHTML = `
                <div class="info-row"><span class="info-label">东北角:</span><span>${northEast.lat.toFixed(6)}, ${northEast.lng.toFixed(6)}</span></div>
                <div class="info-row"><span class="info-label">西南角:</span><span>${southWest.lat.toFixed(6)}, ${southWest.lng.toFixed(6)}</span></div>
            `;
        }
    } else {
        showMeasurementInfo(layerEntry.layer, layerEntry.type);
    }
}

function setLayerVisibility(id, visible) {
    const layerEntry = layers[id];
    if (!layerEntry) return;

    // 懒加载 KML：首次开启时拉取数据
    if (visible && layerEntry._lazyKml && !layerEntry._lazyLoaded) {
        layerEntry.visible = false; // 暂时保持隐藏
        updateInfoPanel(`正在加载 ${layerEntry.name}...`);
        ensureKmlLayerLoaded(layerEntry).then(function(ok) {
            if (ok) {
                layerEntry.visible = true;
                addLayerEntryToMap(layerEntry);
                updateLayersList();
                rebuildHeatmap();
                updateInfoPanel(`${layerEntry.name} 已显示`);
                _syncLanduseLegend(layerEntry, true);
            } else {
                updateLayersList();
            }
        });
        return;
    }

    // 懒加载路网 GeoJSON：首次开启时拉取数据
    if (visible && layerEntry._lazyRoadNetwork && !layerEntry._lazyLoaded) {
        layerEntry.visible = false;
        updateInfoPanel('正在加载路网...');
        ensureRoadNetworkLoaded(layerEntry).then(function(ok) {
            if (ok) {
                layerEntry.visible = true;
                addLayerEntryToMap(layerEntry);
                updateLayersList();
                updateInfoPanel('路网已显示');
            } else {
                updateLayersList();
            }
        });
        return;
    }

    layerEntry.visible = visible;

    if (visible) {
        addLayerEntryToMap(layerEntry);
    } else {
        removeLayerEntryFromMap(layerEntry);
    }

    updateLayersList();
    rebuildHeatmap();
    updateInfoPanel(`${layerEntry.name} 已${visible ? '显示' : '隐藏'}`);
    _syncLanduseLegend(layerEntry, visible);
}

function _syncLanduseLegend(layerEntry, visible) {
    if (layerEntry.name === '土地利用规划' || layerEntry.name === '合肥市土地利用规划') {
        if (visible && !window._landuseLegendVisible) {
            window._landuseLegendCtrl.addTo(map);
            window._landuseLegendVisible = true;
        } else if (!visible && window._landuseLegendVisible) {
            window._landuseLegendCtrl.remove();
            window._landuseLegendVisible = false;
        }
    }
}

function toggleLayerVisibility(id) {
    const layerEntry = layers[id];
    if (!layerEntry) return;
    setLayerVisibility(id, layerEntry.visible === false);
}

function zoomToLayer(id) {
    const layerEntry = layers[id];
    if (!layerEntry) return;

    if (layerEntry.type === 'marker') {
        map.setView(layerEntry.layer.getLatLng(), 17);
        return;
    }

    const bounds = getLayerBounds(layerEntry);
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20] });
    }
}

function deleteLayer(id) {
    const layerEntry = layers[id];
    if (!layerEntry) return;

    removeLayerEntryFromMap(layerEntry);
    if (typeof layerEntry.destroy === 'function') {
        layerEntry.destroy();
    }
    delete layers[id];

    rebuildHeatmap();
    updateLayersList();
    updateInfoPanel(`图层已删除：${layerEntry.name}`);
}

function updateInfoPanel(message) {
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) {
        infoPanel.innerHTML = `<div class="message-card"><i class="fas fa-wand-magic-sparkles"></i><div>${message}</div></div>`;
    }

    let tone = 'info';
    if (message.includes('失败') || message.includes('错误')) tone = 'warning';
    else if (message.includes('正在')) tone = 'loading';
    else if (message.includes('已') || message.includes('完成')) tone = 'success';

    setSystemStatus(message, tone);
}

function exportKML() {
    if (Object.keys(layers).length === 0) {
        alert('没有可导出的图层');
        return;
    }

    const geoJSON = drawnItems.toGeoJSON();
    const kml = tokml(geoJSON);

    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `服务业选址分析_${new Date().toISOString().slice(0, 10)}.kml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    updateInfoPanel('KML文件已导出');
}

function importKML() {
    const fileInput = document.getElementById('kmlFileInput');
    fileInput.click();
}

function handleKMLFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const localIcons = getFallbackLocalIcons();

    if (file.name.toLowerCase().endsWith('.kmz')) {
        handleKMZFile(file);
    } else {
        const reader = new FileReader();
        reader.onload = function(e) {
            processKMLContent(e.target.result, localIcons, {
                sourceName: decodeUnicodeFilename(file.name).replace(/\.kml$/i, ''),
                sourceKind: 'importedKml'
            });
        };
        reader.onerror = function(e) {
            console.error('读取文件出错:', e);
            alert('读取文件出错');
        };
        reader.readAsText(file);
    }

    event.target.value = null;
}

function handleKMZFile(file) {
    if (typeof JSZip === 'undefined') {
        alert('缺少JSZip库，无法处理KMZ文件。请转换为KML后再导入。');
        return;
    }

    updateInfoPanel('正在处理KMZ文件...');

    const reader = new FileReader();
    reader.onload = function(e) {
        JSZip.loadAsync(e.target.result)
            .then(function(zip) {
                let kmlFile = null;

                zip.forEach(function(relativePath, zipEntry) {
                    if (relativePath.toLowerCase().endsWith('.kml')) {
                        kmlFile = zipEntry;
                    }
                });

                if (!kmlFile) throw new Error('KMZ文件中未找到KML文件');

                const resourcePromises = [];
                const resources = {};
                const resourceMap = {};

                zip.forEach(function(relativePath, zipEntry) {
                    if (zipEntry.dir || relativePath.toLowerCase().endsWith('.kml')) return;

                    resourceMap[relativePath.toLowerCase()] = relativePath;

                    if (
                        relativePath.toLowerCase().endsWith('.png') ||
                        relativePath.toLowerCase().endsWith('.jpg') ||
                        relativePath.toLowerCase().endsWith('.jpeg') ||
                        relativePath.toLowerCase().endsWith('.gif') ||
                        relativePath.toLowerCase().endsWith('.svg') ||
                        relativePath.toLowerCase().endsWith('.bmp') ||
                        relativePath.toLowerCase().endsWith('.ico')
                    ) {
                        const promise = zipEntry.async('blob').then(function(blob) {
                            const url = URL.createObjectURL(blob);
                            resources[relativePath] = url;
                            const fileName = relativePath.split('/').pop();
                            resources[fileName] = url;
                            return { path: relativePath, url: url, fileName: fileName };
                        });
                        resourcePromises.push(promise);
                    }
                });

                return Promise.all(resourcePromises).then(function() {
                    return kmlFile.async('text').then(function(kmlContent) {
                        let modifiedKML = kmlContent;
                        const hrefRegex = /<href>(.*?)<\/href>/g;
                        const hrefs = new Set();
                        let match;

                        while ((match = hrefRegex.exec(kmlContent)) !== null) {
                            if (match[1] && match[1].trim()) {
                                hrefs.add(match[1].trim());
                            }
                        }

                        hrefs.forEach(href => {
                            const origHref = href;
                            const fileName = href.split('/').pop();
                            const fileNameLower = fileName.toLowerCase();

                            if (resources[href]) {
                                modifiedKML = modifiedKML.replace(new RegExp(escapeRegExp(origHref), 'g'), resources[href]);
                            } else if (resources[fileName]) {
                                modifiedKML = modifiedKML.replace(new RegExp(escapeRegExp(origHref), 'g'), resources[fileName]);
                            } else {
                                for (const key in resourceMap) {
                                    if (key.endsWith('/' + fileNameLower) || key === fileNameLower) {
                                        const fullPath = resourceMap[key];
                                        if (resources[fullPath]) {
                                            modifiedKML = modifiedKML.replace(new RegExp(escapeRegExp(origHref), 'g'), resources[fullPath]);
                                            break;
                                        }
                                    }
                                }
                            }
                        });

                        return { kmlContent: modifiedKML, resources: resources };
                    });
                });
            })
            .then(function(result) {
                const combinedResources = { ...getFallbackLocalIcons(), ...result.resources };
                processKMLContent(result.kmlContent, combinedResources, {
                    sourceName: decodeUnicodeFilename(file.name).replace(/\.kmz$/i, ''),
                    sourceKind: 'importedKml'
                });
            })
            .catch(function(error) {
                console.error('处理KMZ文件出错:', error);
                alert('处理KMZ文件出错: ' + error.message);
            });
    };

    reader.onerror = function(e) {
        console.error('读取KMZ文件出错:', e);
        alert('读取KMZ文件出错');
    };

    reader.readAsArrayBuffer(file);
}

function getFallbackLocalIcons() {
    return {
        'Layer0_Symbol_7e82c180_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
        'Layer0_Symbol_7e82c17f_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
        'Layer0_Symbol_7e82c17e_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
        'Layer0_Symbol_7e82c17d_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-violet.png',
        'Layer0_Symbol_7e82c17c_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
        'Layer0_Symbol_7e82c17b_0.png': 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-yellow.png'
    };
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function processKMLContent(kmlContent, resources = {}, options = {}) {
    const {
        sourceName = '导入的KML图层',
        sourceKind = 'importedKml',
        autoZoom = true,
        skipHeatmapRebuild = false,
        visible = true,
        heatIncluded = true
    } = options;

    try {
        const parser = new DOMParser();
        const kml = parser.parseFromString(kmlContent, 'text/xml');

        if (kml.documentElement.nodeName === 'parsererror') {
            throw new Error('XML解析错误：' + kml.documentElement.textContent);
        }

        let geoJSON;
        if (typeof togeojson === 'undefined') {
            if (typeof toGeoJSON !== 'undefined') {
                geoJSON = toGeoJSON.kml(kml);
            } else {
                throw new Error('没有可用的KML到GeoJSON转换库');
            }
        } else {
            geoJSON = togeojson.kml(kml);
        }

        if (!geoJSON || !geoJSON.features || geoJSON.features.length === 0) {
            throw new Error('转换后的GeoJSON没有特征');
        }

        const newImportedHeatPoints = extractHeatPointsFromGeoJSON(geoJSON);
        const styles = extractKMLStyles(kml, resources);

        let kmlTitle = sourceName || '导入的KML图层';
        const kmlName = kml.querySelector('Document > name');
        if (!sourceName && kmlName && kmlName.textContent) {
            kmlTitle = kmlName.textContent;
        }

        const layerPaneName = getLayerPaneName(sourceKind);
        const importedLayerGroup = new L.FeatureGroup();
        const importedLayersList = [];

        const geoJsonOptions = {
            style: function(feature) {
                if (feature.properties && feature.properties.style) {
                    return feature.properties.style;
                }

                if (feature.properties && feature.properties.styleUrl) {
                    let styleId = feature.properties.styleUrl.replace('#', '');

                    if (styles[styleId] && styles[styleId].pairs && styles[styleId].pairs.normal) {
                        styleId = styles[styleId].pairs.normal;
                    }

                    const style = styles[styleId];
                    if (style) {
                        if (!style._leafletStyle) {
                            style._leafletStyle = {
                                color: style.lineColor || '#3498db',
                                weight: style.lineWidth || 4,
                                opacity: style.lineOpacity || 0.8,
                                fillColor: style.polyColor || '#3498db',
                                fillOpacity: style.polyOpacity || 0.3
                            };

                            if (Object.prototype.hasOwnProperty.call(style, 'fill')) style._leafletStyle.fill = style.fill;
                            if (Object.prototype.hasOwnProperty.call(style, 'outline')) style._leafletStyle.stroke = style.outline;
                        }

                        return style._leafletStyle;
                    }
                }

                return {
                    color: '#3498db',
                    weight: 4,
                    opacity: 0.8,
                    fillColor: '#3498db',
                    fillOpacity: 0.3
                };
            },

            pointToLayer: function(feature, latlng) {
                if (feature.properties && feature.properties.icon) {
                    return L.marker(latlng, withLayerPane({
                        icon: L.icon({
                            iconUrl: feature.properties.icon,
                            iconSize: [10, 10],
                            iconAnchor: [5, 10],
                            popupAnchor: [0, -10]
                        })
                    }, layerPaneName));
                }

                if (feature.properties && feature.properties.styleUrl) {
                    let styleId = feature.properties.styleUrl.replace('#', '');

                    if (styles[styleId] && styles[styleId].pairs && styles[styleId].pairs.normal) {
                        styleId = styles[styleId].pairs.normal;
                    }

                    const style = styles[styleId];

                    if (style && style.iconUrl) {
                        let iconSize = [10, 10];
                        let iconAnchor = [5, 10];

                        if (style.iconScale) {
                            const scale = style.iconScale;
                            iconSize = [Math.round(10 * scale), Math.round(10 * scale)];
                            iconAnchor = [Math.round(iconSize[0] / 2), iconSize[1]];
                        }

                        if (style.iconHotSpot) {
                            if (style.iconHotSpot.xunits === 'pixels') {
                                iconAnchor[0] = style.iconHotSpot.x;
                            } else if (style.iconHotSpot.xunits === 'fraction') {
                                iconAnchor[0] = style.iconHotSpot.x * iconSize[0];
                            }

                            if (style.iconHotSpot.yunits === 'pixels') {
                                iconAnchor[1] = style.iconHotSpot.y;
                            } else if (style.iconHotSpot.yunits === 'fraction') {
                                iconAnchor[1] = style.iconHotSpot.y * iconSize[1];
                            }
                        }

                        let iconUrl = style.iconUrl;
                        if (!iconUrl.startsWith('http') && !iconUrl.startsWith('blob:') && !iconUrl.startsWith('data:')) {
                            const fileName = iconUrl.split('/').pop();
                            if (resources[fileName]) {
                                iconUrl = resources[fileName];
                            } else if (resources[iconUrl]) {
                                iconUrl = resources[iconUrl];
                            } else {
                                return L.marker(latlng, withLayerPane({}, layerPaneName));
                            }
                        }

                        if (!style._leafletIcon) {
                            style._leafletIcon = L.icon({
                                iconUrl: iconUrl,
                                iconSize: iconSize,
                                iconAnchor: iconAnchor
                            });
                        }

                        return L.marker(latlng, withLayerPane({
                            icon: style._leafletIcon
                        }, layerPaneName));
                    }
                }

                return L.marker(latlng, withLayerPane({}, layerPaneName));
            },

            onEachFeature: function(feature, layer) {
                let type = 'unknown';

                if (layer instanceof L.Marker) {
                    type = 'marker';
                } else if (layer instanceof L.Polygon) {
                    type = 'polygon';
                } else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
                    type = 'polyline';
                }

                if (feature.properties) {
                    let popupContent = '';

                    if (feature.properties.name) {
                        popupContent += `<strong>${feature.properties.name}</strong>`;
                    }

                    if (feature.properties.description) {
                        if (popupContent) popupContent += '<br>';
                        popupContent += feature.properties.description;
                    }

                    if (popupContent) {
                        layer.bindPopup(`<div class="custom-popup">${popupContent}</div>`);
                    }
                }

                importedLayerGroup.addLayer(layer);

                importedLayersList.push({
                    layer: layer,
                    type: type,
                    name: (feature.properties && feature.properties.name) ? feature.properties.name : getLayerTypeName(type),
                    properties: feature.properties || {}
                });
            }
        };

        if (layerPaneName) {
            geoJsonOptions.pane = layerPaneName;
        }

        L.geoJSON(geoJSON, geoJsonOptions);

        const groupId = `layer_${layerIdCounter++}`;

        if (sourceKind === 'importedKml' && heatImportMode === 'replace') {
            getAllLayerEntries().forEach(entry => {
                if (entry.sourceKind === 'importedKml') {
                    entry.heatIncluded = false;
                }
            });
        }

        layers[groupId] = {
            id: groupId,
            layer: importedLayerGroup,
            type: 'kmlgroup',
            name: kmlTitle,
            created: new Date().toLocaleString(),
            imported: true,
            visible: visible,
            heatIncluded: heatIncluded,
            heatPoints: newImportedHeatPoints,
            sourceKind: sourceKind,
            subLayers: importedLayersList,
            featureSummary: summarizeImportedLayerTypes(importedLayersList),
            originalStyles: styles
        };

        importedLayerGroup.on('click', function(e) {
            showLayerInfo(groupId);
            L.DomEvent.stopPropagation(e);
        });

        if (visible) {
            drawnItems.addLayer(importedLayerGroup);
        }

        if (autoZoom) {
            const bounds = importedLayerGroup.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [20, 20] });
            }
        }

        updateLayersList();

        if (!skipHeatmapRebuild) {
            rebuildHeatmap();
        }

        updateInfoPanel(`KML文件已导入：${kmlTitle}，提取到 ${newImportedHeatPoints.length} 个热力点`);
    } catch (error) {
        console.error('导入KML文件出错:', error);
        alert('导入KML文件出错: ' + error.message);
    }
}

function summarizeImportedLayerTypes(importedLayersList) {
    return importedLayersList.reduce((summary, item) => {
        if (item.type === 'marker') summary.marker += 1;
        else if (item.type === 'polyline') summary.polyline += 1;
        else if (item.type === 'polygon') summary.polygon += 1;
        else summary.unknown += 1;
        return summary;
    }, {
        marker: 0,
        polyline: 0,
        polygon: 0,
        unknown: 0
    });
}

function extractKMLStyles(kml, resources = {}) {
    const styles = {};

    try {
        const styleElements = kml.querySelectorAll('Style');

        styleElements.forEach(style => {
            const styleId = style.getAttribute('id');
            if (!styleId) return;

            const styleObj = {};

            const lineStyle = style.querySelector('LineStyle');
            if (lineStyle) {
                const color = lineStyle.querySelector('color');
                const width = lineStyle.querySelector('width');

                if (color) {
                    const kmlColor = color.textContent;
                    if (kmlColor && kmlColor.length === 8) {
                        const opacity = parseInt(kmlColor.substring(0, 2), 16) / 255;
                        const blue = kmlColor.substring(2, 4);
                        const green = kmlColor.substring(4, 6);
                        const red = kmlColor.substring(6, 8);
                        styleObj.lineColor = `#${red}${green}${blue}`;
                        styleObj.lineOpacity = opacity;
                    }
                }

                if (width) styleObj.lineWidth = parseFloat(width.textContent);
            }

            const polyStyle = style.querySelector('PolyStyle');
            if (polyStyle) {
                const color = polyStyle.querySelector('color');
                const fill = polyStyle.querySelector('fill');
                const outline = polyStyle.querySelector('outline');

                if (color) {
                    const kmlColor = color.textContent;
                    if (kmlColor && kmlColor.length === 8) {
                        const opacity = parseInt(kmlColor.substring(0, 2), 16) / 255;
                        const blue = kmlColor.substring(2, 4);
                        const green = kmlColor.substring(4, 6);
                        const red = kmlColor.substring(6, 8);
                        styleObj.polyColor = `#${red}${green}${blue}`;
                        styleObj.polyOpacity = opacity;
                    }
                }

                if (fill) styleObj.fill = parseInt(fill.textContent, 10) !== 0;
                if (outline) styleObj.outline = parseInt(outline.textContent, 10) !== 0;
            }

            const iconStyle = style.querySelector('IconStyle');
            if (iconStyle) {
                const scale = iconStyle.querySelector('scale');
                const icon = iconStyle.querySelector('Icon');
                const hotSpot = iconStyle.querySelector('hotSpot');

                if (scale) styleObj.iconScale = parseFloat(scale.textContent);

                if (icon) {
                    const href = icon.querySelector('href');
                    if (href) {
                        let iconUrl = href.textContent;
                        const fileName = iconUrl.split('/').pop();

                        if (resources[fileName]) {
                            iconUrl = resources[fileName];
                        } else if (resources[iconUrl]) {
                            iconUrl = resources[iconUrl];
                        }

                        styleObj.iconUrl = iconUrl;
                    }
                }

                if (hotSpot) {
                    styleObj.iconHotSpot = {
                        x: parseFloat(hotSpot.getAttribute('x') || '0.5'),
                        y: parseFloat(hotSpot.getAttribute('y') || '0.5'),
                        xunits: hotSpot.getAttribute('xunits') || 'fraction',
                        yunits: hotSpot.getAttribute('yunits') || 'fraction'
                    };
                }
            }

            styles[styleId] = styleObj;
        });

        const styleMaps = kml.querySelectorAll('StyleMap');
        styleMaps.forEach(styleMap => {
            const styleMapId = styleMap.getAttribute('id');
            if (!styleMapId) return;

            const styleMapObj = { pairs: {} };
            const pairs = styleMap.querySelectorAll('Pair');
            pairs.forEach(pair => {
                const key = pair.querySelector('key');
                const styleUrl = pair.querySelector('styleUrl');

                if (key && styleUrl) {
                    const keyName = key.textContent;
                    const styleRef = styleUrl.textContent.replace('#', '');
                    styleMapObj.pairs[keyName] = styleRef;

                    if (styles[styleRef] && keyName === 'normal') {
                        Object.assign(styleMapObj, styles[styleRef]);
                    }
                }
            });

            styles[styleMapId] = styleMapObj;
        });
    } catch (error) {
        console.error('提取KML样式时出错:', error);
    }

    return styles;
}

function getPopulationHourFromFileName(fileName) {
    const match = fileName.match(/(\d{2})(?=\.csv$)/i);
    return match ? match[1] : null;
}

function getSelectedPopulationHours() {
    return POPULATION_HOURS.filter(hour => selectedPopulationHours.has(hour)).slice(0, 1);
}

function getSelectedPopulationHour() {
    const selectedHours = getSelectedPopulationHours();
    return selectedHours.length ? selectedHours[0] : POPULATION_HOURS[0];
}

function formatPopulationHourLabel(hour) {
    return `${hour}:00`;
}

function formatPopulationHourRanges(hours) {
    return POPULATION_FIXED_HOUR_LABEL;
}

function updatePopulationTimeSummary() {
    const summaryElement = document.getElementById('populationHourSummary');
    if (!summaryElement) return;

    const selectedHour = getSelectedPopulationHour();
    summaryElement.innerHTML = `
        <div class="info-row"><span class="info-label"><i class="fas fa-clock"></i> 当前小时</span><span class="info-value">${formatPopulationHourRanges([selectedHour])}</span></div>
    `;
}

function renderPopulationTimeControls() {
    updatePopulationTimeSummary();
}

function setSelectedPopulationHours(hours, options = {}) {
    const normalizedHours = POPULATION_HOURS.filter(hour => hours.includes(hour));
    if (!normalizedHours.length) {
        return;
    }

    const targetHour = normalizedHours[0];
    selectedPopulationHours = new Set([targetHour]);
    renderPopulationTimeControls();

    if (options.refresh !== false) {
        ensurePopulationHourLoaded(targetHour).then(function() {
            refreshPopulationSelection({ announce: options.announce !== false });
        }).catch(function(error) {
            console.error('加载人口CSV失败:', error);
            setSystemStatus(`加载 ${targetHour}:00 数据失败：${error.message}`, 'warning');
            updateInfoPanel(`加载 ${targetHour}:00 数据失败：${error.message}`);
        });
    }
}

function initPopulationTimeControls() {
    renderPopulationTimeControls();
}

function parsePopulationCsvText(csvText, fileName) {
    const normalizedText = csvText.replace(/^\uFEFF/, '');
    const lines = normalizedText.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) {
        return [];
    }

    const headers = lines[0].split(',').map(header => header.trim());
    const columnIndexes = headers.reduce((indexMap, header, index) => {
        indexMap[header] = index;
        return indexMap;
    }, {});

    const requiredColumns = ['gcj02_LNG', 'gcj02_LAT', 'value'];
    const missingColumns = requiredColumns.filter(columnName => typeof columnIndexes[columnName] !== 'number');
    if (missingColumns.length > 0) {
        const displayName = decodeUnicodeFilename(fileName.split('/').pop() || fileName);
        throw new Error(`${displayName} 缺少必要字段：${missingColumns.join(', ')}`);
    }

    const records = [];

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const columns = lines[lineIndex].split(',');
        if (columns.length < headers.length) {
            continue;
        }

        const lngText = columns[columnIndexes.gcj02_LNG];
        const latText = columns[columnIndexes.gcj02_LAT];
        const weightText = columns[columnIndexes.value];
        const lng = Number(lngText);
        const lat = Number(latText);
        const weightValue = Number(weightText);

        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
            continue;
        }

        records.push({
            key: `${lngText},${latText}`,
            lng: lng,
            lat: lat,
            weight: Number.isFinite(weightValue) && weightValue > 0 ? weightValue : 1
        });
    }

    return records;
}

function mergePopulationRecords(recordMap, records, stats) {
    records.forEach(record => {
        let aggregatedRecord = recordMap.get(record.key);

        if (!aggregatedRecord) {
            aggregatedRecord = {
                key: record.key,
                lng: record.lng,
                lat: record.lat,
                totalWeight: 0,
                sampleCount: 0,
                maxRowWeight: 0
            };
            recordMap.set(record.key, aggregatedRecord);
        }

        aggregatedRecord.totalWeight += record.weight;
        aggregatedRecord.sampleCount += 1;
        aggregatedRecord.maxRowWeight = Math.max(aggregatedRecord.maxRowWeight, record.weight);
        stats.rawRowCount += 1;
    });
}

function mergeAggregatedPopulationPoint(recordMap, point) {
    let aggregatedRecord = recordMap.get(point.key);

    if (!aggregatedRecord) {
        aggregatedRecord = {
            key: point.key,
            lng: point.lng,
            lat: point.lat,
            totalWeight: 0,
            sampleCount: 0,
            maxRowWeight: 0
        };
        recordMap.set(point.key, aggregatedRecord);
    }

    aggregatedRecord.totalWeight += point.totalWeight;
    aggregatedRecord.sampleCount += point.sampleCount;
    aggregatedRecord.maxRowWeight = Math.max(aggregatedRecord.maxRowWeight, point.maxRowWeight);
}

function buildPopulationBounds(points) {
    if (!points.length) return null;

    const firstPoint = points[0];
    const bounds = L.latLngBounds(
        [firstPoint.lat, firstPoint.lng],
        [firstPoint.lat, firstPoint.lng]
    );

    for (let index = 1; index < points.length; index += 1) {
        bounds.extend([points[index].lat, points[index].lng]);
    }

    return bounds;
}

function formatPopulationDisplayNumber(value) {
    return Math.round(value).toLocaleString('zh-CN');
}

function buildPopulationDensityHeatPoints(points) {
    return points.map(function(point) {
        return [
            point.lat,
            point.lng,
            1
        ];
    });
}

function summarizePopulationAggregation(recordMap, stats) {
    const points = Array.from(recordMap.values()).sort((left, right) => left.totalWeight - right.totalWeight);
    const heatPoints = buildPopulationDensityHeatPoints(points);

    let totalWeight = 0;
    let maxWeight = 0;
    let minWeight = Number.POSITIVE_INFINITY;

    points.forEach(point => {
        totalWeight += point.totalWeight;
        maxWeight = Math.max(maxWeight, point.totalWeight);
        minWeight = Math.min(minWeight, point.totalWeight);
    });

    return {
        points: points,
        heatPoints: heatPoints,
        bounds: buildPopulationBounds(points),
        rawRowCount: stats.rawRowCount,
        fileCount: stats.fileCount,
        totalWeight: totalWeight,
        maxWeight: maxWeight,
        minWeight: Number.isFinite(minWeight) ? minWeight : 0
    };
}

function buildPopulationDataForSelectedHours() {
    const selectedHours = getSelectedPopulationHours();
    const aggregationMap = new Map();
    const stats = {
        rawRowCount: 0,
        fileCount: selectedHours.length
    };

    selectedHours.forEach(hour => {
        const hourDataset = populationHourlyPointSets[hour];
        if (!hourDataset) return;

        stats.rawRowCount += hourDataset.rawRowCount;
        hourDataset.points.forEach(point => {
            mergeAggregatedPopulationPoint(aggregationMap, point);
        });
    });

    if (!aggregationMap.size) {
        return null;
    }

    return summarizePopulationAggregation(aggregationMap, stats);
}

function buildPopulationPopupHtml(point) {
    const sourcePointCount = point.sourcePointCount || 1;
    const pointTitle = sourcePointCount > 1 ? '人口聚合点' : '人口数据点';

    return `
        <div class="custom-popup">
            <strong>${pointTitle}</strong>
            ${sourcePointCount > 1 ? `<p>聚合原始坐标数：${formatPopulationDisplayNumber(sourcePointCount)}</p>` : ''}
            <p>当前小时值：${formatPopulationDisplayNumber(point.totalWeight)}</p>
            <p>当前小时记录数：${formatPopulationDisplayNumber(point.sampleCount)}</p>
            <p>单条记录峰值：${formatPopulationDisplayNumber(point.maxRowWeight)}</p>
            <p>GCJ-02：${point.lng.toFixed(6)}, ${point.lat.toFixed(6)}</p>
        </div>
    `;
}

function getPopulationWeightRatio(weight, maxWeight) {
    return 1;
}

function getPopulationPointRadius(weight, maxWeight) {
    return 2.6;
}

function getPopulationPointOpacity(weight, maxWeight) {
    return 0.22;
}

function getPopulationViewportGridSize(zoom) {
    if (zoom >= 16) {
        return 0.0005;
    }

    if (zoom >= 15) {
        return 0.0009;
    }

    if (zoom >= 14) {
        return 0.0016;
    }

    return 0.0026;
}

function buildPopulationViewportPointCollection(points, gridSize) {
    if (!gridSize || points.length <= POPULATION_VIEW_TARGET_POINT_COUNT) {
        return points.map(function(point) {
            return {
                ...point,
                sourcePointCount: point.sourcePointCount || 1
            };
        });
    }

    const cellMap = new Map();

    points.forEach(function(point) {
        const lngCell = Math.round(point.lng / gridSize);
        const latCell = Math.round(point.lat / gridSize);
        const cellKey = `${lngCell}:${latCell}`;
        const densityCount = Math.max(1, point.sampleCount || 1);

        let aggregatedPoint = cellMap.get(cellKey);
        if (!aggregatedPoint) {
            aggregatedPoint = {
                key: `viewport:${cellKey}`,
                lngSum: 0,
                latSum: 0,
                densityCount: 0,
                totalWeight: 0,
                sampleCount: 0,
                maxRowWeight: 0,
                sourcePointCount: 0
            };
            cellMap.set(cellKey, aggregatedPoint);
        }

        aggregatedPoint.lngSum += point.lng * densityCount;
        aggregatedPoint.latSum += point.lat * densityCount;
        aggregatedPoint.densityCount += densityCount;
        aggregatedPoint.totalWeight += point.totalWeight;
        aggregatedPoint.sampleCount += point.sampleCount;
        aggregatedPoint.maxRowWeight = Math.max(aggregatedPoint.maxRowWeight, point.maxRowWeight);
        aggregatedPoint.sourcePointCount += point.sourcePointCount || 1;
    });

    return Array.from(cellMap.values()).map(function(point) {
        return {
            key: point.key,
            lng: point.lngSum / point.densityCount,
            lat: point.latSum / point.densityCount,
            totalWeight: point.totalWeight,
            sampleCount: point.sampleCount,
            maxRowWeight: point.maxRowWeight,
            sourcePointCount: point.sourcePointCount
        };
    });
}

function getPopulationViewportPoints(layerEntry, paddedBounds, zoom) {
    const visiblePoints = [];

    layerEntry.populationPoints.forEach(function(point) {
        if (paddedBounds.contains([point.lat, point.lng])) {
            visiblePoints.push(point);
        }
    });

    if (visiblePoints.length <= POPULATION_VIEW_TARGET_POINT_COUNT) {
        return visiblePoints.map(function(point) {
            return {
                ...point,
                sourcePointCount: 1
            };
        });
    }

    let gridSize = getPopulationViewportGridSize(zoom);
    let viewportPoints = buildPopulationViewportPointCollection(visiblePoints, gridSize);

    while (viewportPoints.length > POPULATION_VIEW_MAX_POINT_COUNT && gridSize < POPULATION_VIEW_MAX_GRID_SIZE) {
        gridSize *= 1.35;
        viewportPoints = buildPopulationViewportPointCollection(visiblePoints, gridSize);
    }

    return viewportPoints;
}

function cancelPopulationLayerViewportUpdate(layerEntry) {
    if (!layerEntry || !layerEntry.viewportRefreshHandle) {
        return;
    }

    window.clearTimeout(layerEntry.viewportRefreshHandle);
    layerEntry.viewportRefreshHandle = null;
}

function schedulePopulationLayerViewportUpdate(layerEntry, options = {}) {
    if (!layerEntry || !layerEntry.layer || !map) {
        return;
    }

    cancelPopulationLayerViewportUpdate(layerEntry);

    const delay = options.immediate === true ? 0 : POPULATION_VIEW_RENDER_DELAY_MS;
    layerEntry.viewportRefreshHandle = window.setTimeout(function() {
        layerEntry.viewportRefreshHandle = null;
        window.requestAnimationFrame(function() {
            updatePopulationLayerViewport(layerEntry);
        });
    }, delay);
}

function updatePopulationLayerViewport(layerEntry) {
    if (!layerEntry || !layerEntry.layer || !map) return;

    layerEntry.layer.clearLayers();
    layerEntry.renderedPointCount = 0;

    // Population density now displays only as a heatmap, no marker points rendered.
}

function upsertPopulationLayerEntry(populationData, options = {}) {
    const existingPopulationEntry = getAllLayerEntries().find(entry => entry.sourceKind === 'populationDensity');
    const selectedHours = options.selectedHours || getSelectedPopulationHours();

    if (existingPopulationEntry) {
        removeLayerEntryFromMap(existingPopulationEntry);
        if (typeof existingPopulationEntry.destroy === 'function') {
            existingPopulationEntry.destroy();
        }
        delete layers[existingPopulationEntry.id];
    }

    const groupId = `layer_${layerIdCounter++}`;
    const layerGroup = L.layerGroup();
    const populationEntry = {
        id: groupId,
        layer: layerGroup,
        type: 'populationgroup',
        name: POPULATION_LAYER_NAME,
        created: new Date().toLocaleString(),
        visible: options.visible === true,
        heatIncluded: options.heatIncluded !== false,
        includeHeatWhenHidden: false,
        sourceKind: 'populationDensity',
        heatPoints: populationData.heatPoints,
        featureCount: populationData.points.length,
        featureSummary: {
            marker: populationData.points.length,
            polyline: 0,
            polygon: 0,
            unknown: 0
        },
        renderModeLabel: `${POPULATION_POINT_MIN_ZOOM}级以上按当前视窗聚合渲染，${POPULATION_POINT_POPUP_MIN_ZOOM}级以上可点选详情`,
        coordinateSystem: 'GCJ-02（直接读取CSV中的 gcj02_LNG / gcj02_LAT）',
        timeWindowLabel: formatPopulationHourRanges(selectedHours),
        dataSource: `01原始数据CSV，当前选中 ${selectedHours.length} 个小时，原始 ${formatPopulationDisplayNumber(populationData.rawRowCount)} 行`,
        weightStrategy: `使用CSV的 value 字段，${POPULATION_WEIGHT_STRATEGY}`,
        weightSummary: {
            total: formatPopulationDisplayNumber(populationData.totalWeight),
            max: formatPopulationDisplayNumber(populationData.maxWeight),
            min: formatPopulationDisplayNumber(populationData.minWeight)
        },
        weightStats: {
            total: populationData.totalWeight,
            max: populationData.maxWeight,
            min: populationData.minWeight
        },
        bounds: populationData.bounds,
        populationPoints: populationData.points,
        renderedPointCount: 0,
        attachToMap: function() {
            if (!drawnItems.hasLayer(layerGroup)) {
                drawnItems.addLayer(layerGroup);
            }
            schedulePopulationLayerViewportUpdate(populationEntry, { immediate: true });
        },
        detachFromMap: function() {
            cancelPopulationLayerViewportUpdate(populationEntry);
            layerGroup.clearLayers();
            drawnItems.removeLayer(layerGroup);
        },
        refreshViewport: function() {
            schedulePopulationLayerViewportUpdate(populationEntry);
        },
        destroy: function() {
            cancelPopulationLayerViewportUpdate(populationEntry);
            layerGroup.clearLayers();
        }
    };

    layers[groupId] = populationEntry;

    if (populationEntry.visible) {
        addLayerEntryToMap(populationEntry);
    }

    updateLayersList();

    return populationEntry;
}

function refreshPopulationSelection(options = {}) {
    renderPopulationTimeControls();

    if (!Object.keys(populationHourlyPointSets).length) {
        return null;
    }

    const existingPopulationEntry = getAllLayerEntries().find(entry => entry.sourceKind === 'populationDensity');
    const populationData = buildPopulationDataForSelectedHours();
    if (!populationData) {
        return null;
    }

    const populationEntry = upsertPopulationLayerEntry(populationData, {
        visible: existingPopulationEntry ? existingPopulationEntry.visible === true : false,
        heatIncluded: true,
        selectedHours: getSelectedPopulationHours()
    });

    rebuildHeatmap();

    if (options.announce !== false) {
        updateInfoPanel(`人口数据已切换到 ${populationEntry.timeWindowLabel}，热力图已按所选时段更新。`);
    }

    return populationData;
}

async function loadPopulationCsvFiles() {
    updateInfoPanel('正在从CSV加载人口数据...');

    populationHourlyPointSets = {};

    // 优先加载当前选中的小时，其余延迟加载
    const selectedHour = getSelectedPopulationHour();
    const selectedIndex = POPULATION_HOURS.indexOf(selectedHour);
    const selectedFileName = POPULATION_CSV_FILES[selectedIndex];

    setSystemStatus(`正在加载人口CSV：${decodeUnicodeFilename(selectedFileName.split('/').pop())}`, 'loading');

    const response = await fetch(buildRelativeFileUrl(selectedFileName));
    if (!response.ok) {
        const displayName = decodeUnicodeFilename(selectedFileName.split('/').pop());
        throw new Error(`${displayName} 加载失败（HTTP ${response.status}），请确认通过本地静态服务运行项目`);
    }

    const csvText = await response.text();
    const records = parsePopulationCsvText(csvText, selectedFileName);
    const hourlyRecordMap = new Map();
    const hourlyStats = { rawRowCount: 0 };

    mergePopulationRecords(hourlyRecordMap, records, hourlyStats);

    populationHourlyPointSets[selectedHour] = {
        points: Array.from(hourlyRecordMap.values()),
        rawRowCount: hourlyStats.rawRowCount,
        fileName: decodeUnicodeFilename(selectedFileName.split('/').pop())
    };

    const populationData = refreshPopulationSelection({ announce: false });
    if (!populationData) {
        throw new Error('人口CSV未解析出有效点位');
    }

    setSystemStatus(
        `人口CSV已加载完成，当前时段 ${formatPopulationHourRanges([selectedHour])}`,
        'success'
    );
    updateInfoPanel(
        `人口CSV已加载完成：当前 ${formatPopulationHourRanges([selectedHour])} 共 ${formatPopulationDisplayNumber(hourlyStats.rawRowCount)} 行。切换时段时将自动加载对应数据。`
    );

    return populationData;
}

async function ensurePopulationHourLoaded(hour) {
    if (populationHourlyPointSets[hour]) {
        return;
    }

    const hourIndex = POPULATION_HOURS.indexOf(hour);
    if (hourIndex < 0) return;

    const fileName = POPULATION_CSV_FILES[hourIndex];
    const displayName = decodeUnicodeFilename(fileName.split('/').pop() || fileName);

    setSystemStatus(`正在加载人口CSV：${displayName}`, 'loading');

    const response = await fetch(buildRelativeFileUrl(fileName));
    if (!response.ok) {
        throw new Error(`${displayName} 加载失败（HTTP ${response.status}）`);
    }

    const csvText = await response.text();
    const records = parsePopulationCsvText(csvText, fileName);
    const hourlyRecordMap = new Map();
    const hourlyStats = { rawRowCount: 0 };

    mergePopulationRecords(hourlyRecordMap, records, hourlyStats);

    populationHourlyPointSets[hour] = {
        points: Array.from(hourlyRecordMap.values()),
        rawRowCount: hourlyStats.rawRowCount,
        fileName: displayName
    };

    setSystemStatus(`人口CSV已加载：${displayName}`, 'success');
}

async function loadInitialDataResources() {
    // KML 注册（瞬时）与 CSV 加载并行
    const csvPromise = loadPopulationCsvFiles().catch(function(error) {
        console.error('加载人口CSV失败:', error);
        setSystemStatus(`人口CSV加载失败：${error.message}`, 'warning');
        updateInfoPanel(`人口CSV加载失败：${error.message}`);
    });

    const kmlPromise = loadBuiltInKmlFiles();
    registerRoadNetworkLayer();

    await Promise.all([csvPromise, kmlPromise]);
}

function decodeUnicodeFilename(name) {
    if (!name) return '';
    return name.replace(/#U([0-9A-Fa-f]{4,6})/g, function(match, hex) {
        try {
            return String.fromCodePoint(parseInt(hex, 16));
        } catch (error) {
            return match;
        }
    });
}

function buildRelativeFileUrl(fileName) {
    return fileName.split('/').map(part => encodeURIComponent(part)).join('/');
}

async function loadBuiltInKmlFiles() {
    // 注册 KML 文件为占位符条目（懒加载：不实际拉取文件）
    AUTO_LOAD_KML_FILES.forEach(function(item) {
        const fileConfig = typeof item === 'string'
            ? { fileName: item, sourceKind: 'builtinKml' }
            : item;
        const fileName = fileConfig.fileName;
        const groupId = `layer_${layerIdCounter++}`;

        layers[groupId] = {
            id: groupId,
            layer: new L.FeatureGroup(),
            type: 'kmlgroup',
            name: fileConfig.displayName || decodeUnicodeFilename(fileName).replace(/\.kml$/i, ''),
            created: new Date().toLocaleString(),
            imported: true,
            visible: fileConfig.visible || false,
            heatIncluded: fileConfig.heatIncluded !== false,
            heatPoints: [],
            sourceKind: fileConfig.sourceKind || 'builtinKml',
            subLayers: [],
            featureSummary: '未加载 · 开启时自动加载',
            _lazyKml: fileName,
            _lazyConfig: fileConfig,
            _lazyLoaded: false
        };
    });

    updateLayersList();
    setSystemStatus(`已注册 ${AUTO_LOAD_KML_FILES.length} 个预置KML图层（按需加载）`, 'success');
    updateInfoPanel(`已注册 ${AUTO_LOAD_KML_FILES.length} 个预置KML图层，开启时自动加载。`);

    // 自动加载和显示visible为true的图层
    for (const groupId in layers) {
        const layerEntry = layers[groupId];
        if (layerEntry.visible && layerEntry._lazyKml && !layerEntry._lazyLoaded) {
            console.log(`开始自动加载 ${layerEntry.name}...`);
            updateInfoPanel(`正在自动加载 ${layerEntry.name}...`);
            try {
                const loadSuccess = await ensureKmlLayerLoaded(layerEntry);
                console.log(`${layerEntry.name} 加载结果:`, loadSuccess, `_lazyLoaded:`, layerEntry._lazyLoaded);
                if (layerEntry._lazyLoaded) {
                    console.log(`将 ${layerEntry.name} 添加到地图...`);
                    addLayerEntryToMap(layerEntry);
                    console.log(`${layerEntry.name} 已添加到地图`);
                    updateInfoPanel(`${layerEntry.name} 已显示`);
                    _syncLanduseLegend(layerEntry, true);
                    console.log(`${layerEntry.name} 图例已同步`);
                } else {
                    console.error(`${layerEntry.name} 加载失败，_lazyLoaded 为 false`);
                    layerEntry.visible = false;
                    updateLayersList();
                }
            } catch (error) {
                console.error(`自动加载 ${layerEntry.name} 失败:`, error);
                updateInfoPanel(`${layerEntry.name} 加载失败：${error.message}`);
                layerEntry.visible = false;
                updateLayersList();
            }
        }
    }
}

function registerRoadNetworkLayer() {
    const groupId = `layer_${layerIdCounter++}`;
    layers[groupId] = {
        id: groupId,
        layer: new L.FeatureGroup(),
        type: 'kmlgroup',
        name: '路网',
        created: new Date().toLocaleString(),
        imported: true,
        visible: false,
        heatIncluded: false,
        heatPoints: [],
        sourceKind: 'roadNetwork',
        subLayers: [],
        featureSummary: '未加载 · 开启时自动加载',
        _lazyRoadNetwork: true,
        _lazyLoaded: false
    };
}

async function ensureRoadNetworkLoaded(layerEntry) {
    if (!layerEntry._lazyRoadNetwork || layerEntry._lazyLoaded) return true;

    try {
        updateInfoPanel('正在加载路网数据...');
        const response = await fetch(buildRelativeFileUrl(ROAD_NETWORK_FILE));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const geojson = await response.json();
        const paneName = getLayerPaneName('roadNetwork');
        const featureGroup = layerEntry.layer;
        const subLayersList = [];

        L.geoJSON(geojson, {
            style: function(feature) {
                var highway = (feature.properties && feature.properties.highway) || '';
                var s = ROAD_NETWORK_STYLES[highway] || ROAD_NETWORK_STYLES._default;
                return {
                    color: s.color,
                    weight: s.weight,
                    opacity: s.opacity,
                    lineCap: 'round',
                    lineJoin: 'round'
                };
            },
            onEachFeature: function(feature, layer) {
                featureGroup.addLayer(layer);
                subLayersList.push(layer);
            },
            pane: paneName
        });

        layerEntry.subLayers = subLayersList;
        layerEntry.featureSummary = subLayersList.length + ' 条道路';
        layerEntry._lazyLoaded = true;

        updateInfoPanel('路网加载完成（' + subLayersList.length + ' 条道路）');
        return true;
    } catch (error) {
        console.error('路网加载失败:', error);
        updateInfoPanel('路网加载失败：' + error.message);
        return false;
    }
}

async function ensureKmlLayerLoaded(layerEntry) {
    if (!layerEntry._lazyKml || layerEntry._lazyLoaded) return true;

    const fileName = layerEntry._lazyKml;
    const fileConfig = layerEntry._lazyConfig;

    try {
        updateInfoPanel(`正在加载 ${layerEntry.name}...`);
        const response = await fetch(buildRelativeFileUrl(fileName));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const kmlText = await response.text();
        const kml = new DOMParser().parseFromString(kmlText, 'text/xml');
        var geoJSON;
        if (typeof togeojson === 'undefined') {
            if (typeof toGeoJSON !== 'undefined') {
                geoJSON = toGeoJSON.kml(kml);
            } else {
                throw new Error('没有可用的KML到GeoJSON转换库');
            }
        } else {
            geoJSON = togeojson.kml(kml);
        }
        const styles = extractKMLStyles(kml, {});
        // 转换热力点坐标
        const newHeatPoints = extractHeatPointsFromGeoJSON(geoJSON).map(function(point) {
            var [lng, lat, intensity] = point;
            var [newLng, newLat] = wgs84ToGcj02(lng, lat);
            return [newLat, newLng, intensity];
        });

        const layerPaneName = getLayerPaneName(layerEntry.sourceKind);
        const importedLayerGroup = layerEntry.layer;
        const importedLayersList = [];

        // 转换 GeoJSON 坐标从 WGS84 到 GCJ-02
//        function transformGeoJSONCoordinates(geoJSON) {
//            function transformCoordinates(coords) {
//                if (Array.isArray(coords)) {
//                    if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
//                        // 坐标对 [lng, lat]
//                        var [lng, lat] = coords;
//                        var [newLng, newLat] = wgs84ToGcj02(lng, lat);
//                        return [newLng, newLat];
//                    } else {
//                        // 坐标数组
//                        return coords.map(transformCoordinates);
//                    }
//                }
//                return coords;
//            }
//
//            function transformGeometry(geometry) {
//                if (geometry && geometry.coordinates) {
//                    geometry.coordinates = transformCoordinates(geometry.coordinates);
//                }
//                return geometry;
//            }
//
//            if (geoJSON.type === 'FeatureCollection') {
//                geoJSON.features = geoJSON.features.map(function(feature) {
//                    if (feature.geometry) {
//                        feature.geometry = transformGeometry(feature.geometry);
//                    }
//                    return feature;
//                });
//            } else if (geoJSON.type === 'Feature') {
//                if (geoJSON.geometry) {
//                    geoJSON.geometry = transformGeometry(geoJSON.geometry);
//                }
//            } else if (geoJSON.geometry) {
//                geoJSON.geometry = transformGeometry(geoJSON.geometry);
//            }
//
//            return geoJSON;
//        }
        function transformGeoJSONCoordinates(geoJSON) {
            if (!geoJSON || !geoJSON.features) return geoJSON;
            function convertCoords(coords) {
                if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                    const [lng, lat] = wgs84ToGcj02(coords[0], coords[1]);
                    return [lng, lat];
                }
                return coords.map(convertCoords);
            }
            geoJSON.features.forEach(feature => {
                if (feature.geometry && feature.geometry.coordinates) {
                    feature.geometry.coordinates = convertCoords(feature.geometry.coordinates);
                }
            });
            return geoJSON;
        }
        // 转换坐标
        //geoJSON = transformGeoJSONCoordinates(geoJSON);
        if (fileConfig.fileName === 'landuse.kml') {
              geoJSON = transformGeoJSONCoordinates(geoJSON);
         }

        L.geoJSON(geoJSON, {
            style: function(feature) {
                if (feature.properties && feature.properties.styleUrl) {
                    var styleId = feature.properties.styleUrl.replace('#', '');
                    if (styles[styleId] && styles[styleId].pairs && styles[styleId].pairs.normal) {
                        styleId = styles[styleId].pairs.normal;
                    }
                    var style = styles[styleId];
                    if (style) {
                        if (!style._leafletStyle) {
                            style._leafletStyle = {
                                color: style.lineColor || '#3498db',
                                weight: style.lineWidth || 4,
                                opacity: style.lineOpacity || 0.8,
                                fillColor: style.polyColor || '#3498db',
                                fillOpacity: style.polyOpacity || 0.3
                            };
                            if (Object.prototype.hasOwnProperty.call(style, 'fill')) style._leafletStyle.fill = style.fill;
                            if (Object.prototype.hasOwnProperty.call(style, 'outline')) style._leafletStyle.stroke = style.outline;
                        }
                        return style._leafletStyle;
                    }
                }
                return { color: '#3498db', weight: 4, opacity: 0.8, fillColor: '#3498db', fillOpacity: 0.3 };
            },
            pointToLayer: function(feature, latlng) {
                // 转换点坐标
                var [lng, lat] = wgs84ToGcj02(latlng.lng, latlng.lat);
                var newLatLng = L.latLng(lat, lng);
                
                if (feature.properties && feature.properties.styleUrl) {
                    var styleId = feature.properties.styleUrl.replace('#', '');
                    if (styles[styleId] && styles[styleId].pairs && styles[styleId].pairs.normal) {
                        styleId = styles[styleId].pairs.normal;
                    }
                    var style = styles[styleId];
                    if (style && style.iconUrl) {
                        var iconSize = [10, 10];
                        if (style.iconScale) {
                            iconSize = [10 * style.iconScale, 10 * style.iconScale];
                        }
                        var iconOptions = { iconUrl: style.iconUrl, iconSize: iconSize };
                        if (style.hotSpot) {
                            var ax = style.hotSpot.xunits === 'fraction' ? style.hotSpot.x * iconSize[0] : style.hotSpot.x;
                            var ay = style.hotSpot.yunits === 'fraction' ? (1 - style.hotSpot.y) * iconSize[1] : iconSize[1] - style.hotSpot.y;
                            iconOptions.iconAnchor = [ax, ay];
                        }
                        return L.marker(newLatLng, { icon: L.icon(iconOptions), pane: layerPaneName });
                    }
                }
                return L.marker(newLatLng, { pane: layerPaneName });
            },
            onEachFeature: function(feature, layer) {
                var popupContent = '';
                if (feature.properties) {
                    if (feature.properties.name) popupContent += '<strong>' + feature.properties.name + '</strong>';
                    if (feature.properties.description) popupContent += '<p>' + feature.properties.description + '</p>';
                }
                if (popupContent) layer.bindPopup('<div class="custom-popup">' + popupContent + '</div>');

                importedLayerGroup.addLayer(layer);
                importedLayersList.push(layer);
            },
            pane: layerPaneName
        });

        layerEntry.heatPoints = newHeatPoints;
        layerEntry.subLayers = importedLayersList;
        layerEntry.featureSummary = summarizeImportedLayerTypes(importedLayersList);
        layerEntry._lazyLoaded = true;

        updateInfoPanel(`${layerEntry.name} 加载完成（${importedLayersList.length} 个要素）`);
        return true;
    } catch (error) {
        console.error(`懒加载 KML 失败: ${fileName}`, error);
        updateInfoPanel(`${layerEntry.name} 加载失败：${error.message}`);
        return false;
    }
}

// 批量懒加载指定名称的 KML 图层（用于选址评分依赖）
async function ensureScoringKmlLoaded() {
    const needed = ['公交站', '地铁站', '主要道路'];
    const promises = [];
    getAllLayerEntries().forEach(function(entry) {
        if (needed.some(function(n) { return entry.name && entry.name.indexOf(n) !== -1; })) {
            if (entry._lazyKml && !entry._lazyLoaded) {
                promises.push(ensureKmlLayerLoaded(entry));
            }
        }
    });
    if (promises.length > 0) {
        await Promise.all(promises);
    }
}


function fitMapToVisibleLayers() {
    let mergedBounds = null;

    getAllLayerEntries().forEach(entry => {
        if (entry.visible === false) return;
        const bounds = getLayerBounds(entry);
        if (!bounds || !bounds.isValid()) return;

        if (!mergedBounds) {
            mergedBounds = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
        } else {
            mergedBounds.extend(bounds);
        }
    });

    if (mergedBounds && mergedBounds.isValid()) {
        map.fitBounds(mergedBounds, { padding: [20, 20] });
    }
}

function initSidebarToggle() {
    const panel = document.getElementById('sidebarPanel');
    const toggleBtn = document.getElementById('sidebarToggleBtn');
    const openBtn = document.getElementById('sidebarOpenBtn');
    const workspace = document.querySelector('.workspace');
    if (!panel || !toggleBtn || !openBtn) return;

    function closeSidebar() {
        panel.classList.add('panel-collapsed');
        if (workspace) workspace.classList.add('sidebar-hidden');
        openBtn.style.display = '';
        openBtn.style.cssText = 'display:grid;place-items:center;';
        toggleBtn.querySelector('i').className = 'fas fa-angles-left';
        toggleBtn.title = '展开面板';
        scheduleMapLayoutRefresh([0, 180, 520]);
    }

    function openSidebar() {
        panel.classList.remove('panel-collapsed');
        if (workspace) workspace.classList.remove('sidebar-hidden');
        openBtn.style.display = 'none';
        toggleBtn.querySelector('i').className = 'fas fa-angles-right';
        toggleBtn.title = '收起面板';
        scheduleMapLayoutRefresh([0, 180, 520]);
    }

    toggleBtn.addEventListener('click', function() {
        if (panel.classList.contains('panel-collapsed')) {
            openSidebar();
        } else {
            closeSidebar();
        }
    });

    openBtn.addEventListener('click', openSidebar);
}

// ====== 侧边栏视图切换 ======
function initViewSwitcher() {
    const tabs = document.querySelectorAll('.chip-tab');
    tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
            const targetView = this.getAttribute('data-view');
            tabs.forEach(function(t) { t.classList.remove('is-active'); });
            this.classList.add('is-active');

            document.querySelectorAll('.panel-view').forEach(function(view) {
                view.classList.remove('panel-view-active');
            });

            if (targetView === 'layers') {
                document.getElementById('viewLayers').classList.add('panel-view-active');
            } else if (targetView === 'scoring') {
                document.getElementById('viewScoring').classList.add('panel-view-active');
            }
        });
    });
}

// ====== 选址评分模块 ======
let scoringMode = false;
let currentScoringRound = 1; // 1表示第一次选址，2表示第二次选址
let scoringMarker1 = null; // 第一次选址标记
let scoringCircle1 = null; // 第一次选址圆圈
let scoringMarker2 = null; // 第二次选址标记
let scoringCircle2 = null; // 第二次选址圆圈
let scoringResults = {}; // 存储两次选址结果
let scoringLandPriceAnchors = [];
let scoringBakeryCompetitors = [];
let scoringBusStopPoints = [];
let scoringMetroStationPoints = [];
let scoringMajorRoadPoints = [];
let scoringDataLoaded = false;

const SCORING_RADIUS_M = 1000;
const SCORING_TRANSPORT_MAX_STOPS = 8;
const SCORING_METRO_MAX_STATIONS = 3;
const SCORING_ROAD_IDEAL_DIST_M = 200;
const SCORING_ROAD_MAX_DIST_M = 2000;
const SCORING_COMPETITION_MAX_SHOPS = 5;

function haversineDistance(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function loadScoringData() {
    if (scoringDataLoaded) return;

    try {
        var landPriceResp = await fetch('land_price_anchors_with_coords.json');
        if (landPriceResp.ok) {
            scoringLandPriceAnchors = await landPriceResp.json();
        }
    } catch (e) {
        console.error('加载地价锚点数据失败:', e);
    }

    try {
        var bakeryResp = await fetch('bakery_all_competitors_with_coords.json');
        if (bakeryResp.ok) {
            scoringBakeryCompetitors = await bakeryResp.json();
        }
    } catch (e) {
        console.error('加载烘焙竞品数据失败:', e);
    }

    // 确保评分依赖的 KML 已懒加载
    await ensureScoringKmlLoaded();

    // 从 bus_stops.kml 中提取坐标
    extractBusStopPoints();

    // 从 metro_stations.kml 中提取地铁站坐标
    extractMetroStationPoints();

    // 从 major_roads.kml 中提取主要道路坐标
    extractMajorRoadPoints();

    scoringDataLoaded = true;
}

function extractBusStopPoints() {
    scoringBusStopPoints = [];
    getAllLayerEntries().forEach(function(entry) {
        if (entry.name && entry.name.indexOf('公交') !== -1) {
            var layerGroup = entry.layer;
            if (!layerGroup) return;

            var extractFromLayer = function(lyr) {
                if (lyr.getLatLng) {
                    var ll = lyr.getLatLng();
                    scoringBusStopPoints.push({ lat: ll.lat, lng: ll.lng });
                } else if (lyr.eachLayer) {
                    lyr.eachLayer(extractFromLayer);
                }
            };

            if (layerGroup.eachLayer) {
                layerGroup.eachLayer(extractFromLayer);
            }
        }
    });
    console.log('[选址评分] 提取公交站点数:', scoringBusStopPoints.length);
}

function extractMetroStationPoints() {
    scoringMetroStationPoints = [];
    getAllLayerEntries().forEach(function(entry) {
        if (entry.name && entry.name.indexOf('地铁') !== -1) {
            var layerGroup = entry.layer;
            if (!layerGroup) return;

            var extractFromLayer = function(lyr) {
                if (lyr.getLatLng) {
                    var ll = lyr.getLatLng();
                    scoringMetroStationPoints.push({ lat: ll.lat, lng: ll.lng });
                } else if (lyr.eachLayer) {
                    lyr.eachLayer(extractFromLayer);
                }
            };

            if (layerGroup.eachLayer) {
                layerGroup.eachLayer(extractFromLayer);
            }
        }
    });
    console.log('[选址评分] 提取地铁站点数:', scoringMetroStationPoints.length);
}

function extractMajorRoadPoints() {
    scoringMajorRoadPoints = [];
    getAllLayerEntries().forEach(function(entry) {
        if (entry.name && entry.name.indexOf('主要道路') !== -1) {
            var layerGroup = entry.layer;
            if (!layerGroup) return;

            var extractFromLayer = function(lyr) {
                if (lyr.getLatLng) {
                    var ll = lyr.getLatLng();
                    scoringMajorRoadPoints.push({ lat: ll.lat, lng: ll.lng });
                } else if (lyr.eachLayer) {
                    lyr.eachLayer(extractFromLayer);
                }
            };

            if (layerGroup.eachLayer) {
                layerGroup.eachLayer(extractFromLayer);
            }
        }
    });
    console.log('[选址评分] 提取主要道路点数:', scoringMajorRoadPoints.length);
}

function scoreTransport(lat, lng) {
    // Always re-extract in case KML data loaded late
    extractBusStopPoints();
    extractMetroStationPoints();
    extractMajorRoadPoints();

    var busCount = 0;
    scoringBusStopPoints.forEach(function(pt) {
        if (haversineDistance(lat, lng, pt.lat, pt.lng) <= SCORING_RADIUS_M) {
            busCount++;
        }
    });

    var metroCount = 0;
    scoringMetroStationPoints.forEach(function(pt) {
        if (haversineDistance(lat, lng, pt.lat, pt.lng) <= SCORING_RADIUS_M) {
            metroCount++;
        }
    });

    // 道路通达度：距最近主干道的距离
    var nearestRoadDist = Infinity;
    scoringMajorRoadPoints.forEach(function(pt) {
        var dist = haversineDistance(lat, lng, pt.lat, pt.lng);
        if (dist < nearestRoadDist) {
            nearestRoadDist = dist;
        }
    });

    // 公交站评分（满15个为满分）
    var busScore = Math.min(busCount / SCORING_TRANSPORT_MAX_STOPS, 1) * 10;
    // 地铁站评分（满5个为满分）
    var metroScore = Math.min(metroCount / SCORING_METRO_MAX_STATIONS, 1) * 10;
    // 道路通达度评分：≤200m满分，≥2000m零分
    var roadScore;
    if (scoringMajorRoadPoints.length === 0) {
        roadScore = 5;
    } else if (nearestRoadDist <= SCORING_ROAD_IDEAL_DIST_M) {
        roadScore = 10;
    } else if (nearestRoadDist >= SCORING_ROAD_MAX_DIST_M) {
        roadScore = 0;
    } else {
        roadScore = 10 * (1 - (nearestRoadDist - SCORING_ROAD_IDEAL_DIST_M) / (SCORING_ROAD_MAX_DIST_M - SCORING_ROAD_IDEAL_DIST_M));
    }

    // 综合交通评分：公交 25% + 地铁 40% + 道路通达 35%
    var score;
    if (scoringMetroStationPoints.length === 0) {
        score = busScore * 0.5 + roadScore * 0.5;
    } else {
        score = busScore * 0.25 + metroScore * 0.4 + roadScore * 0.35;
    }

    return {
        score: Math.round(score * 10) / 10,
        busCount: busCount,
        metroCount: metroCount,
        nearestRoadDist: Math.round(nearestRoadDist)
    };
}

function scorePopulation(lat, lng) {
    var selectedHour = getSelectedScoringHour();
    var dataset = populationHourlyPointSets[selectedHour];
    if (!dataset || !dataset.points || !dataset.points.length) {
        return { score: 0, totalWeight: 0 };
    }

    // 距离加权衰减：越近影响越大（高斯衰减）
    var sigma = SCORING_RADIUS_M * 0.6;
    var weightedSum = 0;
    var rawSum = 0;
    dataset.points.forEach(function(pt) {
        var dist = haversineDistance(lat, lng, pt.lat, pt.lng);
        if (dist <= SCORING_RADIUS_M) {
            rawSum += pt.totalWeight;
            var decay = Math.exp(-(dist * dist) / (2 * sigma * sigma));
            weightedSum += pt.totalWeight * decay;
        }
    });

    // 平方根缩放 + 高阈值以确保区分度
    // 1km 半径下：火车站约700，市中心约470，滨湖约215，经开约95，郊区<10
    // 阈值设为700（火车站级别才满分），平方根缩放拉开中低段差距
    var maxThreshold = 700;
    var normalized = Math.min(weightedSum / maxThreshold, 1);
    var score = Math.sqrt(normalized) * 10;
    return { score: Math.round(score * 10) / 10, totalWeight: Math.round(rawSum) };
}

function scoreLandPrice(lat, lng) {
    if (!scoringLandPriceAnchors.length) {
        return { score: 5, price: 0, areaName: '无数据' };
    }

    // 混合插值：最近锚点主导（60%）+ 高斯加权全局（40%）
    // 确保最近区域特征不被远处锚点稀释
    var sigma = 2000;
    var totalGaussWeight = 0;
    var gaussWeightedPrice = 0;
    var nearestDist = Infinity;
    var nearestArea = '';
    var nearestPrice = 0;

    scoringLandPriceAnchors.forEach(function(anchor) {
        var dist = haversineDistance(lat, lng, anchor.latitude_wgs84, anchor.longitude_wgs84);
        var w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
        totalGaussWeight += w;
        gaussWeightedPrice += anchor.proxy_price_yuan_per_m2 * w;
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestArea = anchor.area_name;
            nearestPrice = anchor.proxy_price_yuan_per_m2;
        }
    });

    var gaussAvg = totalGaussWeight > 0 ? gaussWeightedPrice / totalGaussWeight : 0;
    // 最近锚点权重随距离衰减：非常近时占80%，远时高斯均值占更多
    var nearWeight = Math.exp(-nearestDist / 3000) * 0.8;
    nearWeight = Math.max(nearWeight, 0.3);
    var avgPrice = nearestPrice * nearWeight + gaussAvg * (1 - nearWeight);

    // 地价适宜度：越便宜越好（成本导向）
    // 价格区间映射：10000以下→10分，30000以上→0分
    var minPrice = 10000;
    var maxPrice = 30000;
    var score;
    if (avgPrice <= minPrice) {
        score = 10;
    } else if (avgPrice >= maxPrice) {
        score = 0;
    } else {
        score = 10 * (1 - (avgPrice - minPrice) / (maxPrice - minPrice));
    }

    return {
        score: Math.round(Math.max(0, Math.min(10, score)) * 10) / 10,
        price: Math.round(avgPrice),
        areaName: nearestArea
    };
}

function scoreCompetition(lat, lng) {
    var nearestDist = Infinity;
    var nearestName = '';

    // 使用10km搜索半径，指数距离衰减计算竞争压力
    // 衰减系数 lambda：使得1km处权重为0.37，2km处为0.14，5km处为0.007
    var searchRadius = 10000;
    var lambda = 1000; // 衰减特征距离
    var competitionPressure = 0;
    var countWithin1km = 0;

    scoringBakeryCompetitors.forEach(function(shop) {
        if (!shop.longitude_wgs84 || !shop.latitude_wgs84) return;
        var dist = haversineDistance(lat, lng, shop.latitude_wgs84, shop.longitude_wgs84);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestName = shop.store_name || shop.brand;
        }
        if (dist <= searchRadius) {
            // 指数衰减：e^(-dist/lambda)
            var weight = Math.exp(-dist / lambda);
            competitionPressure += weight;
            if (dist <= 1000) {
                countWithin1km++;
            }
        }
    });

    // 竞争压力 = 市场验证指标：竞争越多说明市场越好
    // S型映射：midPoint=1 时得5分，压力越高分越高
    // 压力0→2.3，0.5→3.5，1→5.0，3→8.5，5→9.8
    var midPoint = 1;
    var steepness = 1.2;
    var score = 10 / (1 + Math.exp(-steepness * (competitionPressure - midPoint)));

    return {
        score: Math.round(score * 10) / 10,
        count: countWithin1km,
        nearestDist: Math.round(nearestDist),
        nearestName: nearestName
    };
}

function getSelectedScoringHour() {
    var select = document.getElementById('scoringHourSelect');
    return select ? select.value : '14';
}

function computeCompositeScore(transport, population, landPrice, competition) {
    var wT = parseInt(document.getElementById('weightTransport').value) || 25;
    var wP = parseInt(document.getElementById('weightPopulation').value) || 25;
    var wL = parseInt(document.getElementById('weightLandPrice').value) || 25;
    var wC = parseInt(document.getElementById('weightCompetition').value) || 25;
    var totalW = wT + wP + wL + wC;

    if (totalW === 0) return 0;

    var composite = (wT * transport.score + wP * population.score + wL * landPrice.score + wC * competition.score) / totalW;
    return Math.round(composite * 10) / 10;
}

function renderScoringResult(lat, lng, transport, population, landPrice, competition, composite) {
    var resultCard = document.getElementById('scoringResultCard');
    var resultContent = document.getElementById('scoringResultContent');
    resultCard.style.display = '';

    var html = '';

    // 总分
    html += '<div class="scoring-total-score">';
    html += '  <span class="scoring-total-label">综合评分</span>';
    html += '  <span class="scoring-total-number">' + composite.toFixed(1) + '</span>';
    html += '  <span class="scoring-total-max">/ 10</span>';
    html += '</div>';

    // 四维度（不显示详情小字）
    html += '<div class="scoring-dimensions">';

    html += buildDimRow('fas fa-bus', 'dim-transport', '交通便利度', transport.score);
    html += buildDimRow('fas fa-users', 'dim-population', '人口密度', population.score);
    html += buildDimRow('fas fa-building', 'dim-landprice', '地价适宜度', landPrice.score);
    html += buildDimRow('fas fa-store', 'dim-competition', '竞争压力', competition.score);

    html += '</div>';

    // 坐标信息
    html += '<div class="scoring-coord-info">';
    html += '  <i class="fas fa-map-pin"></i> WGS84: ' + lat.toFixed(6) + ', ' + lng.toFixed(6);
    html += '</div>';

    resultContent.innerHTML = html;
}

function buildDimRow(icon, dimClass, name, score) {
    var pct = (score / 10) * 100;
    return '<div class="scoring-dim-row">' +
        '<div class="scoring-dim-icon ' + dimClass + '"><i class="' + icon + '"></i></div>' +
        '<div class="scoring-dim-info">' +
        '  <div class="scoring-dim-name">' + name + '</div>' +
        '  <div class="scoring-bar"><div class="scoring-bar-fill ' + dimClass + '" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<div class="scoring-dim-score">' + score.toFixed(1) + '</div>' +
        '</div>';
}

async function performScoring(latlng) {
    var lat = latlng.lat;
    var lng = latlng.lng;

    await loadScoringData();

    var transport = scoreTransport(lat, lng);
    var population = scorePopulation(lat, lng);
    var landPrice = scoreLandPrice(lat, lng);
    var competition = scoreCompetition(lat, lng);
    var composite = computeCompositeScore(transport, population, landPrice, competition);

    // 存储选址结果
    scoringResults[currentScoringRound] = {
        lat: lat,
        lng: lng,
        transport: transport,
        population: population,
        landPrice: landPrice,
        competition: competition,
        composite: composite
    };

    renderScoringResult(lat, lng, transport, population, landPrice, competition, composite);

    // 根据当前选址轮次使用不同的颜色和变量
    if (currentScoringRound === 1) {
        // 第一次选址 - 蓝色
        if (scoringMarker1) {
            map.removeLayer(scoringMarker1);
        }
        if (scoringCircle1) {
            map.removeLayer(scoringCircle1);
        }

        scoringCircle1 = L.circle([lat, lng], {
            radius: SCORING_RADIUS_M,
            color: '#2f6fff',
            fillColor: '#2f6fff',
            fillOpacity: 0.08,
            weight: 2,
            dashArray: '6 4'
        }).addTo(map);

        scoringMarker1 = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'scoring-marker-icon',
                html: '<div style="background:linear-gradient(135deg,#2f6fff,#89b7ff);width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:16px;font-weight:800;box-shadow:0 3px 12px rgba(47,111,255,0.35);border:3px solid #fff;">1</div>',
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            })
        }).addTo(map);

        scoringMarker1.bindPopup(
            '<div class="custom-popup"><strong>候选烘焙店选址 #1</strong>' +
            '<p>综合评分：<b>' + composite.toFixed(1) + ' / 10</b></p>' +
            '<p>WGS84：' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</p></div>'
        );

        // 提示用户进行第二次选址
        document.getElementById('scoringHint').textContent = '第一次选址完成，请再次点击地图进行第二次选址';
        currentScoringRound = 2;
    } else {
        // 第二次选址 - 绿色
        if (scoringMarker2) {
            map.removeLayer(scoringMarker2);
        }
        if (scoringCircle2) {
            map.removeLayer(scoringCircle2);
        }

        scoringCircle2 = L.circle([lat, lng], {
            radius: SCORING_RADIUS_M,
            color: '#22c55e',
            fillColor: '#22c55e',
            fillOpacity: 0.08,
            weight: 2,
            dashArray: '6 4'
        }).addTo(map);

        scoringMarker2 = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'scoring-marker-icon',
                html: '<div style="background:linear-gradient(135deg,#22c55e,#86efac);width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:16px;font-weight:800;box-shadow:0 3px 12px rgba(34,197,94,0.35);border:3px solid #fff;">2</div>',
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            })
        }).addTo(map);

        scoringMarker2.bindPopup(
            '<div class="custom-popup"><strong>候选烘焙店选址 #2</strong>' +
            '<p>综合评分：<b>' + composite.toFixed(1) + ' / 10</b></p>' +
            '<p>WGS84：' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</p></div>'
        );

        // 显示两次选址对比结果
        showScoringComparison();
        document.getElementById('scoringHint').textContent = '两次选址完成，已显示对比结果';
    }

    document.getElementById('clearScoringBtn').style.display = '';

    return { transport: transport, population: population, landPrice: landPrice, competition: competition, composite: composite };
}

function clearScoring() {
    // 清除第一次选址结果
    if (scoringMarker1) {
        map.removeLayer(scoringMarker1);
        scoringMarker1 = null;
    }
    if (scoringCircle1) {
        map.removeLayer(scoringCircle1);
        scoringCircle1 = null;
    }
    
    // 清除第二次选址结果
    if (scoringMarker2) {
        map.removeLayer(scoringMarker2);
        scoringMarker2 = null;
    }
    if (scoringCircle2) {
        map.removeLayer(scoringCircle2);
        scoringCircle2 = null;
    }
    
    // 重置选址轮次和结果
    currentScoringRound = 1;
    scoringResults = {};
    
    document.getElementById('scoringResultCard').style.display = 'none';
    document.getElementById('clearScoringBtn').style.display = 'none';
    document.getElementById('scoringHint').textContent = '点击地图任意位置，选择烘焙店候选点进行评分';
}

// 显示两次选址对比结果
function showScoringComparison() {
    if (!scoringResults[1] || !scoringResults[2]) return;
    
    const result1 = scoringResults[1];
    const result2 = scoringResults[2];
    
    const comparisonHtml = `
        <div class="scoring-comparison">
            <h4>选址对比结果</h4>
            <div class="scoring-comparison-grid">
                <div class="scoring-comparison-item">
                    <div class="scoring-comparison-label">选址 #1 (蓝色)</div>
                    <div class="scoring-comparison-score">${result1.composite.toFixed(1)}</div>
                </div>
                <div class="scoring-comparison-item">
                    <div class="scoring-comparison-label">选址 #2 (绿色)</div>
                    <div class="scoring-comparison-score">${result2.composite.toFixed(1)}</div>
                </div>
            </div>
            <div class="scoring-comparison-winner">
                ${result1.composite > result2.composite ? 
                    '选址 #1 (蓝色) 综合评分更高' : 
                    result2.composite > result1.composite ? 
                    '选址 #2 (绿色) 综合评分更高' : 
                    '两次选址评分相同'}
            </div>
        </div>
    `;
    
    // 确保评分结果卡片显示
    document.getElementById('scoringResultCard').style.display = 'block';
    
    // 在评分结果下方添加对比信息
    const scoringResultContent = document.getElementById('scoringResultContent');
    if (scoringResultContent) {
        // 检查是否已经存在对比结果，如果存在则更新
        let comparisonDiv = document.querySelector('.scoring-comparison');
        if (comparisonDiv) {
            comparisonDiv.innerHTML = comparisonHtml;
        } else {
            // 创建新的对比结果容器
            const newComparisonDiv = document.createElement('div');
            newComparisonDiv.innerHTML = comparisonHtml;
            scoringResultContent.appendChild(newComparisonDiv);
        }
    }
}

function setScoringMode(active) {
    scoringMode = active;
    var startBtn = document.getElementById('startScoringBtn');
    var hint = document.getElementById('scoringHint');
    var mapEl = document.getElementById('map');

    if (active) {
        startBtn.innerHTML = '<i class="fas fa-stop"></i> 停止选址';
        startBtn.classList.remove('btn-primary');
        startBtn.classList.add('btn-danger');
        hint.textContent = '选址模式已开启 —— 点击地图选择候选位置';
        mapEl.style.cursor = 'crosshair';
    } else {
        startBtn.innerHTML = '<i class="fas fa-location-crosshairs"></i> 开始选址';
        startBtn.classList.remove('btn-danger');
        startBtn.classList.add('btn-primary');
        hint.textContent = '点击地图任意位置，选择烘焙店候选点进行评分';
        mapEl.style.cursor = '';
    }
}

function renderScoringHourSelect() {
    var select = document.getElementById('scoringHourSelect');
    if (!select) return;
    select.innerHTML = '';
    POPULATION_HOURS.forEach(function(hour) {
        var opt = document.createElement('option');
        opt.value = hour;
        opt.textContent = hour + ':00';
        if (hour === '14') opt.selected = true;
        select.appendChild(opt);
    });
}

function initScoringControls() {
    renderScoringHourSelect();

    document.getElementById('startScoringBtn').addEventListener('click', function() {
        setScoringMode(!scoringMode);
    });

    document.getElementById('clearScoringBtn').addEventListener('click', function() {
        clearScoring();
    });

    // 权重滑块值显示
    ['weightTransport', 'weightPopulation', 'weightLandPrice', 'weightCompetition'].forEach(function(id) {
        var slider = document.getElementById(id);
        var valueEl = document.getElementById(id + 'Value');
        if (slider && valueEl) {
            slider.addEventListener('input', function() {
                valueEl.textContent = this.value;
                // 如果已有选址，重新计算
                if (scoringResults[1]) {
                    performScoring(L.latLng(scoringResults[1].lat, scoringResults[1].lng));
                } else if (scoringResults[2]) {
                    performScoring(L.latLng(scoringResults[2].lat, scoringResults[2].lng));
                }
            });
        }
    });

    // 评分时段变化
    var scoringHourEl = document.getElementById('scoringHourSelect');
    if (scoringHourEl) {
        scoringHourEl.addEventListener('change', function() {
            var hour = this.value;
            ensurePopulationHourLoaded(hour).then(function() {
                if (scoringResults[1]) {
                    performScoring(L.latLng(scoringResults[1].lat, scoringResults[1].lng));
                } else if (scoringResults[2]) {
                    performScoring(L.latLng(scoringResults[2].lat, scoringResults[2].lng));
                }
            });
        });
    }

    // 地图点击事件
    map.on('click', function(e) {
        if (!scoringMode) return;
        document.getElementById('scoringHint').textContent = '正在计算评分...';
        performScoring(e.latlng);
    });
}

// ====== AI助手功能 ======
function initAIAssistant() {
    const aiAssistantBtn = document.getElementById('aiAssistantBtn');
    const aiAssistant = document.getElementById('aiAssistant');
    const closeAIAssistant = document.getElementById('closeAIAssistant');
    const aiAssistantInput = document.getElementById('aiAssistantInput');
    const sendAIMessage = document.getElementById('sendAIMessage');
    const aiAssistantBody = document.getElementById('aiAssistantBody');

    // 显示AI助手悬浮按钮
    if (aiAssistantBtn) {
        aiAssistantBtn.style.display = 'grid';
    }

    // 打开AI助手
    if (aiAssistantBtn && aiAssistant) {
        aiAssistantBtn.addEventListener('click', function() {
            aiAssistant.style.display = 'flex';
            aiAssistantBtn.style.display = 'none';
        });
    }

    // 关闭AI助手
    if (closeAIAssistant && aiAssistant && aiAssistantBtn) {
        closeAIAssistant.addEventListener('click', function() {
            aiAssistant.style.display = 'none';
            aiAssistantBtn.style.display = 'grid';
        });
    }

    // 发送消息
    function sendMessage() {
        const message = aiAssistantInput.value.trim();
        if (!message) return;

        // 添加用户消息
        addMessage('user', message);
        aiAssistantInput.value = '';

        // 生成AI回复
        setTimeout(() => {
            const response = generateAIResponse(message);
            addMessage('ai', response);
        }, 500);
    }

    // 发送按钮点击事件
    if (sendAIMessage) {
        sendAIMessage.addEventListener('click', sendMessage);
    }

    // 回车键发送
    if (aiAssistantInput) {
        aiAssistantInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    }

    // 添加消息到聊天窗口
    function addMessage(type, content) {
        if (!aiAssistantBody) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = type === 'user' ? 'user-message' : 'ai-message';

        const messageContent = document.createElement('div');
        messageContent.className = type === 'user' ? 'user-message-content' : 'ai-message-content';
        messageContent.innerHTML = `<p>${content}</p>`;

        messageDiv.appendChild(messageContent);
        aiAssistantBody.appendChild(messageDiv);

        // 滚动到底部
        aiAssistantBody.scrollTop = aiAssistantBody.scrollHeight;
    }

    // 生成AI回复
    function generateAIResponse(message) {
        message = message.toLowerCase();

        // 基于选址评分结果的回复
        if (scoringResults[1] || scoringResults[2]) {
            const scoringResult = document.getElementById('scoringResultContent');
            if (scoringResult) {
                const totalScore = scoringResult.querySelector('.scoring-total-number');
                if (totalScore) {
                    const score = parseFloat(totalScore.textContent);
                    
                    if (message.includes('评分') || message.includes('选址') || message.includes('怎么样')) {
                        // 获取当前选址结果
                        let currentResult;
                        if (scoringResults[2]) {
                            currentResult = scoringResults[2];
                        } else if (scoringResults[1]) {
                            currentResult = scoringResults[1];
                        } else {
                            return `该位置综合评分为 ${score} 分，适合开设烘焙店。各方面条件较为均衡，可以考虑。`;
                        }
                        
                        if (score >= 8) {
                            return `该位置综合评分为 ${score} 分，非常适合开设烘焙店。\n\n分析详情：\n- 交通便利度：${currentResult.transport.score.toFixed(1)} 分\n- 人口密度：${currentResult.population.score.toFixed(1)} 分\n- 地价适宜度：${currentResult.landPrice.score.toFixed(1)} 分\n- 竞争压力：${currentResult.competition.score.toFixed(1)} 分\n\n优势：交通便利，人口密度高，地价适宜，竞争压力适中。\n建议：优先考虑此位置，可作为主要候选选址。`;
                        } else if (score >= 6) {
                            return `该位置综合评分为 ${score} 分，适合开设烘焙店。\n\n分析详情：\n- 交通便利度：${currentResult.transport.score.toFixed(1)} 分\n- 人口密度：${currentResult.population.score.toFixed(1)} 分\n- 地价适宜度：${currentResult.landPrice.score.toFixed(1)} 分\n- 竞争压力：${currentResult.competition.score.toFixed(1)} 分\n\n优势：各方面条件较为均衡，没有明显劣势。\n建议：可以考虑此位置，作为候选选址之一。`;
                        } else {
                            return `该位置综合评分为 ${score} 分，建议谨慎考虑。\n\n分析详情：\n- 交通便利度：${currentResult.transport.score.toFixed(1)} 分\n- 人口密度：${currentResult.population.score.toFixed(1)} 分\n- 地价适宜度：${currentResult.landPrice.score.toFixed(1)} 分\n- 竞争压力：${currentResult.competition.score.toFixed(1)} 分\n\n劣势：可能在交通、人口密度或其他方面存在不足。\n建议：可以尝试在周边寻找更合适的位置，或考虑改善现有条件。`;
                        }
                    }
                }
            }
            
            // 两次选址的对比分析
            if (scoringResults[1] && scoringResults[2] && (message.includes('对比') || message.includes('哪个好') || message.includes('比较'))) {
                const result1 = scoringResults[1];
                const result2 = scoringResults[2];
                const score1 = result1.composite;
                const score2 = result2.composite;
                
                if (score1 > score2) {
                    return `选址对比分析：\n\n选址 #1 (蓝色)：综合评分 ${score1.toFixed(1)} 分\n- 交通便利度：${result1.transport.score.toFixed(1)} 分\n- 人口密度：${result1.population.score.toFixed(1)} 分\n- 地价适宜度：${result1.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result1.competition.score.toFixed(1)} 分\n\n选址 #2 (绿色)：综合评分 ${score2.toFixed(1)} 分\n- 交通便利度：${result2.transport.score.toFixed(1)} 分\n- 人口密度：${result2.population.score.toFixed(1)} 分\n- 地价适宜度：${result2.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result2.competition.score.toFixed(1)} 分\n\n结论：选址 #1 的评分更高，更适合开设烘焙店。建议优先考虑选址 #1。`;
                } else if (score2 > score1) {
                    return `选址对比分析：\n\n选址 #1 (蓝色)：综合评分 ${score1.toFixed(1)} 分\n- 交通便利度：${result1.transport.score.toFixed(1)} 分\n- 人口密度：${result1.population.score.toFixed(1)} 分\n- 地价适宜度：${result1.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result1.competition.score.toFixed(1)} 分\n\n选址 #2 (绿色)：综合评分 ${score2.toFixed(1)} 分\n- 交通便利度：${result2.transport.score.toFixed(1)} 分\n- 人口密度：${result2.population.score.toFixed(1)} 分\n- 地价适宜度：${result2.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result2.competition.score.toFixed(1)} 分\n\n结论：选址 #2 的评分更高，更适合开设烘焙店。建议优先考虑选址 #2。`;
                } else {
                    return `选址对比分析：\n\n选址 #1 (蓝色)：综合评分 ${score1.toFixed(1)} 分\n- 交通便利度：${result1.transport.score.toFixed(1)} 分\n- 人口密度：${result1.population.score.toFixed(1)} 分\n- 地价适宜度：${result1.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result1.competition.score.toFixed(1)} 分\n\n选址 #2 (绿色)：综合评分 ${score2.toFixed(1)} 分\n- 交通便利度：${result2.transport.score.toFixed(1)} 分\n- 人口密度：${result2.population.score.toFixed(1)} 分\n- 地价适宜度：${result2.landPrice.score.toFixed(1)} 分\n- 竞争压力：${result2.competition.score.toFixed(1)} 分\n\n结论：两次选址的综合评分相同，均为 ${score1.toFixed(1)} 分。两个位置都适合开设烘焙店，您可以根据其他因素（如租金、周边环境、个人偏好等）进行选择。`;
                }
            }
        }

        // 通用回复
        if (message.includes('你好') || message.includes('嗨') || message.includes('Hello')) {
            return '您好！我是选址AI助手，很高兴为您服务。我可以帮您分析选址的可行性，提供专业的选址建议，以及对比不同选址的优劣。请问您需要了解什么？';
        } else if (message.includes('功能') || message.includes('能做什么')) {
            return '我是一个专业的选址分析AI助手，主要功能包括：\n1. 基于交通便利度、人口密度、地价适宜度和竞争压力四个维度进行选址评分\n2. 提供详细的评分分析和改进建议\n3. 支持两次选址对比分析\n4. 回答关于选址的各类问题\n5. 提供选址相关的专业知识和建议\n\n您可以通过点击地图选择位置，然后向我咨询关于该位置的分析结果。';
        } else if (message.includes('评分标准') || message.includes('如何评分')) {
            return '评分标准基于四个核心维度：\n\n1. 交通便利度（30%）：\n   - 公交站密度和距离\n   - 地铁站密度和距离\n   - 主要道路通达度\n\n2. 人口密度（30%）：\n   - 周边人口数量\n   - 人口密度分布\n   - 人口流动趋势\n\n3. 地价适宜度（20%）：\n   - 周边地价水平\n   - 与商业中心的距离\n   - 区域发展潜力\n\n4. 竞争压力（20%）：\n   - 周边同类店铺数量\n   - 竞争强度分析\n   - 市场饱和度\n\n综合评分范围为0-10分，评分越高表示位置越适合开设烘焙店。';
        } else if (message.includes('交通') || message.includes('公交') || message.includes('地铁')) {
            return '交通便利度是选址的重要因素之一，主要考虑：\n1. 公交站和地铁站的密度和距离\n2. 主要道路的通达度\n3. 交通流量和便利性\n\n一般来说，距离公交站500米内、地铁站800米内的位置交通便利性较好。';
        } else if (message.includes('人口') || message.includes('客流')) {
            return '人口密度是影响烘焙店生意的关键因素：\n1. 周边常住人口数量\n2. 流动人口数量\n3. 人口结构和消费能力\n\n建议选择人口密度较高、消费能力较强的区域，如商业区、居民区、办公区等。';
        } else if (message.includes('地价') || message.includes('租金')) {
            return '地价适宜度需要综合考虑：\n1. 租金成本与预算的匹配度\n2. 区域发展潜力\n3. 与商业中心的距离\n\n理想的位置应该是租金合理，同时具有良好的发展前景。';
        } else if (message.includes('竞争') || message.includes('同行')) {
            return '竞争压力分析：\n1. 周边同类店铺的数量和分布\n2. 竞争对手的实力和特色\n3. 市场饱和度\n\n适度的竞争可以促进市场活跃，但过度竞争可能影响生意。建议选择竞争适度的区域。';
        } else if (message.includes('如何选择') || message.includes('建议')) {
            return '选择烘焙店位置的建议：\n1. 优先考虑交通便利、人口密度高的区域\n2. 注意租金成本与预期收益的平衡\n3. 分析周边竞争情况，避免过度竞争\n4. 考虑目标客户群体的需求和消费习惯\n5. 关注区域发展潜力和未来规划\n\n您可以使用系统的选址评分功能，通过点击地图选择位置，获取详细的评分分析。';
        } else {
            return '感谢您的咨询。我是一个专业的选址分析AI助手，可以为您提供以下帮助：\n1. 分析选址的可行性和评分\n2. 对比不同选址的优劣\n3. 解答关于选址的各类问题\n4. 提供专业的选址建议\n\n请问您对当前选址有什么具体问题，或者需要了解更多关于选址分析的信息吗？';
        }
    }
}

document.addEventListener('DOMContentLoaded', function() {
    initResponsiveLayout();
    initSidebarToggle();
    initViewSwitcher();
    initMap();
    initScoringControls();
    initHeatmapControls();
    initPopulationTimeControls();
    initUiEnhancements();
    initAIAssistant();

    document.getElementById('kmlFileInput').addEventListener('change', handleKMLFile);

    setSystemStatus('正在加载人口CSV与预置KML资源...', 'loading');
    loadInitialDataResources();
});

if (typeof L.GeometryUtil === 'undefined') {
    L.GeometryUtil = {
        geodesicArea: function(latlngs) {
            const pointsCount = latlngs.length;
            let area = 0.0;

            if (pointsCount > 2) {
                for (let i = 0; i < pointsCount; i++) {
                    const j = (i + 1) % pointsCount;
                    const p1 = latlngs[i];
                    const p2 = latlngs[j];
                    area += L.Util.rad(p2.lng - p1.lng) * Math.sin(L.Util.rad(p2.lat));
                }

                area = area * 6378137.0 * 6378137.0 / 2.0;
            }

            return Math.abs(area);
        }
    };
}
