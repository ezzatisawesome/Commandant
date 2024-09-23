export default {
    CESIUM_KEY: import.meta.env.PUBLIC_CESIUM_KEY,
    PROPAGATE_ENDPOINT: import.meta.env.PROD ? import.meta.env.PROPAGATE_ENDPOINT : 'http://127.0.0.1:5000'
}