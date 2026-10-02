const IS_LOCAL = [
    'localhost',
    '127.0.0.1',
    '::1'
].includes(window.location.hostname);

window.ENV = {
    API_HOST: IS_LOCAL
        ? "http://localhost:8080"
        : "https://netsfc-api.tianyibrad.com",
    // Carto's raster basemap API key is sent with each browser tile request.
    CARTO_API_KEY: "cb1_47ot_1_a412491098553e3cc9f8dc2e"
};
