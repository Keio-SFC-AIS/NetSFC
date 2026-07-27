import { boundCheck } from './measure_page.js';

const MAP_CONFIG = {
    center: [35.388228020107945, 139.42707616563885],
    zoom: 18.5,
    minZoom: 10,
    maxZoom: 22,
};

const POI_ICONS = {
    washroom: '🚻',
    garbage: '🗑️',
    printer: '🖨️',
    water_fountain: '🚰',
    restaurants: '🍽️',
    elevator: '🛗',
    accessible_washroom: '♿',
    vending_machine: '🥤',
    aed: '❤️',
    statue: '⭐',
    building: '🏢'
};

const LABEL_ZOOM_THRESHOLD = 21;
const GLOBAL_AMENITY_TYPES = ['aed', 'restaurants', 'accessible_washroom', 'washroom', 'elevator', 'water_fountain', 'printer', 'vending_machine'];
const GLOBAL_AMENITY_MAX_ICONS = 5;
const GLOBAL_AMENITY_MIN_ZOOM = 15.5;
const GLOBAL_AMENITY_MAX_ZOOM = 19.5;
const CROSS_FLOOR_VISIBLE_TYPES = ['elevator'];
const ALWAYS_VISIBLE_TYPES = ['statue'];
const REGION_THEME_STYLES = {
    teaching: { color: '#3f6f8c', fillColor: '#8fb2c7' },
    library: { color: '#456b4f', fillColor: '#96b79a' },
    conference: { color: '#7d5d3f', fillColor: '#c5a98a' },
    administration: { color: '#7b4f5f', fillColor: '#c39aaa' },
    graduate: { color: '#585b88', fillColor: '#9ea3d3' },
    lifestyle: { color: '#8a6840', fillColor: '#d4b288' },
    research: { color: '#5a6e57', fillColor: '#9eb197' },
    default: { color: '#2f6f67', fillColor: '#7fb3a8' },
};
const BUILDING_REGION_THEME = {
    'kappa building': 'teaching',
    'epsilon building': 'teaching',
    'iota building': 'teaching',
    'omicron building': 'teaching',
    'lambda building': 'teaching',
    'media center': 'library',
    'theta building': 'conference',
    'alpha building': 'administration',
    'omega building': 'graduate',
    'tau building': 'graduate',
    'sigma building': 'lifestyle',
    'delta building': 'research',
};
const BUILDING_REGION_STYLE = {
    weight: 1.6,
    fillOpacity: 0.24,
};
const SHARED_REGION_STYLE = {
    weight: 1.5,
    fillOpacity: 0.20,
};
const REGION_HOVER_FILL_OPACITY = 0.40;
const DETAIL_PANEL_BASE_LEFT = 388;
const DETAIL_PANEL_WIDTH = 380;
const DETAIL_PANEL_GAP = 16;
const MEDIUM_LAYOUT_BREAKPOINT = 1100;
const MOBILE_LAYOUT_BREAKPOINT = 600;
const HEATMAP_DEFAULT_LOOKBACK_HOURS = 168;
const HEATMAP_DEFAULT_LIMIT = 10000;
const HEATMAP_MAX_POINTS = 12000;
const HEATMAP_WS_RECONNECT_MS = 2000;
const HEATMAP_WS_PING_MS = 25000;
// Zoom level at which heat points render at full intensity. leaflet.heat fades
// points out the further the current zoom is from this value, so it should sit
// near the map's everyday viewing zoom (MAP_CONFIG.zoom), not the map's maxZoom -
// using maxZoom (22) here crushed intensity to ~6% opacity at the default zoom.
const HEATMAP_INTENSITY_REFERENCE_ZOOM = 17;
const HEATMAP_TIMELINE_LOOKBACK_HOURS = 6;
const HEATMAP_TIMELINE_BUCKET_MINUTES = 15;
const HEATMAP_TIMELINE_REFRESH_MS = 60000;
const HEATMAP_TIMELINE_PLAY_INTERVAL_MS = 900;

let map;
let heatLayer;
let baseTileLayer;
let heatPoints = [];
let heatmapSocket = null;
let heatmapWsRetryTimer = null;
let heatmapWsPingTimer = null;
let layerControl = null;
let timelineFrames = [];
let timelineIsLive = true;
let timelinePlayTimer = null;
let timelineRefreshTimer = null;
let timelineEls = null;
let buildingAliasLayerGroup = null;
let buildingAliasMarkers = [];
let buildingAmenityLayerGroup = null;
let buildingAmenityMarkers = [];
let sharedConnectorLayerGroup = null;
let alwaysVisibleLayerGroup = null;

let userLocationMarker = null;
let userAccuracyCircle = null;
let currentUserLatLng = null;
let isFirstLocation = true;

let allPointFacilities = []; 
let itemLayerGroup = null; 
let categoryFilterLayerGroup = null; 

let currentBuildingFloors = [];
let currentFloorItems = [];  
let activeItemFilter = null;
let allRawFacilities = [];
let currentSelectedFloor = null;
let detailPanelOrder = [];


window.onload = function() {
    map = L.map('map', {
        center: MAP_CONFIG.center,
        zoom: MAP_CONFIG.zoom,
        minZoom: MAP_CONFIG.minZoom,
        maxZoom: MAP_CONFIG.maxZoom,

        rotate: true,
        bearing: 79,
        rotateControl: false,

        zoomControl: false,
        zoomAnimation: true,
        fadeAnimation: true,
        markerZoomAnimation: true,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 80,

        inertia: true,
        inertiaDeceleration: 2000,
        inertiaMaxSpeed: 1500,
    });

    const norotateContainer = map.getPane('norotatePane') || map.getContainer();
    let heatmapPane = map.getPane('heatmapPane');
    if (!heatmapPane) {
        heatmapPane = map.createPane('heatmapPane', norotateContainer);
    }
    heatmapPane.style.zIndex = 450;
    heatmapPane.style.pointerEvents = 'none';

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    baseTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: MAP_CONFIG.maxZoom,
        maxNativeZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: false,
    }).addTo(map);

    heatLayer = L.heatLayer(heatPoints, {
        pane: 'heatmapPane',
        radius: 35,
        blur: 25,
        maxZoom: HEATMAP_INTENSITY_REFERENCE_ZOOM,
        minOpacity: 0.3,
        gradient: {
            0.1: '#9ca3af',
            0.55: '#f59e0b',
            1.0: '#ef4444'
        }
    });

    // leaflet.heat@0.2.0 hardcodes overlayPane in onAdd/onRemove and ignores the
    // `pane` option entirely, so without this override the canvas lands inside
    // leaflet-rotate's rotated pane and every point renders in the wrong place.
    heatLayer.onAdd = function (targetMap) {
        this._map = targetMap;
        if (!this._canvas) this._initCanvas();
        const targetPane = targetMap.getPane(this.options.pane) || targetMap.getPane('overlayPane');
        targetPane.appendChild(this._canvas);
        targetMap.on('moveend', this._reset, this);
        if (targetMap.options.zoomAnimation && L.Browser.any3d) {
            targetMap.on('zoomanim', this._animateZoom, this);
        }
        this._reset();
    };

    heatLayer.onRemove = function (targetMap) {
        const targetPane = targetMap.getPane(this.options.pane) || targetMap.getPane('overlayPane');
        if (targetPane && this._canvas && this._canvas.parentNode === targetPane) {
            targetPane.removeChild(this._canvas);
        }
        targetMap.off('moveend', this._reset, this);
        if (targetMap.options.zoomAnimation) {
            targetMap.off('zoomanim', this._animateZoom, this);
        }
    };

    // setLatLngs()/addLatLng() (unmodified plugin methods, used by applyHeatLayerPoints)
    // schedule _redraw via requestAnimationFrame instead of calling it synchronously.
    // If the layer is removed from the map (e.g. the timeline switches back to live
    // right as the heatmap gets toggled off) before that frame fires, Map.removeLayer
    // has already set this._map to null by then, and the plugin's own _redraw has no
    // guard for that - it crashes on this._map.getSize(). Wrap it with the same guard
    // _reset uses above.
    const pluginRedraw = heatLayer._redraw;
    heatLayer._redraw = function () {
        if (!this._map) return;
        pluginRedraw.call(this);
    };

    heatLayer._reset = function () {
        if (!this._map) return;
        // heatmapPane only inherits the map pane's own pan translate (no rotation).
        // `containerPointToLayerPoint` is unreliable here because leaflet-rotate
        // patches it to also fold in the bearing rotation, which doesn't apply to
        // this unrotated pane and produced wildly wrong offsets. `_getMapPanePos()`
        // reads the map pane's raw translate directly, so negating it reliably
        // cancels the outer offset regardless of bearing. Hardcoding position to
        // (0,0) (the previous approach) left the canvas shifted by that pan
        // offset, which is why the heat never appeared on screen.
        L.DomUtil.setPosition(this._canvas, this._map._getMapPanePos().multiplyBy(-1));

        var size = this._map.getSize();
        if (this._heat._width !== size.x) {
            this._canvas.width = this._heat._width = size.x;
        }
        if (this._heat._height !== size.y) {
            this._canvas.height = this._heat._height = size.y;
        }

        this._redraw();
    };

    // The plugin's built-in zoom-anim transform assumes the rotated overlayPane;
    // skip it and let the full _reset() from the listener below take over instead.
    heatLayer._animateZoom = function () {};

    heatLayer.addTo(map);

    map.on('move rotate zoom resetview', () => {
        if (heatLayer && heatLayer._map) {
            heatLayer._reset();
        }
    });

    map.on('zoomend', () => {
        updateLabelVisibility();
        updateBuildingAliasLabelSizes();
        updateBuildingAmenityVisibility();
    });

    updateLabelVisibility();
    loadPOIs();
    initGeolocation();
    initSettingsModal();
    initCategoryChips();
    initClassroomPanel();
    initItemPanel();
    initHeatmapLayerControls();
    initHeatmapSettingsToggle();
    initHeatmapTimelineControls();
    loadHeatmapSnapshot();
    connectHeatmapWebSocket();
    window.addEventListener('resize', updateDetailPanelPositions);
    window.addEventListener('beforeunload', () => {
        teardownHeatmapWebSocket();
        stopTimelinePlayback();
        if (timelineRefreshTimer) clearInterval(timelineRefreshTimer);
    });
};

function initHeatmapLayerControls() {
    if (!map || !heatLayer || !baseTileLayer) return;
    if (layerControl) {
        map.removeControl(layerControl);
    }

    layerControl = L.control.layers(
        { 'Campus Map': baseTileLayer },
        { Heatmap: heatLayer },
        { position: 'bottomright', collapsed: true }
    ).addTo(map);

    map.on('overlayadd', (event) => {
        if (event.layer !== heatLayer) return;
        syncHeatmapSettingCheckbox(true);
        showHeatmapTimeline();
    });

    map.on('overlayremove', (event) => {
        if (event.layer !== heatLayer) return;
        syncHeatmapSettingCheckbox(false);
        hideHeatmapTimeline();
    });
}

function initHeatmapSettingsToggle() {
    const heatmapSetting = document.getElementById('setting-heatmap');
    if (!heatmapSetting) return;

    heatmapSetting.checked = map.hasLayer(heatLayer);
    heatmapSetting.addEventListener('change', () => {
        toggleHeatmapLayer(heatmapSetting.checked);
    });
}

function syncHeatmapSettingCheckbox(isOn) {
    const heatmapSetting = document.getElementById('setting-heatmap');
    if (!heatmapSetting) return;
    heatmapSetting.checked = isOn;
}

function toggleHeatmapLayer(shouldShow) {
    if (!map || !heatLayer) return;
    if (shouldShow && !map.hasLayer(heatLayer)) {
        heatLayer.addTo(map);
    } else if (!shouldShow && map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
    }
}

function toWsUrl(apiHost) {
    const sanitized = (apiHost || '').replace(/\/$/, '');
    if (sanitized.startsWith('https://')) return sanitized.replace('https://', 'wss://');
    if (sanitized.startsWith('http://')) return sanitized.replace('http://', 'ws://');
    return `ws://${sanitized}`;
}

function normalizeHeatmapPoint(point) {
    if (!point || !Array.isArray(point.coords) || point.coords.length !== 2) return null;
    const lat = Number(point.coords[0]);
    const lng = Number(point.coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const rawWeight = Number(point.weight);
    const weight = Number.isFinite(rawWeight) ? Math.max(0, Math.min(1, rawWeight)) : 0.2;
    return [lat, lng, weight];
}

function applyHeatLayerPoints(points) {
    if (!heatLayer) return;
    heatLayer.setLatLngs(points);
    if (heatLayer._map) {
        heatLayer._reset();
    }
}

function renderHeatmapPoints(points) {
    heatPoints = points.slice(-HEATMAP_MAX_POINTS);
    if (timelineIsLive) {
        applyHeatLayerPoints(heatPoints);
    }
}

function addHeatmapPoint(pointData) {
    const normalized = normalizeHeatmapPoint(pointData);
    if (!normalized) return;
    heatPoints.push(normalized);
    if (heatPoints.length > HEATMAP_MAX_POINTS) {
        heatPoints = heatPoints.slice(heatPoints.length - HEATMAP_MAX_POINTS);
    }
    if (timelineIsLive) {
        applyHeatLayerPoints(heatPoints);
    }
}

function updateTimelineLabel(frame) {
    if (!timelineEls) return;
    if (!frame) {
        timelineEls.label.textContent = 'Live';
        timelineEls.container.classList.add('live');
        return;
    }
    timelineEls.container.classList.remove('live');
    const frameDate = new Date(frame.frame_start_ts);
    timelineEls.label.textContent = Number.isNaN(frameDate.getTime())
        ? frame.frame_start_ts
        : frameDate.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderTimelineFrame(index) {
    const frame = timelineFrames[index];
    if (!frame) return;
    const normalizedPoints = (frame.points || []).map(normalizeHeatmapPoint).filter(Boolean);
    applyHeatLayerPoints(normalizedPoints);
    updateTimelineLabel(frame);
}

function stopTimelinePlayback() {
    if (timelinePlayTimer) {
        clearInterval(timelinePlayTimer);
        timelinePlayTimer = null;
    }
    if (timelineEls) timelineEls.playBtn.textContent = '▶';
}

function jumpToLive() {
    timelineIsLive = true;
    stopTimelinePlayback();
    if (timelineEls && timelineFrames.length > 0) {
        timelineEls.slider.value = String(timelineFrames.length - 1);
    }
    updateTimelineLabel(null);
    applyHeatLayerPoints(heatPoints);
}

function onHeatmapTimelineInput() {
    if (!timelineEls || timelineFrames.length === 0) return;
    const index = Number(timelineEls.slider.value);
    if (index >= timelineFrames.length - 1) {
        jumpToLive();
        return;
    }
    stopTimelinePlayback();
    timelineIsLive = false;
    renderTimelineFrame(index);
}

function toggleTimelinePlayback() {
    if (timelinePlayTimer) {
        stopTimelinePlayback();
        return;
    }
    if (!timelineEls || timelineFrames.length === 0) return;

    timelineEls.playBtn.textContent = '⏸';
    timelineIsLive = false;
    let index = Number(timelineEls.slider.value);
    if (index >= timelineFrames.length - 1) index = 0;
    timelineEls.slider.value = String(index);
    renderTimelineFrame(index);

    timelinePlayTimer = setInterval(() => {
        index += 1;
        if (index >= timelineFrames.length) {
            stopTimelinePlayback();
            jumpToLive();
            return;
        }
        timelineEls.slider.value = String(index);
        renderTimelineFrame(index);
    }, HEATMAP_TIMELINE_PLAY_INTERVAL_MS);
}

async function loadHeatmapTimeline(preserveFrameStartTs) {
    if (!timelineEls) return;
    const apiHost = window.ENV.API_HOST.replace(/\/$/, '');
    const endDt = new Date();
    const startDt = new Date(endDt.getTime() - HEATMAP_TIMELINE_LOOKBACK_HOURS * 60 * 60 * 1000);
    const url = `${apiHost}/api/measurements/heatmap/timeline`
        + `?start_ts=${encodeURIComponent(startDt.toISOString())}`
        + `&end_ts=${encodeURIComponent(endDt.toISOString())}`
        + `&bucket_minutes=${HEATMAP_TIMELINE_BUCKET_MINUTES}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Heatmap timeline request failed: ${response.status}`);
        }
        const data = await response.json();
        timelineFrames = Array.isArray(data.frames) ? data.frames : [];
        timelineEls.slider.max = String(Math.max(0, timelineFrames.length - 1));

        if (timelineFrames.length === 0) return;

        if (timelineIsLive) {
            timelineEls.slider.value = String(timelineFrames.length - 1);
            return;
        }

        let targetIndex = timelineFrames.length - 1;
        if (preserveFrameStartTs) {
            const foundIndex = timelineFrames.findIndex(f => f.frame_start_ts === preserveFrameStartTs);
            if (foundIndex === -1) {
                jumpToLive();
                return;
            }
            targetIndex = foundIndex;
        }
        timelineEls.slider.value = String(targetIndex);
        renderTimelineFrame(targetIndex);
    } catch (error) {
        console.error('Failed to load heatmap timeline', error);
    }
}

function showHeatmapTimeline() {
    if (!timelineEls) return;
    timelineEls.container.classList.add('visible');
    loadHeatmapTimeline();

    if (timelineRefreshTimer) clearInterval(timelineRefreshTimer);
    timelineRefreshTimer = setInterval(() => {
        const selectedFrame = (!timelineIsLive) ? timelineFrames[Number(timelineEls.slider.value)] : null;
        loadHeatmapTimeline(selectedFrame ? selectedFrame.frame_start_ts : undefined);
    }, HEATMAP_TIMELINE_REFRESH_MS);
}

function hideHeatmapTimeline() {
    if (!timelineEls) return;
    timelineEls.container.classList.remove('visible');
    if (timelineRefreshTimer) {
        clearInterval(timelineRefreshTimer);
        timelineRefreshTimer = null;
    }
    stopTimelinePlayback();
    jumpToLive();
}

function initHeatmapTimelineControls() {
    const container = document.getElementById('heatmap-timeline');
    const slider = document.getElementById('heatmap-timeline-slider');
    const label = document.getElementById('heatmap-timeline-label');
    const playBtn = document.getElementById('heatmap-timeline-play-btn');
    const liveBtn = document.getElementById('heatmap-timeline-live-btn');
    if (!container || !slider || !label || !playBtn || !liveBtn) return;

    timelineEls = { container, slider, label, playBtn, liveBtn };

    slider.addEventListener('input', onHeatmapTimelineInput);
    playBtn.addEventListener('click', toggleTimelinePlayback);
    liveBtn.addEventListener('click', jumpToLive);

    updateTimelineLabel(null);

    if (map.hasLayer(heatLayer)) {
        showHeatmapTimeline();
    }
}

async function loadHeatmapSnapshot() {
    const apiHost = window.ENV.API_HOST.replace(/\/$/, '');
    const url = `${apiHost}/api/measurements/heatmap?lookback_hours=${HEATMAP_DEFAULT_LOOKBACK_HOURS}&limit=${HEATMAP_DEFAULT_LIMIT}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Heatmap snapshot request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
            throw new Error('Heatmap snapshot response is not an array');
        }
        const normalizedPoints = data
            .map(normalizeHeatmapPoint)
            .filter(Boolean);
        renderHeatmapPoints(normalizedPoints);
    } catch (error) {
        console.error('Failed to load heatmap snapshot', error);
    }
}

function teardownHeatmapWebSocket() {
    if (heatmapWsRetryTimer) {
        clearTimeout(heatmapWsRetryTimer);
        heatmapWsRetryTimer = null;
    }
    if (heatmapWsPingTimer) {
        clearInterval(heatmapWsPingTimer);
        heatmapWsPingTimer = null;
    }
    if (heatmapSocket) {
        heatmapSocket.onclose = null;
        try {
            heatmapSocket.close();
        } catch (error) {
            console.warn('Heatmap socket close error', error);
        }
        heatmapSocket = null;
    }
}

function connectHeatmapWebSocket() {
    teardownHeatmapWebSocket();
    const apiHost = window.ENV.API_HOST.replace(/\/$/, '');
    const wsUrl = `${toWsUrl(apiHost)}/ws/heatmap`;

    try {
        heatmapSocket = new WebSocket(wsUrl);
    } catch (error) {
        console.error('Failed to create heatmap WebSocket', error);
        heatmapWsRetryTimer = setTimeout(connectHeatmapWebSocket, HEATMAP_WS_RECONNECT_MS);
        return;
    }

    heatmapSocket.onopen = () => {
        if (heatmapWsPingTimer) clearInterval(heatmapWsPingTimer);
        heatmapWsPingTimer = setInterval(() => {
            if (heatmapSocket && heatmapSocket.readyState === WebSocket.OPEN) {
                heatmapSocket.send('ping');
            }
        }, HEATMAP_WS_PING_MS);
    };

    heatmapSocket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message && message.type === 'NEW_MEASUREMENT' && message.data) {
                addHeatmapPoint(message.data);
            }
        } catch (error) {
            console.warn('Invalid heatmap WebSocket message', error);
        }
    };

    heatmapSocket.onerror = (event) => {
        console.warn('Heatmap WebSocket error', event);
    };

    heatmapSocket.onclose = () => {
        if (heatmapWsPingTimer) {
            clearInterval(heatmapWsPingTimer);
            heatmapWsPingTimer = null;
        }
        heatmapWsRetryTimer = setTimeout(connectHeatmapWebSocket, HEATMAP_WS_RECONNECT_MS);
    };
}

function loadPOIs() {
    const url = `${window.ENV.API_HOST}/api/pois`;
    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status}`);
            }
            return response.json();
        })
        .then(facilities => {
            allRawFacilities = facilities;
            const { buildingItems, pointItems, sharedConnectorAreas } = transformFacilities(facilities);
            allPointFacilities = pointItems;
            placeAlwaysVisibleItems(pointItems);
            placeSharedConnectorAreas(sharedConnectorAreas);
            placePOIs(buildingItems);
        })
        .catch(error => {
            console.error('Failed to load POIs', error);
        });
}

function normalizeLayerType(layerType) {
    if (typeof layerType !== 'string') return '';
    const normalized = layerType.trim().toLowerCase();
    if (normalized === 'place_to_eat' || normalized === 'place to eat') return 'restaurants';
    return normalized;
}

function isPointFacility(facility) {
    return Array.isArray(facility.coords)
        && facility.coords.length === 2
        && typeof facility.coords[0] === 'number'
        && typeof facility.coords[1] === 'number';
}

function normalizeBuildingName(name) {
    if (typeof name !== 'string') return '';
    const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized === 'mu building') return 'media center';
    if (normalized === 'media center') return 'media center';
    return normalized;
}

function isAlwaysVisibleFacility(facility) {
    return ALWAYS_VISIBLE_TYPES.includes(normalizeLayerType(facility.layer_type));
}

function getRegionThemeKey(buildingName) {
    const normalizedBuildingName = normalizeBuildingName(buildingName);
    return BUILDING_REGION_THEME[normalizedBuildingName] || 'default';
}

function getRegionStyle(buildingName, variant = 'building') {
    const theme = REGION_THEME_STYLES[getRegionThemeKey(buildingName)] || REGION_THEME_STYLES.default;
    const baseStyle = variant === 'shared' ? SHARED_REGION_STYLE : BUILDING_REGION_STYLE;
    return {
        ...baseStyle,
        color: theme.color,
        fillColor: theme.fillColor,
    };
}

function placeAlwaysVisibleItems(items) {
    if (alwaysVisibleLayerGroup) {
        map.removeLayer(alwaysVisibleLayerGroup);
    }
    alwaysVisibleLayerGroup = L.layerGroup().addTo(map);

    (items || []).forEach(item => {
        if (!isAlwaysVisibleFacility(item) || !isPointFacility(item)) return;

        const icon = POI_ICONS[normalizeLayerType(item.layer_type)] || '⭐';
        const labelText = item.name || 'landmark';
        const html = `
            <div class="poi-label always-visible-item">
                <span class="poi-icon">${icon}</span>
                <span class="poi-title always-visible-title">${labelText}</span>
            </div>
        `;

        const markerIcon = L.divIcon({
            html,
            className: 'poi-div-icon',
            iconSize: [200, 24],
            iconAnchor: [10, 12],
            popupAnchor: [0, -12],
        });

        L.marker([item.coords[0], item.coords[1]], { icon: markerIcon, interactive: true })
            .addTo(alwaysVisibleLayerGroup)
            .on('click', () => openItemPanel(item))
            .bindTooltip(labelText, {
                direction: 'top',
                offset: [0, -12],
                permanent: false,
                opacity: 0.85,
                className: 'poi-tooltip'
            });
    });
}

function placeSharedConnectorAreas(areas) {
    if (sharedConnectorLayerGroup) {
        map.removeLayer(sharedConnectorLayerGroup);
    }
    sharedConnectorLayerGroup = L.layerGroup().addTo(map);

    (areas || []).forEach(area => {
        if (!Array.isArray(area.coords) || area.coords.length < 3) return;

        L.polygon(area.coords, {
            ...getRegionStyle(area.buildingName || area.name, 'shared'),
            interactive: false
        }).addTo(sharedConnectorLayerGroup);
    });
}

function placePOIs(items) {
    if (buildingAliasLayerGroup) {
        map.removeLayer(buildingAliasLayerGroup);
    }
    if (buildingAmenityLayerGroup) {
        map.removeLayer(buildingAmenityLayerGroup);
    }
    buildingAliasLayerGroup = L.layerGroup().addTo(map);
    buildingAmenityLayerGroup = L.layerGroup().addTo(map);
    buildingAliasMarkers = [];
    buildingAmenityMarkers = [];

    items.forEach(item => {
        if (!item.coords || !Array.isArray(item.coords)) {
            console.warn('Skipping POI without coords:', item);
            return;
        }

        if (item.coords.length === 2 && typeof item.coords[0] === 'number' && typeof item.coords[1] === 'number') {
            const itemType = normalizeLayerType(item.layer_type);
            const icon = POI_ICONS[itemType] || '📍';
            const labelText = itemType.replace(/_/g, ' ');
            const html = `
                <div class="poi-label">
                    <span class="poi-icon">${icon}</span>
                    <span class="poi-title">${labelText}</span>
                </div>
            `;

            const poiIcon = L.divIcon({
                html,
                className: 'poi-div-icon',
                iconSize: [100, 24],
                iconAnchor: [8, 12],
                popupAnchor: [0, -12],
            });

            L.marker([item.coords[0], item.coords[1]], { icon: poiIcon, interactive: true })
                .addTo(map)
                .bindTooltip(labelText, {
                    direction: 'top',
                    offset: [0, -24],
                    permanent: false,
                    opacity: 0.85,
                    className: 'poi-tooltip'
                });
            return;
        }
        
        if (item.coords.length > 2 && Array.isArray(item.coords[0])) {
            const labelText = item.name || item.layer_type.replace(/_/g, ' ');
            const polygonStyle = getRegionStyle(item.building || item.name, 'building');

            const polygon = L.polygon(item.coords, {
                ...polygonStyle,
                interactive: true
            }).addTo(map);

            polygon.bindTooltip(labelText, { direction: 'top', opacity: 0.85 });

            if (item.alias) {
                const aliasText = item.alias;
                const aliasMarker = L.marker(getPolygonVisualCenter(polygon, item.coords), {
                    icon: createBuildingAliasIcon(aliasText, 14),
                    interactive: false,
                    keyboard: false,
                    zIndexOffset: 2000
                }).addTo(buildingAliasLayerGroup);
                buildingAliasMarkers.push({ marker: aliasMarker, alias: aliasText, coords: item.coords });
            }

            const amenityTypes = Array.isArray(item.amenity_types) ? item.amenity_types : [];
            if (amenityTypes.length > 0) {
                const amenityAnchor = getBuildingAmenityAnchor(polygon.getBounds());
                const amenityMarker = L.marker(amenityAnchor, {
                    icon: createBuildingAmenityIcon(amenityTypes),
                    interactive: false,
                    keyboard: false,
                    zIndexOffset: 1900
                }).addTo(buildingAmenityLayerGroup);
                buildingAmenityMarkers.push(amenityMarker);
            }

            const handleBuildingClick = (event) => {
                if (event.originalEvent) L.DomEvent.stopPropagation(event);
                openBuildingPanel(item);
                map.flyToBounds(polygon.getBounds(), {
                    paddingTopLeft: [380, 44],
                    paddingBottomRight: [60, 110],
                    duration: 0.5,
                    maxZoom: 20
                });
            };

            polygon.on('click', handleBuildingClick);
            polygon.on('mouseover', () => polygon.setStyle({ fillOpacity: REGION_HOVER_FILL_OPACITY }));
            polygon.on('mouseout', () => polygon.setStyle({ fillOpacity: polygonStyle.fillOpacity }));

            return;
        }
    });

    updateBuildingAliasLabelSizes();
    updateBuildingAmenityVisibility();
}

function createBuildingAliasIcon(aliasText, fontSizePx) {
    const safeFontSize = Math.max(10, Math.round(fontSizePx));
    const estimatedWidth = Math.max(18, Math.round(safeFontSize * (0.7 + aliasText.length * 0.42)));
    const estimatedHeight = Math.max(14, Math.round(safeFontSize * 1.2));
    const html = `
        <div class="building-alias-label" style="font-size:${safeFontSize}px;line-height:1;">${aliasText}</div>
    `;

    return L.divIcon({
        html,
        className: 'building-alias-div-icon',
        iconSize: [estimatedWidth, estimatedHeight],
        iconAnchor: [estimatedWidth / 2, estimatedHeight / 2]
    });
}

function updateBuildingAliasLabelSizes() {
    if (!map || buildingAliasMarkers.length === 0) return;

    const heights = [];
    for (let i = 0; i < buildingAliasMarkers.length; i++) {
        const metrics = getPolygonDisplayMetrics(buildingAliasMarkers[i].coords);
        heights.push(metrics.height);
    }

    heights.sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 26;
    const unifiedFontPx = Math.min(28, Math.max(11, medianHeight * 0.56));

    buildingAliasMarkers.forEach(({ marker, alias }) => {
        marker.setIcon(createBuildingAliasIcon(alias, unifiedFontPx));
    });
}

function createBuildingAmenityIcon(types) {
    const unique = [];
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        if (!GLOBAL_AMENITY_TYPES.includes(type)) continue;
        if (!unique.includes(type)) unique.push(type);
    }

    const selected = unique.slice(0, GLOBAL_AMENITY_MAX_ICONS);
    const html = `
        <div class="building-amenity-strip">${selected.map(type => `<span class="building-amenity-chip">${POI_ICONS[type] || '•'}</span>`).join('')}</div>
    `;
    const iconWidth = Math.max(24, selected.length * 18 + 8);

    return L.divIcon({
        html,
        className: 'building-amenity-div-icon',
        iconSize: [iconWidth, 18],
        iconAnchor: [0, 18]
    });
}

function updateBuildingAmenityVisibility() {
    if (!map || !buildingAmenityLayerGroup) return;
    const zoom = map.getZoom();
    const shouldShow = zoom >= GLOBAL_AMENITY_MIN_ZOOM && zoom <= GLOBAL_AMENITY_MAX_ZOOM;
    if (shouldShow) {
        if (!map.hasLayer(buildingAmenityLayerGroup)) map.addLayer(buildingAmenityLayerGroup);
    } else if (map.hasLayer(buildingAmenityLayerGroup)) {
        map.removeLayer(buildingAmenityLayerGroup);
    }
}

function getPolygonDisplayMetrics(coords) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < coords.length; i++) {
        const pair = coords[i];
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const point = map.latLngToContainerPoint([pair[0], pair[1]]);
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return { width: 48, height: 28 };
    }

    return {
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
    };
}

function getPolygonVisualCenter(polygon, coords) {
    const boundsCenter = polygon.getBounds().getCenter();
    if (isPointInsidePolygon(boundsCenter, coords)) {
        return [boundsCenter.lat, boundsCenter.lng];
    }
    return getPolygonCentroid(coords);
}

function isPointInsidePolygon(latlng, coords) {
    const x = latlng.lng;
    const y = latlng.lat;
    let inside = false;

    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const xi = coords[i][1];
        const yi = coords[i][0];
        const xj = coords[j][1];
        const yj = coords[j][0];

        const intersect = ((yi > y) !== (yj > y))
            && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

        if (intersect) inside = !inside;
    }

    return inside;
}

function getBuildingAmenityAnchor(bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const latSpan = Math.abs(ne.lat - sw.lat);
    const lngSpan = Math.abs(ne.lng - sw.lng);

    return [
        sw.lat + latSpan * 0.12,
        sw.lng + lngSpan * 0.10
    ];
}

function getPolygonCentroid(coords) {
    const total = coords.reduce((acc, [lat, lng]) => {
        acc.lat += lat;
        acc.lng += lng;
        return acc;
    }, { lat: 0, lng: 0 });

    return [total.lat / coords.length, total.lng / coords.length];
}

function initGeolocation() {
    const locateBtn = document.getElementById('locate-btn');

    if (!navigator.geolocation) {
        console.warn('Geolocation is not supported by your browser');
        return;
    }
    navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            currentUserLatLng = [lat, lng];
            if (locateBtn) locateBtn.classList.add('active');

            if (userLocationMarker) {
                userLocationMarker.setLatLng(currentUserLatLng);
            } else {
                const userIcon = L.divIcon({
                    className: 'user-location-marker',
                    iconSize: [14, 14],
                    iconAnchor: [7, 7]
                });
                userLocationMarker = L.marker(currentUserLatLng, { icon: userIcon }).addTo(map);
            }

            const MAX_ACCURACY_THRESHOLD = 500;

            if (accuracy <= MAX_ACCURACY_THRESHOLD) {
                if (userAccuracyCircle) {
                    userAccuracyCircle.setLatLng(currentUserLatLng);
                    userAccuracyCircle.setRadius(accuracy);
                } else {
                    userAccuracyCircle = L.circle(currentUserLatLng, {
                        radius: accuracy,
                        color: '#1a73e8',
                        fillColor: '#1a73e8',
                        fillOpacity: 0.12,
                        weight: 1.5,
                        interactive: false
                    }).addTo(map);
                }
            } else {
                if (userAccuracyCircle) {
                    map.removeLayer(userAccuracyCircle);
                    userAccuracyCircle = null;
                }
            }

            if (isFirstLocation && boundCheck(currentUserLatLng[0], currentUserLatLng[1])) {
                map.flyTo(currentUserLatLng, 18, { animate: true });
                isFirstLocation = false;
            }
        },
        (error) => {
            console.warn('Geolocation Error:', error.code, error.message);
            if (locateBtn) locateBtn.classList.remove('active');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 2000
        }
    );

    if (locateBtn) {
        locateBtn.addEventListener('click', () => {
            if (currentUserLatLng) {
                map.flyTo(currentUserLatLng, 18, { animate: true });
            } else {
                alert('Please check if location permissions are allowed.');
            }
        });
    }
}

function initCategoryChips() {
    const chipBtns = document.querySelectorAll('.chip-btn');

    chipBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const isAlreadyActive = btn.classList.contains('active');

            chipBtns.forEach(b => b.classList.remove('active'));

            if (isAlreadyActive) {
                filterPOIsByCategory(null);
            } else {
                btn.classList.add('active');
                const category = btn.getAttribute('data-category');
                filterPOIsByCategory(category);
            }
        });
    });
}

function filterPOIsByCategory(category) {
    if (categoryFilterLayerGroup) {
        map.removeLayer(categoryFilterLayerGroup);
        categoryFilterLayerGroup = null;
    }

    if (itemLayerGroup) {
        map.removeLayer(itemLayerGroup);
        itemLayerGroup = null;
    }

    if (!category) {
        if (currentOpenBuildingName) {
            showItemsForBuilding(currentOpenBuildingName); 
        }
        return;
    }

    categoryFilterLayerGroup = L.layerGroup().addTo(map);

    let matchingFacilities;
    if (category === 'all') {
        matchingFacilities = allPointFacilities.filter(isPointFacility);
    } else {
        matchingFacilities = allPointFacilities.filter(f => normalizeLayerType(f.layer_type) === category && isPointFacility(f));
    }

    matchingFacilities.forEach(item => {
        const itemType = normalizeLayerType(item.layer_type);
        const icon = POI_ICONS[itemType] || '📍';
        const labelText = itemType.replace(/_/g, ' ');
        const html = `
            <div class="poi-label">
                <span class="poi-icon">${icon}</span>
                <span class="poi-title">${labelText}</span>
            </div>
        `;
        const poiIcon = L.divIcon({
            html,
            className: 'poi-div-icon',
            iconSize: [120, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -12],
        });

        L.marker([item.coords[0], item.coords[1]], { icon: poiIcon, interactive: true })
            .addTo(categoryFilterLayerGroup)
            .on('click', () => openItemPanel(item))
            .bindTooltip(labelText, {
                direction: 'top',
                offset: [0, -12],
                permanent: false,
                opacity: 0.85,
                className: 'poi-tooltip'
            });

        updateLabelVisibility();
    });
}

function initSettingsModal() {
    const gearBtn = document.getElementById('meta-settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeBtn = document.getElementById('close-settings-btn');

    if (gearBtn && modal) {
        gearBtn.addEventListener('click', () => modal.classList.add('open'));
    }

    const closeModal = () => modal && modal.classList.remove('open');

    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
}

function updateLabelVisibility() {
    let showLabels;
    if (map.getZoom() >= LABEL_ZOOM_THRESHOLD) {
        showLabels = true;
    } else {
        showLabels = false;
    }

    const labels = document.querySelectorAll('.poi-title');
    labels.forEach(el => {
        if (showLabels) {
            el.style.display = 'inline';
        } else {
            el.style.display = 'none';
        }
    });
}

function getFacilityBuildingKeys(facility) {
    const keys = [];
    if (facility && facility.building) {
        keys.push(facility.building);
    }

    const shared = facility && facility.details && facility.details.shared_buildings;
    if (Array.isArray(shared)) {
        shared.forEach(name => {
            if (name && !keys.includes(name)) keys.push(name);
        });
    }

    return keys;
}

function belongsToBuilding(facility, buildingName) {
    const normalizedBuildingName = normalizeBuildingName(buildingName);
    return getFacilityBuildingKeys(facility).some(name => normalizeBuildingName(name) === normalizedBuildingName);
}

function isCrossFloorVisibleFacility(facility) {
    return CROSS_FLOOR_VISIBLE_TYPES.includes(normalizeLayerType(facility.layer_type));
}

function showItemsForBuilding(buildingName, floorLabel = null) {
    if (itemLayerGroup) {
        map.removeLayer(itemLayerGroup);
        itemLayerGroup = null;
    }

    if (categoryFilterLayerGroup) {
        map.removeLayer(categoryFilterLayerGroup);
        categoryFilterLayerGroup = null;
    }
    const chipBtns = document.querySelectorAll('.chip-btn');
    chipBtns.forEach(b => b.classList.remove('active'));

    const matchingItems = allPointFacilities.filter(f => {
        if (!belongsToBuilding(f, buildingName)) return false;
        if (!floorLabel) return true;
        if (isCrossFloorVisibleFacility(f)) return true;
        return f.floor === floorLabel;
    });
    if (matchingItems.length === 0) return;

    itemLayerGroup = L.layerGroup().addTo(map);

    matchingItems.forEach(item => {
        const itemType = normalizeLayerType(item.layer_type);
        const icon = POI_ICONS[itemType] || '📍';
        const labelText = itemType.replace(/_/g, ' ');
        const html = `
            <div class="poi-label">
                <span class="poi-icon">${icon}</span>
                <span class="poi-title">${labelText}</span>
            </div>
        `;
        const poiIcon = L.divIcon({
            html,
            className: 'poi-div-icon',
            iconSize: [120, 24],
            iconAnchor: [8, 12],
            popupAnchor: [0, -12],
        });

        L.marker([item.coords[0], item.coords[1]], { icon: poiIcon, interactive: true })
            .addTo(itemLayerGroup)
            .on('click', () => openItemPanel(item))
            .bindTooltip(labelText, {
                direction: 'top',
                offset: [0, -12],
                permanent: false,
                opacity: 0.85,
                className: 'poi-tooltip'
            });

        updateLabelVisibility();
    }); 
}

let currentOpenBuildingName = null;

function openBuildingPanel(item) {
    document.getElementById('building-panel-name').textContent = item.name || 'Unnamed building';
    document.getElementById('building-panel-description').textContent = item.description || '';

    currentBuildingFloors = item.floors || [];
    currentOpenBuildingName = item.building || item.name;

    const tabsContainer = document.getElementById('building-floor-tabs');
    tabsContainer.innerHTML = '';

    const classroomsEl = document.getElementById('building-panel-classrooms');
    classroomsEl.className = 'gm-pills-list';

    if (currentBuildingFloors.length === 0) {
        currentSelectedFloor = null;
        showItemsForBuilding(item.building || item.name, null);
        classroomsEl.innerHTML = '<li style="color:#999; background:none; padding:0;">None listed</li>';
        document.getElementById('building-panel-items').innerHTML = '';
    } else {
        currentBuildingFloors.forEach((floor, index) => {
            const tab = document.createElement('button');
            tab.className = 'building-floor-tab' + (index === 0 ? ' active' : '');
            tab.textContent = floor.label || `Floor ${floor.level}`;
            tab.addEventListener('click', () => selectFloor(index));
            tabsContainer.appendChild(tab);
        });
        renderFloorContent(currentBuildingFloors[0]);
    }

    document.getElementById('building-panel').classList.add('open');
}

function initClassroomPanel() {
    const closeBtn = document.getElementById('classroom-panel-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeClassroomPanel);
    }

    const classroomsEl = document.getElementById('building-panel-classrooms');
    if (classroomsEl) {
        classroomsEl.addEventListener('click', (e) => {
            const li = e.target.closest('li');
            if (li && li.textContent !== 'None listed') {
                const classroomName = li.textContent.trim();
                openClassroomPanel(classroomName);
            }
        });
    }
}

function initItemPanel() {
    const closeBtn = document.getElementById('item-panel-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeItemPanel);
    }

    const itemsEl = document.getElementById('building-panel-items');
    if (itemsEl) {
        itemsEl.addEventListener('click', (e) => {
            const li = e.target.closest('li[data-item-name]');
            if (!li) return;
            const itemName = li.dataset.itemName;
            const itemType = li.dataset.itemType;
            const target = currentFloorItems.find(item => item.name === itemName && normalizeLayerType(item.layer_type) === normalizeLayerType(itemType));
            if (target) openItemPanel(target);
        });
    }
}

function registerDetailPanelOpen(panelId) {
    detailPanelOrder = detailPanelOrder.filter(id => id !== panelId);
    detailPanelOrder.push(panelId);
    updateDetailPanelPositions();
}

function unregisterDetailPanel(panelId) {
    detailPanelOrder = detailPanelOrder.filter(id => id !== panelId);
    updateDetailPanelPositions();
}

function updateDetailPanelPositions() {
    const panels = ['classroom-panel', 'item-panel'];

    if (window.innerWidth <= MOBILE_LAYOUT_BREAKPOINT) {
        panels.forEach(panelId => {
            const panel = document.getElementById(panelId);
            if (!panel) return;
            panel.style.left = '';
            panel.style.right = '';
            panel.style.top = '';
            panel.style.maxHeight = '';
        });
        return;
    }

    if (window.innerWidth <= MEDIUM_LAYOUT_BREAKPOINT) {
        const availableHeight = Math.max(220, Math.floor((window.innerHeight - 120 - DETAIL_PANEL_GAP - 32) / 2));

        detailPanelOrder.forEach((panelId, index) => {
            const panel = document.getElementById(panelId);
            if (!panel || !panel.classList.contains('open')) return;
            panel.style.left = '';
            panel.style.right = '16px';
            panel.style.top = `${90 + index * (availableHeight + DETAIL_PANEL_GAP)}px`;
            panel.style.maxHeight = `${availableHeight}px`;
        });

        panels.forEach(panelId => {
            if (detailPanelOrder.includes(panelId)) return;
            const panel = document.getElementById(panelId);
            if (!panel) return;
            panel.style.left = '';
            panel.style.right = '16px';
            panel.style.top = '90px';
            panel.style.maxHeight = `${availableHeight}px`;
        });
        return;
    }

    detailPanelOrder.forEach((panelId, index) => {
        const panel = document.getElementById(panelId);
        if (!panel || !panel.classList.contains('open')) return;
        panel.style.left = `${DETAIL_PANEL_BASE_LEFT + index * (DETAIL_PANEL_WIDTH + DETAIL_PANEL_GAP)}px`;
        panel.style.right = '';
        panel.style.top = '';
        panel.style.maxHeight = '';
    });

    panels.forEach(panelId => {
        if (detailPanelOrder.includes(panelId)) return;
        const panel = document.getElementById(panelId);
        if (panel && !panel.classList.contains('open')) {
            panel.style.left = `${DETAIL_PANEL_BASE_LEFT}px`;
            panel.style.right = '';
            panel.style.top = '';
            panel.style.maxHeight = '';
        }
    });
}

function openItemPanel(item) {
    const details = item.details || {};
    const baseUrl = window.ENV.API_HOST.replace(/\/$/, '');
    const images = Array.isArray(details.images) ? details.images : [];

    document.getElementById('item-title').textContent = item.name || 'Unnamed item';
    document.getElementById('item-building-tag').textContent = item.building || 'CAMPUS';
    document.getElementById('item-description').textContent = details.description || 'No description available for this item yet.';
    document.getElementById('item-category').textContent = normalizeLayerType(item.layer_type).replace(/_/g, ' ') || 'N/A';
    document.getElementById('item-floor').textContent = item.floor || 'N/A';
    document.getElementById('item-building').textContent = item.building || 'N/A';
    document.getElementById('item-notes').textContent = details.notes || 'N/A';

    const heroImg = document.getElementById('item-hero-img');
    const heroPlaceholder = document.getElementById('item-hero-placeholder');
    const heroCaption = document.getElementById('item-hero-caption');
    const galleryContainer = document.getElementById('item-gallery-container');
    const thumbnailsRow = document.getElementById('item-thumbnails-row');
    thumbnailsRow.innerHTML = '';

    const getFullUrl = (url) => url.startsWith('http') ? url : `${baseUrl}/${url.replace(/^\//, '')}`;

    if (images.length > 0) {
        if (galleryContainer) galleryContainer.style.display = 'flex';
        heroImg.style.display = 'block';
        heroPlaceholder.style.display = 'none';
        heroImg.src = getFullUrl(images[0].url);
        heroCaption.textContent = images[0].label || 'Preview';

        images.forEach((imgData, index) => {
            const thumbUrl = getFullUrl(imgData.url);
            const thumb = document.createElement('div');
            thumb.className = `cr-thumb-item ${index === 0 ? 'active' : ''}`;
            thumb.innerHTML = `<img src="${thumbUrl}" alt="${imgData.label || 'Preview'}"><span>${imgData.label || ''}</span>`;
            thumb.addEventListener('click', () => {
                document.querySelectorAll('#item-thumbnails-row .cr-thumb-item').forEach(t => t.classList.remove('active'));
                thumb.classList.add('active');
                heroImg.classList.add('loading');
                heroImg.src = thumbUrl;
                heroCaption.textContent = imgData.label || 'Preview';
                setTimeout(() => {
                    heroImg.classList.remove('loading');
                }, 50);
            });
            thumbnailsRow.appendChild(thumb);
        });
    } else {
        if (galleryContainer) galleryContainer.style.display = 'none';
        heroImg.style.display = 'none';
        heroImg.src = '';
        heroPlaceholder.style.display = 'none';
        heroCaption.textContent = 'Preview';
    }

    const features = document.getElementById('item-features');
    const featureList = Array.isArray(details.features) ? details.features : [];
    features.innerHTML = featureList.length > 0
        ? featureList.map(feature => `<li>${feature}</li>`).join('')
        : '<li style="color:#999;">No extra details yet</li>';

    const linksEl = document.getElementById('item-links');
    const links = Array.isArray(details.links) ? details.links : [];
    linksEl.innerHTML = links.length > 0
        ? links.map(link => `<a href="${link.url}" target="_blank" rel="noopener" style="color:#1a73e8; text-decoration:none;">🔗 ${link.title}</a>`).join('')
        : '<span style="color:#999;">No links available</span>';

    const panel = document.getElementById('item-panel');
    if (panel) {
        panel.classList.add('open');
        registerDetailPanelOpen('item-panel');
    }
}

function closeItemPanel() {
    const panel = document.getElementById('item-panel');
    if (panel) panel.classList.remove('open');
    unregisterDetailPanel('item-panel');
}

function openClassroomPanel(classroomName) {
    const baseUrl = window.ENV.API_HOST.replace(/\/$/, '');

    const target = allRawFacilities.find(f => f.name === classroomName && f.layer_type === 'classroom') 
                   || { name: classroomName };
    const details = target.details || {};

    document.getElementById('cr-title').textContent = target.name || classroomName;
    document.getElementById('cr-building-tag').textContent = target.building || 'CAMPUS';

    const galleryContainer = document.getElementById('cr-gallery-container');
    const heroImg = document.getElementById('cr-hero-img');
    const heroCaption = document.getElementById('cr-hero-caption');
    const thumbnailsRow = document.getElementById('cr-thumbnails-row');

    const images = (details.images && details.images.length > 0) ? details.images : [];

    if (images.length > 0) {
        galleryContainer.style.display = 'flex';
        thumbnailsRow.innerHTML = '';

        const getFullUrl = (url) => url.startsWith('http') ? url : `${baseUrl}/${url.replace(/^\//, '')}`;

        heroImg.src = getFullUrl(images[0].url);
        heroCaption.textContent = images[0].label || 'Overview';

        images.forEach((imgData, index) => {
            const thumbUrl = getFullUrl(imgData.url);
            const thumb = document.createElement('div');
            thumb.className = `cr-thumb-item ${index === 0 ? 'active' : ''}`;
            thumb.innerHTML = `<img src="${thumbUrl}" alt="${imgData.label}"><span>${imgData.label || ''}</span>`;

            thumb.addEventListener('click', () => {
                document.querySelectorAll('.cr-thumb-item').forEach(t => t.classList.remove('active'));
                thumb.classList.add('active');

                heroImg.classList.add('loading');
                heroImg.src = thumbUrl;
                heroCaption.textContent = imgData.label || '';
                
                setTimeout(() => {
                    heroImg.classList.remove('loading');
                }, 50);
            });

            thumbnailsRow.appendChild(thumb);
        });
    } else {
        galleryContainer.style.display = 'none';
    }

    document.getElementById('cr-description').textContent = details.description || 'No description available for this classroom.';
    document.getElementById('cr-capacity').textContent = details.capacity || 'N/A';
    document.getElementById('cr-podium').textContent = details.podium_type || 'N/A';
    document.getElementById('cr-desk').textContent = details.desk_type || 'N/A';
    document.getElementById('cr-notes').textContent = details.notes || 'N/A';

    const equipEl = document.getElementById('cr-equipment');
    if (equipEl) {
        const equipment = details.equipment || [];
        equipEl.innerHTML = equipment.length > 0 
            ? equipment.map(item => `<li>${item}</li>`).join('')
            : '<li style="color:#999;">Standard classroom equipment</li>';
    }

    const linksEl = document.getElementById('cr-links');
    if (linksEl) {
        const links = details.links || [];
        linksEl.innerHTML = links.length > 0
            ? links.map(link => `<a href="${link.url}" target="_blank" rel="noopener" style="color:#1a73e8; text-decoration:none;">🔗 ${link.title}</a>`).join('')
            : '<span style="color:#999;">No links available</span>';
    }

    const panel = document.getElementById('classroom-panel');
    if (panel) {
        panel.classList.add('open');
        registerDetailPanelOpen('classroom-panel');
    }
}

function closeClassroomPanel() {
    const panel = document.getElementById('classroom-panel');
    if (panel) panel.classList.remove('open');
    unregisterDetailPanel('classroom-panel');
}

function selectFloor(index) {
    const tabs = document.querySelectorAll('.building-floor-tab');
    tabs.forEach((tab, i) => tab.classList.toggle('active', i === index));
    renderFloorContent(currentBuildingFloors[index]);
}

function renderFloorContent(floor) {
    const classroomsEl = document.getElementById('building-panel-classrooms');
    const itemsEl = document.getElementById('building-panel-items');
    const imageEl = document.getElementById('building-floor-image');
    const imageWrapEl = document.getElementById('building-floor-image-wrap');
    const filterContainer = document.getElementById('building-item-filters');

    classroomsEl.className = 'gm-pills-list';
    if (floor.classrooms && floor.classrooms.length > 0) {
        classroomsEl.innerHTML = floor.classrooms.map(c => `<li>${c}</li>`).join('');
    } else {
        classroomsEl.innerHTML = '<li style="color:#999; background:none; padding:0;">None listed</li>';
    }

    if (floor.image_url) {
        if (floor.image_url.startsWith('http')) {
            imageEl.src = floor.image_url;
        } else {
            const baseUrl = window.ENV.API_HOST.replace(/\/$/, '');
            const imgPath = floor.image_url.startsWith('/') ? floor.image_url : `/${floor.image_url}`;
            imageEl.src = `${baseUrl}${imgPath}`;
        }
        if (imageWrapEl) imageWrapEl.style.display = '';
    } else {
        imageEl.src = '';
        if (imageWrapEl) imageWrapEl.style.display = 'none';
    }

    const floorItems = floor.items || [];
    const crossFloorItems = currentBuildingFloors
        .flatMap(f => f.items || [])
        .filter(item => CROSS_FLOOR_VISIBLE_TYPES.includes(normalizeLayerType(item.layer_type)));

    const seenFloorItems = new Set();
    currentFloorItems = [...floorItems, ...crossFloorItems].filter(item => {
        const key = `${item.layer_type}|${item.name}`;
        if (seenFloorItems.has(key)) return false;
        seenFloorItems.add(key);
        return true;
    });
    activeItemFilter = null;
    currentSelectedFloor = floor.level || floor.label || null;

    if (currentOpenBuildingName) {
        showItemsForBuilding(currentOpenBuildingName, currentSelectedFloor);
    }

    const types = [];
    currentFloorItems.forEach(item => {
        if (!types.includes(item.layer_type)) types.push(item.layer_type);
    });

    filterContainer.innerHTML = '';
    types.forEach(type => {
        const normalizedType = normalizeLayerType(type);
        const btn = document.createElement('button');
        btn.className = 'item-filter-btn';
        btn.dataset.type = type; 
        btn.textContent = POI_ICONS[normalizedType] || '📍';
        btn.title = normalizedType.replace(/_/g, ' ');
        btn.addEventListener('click', () => {
            if (activeItemFilter === type) {
                activeItemFilter = null;
            } else {
                activeItemFilter = type;
            }
            updateFilterButtonStyles();
            renderItemsList();
        });
        filterContainer.appendChild(btn);
    });

    renderItemsList();
}

function updateFilterButtonStyles() {
    document.querySelectorAll('.item-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === activeItemFilter);
    });
}

function renderItemsList() {
    const itemsEl = document.getElementById('building-panel-items');

    let itemsToShow;
    if (activeItemFilter) {
        itemsToShow = currentFloorItems.filter(item => normalizeLayerType(item.layer_type) === normalizeLayerType(activeItemFilter));
    } else {
        itemsToShow = currentFloorItems;
    }

    itemsEl.innerHTML = itemsToShow.map(item => `<li class="building-item-entry" data-item-name="${item.name}" data-item-type="${item.layer_type}">${item.name}</li>`).join('')
        || '<li style="color:#999;">None listed</li>';
}

function closeBuildingPanel() {
    document.getElementById('building-panel').classList.remove('open');
    closeClassroomPanel();
    closeItemPanel();
    detailPanelOrder = [];

    if (itemLayerGroup) {
        map.removeLayer(itemLayerGroup);
        itemLayerGroup = null;
    }
    currentOpenBuildingName = null;
    currentSelectedFloor = null;
}

document.getElementById('building-panel-close').addEventListener('click', () => {
    closeBuildingPanel();
});

function transformFacilities(facilities) {
    const buildingPolygons = facilities.filter(f => normalizeLayerType(f.layer_type) === 'polygon');
    const pointFacilities = facilities.filter(f => normalizeLayerType(f.layer_type) !== 'polygon');
    const buildingAmenitySet = {};

    pointFacilities.forEach(f => {
        if (!f.layer_type || normalizeLayerType(f.layer_type) === 'classroom') return;
        const buildingKeys = getFacilityBuildingKeys(f)
            .map(name => normalizeBuildingName(name))
            .filter(name => name !== '');
        const layerType = normalizeLayerType(f.layer_type);
        buildingKeys.forEach(buildingKey => {
            if (!buildingAmenitySet[buildingKey]) buildingAmenitySet[buildingKey] = [];
            if (!buildingAmenitySet[buildingKey].includes(layerType)) {
                buildingAmenitySet[buildingKey].push(layerType);
            }
        });
    });

    const groupedByBuilding = {};
    const groupedClassroomsByBuilding = {};
    pointFacilities.forEach(f => {
        const buildingKeys = getFacilityBuildingKeys(f)
            .map(name => normalizeBuildingName(name))
            .filter(name => name !== '');
        const layerType = normalizeLayerType(f.layer_type);
        if (buildingKeys.length === 0) return;

        buildingKeys.forEach(buildingKey => {
            if (!groupedByBuilding[buildingKey]) groupedByBuilding[buildingKey] = {};
            const floorKey = f.floor || 'Unspecified';
            if (layerType === 'classroom') {
                if (!groupedClassroomsByBuilding[buildingKey]) groupedClassroomsByBuilding[buildingKey] = {};
                if (!groupedClassroomsByBuilding[buildingKey][floorKey]) groupedClassroomsByBuilding[buildingKey][floorKey] = [];
                groupedClassroomsByBuilding[buildingKey][floorKey].push(f.name);
            } else {
                if (!groupedByBuilding[buildingKey][floorKey]) groupedByBuilding[buildingKey][floorKey] = [];
                groupedByBuilding[buildingKey][floorKey].push({
                    ...f,
                    layer_type: layerType,
                    building: f.building,
                    floor: f.floor,
                    details: f.details || {}
                });
            }
        });
    });

    const buildingItems = buildingPolygons.map(poly => {
        const coords = poly.coords;
        const buildingName = poly.building;
        const normalizedBuildingName = normalizeBuildingName(poly.building);
        const floorMap = groupedByBuilding[normalizedBuildingName] || {};
        const classroomMap = groupedClassroomsByBuilding[normalizedBuildingName] || {};

        let declaredFloors = [];
        if (poly.floor) {
            const rawParts = poly.floor.split(',');
            for (let i = 0; i < rawParts.length; i++) {
                const trimmed = rawParts[i].trim();
                if (trimmed !== '') {
                    declaredFloors.push(trimmed);
                }
            }
        }

        const floorLabels = [];
        for (let i = 0; i < declaredFloors.length; i++) {
            if (!floorLabels.includes(declaredFloors[i])) {
                floorLabels.push(declaredFloors[i]);
            }
        }
        const facilityFloors = Object.keys(floorMap);
        for (let i = 0; i < facilityFloors.length; i++) {
            if (!floorLabels.includes(facilityFloors[i])) {
                floorLabels.push(facilityFloors[i]);
            }
        }

        const classroomFloors = Object.keys(classroomMap);
        for (let i = 0; i < classroomFloors.length; i++) {
            if (!floorLabels.includes(classroomFloors[i])) floorLabels.push(classroomFloors[i]);
        }

        const floors = floorLabels.map(floorLabel => ({
            level: floorLabel,
            label: floorLabel,
            classrooms: classroomMap[floorLabel] || [],
            items: floorMap[floorLabel] || [],
            image_url: (poly.floor_images && poly.floor_images[floorLabel]) || null
        }));

        return {
            layer_type: 'building', 
            name: buildingName,
            alias: poly.alias || null,
            building: buildingName,
            description: poly.description || '',
            coords: coords,
            amenity_types: buildingAmenitySet[normalizedBuildingName] || [],
            floors: floors
        };
    });

    const pointItems = pointFacilities.filter(f => f.coords && normalizeLayerType(f.layer_type) !== 'classroom'); 

    const sharedConnectorAreas = pointFacilities
        .filter(f => f.details && Array.isArray(f.details.connector_polygon) && f.details.connector_polygon.length >= 3)
        .map(f => ({
            name: f.name,
            buildingName: f.building,
            coords: f.details.connector_polygon
        }));

    return { buildingItems, pointItems, sharedConnectorAreas };
}