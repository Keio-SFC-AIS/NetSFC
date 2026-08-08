const BROADCAST_API_ROOT = 'https://api.tianyibrad.com';
const BROADCAST_TARGET = 'NetSFC';
const SERVER_TIMEOUT_MS = 5000;
const SERVER_POLL_INTERVAL_MS = 30000;
const BROADCAST_FETCH_TIMEOUT_MS = 8000;
const BROADCAST_AUTO_DISMISS_MS = 9000;

let broadcastDismissTimer = null;

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
        ...options,
        signal: controller.signal
    })
        .catch((error) => {
            if (error && error.name === 'AbortError') {
                throw new Error('REQUEST_TIMEOUT');
            }
            throw error;
        })
        .finally(() => {
            clearTimeout(timeoutId);
        });
}

function getBroadcastList(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
}

function toTimestamp(value) {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : ts;
}

function getBroadcastRank(item) {
    const timeCandidates = [
        item.date_updated,
        item.updated_at,
        item.updatedAt,
        item.date_created,
        item.created_at,
        item.createdAt,
        item.publish_at,
        item.published_at,
        item.timestamp
    ];

    for (let i = 0; i < timeCandidates.length; i++) {
        const ts = toTimestamp(timeCandidates[i]);
        if (ts !== null) return ts;
    }

    const idAsNumber = Number(item.id);
    if (Number.isFinite(idAsNumber)) return idAsNumber;

    return 0;
}

function pickLatestBroadcast(items) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const filtered = items.filter((item) => {
        if (!item) return false;
        if (item.target !== BROADCAST_TARGET) return false;
        return Boolean(item.is_active);
    });

    if (filtered.length === 0) return null;

    filtered.sort((a, b) => getBroadcastRank(b) - getBroadcastRank(a));
    return filtered[0] || null;
}

async function fetchLatestBroadcast() {
    const base = BROADCAST_API_ROOT.replace(/\/$/, '');
    const filterExpr = `target = "${BROADCAST_TARGET}" && is_active = true`;
    const candidates = [
        `${base}/api/collections/Service_Broadcast/records?filter=${encodeURIComponent(filterExpr)}&sort=-updated,-created,-id&page=1&perPage=1`,
        `${base}/api/collections/service_broadcast/records?filter=${encodeURIComponent(filterExpr)}&sort=-updated,-created,-id&page=1&perPage=1`,
        `${base}/api/collections/Service_Broadcast/records?sort=-updated,-created,-id&page=1&perPage=50`,
        `${base}/api/collections/service_broadcast/records?sort=-updated,-created,-id&page=1&perPage=50`
    ];

    for (let i = 0; i < candidates.length; i++) {
        try {
            const response = await fetchWithTimeout(candidates[i], {
                headers: { Accept: 'application/json' }
            }, BROADCAST_FETCH_TIMEOUT_MS);

            if (!response.ok) continue;
            const data = await response.json();
            const latest = pickLatestBroadcast(getBroadcastList(data));
            if (latest) return latest;
        } catch (error) {
            // Try the next candidate endpoint.
        }
    }

    return null;
}

function setServerIndicator(isTimeout, detailText) {
    const indicator = document.getElementById('server-status-indicator');
    const label = document.getElementById('server-status-text');
    if (!indicator || !label) return;

    indicator.classList.remove('is-timeout', 'is-ok');
    if (isTimeout) {
        indicator.classList.add('is-timeout');
        label.textContent = detailText || 'Server timeout';
    } else {
        indicator.classList.add('is-ok');
        label.textContent = detailText || 'Server online';
    }
}

async function checkServerStatus(statusUrl) {
    try {
        const response = await fetchWithTimeout(statusUrl, {
            method: 'GET',
            headers: { Accept: 'application/json' }
        }, SERVER_TIMEOUT_MS);

        const text = response.ok ? 'Server online' : `Server responsive (${response.status})`;
        setServerIndicator(false, text);
    } catch (error) {
        const isTimeout = error instanceof Error && error.message === 'REQUEST_TIMEOUT';
        if (isTimeout) {
            setServerIndicator(true, 'Server timeout');
            return;
        }

        // Requirement: red only on timeout, green otherwise.
        setServerIndicator(false, 'Server online');
    }
}

function renderBroadcastModal(broadcast) {
    const modal = document.getElementById('service-broadcast-modal');
    const title = document.getElementById('service-broadcast-title');
    const message = document.getElementById('service-broadcast-message');
    const type = document.getElementById('service-broadcast-type');
    const closeBtn = document.getElementById('service-broadcast-close');

    if (!modal || !title || !message || !type || !closeBtn) return;

    title.textContent = broadcast.title || 'Service Broadcast';
    message.textContent = broadcast.message || '';

    const typeText = (broadcast.type || 'info').toLowerCase();
    type.textContent = typeText.toUpperCase();
    type.className = `service-broadcast-type type-${typeText}`;

    const allowDismiss = Boolean(broadcast.allow_dismiss);
    closeBtn.style.display = allowDismiss ? 'inline-flex' : 'none';

    const closeModal = () => {
        modal.classList.remove('open');
        if (broadcastDismissTimer) {
            clearTimeout(broadcastDismissTimer);
            broadcastDismissTimer = null;
        }
    };

    closeBtn.onclick = () => {
        if (!allowDismiss) return;
        closeModal();
    };

    if (broadcastDismissTimer) {
        clearTimeout(broadcastDismissTimer);
        broadcastDismissTimer = null;
    }

    const shouldAutoDismiss = allowDismiss && !['danger', 'maintenance'].includes(typeText);
    if (shouldAutoDismiss) {
        broadcastDismissTimer = window.setTimeout(() => {
            closeModal();
        }, BROADCAST_AUTO_DISMISS_MS);
    }

    modal.classList.add('open');
}

async function initBroadcastModal() {
    const latest = await fetchLatestBroadcast();
    if (!latest) return;

    if (latest.target !== BROADCAST_TARGET) return;
    if (!latest.is_active) return;

    renderBroadcastModal(latest);
}

export function initSystemUI(options = {}) {
    const apiHost = (options.apiHost || (window.ENV && window.ENV.API_HOST) || '').replace(/\/$/, '');
    const statusUrl = apiHost ? `${apiHost}/api/health` : '/api/health';

    setServerIndicator(false, 'Checking server...');
    checkServerStatus(statusUrl);

    window.setInterval(() => {
        checkServerStatus(statusUrl);
    }, SERVER_POLL_INTERVAL_MS);

    initBroadcastModal();
}
