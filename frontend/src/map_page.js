// Generates a heatmap with zoom/pan support
// Should be able to show user location and display POI items directly on the map
import { boundCheck } from './measure_page.js';

const MAP_CONFIG = {
    center: [35.3883, 139.4283], // default center, SFC campus
    zoom: 17,
    minZoom: 10,
    maxZoom: 22,
};

const POI_ICONS = {
    washroom: '🚻',
    garbage: '🗑️',
    printer: '🖨️',
    water_fountain: '🚰',
    elevator: '🛗',
    accessible_washroom: '♿',
    vending_machine: '🥤',
    aed: '❤️',
    building: '🏢'
};

const LABEL_ZOOM_THRESHOLD = 21;
const GLOBAL_AMENITY_TYPES = ['aed', 'accessible_washroom', 'washroom', 'elevator', 'water_fountain', 'printer', 'vending_machine'];
const GLOBAL_AMENITY_MAX_ICONS = 5;
const GLOBAL_AMENITY_MAX_ZOOM = 19;

let map;
let heatLayer;
let heatPoints = [];
let buildingAliasLayerGroup = null;
let buildingAliasMarkers = [];
let buildingAmenityLayerGroup = null;
let buildingAmenityMarkers = [];

let userLocationMarker = null;
let userAccuracyCircle = null;
let currentUserLatLng = null;
let isFirstLocation = true;

let allPointFacilities = []; // Holds point items until building is called
let itemLayerGroup = null; // Tracks shown items on map
let categoryFilterLayerGroup = null; // Layer for global category filters (e.g., water fountains)

let currentBuildingFloors = [];
let currentFloorItems = [];  
let activeItemFilter = null;
let allRawFacilities = [];


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

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: MAP_CONFIG.maxZoom,
        maxNativeZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: false,
    }).addTo(map);

    heatLayer = L.heatLayer(heatPoints, {
        radius: 35,
        blur: 25,
        maxZoom: MAP_CONFIG.maxZoom,
        gradient: { 0.4: 'blue', 0.7: 'orange', 1.0: 'red' }
    }).addTo(map);

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
};

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
            const { buildingItems, pointItems } = transformFacilities(facilities);
            allPointFacilities = pointItems;
            placePOIs(buildingItems);
        })
        .catch(error => {
            console.error('Failed to load POIs', error);
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

        // Handle Items
        if (item.coords.length === 2 && typeof item.coords[0] === 'number' && typeof item.coords[1] === 'number') {
            const icon = POI_ICONS[item.layer_type] || '📍';
            const labelText = item.layer_type.replace(/_/g, ' ');
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

            const polygon = L.polygon(item.coords, {
                color: '#1a73e8',
                weight: 1.5,
                fillOpacity: 0.20,
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
                    paddingTopLeft: [380, 80],
                    paddingBottomRight: [60, 60],
                    duration: 0.5,
                    maxZoom: 20
                });
            };

            polygon.on('click', handleBuildingClick);
            polygon.on('mouseover', () => polygon.setStyle({ fillOpacity: 0.40 }));
            polygon.on('mouseout', () => polygon.setStyle({ fillOpacity: 0.20 }));

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
    const shouldShow = map.getZoom() <= GLOBAL_AMENITY_MAX_ZOOM;
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

// Get user location
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

            // User Location Marker & Accuracy Circle
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

            // Locate user on first location update if user is in the campus bounds
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

// Category Filter Chips
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
        matchingFacilities = allPointFacilities;
    } else {
        matchingFacilities = allPointFacilities.filter(f => f.layer_type === category);
    }

    matchingFacilities.forEach(item => {
        if (!item.coords || item.coords.length < 2) return;

        const icon = POI_ICONS[item.layer_type] || '📍';
        const labelText = item.layer_type.replace(/_/g, ' ');
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

function showItemsForBuilding(buildingName) {
    if (itemLayerGroup) {
        map.removeLayer(itemLayerGroup);
        itemLayerGroup = null;
    }

    // No duplicate pins
    if (categoryFilterLayerGroup) {
        map.removeLayer(categoryFilterLayerGroup);
        categoryFilterLayerGroup = null;
    }
    const chipBtns = document.querySelectorAll('.chip-btn');
    chipBtns.forEach(b => b.classList.remove('active'));

    const matchingItems = allPointFacilities.filter(f => f.building === buildingName);
    if (matchingItems.length === 0) return;

    itemLayerGroup = L.layerGroup().addTo(map);

    matchingItems.forEach(item => {
        const icon = POI_ICONS[item.layer_type] || '📍';
        const labelText = item.layer_type.replace(/_/g, ' ');
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

    showItemsForBuilding(item.building || item.name);

    const tabsContainer = document.getElementById('building-floor-tabs');
    tabsContainer.innerHTML = '';

    const classroomsEl = document.getElementById('building-panel-classrooms');
    classroomsEl.className = 'gm-pills-list';

    if (currentBuildingFloors.length === 0) {
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
    if (panel) panel.classList.add('open');
}

function closeClassroomPanel() {
    const panel = document.getElementById('classroom-panel');
    if (panel) panel.classList.remove('open');
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

    currentFloorItems = floor.items || [];
    activeItemFilter = null;

    const types = [];
    currentFloorItems.forEach(item => {
        if (!types.includes(item.layer_type)) types.push(item.layer_type);
    });

    filterContainer.innerHTML = '';
    types.forEach(type => {
        const btn = document.createElement('button');
        btn.className = 'item-filter-btn';
        btn.dataset.type = type; // 💡 优化项 6: 绑好 dataset.type 确保样式切换不报 ReferenceError
        btn.textContent = POI_ICONS[type] || '📍';  
        btn.title = type.replace(/_/g, ' ');   
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
        itemsToShow = currentFloorItems.filter(item => item.layer_type === activeItemFilter);
    } else {
        itemsToShow = currentFloorItems;
    }

    itemsEl.innerHTML = itemsToShow.map(item => `<li>${item.name}</li>`).join('')
        || '<li style="color:#999;">None listed</li>';
}

function closeBuildingPanel() {
    document.getElementById('building-panel').classList.remove('open');
    closeClassroomPanel();

    if (itemLayerGroup) {
        map.removeLayer(itemLayerGroup);
        itemLayerGroup = null;
    }
    currentOpenBuildingName = null;
}

document.getElementById('building-panel-close').addEventListener('click', () => {
    closeBuildingPanel();
});

function transformFacilities(facilities) {
    const buildingPolygons = facilities.filter(f => f.layer_type === 'polygon');
    const pointFacilities = facilities.filter(f => f.layer_type !== 'polygon');
    const buildingAmenitySet = {};

    pointFacilities.forEach(f => {
        if (!f.building || !f.layer_type || f.layer_type === 'classroom') return;
        if (!buildingAmenitySet[f.building]) buildingAmenitySet[f.building] = [];
        if (!buildingAmenitySet[f.building].includes(f.layer_type)) {
            buildingAmenitySet[f.building].push(f.layer_type);
        }
    });

    // Group point facilities by building -> floor -> items
    const groupedByBuilding = {};
    const groupedClassroomsByBuilding = {};
    pointFacilities.forEach(f => {
        const buildingKey = f.building;
        if (!buildingKey) return;
        if (!groupedByBuilding[buildingKey]) groupedByBuilding[buildingKey] = {};
        const floorKey = f.floor || 'Unspecified';
        if (f.layer_type === 'classroom') {
            if (!groupedClassroomsByBuilding[buildingKey]) groupedClassroomsByBuilding[buildingKey] = {};
            if (!groupedClassroomsByBuilding[buildingKey][floorKey]) groupedClassroomsByBuilding[buildingKey][floorKey] = [];
            groupedClassroomsByBuilding[buildingKey][floorKey].push(f.name);
        } else {
            if (!groupedByBuilding[buildingKey][floorKey]) groupedByBuilding[buildingKey][floorKey] = [];
            groupedByBuilding[buildingKey][floorKey].push({ name: f.name, layer_type: f.layer_type });
        }
    });

    // Building polygons -> match placePOIs' expected shape
    const buildingItems = buildingPolygons.map(poly => {
        const coords = poly.coords;
        const buildingName = poly.building;
        const floorMap = groupedByBuilding[poly.building] || {};
        const classroomMap = groupedClassroomsByBuilding[poly.building] || {};

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
            amenity_types: buildingAmenitySet[buildingName] || [],
            floors: floors
        };
    });

    const pointItems = pointFacilities.filter(f => f.coords && f.layer_type !== 'classroom'); 

    return { buildingItems, pointItems };
}